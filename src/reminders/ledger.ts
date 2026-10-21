import { prisma } from "../db/client.js";
import { reminderKindOf } from "./policy.js";
import { isoDateInZone } from "../scheduling/time.js";

// ---------------------------------------------------------------------------
// CONTROLE PERSISTENTE DOS LEMBRETES (ReminderDispatch). Uma linha por (reserva, regra, horario do agendamento), adquirida de forma ATOMICA
// (indice unico do banco) antes de qualquer envio. Cobre: duas regras iguais, duas rodadas do cron, duas copias do servidor, reinicio no meio
// do envio e copias do MESMO agendamento (a chave e o uuid da reserva no Clinica Experts; sem CE, o id local).
//
// Ciclo:  (nada) -> reserved -> sent | unconfirmed | blocked | vetoed | duplicate | failed_permanent
//                      \-> failed (falha definitiva do envio, nada saiu: pode tentar de novo, com teto e intervalo)
//         (nada) -> deferred (a conferencia no CE foi inconclusiva: nada enviado, nada consumido; tenta de novo, com teto e intervalo) -> exhausted
// "reserved" que ficou sem desfecho (processo caiu no meio) vira "unconfirmed": pode ter saido, entao NUNCA reenvia as cegas.
// Garantia: no maximo UM lembrete de cada tipo por reserva+horario por dia de envio, e UM por regra por reserva+horario. A UAZAPI nao oferece
// idempotencia nem consulta de status, entao um envio que deu timeout fica "unconfirmed" (sem entrega confirmada e sem reenvio automatico).
// ---------------------------------------------------------------------------

export type DispatchState = "deferred" | "reserved" | "sent" | "unconfirmed" | "blocked" | "vetoed" | "duplicate" | "failed" | "failed_permanent" | "exhausted";

export const MAX_DEFERRALS = 16; // tentativas de conferir o CE antes de desistir deste lembrete (cobre ~4 h de janela com rodadas de 15 min; a janela de envio e o limite de verdade)
export const DEFER_GAP_MS = 10 * 60_000;
export const MAX_SEND_ATTEMPTS = 3; // tentativas de envio depois de falha definitiva
export const FAILED_GAP_MS = 5 * 60_000;
export const STALE_RESERVED_MS = 30 * 60_000;

export interface DispatchKey {
  clinicId: string;
  bookingKey: string;
  appointmentId: string | null;
  patientId: string;
  ruleId: string;
  kind: string;
  startsAt: Date;
  sendDay: string;
}

// PURO: identidade da reserva. Com CE, o uuid dele (as copias locais da mesma reserva dividem o controle); sem CE, o id local.
export function bookingKeyOf(appt: { id: string; ceBookingUuid: string | null }): string {
  return appt.ceBookingUuid ? `ce:${appt.ceBookingUuid}` : `appt:${appt.id}`;
}

// PURO: tipo do lembrete. Cobranca (regra-filha) e um pedido diferente do primeiro; os demais sao classificados pelo texto ("amanha"/"hoje").
// Sem classificacao, o tipo e proprio da regra (duas regras diferentes e nao classificaveis nao se bloqueiam).
export function dispatchKind(rule: { id: string; parentRuleId: string | null; message: string; purpose?: string | null; dayOffset?: number | null }): string {
  return reminderKindOf(rule);
}

export function sendDayOf(now: Date, timeZone: string): string {
  return isoDateInZone(now, timeZone);
}

export type Acquire =
  | { ok: true; id: string; attempt: number }
  | { ok: false; why: "already_handled" | "in_progress" | "same_kind_today" | "exhausted" | "too_soon"; state?: string };

const isUnique = (e: unknown) => (e as { code?: string } | null)?.code === "P2002";

// Reserva de forma atomica. Nao envia nada. Falha com o motivo quando outra rodada/regra ja cuidou disto.
export async function acquireDispatch(key: DispatchKey, now = new Date()): Promise<Acquire> {
  try {
    const row = await prisma.reminderDispatch.create({ data: { ...key, state: "reserved", attempt: 1 } });
    return { ok: true, id: row.id, attempt: 1 };
  } catch (e) {
    if (!isUnique(e)) throw e;
  }
  // Ja existe linha para esta reserva+horario: a da mesma regra, ou a de outra regra do mesmo tipo no mesmo dia.
  const same = await prisma.reminderDispatch.findFirst({ where: { bookingKey: key.bookingKey, ruleId: key.ruleId, startsAt: key.startsAt } });
  const sameKind = same ? null : await prisma.reminderDispatch.findFirst({ where: { bookingKey: key.bookingKey, kind: key.kind, startsAt: key.startsAt, sendDay: key.sendDay } });
  if (!same) return { ok: false, why: sameKind ? "same_kind_today" : "in_progress", state: sameKind?.state };

  if (same.state === "reserved") {
    // Quem reservou pode estar enviando agora. Se ficou muito tempo assim, o processo caiu: desfecho desconhecido, nunca reenvia.
    if (now.getTime() - same.updatedAt.getTime() > STALE_RESERVED_MS) {
      await prisma.reminderDispatch.updateMany({ where: { id: same.id, state: "reserved" }, data: { state: "unconfirmed", detail: "reserva sem desfecho (processo caiu no envio): pode ter saido, nao reenviado" } });
      return { ok: false, why: "already_handled", state: "unconfirmed" };
    }
    return { ok: false, why: "in_progress", state: "reserved" };
  }
  if (same.state === "deferred" || same.state === "failed") {
    const gap = same.state === "deferred" ? DEFER_GAP_MS : FAILED_GAP_MS;
    const max = same.state === "deferred" ? MAX_DEFERRALS : MAX_SEND_ATTEMPTS;
    if (same.attempt >= max) return { ok: false, why: "exhausted", state: same.state };
    if (now.getTime() - same.updatedAt.getTime() < gap) return { ok: false, why: "too_soon", state: same.state };
    // So uma rodada vence a disputa: a que troca deferred/failed -> reserved.
    const claimed = await prisma.reminderDispatch.updateMany({
      where: { id: same.id, state: same.state, updatedAt: same.updatedAt },
      data: { state: "reserved", attempt: { increment: 1 }, sendDay: key.sendDay },
    });
    return claimed.count === 1 ? { ok: true, id: same.id, attempt: same.attempt + 1 } : { ok: false, why: "in_progress", state: same.state };
  }
  return { ok: false, why: same.state === "exhausted" ? "exhausted" : "already_handled", state: same.state };
}

