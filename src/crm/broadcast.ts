import cron from "node-cron";
import { prisma } from "../db/client.js";
import { sendText } from "../whatsapp/manager.js";

// Envia aos poucos pra nao estourar limite de taxa do WhatsApp e nao
// disparar centenas de mensagens de uma vez so (risco real de banimento).
const BATCH_SIZE = 20;

function renderTemplate(template: string, patientName: string | null): string {
  const firstName = patientName?.split(" ")[0] ?? "";
  return template.replace(/\{nome\}/gi, firstName).trim();
}

function isWithinBusinessHours(workStartHour: number, workEndHour: number): boolean {
  const hour = new Date().getHours();
  return hour >= workStartHour && hour < workEndHour;
}

async function activateDueCampaigns(): Promise<void> {
  const due = await prisma.broadcastCampaign.findMany({
    where: { status: "scheduled", scheduledFor: { lte: new Date() } },
  });

  for (const campaign of due) {
    const patients = await prisma.patient.findMany({
      where: {
        clinicId: campaign.clinicId,
        ...(campaign.targetStage ? { funnelStage: campaign.targetStage } : {}),
      },
    });

    if (patients.length > 0) {
      // skipDuplicates nao existe no SQLite; seguro sem ele pois esta ativacao
      // roda uma unica vez por campanha (logo depois muda o status pra "sending").
      await prisma.broadcastRecipient.createMany({
        data: patients.map((p) => ({ campaignId: campaign.id, patientId: p.id })),
      });
    }

    await prisma.broadcastCampaign.update({ where: { id: campaign.id }, data: { status: "sending" } });
  }
}

async function sendNextBatch(): Promise<void> {
  const sendingCampaigns = await prisma.broadcastCampaign.findMany({ where: { status: "sending" } });

  for (const campaign of sendingCampaigns) {
    const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: campaign.clinicId } });
    if (!isWithinBusinessHours(clinic.workStartHour, clinic.workEndHour)) continue;

    const pending = await prisma.broadcastRecipient.findMany({
      where: { campaignId: campaign.id, status: "pending" },
      include: { patient: true },
      take: BATCH_SIZE,
    });

    for (const recipient of pending) {
      const text = renderTemplate(campaign.message, recipient.patient.name);
      try {
        await sendText(clinic.id, recipient.patient.phone, text);
        await prisma.broadcastRecipient.update({
          where: { id: recipient.id },
          data: { status: "sent", sentAt: new Date() },
        });
      } catch (err) {
        console.error(`Falha ao enviar broadcast para ${recipient.patient.phone}:`, err);
        await prisma.broadcastRecipient.update({ where: { id: recipient.id }, data: { status: "failed" } });
      }
    }

    const stillPending = await prisma.broadcastRecipient.count({
      where: { campaignId: campaign.id, status: "pending" },
    });
    if (stillPending === 0) {
      await prisma.broadcastCampaign.update({ where: { id: campaign.id }, data: { status: "completed" } });
    }
  }
}

export async function runBroadcastTick(): Promise<void> {
  await activateDueCampaigns();
  await sendNextBatch();
}

// A cada 5 minutos: ativa campanhas que chegaram na hora e manda o proximo lote.
export function startBroadcastJob(): void {
  cron.schedule("*/5 * * * *", () => {
    runBroadcastTick().catch((err) => console.error("Erro no job de mensagens programadas:", err));
  });
}
