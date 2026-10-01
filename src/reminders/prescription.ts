import cron from "node-cron";
import { prisma } from "../db/client.js";
import { sendText } from "../uazapi/client.js";
import { renderMessageTemplate, getClinicTemplateInfo } from "../crm/template.js";
import { PAID_CLINIC_WHERE } from "../crm/plan.js";
import { notifyStaff } from "../crm/notify.js";
import { recordAutomatedMessage } from "../crm/conversationLog.js";

const MAX_PER_TICK = 30; // teto de seguranca por clinica a cada execucao (15min)

// "Hoje" (meia-noite UTC) na timezone da clinica - mesmo padrao usado pra
// gravar a data do lembrete (so o dia importa, ver schema.prisma).
function todayUtcMidnight(timeZone: string): Date {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date());
  return new Date(`${parts}T00:00:00Z`);
}

// Roda a cada 15min. Lembretes de renovacao de receita (data + mensagem
// escolhidas pela equipe por paciente, ate 2 por vez) disparam uma unica
// vez quando a data chega, respeitando o opt-out (LGPD).
export function startPrescriptionReminderJob(): void {
  cron.schedule("*/15 * * * *", async () => {
    const clinics = await prisma.clinic.findMany({ where: PAID_CLINIC_WHERE, select: { id: true, timezone: true } });

    for (const clinic of clinics) {
      const cutoff = todayUtcMidnight(clinic.timezone || "America/Sao_Paulo");

      const due = await prisma.prescriptionReminder.findMany({
        where: { sentAt: null, date: { lte: cutoff }, patient: { clinicId: clinic.id, optedOut: false } },
        include: { patient: true },
        take: MAX_PER_TICK,
      });
      if (due.length === 0) continue;

      const clinicInfo = await getClinicTemplateInfo(clinic.id);

      for (const reminder of due) {
        const text = renderMessageTemplate(reminder.message, {
          patientName: reminder.patient.name,
          patientPhone: reminder.patient.phone,
          clinicName: clinicInfo.name,
          locationName: clinicInfo.primaryLocation?.name,
          locationAddress: clinicInfo.primaryLocation?.fullAddress,
        });

        try {
          await sendText(clinic.id, reminder.patient.phone, text);
          await prisma.prescriptionReminder.update({ where: { id: reminder.id }, data: { sentAt: new Date() } });
          await recordAutomatedMessage(reminder.patientId, text, "Renovação de receita");
        } catch (err) {
          console.error(`Falha ao enviar lembrete de receita (${reminder.id}) para ${reminder.patient.phone}:`, err);
          await notifyStaff(
            clinic.id,
            "automation_failed",
            `⚠️ Falha ao enviar o lembrete de renovação de receita para ${reminder.patient.name ?? reminder.patient.phone} (${reminder.patient.phone}). O sistema vai tentar novamente.`
          );
        }
      }
    }
  });
}
