import cron from "node-cron";
import { prisma } from "../db/client.js";
import { sendText } from "../uazapi/client.js";
import { renderMessageTemplate, getClinicTemplateInfo } from "../crm/template.js";

function intervalMs(value: number, unit: string): number {
  const hourMs = 60 * 60_000;
  return unit === "hours" ? value * hourMs : value * 24 * hourMs;
}

// Roda a cada 15min. So dispara uma vez por agendamento por regra (marca em
// PostProcedureSent), respeitando "so apos concluido" e o filtro de
// procedimentos (procedureIds vazio = vale pra todos).
export function startPostProcedureJob(): void {
  cron.schedule("*/15 * * * *", async () => {
    const rules = await prisma.postProcedureRule.findMany({ where: { active: true } });
    const clinicInfoCache = new Map<string, Awaited<ReturnType<typeof getClinicTemplateInfo>>>();

    for (const rule of rules) {
      const now = new Date();
      const cutoff = new Date(now.getTime() - intervalMs(rule.intervalValue, rule.intervalUnit));
      const procedureFilter = rule.procedureIds.split(",").filter(Boolean);

      const due = await prisma.appointment.findMany({
        where: {
          clinicId: rule.clinicId,
          ...(rule.onlyIfCompleted ? { status: "completed" } : { status: { not: "cancelled" } }),
          scheduledAt: { lte: cutoff },
          ...(procedureFilter.length ? { procedureId: { in: procedureFilter } } : {}),
          postProcedureSent: { none: { ruleId: rule.id } },
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
          await prisma.postProcedureSent.create({ data: { appointmentId: appt.id, ruleId: rule.id } });
        } catch (err) {
          console.error(`Falha ao enviar pos-procedimento (regra ${rule.id}) para ${appt.patient.phone}:`, err);
        }
      }
    }
  });
}
