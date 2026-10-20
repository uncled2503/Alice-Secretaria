import { scheduleLocked } from "../jobs/lock.js";
import { prisma } from "../db/client.js";
import { deferralInfo, sendText, isPermanentSendError, isAmbiguousSendError, isConnectionDownError, type SendOutcome } from "../uazapi/client.js";
import { isReviewUnavailable } from "../ai/sendGate.js";
import { getFunnelStages } from "./stages.js";
import { movePatientToKind, movePatientToStage } from "./stageAutomation.js";
import { renderMessageTemplate, getClinicTemplateInfo, type ClinicTemplateInfo } from "./template.js";
import { PAID_CLINIC_WHERE } from "./plan.js";
import { isClosingMessage, isExplicitRefusal } from "./followupGuards.js";
import { judgeConversation, JUDGE_TTL_MS, type JudgeResult } from "./recontactJudge.js";
import { decideTiming, MIN_GAP_BETWEEN_AUTOMATED_MS, ruleThresholdMin, validRecoveryHours, type RecoveryPolicy, type SendCalendar } from "./followupSchedule.js";
import { acquireFlow, competingContact, conversationFingerprint, finishFlow as finishFlowAt, MAX_VETOES, recordFlowDecision as recordFlowDecisionAt, VETO_RETRY_MS, DEFER_RETRY_MS, FAIL_GAP_MS, type DecisionMeta, type FlowKey, type FlowState } from "./followupLedger.js";
import { pruneAutomationRuns, RunRecorder } from "./automationRuns.js";
import { isNonCommercialHandoff, nonCommercialByContext } from "./nonCommercial.js";
import { REVISION } from "../version.js";

export { nextDayAt } from "./followupSchedule.js";

// ---------------------------------------------------------------------------
// RECONTATOS (cascata por silencio). Esta rodada separa, de forma explicavel e auditavel, cinco perguntas que antes se misturavam:
//   1. A PESSOA ENTRA na cascata? (consultas e exclusoes: atendimento humano, pediu para parar, retorno combinado, ja tem horario...)
//   2. QUANDO a etapa vence e quando PODE sair? (followupSchedule.ts: fuso da clinica, expediente, feriado, janela, prazo de recuperacao)
//   3. Alguma OUTRA automacao ja falou com ela? (followupLedger.ts: coordenacao e prioridade)
//   4. A IA (juiz) e a revisao de envio concordam? (veto e TEMPORARIO e reavaliavel; falha tecnica da IA nao e decisao de negocio)
//   5. O que de fato aconteceu no envio? (sent / unconfirmed / blocked / vetoed / failed) - cada desfecho tem tratamento proprio e fica gravado.
// Cada rodada grava um resumo por clinica (AutomationRun) e cada decisao relevante uma linha (FollowUpDispatch): ver crm/automationRuns.ts.
// ---------------------------------------------------------------------------

type RuleRow = Awaited<ReturnType<typeof prisma.followUpRule.findMany>>[number];

const MAX_SENDS_PER_CLINIC = 8; // teto por clinica a cada execucao (15min): o resto fica pra proxima rodada
const HUMAN_RECENT_MS = 2 * 3_600_000; // a equipe (pessoa) falou nesta conversa ha menos disso: o recontato espera
const MAX_JUDGE_CALLS_PER_CLINIC = 25; // teto de consultas a IA por clinica a cada execucao (controla custo)
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface FollowUpDeps {
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
  clinicId?: string; // rodada dirigida a UMA clinica (diagnostico/teste); sem isso, todas as clinicas ativas
}

// Verifica cada conversa aberta e dispara a proxima mensagem da cascata de recontato quando o paciente fica um tempo sem responder
// (silencio contado a partir da ultima mensagem DELE).
let followUpRunning = false;

export async function runFollowUpCheck(deps: FollowUpDeps = {}): Promise<void> {
  if (followUpRunning) return; // rodada anterior (juiz de IA + pausas) ainda em andamento
  followUpRunning = true;
  try {
    await runFollowUpCheckInner(deps);
  } finally {
    followUpRunning = false;
  }
}

