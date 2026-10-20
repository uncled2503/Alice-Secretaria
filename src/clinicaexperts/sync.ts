import type { Prisma } from "@prisma/client";
import { prisma } from "../db/client.js";
import { trackBackground } from "../jobs/background.js";
import { scheduleLocked } from "../jobs/lock.js";
import { notifyStaff } from "../crm/notify.js";
import { logActivity } from "../crm/activity.js";
import { formatDateTimeInZone } from "../scheduling/time.js";
import { reservationDurationMin } from "../scheduling/reservation.js";
import { ceListAll, ceRequest, dayBoundIso, getAccount, isoWithOffset, isUncertain, noteError, type CeResult } from "./client.js";
import { invalidateCeCache } from "./availability.js";
import { birthFieldOf, parseCeBirthDate } from "./birthdays.js";
import { procKey } from "./procKey.js";
import { ceStatusInfo, parseBookingResource, type CeBookingParsed } from "./contract.js";
import { ensureCePatient, lookupCePatient } from "./identity.js";
import { matchReservation, type LocalReservation } from "./match.js";

// ---------------------------------------------------------------------------
// Agendamento da Alice -> Clinica Experts
//
// Principios (revisao integrada 21/10/2026):
//  - o CE e a verdade do calendario: uma reserva so "vale" depois que ele a aceitou, e o que ele devolve e CONFERIDO (HTTP 200 com corpo estranho nao e confirmacao);
//  - NUNCA se recria uma reserva as cegas: antes de cada escrita grava-se uma TENTATIVA (CeBookingAttempt). Resultado incerto (rede, tempo esgotado, 5xx, corpo invalido) fica
//    "aberto" e e reconciliado procurando la uma reserva que combine em TUDO (pessoa, profissional, procedimentos, inicio e fim); sem prova, a equipe confere (unresolved);
//  - remarcar e PUT /bookings/{uuid} (o PATCH /reschedule nao tem corpo documentado: nao permite informar o novo horario) e so apos conferir a reserva atual;
//    reserva com varios procedimentos NAO e remarcada por PUT (o PUT com um so `procedure` apagaria os demais);
//  - cancelar guarda o uuid e o estado do cancelamento (pending ate o CE confirmar), para distinguir "cancelamento nosso ainda nao recebido" de reativacao feita na recepcao;
//  - confirmar presenca e PATCH /bookings/{uuid}/confirm, separado de "paciente confirmou" (a confirmacao do paciente vale mesmo com o CE fora do ar e fica pendente de sincronizar).
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

// Resultado de espelhar um agendamento no Clinica Experts. definitive=false: nao deu pra saber se o CE aplicou (rede/tempo esgotado); nesse caso `uncertain` e a tentativa fica aberta.
export type SyncResult = { ok: true; skipped?: string } | { ok: false; error: string; definitive: boolean; uncertain?: boolean; attemptId?: string };

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

const APPT_INCLUDE = { patient: true, attendee: true, procedure: true, procedures: true, professional: true, clinic: true } as const;
type Loaded = Prisma.AppointmentGetPayload<{ include: typeof APPT_INCLUDE }>;

const nonNull = <T>(x: T | null | undefined): x is T => x != null;
const whoOf = (a: Loaded) => a.attendee?.name ?? a.patient.name ?? a.patient.phone;

// O agendamento daqui, no formato que o comparador estrito entende.
export function localReservationOf(a: Loaded): LocalReservation {
  return {
    id: a.id, status: a.status, ceBookingUuid: a.ceBookingUuid, scheduledAt: a.scheduledAt, endsAt: a.endsAt, durationMin: reservationDurationMin(a),
    professionalCeUuid: a.professional?.ceUuid ?? null,
    procedureCeIds: (a.procedures.length ? a.procedures.map((p) => p.ceProcedureId) : [a.procedure.ceId]).filter(nonNull),
    personCeUuid: a.attendee ? a.attendee.ceUuid : a.patient.ceUuid,
    personName: a.attendee?.name ?? a.patient.name,
    personPhone: a.patient.phone,
  };
}

// Reservas do dia (TODAS as paginas) ja validadas. `complete:false` = a listagem pode estar incompleta: quem chama nao conclui "nao existe".
async function listDayBookings(clinicId: string, at: Date, tz: string): Promise<{ ok: true; items: CeBookingParsed[]; complete: boolean } | { ok: false; error: string }> {
  const res = await ceListAll<Record<string, unknown>>(clinicId, "/bookings", { starts_at: dayBoundIso(at, tz, "start"), ends_at: dayBoundIso(at, tz, "end") }, { perPage: 1000 });
  if (!res.ok) return { ok: false, error: res.error };
  const items: CeBookingParsed[] = [];
  let invalid = 0;
  for (const raw of res.items) {
    const p = parseBookingResource(raw, tz);
    if (p.ok) items.push(p.booking);
    else invalid++;
  }
  return { ok: true, items, complete: res.complete && invalid === 0 };
}

export type FoundBooking =
  | { status: "found"; booking: CeBookingParsed }
  | { status: "none"; complete: boolean }
  | { status: "ambiguous"; count: number }
  | { status: "error"; error: string };

