import { prisma } from "../db/client.js";
import { notifyStaff } from "../crm/notify.js";
import { logActivity } from "../crm/activity.js";
import { formatDateTimeInZone } from "../scheduling/time.js";
import { ceRequest, dayBoundIso, getAccount, isoWithOffset, noteError } from "./client.js";
import { invalidateCeCache } from "./availability.js";
import { birthFieldOf, parseCeBirthDate } from "./birthdays.js";
import { procKey } from "./procKey.js";

// ---------------------------------------------------------------------------
// Agendamento da Alice -> Clinica Experts
// ---------------------------------------------------------------------------

// Serializa as chamadas de um mesmo agendamento (criar e logo remarcar nao
// podem correr em paralelo, senao o segundo nao enxerga o uuid do primeiro).
const chains = new Map<string, Promise<unknown>>();
function serial<T>(key: string, job: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(job);
  chains.set(key, next);
  void next
    .finally(() => {
      if (chains.get(key) === next) chains.delete(key);
    })
    .catch(() => undefined);
  return next;
}

async function ensurePatientUuid(
  clinicId: string,
  patient: { id: string; name: string | null; phone: string; ceUuid: string | null },
): Promise<string | null> {
  if (patient.ceUuid) return patient.ceUuid;
  const digits = patient.phone.replace(/\D/g, "");
  if (!digits) return null;

  let uuid: string | null = null;
  const found = await ceRequest<{ data: { uuid: string; phone: string | null }[] }>(clinicId, "/patients", { query: { phone: digits, per_page: 5 } });
  if (found.ok) {
    const tail = digits.slice(-8);
    uuid = found.data.data?.find((p) => (p.phone ?? "").replace(/\D/g, "").endsWith(tail))?.uuid ?? null;
  }
  if (!uuid) {
    const created = await ceRequest<{ data: { uuid: string } }>(clinicId, "/patients", {
      method: "POST",
      body: { name: patient.name?.trim() || `Paciente ${digits}`, phone: `+${digits}`, origin: "Alice (WhatsApp)" },
    });
    if (created.ok) uuid = created.data.data?.uuid ?? null;
  }
  if (uuid) await prisma.patient.update({ where: { id: patient.id }, data: { ceUuid: uuid } });
  return uuid;
}

// Resultado de espelhar um agendamento no Clinica Experts. definitive=false: nao deu pra saber se o CE criou (rede/tempo esgotado).
export type SyncResult = { ok: true; skipped?: string } | { ok: false; error: string; definitive: boolean };

// quiet: quem chamou (a Alice, ao agendar) vai tratar a falha na hora - desfaz o agendamento e passa pra equipe -, entao nao manda o
// aviso de "lance manualmente". O erro exato fica no diario de atividades de qualquer jeito (antes so aparecia em um aviso que some).
async function alertFailure(clinicId: string, text: string, quiet = false): Promise<void> {
  await noteError(clinicId, text);
  await logActivity({ clinicId, type: "ce_mirror_failed", area: "agenda", title: "Agendamento não chegou ao Clínica Experts", description: text.slice(0, 480), actorName: null });
  if (quiet) return;
  await notifyStaff(
    clinicId,
    "automation_failed",
    `⚠️ Não consegui espelhar um agendamento no Clínica Experts: ${text}. Confira e lance manualmente para evitar horário duplicado.`,
  );
}

// A reserva ja existe la? (depois de uma falha incerta: rede caiu, tempo esgotado, erro 5xx). Procura no dia pelo mesmo paciente e horario.
async function findExistingBooking(clinicId: string, patientUuid: string, startsAt: Date, tz: string): Promise<string | null> {
  const res = await ceRequest<{ data: { uuid: string; starts_at: string; status: string; patient: { uuid: string } | null }[] }>(clinicId, "/bookings", {
    query: { starts_at: dayBoundIso(startsAt, tz, "start"), ends_at: dayBoundIso(startsAt, tz, "end"), per_page: 1000 },
  });
  if (!res.ok) return null;
  const hit = res.data.data?.find((b) => b.patient?.uuid === patientUuid && b.status !== "canceled" && Date.parse(b.starts_at) === startsAt.getTime());
  return hit?.uuid ?? null;
}

