import { prisma } from "../db/client.js";

// Sinais de agenda (fase 2 da Lisboa): paciente com faltas repetidas ou que remarca muito. Vai como observacao no aviso
// interno de novo agendamento / remarcacao, pra a equipe aplicar a politica de confirmacao/sinal da clinica ANTES de
// segurar um horario disputado.
export const NO_SHOW_ALERT_AT = 2;
export const RESCHEDULE_ALERT_AT = 3;
const RESCHEDULE_LOOKBACK_MS = 90 * 24 * 3_600_000;

export function riskNoteText(noShows: number, reschedules: number): string {
  const parts: string[] = [];
  if (noShows >= NO_SHOW_ALERT_AT) parts.push(`${noShows} falta(s) anterior(es)`);
  if (reschedules >= RESCHEDULE_ALERT_AT) parts.push(`${reschedules} remarcações nos últimos 90 dias`);
  return parts.length ? `\n⚠️ Atenção: ${parts.join(" · ")}. Vale aplicar a política de confirmação/sinal da clínica.` : "";
}

export async function bookingRiskNote(patientId: string): Promise<string> {
  try {
    const [noShows, reschedules] = await Promise.all([
      prisma.appointment.count({ where: { patientId, status: "no_show" } }),
      prisma.activityLog.count({ where: { patientId, type: "appointment_rescheduled", createdAt: { gte: new Date(Date.now() - RESCHEDULE_LOOKBACK_MS) } } }),
    ]);
    return riskNoteText(noShows, reschedules);
  } catch {
    return ""; // so um aviso a mais: nunca atrapalha o agendamento
  }
}
