import { prisma } from "../db/client.js";
import { bookingKeyOf } from "./ledger.js";

// ---------------------------------------------------------------------------
// ESTADO DA RESPOSTA A CONFIRMACAO de UMA reserva, no horario ATUAL (versao). Separa o que antes se misturava:
//   confirmou | pediu_remarcacao | cancelou (pela propria pessoa) | cancelada (por outro caminho: equipe, CE, sistema) | nao_respondeu (pedido aceito pelo provedor, sem resposta)
//   | pedido_incerto (pode ter saido: sem reenvio automatico) | pedido_nao_enviado (falhou/barrado/bloqueado) | sem_pedido (nada tentado ainda para este horario).
// "Nao respondeu" NUNCA e cancelamento. Derivado (sem nova fonte de verdade): Appointment + o controle persistente dos envios (ReminderDispatch) deste horario.
// ---------------------------------------------------------------------------
export type ConfirmationReply = "confirmou" | "pediu_remarcacao" | "cancelou" | "cancelada" | "nao_respondeu" | "pedido_incerto" | "pedido_nao_enviado" | "sem_pedido";

export interface ConfirmationState {
  estado: ConfirmationReply;
  desde: string | null;
  pedido: { regra: string; tipo: string; estado: string; tentadoEm: string | null } | null;
  detalhe: string;
}

const ASKS = ["dia_seguinte", "cobranca"];
const isAsk = (kind: string) => ASKS.includes(kind) || kind.startsWith("confirmacao_");

// PURO: decide o estado a partir do agendamento e das linhas de controle do horario ATUAL.
export function confirmationStateOf(
  appt: { status: string; cancelSource: string | null; cancelledAt: Date | null; patientConfirmed: boolean; confirmedAt: Date | null; rescheduleRequestedAt: Date | null; scheduledAt: Date },
  rows: { ruleId: string; kind: string; state: string; attemptedAt: Date | null; updatedAt: Date; startsAt: Date }[],
): ConfirmationState {
  const asks = rows.filter((r) => r.startsAt.getTime() === appt.scheduledAt.getTime() && isAsk(r.kind)).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  const last = asks.find((r) => r.state === "sent") ?? asks.find((r) => r.state === "unconfirmed") ?? asks[0] ?? null;
  const pedido = last ? { regra: last.ruleId, tipo: last.kind, estado: last.state, tentadoEm: last.attemptedAt?.toISOString() ?? null } : null;
  if (appt.status === "cancelled") {
    const own = appt.cancelSource === "paciente_whatsapp";
    return { estado: own ? "cancelou" : "cancelada", desde: appt.cancelledAt?.toISOString() ?? null, pedido, detalhe: own ? "a própria pessoa cancelou" : `cancelada por outro caminho (${appt.cancelSource ?? "origem não registrada"})` };
  }
  if (appt.rescheduleRequestedAt) return { estado: "pediu_remarcacao", desde: appt.rescheduleRequestedAt.toISOString(), pedido, detalhe: "pediu para remarcar; a troca ainda não foi feita (mensagens deste horário suspensas)" };
  if (appt.patientConfirmed) return { estado: "confirmou", desde: appt.confirmedAt?.toISOString() ?? null, pedido, detalhe: "presença confirmada para este horário" };
  if (!last) return { estado: "sem_pedido", desde: null, pedido, detalhe: "nenhum pedido de confirmação foi tentado para este horário" };
  if (last.state === "sent") return { estado: "nao_respondeu", desde: last.attemptedAt?.toISOString() ?? null, pedido, detalhe: "pedido aceito pelo provedor; sem confirmação até agora (não é cancelamento)" };
  if (last.state === "unconfirmed" || last.state === "reserved") return { estado: "pedido_incerto", desde: last.attemptedAt?.toISOString() ?? null, pedido, detalhe: "o pedido pode ter saído, sem confirmação do provedor: não é reenviado automaticamente" };
  return { estado: "pedido_nao_enviado", desde: last.attemptedAt?.toISOString() ?? null, pedido, detalhe: `o pedido não saiu (${last.state})` };
}

export async function confirmationStateFor(clinicId: string, appointmentId: string): Promise<ConfirmationState | null> {
  const appt = await prisma.appointment.findFirst({ where: { id: appointmentId, clinicId }, select: { id: true, ceBookingUuid: true, status: true, cancelSource: true, cancelledAt: true, patientConfirmed: true, confirmedAt: true, rescheduleRequestedAt: true, scheduledAt: true } });
  if (!appt) return null;
  const rows = await prisma.reminderDispatch.findMany({ where: { clinicId, bookingKey: bookingKeyOf(appt) }, select: { ruleId: true, kind: true, state: true, attemptedAt: true, updatedAt: true, startsAt: true } });
  return confirmationStateOf(appt, rows);
}

// A pessoa pediu para remarcar UM horario identificado (sem ambiguidade). Idempotente; nao mexe no horario.
export async function markRescheduleRequested(appointmentId: string, now = new Date()): Promise<boolean> {
  const r = await prisma.appointment.updateMany({ where: { id: appointmentId, status: "confirmed", rescheduleRequestedAt: null, scheduledAt: { gt: now } }, data: { rescheduleRequestedAt: now } });
  return r.count === 1;
}
