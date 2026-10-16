import { scheduleLocked } from "../jobs/lock.js";
import { prisma } from "../db/client.js";
import { sendText } from "../uazapi/client.js";
import { PAID_CLINIC_WHERE } from "./plan.js";
import { isWithinClinicHours } from "./openHours.js";
import { wallClockInZone } from "../scheduling/time.js";
import { nationalHolidayOn, parseHolidayOpen } from "../scheduling/holidays.js";
import { recordAutomatedMessage } from "./conversationLog.js";
import { MONTH_LEADS_MODE, monthLeadRecipients, firstInterest } from "./leadReactivation.js";
import { getFunnelStages } from "./stages.js";
import type { Clinic } from "@prisma/client";

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
// {procedimento} = o primeiro interesse conhecido do paciente (anotado pela Alice no resumo do CRM).
export function renderTemplate(template: string, patientName: string | null, patientPhone: string, clinic: BroadcastClinicInfo, interestNote: string | null = null): string {
  const fullName = patientName?.trim() ?? "";
  const firstName = fullName.split(" ")[0] ?? "";
  const now = new Date();

  return template
    .replace(/\{nome\}/gi, firstName)
    .replace(/\{primeiro_nome\}/gi, firstName)
    .replace(/\{nome_completo\}/gi, fullName)
    .replace(/\{procedimento\}/gi, firstInterest(interestNote))
    .replace(/\{telefone\}/gi, patientPhone)
    .replace(/\{endereco\}/gi, clinic.primaryLocation?.fullAddress ?? "")
    .replace(/\{unidade\}/gi, clinic.primaryLocation?.name ?? clinic.name)
    .replace(/\{data_hora\}/gi, now.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }))
    .replace(/\b(Oi|Olá|Ola),\s*!/gi, "$1!") // sem nome: "Oi, !" vira "Oi!"
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

