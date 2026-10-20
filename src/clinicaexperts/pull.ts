import { scheduleLocked } from "../jobs/lock.js";
import type { Prisma, Procedure } from "@prisma/client";
import { parseBookingResource, type CeBookingParsed } from "./contract.js";
import { birthFieldOf, parseCeBirthDate } from "./birthdays.js";
import { prisma } from "../db/client.js";
import { ceListAll, ceRequest, dayBoundIso, noteError } from "./client.js";
import { formatDateTimeInZone, zonedWallClockToUtc } from "../scheduling/time.js";
import { reservationDurationMin } from "../scheduling/reservation.js";
import { ensurePlaceholderProcedure, isPlaceholderProcedure } from "./placeholderProcedure.js";
import { reconcileMissingBookings, recoverLateStatuses } from "./liveCheck.js";
import { logActivity } from "../crm/activity.js";
import { namesCompatible, pickUniqueMatch } from "./match.js";
import { phoneQueryForms } from "./identity.js";
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

// PURO: status do Clinica Experts -> status da Alice (ver contract.ts). DESCONHECIDO devolve null (nunca vira "confirmed" por padrao).
export { mapCeStatus, parseCeInstant } from "./contract.js";

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


// Reserva do Clinica Experts que NAO virou agendamento na Alice (portanto nao recebe lembrete/confirmacao).
export interface PullSkip {
  uuid: string;
  startsAt: string; // ISO
  patient: string; // nome ou telefone
  reason: "sem_telefone" | "procedimento_sem_vinculo" | "estado_desconhecido";
  procedureIds: number[]; // ids do Clinica Experts
  procedureNames: string[]; // nomes no CE ("#id" quando nao deu pra consultar)
}

