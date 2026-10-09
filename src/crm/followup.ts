import { scheduleLocked } from "../jobs/lock.js";
import { prisma } from "../db/client.js";
import { sendText, isPermanentSendError } from "../uazapi/client.js";
import { getFunnelStages } from "./stages.js";
import { movePatientToKind, movePatientToStage } from "./stageAutomation.js";
import { renderMessageTemplate, getClinicTemplateInfo, type ClinicTemplateInfo } from "./template.js";
import { PAID_CLINIC_WHERE } from "./plan.js";
import { isWithinClinicHours, type OpenHoursClinic } from "./openHours.js";
import { isClosingMessage } from "./followupGuards.js";
import { judgeConversation } from "./recontactJudge.js";

// Cache simples por execucao do job.
const stagesCache = new Map<string, Awaited<ReturnType<typeof getFunnelStages>>>();
const clinicCache = new Map<string, { timezone: string; hours: OpenHoursClinic; info: ClinicTemplateInfo }>();
const rulesCache = new Map<string, Awaited<ReturnType<typeof prisma.followUpRule.findMany>>>();

async function cachedRules(clinicId: string) {
  let rules = rulesCache.get(clinicId);
  if (!rules) {
    rules = await prisma.followUpRule.findMany({
      where: { clinicId, active: true },
      orderBy: { order: "asc" },
    });
    rulesCache.set(clinicId, rules);
  }
  return rules;
}

function ruleThresholdMin(rule: { afterMinutes: number; afterDays: number }): number {
  return rule.afterMinutes > 0 ? rule.afterMinutes : rule.afterDays * 1440;
}

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
    const clinic = await prisma.clinic.findUniqueOrThrow({
      where: { id: clinicId },
      select: { timezone: true, workDays: true, workStartHour: true, workEndHour: true, hoursByDay: true },
    });
    entry = { timezone: clinic.timezone || "America/Sao_Paulo", hours: clinic, info: await getClinicTemplateInfo(clinicId) };
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

// Travas contra disparo em massa (risco de banimento do numero). Incidente:
// ao reconectar o WhatsApp de uma clinica, todas as conversas antigas viraram
// "due" ao mesmo tempo e o recontato foi pra todo mundo de uma vez.
// - MAX_OVERDUE_MS: nunca manda recontato atrasado alem desta tolerancia
//   (silencio passou muito do ponto da regra = conversa fria, nao recontato).
// - MAX_SENDS_PER_CLINIC: teto por clinica a cada execucao (15min).
// - pausa aleatoria entre envios, pra nao parecer rajada.
const MAX_OVERDUE_MS = 3 * 24 * 3_600_000;
const MAX_SENDS_PER_CLINIC = 8;
const MAX_JUDGE_CALLS_PER_CLINIC = 25; // teto de consultas a IA por clinica a cada execucao (controla custo)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Verifica cada conversa aberta e dispara a proxima mensagem da cascata de
// recontato quando o paciente fica um tempo sem responder (silencio contado a
// partir da ultima mensagem DELE).
let followUpRunning = false;

export async function runFollowUpCheck(): Promise<void> {
  if (followUpRunning) return; // rodada anterior (juiz de IA + pausas) ainda em andamento
  followUpRunning = true;
  try {
    await runFollowUpCheckInner();
  } finally {
    followUpRunning = false;
  }
}