async function runFollowUpCheckInner(deps: FollowUpDeps): Promise<void> {
  const now = deps.now ?? new Date();
  const sleep = deps.sleep ?? realSleep;
  const stagesCache = new Map<string, Awaited<ReturnType<typeof getFunnelStages>>>();
  const clinicCache = new Map<string, { calendar: SendCalendar; timezone: string; info: ClinicTemplateInfo; recovery: RecoveryPolicy }>();
  const rulesCache = new Map<string, RuleRow[]>();
  const recorders = new Map<string, RunRecorder>();
  const sentByClinic = new Map<string, number>();
  const judgedByClinic = new Map<string, number>();

  const cachedStages = async (clinicId: string) => {
    let s = stagesCache.get(clinicId);
    if (!s) stagesCache.set(clinicId, (s = await getFunnelStages(clinicId)));
    return s;
  };
  const cachedRules = async (clinicId: string) => {
    let r = rulesCache.get(clinicId);
    if (!r) rulesCache.set(clinicId, (r = await prisma.followUpRule.findMany({ where: { clinicId, active: true }, orderBy: { order: "asc" } })));
    return r;
  };
  const cachedClinic = async (clinicId: string) => {
    let c = clinicCache.get(clinicId);
    if (!c) {
      const clinic = await prisma.clinic.findUniqueOrThrow({
        where: { id: clinicId },
        select: { timezone: true, workDays: true, workStartHour: true, workEndHour: true, hoursByDay: true, closedOnHolidays: true, holidayOpen: true, followupRecoveryHours: true },
      });
      c = { calendar: { ...clinic, timezone: clinic.timezone || "America/Sao_Paulo" }, timezone: clinic.timezone || "America/Sao_Paulo", info: await getClinicTemplateInfo(clinicId), recovery: { recoveryHours: validRecoveryHours(clinic.followupRecoveryHours) ? clinic.followupRecoveryHours : null } };
      clinicCache.set(clinicId, c);
    }
    return c;
  };

  // uma linha de resumo por clinica ativa, MESMO sem candidatas: e o que prova que o job rodou
  const activeClinics = await prisma.clinic.findMany({ where: { ...PAID_CLINIC_WHERE, aliceActive: true, ...(deps.clinicId ? { id: deps.clinicId } : {}) }, select: { id: true } });
  for (const c of activeClinics) recorders.set(c.id, new RunRecorder("recontato", c.id, now));
  const rec = (clinicId: string) => {
    let r = recorders.get(clinicId);
    if (!r) recorders.set(clinicId, (r = new RunRecorder("recontato", clinicId, now)));
    return r;
  };

  // toda gravacao do controle leva o RELOGIO DA RODADA (rodada dirigida/teste com relogio controlado)
  const finishFlow = (id: string, state: FlowState, meta: DecisionMeta = {}) => finishFlowAt(id, state, { ...meta, at: now });
  const recordFlowDecision = (key: FlowKey, state: FlowState, meta: DecisionMeta = {}) => recordFlowDecisionAt(key, state, { ...meta, at: now });

  let failure: unknown = null;
  try {
    const conversations = await loadCandidates(now, deps.clinicId);

    for (const conversation of conversations) {
      const lastPatientMessage = conversation.messages[0];
      if (!lastPatientMessage) continue;
      const clinicId = conversation.patient.clinicId;
      const r = rec(clinicId);
      r.candidates++;
      try {
        await processConversation(conversation, lastPatientMessage, r);
      } catch (err) {
        r.add("falha", "erro_inesperado");
        console.error(`[recontato] erro na conversa ${conversation.id}:`, err instanceof Error ? err.message : err);
      }
    }

    // Transferencias paradas (a Alice nao recontata conversa em atendimento humano): conta para o diagnostico; o aviso a equipe e o relatorio das 20h
    for (const [clinicId, r] of recorders) {
      const stalled = await prisma.conversation.count({
        where: { patient: { clinicId, optedOut: false }, humanTakeover: true, handoffPending: true, staffTouchedAt: null, status: { in: ["active", "qualified", "scheduled"] }, lastMessageAt: { lt: new Date(now.getTime() - 12 * 3_600_000), gt: new Date(now.getTime() - 7 * 24 * 3_600_000) } },
      });
      if (stalled) for (let i = 0; i < stalled; i++) r.add("ignorado", "transferencia_parada_com_a_equipe");
    }
  } catch (err) {
    failure = err;
    console.error("[recontato] a rodada falhou:", err instanceof Error ? err.message : err);
  } finally {
    for (const r of recorders.values()) await r.save(failure ? "erro" : "ok", failure ?? undefined);
    await pruneAutomationRuns(now).catch(() => undefined);
  }
  if (failure) throw failure;

  async function processConversation(conversation: ConvRow, lastPatientMessage: { content: string; createdAt: Date }, r: RunRecorder): Promise<void> {
    const clinicId = conversation.patient.clinicId;
    if (conversation.patient.clinic.importStatus === "running") return void r.add("ignorado", "importando_historico"); // importando historico: nada de disparo
    if (isNonCommercialHandoff(conversation.handoffReason)) return void r.add("ignorado", "contato_nao_comercial"); // curriculo, fornecedor, parceria, cobranca
    const stages = await cachedStages(clinicId);
    const recoveryEligible = new Set(stages.filter((s) => s.kind === "aberta").map((s) => s.stageId));
    if (conversation.patient.funnelStage !== "novo_lead" && !recoveryEligible.has(conversation.patient.funnelStage)) {
      return void r.add("ignorado", "etapa_do_funil_fora_do_recontato"); // ja ganhou, perdeu, ou esta em pos-procedimento - nao e recontato
    }

    const rules = await cachedRules(clinicId);
    if (rules.length === 0) return void r.add("ignorado", "sem_regras_ativas");
    // Proxima etapa = a PRIMEIRA regra ativa com ordem maior que a ultima enviada (antes era exatamente "ultima + 1": uma regra desligada no meio
    // da cascata - ex.: "4 horas" desligada e "1 dia" ligada - travava tudo e depois dava a conversa como perdida).
    const pending = rules.filter((x) => x.order > conversation.lastFollowUpOrder);
    if (pending.length === 0) return void (await closeExhausted(conversation, lastPatientMessage, rules, now, r));

    // Quem ja tem horario (futuro, de hoje ou que acabou de acontecer) NAO e lead sumido: nunca recebe recontato - independente da opcao da regra.
    const active = await prisma.appointment.findFirst({
      where: {
        patientId: conversation.patientId,
        OR: [
          { status: "confirmed", scheduledAt: { gte: new Date(now.getTime() - 24 * 3_600_000) } },
          { status: "completed", scheduledAt: { gte: new Date(now.getTime() - 7 * 24 * 3_600_000) } },
        ],
      },
      select: { id: true },
    });
    if (active) return void r.add("ignorado", "ja_tem_horario");

    // Encerrou o assunto ("ok", "estarei ai", "obrigada"): nao ha o que retomar.
    if (isClosingMessage(lastPatientMessage.content)) return void r.add("ignorado", "encerrou_o_assunto");
    // Recusou o interesse de forma inequivoca: nao ha o que retomar (respeita a decisao dela; adiamento como "vou pensar" continua com o juiz).
    if (isExplicitRefusal(lastPatientMessage.content)) return void r.add("ignorado", "recusou_explicitamente");

    // CONTEXTO nao comercial (candidatura, fornecedor, parceria, cobranca, interesse gravado que e uma vaga de emprego): fora do recontato ANTES de gerar e de enviar
    // (nao depende do revisor nem de a transferencia ter sido gravada).
    const recentUser = await prisma.message.findMany({ where: { conversationId: conversation.id, role: "user" }, orderBy: { createdAt: "desc" }, take: 5, select: { content: true } });
    const nonCommercial = nonCommercialByContext({ interestNote: conversation.patient.interestNote, patientTexts: recentUser.map((m) => m.content), adText: conversation.patient.adName });
    if (nonCommercial) return void r.add("ignorado", `contato_nao_comercial:${nonCommercial}`);

    const clinic = await cachedClinic(clinicId);
    let last = conversation.lastFollowUpOrder;
    for (const rule of pending) {
      if (rule.repeatMode === "once") {
        const already = await prisma.followUpSent.findUnique({ where: { conversationId_ruleId: { conversationId: conversation.id, ruleId: rule.id } } });
        if (already) {
          // ja mandou esse recontato uma vez nessa conversa - so avanca o ponteiro pra cascata seguir pros proximos recontatos.
          if (await movePointer(conversation.id, last, rule.order)) last = rule.order;
          continue;
        }
      }
      const timing = decideTiming(rule, lastPatientMessage.createdAt, now, clinic.calendar, clinic.recovery);
      if (timing.action === "wait") return void r.add("ignorado", `aguardando:${timing.code}`);
      if (timing.action === "expire") {
        // conversa fria: nada gravado (nao reativa mensagem antiga) e a proxima etapa e avaliada. Janela perdida / sem janela: grava e avanca (nao reaparece).
        if (timing.code === "conversa_fria") { r.add("ignorado", "conversa_fria"); continue; }
        await recordFlowDecision(keyOf(conversation, rule, lastPatientMessage.createdAt, timing.dueAt), "expired", {
          layer: "janela", reason: timing.code === "sem_janela" ? "nenhuma janela de envio nos proximos 10 dias" : `a janela de envio passou sem a mensagem sair (prazo ${timing.deadline?.toISOString() ?? "-"})`, temporary: false,
        });
        if (await movePointer(conversation.id, last, rule.order)) last = rule.order;
        r.add("ignorado", `expirado:${timing.code}`);
        continue;
      }
      // timing.action === "send": a etapa venceu e a clinica pode mandar agora
      await attemptSend(conversation, lastPatientMessage, rule, clinic, last, timing.dueAt, r);
      return;
    }
  }

  async function attemptSend(
    conversation: ConvRow,
    lastPatientMessage: { content: string; createdAt: Date },
    rule: RuleRow,
    clinic: { calendar: SendCalendar; timezone: string; info: ClinicTemplateInfo; recovery: RecoveryPolicy },
    last: number,
    dueAt: Date,
    r: RunRecorder,
  ): Promise<void> {
    const clinicId = conversation.patient.clinicId;
    const key = keyOf(conversation, rule, lastPatientMessage.createdAt, dueAt);

    if ((sentByClinic.get(clinicId) ?? 0) >= MAX_SENDS_PER_CLINIC) return void r.add("adiado", "limite_de_envios_por_rodada"); // o resto fica pra proxima execucao

    const lastAny = await prisma.message.findFirst({
      where: { conversationId: conversation.id, role: { in: ["user", "assistant", "human"] } },
      orderBy: { createdAt: "desc" },
      select: { role: true, createdAt: true },
    });
    if (lastAny?.role === "user") return void r.add("ignorado", "pessoa_falou_por_ultimo"); // a bola esta com a clinica, nao e silencio dela

    // A equipe falou com ela ha pouco (pessoa de verdade, nao automacao): nenhum recontato comercial concorrente durante o atendimento humano.
    const humanRecently = await prisma.message.findFirst({
      where: { conversationId: conversation.id, role: "human", createdAt: { gte: new Date(now.getTime() - HUMAN_RECENT_MS), lte: now } },
      select: { id: true },
    });
    if (humanRecently || (conversation.staffTouchedAt && now.getTime() - conversation.staffTouchedAt.getTime() < HUMAN_RECENT_MS && conversation.staffTouchedAt.getTime() <= now.getTime())) return void r.add("ignorado", "equipe_atendendo_recentemente");

    // O texto cita o procedimento, mas ainda nao sabemos qual interessa a este paciente: nao envia (e nem gasta consulta a IA); tenta de novo
    // quando o resumo do CRM descobrir o interesse. Agora FICA REGISTRADO (antes era um `continue` mudo).
    const interest = conversation.patient.interestNote?.split(",")[0]?.trim() || null;
    if (!interest && /[{\[]procedimento[}\]]/i.test(rule.message)) return void r.add("adiado", "texto_usa_procedimento_e_interesse_desconhecido");

    // Outra automacao ja falou com ela? (lembrete, retorno combinado, retomada de avaliacao, outra etapa colada)
    const compete = await competingContact({ patientId: conversation.patientId, flow: "recontato", now, minGapMs: MIN_GAP_BETWEEN_AUTOMATED_MS });
    if (compete) return void r.add("ignorado", `concorrencia:${compete.code}`);

    r.eligible++;
    const fingerprint = await conversationFingerprint(conversation.id, conversation.patientId);
    const got = await acquireFlow(key, fingerprint, now);
    if (!got.ok) {
      if (got.why === "already_handled" || got.why === "exhausted") {
        // ja tratado em outra rodada/copia (ou esgotado): so avanca o ponteiro, sem enviar
        await movePointer(conversation.id, last, rule.order);
        return void r.add(got.why === "exhausted" ? "ignorado" : "ignorado", `${got.why}:${got.state ?? "-"}`);
      }
      return void r.add("adiado", `${got.why}:${got.state ?? "-"}`);
    }

    // Ultima palavra: uma IA le a conversa e decide se o recontato faz sentido. Falha TECNICA da IA nao e decisao de negocio: adia e tenta de novo.
    if ((judgedByClinic.get(clinicId) ?? 0) >= MAX_JUDGE_CALLS_PER_CLINIC) {
      await finishFlow(got.id, "deferred", { layer: "juiz_ia", reason: "limite de consultas a IA por rodada", temporary: true, reevaluateAt: new Date(now.getTime() + DEFER_RETRY_MS), fingerprint });
      return void r.add("adiado", "limite_de_consultas_a_IA_por_rodada");
    }
    judgedByClinic.set(clinicId, (judgedByClinic.get(clinicId) ?? 0) + 1);
    const judged: JudgeResult = await judgeConversation(conversation.id, conversation.patientId, clinic.info.name, { fingerprint, ruleOrder: rule.order, now, clinicId });
    if (judged.kind === "unavailable") {
      await finishFlow(got.id, "deferred", { layer: "juiz_ia", reason: `falha tecnica do juiz de IA (${judged.why}) - nao e decisao de negocio`, temporary: true, reevaluateAt: new Date(now.getTime() + (judged.retryAfterMs ?? DEFER_RETRY_MS)), fingerprint });
      return void r.add("incerto", judged.permanent ? "juiz_de_IA_requisicao_recusada" : "juiz_de_IA_indisponivel");
    }
    if (!judged.verdict.recontact) {
      const final = got.vetoes + 1 >= MAX_VETOES;
      await finishFlow(got.id, "vetoed", { layer: "juiz_ia", reason: `juiz de IA${judged.verdict.category ? ` [${judged.verdict.category}]` : ""}: ${judged.verdict.reason || "sem motivo"}${judged.source === "cache" ? " (veredito em cache, mesmo contexto)" : ""}`, temporary: !final, reevaluateAt: final ? null : new Date(now.getTime() + VETO_RETRY_MS), fingerprint });
      if (final) await movePointer(conversation.id, last, rule.order);
      return void r.add("vetado", final ? "juiz_de_IA_definitivo" : "juiz_de_IA_temporario");
    }

    const text = renderMessageTemplate(rule.message, {
      procedureName: interest,
      patientName: conversation.patient.name,
      patientPhone: conversation.patient.phone,
      clinicName: clinic.info.name,
      locationName: clinic.info.primaryLocation?.name,
      locationAddress: clinic.info.primaryLocation?.fullAddress,
      birthDate: conversation.patient.birthDate,
    });

    // REVALIDACAO IMEDIATAMENTE ANTES do envio: o juiz de IA pode ter demorado e o mundo mudou (a pessoa respondeu, a equipe assumiu, pediu para sair, reservou, combinou retorno).
    const recheck = await recheckBeforeSend(conversation.id, conversation.patientId, lastPatientMessage.createdAt, now);
    if (recheck) {
      if (recheck.definitive) {
        await finishFlow(got.id, "skipped", { layer: "elegibilidade", reason: `${recheck.code}: ${recheck.detail}`, temporary: false, fingerprint });
        r.add("ignorado", `revalidacao:${recheck.code}`);
      } else {
        await finishFlow(got.id, "deferred", { layer: "elegibilidade", reason: `${recheck.code}: ${recheck.detail}`, temporary: true, reevaluateAt: new Date(now.getTime() + DEFER_RETRY_MS), fingerprint });
        r.add("adiado", `revalidacao:${recheck.code}`);
      }
      return;
    }

    // RESERVA atomica no banco ANTES de enviar: se outro processo (ou outra rodada sobreposta, ou o servidor antigo durante uma troca de versao) ja
    // pegou este recontato, o ponteiro nao bate e este aqui nao envia.
    if (!(await movePointer(conversation.id, last, rule.order))) {
      await finishFlow(got.id, "deferred", { layer: "concorrencia", reason: "a conversa mudou durante a rodada (outra rodada ou resposta da pessoa)", temporary: true, reevaluateAt: now, fingerprint });
      return void r.add("adiado", "conversa_mudou_durante_a_rodada");
    }
    const release = () => movePointer(conversation.id, rule.order, last);

    let outcome: SendOutcome;
    try {
      outcome = await sendText(clinicId, conversation.patient.phone, text, { kind: "recontato" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isConnectionDownError(err) || isReviewUnavailable(err)) {
        // WhatsApp desconectado / revisor indisponivel: nada saiu e NAO e decisao de negocio. Adia sem gastar tentativa nem virar veto; a etapa volta quando o servico voltar.
        const d = deferralInfo(err);
        await finishFlow(got.id, "deferred", { layer: d.layer, reason: d.reason, temporary: true, reevaluateAt: new Date(now.getTime() + DEFER_RETRY_MS), fingerprint });
        await release();
        return void r.add("adiado", d.tag);
      }
      console.error(`[recontato] falha ao enviar clinica=${clinicId} conversa=${conversation.id} etapa=${rule.order} revisao=${REVISION.split(":")[0]}:`, msg);
      if (isPermanentSendError(err)) {
        // Numero sem WhatsApp: nao adianta insistir - esta etapa fica consumida.
        await finishFlow(got.id, "failed_permanent", { layer: "envio", reason: `numero recusado pelo provedor: ${msg.slice(0, 100)}` });
        return void r.add("falha", "numero_sem_whatsapp");
      }
      if (isAmbiguousSendError(err)) {
        // O WhatsApp PODE ter entregado: nunca reenvia as cegas. Etapa consumida, estado "nao confirmado".
        await finishFlow(got.id, "unconfirmed", { layer: "envio", reason: "tempo esgotado no provedor: pode ter sido entregue, nao reenviado" });
        return void r.add("incerto", "envio_nao_confirmado");
      }
      // Nao enviou: devolve a reserva pra tentar de novo (com intervalo e teto).
      await finishFlow(got.id, "failed", { layer: "envio", reason: `falha no envio: ${msg.slice(0, 100)}`, temporary: true, reevaluateAt: new Date(now.getTime() + FAIL_GAP_MS) });
      await release();
      return void r.add("falha", "envio_falhou_tentara_de_novo");
    }

    if (outcome === "vetoed") {
      // A revisao por IA da mensagem disse nao. TEMPORARIO: reavalia quando o contexto mudar ou em 6 h; no maximo MAX_VETOES vezes.
      const final = got.vetoes + 1 >= MAX_VETOES;
      await finishFlow(got.id, "vetoed", { layer: "revisao_envio", reason: "revisao por IA barrou a mensagem (motivo no Diario de atividades)", temporary: !final, reevaluateAt: final ? null : new Date(now.getTime() + VETO_RETRY_MS), fingerprint });
      if (!final) await release();
      return void r.add("vetado", final ? "revisao_de_envio_definitivo" : "revisao_de_envio_temporario");
    }
    if (outcome === "blocked") {
      await finishFlow(got.id, "blocked", { layer: "politica", reason: "envio automatico bloqueado para esta clinica (plano gratuito)" });
      return void r.add("ignorado", "envio_bloqueado_pelo_plano");
    }
    if (outcome === "duplicate") {
      await finishFlow(got.id, "duplicate", { layer: "envio", reason: "mensagem identica ja enviada a esta pessoa" });
      return void r.add("ignorado", "mensagem_duplicada");
    }

    // Saiu.
    sentByClinic.set(clinicId, (sentByClinic.get(clinicId) ?? 0) + 1);
    await finishFlow(got.id, "sent", { layer: "envio", reason: `recontato ${rule.order} enviado` });
    r.add("enviado", `etapa_${rule.order}`);
    await prisma.message.create({ data: { conversationId: conversation.id, role: "assistant", content: text, authorName: "Recontato automático" } });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastFollowUpOrder: rule.order } });
    if (rule.repeatMode === "once") {
      await prisma.followUpSent.create({ data: { conversationId: conversation.id, ruleId: rule.id } }).catch(() => undefined); // ja registrado por outra rodada
    }
    // "recuperacao" e o slug padrao pra essa etapa; se a clinica renomeou/removeu esse stageId, so pulamos esse bonus (sem quebrar o envio).
    const stages = await cachedStages(clinicId);
    const recoveryStage = stages.find((s) => s.stageId === "recuperacao");
    const recoveryEligible = new Set(stages.filter((s) => s.kind === "aberta").map((s) => s.stageId));
    if (last === 0 && recoveryStage && recoveryEligible.has(conversation.patient.funnelStage)) {
      // via movePatientToStage: registra a transicao e dispara os eventos de CRM
      await movePatientToStage(clinicId, conversation.patientId, recoveryStage.stageId, { note: "sem resposta no recontato" });
    }
    await sleep(3000 + Math.random() * 5000);
  }
}

