import { scheduleLocked } from "../jobs/lock.js";
import { birthFieldOf, parseCeBirthDate } from "./birthdays.js";
import { prisma } from "../db/client.js";
import { ceRequest, dayBoundIso, noteError } from "./client.js";
import { zonedWallClockToUtc } from "../scheduling/time.js";
import { ensurePlaceholderProcedure, isPlaceholderProcedure } from "./placeholderProcedure.js";
import { reconcileMissingBookings } from "./liveCheck.js";
import { scheduleBriefingRefreshForAppointment } from "../ai/leadBriefing.js";
import { syncAppointmentInBackground } from "./sync.js";
import { notifyStaff } from "../crm/notify.js";
import { listCeProcedures, linkMissingProcedures } from "./autoLink.js";

// ---------------------------------------------------------------------------
// Clinica Experts -> Alice: agendamentos feitos DIRETO no Clinica Experts
// (recepcao, telefone, presencial) viram Appointment aqui, pra os lembretes de
// confirmacao enxergarem a agenda real. So grava no banco: NAO manda mensagem,
// NAO avisa a equipe e NAO espelha de volta (nao passa por createBooking).
// ---------------------------------------------------------------------------

const DAYS_AHEAD = 3; // hoje + proximos dias
const DAYS_BEHIND = 2; // dias passados: SO atualizam status (ex.: concluido depois do dia), nunca criam
const PULL_EVERY = "*/10 * * * *";

export interface CeBookingLite {
  uuid?: string;
  status?: string;
  starts_at?: string;
  professional?: { uuid?: string } | null;
  patient?: { uuid?: string; name?: string | null; phone?: string | null } | null;
  procedures?: { id: number }[];
  [k: string]: unknown; // o CE pode mandar o procedimento em outro campo: ver extractProcedureIds
}

// PURO: status do Clinica Experts -> status da Alice. "scheduled"/confirmado
// vira confirmed; cancelado e falta sao espelhados; concluido vira completed.
export function mapCeStatus(raw: string | undefined): "confirmed" | "cancelled" | "no_show" | "completed" {
  const s = (raw ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (s.startsWith("cancel")) return "cancelled";
  if (s.includes("noshow") || s.includes("missed") || s === "faltou") return "no_show";
  if (s.includes("complet") || s.includes("done") || s.includes("attended") || s.includes("finish")) return "completed";
  return "confirmed";
}

// PURO: telefone do CE ("+55 11 94949-4707", "11949494707"...) -> digitos com DDI 55.
export function normalizeCePhone(raw: string | null | undefined): string | null {
  const d = (raw ?? "").replace(/\D/g, "");
  if (d.length < 10) return null;
  if (d.startsWith("55") && d.length >= 12) return d;
  if (d.length === 10 || d.length === 11) return `55${d}`;
  return d;
}

// PURO: nome de procedimento que e so a avaliacao (nao o servico em si).
export function isEvaluationName(name: string): boolean {
  return /^\s*avalia/i.test(name.normalize("NFD").replace(/[\u0300-\u036f]/g, ""));
}

// ---------------------------------------------------------------------------
// PROCEDIMENTO DA RESERVA (14/10/2026): varias reservas da Lisboa chegavam com "procedures" vazio e ficavam fora das confirmacoes
// ("reserva sem procedimento"), mesmo a paciente tendo recebido a mensagem com o nome do procedimento. O CE pode guardar o procedimento
// em outro campo (servico, item, sessao, pacote) ou so no detalhe da reserva. Aqui o extrator aceita as formas usuais; quando a lista nao
// traz nada, a importacao consulta o DETALHE da reserva (1x por hora por reserva) e o diagnostico guarda os nomes de campo que o CE devolveu.
// ---------------------------------------------------------------------------
const PROC_KEYS = ["procedures", "procedure", "services", "service", "items", "sessions", "session", "packages", "package", "treatments", "booking_procedures", "appointment_procedures", "sold_procedures"];

function idOf(x: unknown): number | null {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string" && /^\d+$/.test(x.trim())) return Number(x.trim());
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    for (const k of ["procedure_id", "service_id", "id"]) {
      const v = idOf(o[k]);
      if (v != null) return v;
    }
    for (const k of ["procedure", "service"]) {
      const v = o[k] && typeof o[k] === "object" ? idOf(o[k]) : null;
      if (v != null) return v;
    }
  }
  return null;
}