export interface PullResult {
  created: number;
  updated: number;
  skipped: number;
  skippedNote: string[];
  skipDetails: PullSkip[];
  invalid: number; // reservas ilegiveis (HTTP 200 com campos essenciais ausentes): ignoradas, nunca viram cancelamento
  incompleteDays: number; // dias cuja listagem nao fechou o total informado pelo CE
  unknownStates: string[]; // estados do CE que a Alice nao conhece (preservados no campo bruto; nunca tratados como confirmado)
  divergences: number; // reservas cuja pessoa no CE difere da daqui
  reactivated: number; // cancelamento nosso desfeito porque a recepcao reativou no CE (versao mais nova)
  cancelRetried: number; // cancelamentos nossos que o CE ainda nao recebeu e foram reenviados
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

// Reserva lida do CE + os ids de procedimento (a lista, ou outro campo/detalhe quando a lista veio vazia).
interface Work { b: CeBookingParsed; raw: Record<string, unknown>; procIds: number[] }

interface PullCtx {
  clinicId: string;
  tz: string;
  procByCeId: Map<number, Procedure>;
  proByUuid: Map<string, { id: string; ceUuid: string | null }>;
  result: PullResult;
}

const divergenceSeen = new Set<string>();
const unknownStateSeen = new Set<string>();

function pickByIds(ids: number[], byCeId: Map<number, Procedure>): Procedure | null {
  const ordered = ids.map((id) => byCeId.get(id)).filter((p): p is Procedure => !!p);
  return ordered.find((p) => !isEvaluationName(p.name)) ?? ordered[0] ?? null;
}

// Grava TODOS os procedimentos da reserva (a lista inteira, na ordem do CE). Lista vazia no CE nao apaga o que ja se sabe ("sem dado" != "sem procedimento").
async function replaceProcedures(appointmentId: string, b: CeBookingParsed, ids: number[], byCeId: Map<number, Procedure>): Promise<void> {
  if (!ids.length) return;
  const byId = new Map(b.procedures.map((p) => [p.id, p]));
  await prisma.appointmentProcedure.deleteMany({ where: { appointmentId } });
  await prisma.appointmentProcedure.createMany({
    data: ids.map((id, position) => {
      const local = byCeId.get(id);
      const ce = byId.get(id);
      return { appointmentId, ceProcedureId: id, procedureId: local?.id ?? null, name: ce?.name ?? local?.name ?? `#${id}`, durationMin: ce?.duration ?? local?.durationMin ?? null, position };
    }),
  });
}

const sameIds = (a: number[], b: number[]) => a.length === b.length && [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);

// A pessoa da reserva do CE: o cadastro local certo, SEM nunca sobrescrever o uuid de outro cadastro. Mesmo telefone com pessoa diferente (casal, familia) vira acompanhante
// do contato (Attendee), nao troca o uuid do paciente.
async function resolvePerson(ctx: PullCtx, b: CeBookingParsed): Promise<{ patientId: string; attendeeId: string | null; patientName: string | null } | null> {
  const { clinicId } = ctx;
  const uuid = b.patient?.uuid ?? null;
  const phone = normalizeCePhone(b.patient?.phone);
  const ceName = b.patient?.name ?? null;
  const birth = parseCeBirthDate(birthFieldOf(b.patient?.raw ?? {}).raw);
  if (uuid) {
    const byUuid = await prisma.patient.findFirst({ where: { clinicId, ceUuid: uuid } });
    if (byUuid) {
      if (birth) await prisma.patient.updateMany({ where: { id: byUuid.id, birthDate: null }, data: { birthDate: birth } });
      return { patientId: byUuid.id, attendeeId: null, patientName: byUuid.name };
    }
    const att = await prisma.attendee.findFirst({ where: { clinicId, ceUuid: uuid }, include: { contactPatient: true } });
    if (att) return { patientId: att.contactPatientId, attendeeId: att.id, patientName: att.contactPatient.name };
  }
  if (!phone) return null;
  const forms = [...new Set([phone, ...phoneQueryForms(phone)])];
  let contact = await prisma.patient.findUnique({ where: { clinicId_phone: { clinicId, phone } } });
  if (!contact) contact = await prisma.patient.findFirst({ where: { clinicId, phone: { in: forms } } }); // mesmo numero em outro formato (com/sem 9)
  if (!contact) {
    try {
      contact = await prisma.patient.create({ data: { clinicId, phone, name: ceName, ceUuid: uuid, ...(birth ? { birthDate: birth } : {}) } });
    } catch (e) {
      if ((e as { code?: string })?.code !== "P2002") throw e;
      contact = await prisma.patient.findUnique({ where: { clinicId_phone: { clinicId, phone } } });
      if (!contact) throw e;
    }
    return { patientId: contact.id, attendeeId: null, patientName: contact.name };
  }
  // Ja existe cadastro com este telefone.
  const differentPerson = !!uuid && ((!!contact.ceUuid && contact.ceUuid !== uuid) || (!contact.ceUuid && !namesCompatible(contact.name, ceName)));
  if (!differentPerson) {
    if (uuid && !contact.ceUuid) await prisma.patient.update({ where: { id: contact.id }, data: { ceUuid: uuid } }); // primeiro vinculo (nenhum outro cadastro tem este uuid: conferido acima)
    if (birth) await prisma.patient.updateMany({ where: { id: contact.id, birthDate: null }, data: { birthDate: birth } });
    return { patientId: contact.id, attendeeId: null, patientName: contact.name };
  }
  const att = await prisma.attendee.create({ data: { clinicId, contactPatientId: contact.id, name: ceName?.trim() || "Acompanhante", ceUuid: uuid, ...(birth ? { birthDate: birth } : {}) } });
  console.log(`[clinicaexperts] telefone compartilhado: a reserva ${b.uuid.slice(0, 8)} e de outra pessoa (${att.name}); registrada como acompanhante do contato, sem trocar o cadastro existente`);
  return { patientId: contact.id, attendeeId: att.id, patientName: contact.name };
}

type ExistingRow = Prisma.AppointmentGetPayload<{ include: { procedure: true; patient: true; attendee: true; procedures: true } }>;

// Atualiza um agendamento que JA existe aqui com o que o CE diz agora. O CE e a verdade do calendario; o que e so da Alice (confirmacao do paciente) so cai quando o horario muda.
async function refreshExisting(ctx: PullCtx, existing: ExistingRow, w: Work, picked: Procedure | null): Promise<void> {
  const { b } = w;
  const now = new Date();
  const meaning = b.status.meaning;
  const data: {
    scheduledAt?: Date; endsAt?: Date | null; status?: string; professionalId?: string | null; procedureId?: string; cancelledAt?: Date | null; cancelSource?: string | null;
    ceCancelState?: string | null; patientConfirmed?: boolean; confirmedAt?: Date | null; cePresenceState?: string | null; cePresenceAt?: Date | null;
  } = {};
  let activity: { type: string; title: string; description: string } | null = null;

  if (picked && picked.id !== existing.procedureId && (isEvaluationName(existing.procedure.name) || isPlaceholderProcedure(existing.procedure)) && !isEvaluationName(picked.name)) data.procedureId = picked.id; // era "Avaliacao"/sem procedimento: agora tem o de verdade
  else if (picked && picked.id !== existing.procedureId && isPlaceholderProcedure(existing.procedure)) data.procedureId = picked.id;

  // horario
  if (existing.scheduledAt.getTime() !== b.startsAt.getTime()) {
    data.scheduledAt = b.startsAt;
    // A recepcao trocou o horario la: a confirmacao enviada/dada era do horario ANTIGO. Zera e libera os lembretes pro horario novo (o historico de envios do horario antigo fica no controle).
    data.patientConfirmed = false; data.confirmedAt = null; data.cePresenceState = null; data.cePresenceAt = null;
    await prisma.reminderSent.deleteMany({ where: { appointmentId: existing.id } });
    if (!b.endsAt) data.endsAt = new Date(b.startsAt.getTime() + reservationDurationMin(existing) * 60_000); // mantem a duracao
  }
  if (b.endsAt && (!existing.endsAt || existing.endsAt.getTime() !== b.endsAt.getTime())) data.endsAt = b.endsAt;

  // profissional (so troca para um profissional que a Alice conhece; desconhecido nao apaga o vinculo)
  if (b.professionalUuid) {
    const pro = ctx.proByUuid.get(b.professionalUuid);
    if (pro && pro.id !== existing.professionalId) data.professionalId = pro.id;
    else if (!pro) {
      const k = `${existing.id}:pro:${b.professionalUuid}`;
      if (!divergenceSeen.has(k)) { divergenceSeen.add(k); console.warn(`[clinicaexperts] a reserva ${b.uuid.slice(0, 8)} esta com um profissional do CE que nao tem vinculo aqui; mantido o profissional anterior`); }
    }
  }

  // procedimentos (a reserva inteira)
  if (w.procIds.length) {
    const have = existing.procedures.map((p) => p.ceProcedureId).filter((x): x is number => x != null);
    if (!sameIds(have, w.procIds)) {
      await replaceProcedures(existing.id, b, w.procIds, ctx.procByCeId);
      ctx.result.updated++;
    }
  }

  // pessoa: o CE diz que a reserva e de outro cadastro? So registra; nunca troca a pessoa sozinho.
  const localUuid = existing.attendee ? existing.attendee.ceUuid : existing.patient.ceUuid;
  if (b.patient?.uuid && localUuid && b.patient.uuid !== localUuid) {
    const k = `${existing.id}:pat:${b.patient.uuid}`;
    if (!divergenceSeen.has(k)) {
      divergenceSeen.add(k);
      ctx.result.divergences++;
      activity = { type: "ce_identity_divergence", title: "A reserva está em outro paciente no Clínica Experts", description: `A reserva do dia ${formatDateTimeInZone(existing.scheduledAt, ctx.tz)} aqui é de ${existing.attendee?.name ?? existing.patient.name ?? existing.patient.phone}, mas no Clínica Experts está em ${b.patient.name ?? "outro cadastro"}. Nada foi trocado; confira na recepção.` };
    }
  }

  // estado
  if (meaning == null) {
    if (!unknownStateSeen.has(b.status.raw)) { unknownStateSeen.add(b.status.raw); ctx.result.unknownStates.push(b.status.raw); console.warn(`[clinicaexperts] estado de reserva desconhecido no CE: "${b.status.raw}" (mantido o estado daqui; nao e tratado como confirmado)`); }
  } else if (meaning === "cancelled") {
    if (existing.status !== "cancelled") { data.status = "cancelled"; data.cancelledAt = now; data.cancelSource = "ce_cancelada"; data.ceCancelState = "confirmed"; }
    else if (existing.ceCancelState !== "confirmed") data.ceCancelState = "confirmed"; // o CE agora confirma o cancelamento que fizemos
  } else if (meaning === "completed" || meaning === "no_show") {
    const local = meaning === "no_show" ? "no_show" : "completed";
    if (existing.status !== local) data.status = local;
  } else if (existing.status === "cancelled") {
    // CE ATIVO e aqui cancelado: cancelamento nosso que o CE ainda nao recebeu, ou reativacao da recepcao? Quem decide e a VERSAO (updated_at do CE) em relacao ao nosso cancelamento.
    const ours = existing.cancelSource !== "sistema_desfeito" && (existing.ceCancelState === "pending" || (existing.ceCancelState == null && !(existing.cancelSource ?? "").startsWith("ce_")));
    const ceChangedAfter = !!(b.updatedAt && existing.cancelledAt && b.updatedAt.getTime() > existing.cancelledAt.getTime() + 2 * 60_000);
    if (ours && !ceChangedAfter) {
      if (existing.ceCancelState !== "pending") await prisma.appointment.update({ where: { id: existing.id }, data: { ceCancelState: "pending" } });
      syncAppointmentInBackground(existing.id); // o cancelamento nao chegou la: tenta de novo (nao reativa aqui)
      ctx.result.cancelRetried++;
    } else {
      data.status = "confirmed"; data.cancelledAt = null; data.cancelSource = null; data.ceCancelState = null;
      data.patientConfirmed = false; data.confirmedAt = null; data.cePresenceState = null; data.cePresenceAt = null;
      ctx.result.reactivated++;
      activity = { type: "appointment_reactivated", title: "Reserva reativada no Clínica Experts", description: `A reserva de ${formatDateTimeInZone(b.startsAt, ctx.tz)} estava cancelada aqui e foi reativada no Clínica Experts; voltou para a agenda (a confirmação do paciente foi zerada).` };
    }
  }

  const meta = { ceStatus: b.status.raw, ceUpdatedAt: b.updatedAt ?? existing.ceUpdatedAt, ceSyncedAt: now };
  const substantive = Object.keys(data).length > 0;
  await prisma.appointment.update({ where: { id: existing.id }, data: { ...data, ...meta } });
  if (substantive) {
    ctx.result.updated++;
    scheduleBriefingRefreshForAppointment(existing.id); // mudou la (status/horario/procedimento): a memoria do lead acompanha
  }
  if (activity) await logActivity({ clinicId: ctx.clinicId, patientId: existing.patientId, type: activity.type, area: "agenda", title: activity.title, description: activity.description, actorName: null }).catch(() => undefined);
}

async function pullClinicBookingsNow(clinicId: string): Promise<PullResult> {
  const result: PullResult = { created: 0, updated: 0, skipped: 0, skippedNote: [], skipDetails: [], invalid: 0, incompleteDays: 0, unknownStates: [], divergences: 0, reactivated: 0, cancelRetried: 0 };
  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { timezone: true } });
  const tz = clinic?.timezone || "America/Sao_Paulo";

  const raws: Record<string, unknown>[] = [];
  for (let i = -DAYS_BEHIND; i <= DAYS_AHEAD; i++) {
    const day = new Date(Date.now() + i * 24 * 3_600_000);
    // /bookings so e confiavel com janela de DIA INTEIRO (ver memoria da integracao). Todas as paginas, com conferencia do total.
    const res = await ceListAll<Record<string, unknown>>(clinicId, "/bookings", { starts_at: dayBoundIso(day, tz, "start"), ends_at: dayBoundIso(day, tz, "end") }, { perPage: 1000 });
    if (!res.ok) return { ...result, error: res.error };
    if (!res.complete) result.incompleteDays++;
    raws.push(...res.items);
  }

  const bookings: Work[] = [];
  for (const raw of raws) {
    const parsed = parseBookingResource(raw, tz);
    if (!parsed.ok) { result.invalid++; continue; } // HTTP 200 com uma reserva ilegivel NAO e confirmacao de nada: ignora esta, nao cancela nem cria nada a partir dela
    bookings.push({ b: parsed.booking, raw, procIds: parsed.booking.procedures.map((p) => p.id) });
  }
  if (raws.length && !bookings.length) return { ...result, error: `o Clinica Experts devolveu ${raws.length} reserva(s) em formato nao reconhecido (a importacao nao alterou nada)` };
  if (result.invalid) console.warn(`[clinicaexperts] ${result.invalid} reserva(s) ilegivel(is) ignorada(s) na importacao`);
  if (result.incompleteDays) console.warn(`[clinicaexperts] listagem incompleta em ${result.incompleteDays} dia(s): nada e tratado como "sumiu" por falta na lista`);

  // Carrega TUDO de uma vez (antes eram ~7 consultas ao banco POR reserva, a cada 10 min - com 1
  // nucleo de CPU isso saturava o servidor).
  let procRows = await prisma.procedure.findMany({ where: { clinicId, ceId: { not: null } } });
  const procByCeId = new Map(procRows.map((p) => [p.ceId as number, p]));
  const ceNames = new Map<number, string>(); // nome dos procedimentos do CE (so preenchido quando precisou consultar)
  const proRows = await prisma.professional.findMany({ where: { clinicId, ceUuid: { not: null } }, select: { id: true, ceUuid: true } });
  const proByUuid = new Map(proRows.map((p) => [p.ceUuid as string, p]));
  const uuids = bookings.map((w) => w.b.uuid);
  const existingRows = uuids.length
    ? await prisma.appointment.findMany({ where: { clinicId, ceBookingUuid: { in: uuids } }, include: { procedure: true, patient: true, attendee: true, procedures: true } })
    : [];
  const existingByUuid = new Map(existingRows.map((a) => [a.ceBookingUuid as string, a]));
  const ctx: PullCtx = { clinicId, tz, procByCeId, proByUuid, result };

  // Reservas novas e futuras SEM procedimento na lista: tenta os outros campos e, se preciso, o detalhe da reserva (teto de 20 por rodada).
  const diagnostics: BookingDiagnostic[] = [];
  let detailCalls = 0;
  for (const w of bookings) {
    const { b } = w;
    if (existingByUuid.has(b.uuid)) continue;
    if (b.status.meaning !== "active" && b.status.meaning !== "completed") continue;
    if (b.startsAt.getTime() < Date.now()) continue;
    if (w.procIds.length) continue;
    let ids = extractProcedureIds(w.raw);
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
      w.procIds = ids;
      console.log(`[clinicaexperts] procedimento da reserva ${b.uuid.slice(0, 8)} lido de outro campo/detalhe: ${ids.join(",")}`);
    } else {
      diagnostics.push({ uuid: b.uuid.slice(0, 8), startsAt: b.startsAtRaw, status: b.status.raw, listKeys: Object.keys(w.raw), detailKeys, detailFound: ids, safe: safeScalars(detailObj ?? w.raw) });
    }
  }
  if (diagnostics.length) {
    lastBookingDiagnostics.set(clinicId, { at: new Date(), items: diagnostics.slice(0, 15) });
    console.warn(`[clinicaexperts] ${diagnostics.length} reserva(s) futura(s) sem procedimento mesmo no detalhe; campos da lista: ${diagnostics[0].listKeys.join(",")}; detalhe: ${(diagnostics[0].detailKeys ?? []).join(",")}`);
  }

  // Reservas novas e futuras cujo procedimento ainda nao existe aqui (criado no CE depois do ultimo "Sincronizar catalogo", ou
  // item interno como "Retoque"): cria/vincula so o que falta, em vez de descartar a reserva e deixar a pessoa sem confirmacao.
  const needCe = new Set<number>();
  for (const w of bookings) {
    const { b } = w;
    if (existingByUuid.has(b.uuid)) continue;
    if (b.status.meaning !== "active" && b.status.meaning !== "completed") continue;
    if (b.startsAt.getTime() < Date.now()) continue;
    if (!normalizeCePhone(b.patient?.phone) || pickByIds(w.procIds, procByCeId)) continue;
    for (const id of w.procIds) needCe.add(id);
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
  for (const w of bookings) {
    const { b } = w;
    if (seen.has(b.uuid)) continue;
    seen.add(b.uuid);
    const when = b.startsAt;
    const meaning = b.status.meaning;
    const picked = pickByIds(w.procIds, procByCeId);

    const existing = existingByUuid.get(b.uuid) ?? null;
    if (existing) { await refreshExisting(ctx, existing, w, picked); continue; }

    if (meaning === "cancelled" || meaning === "no_show") { result.skipped++; continue; }
    // Estado que a Alice nao conhece: NAO entra como "confirmado" (nao se sabe o que e). Vai para o aviso da equipe.
    if (meaning == null) {
      result.skipped++;
      if (!unknownStateSeen.has(b.status.raw)) { unknownStateSeen.add(b.status.raw); result.unknownStates.push(b.status.raw); console.warn(`[clinicaexperts] estado de reserva desconhecido no CE: "${b.status.raw}" (reserva ${b.uuid.slice(0, 8)} nao importada)`); }
      result.skipDetails.push({ uuid: b.uuid, startsAt: when.toISOString(), patient: b.patient?.name?.trim() || "(sem nome)", reason: "estado_desconhecido", procedureIds: w.procIds, procedureNames: [b.status.raw] });
      continue;
    }
    // Reserva JA PASSADA que nunca foi importada: nao cria (so serviria pra disparar
    // pos-procedimento/recontato retroativo). Os dias passados da janela existem so
    // pra atualizar o status do que ja estava aqui.
    if (when.getTime() < Date.now()) { result.skipped++; continue; }

    const phone = normalizeCePhone(b.patient?.phone);
    if (!phone && !b.patient?.uuid) {
      // sem telefone e sem cadastro identificavel: nao ha como lembrar
      result.skipped++;
      result.skippedNote.push("sem telefone");
      result.skipDetails.push({ uuid: b.uuid, startsAt: when.toISOString(), patient: b.patient?.name?.trim() || "(sem nome)", reason: "sem_telefone", procedureIds: w.procIds, procedureNames: w.procIds.map((id) => ceNames.get(id) ?? `#${id}`) });
      continue;
    }
    const person = await resolvePerson(ctx, b);
    if (!person) {
      result.skipped++;
      result.skippedNote.push("sem telefone");
      result.skipDetails.push({ uuid: b.uuid, startsAt: when.toISOString(), patient: b.patient?.name?.trim() || "(sem nome)", reason: "sem_telefone", procedureIds: w.procIds, procedureNames: w.procIds.map((id) => ceNames.get(id) ?? `#${id}`) });
      continue;
    }

    // Agendamento da propria Alice cujo vinculo ainda nao tinha sido gravado (corrida com o espelhamento / resultado incerto): liga SO se for inequivocamente o mesmo
    // (pessoa, profissional, procedimentos, inicio e fim). Reserva diferente no mesmo horario (outro profissional/procedimento) e outra reserva: nunca e fundida.
    const tol = 60_000;
    const candidates = await prisma.appointment.findMany({
      where: {
        clinicId, patientId: person.patientId, attendeeId: person.attendeeId, ceBookingUuid: null,
        OR: [{ status: "confirmed" }, { status: "cancelled", cancelSource: "sistema_desfeito" }], // desfeito por falta de resposta do CE: se a reserva existe la, volta a valer
        scheduledAt: { gte: new Date(when.getTime() - tol), lte: new Date(when.getTime() + tol) },
      },
      include: { procedure: true, procedures: true, professional: true, patient: true, attendee: true },
    });
    const locals = candidates.map((a) => ({
      a, id: a.id, status: "confirmed", ceBookingUuid: a.ceBookingUuid, scheduledAt: a.scheduledAt, endsAt: a.endsAt, durationMin: reservationDurationMin(a),
      professionalCeUuid: a.professional?.ceUuid ?? null,
      procedureCeIds: (a.procedures.length ? a.procedures.map((p) => p.ceProcedureId) : [a.procedure.ceId]).filter((x): x is number => x != null),
      personCeUuid: a.attendee ? a.attendee.ceUuid : a.patient.ceUuid, personName: a.attendee?.name ?? a.patient.name, personPhone: a.patient.phone,
    }));
    const match = pickUniqueMatch(locals, b, { allowMissingProcedures: true, allowUnknownProfessional: true });
    if (match.status === "ambiguous") {
      result.skipped++;
      console.warn(`[clinicaexperts] a reserva ${b.uuid.slice(0, 8)} combina com ${match.count} agendamentos daqui; nada foi ligado nem criado (a equipe confere)`);
      continue;
    }
    if (match.status === "one") {
      await adoptBooking(match.item.a.id, b, w.procIds, procByCeId);
      result.updated++;
      continue;
    }

    // Sem procedimento (ou procedimento que nao existe aqui): ENTRA mesmo assim, com o procedimento interno "horario sem procedimento", e a
    // confirmacao sai so com data e horario. Antes a pessoa ficava sem confirmacao nenhuma (pedido da Lisboa, 16/10).
    const procedureForBooking = picked ?? (await ensurePlaceholderProcedure(clinicId));
    const professional = b.professionalUuid ? proByUuid.get(b.professionalUuid) ?? null : null;
    const createdAppt = await prisma.appointment.create({
      data: {
        clinicId, patientId: person.patientId, attendeeId: person.attendeeId, procedureId: procedureForBooking.id, professionalId: professional?.id ?? null,
        scheduledAt: when, endsAt: b.endsAt, status: meaning === "completed" ? "completed" : "confirmed", source: "presencial", ceBookingUuid: b.uuid,
        ceStatus: b.status.raw, ceUpdatedAt: b.updatedAt, ceSyncedAt: new Date(),
      },
    });
    await replaceProcedures(createdAppt.id, b, w.procIds, procByCeId);
    result.created++;
    scheduleBriefingRefreshForAppointment(createdAppt.id);
  }
  lastPullSkips.set(clinicId, { at: new Date(), skips: result.skipDetails });

  // Reservas que a Alice tem como confirmadas mas o CE nao devolveu mais (apagadas ou trocadas la): confere ao vivo e cancela aqui.
  try {
    const todayStart = zonedWallClockToUtc(tz, ...ymd(new Date(), tz), 0, 0);
    const windowEnd = new Date(todayStart.getTime() + (DAYS_AHEAD + 1) * 24 * 3_600_000);
    const rec = await reconcileMissingBookings(clinicId, new Set(bookings.map((w) => w.b.uuid)), { from: new Date(), to: windowEnd }, tz);
    if (rec.cancelled || rec.moved) console.log(`[clinicaexperts] ${rec.cancelled} agendamento(s) cancelado(s) e ${rec.moved} corrigido(s) por terem sumido/mudado no CE`);
  } catch (err) {
    console.error("[clinicaexperts] reconciliacao:", err);
  }
  // Atendimentos registrados no CE DEPOIS da janela de importacao (a recepcao lanca "concluido" dias depois): recuperacao limitada e auditavel.
  try {
    const late = await recoverLateStatuses(clinicId, tz);
    if (late.updated) console.log(`[clinicaexperts] ${late.updated} atendimento(s) com estado final registrado tarde no CE (de ${late.checked} conferido(s))`);
  } catch (err) {
    console.error("[clinicaexperts] recuperacao de estados tardios:", err);
  }
  return result;
}