// Conversas candidatas ao recontato. So atividade dos ultimos 60 dias (a cascata, silencio + 3 dias de tolerancia, ja se resolveu bem antes disso).
// Alice pausada = sem recontato; quem pediu pra parar OU disse que nao tem interesse nao recebe; quem pediu pra ser chamada numa data futura espera
// essa data (o retorno combinado cuida dela - ver hotLeads.ts); conversa com a equipe (humanTakeover) nao recebe recontato COMERCIAL concorrente.
export async function loadCandidates(now: Date, clinicId?: string) {
  return prisma.conversation.findMany({
    where: {
      status: "active",
      humanTakeover: false,
      lastMessageAt: { gte: new Date(now.getTime() - 60 * 24 * 3_600_000) },
      patient: {
        optedOut: false,
        noInterest: false,
        OR: [{ callbackAt: null }, { callbackAt: { lte: now } }],
        clinic: { ...PAID_CLINIC_WHERE, aliceActive: true },
        ...(clinicId ? { clinicId } : {}),
      },
    },
    include: {
      patient: { include: { clinic: { select: { importStatus: true } } } },
      messages: { where: { role: "user" }, orderBy: { createdAt: "desc" }, take: 1, select: { content: true, createdAt: true } },
    },
  });
}
type ConvRow = Awaited<ReturnType<typeof loadCandidates>>[number];

