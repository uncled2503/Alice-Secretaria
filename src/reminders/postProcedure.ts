import { scheduleLocked } from "../jobs/lock.js";
import { prisma } from "../db/client.js";
import { sendText, isPermanentSendError } from "../uazapi/client.js";
import { renderMessageTemplate, getClinicTemplateInfo } from "../crm/template.js";
import { PAID_CLINIC_WHERE } from "../crm/plan.js";
import { notifyStaff } from "../crm/notify.js";
import { recordAutomatedMessage } from "../crm/conversationLog.js";

function intervalMs(value: number, unit: string): number {
  const hourMs = 60 * 60_000;
  return unit === "hours" ? value * hourMs : value * 24 * hourMs;
}

// Nunca considera um agendamento "due" ha mais tempo que isso - protege contra
// disparo retroativo em massa quando uma regra e criada ou recriada do zero
// (sem isso, TODO agendamento ja feito no passado - meses de historico - vira
// "due" ao mesmo tempo na primeira checagem, porque nenhum tem PostProcedureSent
// pra esse ruleId novo). Incidente real: 30/09/2026, Clinica Dr. Saulo Silva -
// recriar a regra mandou a mensagem pra toda a base de pacientes de uma vez.
const MAX_OVERDUE_MS = 3 * 24 * 60 * 60_000; // 3 dias de folga alem do prazo da regra
const MAX_PER_TICK = 30; // teto de seguranca por regra a cada execucao (15min)

// Roda a cada 15min. So dispara uma vez por agendamento por regra (marca em
// PostProcedureSent), respeitando "so apos concluido" e o filtro de
// procedimentos (procedureIds vazio = vale pra todos).
export function startPostProcedureJob(): void {
  scheduleLocked("pos-procedimento", "*/15 * * * *", async () => {
    const rules = await prisma.postProcedureRule.findMany({ where: { active: true, clinic: PAID_CLINIC_WHERE } });
    const clinicInfoCache = new Map<string, Awaited<ReturnType<typeof getClinicTemplateInfo>>>();

    for (const rule of rules) {
      const now = new Date();
      const cutoff = new Date(now.getTime() - intervalMs(rule.intervalValue, rule.intervalUnit));
      const floor = new Date(cutoff.getTime() - MAX_OVERDUE_MS);
      const procedureFilter = rule.procedureIds.split(",").filter(Boolean);

      const due = await prisma.appointment.findMany({
        where: {
          clinicId: rule.clinicId,
          ...(rule.onlyIfCompleted ? { status: "completed" } : { status: { notIn: ["cancelled", "no_show"] } }),
          scheduledAt: { lte: cutoff, gte: floor },
          ...(procedureFilter.length ? { procedureId: { in: procedureFilter } } : {}),
          postProcedureSent: { none: { ruleId: rule.id } },
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
          await prisma.postProcedureSent.create({ data: { appointmentId: appt.id, ruleId: rule.id } });
        } catch {
          continue; // reserva atomica: outro processo ja pegou
        }
        try {
          await sendText(appt.clinicId, appt.patient.phone, text);
          await recordAutomatedMessage(appt.patientId, text, rule.name || "Pós-procedimento automático");
        } catch (err) {
          if (isPermanentSendError(err)) {
            // Numero sem WhatsApp: mantem a reserva (nao tenta de novo a cada 15 min) e avisa a equipe uma vez.
            console.error(`Pos-procedimento nao enviado: ${appt.patient.phone} nao tem WhatsApp.`);
            await notifyStaff(appt.clinicId, "automation_failed", `⚠️ O número de ${appt.patient.name ?? appt.patient.phone} (${appt.patient.phone}) não tem WhatsApp, então a mensagem de acompanhamento ("${rule.name}") não foi enviada. Confira o telefone no cadastro.`);
            continue;
          }
          await prisma.postProcedureSent.deleteMany({ where: { appointmentId: appt.id, ruleId: rule.id } }); // devolve a reserva
          console.error(`Falha ao enviar pos-procedimento (regra ${rule.id}) para ${appt.patient.phone}:`, err);
          // Sem isso a falha so aparecia no log do servidor - a clinica nunca
          // ficava sabendo que a mensagem automatica nao saiu. O robo tenta de
          // novo no proximo ciclo (15min); o aviso repete ate resolver ou sair.
          await notifyStaff(
            appt.clinicId,
            "automation_failed",
            `⚠️ Falha ao enviar mensagem automática de acompanhamento ("${rule.name}") para ${appt.patient.name ?? appt.patient.phone} (${appt.patient.phone}). O sistema vai tentar novamente, mas convém checar a conexão do WhatsApp.`
          );
        }
      }
    }
  });
}