// Procura o paciente no Clinica Experts pelo telefone e, se achar, guarda o
// vinculo e completa o NOME (so troca quando o nome atual e vazio ou de uma
// palavra so, ex.: apelido do WhatsApp). Melhor esforco: nunca lanca. Cada
// paciente e consultado no maximo 1x por 6h (evita bater na API a cada mensagem).
const lookedUp = new Map<string, number>();
export async function enrichPatientFromCe(clinicId: string, patient: { id: string; name: string | null; phone: string; ceUuid: string | null }): Promise<void> {
  try {
    const last = lookedUp.get(patient.id);
    if (last && Date.now() - last < 6 * 3_600_000) return;
    if (!(await getAccount(clinicId))) return;
    lookedUp.set(patient.id, Date.now());
    const digits = patient.phone.replace(/\D/g, "");
    if (!digits) return;
    const found = await ceRequest<{ data: { uuid: string; name?: string | null; phone: string | null; [k: string]: unknown }[] }>(clinicId, "/patients", { query: { phone: digits, per_page: 5 } });
    if (!found.ok) return;
    const tail = digits.slice(-8);
    const match = found.data.data?.find((p) => (p.phone ?? "").replace(/\D/g, "").endsWith(tail));
    if (!match) return;
    const ceName = match.name?.trim();
    const needsName = !!ceName && (!patient.name || !/\s/.test(patient.name.trim()));
    await prisma.patient.update({
      where: { id: patient.id },
      data: { ...(patient.ceUuid ? {} : { ceUuid: match.uuid }), ...(needsName ? { name: ceName } : {}) },
    });
    // Aniversario (para os disparos de parabens): so preenche se a Alice ainda nao tem a data.
    const birth = parseCeBirthDate(birthFieldOf(match).raw);
    if (birth) await prisma.patient.updateMany({ where: { id: patient.id, birthDate: null }, data: { birthDate: birth } });
  } catch (err) {
    console.error("[clinicaexperts] enrichPatientFromCe:", err);
  }
}

