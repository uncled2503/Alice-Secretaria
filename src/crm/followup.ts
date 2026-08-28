import cron from "node-cron";
import { prisma } from "../db/client.js";
import { sendText } from "../whatsapp/manager.js";
import { getFunnelStages } from "./stages.js";
import { renderMessageTemplate, getClinicTemplateInfo, type ClinicTemplateInfo } from "./template.js";

// Cache simples por execucao do job.
const stagesCache = new Map<string, Awaited<ReturnType<typeof getFunnelStages>>>();
const clinicCache = new Map<string, { timezone: string; info: ClinicTemplateInfo }>();

async function cachedStages(clinicId: string) {
  let stages = stagesCache.get(clinicId);
  if (!stages) {
    stages = await getFunnelStages(clinicId);
    stagesCache.set(clinicId, stages);
  }
  return stages;
}

async function cachedClinic(clinicId: string) {
  let entry = clinicCache.get(clinicId);
  if (!entry) {
    const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { timezone: true } });
    entry = { timezone: clinic.timezone || "America/Sao_Paulo", info: await getClinicTemplateInfo(clinicId) };
    clinicCache.set(clinicId, entry);
  }
  return entry;
}

function localHour(timeZone: string): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit" }).format(new Date()));
}

// Janela [start, end): aceita janela que vira a meia-noite (ex: 20 -> 6).
function withinWindow(hour: number, start: number | null, end: number | null): boolean {
  if (start == null || end == null) return true;
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

// Verifica cada conversa aberta e dispara a proxima mensagem da cascata de
// recontato quando o paciente fica um tempo sem responder (silencio contado a
// partir da ultima mensagem DELE).
export async function runFollowUpCheck(): Promise<void> {
  stagesCache.clear();
  clinicCache.clear();

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

    const clinicId = conversation.patient.clinicId;
    const stages = await cachedStages(clinicId);
    const recoveryEligible = new Set(stages.filter((s) => s.kind === "aberta").map((s) => s.stageId));

    if (
      conversation.patient.funnelStage !== "novo_lead" &&
      !recoveryEligible.has(conversation.patient.funnelStage)
    ) {
      continue; // ja ganhou, perdeu, ou esta em pos-procedimento - nao e recontato
    }

    const nextOrder = conversation.lastFollowUpOrder + 1;
    const rule = await prisma.followUpRule.findFirst({
      where: { clinicId, order: nextOrder, active: true },
    });
    if (!rule) continue;

    if (rule.skipIfUpcomingAppt) {
      const upcoming = await prisma.appointment.findFirst({
        where: { patientId: conversation.patientId, status: "confirmed", scheduledAt: { gte: new Date() } },
      });
      if (upcoming) continue;
    }

    if (rule.repeatMode === "once") {
      const already = await prisma.followUpSent.findUnique({
        where: { conversationId_ruleId: { conversationId: conversation.id, ruleId: rule.id } },
      });
      if (already) {
        // ja mandou esse recontato uma vez nessa conversa - so avanca o ponteiro
        // pra cascata seguir pros proximos recontatos.
        await prisma.conversation.update({ where: { id: conversation.id }, data: { lastFollowUpOrder: nextOrder } });
        continue;
      }
    }

    const silenceMin = (Date.now() - lastPatientMessage.createdAt.getTime()) / 60_000;
    const thresholdMin = rule.afterMinutes > 0 ? rule.afterMinutes : rule.afterDays * 1440;
    if (silenceMin < thresholdMin) continue;

    const clinic = await cachedClinic(clinicId);
    if (!withinWindow(localHour(clinic.timezone), rule.sendWindowStart, rule.sendWindowEnd)) continue;

    const text = renderMessageTemplate(rule.message, {
      patientName: conversation.patient.name,
      patientPhone: conversation.patient.phone,
      clinicName: clinic.info.name,
      locationName: clinic.info.primaryLocation?.name,
      locationAddress: clinic.info.primaryLocation?.fullAddress,
      birthDate: conversation.patient.birthDate,
    });

    try {
      await sendText(clinicId, conversation.patient.phone, text);
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
    if (rule.repeatMode === "once") {
      await prisma.followUpSent.create({ data: { conversationId: conversation.id, ruleId: rule.id } });
    }

    // "recuperacao" e o slug padrao pra essa etapa; se a clinica renomeou/
    // removeu esse stageId, so pulamos esse bonus (sem quebrar o envio).
    const recoveryStage = stages.find((s) => s.stageId === "recuperacao");
    if (nextOrder === 1 && recoveryStage && recoveryEligible.has(conversation.patient.funnelStage)) {
      await prisma.patient.update({
        where: { id: conversation.patientId },
        data: { funnelStage: recoveryStage.stageId },
      });
    }
  }
}

// Roda a cada 15min - agora que os recontatos podem ter janela em minutos.
export function startFollowUpJob(): void {
  cron.schedule("*/15 * * * *", () => {
    runFollowUpCheck().catch((err) => console.error("Erro no job de recontato:", err));
  });
}
