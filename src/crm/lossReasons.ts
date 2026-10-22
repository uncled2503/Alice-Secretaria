import { prisma } from "../db/client.js";
import { logActivity } from "./activity.js";

// ---------------------------------------------------------------------------
// MOTIVO ESTRUTURADO DE PERDA / CANCELAMENTO / FALTA (checklist mestre, Fase 2/3). Lista FECHADA (sem texto livre como categoria) + nota opcional. Nada e inferido: o motivo so existe quando a
// equipe registra (ou quando a conversa trouxe a frase inequivoca e a equipe confirmou). Sem motivo = "nao informado" nos relatorios (nunca chutado).
// ---------------------------------------------------------------------------
export const LOSS_REASONS = ["preco", "horario", "medo", "pensar", "sem_resposta", "distancia", "sem_interesse", "doenca", "concorrente", "resolveu_sozinha", "outro"] as const;
export type LossReason = (typeof LOSS_REASONS)[number];
export const LOSS_LABEL: Record<LossReason, string> = {
  preco: "Preço", horario: "Horário", medo: "Medo / dor", pensar: "Vai pensar", sem_resposta: "Sem resposta", distancia: "Distância", sem_interesse: "Sem interesse", doenca: "Saúde / impedimento", concorrente: "Foi para outro lugar", resolveu_sozinha: "Resolveu de outro jeito", outro: "Outro",
};
export const validLossReason = (v: unknown): v is LossReason => typeof v === "string" && (LOSS_REASONS as readonly string[]).includes(v);

export async function setLossReason(clinicId: string, patientId: string, code: string | null, note: string | null, actorName: string | null): Promise<{ ok: boolean; message: string }> {
  if (code !== null && !validLossReason(code)) return { ok: false, message: `Motivo inválido. Use um de: ${LOSS_REASONS.join(", ")}.` };
  const upd = await prisma.patient.updateMany({ where: { id: patientId, clinicId }, data: { lossReasonCode: code, lossReasonNote: code ? (note ?? "").slice(0, 300) || null : null, lossReasonAt: code ? new Date() : null } });
  if (upd.count !== 1) return { ok: false, message: "Contato não encontrado nesta clínica." };
  await logActivity({ clinicId, patientId, type: "loss_reason", area: "atendimento", title: code ? `Motivo de perda registrado: ${LOSS_LABEL[code as LossReason]}` : "Motivo de perda removido", description: note ? note.slice(0, 200) : null, actorName });
  return { ok: true, message: code ? "Motivo registrado." : "Motivo removido." };
}

export async function setCancelReason(clinicId: string, appointmentId: string, code: string | null, actorName: string | null): Promise<{ ok: boolean; message: string }> {
  if (code !== null && !validLossReason(code)) return { ok: false, message: `Motivo inválido. Use um de: ${LOSS_REASONS.join(", ")}.` };
  const appt = await prisma.appointment.findFirst({ where: { id: appointmentId, clinicId }, select: { id: true, status: true, patientId: true } });
  if (!appt) return { ok: false, message: "Agendamento não encontrado nesta clínica." };
  if (!["cancelled", "no_show"].includes(appt.status)) return { ok: false, message: "O motivo só se registra em agendamento cancelado ou com falta." };
  await prisma.appointment.update({ where: { id: appt.id }, data: { cancelReasonCode: code } });
  await logActivity({ clinicId, patientId: appt.patientId, type: "cancel_reason", area: "agenda", title: code ? `Motivo do ${appt.status === "no_show" ? "falta" : "cancelamento"}: ${LOSS_LABEL[code as LossReason]}` : "Motivo removido", actorName });
  return { ok: true, message: "Registrado." };
}

export interface ReasonCount { code: string; label: string; n: number }
const tally = (codes: (string | null)[]): ReasonCount[] => {
  const m = new Map<string, number>();
  for (const c of codes) { const k = c && validLossReason(c) ? c : "nao_informado"; m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m.entries()].map(([code, n]) => ({ code, label: code === "nao_informado" ? "Não informado" : LOSS_LABEL[code as LossReason], n })).sort((a, b) => b.n - a.n);
};

// Motivos no periodo (com "nao informado" explicito: o denominador e o total de perdas/cancelamentos, nao so dos que tem motivo).
export async function reasonReport(clinicId: string, from: Date, to: Date) {
  const [lost, cancelled, noShow] = await Promise.all([
    prisma.patient.findMany({ where: { clinicId, lossReasonAt: { gte: from, lt: to } }, select: { lossReasonCode: true } }),
    prisma.appointment.findMany({ where: { clinicId, status: "cancelled", cancelledAt: { gte: from, lt: to } }, select: { cancelReasonCode: true } }),
    prisma.appointment.findMany({ where: { clinicId, status: "no_show", scheduledAt: { gte: from, lt: to } }, select: { cancelReasonCode: true } }),
  ]);
  return {
    perdas: { total: lost.length, porMotivo: tally(lost.map((x) => x.lossReasonCode)) },
    cancelamentos: { total: cancelled.length, porMotivo: tally(cancelled.map((x) => x.cancelReasonCode)) },
    faltas: { total: noShow.length, porMotivo: tally(noShow.map((x) => x.cancelReasonCode)) },
  };
}