// Espelha um agendamento da Alice (criar, remarcar, cancelar) no Clinica Experts e DEVOLVE o resultado. Quem agenda pela Alice espera
// esse resultado antes de dizer "agendado" ao paciente (opts.quiet: trata a falha na hora, sem o aviso "lance manualmente").
export function syncAppointment(appointmentId: string, opts: { quiet?: boolean } = {}): Promise<SyncResult> {
  return serial(appointmentId, async (): Promise<SyncResult> => {
    const appt = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: { patient: true, procedure: true, professional: true, clinic: true },
    });
    if (!appt) return { ok: true, skipped: "agendamento nao encontrado" };
    const account = await getAccount(appt.clinicId);
    if (!account || !account.syncOut) return { ok: true, skipped: "Clinica Experts desligado" };

    const tz = appt.clinic.timezone || "America/Sao_Paulo";
    const label = `${appt.patient.name ?? appt.patient.phone} - ${appt.procedure.name} em ${formatDateTimeInZone(appt.scheduledAt, tz)}`;
    const fail = async (text: string, error: string, definitive = true): Promise<SyncResult> => {
      await alertFailure(appt.clinicId, text, opts.quiet === true);
      return { ok: false, error, definitive };
    };

    // Cancelamento: so cancela la se o agendamento tinha sido espelhado.
    if (appt.status === "cancelled") {
      if (!appt.ceBookingUuid) return { ok: true, skipped: "nunca foi espelhado" };
      const res = await ceRequest(appt.clinicId, `/bookings/${appt.ceBookingUuid}/cancel`, { method: "PATCH" });
      if (!res.ok) return fail(`cancelamento de ${label} (${res.error})`, res.error, res.status > 0 && res.status < 500);
      await prisma.appointment.update({ where: { id: appt.id }, data: { ceBookingUuid: null } });
      invalidateCeCache(appt.clinicId);
      return { ok: true };
    }
    // Atendido/faltou: quem muda isso la e a equipe, no proprio Clinica Experts.
    if (appt.status !== "confirmed") return { ok: true, skipped: "status gerenciado no Clinica Experts" };

    if (!appt.procedure.ceId || !appt.professional?.ceUuid) {
      const faltando = [!appt.procedure.ceId ? `procedimento "${appt.procedure.name}"` : null, !appt.professional?.ceUuid ? (appt.professional ? `profissional ${appt.professional.name}` : "profissional (nenhum definido)") : null].filter(Boolean).join(" e ");
      return fail(`${label} (sem vínculo com o Clínica Experts: ${faltando}; use "Vincular procedimentos" ou "Sincronizar catálogo")`, `sem vinculo com o Clinica Experts: ${faltando}`);
    }
    const patientUuid = await ensurePatientUuid(appt.clinicId, appt.patient);
    if (!patientUuid) return fail(`${label} (não consegui localizar nem criar o paciente)`, "nao consegui localizar nem criar o paciente no Clinica Experts");

    const end = new Date(appt.scheduledAt.getTime() + appt.procedure.durationMin * 60_000);
    const body = {
      starts_at: isoWithOffset(appt.scheduledAt, tz),
      ends_at: isoWithOffset(end, tz),
      professional: appt.professional.ceUuid,
      patient: patientUuid,
      procedure: String(appt.procedure.ceId),
    };

    if (appt.ceBookingUuid) {
      const res = await ceRequest(appt.clinicId, `/bookings/${appt.ceBookingUuid}`, { method: "PUT", body });
      if (!res.ok) return fail(`remarcação de ${label} (${res.error})`, res.error, res.status > 0 && res.status < 500);
    } else {
      const res = await ceRequest<{ data: { uuid: string } }>(appt.clinicId, "/bookings", { method: "POST", body: { ...body, status: "scheduled" } });
      let uuid = res.ok ? res.data.data?.uuid ?? null : null;
      if (!uuid) {
        // Erro 4xx = o CE recusou de vez. Rede/tempo esgotado/5xx (ou resposta sem uuid) = pode ter criado: confere antes de desistir.
        const uncertain = res.ok || res.status === 0 || res.status >= 500;
        if (uncertain) uuid = await findExistingBooking(appt.clinicId, patientUuid, appt.scheduledAt, tz);
        if (!uuid) {
          const error = res.ok ? "o Clinica Experts respondeu sem o codigo da reserva" : res.error;
          return fail(`${label} (${error})`, error, !uncertain);
        }
      }
      await prisma.appointment.update({ where: { id: appt.id }, data: { ceBookingUuid: uuid } });
    }
    invalidateCeCache(appt.clinicId);
    await prisma.clinicaExpertsAccount.updateMany({ where: { clinicId: appt.clinicId }, data: { lastSyncAt: new Date(), lastError: null } });
    return { ok: true };
  });
}

// AUDITORIA (somente leitura): agendamentos FUTUROS da Alice/painel que ainda nao estao no Clinica Experts, com o motivo provavel e se ja
// existe uma reserva igual la (lancada a mao pela recepcao). Serve pra equipe saber o que lancar ou cancelar.
export interface UnmirroredItem {
  id: string;
  patient: string;
  procedure: string;
  professional: string | null;
  startsAt: Date;
  source: string | null;
  bookedAt: Date;
  reason: string;
  alreadyInCe: boolean | null; // null = nao deu pra conferir
}

const foldName = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