// A reserva JA existe la? (depois de uma escrita incerta). Procura no dia uma reserva que combine em TUDO (comparador estrito) e que nenhum outro agendamento daqui ja use.
// Duas candidatas = ambiguo (nunca escolhe a primeira).
export async function findMatchingBooking(appt: Loaded, tz: string, patientUuid: string | null): Promise<FoundBooking> {
  const day = await listDayBookings(appt.clinicId, appt.scheduledAt, tz);
  if (!day.ok) return { status: "error", error: day.error };
  const local = { ...localReservationOf(appt), ceBookingUuid: null, personCeUuid: patientUuid ?? (appt.attendee ? appt.attendee.ceUuid : appt.patient.ceUuid) };
  const hits = day.items.filter((b) => matchReservation(local, b).match);
  if (hits.length === 0) return { status: "none", complete: day.complete };
  const taken = await prisma.appointment.findMany({ where: { clinicId: appt.clinicId, ceBookingUuid: { in: hits.map((h) => h.uuid) }, id: { not: appt.id } }, select: { ceBookingUuid: true } });
  const takenSet = new Set(taken.map((t) => t.ceBookingUuid));
  const free = hits.filter((h) => !takenSet.has(h.uuid));
  if (free.length === 1) return { status: "found", booking: free[0] };
  return free.length === 0 ? { status: "none", complete: day.complete } : { status: "ambiguous", count: free.length };
}

// ---------- tentativas ----------

const OPEN_STATES = ["pending", "uncertain"];

async function openAttempt(appt: Loaded, kind: "create" | "reschedule" | "cancel" | "confirm", data: { startsAt?: Date; endsAt?: Date; patientUuid?: string | null }): Promise<string> {
  const prior = await prisma.ceBookingAttempt.findFirst({ where: { appointmentId: appt.id, kind, state: { in: OPEN_STATES } }, orderBy: { createdAt: "desc" } });
  if (prior && kind !== "create") {
    await prisma.ceBookingAttempt.update({ where: { id: prior.id }, data: { attempts: { increment: 1 }, state: "pending", startsAt: data.startsAt ?? prior.startsAt, endsAt: data.endsAt ?? prior.endsAt } });
    return prior.id;
  }
  const row = await prisma.ceBookingAttempt.create({
    data: {
      clinicId: appt.clinicId, appointmentId: appt.id, kind, state: "pending",
      startsAt: data.startsAt ?? null, endsAt: data.endsAt ?? null, professionalUuid: appt.professional?.ceUuid ?? null, patientUuid: data.patientUuid ?? null,
      procedureCeIds: JSON.stringify((appt.procedures.length ? appt.procedures.map((p) => p.ceProcedureId) : [appt.procedure.ceId]).filter(nonNull)), ceBookingUuid: appt.ceBookingUuid,
    },
  });
  return row.id;
}
const closeAttempt = (id: string, state: "created" | "failed" | "linked_existing" | "unresolved" | "uncertain", lastError?: string, ceBookingUuid?: string) =>
  prisma.ceBookingAttempt.update({
    where: { id },
    data: { state, lastError: lastError ? lastError.slice(0, 300) : null, ...(ceBookingUuid ? { ceBookingUuid } : {}), ...(state === "uncertain" ? {} : { resolvedAt: new Date() }) },
  }).catch(() => undefined);

// Le a reserva do CE e a valida (corpo vazio/ilegivel/sem campos essenciais NAO e confirmacao).
async function readBooking(clinicId: string, uuid: string, tz: string): Promise<{ ok: true; booking: CeBookingParsed } | { ok: false; gone: boolean; error: string; systemic: boolean }> {
  const res = await ceRequest<unknown>(clinicId, `/bookings/${uuid}`);
  if (!res.ok) return { ok: false, gone: res.kind === "not_found", error: res.error, systemic: res.kind !== "not_found" && res.kind !== "validation" };
  const parsed = parseBookingResource(res.data, tz);
  if (!parsed.ok) return { ok: false, gone: false, error: `resposta do Clinica Experts sem os dados da reserva (${parsed.issues.join("; ")})`, systemic: false };
  if (parsed.booking.uuid !== uuid) return { ok: false, gone: false, error: "o Clinica Experts devolveu outra reserva", systemic: false };
  return { ok: true, booking: parsed.booking };
}

const TOL_MS = 60_000;
const near = (a: Date | null | undefined, b: Date | null | undefined) => !!a && !!b && Math.abs(a.getTime() - b.getTime()) <= TOL_MS;

// O que o CE tem agora e o que o agendamento daqui diz: grava a versao lida (estado bruto, fim, versao).
async function recordSeen(apptId: string, b: CeBookingParsed): Promise<void> {
  await prisma.appointment.update({ where: { id: apptId }, data: { ceStatus: b.status.raw, ceUpdatedAt: b.updatedAt, ceSyncedAt: new Date(), ...(b.endsAt ? { endsAt: b.endsAt } : {}) } }).catch(() => undefined);
}

