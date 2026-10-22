import { scheduleLocked } from "../jobs/lock.js";
import { prisma } from "../db/client.js";
import { sendText, isSendDeferred, deferralInfo, isPermanentSendError, isAmbiguousSendError, type SendReport } from "../uazapi/client.js";
import { PAID_CLINIC_WHERE } from "./plan.js";
import { isWithinClinicHours } from "./openHours.js";
import { wallClockInZone } from "../scheduling/time.js";
import { nationalHolidayOn, parseHolidayOpen } from "../scheduling/holidays.js";
import { recordAutomatedMessage } from "./conversationLog.js";
import { MONTH_LEADS_MODE, monthLeadRecipients, firstInterest } from "./leadReactivation.js";
import { getFunnelStages } from "./stages.js";
import { usableFirstName, usableFullName, tidyGreetingText } from "./greeting.js";
import type { Clinic } from "@prisma/client";

// Envia aos poucos pra nao estourar limite de taxa do WhatsApp e nao
// disparar centenas de mensagens de uma vez so (risco real de banimento).
const BATCH_SIZE = 20;
export const BROADCAST_MAX_ATTEMPTS = 3;
export const BROADCAST_RETRY_GAP_MS = 15 * 60_000;
export const BROADCAST_STALE_MS = 30 * 60_000;
// Estados do DESTINATARIO (22/10/2026). `sentAt` so existe quando o PROVEDOR ACEITOU a mensagem (antes era gravado tambem para "skipped"/vetado/bloqueado, e a atribuicao de resposta a campanha
// usava esse horario como prova de envio).
//   pending -> sending (reserva atomica) -> sent (aceito pelo provedor) | vetoed (revisao barrou) | blocked (plano/politica) | skipped (nao se aplica: opt-out, sem interesse, ja agendou, duplicada)
//   | deferred (WhatsApp/revisao fora do ar: nada saiu, tenta de novo) | failed (falha recuperavel, ate 3 tentativas) | failed_permanent (numero sem WhatsApp) | unconfirmed (timeout: pode ter saido; NUNCA reenvia)
export const BROADCAST_OPEN = ["pending", "sending", "deferred", "failed"];

type BroadcastClinicInfo = {
  name: string;
  primaryLocation: { name: string; fullAddress: string } | null;
};

// {nome} continua funcionando (campanhas antigas ja usam esse placeholder) -
// e so um alias de {primeiro_nome}. Endereco/unidade vem da unidade principal
// da clinica, ja que o paciente nao esta amarrado a uma unidade especifica.
// {procedimento} = o primeiro interesse conhecido do paciente (anotado pela Alice no resumo do CRM).
export function renderTemplate(template: string, patientName: string | null, patientPhone: string, clinic: BroadcastClinicInfo, interestNote: string | null = null): string {
  const fullName = usableFullName(patientName);
  const firstName = usableFirstName(patientName);
  const now = new Date();

  return tidyGreetingText(template
    .replace(/\{nome\}/gi, firstName)
    .replace(/\{primeiro_nome\}/gi, firstName)
    .replace(/\{nome_completo\}/gi, fullName)
    .replace(/\{procedimento\}/gi, firstInterest(interestNote))
    .replace(/\{telefone\}/gi, patientPhone)
    .replace(/\{endereco\}/gi, clinic.primaryLocation?.fullAddress ?? "")
    .replace(/\{unidade\}/gi, clinic.primaryLocation?.name ?? clinic.name)
    .replace(/\{data_hora\}/gi, now.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }))
  ).trim(); // sem nome: "Oi, !" vira "Oi!" (tidyGreetingText)
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
            contactKind: "paciente", // nem contato classificado como nao-paciente
            promoOptOut: false, // nem quem pediu para nao receber PROMOCOES (continua recebendo as operacionais)
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

async function settleStaleRecipients(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - BROADCAST_STALE_MS);
  // reservado e abandonado ANTES de chamar o provedor: nada saiu, volta a pendente; COM tentativa iniciada: incerto, nunca reenvia
  await prisma.broadcastRecipient.updateMany({ where: { status: "sending", attemptedAt: null, updatedAt: { lt: cutoff } }, data: { status: "pending", detail: "reserva abandonada antes de chamar o provedor: liberada", updatedAt: now } });
  await prisma.broadcastRecipient.updateMany({ where: { status: "sending", attemptedAt: { not: null }, updatedAt: { lt: cutoff } }, data: { status: "unconfirmed", detail: "o processo parou durante o envio: pode ter saido; NAO reenviado", updatedAt: now } });
}