export async function auditUnmirrored(clinicId: string): Promise<{ ok: boolean; error?: string; items: UnmirroredItem[] }> {
  const account = await getAccount(clinicId);
  if (!account) return { ok: false, error: "Clinica Experts nao conectado.", items: [] };
  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { timezone: true } });
  const tz = clinic?.timezone || "America/Sao_Paulo";
  const appts = await prisma.appointment.findMany({
    where: { clinicId, status: "confirmed", ceBookingUuid: null, scheduledAt: { gte: new Date() } },
    orderBy: { scheduledAt: "asc" },
    take: 100,
    include: { patient: { select: { name: true, phone: true, ceUuid: true } }, procedure: { select: { name: true, ceId: true } }, professional: { select: { name: true, ceUuid: true } } },
  });

  // Reservas do CE nos dias envolvidos (uma consulta por dia)
  const dayKeys = [...new Set(appts.map((a) => dayBoundIso(a.scheduledAt, tz, "start")))];
  const ceByDay = new Map<string, { starts_at: string; status: string; patient: { uuid: string; name: string } | null }[] | null>();
  for (const key of dayKeys) {
    const sample = appts.find((a) => dayBoundIso(a.scheduledAt, tz, "start") === key)!;
    const res = await ceRequest<{ data: { starts_at: string; status: string; patient: { uuid: string; name: string } | null }[] }>(clinicId, "/bookings", {
      query: { starts_at: key, ends_at: dayBoundIso(sample.scheduledAt, tz, "end"), per_page: 1000 },
    });
    ceByDay.set(key, res.ok ? res.data.data ?? [] : null);
  }

  const items: UnmirroredItem[] = appts.map((a) => {
    const day = ceByDay.get(dayBoundIso(a.scheduledAt, tz, "start"));
    const label = a.patient.name ?? a.patient.phone;
    const alreadyInCe =
      day == null
        ? null
        : day.some(
            (b) =>
              b.status !== "canceled" &&
              Date.parse(b.starts_at) === a.scheduledAt.getTime() &&
              ((a.patient.ceUuid && b.patient?.uuid === a.patient.ceUuid) || (b.patient?.name && foldName(b.patient.name) === foldName(label))),
          );
    const reason = !a.procedure.ceId
      ? `procedimento "${a.procedure.name}" sem vínculo com o Clínica Experts`
      : !a.professional?.ceUuid
        ? a.professional
          ? `profissional ${a.professional.name} sem vínculo com o Clínica Experts`
          : "sem profissional definido"
        : "o Clínica Experts não aceitou ou a conexão falhou (veja o Diário de atividades)";
    return { id: a.id, patient: label, procedure: a.procedure.name, professional: a.professional?.name ?? null, startsAt: a.scheduledAt, source: a.source, bookedAt: a.createdAt, reason, alreadyInCe };
  });
  return { ok: true, items };
}

// AUDITORIA (somente leitura): QUEM FAZ O QUE. Compara os profissionais que a Alice oferece em cada procedimento com quem de fato o fez
// nos ultimos 120 dias no Clinica Experts. Pega "a Alice marcou Lavieen com a Amanda, que nunca fez Lavieen" (15/10): a Alice so oferece
// profissional VINCULADO ao procedimento, e o vinculo inicial vem de um palpite por grupo (injetavel/tecnologia).
export interface ExecutorMismatch {
  procedure: string;
  professional: string;
  doneByOthers: { name: string; count: number }[]; // quem fez de verdade
  totalDone: number;
}

export async function auditExecutors(clinicId: string): Promise<{ ok: boolean; error?: string; checkedProcedures: number; historyBookings: number; mismatches: ExecutorMismatch[] }> {
  const empty = { ok: false, checkedProcedures: 0, historyBookings: 0, mismatches: [] as ExecutorMismatch[] };
  if (!(await getAccount(clinicId))) return { ...empty, error: "Clinica Experts nao conectado." };
  const tz = (await prisma.clinic.findUnique({ where: { id: clinicId }, select: { timezone: true } }))?.timezone || "America/Sao_Paulo";
  const to = new Date(Date.now() - 24 * 3_600_000);
  const from = new Date(to.getTime() - 120 * 24 * 3_600_000);
  const history = await fetchAll<CeBooking>(clinicId, "/bookings", { starts_at: dayBoundIso(from, tz, "start"), ends_at: dayBoundIso(to, tz, "end") });
  if (!history) return { ...empty, error: "Nao consegui ler o historico do Clinica Experts (veja o erro na tela)." };
  const usable = history.filter((b) => b.status !== "canceled" && b.status !== "noshow" && b.professional?.uuid);

  const doneBy = new Map<number, Map<string, number>>(); // ceId -> (uuid do profissional -> vezes)
  for (const b of usable) {
    for (const p of b.procedures ?? []) {
      const m = doneBy.get(p.id) ?? new Map<string, number>();
      m.set(b.professional!.uuid, (m.get(b.professional!.uuid) ?? 0) + 1);
      doneBy.set(p.id, m);
    }
  }
  const pros = await prisma.professional.findMany({ where: { clinicId }, select: { name: true, ceUuid: true } });
  const nameByUuid = new Map(pros.filter((p) => p.ceUuid).map((p) => [p.ceUuid as string, p.name]));
  const procs = await prisma.procedure.findMany({
    where: { clinicId, ceId: { not: null }, internalOnly: false },
    select: { name: true, ceId: true, professionals: { where: { active: true }, select: { name: true, ceUuid: true } } },
  });

  const mismatches: ExecutorMismatch[] = [];
  for (const p of procs) {
    const counts = doneBy.get(p.ceId as number);
    const total = counts ? [...counts.values()].reduce((a, b) => a + b, 0) : 0;
    if (total < 3) continue; // pouco historico: nao da pra afirmar nada
    for (const pro of p.professionals) {
      if (!pro.ceUuid || (counts?.get(pro.ceUuid) ?? 0) > 0) continue;
      mismatches.push({
        procedure: p.name,
        professional: pro.name,
        totalDone: total,
        doneByOthers: [...(counts ?? new Map<string, number>()).entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([uuid, count]) => ({ name: nameByUuid.get(uuid) ?? "outro profissional", count })),
      });
    }
  }
  mismatches.sort((a, b) => b.totalDone - a.totalDone);
  return { ok: true, checkedProcedures: procs.length, historyBookings: usable.length, mismatches: mismatches.slice(0, 80) };
}