async function linkBooking(appt: Loaded, b: CeBookingParsed): Promise<void> {
  await prisma.appointment.update({ where: { id: appt.id }, data: { ceBookingUuid: b.uuid, ceStatus: b.status.raw, ceUpdatedAt: b.updatedAt, ceSyncedAt: new Date(), ...(b.endsAt ? { endsAt: b.endsAt } : {}) } });
}

// Espelha um agendamento da Alice (criar, remarcar, cancelar) no Clinica Experts e DEVOLVE o resultado. Quem agenda pela Alice espera
// esse resultado antes de dizer "agendado" ao paciente (opts.quiet: trata a falha na hora, sem o aviso "lance manualmente").
export function syncAppointment(appointmentId: string, opts: { quiet?: boolean } = {}): Promise<SyncResult> {
  return serial(appointmentId, () => syncNow(appointmentId, opts));
}

async function syncNow(appointmentId: string, opts: { quiet?: boolean }): Promise<SyncResult> {
  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId }, include: APPT_INCLUDE });
  if (!appt) return { ok: true, skipped: "agendamento nao encontrado" };
  const account = await getAccount(appt.clinicId);
  if (!account || !account.syncOut) return { ok: true, skipped: "Clinica Experts desligado" };

  const tz = appt.clinic.timezone || "America/Sao_Paulo";
  const label = `${whoOf(appt)} - ${appt.procedure.name} em ${formatDateTimeInZone(appt.scheduledAt, tz)}`;
  const fail = async (text: string, error: string, definitive = true, extra: { uncertain?: boolean; attemptId?: string; alert?: boolean } = {}): Promise<SyncResult> => {
    if (extra.alert !== false) await alertFailure(appt.clinicId, text, opts.quiet === true);
    return { ok: false, error, definitive, ...(extra.uncertain ? { uncertain: true } : {}), ...(extra.attemptId ? { attemptId: extra.attemptId } : {}) };
  };

  if (appt.status === "cancelled") return cancelInCe(appt, tz, label, fail);
  // Atendido/faltou: quem muda isso la e a equipe, no proprio Clinica Experts.
  if (appt.status !== "confirmed") return { ok: true, skipped: "status gerenciado no Clinica Experts" };

  const procs = appt.procedures.length ? appt.procedures.map((p) => ({ ceId: p.ceProcedureId, name: p.name })) : [{ ceId: appt.procedure.ceId, name: appt.procedure.name }];
  const unlinkedProc = procs.find((p) => p.ceId == null);
  if (unlinkedProc || !appt.professional?.ceUuid) {
    const faltando = [unlinkedProc ? `procedimento "${unlinkedProc.name}"` : null, !appt.professional?.ceUuid ? (appt.professional ? `profissional ${appt.professional.name}` : "profissional (nenhum definido)") : null].filter(Boolean).join(" e ");
    return fail(`${label} (sem vínculo com o Clínica Experts: ${faltando}; use "Vincular procedimentos" ou "Sincronizar catálogo")`, `sem vinculo com o Clinica Experts: ${faltando}`);
  }

  // Tentativa anterior de CRIAR com resultado em aberto: reconcilia ANTES de qualquer coisa. Nunca dispara uma segunda criacao as cegas.
  if (!appt.ceBookingUuid) {
    const open = await prisma.ceBookingAttempt.findFirst({ where: { appointmentId: appt.id, kind: "create", state: { in: OPEN_STATES } }, orderBy: { createdAt: "desc" } });
    if (open) {
      const found = await findMatchingBooking(appt, tz, open.patientUuid);
      if (found.status === "found") {
        await linkBooking(appt, found.booking);
        await closeAttempt(open.id, "linked_existing", undefined, found.booking.uuid);
        invalidateCeCache(appt.clinicId);
        return { ok: true };
      }
      const why = found.status === "error" ? `nao consegui consultar o Clinica Experts (${found.error})` : found.status === "ambiguous" ? "mais de uma reserva combina com este agendamento" : "a tentativa anterior ficou sem resposta e a reserva nao foi encontrada";
      return fail(`${label} (${why}; nada foi recriado para nao duplicar)`, why, false, { uncertain: true, attemptId: open.id, alert: false });
    }
  }

  const subject = appt.attendee
    ? ({ kind: "attendee", id: appt.attendee.id, name: appt.attendee.name, phone: appt.patient.phone, ceUuid: appt.attendee.ceUuid } as const)
    : ({ kind: "patient", id: appt.patient.id, name: appt.patient.name, phone: appt.patient.phone, ceUuid: appt.patient.ceUuid } as const);
  const person = await ensureCePatient(appt.clinicId, subject);
  if (!person.ok || !person.uuid) return fail(`${label} (${person.reason ?? "paciente nao localizado no Clinica Experts"})`, person.reason ?? "nao consegui localizar nem criar o paciente no Clinica Experts", !person.uncertain, { uncertain: person.uncertain });
  const patientUuid = person.uuid;

  const startsAt = appt.scheduledAt;
  const endsAt = new Date(startsAt.getTime() + reservationDurationMin(appt) * 60_000);
  const body = {
    starts_at: isoWithOffset(startsAt, tz),
    ends_at: isoWithOffset(endsAt, tz),
    professional: appt.professional.ceUuid,
    patient: patientUuid,
    procedure: String(procs[0].ceId),
  };

  if (appt.ceBookingUuid) return rescheduleInCe(appt, tz, label, body, patientUuid, startsAt, endsAt, fail);

  // CRIAR. A tentativa e gravada ANTES da chamada: se o processo cair no meio, o reconciliador sabe que ficou uma escrita em aberto.
  const attemptId = await openAttempt(appt, "create", { startsAt, endsAt, patientUuid });
  const res = await ceRequest<{ data?: { uuid?: string } }>(appt.clinicId, "/bookings", { method: "POST", body: { ...body, status: "scheduled" } });
  const created = res.ok ? (res.data as { data?: { uuid?: string } } | null)?.data?.uuid : undefined;
  if (res.ok && typeof created === "string" && created) {
    // Conferencia da reserva que acabou de ser criada (a resposta do POST sozinha nao prova o que ficou gravado).
    const seen = await readBooking(appt.clinicId, created, tz);
    if (seen.ok && (seen.booking.status.meaning === "cancelled" || !near(seen.booking.startsAt, startsAt) || (seen.booking.professionalUuid && seen.booking.professionalUuid !== appt.professional.ceUuid))) {
      await prisma.appointment.update({ where: { id: appt.id }, data: { ceBookingUuid: created } });
      await closeAttempt(attemptId, "unresolved", "a reserva criada no CE nao confere com o pedido");
      return fail(`${label} (a reserva criada no Clinica Experts nao confere com o pedido: horario/profissional/estado diferentes)`, "a reserva criada no Clinica Experts nao confere com o pedido", false, { uncertain: true, attemptId });
    }
    if (seen.ok) await linkBooking(appt, seen.booking);
    else await prisma.appointment.update({ where: { id: appt.id }, data: { ceBookingUuid: created, ceSyncedAt: new Date() } });
    await closeAttempt(attemptId, "created", undefined, created);
    invalidateCeCache(appt.clinicId);
    await prisma.clinicaExpertsAccount.updateMany({ where: { clinicId: appt.clinicId }, data: { lastSyncAt: new Date(), lastError: null } });
    return { ok: true };
  }
  // Erro 4xx = o CE recusou de vez (nada foi criado). Rede/tempo esgotado/5xx/corpo invalido (ou resposta sem uuid) = pode ter criado: reconcilia antes de desistir.
  const uncertain = res.ok || isUncertain(res);
  const error = res.ok ? "o Clinica Experts respondeu sem o codigo da reserva" : res.error;
  if (!uncertain) {
    await closeAttempt(attemptId, "failed", error);
    return fail(`${label} (${error})`, error, true, { attemptId });
  }
  await closeAttempt(attemptId, "uncertain", error);
  const found = await findMatchingBooking(appt, tz, patientUuid);
  if (found.status === "found") {
    await linkBooking(appt, found.booking);
    await closeAttempt(attemptId, "linked_existing", undefined, found.booking.uuid);
    invalidateCeCache(appt.clinicId);
    return { ok: true };
  }
  return fail(`${label} (${error})`, error, false, { uncertain: true, attemptId });
}

