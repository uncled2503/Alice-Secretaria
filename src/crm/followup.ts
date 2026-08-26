import cron from "node-cron";
import { prisma } from "../db/client.js";
import { sendText } from "../whatsapp/manager.js";
import { getFunnelStages } from "./stages.js";

function renderTemplate(template: string, patientName: string | null): string {
  const firstName = patientName?.split(" ")[0] ?? "";
  return template.replace(/\{nome\}/gi, firstName).trim();
}

// Cache simples por execucao do job - evita repetir a consulta de etapas
// pra cada conversa da mesma clinica.
const stagesCache = new Map<string, Awaited<ReturnType<typeof getFunnelStages>>>();
async function cachedStages(clinicId: string) {
  let stages = stagesCache.get(clinicId);
  if (!stages) {
    stages = await getFunnelStages(clinicId);
    stagesCache.set(clinicId, stages);
  }
  return stages;
}

// Verifica cada conversa aberta e dispara a proxima mensagem da cascata de
// recontato quando o paciente fica X dias sem responder (silencio contado a
// partir da ultima mensagem DELE, nao das nossas). Pausa automaticamente se
// ja tem agendamento confirmado no futuro.
export async function runFollowUpCheck(): Promise<void> {
  stagesCache.clear();

  const conversations = await prisma.conversation.findMany({
    where: { status: "active", humanTakeover: false },
    include: {
      patient: true,
      messages: { where: { role: "user" }, orderBy: { createdAt: "desc" }, take: 1 },
    },
  });

  for (const conversation of conversations) {
    const lastPatientMessage = conversation.messages[0];
    if (!lastPatientMessage) continue;

    const stages = await cachedStages(conversation.patient.clinicId);
    const recoveryEligible = new Set(stages.filter((s) => s.kind === "aberta").map((s) => s.stageId));

    if (
      conversation.patient.funnelStage !== "novo_lead" &&
      !recoveryEligible.has(conversation.patient.funnelStage)
    ) {
      continue; // ja ganhou, perdeu, ou esta em pos-procedimento - nao é recontato
    }

    const upcomingAppointment = await prisma.appointment.findFirst({
      where: { patientId: conversation.patientId, status: "confirmed", scheduledAt: { gte: new Date() } },
    });
    if (upcomingAppointment) continue; // ja tem horario marcado, nao precisa recontatar

    const nextOrder = conversation.lastFollowUpOrder + 1;
    const rule = await prisma.followUpRule.findFirst({
      where: { clinicId: conversation.patient.clinicId, order: nextOrder, active: true },
    });
    if (!rule) continue;

    const daysSinceSilence = (Date.now() - lastPatientMessage.createdAt.getTime()) / (24 * 60 * 60_000);
    if (daysSinceSilence < rule.afterDays) continue;

    const text = renderTemplate(rule.message, conversation.patient.name);

    try {
      await sendText(conversation.patient.clinicId, conversation.patient.phone, text);
    } catch (err) {
      console.error(`Falha ao enviar recontato para ${conversation.patient.phone}:`, err);
      continue;
    }

    await prisma.message.create({
      data: { conversationId: conversation.id, role: "assistant", content: text },
    });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastFollowUpOrder: nextOrder },
    });

    // "recuperacao" e o slug padrao pra essa etapa; se a clinica renomeou/
    // removeu esse stageId especifico, so pulamos esse bonus (sem quebrar o envio).
    const recoveryStage = stages.find((s) => s.stageId === "recuperacao");
    if (nextOrder === 1 && recoveryStage && recoveryEligible.has(conversation.patient.funnelStage)) {
      await prisma.patient.update({
        where: { id: conversation.patientId },
        data: { funnelStage: recoveryStage.stageId },
      });
    }
  }
}

// Roda a cada hora - a granularidade de "dias" das regras nao exige mais que isso.
export function startFollowUpJob(): void {
  cron.schedule("0 * * * *", () => {
    runFollowUpCheck().catch((err) => console.error("Erro no job de recontato:", err));
  });
}