// O Clinica Experts esta conectado e a clinica espelha os agendamentos da Alice la? (entao a reserva so vale depois de entrar la)
export async function ceMirrorEnabled(clinicId: string): Promise<boolean> {
  const account = await getAccount(clinicId);
  return !!account && account.syncOut;
}

export function syncAppointmentInBackground(appointmentId: string): void {
  void syncAppointment(appointmentId).catch((err) => console.error("[clinicaexperts] syncAppointment:", err));
}

// ---------------------------------------------------------------------------
// Catalogo (profissionais e procedimentos) Clinica Experts -> Alice
// ---------------------------------------------------------------------------

// Itens internos/gratuitos do Clinica Experts que a Alice nao deve vender.
const INTERNAL_RE =
  /cortesia|brinde|presente|parceria|\blead\b|indica[cç][aã]o|instagram|ficha|plataforma|fotos, peso|bioimped|modeladora local|^nada$|spa dos p|academia|retoque/i;

// Procedimentos injetaveis/tecnologia: usados so pra agrupar quem executa
// (deduzido do historico), nao pra decidir nada por nome de pessoa.
const SPECIALIZED_RE =
  /botox|toxina|preench|bioestimul|elleva|radiesse|sculptra|nutriex|enzima|skinbooster|pdrn|fios|lavieen|ultraformer|etherea|hipro|laser|peeling qu|microagulh|escleroterapia|subcis|harmoniza|tizerpatida|tirzepatida|retatrutida|carbox|ozon|avalia|hibrius|pixie|microtox/i;

export const isInternalProcedure = (name: string): boolean => INTERNAL_RE.test(name);
export const isSpecializedProcedure = (name: string): boolean => SPECIALIZED_RE.test(name);

const COLORS: Record<string, string> = {
  lilac: "#a78bfa", beige: "#d6c3a5", skyblue: "#38bdf8", pink: "#f472b6", green: "#34d399", orange: "#fb923c",
  yellow: "#facc15", red: "#f87171", blue: "#60a5fa", purple: "#a855f7", teal: "#2dd4bf", gray: "#9ca3af",
};

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

interface CePro { uuid: string; name: string; first_name?: string; last_name?: string; color?: string; active: boolean }
interface CeProc { id: number; name: string; duration: number; price: number; active: boolean }
interface CeBooking { status: string; professional: { uuid: string } | null; procedures: { id: number }[] }

async function fetchAll<T>(clinicId: string, path: string, query: Record<string, string | number>): Promise<T[] | null> {
  const out: T[] = [];
  for (let page = 1; page <= 30; page++) {
    const res = await ceRequest<{ data: T[]; meta?: { last_page?: number } }>(clinicId, path, { query: { ...query, per_page: 1000, page } });
    if (!res.ok) return null;
    out.push(...(res.data.data ?? []));
    if (!res.data.meta?.last_page || page >= res.data.meta.last_page) break;
  }
  return out;
}