// PURO: ids de procedimento do CE que a reserva traz, em qualquer um dos campos conhecidos (ignora o que nao for id).
export function extractProcedureIds(booking: unknown, depth = 0): number[] {
  if (!booking || typeof booking !== "object" || depth > 2) return [];
  const rec = booking as Record<string, unknown>;
  const out: number[] = [];
  for (const key of PROC_KEYS) {
    const v = rec[key];
    if (v == null) continue;
    const list = Array.isArray(v) ? v : [v];
    for (const item of list) {
      // pacote/sessao: pode trazer a lista de procedimentos por dentro
      if (item && typeof item === "object" && Array.isArray((item as Record<string, unknown>).procedures)) out.push(...extractProcedureIds(item, depth + 1));
      const id = idOf(item);
      if (id != null) out.push(id);
    }
    if (out.length) break; // o primeiro campo que trouxe algo vale
  }
  return [...new Set(out)];
}

// Campos que o CE devolveu para reservas sem procedimento (so nomes e valores NAO pessoais): alimenta o botao de diagnostico.
export interface BookingDiagnostic {
  uuid: string;
  startsAt: string;
  status: string;
  listKeys: string[];
  detailKeys: string[] | null;
  detailFound: number[];
  safe: Record<string, string | number | boolean | null>;
}
export const lastBookingDiagnostics = new Map<string, { at: Date; items: BookingDiagnostic[] }>();
const PERSONAL_KEY = /name|nome|phone|fone|tel|email|mail|cpf|document|address|endereco|birth|nasc|note|obs|comment|photo|avatar|token/i;
const detailTried = new Map<string, number>(); // uuid -> quando consultou o detalhe (1x por hora)

function safeScalars(obj: unknown): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (PERSONAL_KEY.test(k)) continue;
    if (v === null || typeof v === "boolean" || typeof v === "number") out[k] = v as null | boolean | number;
    else if (typeof v === "string") out[k] = v.slice(0, 60);
    else if (Array.isArray(v)) out[k] = `[lista com ${v.length}]`;
    else if (typeof v === "object") out[k] = `{${Object.keys(v as object).slice(0, 8).join(",")}}`;
  }
  return out;
}

// Uma reserva pode ter varios procedimentos (ex.: "Avaliacao" + o procedimento
// de verdade). A confirmacao tem que citar o PROCEDIMENTO, nao a avaliacao:
// prefere o primeiro que nao seja avaliacao e que exista na Alice.
function pickProcedure<P extends { id: string; name: string }>(b: CeBookingLite, byCeId: Map<number, P>): P | null {
  const ceIds = (b.procedures ?? []).map((p) => p.id);
  const ordered = ceIds.map((id) => byCeId.get(id)).filter((p): p is P => !!p);
  return ordered.find((p) => !isEvaluationName(p.name)) ?? ordered[0] ?? null;
}

// PURO: instante de uma reserva do Clinica Experts. Com fuso explicito (Z ou
// +/-hh:mm) usa direto; SEM fuso ("2026-10-09T15:00:00") le como horario de
// parede no fuso da clinica - nunca no fuso do servidor (que e UTC no VPS e
// deslocaria o horario em 3h).
export function parseCeInstant(raw: string, timeZone: string): Date {
  const text = raw.trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(text)) return new Date(text);
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(text);
  if (!m) return new Date(NaN);
  return zonedWallClockToUtc(timeZone, Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
}

// Reserva do Clinica Experts que NAO virou agendamento na Alice (portanto nao recebe lembrete/confirmacao).
export interface PullSkip {
  uuid: string;
  startsAt: string; // ISO
  patient: string; // nome ou telefone
  reason: "sem_telefone" | "procedimento_sem_vinculo";
  procedureIds: number[]; // ids do Clinica Experts
  procedureNames: string[]; // nomes no CE ("#id" quando nao deu pra consultar)
}

export interface PullResult {
  created: number;
  updated: number;
  skipped: number;
  skippedNote: string[];
  skipDetails: PullSkip[];
  error?: string;
}

// Ultimo resultado da importacao por clinica (so em memoria): alimenta o relatorio de cobertura das confirmacoes.
export const lastPullSkips = new Map<string, { at: Date; skips: PullSkip[] }>();

function ymd(d: Date, tz: string): [number, number, number] {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d).split("-").map(Number);
  return [parts[0], parts[1], parts[2]];
}