async function runFollowUpCheckInner(): Promise<void> {
  stagesCache.clear();
  clinicCache.clear();
  rulesCache.clear();
  const sentByClinic = new Map<string, number>();
  const judgedByClinic = new Map<string, number>();

  const conversations = await prisma.conversation.findMany({
    where: { status: "active", humanTakeover: false, patient: { clinic: { ...PAID_CLINIC_WHERE, aliceActive: true } } }, // Alice pausada = sem recontato
    include: {
      patient: { include: { clinic: { select: { importStatus: true } } } },
      messages: { where: { role: "user" }, orderBy: { createdAt: "desc" }, take: 1, select: { content: true, createdAt: true } },
    },
  });

  for (const conversation of conversations) {
    const lastPatientMessage = conversation.messages[0];
    if (!lastPatientMessage) continue;

    const clinicId = conversation.patient.clinicId;
    if (conversation.patient.clinic.importStatus === "running") continue; // importando historico: nada de disparo
    const stages = await cachedStages(clinicId);
    const recoveryEligible = new Set(stages.filter((s) => s.kind === "aberta").map((s) => s.stageId));

    if (
      conversation.patient.funnelStage !== "novo_lead" &&
      !recoveryEligible.has(conversation.patient.funnelStage)
    ) {
      continue; // ja ganhou, perdeu, ou esta em pos-procedimento - nao e recontato
    }

    const rules = await cachedRules(clinicId);
    const nextOrder = conversation.lastFollowUpOrder + 1;
    const rule = rules.find((r) => r.order === nextOrder);
    if (!rule) {
      // Cascata esgotada. Se o paciente continua em silencio, sem agendamento
      // futuro, e a clinica tem recontatos configurados, marca como perdido e
      // fecha a conversa (uma vez).
      if (rules.length === 0) continue;
      const lastRule = rules[rules.length - 1];
      const graceMin = Math.max(ruleThresholdMin(lastRule), 2 * 1440);
      const silenceMin = (Date.now() - lastPatientMessage.createdAt.getTime()) / 60_000;
      if (silenceMin < graceMin) continue;

      const upcoming = await prisma.appointment.findFirst({
        where: { patientId: conversation.patientId, status: "confirmed", scheduledAt: { gte: new Date() } },
      });
      if (upcoming) continue;

      await movePatientToKind(clinicId, conversation.patientId, "perdido", {
        note: "sem resposta apos toda a cascata de recontato",
      });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "closed" } });
      continue;
    }

    // Quem ja tem horario (futuro, de hoje ou que acabou de acontecer) NAO e lead
    // sumido: nunca recebe recontato - independente da opcao da regra.
    const active = await prisma.appointment.findFirst({
      where: {
        patientId: conversation.patientId,
        OR: [
          { status: "confirmed", scheduledAt: { gte: new Date(Date.now() - 24 * 3_600_000) } },
          { status: "completed", scheduledAt: { gte: new Date(Date.now() - 7 * 24 * 3_600_000) } },
        ],
      },
      select: { id: true },
    });
    if (active) continue;

    // Encerrou o assunto ("ok", "estarei ai", "obrigada"): nao ha o que retomar.
    if (isClosingMessage(lastPatientMessage.content)) continue;

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
    if (silenceMin - thresholdMin > MAX_OVERDUE_MS / 60_000) continue; // conversa fria demais, nao recontata

    if ((sentByClinic.get(clinicId) ?? 0) >= MAX_SENDS_PER_CLINIC) continue; // o resto fica pra proxima execucao

    const clinic = await cachedClinic(clinicId);
    // So manda dentro do expediente da clinica (dias e horarios de atendimento).
    if (!isWithinClinicHours(clinic.hours, new Date())) continue;
    if (!withinWindow(localHour(clinic.timezone), rule.sendWindowStart, rule.sendWindowEnd)) continue;

    const lastAny = await prisma.message.findFirst({
      where: { conversationId: conversation.id, role: { in: ["user", "assistant", "human"] } },
      orderBy: { createdAt: "desc" },
      select: { role: true },
    });
    if (lastAny?.role === "user") continue; // o paciente falou por ultimo: a bola esta com a clinica, nao e silencio dele

    // O texto cita o procedimento, mas ainda nao sabemos qual interessa a este paciente: nao envia
    // (e nem gasta consulta a IA); tenta de novo quando o resumo do CRM descobrir o interesse.
    const interest = conversation.patient.interestNote?.split(",")[0]?.trim() || null;
    if (!interest && /[{\[]procedimento[}\]]/i.test(rule.message)) continue;

    // Ultima palavra: uma IA le a conversa e decide se o recontato faz sentido.
    // Falha da IA = nao envia (e tenta de novo no proximo ciclo).
    if ((judgedByClinic.get(clinicId) ?? 0) >= MAX_JUDGE_CALLS_PER_CLINIC) continue;
    judgedByClinic.set(clinicId, (judgedByClinic.get(clinicId) ?? 0) + 1);
    const verdict = await judgeConversation(conversation.id, conversation.patientId, clinic.info.name);
    if (!verdict || !verdict.recontact) continue;

    const text = renderMessageTemplate(rule.message, {
      procedureName: interest,
      patientName: conversation.patient.name,
      patientPhone: conversation.patient.phone,
      clinicName: clinic.info.name,
      locationName: clinic.info.primaryLocation?.name,
      locationAddress: clinic.info.primaryLocation?.fullAddress,
      birthDate: conversation.patient.birthDate,
    });

    // RESERVA atomica no banco ANTES de enviar: se outro processo (ou outra rodada
    // sobreposta, ou o servidor antigo durante uma troca de versao) ja pegou este
    // recontato, o contador nao bate e este aqui nao envia.
    const claimed = await prisma.conversation.updateMany({
      where: { id: conversation.id, lastFollowUpOrder: conversation.lastFollowUpOrder },
      data: { lastFollowUpOrder: nextOrder },
    });
    if (claimed.count !== 1) continue;

    try {
      await sendText(clinicId, conversation.patient.phone, text);
    } catch (err) {
      console.error(`Falha ao enviar recontato para ${conversation.patient.phone}:`, err);
      // Numero sem WhatsApp: nao adianta insistir - mantem a reserva (este recontato fica pulado).
      if (isPermanentSendError(err)) continue;
      // Nao enviou: devolve a reserva pra tentar de novo no proximo ciclo.
      await prisma.conversation.updateMany({ where: { id: conversation.id, lastFollowUpOrder: nextOrder }, data: { lastFollowUpOrder: conversation.lastFollowUpOrder } });
      continue;
    }

    sentByClinic.set(clinicId, (sentByClinic.get(clinicId) ?? 0) + 1);
    await prisma.message.create({
      data: { conversationId: conversation.id, role: "assistant", content: text, authorName: "Recontato automático" },
    });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastFollowUpOrder: nextOrder },
    });
    if (rule.repeatMode === "once") {
      await prisma.followUpSent.create({ data: { conversationId: conversation.id, ruleId: rule.id } }).catch(() => undefined); // ja registrado por outra rodada
    }

    // "recuperacao" e o slug padrao pra essa etapa; se a clinica renomeou/
    // removeu esse stageId, so pulamos esse bonus (sem quebrar o envio).
    const recoveryStage = stages.find((s) => s.stageId === "recuperacao");
    if (nextOrder === 1 && recoveryStage && recoveryEligible.has(conversation.patient.funnelStage)) {
      // via movePatientToStage: registra a transicao e dispara os eventos de CRM
      await movePatientToStage(clinicId, conversation.patientId, recoveryStage.stageId, {
        note: "sem resposta no recontato",
      });
    }
    await sleep(3000 + Math.random() * 5000);
  }
}

// Roda a cada 15min - agora que os recontatos podem ter janela em minutos.
export function startFollowUpJob(): void {
  scheduleLocked("recontato", "*/15 * * * *", () => {
    runFollowUpCheck().catch((err) => console.error("Erro no job de recontato:", err));
  });
}