// ---------- remarcar ----------

async function rescheduleInCe(
  appt: Loaded,
  tz: string,
  label: string,
  body: { starts_at: string; ends_at: string; professional: string | null | undefined; patient: string; procedure: string },
  patientUuid: string,
  startsAt: Date,
  endsAt: Date,
  fail: (text: string, error: string, definitive?: boolean, extra?: { uncertain?: boolean; attemptId?: string; alert?: boolean }) => Promise<SyncResult>,
): Promise<SyncResult> {
  const uuid = appt.ceBookingUuid as string;
  // 1) a reserva atual (nada e escrito antes de conferir). Nao conseguir ler = nada foi alterado.
  const cur = await readBooking(appt.clinicId, uuid, tz);
  if (!cur.ok) {
    if (cur.gone) return fail(`remarcação de ${label} (a reserva não existe mais no Clínica Experts)`, "a reserva nao existe mais no Clinica Experts", true);
    return fail(`remarcação de ${label} (${cur.error})`, cur.error, true, { alert: !cur.systemic });
  }
  const b = cur.booking;
  if (b.status.meaning !== "active") {
    const why = b.status.meaning == null ? `estado desconhecido no Clinica Experts ("${b.status.raw}")` : `a reserva ja esta ${b.status.raw} no Clinica Experts`;
    return fail(`remarcação de ${label} (${why})`, why, true);
  }
  if (b.procedures.length > 1 || appt.procedures.length > 1) {
    const why = "a reserva tem mais de um procedimento: remarque direto no Clinica Experts (a troca por aqui apagaria os demais procedimentos)";
    return fail(`remarcação de ${label} (${why})`, why, true);
  }
  // 2) mesmo horario: nada a fazer (idempotente; nao recria nem reenvia).
  if (near(b.startsAt, startsAt) && (!b.endsAt || near(b.endsAt, endsAt)) && (!b.professionalUuid || b.professionalUuid === body.professional)) {
    await recordSeen(appt.id, b);
    return { ok: true, skipped: "a reserva ja esta neste horario no Clinica Experts" };
  }
  const attemptId = await openAttempt(appt, "reschedule", { startsAt, endsAt, patientUuid });
  const res = await ceRequest(appt.clinicId, `/bookings/${uuid}`, { method: "PUT", body });
  const applied = async (): Promise<SyncResult | null> => {
    const seen = await readBooking(appt.clinicId, uuid, tz);
    if (!seen.ok) return null;
    if (near(seen.booking.startsAt, startsAt) && seen.booking.status.meaning === "active" && (!seen.booking.professionalUuid || seen.booking.professionalUuid === body.professional)) {
      await recordSeen(appt.id, seen.booking);
      return { ok: true };
    }
    return { ok: false, error: "o Clinica Experts nao aplicou a troca", definitive: true };
  };
  if (res.ok) {
    const v = await applied();
    if (v === null || v.ok) { // sem conseguir reler, a resposta do PUT (valida) vale
      await closeAttempt(attemptId, "created");
      invalidateCeCache(appt.clinicId);
      await prisma.clinicaExpertsAccount.updateMany({ where: { clinicId: appt.clinicId }, data: { lastSyncAt: new Date(), lastError: null } });
      return { ok: true };
    }
    await closeAttempt(attemptId, "unresolved", "o CE respondeu ok mas a reserva nao mudou");
    return fail(`remarcação de ${label} (o Clínica Experts respondeu ok mas a reserva não mudou)`, "o Clinica Experts nao aplicou a troca", false, { uncertain: true, attemptId });
  }
  if (isUncertain(res)) {
    const v = await applied();
    if (v?.ok) { await closeAttempt(attemptId, "linked_existing"); invalidateCeCache(appt.clinicId); return { ok: true }; }
    if (v && !v.ok) { await closeAttempt(attemptId, "failed", "a troca nao foi aplicada"); return fail(`remarcação de ${label} (${res.error}; o CE não aplicou a troca)`, res.error, true, { attemptId }); }
    await closeAttempt(attemptId, "uncertain", res.error);
    return fail(`remarcação de ${label} (${res.error})`, res.error, false, { uncertain: true, attemptId });
  }
  await closeAttempt(attemptId, "failed", res.error);
  return fail(`remarcação de ${label} (${res.error})`, res.error, true, { attemptId });
}

