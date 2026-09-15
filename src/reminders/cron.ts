import cron from "node-cron";
import { prisma } from "../db/client.js";
import { sendText } from "../uazapi/client.js";
import { renderMessageTemplate, getClinicTemplateInfo } from "../crm/template.js";
import { PAID_CLINIC_WHERE } from "../crm/plan.js";

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
      const windowStart = new Date(target.getTime() - 20 * 60_000);

      const due = await prisma.appointment.findMany({
        where: {
          clinicId: rule.clinicId,
          status: "confirmed",
          scheduledAt: { gte: windowStart, lte: target },
          reminders: { none: { ruleId: rule.id } },
        },
        include: { patient: true, procedure: true, professional: true },
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
        } catch (err) {
          console.error(`Falha ao enviar lembrete (regra ${rule.id}) para ${appt.patient.phone}:`, err);
        }
      }
    }
  });
}
