import cron from "node-cron";
import { prisma } from "../db/client.js";
import { sendText } from "../uazapi/client.js";

// Envia aos poucos pra nao estourar limite de taxa do WhatsApp e nao
// disparar centenas de mensagens de uma vez so (risco real de banimento).
const BATCH_SIZE = 20;

type BroadcastClinicInfo = {
  name: string;
  primaryLocation: { name: string; fullAddress: string } | null;
};

// {nome} continua funcionando (campanhas antigas ja usam esse placeholder) -
// e so um alias de {primeiro_nome}. Endereco/unidade vem da unidade principal
// da clinica, ja que o paciente nao esta amarrado a uma unidade especifica.
function renderTemplate(template: string, patientName: string | null, patientPhone: string, clinic: BroadcastClinicInfo): string {
  const fullName = patientName?.trim() ?? "";
  const firstName = fullName.split(" ")[0] ?? "";
  const now = new Date();

  return template
    .replace(/\{nome\}/gi, firstName)
    .replace(/\{primeiro_nome\}/gi, firstName)
    .replace(/\{nome_completo\}/gi, fullName)
    .replace(/\{telefone\}/gi, patientPhone)
    .replace(/\{endereco\}/gi, clinic.primaryLocation?.fullAddress ?? "")
    .replace(/\{unidade\}/gi, clinic.primaryLocation?.name ?? clinic.name)
    .replace(/\{data_hora\}/gi, now.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }))
    .trim();
}

async function getBroadcastClinicInfo(clinicId: string): Promise<BroadcastClinicInfo> {
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId } });
  const location = await prisma.clinicLocation.findFirst({
    where: { clinicId, active: true },
    orderBy: { order: "asc" },
  });

  if (!location) return { name: clinic.name, primaryLocation: null };

  const parts = [location.street, location.number, location.neighborhood, location.city, location.state]
    .filter(Boolean)
    .join(", ");
  return { name: clinic.name, primaryLocation: { name: location.name, fullAddress: parts } };
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
    // Campanha criada com "contatos especificos" ja tem os destinatarios
    // gravados na criacao (ver POST /broadcasts) - so recalcula por
    // clinica/etapa quando nao ha nenhum ainda.
    const alreadyPopulated = await prisma.broadcastRecipient.count({ where: { campaignId: campaign.id } });
    if (alreadyPopulated === 0) {
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
    if (pending.length === 0) continue;

    const clinicInfo = await getBroadcastClinicInfo(clinic.id);
    for (const recipient of pending) {
      const text = renderTemplate(campaign.message, recipient.patient.name, recipient.patient.phone, clinicInfo);
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
