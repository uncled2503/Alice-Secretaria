import { scheduleLocked } from "../jobs/lock.js";
import { prisma } from "../db/client.js";
import { sendText } from "../uazapi/client.js";
import { renderMessageTemplate, getClinicTemplateInfo } from "../crm/template.js";
import { PAID_CLINIC_WHERE } from "../crm/plan.js";
import { recordAutomatedMessage } from "../crm/conversationLog.js";
import { wallClockInZone } from "../scheduling/time.js";
import { PLACEHOLDER_PROCEDURE_NAME } from "../clinicaexperts/placeholderProcedure.js";

const DAY_MS = 24 * 60 * 60_000;
const MAX_DAYS = 2 * 365; // limite de 2 anos

// Mesma protecao do postProcedure.ts: nunca manda pra algo que ficou "due" ha
// mais tempo que isso, senao criar/recriar uma regra reenvia pra anos de
// historico de uma vez (ver incidente de 30/09/2026 descrito la).
const MAX_OVERDUE_MS = 30 * DAY_MS; // 30 dias de folga - escala de meses/anos
const MAX_PER_TICK = 30;

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
  scheduleLocked("renovacao", "0 */6 * * *", async () => {
    const rules = await prisma.renewalRule.findMany({
      where: { active: true, clinic: PAID_CLINIC_WHERE },
      include: { clinic: { select: { timezone: true } } },
    });
    const clinicInfoCache = new Map<string, Awaited<ReturnType<typeof getClinicTemplateInfo>>>();

    for (const rule of rules) {
      // O job roda de 6 em 6h em UTC (21h, 3h, 9h e 15h em Brasilia): convite de renovacao so entre 8h e 20h na clinica.
      const localHour = wallClockInZone(new Date(), rule.clinic.timezone || "America/Sao_Paulo").hour;
      if (localHour < 8 || localHour >= 20) continue;
      const days = intervalDays(rule.intervalValue, rule.intervalUnit);
      if (days === null) {
        console.error(`[renovacao] regra ${rule.id} com intervalUnit invalido ("${rule.intervalUnit}"; esperado months/years) - pulando`);
        continue;
      }
      const cutoff = new Date(Date.now() - days * DAY_MS);
      const floor = new Date(cutoff.getTime() - MAX_OVERDUE_MS);
      const procedureFilter = rule.procedureIds.split(",").filter(Boolean);

      const due = await prisma.appointment.findMany({
        where: {
          clinicId: rule.clinicId,
          // "Fez o procedimento": concluido (ou agendado que ja passou sem ser marcado - a recepcao nem sempre marca). Quem
          // faltou ou cancelou nao fez, entao nao recebe "ja faz 4 meses desde o seu Botox".
          ...(rule.onlyIfCompleted ? { status: "completed" } : { status: { in: ["confirmed", "completed"] } }),
          scheduledAt: { lte: cutoff, gte: floor },
          ...(procedureFilter.length ? { procedureId: { in: procedureFilter } } : {}),
          procedure: { name: { not: PLACEHOLDER_PROCEDURE_NAME } }, // reserva sem procedimento nao tem o que renovar
          renewalSent: { none: { ruleId: rule.id } },
          patient: { optedOut: false }, // quem pediu pra parar nao recebe mensagem automatica
        },
        include: { patient: true, procedure: true, professional: true },
        take: MAX_PER_TICK,
      });

      if (due.length === 0) continue;

      if (!clinicInfoCache.has(rule.clinicId)) {
        clinicInfoCache.set(rule.clinicId, await getClinicTemplateInfo(rule.clinicId));
      }
      const clinicInfo = clinicInfoCache.get(rule.clinicId)!;

      for (const appt of due) {
        // Ja tem novo agendamento (ou ja voltou) para o mesmo procedimento: nao manda a renovacao. Olha qualquer atendimento
        // confirmado/concluido DEPOIS deste, do mesmo procedimento (ou do mesmo grupo da regra, ex.: varios tipos de preenchimento).
        const groupIds = procedureFilter.length ? procedureFilter : [appt.procedureId];
        const later = await prisma.appointment.count({
          where: { patientId: appt.patientId, status: { in: ["confirmed", "completed"] }, scheduledAt: { gt: appt.scheduledAt }, procedureId: { in: groupIds } },
        });
        if (later > 0) continue;

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
          const outcome = await sendText(appt.clinicId, appt.patient.phone, text, { kind: "renovacao" });
          await prisma.renewalSent.create({ data: { appointmentId: appt.id, ruleId: rule.id } });
          if (outcome === "sent") await recordAutomatedMessage(appt.patientId, text, rule.name || "Renovação automática");
        } catch (err) {
          console.error(`Falha ao enviar renovacao (regra ${rule.id}) para ${appt.patient.phone}:`, err);
        }
      }
    }
  });
}