// Exclusoes que precisam valer NA HORA do envio (le o banco de novo; nada vem da selecao da rodada). definitive = nunca mais para este ciclo.
export interface SendExclusion { code: string; detail: string; definitive: boolean }
export async function recheckBeforeSend(conversationId: string, patientId: string, lastPatientAt: Date, now: Date): Promise<SendExclusion | null> {
  const patient = await prisma.patient.findUnique({ where: { id: patientId }, select: { optedOut: true, noInterest: true, callbackAt: true } });
  if (!patient) return { code: "pessoa_nao_encontrada", detail: "o cadastro nao existe mais", definitive: true };
  if (patient.optedOut) return { code: "pediu_para_nao_receber", detail: "pediu para nao receber mensagens", definitive: true };
  if (patient.noInterest) return { code: "sem_interesse", detail: "disse que nao tem interesse", definitive: true };
  if (patient.callbackAt && patient.callbackAt.getTime() > now.getTime()) return { code: "retorno_combinado", detail: "pediu para ser chamada numa data futura", definitive: false };
  const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { humanTakeover: true, status: true, staffTouchedAt: true } });
  if (!conv || conv.status !== "active") return { code: "conversa_nao_ativa", detail: "a conversa nao esta mais ativa", definitive: false };
  if (conv.humanTakeover) return { code: "atendimento_humano", detail: "a conversa esta com a equipe", definitive: false };
  if (conv.staffTouchedAt && conv.staffTouchedAt.getTime() <= now.getTime() && now.getTime() - conv.staffTouchedAt.getTime() < HUMAN_RECENT_MS) return { code: "equipe_atendendo_recentemente", detail: "a equipe falou com ela ha pouco", definitive: false };
  // a pessoa escreveu DEPOIS da mensagem que originou este recontato (ciclo novo): este recontato nao vale mais
  const answered = await prisma.message.findFirst({ where: { conversationId, role: "user", createdAt: { gt: lastPatientAt, lte: now } }, select: { id: true } });
  if (answered) return { code: "pessoa_respondeu", detail: "a pessoa escreveu depois da mensagem que originou o recontato", definitive: false };
  // a equipe falou ha pouco (pessoa de verdade): espera; fala antiga da equipe nao impede o recontato
  const humanNow = await prisma.message.findFirst({ where: { conversationId, role: "human", createdAt: { gte: new Date(now.getTime() - HUMAN_RECENT_MS), lte: now } }, select: { id: true } });
  if (humanNow) return { code: "equipe_atendendo_recentemente", detail: "a equipe falou com ela ha pouco", definitive: false };
  const active = await prisma.appointment.findFirst({
    where: { patientId, OR: [{ status: "confirmed", scheduledAt: { gte: new Date(now.getTime() - 24 * 3_600_000) } }, { status: "completed", scheduledAt: { gte: new Date(now.getTime() - 7 * 24 * 3_600_000) } }] },
    select: { id: true },
  });
  if (active) return { code: "ja_tem_horario", detail: "tem horario marcado ou atendimento recente", definitive: false };
  return null;
}