// Liga uma reserva do CE a um agendamento daqui que ja era a mesma (sem criar nada novo) e fecha a tentativa pendente dele.
export async function adoptBooking(appointmentId: string, b: CeBookingParsed, procIds: number[], byCeId: Map<number, Procedure>): Promise<void> {
  await prisma.appointment.updateMany({ where: { id: appointmentId, status: "cancelled", cancelSource: "sistema_desfeito" }, data: { status: "confirmed", cancelledAt: null, cancelSource: null, ceCancelState: null } });
  await prisma.appointment.update({
    where: { id: appointmentId },
    data: { ceBookingUuid: b.uuid, ceStatus: b.status.raw, ceUpdatedAt: b.updatedAt, ceSyncedAt: new Date(), ...(b.endsAt ? { endsAt: b.endsAt } : {}) },
  });
  await replaceProcedures(appointmentId, b, procIds, byCeId);
  await prisma.ceBookingAttempt.updateMany({
    where: { appointmentId, state: { in: ["pending", "uncertain"] } },
    data: { state: "linked_existing", ceBookingUuid: b.uuid, resolvedAt: new Date(), lastError: null },
  });
}

// PURO: por que a reserva nao entra nas confirmacoes. "?" confundia: lista de procedimentos VAZIA quer dizer que a reserva foi criada no
// Clinica Experts sem procedimento escolhido (com procedimento desconhecido o aviso mostra o numero, "#123").
export function skipReasonText(s: Pick<PullSkip, "reason" | "procedureNames">): string {
  if (s.reason === "sem_telefone") return "sem telefone";
  if (s.reason === "estado_desconhecido") return `estado da reserva desconhecido no Clínica Experts (${s.procedureNames[0] ?? "?"})`;
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