// PURO: quem executa cada procedimento, a partir do historico de agendamentos.
// Um profissional so entra se fez pelo menos max(3, 5%) das execucoes - isso
// filtra o ruido (alguem que cobriu uma vez). Procedimento sem historico herda
// os profissionais do mesmo grupo (especializado x geral) com volume relevante.
export function inferExecutors(
  bookings: { professionalUuid: string | null; procedureIds: number[] }[],
  procedures: { id: number; name: string }[],
  activeUuids: Set<string>,
): Map<number, string[]> {
  const perProc = new Map<number, Map<string, number>>();
  const perGroup = { spec: new Map<string, number>(), gen: new Map<string, number>() };
  const nameOf = new Map(procedures.map((p) => [p.id, p.name]));

  for (const b of bookings) {
    if (!b.professionalUuid || !activeUuids.has(b.professionalUuid)) continue;
    for (const id of b.procedureIds) {
      const m = perProc.get(id) ?? new Map<string, number>();
      m.set(b.professionalUuid, (m.get(b.professionalUuid) ?? 0) + 1);
      perProc.set(id, m);
      const g = isSpecializedProcedure(nameOf.get(id) ?? "") ? perGroup.spec : perGroup.gen;
      g.set(b.professionalUuid, (g.get(b.professionalUuid) ?? 0) + 1);
    }
  }

  const groupPros = (g: Map<string, number>) => {
    const total = [...g.values()].reduce((a, b) => a + b, 0);
    return [...g.entries()].filter(([, n]) => n >= Math.max(5, Math.ceil(total * 0.05))).map(([u]) => u);
  };
  const specPros = groupPros(perGroup.spec);
  const genPros = groupPros(perGroup.gen);

  const result = new Map<number, string[]>();
  for (const p of procedures) {
    const counts = perProc.get(p.id);
    if (counts && counts.size) {
      const total = [...counts.values()].reduce((a, b) => a + b, 0);
      const min = Math.max(3, Math.ceil(total * 0.05));
      const own = [...counts.entries()].filter(([, n]) => n >= min).map(([u]) => u);
      if (own.length) {
        result.set(p.id, own);
        continue;
      }
    }
    result.set(p.id, isSpecializedProcedure(p.name) ? specPros : genPros);
  }
  return result;
}

export interface CatalogResult {
  ok: boolean;
  error?: string;
  professionals: { created: number; linked: number };
  procedures: { created: number; linked: number; skipped: number };
  professionalLinks: number;
  historyBookings: number;
}