// Hora local da CLINICA, nao do servidor, e so em dia de atendimento que nao seja feriado fechado. Sem isso, uma
// clinica configurada pra 8h-18h dispara campanha nos horarios errados sempre que a VPS roda num fuso diferente do
// dela (ex: servidor em UTC == 21h em Brasilia), e disparava no domingo/feriado porque so a hora era conferida.
function isSendingAllowed(clinic: Clinic): boolean {
  if (!isWithinClinicHours(clinic, new Date())) return false;
  if (clinic.closedOnHolidays) {
    const wc = wallClockInZone(new Date(), clinic.timezone || "America/Sao_Paulo");
    const holiday = nationalHolidayOn(wc.year, wc.month, wc.day);
    if (holiday && !parseHolidayOpen(clinic.holidayOpen).has(holiday)) return false;
  }
  return true;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let broadcastRunning = false;

// Comparacao tolerante entre o nome do procedimento e o que a pessoa disse que recusou ("botox" x "Aplicacao de Botox").
export function refusalKey(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}
export function refusedAny(refused: string | null, chosenKeys: string[]): boolean {
  if (!refused) return false;
  const items = refused.split(",").map(refusalKey).filter((x) => x.length >= 3);
  return items.some((r) => chosenKeys.some((c) => c.includes(r) || r.includes(c)));
}

// Reativacao de base: quem fez um procedimento (concluido) ha mais de N meses e
// nao tem consulta futura, exceto quem optou por nao receber.
async function reactivationRecipients(clinicId: string, config: string | null): Promise<string[]> {
  let cfg: { procedureIds?: string[]; monthsSince?: number } = {};
  try { cfg = JSON.parse(config || "{}"); } catch { /* usa default */ }
  const months = Math.min(Math.max(cfg.monthsSince ?? 6, 1), 36);
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const now = new Date();

  const completed = await prisma.appointment.findMany({
    where: {
      clinicId,
      status: "completed",
      ...(cfg.procedureIds?.length ? { procedureId: { in: cfg.procedureIds } } : {}),
    },
    select: { patientId: true, scheduledAt: true },
  });
  const lastByPatient = new Map<string, Date>();
  for (const a of completed) {
    const cur = lastByPatient.get(a.patientId);
    if (!cur || a.scheduledAt > cur) lastByPatient.set(a.patientId, a.scheduledAt);
  }
  const candidateIds = [...lastByPatient].filter(([, last]) => last < cutoff).map(([id]) => id);
  if (candidateIds.length === 0) return [];

  const [upcoming, blocked, chosen] = await Promise.all([
    prisma.appointment.findMany({
      where: { clinicId, status: "confirmed", scheduledAt: { gte: now }, patientId: { in: candidateIds } },
      select: { patientId: true },
    }),
    // pediu pra parar OU disse que nao tem interesse (ou recusou algum procedimento: filtrado abaixo)
    prisma.patient.findMany({
      where: { id: { in: candidateIds } },
      select: { id: true, optedOut: true, noInterest: true, refusedProcedures: true },
    }),
    cfg.procedureIds?.length ? prisma.procedure.findMany({ where: { clinicId, id: { in: cfg.procedureIds } }, select: { name: true } }) : Promise.resolve([]),
  ]);
  const skip = new Set(upcoming.map((u) => u.patientId));
  const chosenNames = chosen.map((c) => refusalKey(c.name));
  for (const p of blocked) {
    if (p.optedOut || p.noInterest) skip.add(p.id);
    // Campanha de um procedimento que a pessoa disse que NAO quer: nao oferece de novo.
    else if (chosenNames.length && refusedAny(p.refusedProcedures, chosenNames)) skip.add(p.id);
  }
  return candidateIds.filter((id) => !skip.has(id));
}

async function activateDueCampaigns(): Promise<void> {
  const due = await prisma.broadcastCampaign.findMany({
    where: { status: "scheduled", scheduledFor: { lte: new Date() }, clinic: PAID_CLINIC_WHERE },
  });

  for (const campaign of due) {
    // Campanha criada com "contatos especificos" ja tem os destinatarios
    // gravados na criacao (ver POST /broadcasts) - so recalcula por
    // clinica/etapa/reativacao quando nao ha nenhum ainda.
    const alreadyPopulated = await prisma.broadcastRecipient.count({ where: { campaignId: campaign.id } });
    if (alreadyPopulated === 0) {
      let patientIds: string[];
      if (campaign.targetMode === "reactivation") {
        patientIds = await reactivationRecipients(campaign.clinicId, campaign.targetConfig);
      } else if (campaign.targetMode === MONTH_LEADS_MODE) {
        // Leads do mes que ainda nao agendaram nem compraram (ver leadReactivation.ts)
        patientIds = await monthLeadRecipients(campaign.clinicId, /\{procedimento\}/i.test(campaign.message));
      } else {
        const patients = await prisma.patient.findMany({
          where: {
            clinicId: campaign.clinicId,
            optedOut: false, // quem pediu pra parar nao recebe campanha
            noInterest: false, // nem quem disse que nao tem interesse
            ...(campaign.targetStage ? { funnelStage: campaign.targetStage } : {}),
          },
          select: { id: true },
        });
        patientIds = patients.map((p) => p.id);
      }

      if (patientIds.length > 0) {
        await prisma.broadcastRecipient.createMany({
          data: patientIds.map((id) => ({ campaignId: campaign.id, patientId: id })),
        });
      }
    }

    // Sem nenhum destinatario (ex.: reativacao sem ninguem elegivel): nao fica "enviando" pra sempre.
    const total = await prisma.broadcastRecipient.count({ where: { campaignId: campaign.id } });
    await prisma.broadcastCampaign.update({ where: { id: campaign.id }, data: { status: total === 0 ? "completed" : "sending" } });
  }
}

async function sendNextBatch(): Promise<void> {
  const sendingCampaigns = await prisma.broadcastCampaign.findMany({ where: { status: "sending", clinic: PAID_CLINIC_WHERE } });

  for (const campaign of sendingCampaigns) {
    const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: campaign.clinicId } });
    if (!isSendingAllowed(clinic)) continue;

    const pending = await prisma.broadcastRecipient.findMany({
      where: { campaignId: campaign.id, status: "pending" },
      include: { patient: true },
      take: BATCH_SIZE,
    });
    if (pending.length === 0) continue;

    const clinicInfo = await getBroadcastClinicInfo(clinic.id);
    const needsInterest = /\{procedimento\}/i.test(campaign.message);
    const wonStageIds =
      campaign.targetMode === MONTH_LEADS_MODE ? (await getFunnelStages(clinic.id)).filter((st) => st.kind === "ganho").map((st) => st.stageId) : [];
    for (let i = 0; i < pending.length; i++) {
      const recipient = pending[i];
      // Pediu pra parar (ou foi marcado assim depois da campanha ser montada): pula sem enviar.
      if (recipient.patient.optedOut || recipient.patient.noInterest) {
        await prisma.broadcastRecipient.update({ where: { id: recipient.id }, data: { status: "skipped" } });
        continue;
      }
      // Texto com {procedimento} e sem interesse conhecido: nao faz sentido, pula.
      if (needsInterest && !firstInterest(recipient.patient.interestNote)) {
        await prisma.broadcastRecipient.update({ where: { id: recipient.id }, data: { status: "skipped" } });
        continue;
      }
      // Campanha mensal de leads: a campanha leva horas; quem agendou/comprou nesse meio tempo, ou pediu pra ser chamada
      // mais tarde, ja nao e "lead que nao agendou".
      if (campaign.targetMode === MONTH_LEADS_MODE) {
        const booked = await prisma.appointment.count({ where: { patientId: recipient.patientId, status: { in: ["confirmed", "completed", "no_show"] } } });
        const waiting = recipient.patient.callbackAt && recipient.patient.callbackAt.getTime() > Date.now();
        if (booked > 0 || waiting || wonStageIds.includes(recipient.patient.funnelStage)) {
          await prisma.broadcastRecipient.update({ where: { id: recipient.id }, data: { status: "skipped" } });
          continue;
        }
      }
      const text = renderTemplate(campaign.message, recipient.patient.name, recipient.patient.phone, clinicInfo, recipient.patient.interestNote);
      try {
        const outcome = await sendText(clinic.id, recipient.patient.phone, text, { kind: "campanha" });
        await prisma.broadcastRecipient.update({
          where: { id: recipient.id },
          data: { status: outcome === "sent" ? "sent" : "skipped", sentAt: new Date() },
        });
        // Reativacao: registra a mensagem na conversa do paciente pra Alice ter
        // contexto quando ele responder (as outras campanhas nao precisam disso).
        if (outcome === "sent" && (campaign.targetMode === "reactivation" || campaign.targetMode === MONTH_LEADS_MODE)) {
          await recordAutomatedMessage(recipient.patientId, text, "Reativação de base");
        }
      } catch (err) {
        console.error(`Falha ao enviar broadcast para ${recipient.patient.phone}:`, err);
        await prisma.broadcastRecipient.update({ where: { id: recipient.id }, data: { status: "failed" } });
      }
      // Pausa aleatoria entre um envio e outro (rajada de dezenas de mensagens iguais e o padrao que o WhatsApp bloqueia).
      if (i < pending.length - 1) await sleep(4000 + Math.random() * 6000);
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
  // Um lote com pausas pode passar de 5 min: nao deixa a rodada seguinte comecar por cima (enviaria os mesmos destinatarios de novo).
  if (broadcastRunning) return;
  broadcastRunning = true;
  try {
    await activateDueCampaigns();
    await sendNextBatch();
  } finally {
    broadcastRunning = false;
  }
}

// A cada 5 minutos: ativa campanhas que chegaram na hora e manda o proximo lote.
export function startBroadcastJob(): void {
  scheduleLocked("disparos-em-massa", "*/5 * * * *", () => runBroadcastTick().catch((err) => console.error("Erro no job de mensagens programadas:", err)));
}
