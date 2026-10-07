import cron from "node-cron";
import { prisma } from "../db/client.js";
import { sendText } from "../uazapi/client.js";
import { renderMessageTemplate, getClinicTemplateInfo } from "../crm/template.js";
import { PAID_CLINIC_WHERE } from "../crm/plan.js";
import { recordAutomatedMessage } from "../crm/conversationLog.js";

const EARLIEST_SEND_HOUR = 7; // nunca manda lembrete antes das 7h (hora local da clinica)
const SEND_TOLERANCE_MS = 40 * 60_000; // janela de disparo apos o horario previsto (cron roda a cada 15min)

// PURO: quando o lembrete deve sair. Normalmente "hoursBefore" antes da
// consulta; se isso cair antes das 7h locais (ex.: consulta as 8h com regra de
// 3h), sai as 7h em ponto em vez de acordar o paciente de madrugada.
export function reminderSendTime(scheduledAt: Date, hoursBefore: number, timeZone: string): Date {
  const ideal = new Date(scheduledAt.getTime() - hoursBefore * 3_600_000);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(ideal);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 12);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  if (h >= EARLIEST_SEND_HOUR) return ideal;
  return new Date(ideal.getTime() + ((EARLIEST_SEND_HOUR - h) * 60 - m) * 60_000);
}

// Roda a cada 15min. Cada regra ativa dispara uma vez por agendamento (marca
// em ReminderSent) - assim da pra ter mais de uma regra (ex: 24h antes e 2h
// antes) sem mandar a mesma coisa duas vezes nem perder uma por causa da outra.
export function startReminderJob(): void {
  cron.schedule("*/15 * * * *", async () => {
    const rules = await prisma.reminderRule.findMany({ where: { active: true, clinic: PAID_CLINIC_WHERE } });
    const clinicInfoCache = new Map<string, Awaited<ReturnType<typeof getClinicTemplateInfo>>>();

    for (const rule of rules) {
      const now = new Date();
      const target = new Date(now.getTime() + rule.hoursBefore * 60 * 60_000);
      // Janela estreita (um pouco maior que o intervalo do cron, pra nao
      // perder por atraso) em vez de "do agora ate o alvo": sem isso, um
      // agendamento marcado em cima da hora (ex: pra daqui a 2h) cai dentro
      // da janela de TODAS as regras com hoursBefore maior (24h, 12h...) na
      // primeira checagem, e a Alice manda "amanha" pra uma consulta que e
      // hoje mesmo. Com a janela estreita, cada regra so dispara perto do
      // horario que ela realmente promete.
      // O horario previsto pode ser adiado pra 7h (ver reminderSendTime), entao
      // a busca olha de "agora" ate o alvo e o filtro fino fica no codigo.
      const clinicRow = await prisma.clinic.findUnique({ where: { id: rule.clinicId }, select: { timezone: true } });
      const tz = clinicRow?.timezone || "America/Sao_Paulo";

      const candidates = await prisma.appointment.findMany({
        where: {
          clinicId: rule.clinicId,
          status: "confirmed",
          scheduledAt: { gt: now, lte: new Date(target.getTime() + 8 * 3_600_000) },
          reminders: { none: { ruleId: rule.id } },
        },
        include: { patient: true, procedure: true, professional: true },
      });
      const due = candidates.filter((appt) => {
        const late = now.getTime() - reminderSendTime(appt.scheduledAt, rule.hoursBefore, tz).getTime();
        // Dentro da janela estreita apos o horario previsto E ainda antes da consulta.
        return late >= 0 && late <= SEND_TOLERANCE_MS;
      });

      if (due.length === 0) continue;

      if (!clinicInfoCache.has(rule.clinicId)) {
        clinicInfoCache.set(rule.clinicId, await getClinicTemplateInfo(rule.clinicId));
      }
      const clinicInfo = clinicInfoCache.get(rule.clinicId)!;

      for (const appt of due) {
        const text = renderMessageTemplate(rule.message, {
          patientName: appt.patient.name,
          patientPhone: appt.patient.phone,
          clinicName: clinicInfo.name,
          locationName: clinicInfo.primaryLocation?.name,
          locationAddress: clinicInfo.primaryLocation?.fullAddress,
          procedureName: appt.procedure.name,
          professionalName: appt.professional?.name,
          when: appt.scheduledAt,
        });

        try {
          await sendText(appt.clinicId, appt.patient.phone, text);
          await prisma.reminderSent.create({ data: { appointmentId: appt.id, ruleId: rule.id } });
          await recordAutomatedMessage(appt.patientId, text, "Lembrete de consulta");
        } catch (err) {
          console.error(`Falha ao enviar lembrete (regra ${rule.id}) para ${appt.patient.phone}:`, err);
        }
      }
    }
  });
}