// ---------- cancelar ----------

async function cancelInCe(
  appt: Loaded,
  tz: string,
  label: string,
  fail: (text: string, error: string, definitive?: boolean, extra?: { uncertain?: boolean; attemptId?: string; alert?: boolean }) => Promise<SyncResult>,
): Promise<SyncResult> {
  // Cancelado antes de a criacao ter confirmacao: a reserva pode existir la. Procura (comparador estrito); achando, cancela ela.
  let uuid = appt.ceBookingUuid;
  if (!uuid) {
    const open = await prisma.ceBookingAttempt.findFirst({ where: { appointmentId: appt.id, kind: "create", state: { in: OPEN_STATES } }, orderBy: { createdAt: "desc" } });
    if (!open) return { ok: true, skipped: "nunca foi espelhado" };
    const found = await findMatchingBooking({ ...appt, status: "confirmed" }, tz, open.patientUuid);
    if (found.status === "found") { uuid = found.booking.uuid; await closeAttempt(open.id, "linked_existing", undefined, uuid); await prisma.appointment.update({ where: { id: appt.id }, data: { ceBookingUuid: uuid } }); }
    else if (found.status === "none" && found.complete) { await closeAttempt(open.id, "failed", "cancelado antes de existir no CE (nenhuma reserva encontrada)"); return { ok: true, skipped: "nenhuma reserva encontrada no Clinica Experts" }; }
    else return fail(`cancelamento de ${label} (a criação no Clínica Experts ficou sem confirmação e não consegui localizar a reserva; a equipe confere)`, "nao consegui localizar a reserva para cancelar", false, { uncertain: true, attemptId: open.id });
  }
  if (appt.ceCancelState === "confirmed") return { ok: true, skipped: "o cancelamento ja foi confirmado no Clinica Experts" };
  if (appt.ceCancelState !== "pending") await prisma.appointment.update({ where: { id: appt.id }, data: { ceCancelState: "pending" } });
  const attemptId = await openAttempt(appt, "cancel", {});
  const attemptNo = (await prisma.ceBookingAttempt.findUnique({ where: { id: attemptId }, select: { attempts: true } }))?.attempts ?? 1;
  if (attemptNo > MAX_CANCEL_ATTEMPTS) {
    await closeAttempt(attemptId, "unresolved", "limite de tentativas de cancelamento");
    return { ok: false, error: "limite de tentativas de cancelamento no Clinica Experts", definitive: false, uncertain: true, attemptId };
  }
  const res: CeResult<unknown> = await ceRequest(appt.clinicId, `/bookings/${uuid}/cancel`, { method: "PATCH" });
  if (!res.ok && res.kind !== "not_found") {
    await closeAttempt(attemptId, isUncertain(res) ? "uncertain" : "failed", res.error);
    // alerta so na 1a e na 6a tentativa (a importacao repete a cada 10 min enquanto o CE nao recebe)
    return fail(`cancelamento de ${label} (${res.error})`, res.error, res.kind !== "network" && res.kind !== "server" && res.kind !== "invalid_response", { attemptId, uncertain: isUncertain(res), alert: attemptNo === 1 || attemptNo === 6 });
  }
  // sucesso (ou a reserva ja nao existe la): o cancelamento esta confirmado; o uuid FICA (distingue reativacao depois).
  await prisma.appointment.update({ where: { id: appt.id }, data: { ceCancelState: "confirmed", ceStatus: "canceled", ceSyncedAt: new Date() } });
  await closeAttempt(attemptId, "created", res.ok ? undefined : "a reserva ja nao existia no CE", uuid ?? undefined);
  invalidateCeCache(appt.clinicId);
  return { ok: true };
}
const MAX_CANCEL_ATTEMPTS = 12;