const HANDLED = ["reserved", "sent", "unconfirmed", "duplicate", "blocked", "vetoed", "failed_permanent", "exhausted"];

// Consulta barata ANTES de gastar uma chamada ao CE: ja foi enviado / esta em andamento / foi tentado ha pouco / outra regra do mesmo tipo ja enviou hoje?
// Devolve o motivo de pular, ou null (pode seguir; a reserva atomica ainda decide de verdade).
export async function precheckDispatch(key: DispatchKey, now = new Date()): Promise<string | null> {
  const same = await prisma.reminderDispatch.findFirst({ where: { bookingKey: key.bookingKey, ruleId: key.ruleId, startsAt: key.startsAt } });
  if (same) {
    if (HANDLED.includes(same.state)) return `controle de envio: ja tratado (${same.state})`;
    const gap = same.state === "deferred" ? DEFER_GAP_MS : FAILED_GAP_MS;
    const max = same.state === "deferred" ? MAX_DEFERRALS : MAX_SEND_ATTEMPTS;
    if (same.attempt >= max) return `controle de envio: tentativas esgotadas (${same.state})`;
    if (now.getTime() - same.updatedAt.getTime() < gap) return `controle de envio: aguardando o intervalo entre tentativas (${same.state}, tentativa ${same.attempt})`;
    return null;
  }
  const other = await prisma.reminderDispatch.findFirst({
    where: { bookingKey: key.bookingKey, kind: key.kind, startsAt: key.startsAt, sendDay: key.sendDay, ruleId: { not: key.ruleId }, state: { in: ["reserved", "sent", "unconfirmed", "duplicate", "blocked", "vetoed"] } },
    select: { state: true },
  });
  return other ? `controle de envio: outra regra do mesmo tipo (${key.kind}) ja tratou esta reserva hoje (${other.state})` : null;
}

export async function finishDispatch(id: string, state: DispatchState, detail?: string): Promise<void> {
  await prisma.reminderDispatch.update({ where: { id }, data: { state, ...(detail !== undefined ? { detail: detail.slice(0, 300) } : {}) } }).catch((err) => {
    console.error(`[lembrete] nao consegui gravar o estado "${state}" do controle ${id}:`, err instanceof Error ? err.message : err);
  });
}

// A conferencia no CE foi inconclusiva: registra o adiamento (sem consumir o lembrete). Passou do teto, desiste deste lembrete.
export async function recordDeferral(key: DispatchKey, reason: string, now = new Date()): Promise<{ attempt: number; exhausted: boolean; counted: boolean }> {
  try {
    await prisma.reminderDispatch.create({ data: { ...key, state: "deferred", attempt: 1, detail: reason.slice(0, 300) } });
    return { attempt: 1, exhausted: false, counted: true };
  } catch (e) {
    if (!isUnique(e)) throw e;
  }
  const row = await prisma.reminderDispatch.findFirst({ where: { bookingKey: key.bookingKey, ruleId: key.ruleId, startsAt: key.startsAt } });
  if (!row || row.state !== "deferred") return { attempt: row?.attempt ?? 0, exhausted: false, counted: false };
  const attempt = row.attempt + 1;
  const exhausted = attempt >= MAX_DEFERRALS;
  const claimed = await prisma.reminderDispatch.updateMany({
    where: { id: row.id, state: "deferred", updatedAt: row.updatedAt },
    data: { attempt, state: exhausted ? "exhausted" : "deferred", detail: reason.slice(0, 300) },
  });
  void now;
  return { attempt, exhausted: exhausted && claimed.count === 1, counted: claimed.count === 1 };
}

// Trilha de uma reserva (diagnostico): tudo o que o sistema decidiu e enviou para ela, do mais novo para o mais antigo.
export async function dispatchTrail(clinicId: string, filter: { appointmentId?: string; bookingKey?: string }) {
  let keys: string[] = [];
  if (filter.bookingKey) keys = [filter.bookingKey];
  if (filter.appointmentId) {
    const a = await prisma.appointment.findFirst({ where: { id: filter.appointmentId, clinicId }, select: { id: true, ceBookingUuid: true } });
    if (a) keys.push(bookingKeyOf(a));
  }
  if (!keys.length) return [];
  return prisma.reminderDispatch.findMany({
    where: { clinicId, bookingKey: { in: keys } },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, bookingKey: true, ruleId: true, kind: true, startsAt: true, sendDay: true, state: true, attempt: true, detail: true, createdAt: true, updatedAt: true },
  });
}