async function sendNextBatch(): Promise<void> {
  await settleStaleRecipients(new Date());
  const sendingCampaigns = await prisma.broadcastCampaign.findMany({ where: { status: "sending", clinic: PAID_CLINIC_WHERE } });

  for (const campaign of sendingCampaigns) {
    const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: campaign.clinicId } });
    if (!isSendingAllowed(clinic)) continue;

    const nowBatch = new Date();
    const pending = await prisma.broadcastRecipient.findMany({
      where: { campaignId: campaign.id, OR: [{ status: "pending" }, { status: { in: ["deferred", "failed"] }, attempts: { lt: BROADCAST_MAX_ATTEMPTS }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: nowBatch } }] }] },
      include: { patient: true },
      take: BATCH_SIZE,
    });
    if (pending.length === 0) {
      // nada a enviar agora: se tambem nao ha mais nada em aberto (inclusive retentativas), a campanha termina
      const open = await prisma.broadcastRecipient.count({ where: { campaignId: campaign.id, OR: [{ status: { in: ["pending", "sending", "deferred"] } }, { status: "failed", attempts: { lt: BROADCAST_MAX_ATTEMPTS } }] } });
      if (open === 0) await prisma.broadcastCampaign.update({ where: { id: campaign.id }, data: { status: "completed" } });
      continue;
    }

    const clinicInfo = await getBroadcastClinicInfo(clinic.id);
    const needsInterest = /\{procedimento\}/i.test(campaign.message);
    const wonStageIds =
      campaign.targetMode === MONTH_LEADS_MODE ? (await getFunnelStages(clinic.id)).filter((st) => st.kind === "ganho").map((st) => st.stageId) : [];
    for (let i = 0; i < pending.length; i++) {
      const recipient = pending[i];
      // RESERVA ATOMICA do destinatario (dois ciclos/processos nunca enviam o mesmo): so quem trocar pending/deferred/failed -> sending segue.
      const claim = await prisma.broadcastRecipient.updateMany({ where: { id: recipient.id, status: recipient.status, updatedAt: recipient.updatedAt }, data: { status: "sending", attempts: { increment: 1 }, attemptedAt: null, updatedAt: new Date() } });
      if (claim.count !== 1) continue;
      const attempt = recipient.attempts + 1;
      const skipRecipient = (detail: string) => prisma.broadcastRecipient.updateMany({ where: { id: recipient.id, status: "sending" }, data: { status: "skipped", detail, attempts: { decrement: 1 }, updatedAt: new Date() } });
      // Pediu pra parar (ou foi marcado assim depois da campanha ser montada): pula sem enviar.
      if (recipient.patient.optedOut || recipient.patient.noInterest || recipient.patient.contactKind !== "paciente" || recipient.patient.promoOptOut) {
        await skipRecipient(recipient.patient.contactKind !== "paciente" ? "contato classificado como nao-paciente" : recipient.patient.promoOptOut ? "pediu para nao receber promocoes" : "pediu para nao receber / sem interesse");
        continue;
      }
      // Texto com {procedimento} e sem interesse conhecido: nao faz sentido, pula.
      if (needsInterest && !firstInterest(recipient.patient.interestNote)) {
        await skipRecipient("texto com {procedimento} e sem interesse conhecido");
        continue;
      }
      // Campanha mensal de leads: a campanha leva horas; quem agendou/comprou nesse meio tempo, ou pediu pra ser chamada
      // mais tarde, ja nao e "lead que nao agendou".
      if (campaign.targetMode === MONTH_LEADS_MODE) {
        const booked = await prisma.appointment.count({ where: { patientId: recipient.patientId, status: { in: ["confirmed", "completed", "no_show"] } } });
        const waiting = recipient.patient.callbackAt && recipient.patient.callbackAt.getTime() > Date.now();
        if (booked > 0 || waiting || wonStageIds.includes(recipient.patient.funnelStage)) {
          await skipRecipient("ja agendou/comprou ou pediu retorno mais tarde");
          continue;
        }
      }
      const text = renderTemplate(campaign.message, recipient.patient.name, recipient.patient.phone, clinicInfo, recipient.patient.interestNote);
      const retryAt = new Date(Date.now() + BROADCAST_RETRY_GAP_MS);
      const exhaust = attempt >= BROADCAST_MAX_ATTEMPTS;
      const settle = (data: Record<string, unknown>) => prisma.broadcastRecipient.updateMany({ where: { id: recipient.id, status: "sending" }, data: { ...data, updatedAt: new Date() } });
      let report: SendReport | null = null;
      try {
        const outcome = await sendText(clinic.id, recipient.patient.phone, text, {
          kind: "campanha",
          // IMEDIATAMENTE antes do provedor: a tentativa passa a constar (reservado SEM isto = o provedor NAO foi chamado) e o texto exato fica guardado
          beforeProvider: async () => { await prisma.broadcastRecipient.update({ where: { id: recipient.id }, data: { attemptedAt: new Date(), messageText: text } }); },
          report: (r) => { report = r; },
        });
        const rep = report as SendReport | null;
        if (outcome === "sent") {
          await settle({ status: "sent", sentAt: new Date(), detail: "aceito pelo provedor", destination: rep?.destination ?? null, providerId: rep?.providerId ?? null });
          // Reativacao: registra a mensagem na conversa do paciente pra Alice ter contexto quando ele responder (as outras campanhas nao precisam disso).
          if (campaign.targetMode === "reactivation" || campaign.targetMode === MONTH_LEADS_MODE) {
            await recordAutomatedMessage(recipient.patientId, text, "Reativação de base").catch((err) => console.error("[campanha] aceito, mas o registro no chat falhou (NAO reenvia):", err instanceof Error ? err.message : err));
          }
        } else if (outcome === "vetoed") await settle({ status: "vetoed", detail: "a revisao por IA barrou a mensagem (motivo no Diario)" });
        else if (outcome === "blocked") await settle({ status: "blocked", detail: "envio automatico bloqueado (plano/politica/nao-paciente)" });
        else await settle({ status: "skipped", detail: "mensagem identica ja enviada (duplicada)" });
      } catch (err) {
        const started = await prisma.broadcastRecipient.findUnique({ where: { id: recipient.id }, select: { attemptedAt: true } });
        if (isSendDeferred(err)) {
          // WhatsApp desconectado ou revisao por IA fora do ar: NADA saiu e nao e falha desta pessoa. Fica pendente (deferred) e esta clinica para aqui.
          await settle({ status: "deferred", detail: deferralInfo(err).reason, nextAttemptAt: null, ...(started?.attemptedAt ? {} : { attempts: { decrement: 1 } }) });
          console.warn(`[campanha] clinica=${clinic.id} campanha=${campaign.id}: envio adiado (${err instanceof Error ? err.message : "indisponivel"}); destinatarios seguem pendentes`);
          break;
        }
        if (isPermanentSendError(err)) await settle({ status: "failed_permanent", detail: "numero invalido/sem WhatsApp" });
        else if (isAmbiguousSendError(err)) await settle({ status: "unconfirmed", detail: "tempo esgotado no provedor: pode ter chegado; NAO reenviado" });
        else {
          console.error(`Falha ao enviar broadcast para ...${recipient.patient.phone.slice(-4)}:`, err instanceof Error ? err.message : err);
          await settle({ status: exhaust ? "failed_permanent" : "failed", detail: `falha do provedor antes de aceitar: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`, nextAttemptAt: exhaust ? null : retryAt });
        }
      }
      // Pausa aleatoria entre um envio e outro (rajada de dezenas de mensagens iguais e o padrao que o WhatsApp bloqueia).
      if (i < pending.length - 1) await sleep(4000 + Math.random() * 6000);
    }

    const stillPending = await prisma.broadcastRecipient.count({
      where: { campaignId: campaign.id, OR: [{ status: { in: ["pending", "sending", "deferred"] } }, { status: "failed", attempts: { lt: BROADCAST_MAX_ATTEMPTS } }] },
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