// ---------- confirmacao de presenca ----------

export type PresenceResult = { state: "synced" | "pending" | "skipped"; why?: string };

// O paciente confirmou presenca: guarda SEMPRE a confirmacao dele (mesmo com o CE fora do ar) e deixa a sincronizacao com o CE pendente/visivel.
export async function markPatientConfirmed(appointmentIds: string[], now = new Date()): Promise<void> {
  const rows = await prisma.appointment.findMany({ where: { id: { in: appointmentIds }, status: "confirmed" }, select: { id: true, clinicId: true, ceBookingUuid: true } });
  for (const r of rows) {
    const account = await getAccount(r.clinicId);
    const ceOn = !!account && account.syncOut;
    await prisma.appointment.update({ where: { id: r.id }, data: { patientConfirmed: true, confirmedAt: now, cePresenceState: ceOn ? "pending" : null, cePresenceAt: null } });
    if (ceOn) syncPresenceInBackground(r.id);
  }
}

export function syncPresence(appointmentId: string): Promise<PresenceResult> {
  return serial(`presence:${appointmentId}`, async (): Promise<PresenceResult> => {
    const appt = await prisma.appointment.findUnique({ where: { id: appointmentId }, include: { clinic: { select: { timezone: true } } } });
    if (!appt || appt.status !== "confirmed" || !appt.patientConfirmed) return { state: "skipped", why: "sem confirmacao do paciente ou agendamento inativo" };
    if (appt.cePresenceState === "synced") return { state: "synced" };
    const account = await getAccount(appt.clinicId);
    if (!account || !account.syncOut) return { state: "skipped", why: "Clinica Experts desligado" };
    const tz = appt.clinic.timezone || "America/Sao_Paulo";
    const setState = (state: string, extra: Record<string, unknown> = {}) => prisma.appointment.update({ where: { id: appt.id }, data: { cePresenceState: state, ...extra } }).catch(() => undefined);
    if (!appt.ceBookingUuid) { await setState("pending"); return { state: "pending", why: "o agendamento ainda nao esta ligado a uma reserva do Clinica Experts" }; }
    // A reserva ainda existe, esta ativa e no MESMO horario? Senao a confirmacao do paciente nao vale para o que esta la.
    const cur = await readBooking(appt.clinicId, appt.ceBookingUuid, tz);
    if (!cur.ok) { await setState("pending"); return { state: "pending", why: cur.error }; }
    const b = cur.booking;
    if (b.status.meaning !== "active") { await recordSeen(appt.id, b); await setState(b.status.meaning == null ? "pending" : "skipped"); return { state: b.status.meaning == null ? "pending" : "skipped", why: `estado da reserva no CE: ${b.status.raw}` }; }
    if (!near(b.startsAt, appt.scheduledAt)) { await setState("pending"); return { state: "pending", why: "o horario da reserva no Clinica Experts e outro (a importacao corrige)" }; }
    if (/^confirmed$/i.test(b.status.raw)) { await recordSeen(appt.id, b); await setState("synced", { cePresenceAt: new Date() }); return { state: "synced" }; }
    const res = await ceRequest(appt.clinicId, `/bookings/${appt.ceBookingUuid}/confirm`, { method: "PATCH" });
    if (!res.ok) { await setState("pending"); return { state: "pending", why: res.error }; }
    await setState("synced", { cePresenceAt: new Date(), ceStatus: "confirmed", ceSyncedAt: new Date() });
    return { state: "synced" };
  });
}
export function syncPresenceInBackground(appointmentId: string): void {
  void trackBackground(syncPresence(appointmentId)).catch((err) => console.error("[clinicaexperts] syncPresence:", err));
}

// ---------- reconciliador (a cada 5 min) ----------

export const UNRESOLVED_AFTER_MS = 6 * 3_600_000;