// Move o ponteiro da cascata de forma atomica (so se ainda estiver onde esta rodada o leu).
async function movePointer(conversationId: string, from: number, to: number): Promise<boolean> {
  const r = await prisma.conversation.updateMany({ where: { id: conversationId, lastFollowUpOrder: from }, data: { lastFollowUpOrder: to } });
  return r.count === 1;
}

function keyOf(conversation: { id: string; patientId: string; patient: { clinicId: string } }, rule: RuleRow, lastPatientAt: Date, dueAt: Date): FlowKey {
  return {
    clinicId: conversation.patient.clinicId,
    patientId: conversation.patientId,
    conversationId: conversation.id,
    flow: "recontato",
    ruleId: rule.id,
    step: rule.order,
    cycleKey: String(lastPatientAt.getTime()), // novo ciclo de silencio = a pessoa escreveu de novo
    dueAt,
  };
}

// Cascata esgotada. Se o paciente continua em silencio, sem agendamento futuro, e a clinica tem recontatos configurados, marca como perdido e fecha
// a conversa (uma vez). (Regra mantida: e funcao do TEMPO desde a ultima mensagem, nao de ter enviado cada etapa.)
async function closeExhausted(
  conversation: { id: string; patientId: string; patient: { clinicId: string } },
  lastPatientMessage: { createdAt: Date },
  rules: RuleRow[],
  now: Date,
  r: RunRecorder,
): Promise<void> {
  const lastRule = rules[rules.length - 1];
  const graceMin = Math.max(ruleThresholdMin(lastRule), 2 * 1440);
  const silenceMin = (now.getTime() - lastPatientMessage.createdAt.getTime()) / 60_000;
  if (silenceMin < graceMin) return void r.add("ignorado", "cascata_esgotada_aguardando_prazo");
  const upcoming = await prisma.appointment.findFirst({ where: { patientId: conversation.patientId, status: "confirmed", scheduledAt: { gte: now } } });
  if (upcoming) return void r.add("ignorado", "cascata_esgotada_mas_tem_horario");
  await movePatientToKind(conversation.patient.clinicId, conversation.patientId, "perdido", { note: "sem resposta apos toda a cascata de recontato" });
  await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "closed" } });
  r.add("ignorado", "cascata_esgotada_marcado_como_perdido");
}

// Roda a cada 15min - agora que os recontatos podem ter janela em minutos.
export function startFollowUpJob(): void {
  scheduleLocked("recontato", "*/15 * * * *", () => runFollowUpCheck().catch((err) => console.error("Erro no job de recontato:", err)));
}

export { JUDGE_TTL_MS };