// UMA importacao por clinica de cada vez: o cron (a cada 10 min) e o botao "Importar do Clinica Experts" podiam rodar juntos, ler "esta reserva ainda
// nao existe" ao mesmo tempo e criar a MESMA reserva duas vezes (duas copias locais da mesma reserva = duas confirmacoes). Quem chega durante uma
// importacao em andamento recebe o resultado dela. (Entre varias copias do servidor na troca de versao o risco continua pequeno: o controle de
// lembretes usa a identidade da reserva no CE, nao o id local.)
const pullsInFlight = new Map<string, Promise<PullResult>>();
export function pullClinicBookings(clinicId: string): Promise<PullResult> {
  const running = pullsInFlight.get(clinicId);
  if (running) return running;
  const p = pullClinicBookingsNow(clinicId).finally(() => pullsInFlight.delete(clinicId));
  pullsInFlight.set(clinicId, p);
  return p;
}

async function pullClinicBookingsNow(clinicId: string): Promise<PullResult> {
  const result: PullResult = { created: 0, updated: 0, skipped: 0, skippedNote: [], skipDetails: [] };
  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { timezone: true } });
  const tz = clinic?.timezone || "America/Sao_Paulo";

  const bookings: CeBookingLite[] = [];
  for (let i = -DAYS_BEHIND; i <= DAYS_AHEAD; i++) {
    const day = new Date(Date.now() + i * 24 * 3_600_000);
    // /bookings so e confiavel com janela de DIA INTEIRO (ver memoria da integracao).
    const res = await ceRequest<{ data: CeBookingLite[] }>(clinicId, "/bookings", {
      query: { starts_at: dayBoundIso(day, tz, "start"), ends_at: dayBoundIso(day, tz, "end"), per_page: 1000 },
    });
    if (!res.ok) return { ...result, error: res.error };
    bookings.push(...(res.data.data ?? []));
  }

  // Carrega TUDO de uma vez (antes eram ~7 consultas ao banco POR reserva, a cada 10 min - com 1
  // nucleo de CPU isso saturava o servidor).
  let procRows = await prisma.procedure.findMany({ where: { clinicId, ceId: { not: null } } });
  const procByCeId = new Map(procRows.map((p) => [p.ceId as number, p]));
  const ceNames = new Map<number, string>(); // nome dos procedimentos do CE (so preenchido quando precisou consultar)
  const proRows = await prisma.professional.findMany({ where: { clinicId, ceUuid: { not: null } }, select: { id: true, ceUuid: true } });
  const proByUuid = new Map(proRows.map((p) => [p.ceUuid as string, p]));
  const uuids = bookings.map((b) => b.uuid).filter((u): u is string => !!u);
  const existingRows = uuids.length
    ? await prisma.appointment.findMany({ where: { clinicId, ceBookingUuid: { in: uuids } }, include: { procedure: true } })
    : [];
  const existingByUuid = new Map(existingRows.map((a) => [a.ceBookingUuid as string, a]));

  // Reservas novas e futuras SEM procedimento na lista: tenta os outros campos e, se preciso, o detalhe da reserva (teto de 20 por rodada).
  const diagnostics: BookingDiagnostic[] = [];
  let detailCalls = 0;
  for (const b of bookings) {
    if (!b.uuid || !b.starts_at || existingByUuid.has(b.uuid)) continue;
    const st0 = mapCeStatus(b.status);
    if (st0 === "cancelled" || st0 === "no_show") continue;
    const at0 = parseCeInstant(b.starts_at, tz);
    if (Number.isNaN(at0.getTime()) || at0.getTime() < Date.now()) continue;
    if ((b.procedures ?? []).length) continue;
    let ids = extractProcedureIds(b);
    let detailKeys: string[] | null = null;
    let detailObj: unknown = null;
    if (!ids.length && detailCalls < 20 && Date.now() - (detailTried.get(b.uuid) ?? 0) > 3_600_000) {
      detailTried.set(b.uuid, Date.now());
      detailCalls++;
      const det = await ceRequest<{ data?: unknown }>(clinicId, `/bookings/${b.uuid}`);
      if (det.ok) {
        detailObj = (det.data as { data?: unknown })?.data ?? det.data;
        detailKeys = detailObj && typeof detailObj === "object" ? Object.keys(detailObj as object) : null;
        ids = extractProcedureIds(detailObj);
      }
    }
    if (ids.length) {
      b.procedures = ids.map((id) => ({ id }));
      console.log(`[clinicaexperts] procedimento da reserva ${b.uuid.slice(0, 8)} lido de outro campo/detalhe: ${ids.join(",")}`);
    } else {
      diagnostics.push({ uuid: b.uuid.slice(0, 8), startsAt: b.starts_at, status: String(b.status ?? ""), listKeys: Object.keys(b), detailKeys, detailFound: ids, safe: safeScalars(detailObj ?? b) });
    }
  }
  if (diagnostics.length) {
    lastBookingDiagnostics.set(clinicId, { at: new Date(), items: diagnostics.slice(0, 15) });
    console.warn(`[clinicaexperts] ${diagnostics.length} reserva(s) futura(s) sem procedimento mesmo no detalhe; campos da lista: ${diagnostics[0].listKeys.join(",")}; detalhe: ${(diagnostics[0].detailKeys ?? []).join(",")}`);
  }

  // Reservas novas e futuras cujo procedimento ainda nao existe aqui (criado no CE depois do ultimo "Sincronizar catalogo", ou
  // item interno como "Retoque"): cria/vincula so o que falta, em vez de descartar a reserva e deixar a pessoa sem confirmacao.
  const needCe = new Set<number>();
  for (const b of bookings) {
    if (!b.uuid || !b.starts_at || existingByUuid.has(b.uuid)) continue;
    const st = mapCeStatus(b.status);
    if (st === "cancelled" || st === "no_show") continue;
    const at = parseCeInstant(b.starts_at, tz);
    if (Number.isNaN(at.getTime()) || at.getTime() < Date.now()) continue;
    if (!normalizeCePhone(b.patient?.phone) || pickProcedure(b, procByCeId)) continue;
    for (const p of b.procedures ?? []) needCe.add(p.id);
  }
  if (needCe.size) {
    try {
      const ceProcs = await listCeProcedures(clinicId);
      if (ceProcs) {
        for (const p of ceProcs) ceNames.set(p.id, p.name);
        const linked = await linkMissingProcedures(clinicId, [...needCe], ceProcs);
        if (linked.created || linked.internal || linked.linked) {
          console.log(`[clinicaexperts] procedimentos vinculados na importacao: ${linked.created} novo(s), ${linked.internal} interno(s), ${linked.linked} por nome`);
          procRows = await prisma.procedure.findMany({ where: { clinicId, ceId: { not: null } } });
          procByCeId.clear();
          for (const p of procRows) procByCeId.set(p.ceId as number, p);
        }
      }
    } catch (err) {
      console.error("[clinicaexperts] vincular procedimentos faltantes:", err);
    }
  }

  const seen = new Set<string>();
  for (const b of bookings) {
    if (!b.uuid || seen.has(b.uuid) || !b.starts_at) continue;
    seen.add(b.uuid);
    const when = parseCeInstant(b.starts_at, tz);
    if (Number.isNaN(when.getTime())) { result.skipped++; continue; }
    const status = mapCeStatus(b.status);

    const picked = pickProcedure(b, procByCeId);
    const existing = existingByUuid.get(b.uuid) ?? null;
    if (existing) {
      const data: { scheduledAt?: Date; status?: string; professionalId?: string | null; procedureId?: string; cancelledAt?: Date; cancelSource?: string } = {};
      // Importado antes como "Avaliacao" mas a reserva tem o procedimento de verdade: corrige.
      if (picked && picked.id !== existing.procedureId && isEvaluationName(existing.procedure.name) && !isEvaluationName(picked.name)) data.procedureId = picked.id;
      // Entrou sem procedimento (a recepcao ainda nao tinha escolhido) e agora tem: passa a ser o de verdade.
      if (picked && picked.id !== existing.procedureId && isPlaceholderProcedure(existing.procedure)) data.procedureId = picked.id;
      if (existing.scheduledAt.getTime() !== when.getTime()) {
        data.scheduledAt = when;
        // A recepcao trocou o horario la: a confirmacao enviada era do horario ANTIGO. Zera e libera os lembretes pro horario novo.
        await prisma.appointment.update({ where: { id: existing.id }, data: { patientConfirmed: false, confirmedAt: null } });
        await prisma.reminderSent.deleteMany({ where: { appointmentId: existing.id } });
      }
      // "confirmed" nunca rebaixa um atendimento que ja foi concluido/faltou aqui.
      if (status !== "confirmed" && existing.status !== status) {
        data.status = status;
        if (status === "cancelled") { data.cancelledAt = new Date(); data.cancelSource = "ce_cancelada"; } // o CE disse "cancelada" (prova)
      }
      // Cancelado AQUI mas ainda "confirmado" la: o cancelamento nao chegou no Clinica Experts (o espelho so perde o
      // vinculo quando o cancelamento da certo). Reativar aqui desfazia o cancelamento da clinica e o paciente voltava a
      // receber lembrete; o certo e tentar cancelar la de novo.
      if (status === "confirmed" && existing.status === "cancelled") syncAppointmentInBackground(existing.id);
      if (Object.keys(data).length) {
        await prisma.appointment.update({ where: { id: existing.id }, data });
        result.updated++;
        scheduleBriefingRefreshForAppointment(existing.id); // mudou la (status/horario/procedimento): a memoria do lead acompanha
      }
      continue;
    }

    if (status === "cancelled" || status === "no_show") { result.skipped++; continue; }
    // Reserva JA PASSADA que nunca foi importada: nao cria (so serviria pra disparar
    // pos-procedimento/recontato retroativo). Os dias passados da janela existem so
    // pra atualizar o status do que ja estava aqui.
    if (when.getTime() < Date.now()) { result.skipped++; continue; }

    const procedure = picked;
    const phone = normalizeCePhone(b.patient?.phone);
    // Reserva sem procedimento no CE, mas a pessoa JA tem esse horario na Alice (agendado pela Alice ou importado antes, sem o vinculo
    // com a reserva): so liga o uuid. Antes desistia aqui e a pessoa aparecia no aviso "NAO vao receber a confirmacao" mesmo recebendo.
    if (!procedure && phone) {
      const known = await prisma.patient.findUnique({ where: { clinicId_phone: { clinicId, phone } } });
      const own = known
        ? await prisma.appointment.findFirst({ where: { clinicId, patientId: known.id, scheduledAt: when, ceBookingUuid: null, status: "confirmed" } })
        : null;
      if (own) {
        await prisma.appointment.update({ where: { id: own.id }, data: { ceBookingUuid: b.uuid } });
        result.updated++;
        continue;
      }
    }
    if (!phone) {
      // sem telefone: nao ha como lembrar
      result.skipped++;
      result.skippedNote.push("sem telefone");
      result.skipDetails.push({
        uuid: b.uuid,
        startsAt: when.toISOString(),
        patient: b.patient?.name?.trim() || "(sem nome)",
        reason: "sem_telefone",
        procedureIds: (b.procedures ?? []).map((p) => p.id),
        procedureNames: (b.procedures ?? []).map((p) => ceNames.get(p.id) ?? `#${p.id}`),
      });
      continue;
    }
    // Sem procedimento (ou procedimento que nao existe aqui): ENTRA mesmo assim, com o procedimento interno "horario sem procedimento", e a
    // confirmacao sai so com data e horario. Antes a pessoa ficava sem confirmacao nenhuma (pedido da Lisboa, 16/10).
    const procedureForBooking = procedure ?? (await ensurePlaceholderProcedure(clinicId));

    const professional = b.professional?.uuid ? proByUuid.get(b.professional.uuid) ?? null : null;

    // Agendamento da propria Alice cujo uuid ainda nao tinha sido gravado (corrida
    // com o espelhamento): so anexa o uuid, nao duplica.
    const patientForMatch = await prisma.patient.findUnique({ where: { clinicId_phone: { clinicId, phone } } });
    if (patientForMatch) {
      const own = await prisma.appointment.findFirst({
        where: { clinicId, patientId: patientForMatch.id, scheduledAt: when, ceBookingUuid: null, status: "confirmed" },
      });
      if (own) {
        await prisma.appointment.update({ where: { id: own.id }, data: { ceBookingUuid: b.uuid } });
        result.updated++;
        continue;
      }
    }

    const patient = await prisma.patient.upsert({
      where: { clinicId_phone: { clinicId, phone } },
      update: { ceUuid: b.patient?.uuid ?? undefined },
      create: { clinicId, phone, name: b.patient?.name?.trim() || null, ceUuid: b.patient?.uuid ?? null },
    });
    const birth = parseCeBirthDate(birthFieldOf(b.patient).raw); // aniversario do CE (so preenche se a Alice nao tem)
    if (birth) await prisma.patient.updateMany({ where: { id: patient.id, birthDate: null }, data: { birthDate: birth } });
    const createdAppt = await prisma.appointment.create({
      data: {
        clinicId, patientId: patient.id, procedureId: procedureForBooking.id, professionalId: professional?.id ?? null,
        scheduledAt: when, status, source: "presencial", ceBookingUuid: b.uuid,
      },
    });
    result.created++;
    scheduleBriefingRefreshForAppointment(createdAppt.id);
  }
  lastPullSkips.set(clinicId, { at: new Date(), skips: result.skipDetails });

  // Reservas que a Alice tem como confirmadas mas o CE nao devolveu mais (apagadas ou trocadas la): confere ao vivo e cancela aqui.
  try {
    const todayStart = zonedWallClockToUtc(tz, ...ymd(new Date(), tz), 0, 0);
    const windowEnd = new Date(todayStart.getTime() + (DAYS_AHEAD + 1) * 24 * 3_600_000);
    const rec = await reconcileMissingBookings(clinicId, new Set(bookings.map((b) => b.uuid).filter((u): u is string => !!u)), { from: new Date(), to: windowEnd }, tz);
    if (rec.cancelled || rec.moved) console.log(`[clinicaexperts] ${rec.cancelled} agendamento(s) cancelado(s) e ${rec.moved} corrigido(s) por terem sumido/mudado no CE`);
  } catch (err) {
    console.error("[clinicaexperts] reconciliacao:", err);
  }
  return result;
}

