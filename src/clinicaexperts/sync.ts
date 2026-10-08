import { prisma } from "../db/client.js";
import { notifyStaff } from "../crm/notify.js";
import { formatDateTimeInZone } from "../scheduling/time.js";
import { ceRequest, dayBoundIso, getAccount, isoWithOffset, noteError } from "./client.js";
import { invalidateCeCache } from "./availability.js";

// ---------------------------------------------------------------------------
// Agendamento da Alice -> Clinica Experts
// ---------------------------------------------------------------------------

// Serializa as chamadas de um mesmo agendamento (criar e logo remarcar nao
// podem correr em paralelo, senao o segundo nao enxerga o uuid do primeiro).
const chains = new Map<string, Promise<void>>();
function serial(key: string, job: () => Promise<void>): Promise<void> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(job);
  chains.set(key, next);
  void next.finally(() => {
    if (chains.get(key) === next) chains.delete(key);
  });
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

async function alertFailure(clinicId: string, text: string): Promise<void> {
  await noteError(clinicId, text);
  await notifyStaff(
    clinicId,
    "automation_failed",
    `⚠️ Não consegui espelhar um agendamento no Clínica Experts: ${text}. Confira e lance manualmente para evitar horário duplicado.`,
  );
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
    const found = await ceRequest<{ data: { uuid: string; name?: string | null; phone: string | null }[] }>(clinicId, "/patients", { query: { phone: digits, per_page: 5 } });
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
  } catch (err) {
    console.error("[clinicaexperts] enrichPatientFromCe:", err);
  }
}

export function syncAppointment(appointmentId: string): Promise<void> {
  return serial(appointmentId, async () => {
    const appt = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: { patient: true, procedure: true, professional: true, clinic: true },
    });
    if (!appt) return;
    const account = await getAccount(appt.clinicId);
    if (!account || !account.syncOut) return;

    const tz = appt.clinic.timezone || "America/Sao_Paulo";
    const label = `${appt.patient.name ?? appt.patient.phone} - ${appt.procedure.name} em ${formatDateTimeInZone(appt.scheduledAt, tz)}`;

    // Cancelamento: so cancela la se o agendamento tinha sido espelhado.
    if (appt.status === "cancelled") {
      if (!appt.ceBookingUuid) return;
      const res = await ceRequest(appt.clinicId, `/bookings/${appt.ceBookingUuid}/cancel`, { method: "PATCH" });
      if (!res.ok) return alertFailure(appt.clinicId, `cancelamento de ${label} (${res.error})`);
      await prisma.appointment.update({ where: { id: appt.id }, data: { ceBookingUuid: null } });
      invalidateCeCache(appt.clinicId);
      return;
    }
    // Atendido/faltou: quem muda isso la e a equipe, no proprio Clinica Experts.
    if (appt.status !== "confirmed") return;

    if (!appt.procedure.ceId || !appt.professional?.ceUuid) {
      return alertFailure(appt.clinicId, `${label} (procedimento ou profissional sem vínculo com o Clínica Experts; rode "Sincronizar catálogo")`);
    }
    const patientUuid = await ensurePatientUuid(appt.clinicId, appt.patient);
    if (!patientUuid) return alertFailure(appt.clinicId, `${label} (não consegui localizar nem criar o paciente)`);

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
      if (!res.ok) return alertFailure(appt.clinicId, `remarcação de ${label} (${res.error})`);
    } else {
      const res = await ceRequest<{ data: { uuid: string } }>(appt.clinicId, "/bookings", { method: "POST", body: { ...body, status: "scheduled" } });
      if (!res.ok) return alertFailure(appt.clinicId, `${label} (${res.error})`);
      const uuid = res.data.data?.uuid;
      if (uuid) await prisma.appointment.update({ where: { id: appt.id }, data: { ceBookingUuid: uuid } });
    }
    invalidateCeCache(appt.clinicId);
    await prisma.clinicaExpertsAccount.updateMany({ where: { clinicId: appt.clinicId }, data: { lastSyncAt: new Date(), lastError: null } });
  });
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
      existingProcs.find((a) => a.ceId === p.id) ?? existingProcs.find((a) => a.ceId == null && norm(a.name) === norm(p.name));
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