// Importa profissionais ativos e procedimentos vendaveis do Clinica Experts.
// So CRIA/VINCULA: nunca sobrescreve preco, duracao, descricao ou vinculos que
// a clinica ja ajustou no painel da Alice (ver seedGuard).
export async function syncCatalog(clinicId: string): Promise<CatalogResult> {
  const empty: CatalogResult = {
    ok: false,
    professionals: { created: 0, linked: 0 },
    procedures: { created: 0, linked: 0, skipped: 0 },
    professionalLinks: 0,
    historyBookings: 0,
  };
  if (!(await getAccount(clinicId))) return { ...empty, error: "Clinica Experts nao conectado." };

  const cePros = await fetchAll<CePro>(clinicId, "/professionals", {});
  const ceProcs = await fetchAll<CeProc>(clinicId, "/procedures", {});
  if (!cePros || !ceProcs) return { ...empty, error: "Nao consegui ler profissionais/procedimentos do Clinica Experts (veja o erro na tela)." };

  const activePros = cePros.filter((p) => p.active);
  const result: CatalogResult = { ...empty, ok: true };

  // --- profissionais ---
  const firstNameCount = new Map<string, number>();
  for (const p of activePros) {
    const k = norm(p.first_name || p.name.split(" ")[0]);
    firstNameCount.set(k, (firstNameCount.get(k) ?? 0) + 1);
  }
  const existingPros = await prisma.professional.findMany({ where: { clinicId } });
  const aliceByUuid = new Map<string, string>();
  for (const p of activePros) {
    const first = p.first_name || p.name.split(" ")[0];
    const display = (firstNameCount.get(norm(first)) ?? 0) > 1 ? p.name : first;
    const match =
      existingPros.find((a) => a.ceUuid === p.uuid) ??
      existingPros.find((a) => !a.ceUuid && (norm(a.name) === norm(p.name) || norm(a.name) === norm(display)));
    if (match) {
      if (!match.ceUuid) {
        await prisma.professional.update({ where: { id: match.id }, data: { ceUuid: p.uuid } });
        result.professionals.linked++;
      }
      aliceByUuid.set(p.uuid, match.id);
      continue;
    }
    const created = await prisma.professional.create({
      data: { clinicId, name: display, ceUuid: p.uuid, color: p.color ? COLORS[p.color] ?? null : null, active: true },
    });
    aliceByUuid.set(p.uuid, created.id);
    result.professionals.created++;
  }

  // --- procedimentos ---
  const sellable = ceProcs.filter((p) => p.active && !isInternalProcedure(p.name));
  const existingProcs = await prisma.procedure.findMany({ where: { clinicId }, include: { professionals: { select: { id: true } } } });
  const aliceByCeId = new Map<number, { id: string; hasPros: boolean; fresh: boolean }>();
  for (const p of sellable) {
    const match =
      existingProcs.find((a) => a.ceId === p.id) ?? existingProcs.find((a) => a.ceId == null && procKey(a.name) === procKey(p.name));
    if (match) {
      if (match.ceId == null) {
        await prisma.procedure.update({ where: { id: match.id }, data: { ceId: p.id } });
        result.procedures.linked++;
      } else result.procedures.skipped++;
      aliceByCeId.set(p.id, { id: match.id, hasPros: match.professionals.length > 0, fresh: false });
      continue;
    }
    // A "Avaliacao" tem preco 0 porque e gratuita (nao "depende de avaliacao").
    const isFreeEvaluation = /^avalia/.test(norm(p.name)) && p.price <= 0;
    const reais = isFreeEvaluation ? 0 : p.price > 0 ? Math.round(p.price) / 100 : null; // a API manda em centavos
    const created = await prisma.procedure.create({
      data: {
        clinicId,
        name: p.name,
        ceId: p.id,
        durationMin: p.duration > 0 ? p.duration : 30,
        price: reais,
        priceVariable: reais == null, // sem preco no Clinica Experts: a Alice nao inventa
        aliases: isFreeEvaluation ? "avaliação gratuita, avaliação estética, avaliação" : null,
        description: isFreeEvaluation ? "Avaliação estética personalizada e gratuita para entender a queixa, os objetivos e traçar as possibilidades de tratamento." : null,
        offerInstallments: false,
        paymentMethods: "",
      },
    });
    aliceByCeId.set(p.id, { id: created.id, hasPros: false, fresh: true });
    result.procedures.created++;
  }

  // --- quem executa cada procedimento (historico de 120 dias) ---
  const to = new Date(Date.now() - 24 * 3_600_000); // ate ontem (dia inteiro)
  const from = new Date(to.getTime() - 120 * 24 * 3_600_000);
  const tz = (await prisma.clinic.findUnique({ where: { id: clinicId }, select: { timezone: true } }))?.timezone || "America/Sao_Paulo";
  const history = await fetchAll<CeBooking>(clinicId, "/bookings", { starts_at: dayBoundIso(from, tz, "start"), ends_at: dayBoundIso(to, tz, "end") });
  const usable = (history ?? []).filter((b) => b.status !== "canceled" && b.status !== "noshow");
  result.historyBookings = usable.length;

  const executors = inferExecutors(
    usable.map((b) => ({ professionalUuid: b.professional?.uuid ?? null, procedureIds: (b.procedures ?? []).map((p) => p.id) })),
    sellable.map((p) => ({ id: p.id, name: p.name })),
    new Set(activePros.map((p) => p.uuid)),
  );
  for (const p of sellable) {
    const target = aliceByCeId.get(p.id);
    if (!target || target.hasPros) continue; // nunca mexe em vinculo que ja existe
    const ids = (executors.get(p.id) ?? []).map((u) => aliceByUuid.get(u)).filter((x): x is string => !!x);
    if (!ids.length) continue;
    await prisma.procedure.update({ where: { id: target.id }, data: { professionals: { connect: ids.map((id) => ({ id })) } } });
    result.professionalLinks += ids.length;
  }

  await prisma.clinicaExpertsAccount.updateMany({ where: { clinicId }, data: { lastCatalogAt: new Date(), lastError: null } });
  return result;
}