// PURO: por que a reserva nao entra nas confirmacoes. "?" confundia: lista de procedimentos VAZIA quer dizer que a reserva foi criada no
// Clinica Experts sem procedimento escolhido (com procedimento desconhecido o aviso mostra o numero, "#123").
export function skipReasonText(s: Pick<PullSkip, "reason" | "procedureNames">): string {
  if (s.reason === "sem_telefone") return "sem telefone";
  return s.procedureNames.length ? `procedimento sem vínculo: ${s.procedureNames.join(", ")}` : "reserva sem procedimento no Clínica Experts (escolha o procedimento lá)";
}

// Aviso diario a equipe: reservas das proximas 48h que NAO entram nas confirmacoes automaticas (sem isso so se
// descobria quando o paciente reclamava que nao recebeu).
const skipAlertedOn = new Map<string, string>();
async function alertSkippedSoon(clinicId: string, skips: PullSkip[]): Promise<void> {
  const horizon = Date.now() + 48 * 3_600_000;
  const soon = skips.filter((s) => new Date(s.startsAt).getTime() > Date.now() && new Date(s.startsAt).getTime() <= horizon);
  if (!soon.length) return;
  const today = new Date().toISOString().slice(0, 10);
  if (skipAlertedOn.get(clinicId) === today) return;
  skipAlertedOn.set(clinicId, today);
  const lines = soon.slice(0, 8).map((s) => `• ${s.patient} (${skipReasonText(s)})`);
  await notifyStaff(
    clinicId,
    "automation_failed",
    `⚠️ ${soon.length} agendamento(s) de hoje/amanhã do Clínica Experts NÃO vão receber a confirmação automática:\n${lines.join("\n")}${soon.length > 8 ? `\n…e mais ${soon.length - 8}.` : ""}\nCorrija o telefone no Clínica Experts ou vincule o procedimento (Sincronizar catálogo) e confirme com o paciente manualmente.`,
  );
}

