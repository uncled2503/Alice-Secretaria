import cron from "node-cron";
import { prisma } from "../db/client.js";
import { sendText } from "../uazapi/client.js";
import { renderMessageTemplate, getClinicTemplateInfo } from "../crm/template.js";
import { PAID_CLINIC_WHERE } from "../crm/plan.js";

const DAY_MS = 24 * 60 * 60_000;
const MAX_DAYS = 2 * 365; // limite de 2 anos

// So entende months/years (RenewalRule.intervalUnit - PostProcedureRule tem
// hours/days, e um campo diferente). Unidade fora disso e um dado corrompido
// (ex: escrito direto no banco por um seed, ignorando a API): melhor pular a
// regra com um aviso do que tratar "days" como "months" e mandar a mensagem
// 30x mais tarde do que configurado, em silencio.
function intervalDays(value: number, unit: string): number | null {
  if (unit !== "months" && unit !== "years") return null;
  const days = unit === "years" ? value * 365 : value * 30;
  return Math.min(days, MAX_DAYS);
}

// Roda de 6 em 6h. Dispara uma vez por agendamento por regra (RenewalSent),
// X meses/anos apos o fim do atendimento, respeitando "so apos concluido" e o
// filtro de procedimentos (procedureIds vazio = todos).
export function startRenewalJob(): void {
  cron.schedule("0 */6 * * *", async () => {
    const rules = await prisma.renewalRule.findMany({ where: { active: true, clinic: PAID_CLINIC_WHERE } });
    const clinicInfoCache = new Map<string, Awaited<ReturnType<typeof getClinicTemplateInfo>>>();

    for (const rule of rules) {
      const days = intervalDays(rule.intervalValue, rule.intervalUnit);
      if (days === null) {
        console.error(`[renovacao] regra ${rule.id} com intervalUnit invalido ("${rule.intervalUnit}"; esperado months/years) - pulando`);
        continue;
      }
      const cutoff = new Date(Date.now() - days * DAY_MS);
      const procedureFilter = rule.procedureIds.split(",").filter(Boolean);

      const due = await prisma.appointment.findMany({
        where: {
          clinicId: rule.clinicId,
          ...(rule.onlyIfCompleted ? { status: "completed" } : { status: { not: "cancelled" } }),
          scheduledAt: { lte: cutoff },
          ...(procedureFilter.length ? { procedureId: { in: procedureFilter } } : {}),
          renewalSent: { none: { ruleId: rule.id } },
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
          birthDate: appt.patient.birthDate,
        });

        try {
          await sendText(appt.clinicId, appt.patient.phone, text);
          await prisma.renewalSent.create({ data: { appointmentId: appt.id, ruleId: rule.id } });
        } catch (err) {
          console.error(`Falha ao enviar renovacao (regra ${rule.id}) para ${appt.patient.phone}:`, err);
        }
      }
    }
  });
}