// Ja ha uma criacao SEM desfecho (ou nao resolvida) para esta pessoa neste horario? Entao a Alice nao tenta de novo: a reserva pode existir la (a equipe confere).
export async function hasOpenCreateAttempt(clinicId: string, patientId: string, attendeeId: string | null, startsAt: Date, now = new Date()): Promise<boolean> {
  const atts = await prisma.ceBookingAttempt.findMany({
    where: { clinicId, kind: "create", state: { in: [...OPEN_STATES, "unresolved"] }, startsAt, createdAt: { gte: new Date(now.getTime() - 24 * 3_600_000) } },
    select: { appointmentId: true },
  });
  if (!atts.length) return false;
  return (await prisma.appointment.count({ where: { id: { in: atts.map((a) => a.appointmentId) }, patientId, attendeeId } })) > 0;
}

// Um agendamento que a Alice DESFEZ porque o CE nao respondeu (cancelSource "sistema_desfeito") e depois a reserva aparece la: a verdade e o CE. Volta a valer aqui, sem cancelar la.
export const SYSTEM_UNDONE = "sistema_desfeito";

// Reconcilia tentativas em aberto e confirmacoes de presenca pendentes. Nunca recria: so liga a reserva que combina em tudo; sem prova por 6 h vira "unresolved" e a equipe e avisada.
export async function reconcileOpenAttempts(clinicId: string, now = new Date()): Promise<{ linked: number; unresolved: number; presence: number; retried: number }> {
  const out = { linked: 0, unresolved: 0, presence: 0, retried: 0 };
  const account = await getAccount(clinicId);
  if (!account || !account.syncOut) return out;
  const open = await prisma.ceBookingAttempt.findMany({ where: { clinicId, state: { in: OPEN_STATES }, updatedAt: { lt: new Date(now.getTime() - 2 * 60_000) } }, orderBy: { createdAt: "asc" }, take: 20 });
  for (const att of open) {
    const appt = await prisma.appointment.findUnique({ where: { id: att.appointmentId }, include: APPT_INCLUDE });
    if (!appt) { await closeAttempt(att.id, "failed", "agendamento removido"); continue; }
    const tz = appt.clinic.timezone || "America/Sao_Paulo";
    if (att.kind === "create") {
      if (appt.ceBookingUuid) { await closeAttempt(att.id, "linked_existing", undefined, appt.ceBookingUuid); out.linked++; continue; }
      const found = await findMatchingBooking({ ...appt, status: "confirmed" }, tz, att.patientUuid);
      if (found.status === "found") {
        if (appt.status === "cancelled" && appt.cancelSource === SYSTEM_UNDONE) {
          // a Alice desfez por falta de resposta do CE, mas a reserva EXISTE la: volta a valer e a equipe e avisada (o paciente foi avisado de que a equipe confirma).
          await prisma.appointment.update({ where: { id: appt.id }, data: { status: "confirmed", cancelledAt: null, cancelSource: null, ceCancelState: null } });
          await linkBooking({ ...appt, status: "confirmed" }, found.booking);
          await notifyStaff(clinicId, "automation_failed", `A reserva de ${whoOf(appt)} em ${formatDateTimeInZone(appt.scheduledAt, tz)} existe no Clínica Experts (a criação ficou sem confirmação na hora). Ela voltou para a agenda: avise o paciente.`).catch(() => undefined);
        } else if (appt.status === "cancelled") { await prisma.appointment.update({ where: { id: appt.id }, data: { ceBookingUuid: found.booking.uuid, ceCancelState: "pending" } }); syncAppointmentInBackground(appt.id); }
        else await linkBooking(appt, found.booking);
        await closeAttempt(att.id, "linked_existing", undefined, found.booking.uuid);
        out.linked++;
        continue;
      }
    } else if (att.kind === "reschedule" && appt.ceBookingUuid) {
      const cur = await readBooking(appt.clinicId, appt.ceBookingUuid, tz);
      if (cur.ok) {
        const applied = near(cur.booking.startsAt, att.startsAt);
        await closeAttempt(att.id, applied ? "linked_existing" : "failed", applied ? undefined : "a troca nao foi aplicada no CE");
        await recordSeen(appt.id, cur.booking);
        out.linked++;
        continue;
      }
    } else if (att.kind === "cancel") {
      if (appt.ceCancelState === "confirmed") { await closeAttempt(att.id, "created"); continue; }
      syncAppointmentInBackground(appt.id);
      out.retried++;
      continue;
    }
    if (now.getTime() - att.createdAt.getTime() > UNRESOLVED_AFTER_MS) {
      await closeAttempt(att.id, "unresolved", att.lastError ?? "sem prova de que o CE aplicou");
      out.unresolved++;
      await notifyStaff(clinicId, "automation_failed", `⚠️ Não consegui confirmar no Clínica Experts a ${att.kind === "create" ? "criação" : att.kind === "reschedule" ? "remarcação" : "alteração"} do agendamento de ${whoOf(appt)} em ${formatDateTimeInZone(appt.scheduledAt, tz)}. Confira a agenda do Clínica Experts: nada foi recriado automaticamente.`).catch(() => undefined);
    }
  }
  // confirmacoes de presenca que ficaram pendentes (CE fora do ar na hora)
  const pend = await prisma.appointment.findMany({
    where: { clinicId, status: "confirmed", patientConfirmed: true, cePresenceState: "pending", scheduledAt: { gte: new Date(now.getTime() - 3 * 3_600_000) } },
    select: { id: true }, orderBy: { scheduledAt: "asc" }, take: 20,
  });
  for (const p of pend) { const r = await syncPresence(p.id); if (r.state === "synced") out.presence++; }
  return out;
}