let running = false;

export function startCeBookingPullJob(): void {
  scheduleLocked("importacao-clinica-experts", PULL_EVERY, async () => {
    if (running) return;
    running = true;
    try {
      const accounts = await prisma.clinicaExpertsAccount.findMany({ select: { clinicId: true } });
      for (const a of accounts) {
        try {
          const r = await pullClinicBookings(a.clinicId);
          if (!r.error) await alertSkippedSoon(a.clinicId, r.skipDetails);
          if (r.error) await noteError(a.clinicId, `Importação da agenda: ${r.error}`);
          else {
            // Reservas sem telefone ou com procedimento nao vinculado NAO recebem lembrete: avisa na tela.
            const notes = r.skippedNote.length
              ? `Aviso: ${r.skippedNote.length} agendamento(s) dos próximos dias não entram nos lembretes (${[...new Set(r.skippedNote)].join(", ")}). Confira o telefone no Clínica Experts ou rode "Importar do Clínica Experts".`
              : null;
            await prisma.clinicaExpertsAccount.updateMany({ where: { clinicId: a.clinicId }, data: { lastSyncAt: new Date(), lastError: notes } });
          }
        } catch (err) {
          console.error("[clinicaexperts] pull:", err);
        }
      }
    } finally {
      running = false;
    }
  });
}