let reconcileRunning = false;
export function startCeReconcileJob(): void {
  scheduleLocked("reconciliacao-clinica-experts", "*/5 * * * *", async () => {
    if (reconcileRunning) return;
    reconcileRunning = true;
    try {
      const accounts = await prisma.clinicaExpertsAccount.findMany({ select: { clinicId: true } });
      for (const a of accounts) {
        try { await reconcileOpenAttempts(a.clinicId); } catch (err) { console.error("[clinicaexperts] reconciliacao de tentativas:", err); }
      }
    } finally { reconcileRunning = false; }
  });
}

// Procura o paciente no Clinica Experts pelo telefone e, se achar, guarda o
// vinculo e completa o NOME (so troca quando o nome atual e vazio ou de uma
// palavra so, ex.: apelido do WhatsApp). Melhor esforco: nunca lanca. Cada
// paciente e consultado no maximo 1x por 6h (evita bater na API a cada mensagem).
// Telefone compartilhado: so liga quando UM cadastro bate (ou o nome completo desempata); nunca pelos "ultimos 8 digitos", nunca sobrescreve o uuid de outra pessoa.
const lookedUp = new Map<string, number>();
export async function enrichPatientFromCe(clinicId: string, patient: { id: string; name: string | null; phone: string; ceUuid: string | null }): Promise<void> {
  try {
    const last = lookedUp.get(patient.id);
    if (last && Date.now() - last < 6 * 3_600_000) return;
    if (!(await getAccount(clinicId))) return;
    lookedUp.set(patient.id, Date.now());
    if (!patient.phone.replace(/\D/g, "")) return;
    const found = await lookupCePatient(clinicId, { phone: patient.phone, name: patient.name });
    if (found.status !== "found") return; // nao achou / ambiguo / falhou: nao liga nada
    const match = found.candidate;
    const ceName = match.name?.trim();
    const needsName = !!ceName && (!patient.name || !/\s/.test(patient.name.trim()));
    const claimedByOther = !patient.ceUuid && !!(await prisma.patient.findFirst({ where: { clinicId, ceUuid: match.uuid, id: { not: patient.id } }, select: { id: true } }));
    await prisma.patient.update({
      where: { id: patient.id },
      data: { ...(patient.ceUuid || claimedByOther ? {} : { ceUuid: match.uuid }), ...(needsName && !claimedByOther ? { name: ceName } : {}) },
    });
    // Aniversario (para os disparos de parabens): so preenche se a Alice ainda nao tem a data.
    const birth = parseCeBirthDate(birthFieldOf(match.raw ?? {}).raw);
    if (birth && !claimedByOther) await prisma.patient.updateMany({ where: { id: patient.id, birthDate: null }, data: { birthDate: birth } });
  } catch (err) {
    console.error("[clinicaexperts] enrichPatientFromCe:", err);
  }
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
  const ceByDay = new Map<string, CeBookingParsed[] | null>();
  for (const key of dayKeys) {
    const sample = appts.find((a) => dayBoundIso(a.scheduledAt, tz, "start") === key)!;
    const day = await listDayBookings(clinicId, sample.scheduledAt, tz);
    ceByDay.set(key, day.ok ? day.items : null);
  }

  const items: UnmirroredItem[] = appts.map((a) => {
    const day = ceByDay.get(dayBoundIso(a.scheduledAt, tz, "start"));
    const label = a.patient.name ?? a.patient.phone;
    const alreadyInCe =
      day == null
        ? null
        : day.some(
            (b) =>
              b.status.meaning !== "cancelled" &&
              b.startsAt.getTime() === a.scheduledAt.getTime() &&
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
  const usable = history.filter((b) => !isEndedOrCancelled(b.status) && b.professional?.uuid);

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
  void trackBackground(syncAppointment(appointmentId)).catch((err) => console.error("[clinicaexperts] syncAppointment:", err));
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

// historico de quem executa: cancelada e falta nao contam (estado desconhecido tambem nao conta como execucao)
const isEndedOrCancelled = (status: string): boolean => { const m = ceStatusInfo(status).meaning; return m === "cancelled" || m === "no_show" || m == null; };

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

interface CePro { uuid: string; name: string; first_name?: string; last_name?: string; color?: string; active: boolean }
interface CeProc { id: number; name: string; duration: number; price: number; active: boolean }
interface CeBooking { status: string; professional: { uuid: string } | null; procedures: { id: number }[] }

// Lista INCOMPLETA (passou do teto de paginas ou o total nao fechou) = falha: o catalogo/historico nao pode se basear em meia lista.
async function fetchAll<T>(clinicId: string, path: string, query: Record<string, string | number>): Promise<T[] | null> {
  const res = await ceListAll<T>(clinicId, path, query, { perPage: 1000, maxPages: 30 });
  return res.ok && res.complete ? res.items : null;
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
  const usable = (history ?? []).filter((b) => !isEndedOrCancelled(b.status));
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
