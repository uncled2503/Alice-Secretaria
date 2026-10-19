import { scheduleLocked } from "../jobs/lock.js";
import { prisma } from "../db/client.js";
import { deferralInfo, sendText, isPermanentSendError, isAmbiguousSendError, isConnectionDownError, type SendOutcome } from "../uazapi/client.js";
import { logActivity } from "../crm/activity.js";
import { notifyStaff } from "../crm/notify.js";
import { recordAutomatedMessage } from "../crm/conversationLog.js";
import { getClinicTemplateInfo } from "../crm/template.js";
import { PAID_CLINIC_WHERE } from "../crm/plan.js";
import { openAt, type SendCalendar } from "../crm/followupSchedule.js";
import { acquireFlow, finishFlow as finishFlowAt, MAX_VETOES, VETO_RETRY_MS, DEFER_RETRY_MS, FAIL_GAP_MS, type DecisionMeta, type FlowKey, type FlowState } from "../crm/followupLedger.js";
import { RunRecorder } from "../crm/automationRuns.js";
import { REVISION } from "../version.js";
import { usableFirstName } from "../crm/greeting.js";
import { isReviewUnavailable } from "../ai/sendGate.js";
import { reviewLinkState, validateReferralText, type ReviewLinkState } from "./reviewLink.js";
import { checkResumeSend, modeOf, readRestriction, testSendsSoFar } from "../crm/resumeGuard.js";
import { scoreBand, type ScoreBand } from "./surveyReply.js";

// ---------------------------------------------------------------------------
// PESQUISA DE SATISFACAO -> NOTA -> AGRADECIMENTO (+ LINK DO GOOGLE) -> CONVITE DE INDICACAO, em etapas CONTROLADAS (17-18/10/2026, Lisboa).
//   1. a PESQUISA sai no maximo 1 vez a cada 15 dias por paciente (janela movel, ver `frequencyVerdict`);
//   2. a NOTA e lida pelo codigo (reminders/surveyReply.ts) e gravada de forma atomica e idempotente (`recordSurveyAnswer`);
//   3. o AGRADECIMENTO (e o link do Google, so se confirmado) e a resposta da Alice a nota; nota alta COM reclamacao nao ganha link nem indicacao;
//   4. o CONVITE DE INDICACAO e uma mensagem SEPARADA, enviada depois por um job (`runReferralSteps`) com controle persistente: so se a etapa anterior
//      foi entregue, a pessoa nao esta numa conversa ativa nem reclamou, a equipe nao esta falando com ela e a clinica configurou texto e intervalo.
// ---------------------------------------------------------------------------

export const SURVEY_MIN_DAYS = 15;
const DAY_MS = 24 * 3_600_000;
export const SURVEY_AUTHOR = "Pesquisa de satisfação";
export const REFERRAL_AUTHOR = "Pesquisa de satisfação (indicação)"; // o nome casa com "pesquisa": responder "obrigada" a ele so agradece (situation.ts)
export const PENDING_WINDOW_DAYS = 7;
export const REFERRAL_COOLDOWN_DAYS = 90;
export const REFERRAL_QUIET_MS = 30 * 60_000; // nao interrompe conversa ativa: espera a conversa ficar quieta por 30 min
export const REFERRAL_GIVE_UP_MS = 24 * 3_600_000; // se nao deu pra enviar em 24h depois do previsto, desiste (contexto velho)

// ---------------------------------------------------------------------------
// FREQUENCIA (puro). Janela MOVEL: a proxima pesquisa so pode sair quando passaram 15 dias INTEIROS (15 x 24h) desde a ULTIMA que saiu para a mesma
// pessoa. No instante exato dos 15 dias ja pode (>=); 1 minuto antes, nao. Vale entre procedimentos, profissionais e reservas (a chave e a PESSOA).
// ---------------------------------------------------------------------------
export function frequencyVerdict(lastAskedAt: Date | null, now: Date, minDays = SURVEY_MIN_DAYS): { allowed: boolean; nextEligibleAt: Date | null } {
  if (!lastAskedAt) return { allowed: true, nextEligibleAt: null };
  const next = new Date(lastAskedAt.getTime() + minDays * DAY_MS);
  return { allowed: now.getTime() >= next.getTime(), nextEligibleAt: next };
}

// Identidade: a pessoa e a linha de Patient (clinica + telefone) e, quando ha mais de uma linha com o MESMO vinculo do Clinica Experts (ceUuid), elas sao a
// mesma pessoa. Nunca se une por telefone parecido. `ambiguous` = o vinculo junta mais de uma linha (o diagnostico mostra).
export async function identityPatientIds(clinicId: string, patientId: string): Promise<{ ids: string[]; ambiguous: boolean }> {
  const p = await prisma.patient.findFirst({ where: { id: patientId, clinicId }, select: { id: true, ceUuid: true } });
  if (!p) return { ids: [patientId], ambiguous: false };
  if (!p.ceUuid) return { ids: [p.id], ambiguous: false };
  const same = await prisma.patient.findMany({ where: { clinicId, ceUuid: p.ceUuid }, select: { id: true } });
  const ids = [...new Set([p.id, ...same.map((x) => x.id)])];
  return { ids, ambiguous: ids.length > 1 };
}

// Quando saiu a ULTIMA pesquisa para esta pessoa (pesquisa registrada OU tentativa que pode ter saido: reservada/enviada/sem confirmacao no controle).
export async function lastSurveyAskedAt(clinicId: string, patientIds: string[]): Promise<Date | null> {
  const [survey, ledger] = await Promise.all([
    prisma.satisfactionSurvey.findFirst({ where: { clinicId, patientId: { in: patientIds } }, orderBy: { askedAt: "desc" }, select: { askedAt: true } }),
    prisma.followUpDispatch.findFirst({ where: { clinicId, patientId: { in: patientIds }, flow: "pesquisa", state: { in: ["reserved", "sent", "unconfirmed"] } }, orderBy: { decidedAt: "desc" }, select: { decidedAt: true } }),
  ]);
  const times = [survey?.askedAt, ledger?.decidedAt].filter((d): d is Date => !!d).map((d) => d.getTime());
  return times.length ? new Date(Math.max(...times)) : null;
}

// ---------------------------------------------------------------------------
// GRAVAR A NOTA (atomico, idempotente) E MONTAR O AGRADECIMENTO
// ---------------------------------------------------------------------------
const firstName = (n: string | null | undefined) => usableFirstName(n);

export interface AnswerResult {
  ok: true;
  surveyId: string;
  band: ScoreBand;
  complaint: boolean;
  linkState: "enviado" | "pendente_confirmacao" | "ausente" | "invalido" | "nao_aplicavel" | "atendimento_humano";
  referralScheduled: boolean;
  reply: string; // o agradecimento (texto fixo do sistema)
  repeated: boolean; // a mesma mensagem ja tinha sido gravada: nada novo foi feito, so o texto de novo
}

export type AnswerFailure = { ok: false; motivo: "sem_pesquisa_pendente" | "ja_respondida" | "nota_invalida" };

// O texto que a Alice manda ao receber a nota. Frases FIXAS (casam com fixedReplies.ts: nao gastam IA nem podem ser reescritas pela revisao).
export function thankYouText(p: { name: string | null; band: ScoreBand; complaint: boolean; link: ReviewLinkState }): string {
  const nome = firstName(p.name);
  const greet = nome ? `, ${nome}` : "";
  if (p.band === "baixa") {
    return `Obrigada pela sinceridade${greet}! 💗 Sinto muito que a experiência não tenha sido a que você esperava. Vou passar o seu retorno para a nossa equipe cuidar disso com atenção. Se quiser, me conta o que podemos melhorar.`;
  }
  if (p.complaint) {
    return `Obrigada pelo retorno${greet}! 💗 Agradeço o carinho e também por contar do problema: vou passar para a nossa equipe cuidar disso com atenção.`;
  }
  if (p.band === "neutra") return `Obrigada pelo retorno${greet}! 💗 Sua opinião ajuda a gente a melhorar sempre.`;
  // positiva, sem reclamacao
  if (p.link.send) {
    return `Que bom saber${greet}! 💗 Ficamos muito felizes com a sua nota. Se puder, deixa a sua avaliação no Google, ajuda muito a gente: ${p.link.url}`;
  }
  return `Que bom saber${greet}! 💗 Ficamos muito felizes com a sua nota. Obrigada pelo carinho!`;
}

export async function recordSurveyAnswer(p: {
  clinicId: string;
  patientId: string;
  score: number;
  comment: string | null;
  complaint: boolean;
  messageId?: string | null; // id da mensagem da pessoa que trouxe a nota (idempotencia)
  // A conversa esta com a EQUIPE (atendimento humano): a nota e REGISTRADA (ela e da pessoa e esta ligada a uma pesquisa), mas a Alice NAO responde, NAO manda link do Google
  // e NAO agenda convite de indicacao - nem agora, nem depois que a pausa acabar (a mensagem perderia a pertinencia). A equipe e avisada nos casos que pedem retorno.
  humanOwned?: boolean;
  now?: Date;
}): Promise<AnswerResult | AnswerFailure> {
  const now = p.now ?? new Date();
  const score = Math.round(p.score);
  if (!Number.isFinite(score) || score < 0 || score > 10) return { ok: false, motivo: "nota_invalida" };

  const clinic = await prisma.clinic.findUniqueOrThrow({
    where: { id: p.clinicId },
    select: { npsThreshold: true, googleReviewUrl: true, googleReviewConfirmedAt: true, googleReviewPlace: true, googleReviewLegacyAllowed: true, name: true },
  });
  const patient = await prisma.patient.findUnique({ where: { id: p.patientId }, select: { id: true, name: true, phone: true } });
  const link = reviewLinkState(clinic);
  const band = scoreBand(score, clinic.npsThreshold);

  // Mesma mensagem ja gravada (webhook reentregue, rodada refeita): nao grava de novo, nao avisa a equipe de novo; devolve o mesmo agradecimento.
  if (p.messageId) {
    const done = await prisma.satisfactionSurvey.findFirst({ where: { clinicId: p.clinicId, patientId: p.patientId, answeredByMessageId: p.messageId } });
    if (done && done.score != null) {
      const b = scoreBand(done.score, clinic.npsThreshold);
      const complaint = done.hasComplaint;
      const sentLink = done.linkState === "enviado" ? link : ({ send: false, reason: "ausente", detail: "" } as ReviewLinkState);
      return { ok: true, surveyId: done.id, band: b, complaint, linkState: (done.linkState as AnswerResult["linkState"]) ?? "nao_aplicavel", referralScheduled: false, reply: thankYouText({ name: patient?.name ?? null, band: b, complaint, link: sentLink }), repeated: true };
    }
  }

  const survey = await prisma.satisfactionSurvey.findFirst({
    where: { clinicId: p.clinicId, patientId: p.patientId, answeredAt: null, askedAt: { gte: new Date(now.getTime() - PENDING_WINDOW_DAYS * DAY_MS) } },
    orderBy: { askedAt: "desc" },
  });
  if (!survey) return { ok: false, motivo: "sem_pesquisa_pendente" };

  const humanOwned = p.humanOwned === true;
  const wantsLink = band === "positiva" && !p.complaint;
  const linkState: AnswerResult["linkState"] = humanOwned ? "atendimento_humano" : !wantsLink ? "nao_aplicavel" : link.send ? "enviado" : link.reason === "ausente" ? "ausente" : link.reason === "invalido" ? "invalido" : "pendente_confirmacao";

  // GRAVACAO ATOMICA: so uma chamada vence a disputa (duas mensagens, dois jobs, a ferramenta e o tratamento direto ao mesmo tempo).
  const won = await prisma.satisfactionSurvey.updateMany({
    where: { id: survey.id, answeredAt: null },
    data: {
      score,
      comment: p.comment ? p.comment.slice(0, 500) : null,
      answeredAt: now,
      answeredByMessageId: p.messageId ?? null,
      band,
      hasComplaint: p.complaint,
      linkState,
      reviewLinkSent: linkState === "enviado",
    },
  });
  if (won.count !== 1) return { ok: false, motivo: "ja_respondida" };

  const who = patient?.name?.trim() || patient?.phone || "Paciente";
  await logActivity({
    clinicId: p.clinicId, patientId: p.patientId, type: "satisfaction_recorded", area: "atendimento",
    title: "Pesquisa de satisfação respondida",
    description: `${who} deu nota ${score}${p.comment ? `: "${p.comment.slice(0, 200)}"` : "."}${p.complaint ? " (com reclamação: sem link do Google nem convite de indicação)" : ""}${humanOwned ? " Registrada enquanto a conversa estava com a equipe: a Alice não respondeu nem mandou link do Google ou convite de indicação." : ""}`,
    actorName: null,
  }).catch(() => undefined);

  if (band === "baixa") {
    await notifyStaff(p.clinicId, "human_handoff", `Avaliação baixa (${score}/10): ${who}${p.comment ? ` — "${p.comment.slice(0, 200)}"` : ""}. Vale um retorno da equipe.`).catch(() => undefined);
  } else if (p.complaint) {
    await notifyStaff(p.clinicId, "human_handoff", `Nota ${score}/10 com reclamação: ${who}${p.comment ? ` — "${p.comment.slice(0, 200)}"` : ""}. A Alice NÃO mandou o link do Google nem o convite de indicação. Vale um retorno da equipe.`).catch(() => undefined);
  } else if (humanOwned) {
    // nota normal/alta com a conversa na mao da equipe: ja ficou no diario; nao ha pendencia de link (a Alice nao ia mandar nada)
  } else if (wantsLink && !link.send) {
    // nota alta, mas o link do Google nao pode ir: agradece normalmente e deixa a PENDENCIA para a equipe (uma vez por dia por clinica)
    await logActivity({ clinicId: p.clinicId, patientId: p.patientId, type: "google_review_pending", area: "automacoes", title: "Nota alta sem link do Google", description: `Nota ${score}: o link não foi enviado (${linkState}). ${link.detail}`, actorName: null }).catch(() => undefined);
    const recent = await prisma.activityLog.count({ where: { clinicId: p.clinicId, type: "google_review_pending", createdAt: { gte: new Date(now.getTime() - DAY_MS) } } });
    if (recent <= 1) await notifyStaff(p.clinicId, "automation_failed", `⚠️ Recebi uma nota alta (${score}/10) de ${who}, mas NÃO enviei o link de avaliação do Google: ${link.detail}. Confirme o link correto da clínica em Configurações.`).catch(() => undefined);
  }

  const referralScheduled = !humanOwned && wantsLink && link.send ? await scheduleReferral(p.clinicId, p.patientId, survey.id, now) : false;
  return { ok: true, surveyId: survey.id, band, complaint: p.complaint, linkState, referralScheduled, reply: thankYouText({ name: patient?.name ?? null, band, complaint: p.complaint, link }), repeated: false };
}

// Agenda o convite de indicacao (se a clinica configurou texto E intervalo: sem politica definida, fica desligado). Uma linha por pesquisa (indice unico).
async function scheduleReferral(clinicId: string, patientId: string, surveyId: string, now: Date): Promise<boolean> {
  const cfg = await prisma.resumeFlowConfig.findUnique({ where: { clinicId_flow: { clinicId, flow: "indicacao" } } });
  if (!cfg?.enabled || !cfg.message?.trim() || cfg.delayMinutes == null) return false;
  if (!validateReferralText(cfg.message).ok) return false;
  try {
    await prisma.followUpDispatch.create({
      data: {
        clinicId, patientId, conversationId: null, flow: "indicacao", ruleId: null, step: 1, cycleKey: surveyId,
        dueAt: new Date(now.getTime() + cfg.delayMinutes * 60_000), state: "deferred", attempt: 0, layer: "politica",
        reason: `convite agendado para ${cfg.delayMinutes} min depois da nota`, temporary: true, reevaluateAt: new Date(now.getTime() + cfg.delayMinutes * 60_000), decidedAt: now, version: REVISION.split(":")[0],
      },
    });
    return true;
  } catch (e) {
    if ((e as { code?: string } | null)?.code === "P2002") return true; // ja agendado por outra chamada
    throw e;
  }
}

// ---------------------------------------------------------------------------
// ETAPA 2 (SEPARADA): O CONVITE DE INDICACAO
// ---------------------------------------------------------------------------
export interface ReferralDeps {
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
  clinicId?: string;
}
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const COMPLAINT_AFTER = /\b(mas|porem|problema|reclam\w*|ruim|pessim\w*|decepcion\w*|doeu|queim\w*|manch\w*|alergi\w*|inch\w*|piorou|nao gostei|nao curti)\b/;
const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

let referralRunning = false;
export async function runReferralSteps(deps: ReferralDeps = {}): Promise<void> {
  if (referralRunning) return;
  referralRunning = true;
  try {
    const now = deps.now ?? new Date();
    const sleep = deps.sleep ?? realSleep;
    const clinics = await prisma.clinic.findMany({ where: { ...PAID_CLINIC_WHERE, active: true, aliceActive: true, ...(deps.clinicId ? { id: deps.clinicId } : {}) }, select: { id: true } });
    for (const c of clinics) await runReferralForClinic(c.id, now, sleep);
  } finally {
    referralRunning = false;
  }
}

async function runReferralForClinic(clinicId: string, now: Date, sleep: (ms: number) => Promise<void>): Promise<void> {
  const cfg = await prisma.resumeFlowConfig.findUnique({ where: { clinicId_flow: { clinicId, flow: "indicacao" } } });
  if (!cfg) return;
  const rec = new RunRecorder("convite-indicacao", clinicId, now);
  const restriction = readRestriction({ runMode: cfg.runMode, testPatientIds: cfg.testPatientIds, testMaxSends: cfg.testMaxSends, testStartedAt: cfg.testStartedAt });
  const runMode = modeOf(restriction);
  rec.mode = runMode;
  const finish = (id: string, state: FlowState, meta: DecisionMeta = {}) => finishFlowAt(id, state, { ...meta, at: now, runMode });
  let failure: unknown = null;
  try {
    if (!cfg.enabled || !cfg.message?.trim() || cfg.delayMinutes == null) { rec.add("ignorado", "fluxo_desligado_ou_sem_politica"); return; }
    if (!validateReferralText(cfg.message).ok) { rec.add("ignorado", "texto_do_convite_invalido"); return; }
    // modo restrito: configuracao invalida bloqueia tudo; valida => so os contatos de teste, ate o limite do teste
    if (restriction.mode === "restrito" && !restriction.valid) { rec.add("ignorado", "modo_restrito_invalido"); return; }
    let testBudget = Infinity;
    if (restriction.mode === "restrito" && restriction.valid) {
      testBudget = Math.max(0, restriction.maxSends - (await testSendsSoFar(clinicId, "indicacao", restriction.startedAt, true)));
      if (testBudget === 0) { rec.add("ignorado", "limite_do_teste_atingido"); return; }
    }
    const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { timezone: true, workDays: true, workStartHour: true, workEndHour: true, hoursByDay: true, closedOnHolidays: true, holidayOpen: true, name: true } });
    const cal: SendCalendar = { ...clinic, timezone: clinic.timezone || "America/Sao_Paulo" };
    const info = await getClinicTemplateInfo(clinicId);

    const rows = await prisma.followUpDispatch.findMany({
      where: { clinicId, flow: "indicacao", state: { in: ["deferred", "vetoed", "failed"] }, ...(restriction.mode === "restrito" && restriction.valid ? { patientId: { in: restriction.patientIds } } : {}) },
      orderBy: { dueAt: "asc" },
      take: 50,
    });
    rec.candidates = rows.length;
    for (const row of rows) {
      if (row.dueAt && now.getTime() < row.dueAt.getTime()) { rec.add("ignorado", "ainda_nao_e_a_hora"); continue; }
      if (row.dueAt && now.getTime() - row.dueAt.getTime() > REFERRAL_GIVE_UP_MS) {
        await finish(row.id, "expired", { layer: "janela", reason: "passou mais de 24h do horario previsto: nao envia convite com contexto velho" });
        rec.add("ignorado", "expirado"); continue;
      }
      const patient = await prisma.patient.findUnique({ where: { id: row.patientId } });
      const survey = await prisma.satisfactionSurvey.findUnique({ where: { id: row.cycleKey } });
      if (!patient || !survey?.answeredAt) { await finish(row.id, "skipped", { layer: "elegibilidade", reason: "pesquisa ou pessoa nao encontrada" }); rec.add("ignorado", "pesquisa_nao_encontrada"); continue; }

      // exclusoes DEFINITIVAS
      if (patient.optedOut || patient.noInterest) { await finish(row.id, "skipped", { layer: "elegibilidade", reason: "pediu para nao receber mensagens / sem interesse" }); rec.add("ignorado", "optou_por_sair"); continue; }
      if (survey.hasComplaint || (survey.score != null && survey.score <= 6)) { await finish(row.id, "skipped", { layer: "elegibilidade", reason: "nota baixa ou com reclamacao: sem convite" }); rec.add("ignorado", "nota_baixa_ou_reclamacao"); continue; }
      const prior = await prisma.followUpDispatch.findFirst({ where: { patientId: patient.id, flow: "indicacao", state: { in: ["sent", "unconfirmed"] }, decidedAt: { gte: new Date(now.getTime() - REFERRAL_COOLDOWN_DAYS * DAY_MS) } }, select: { id: true } });
      if (prior) { await finish(row.id, "skipped", { layer: "elegibilidade", reason: `convite de indicacao ja enviado nos ultimos ${REFERRAL_COOLDOWN_DAYS} dias` }); rec.add("ignorado", "convite_recente"); continue; }

      // a etapa anterior (o agradecimento) foi ENTREGUE? (falha definitiva = nao convida; ainda em andamento = espera)
      const conv = await prisma.conversation.findFirst({ where: { patientId: patient.id }, orderBy: { lastMessageAt: "desc" }, select: { id: true, humanTakeover: true, staffTouchedAt: true } });
      if (!conv) { await finish(row.id, "skipped", { layer: "elegibilidade", reason: "sem conversa" }); rec.add("ignorado", "sem_conversa"); continue; }
      const thanks = await prisma.message.findFirst({ where: { conversationId: conv.id, role: "assistant", authorName: null, createdAt: { gte: survey.answeredAt } }, orderBy: { createdAt: "asc" }, select: { deliveryStatus: true } });
      if (!thanks) { rec.add("adiado", "agradecimento_ainda_nao_gravado"); continue; }
      if (thanks.deliveryStatus && ["failed_permanent", "blocked", "vetoed", "expired"].includes(thanks.deliveryStatus)) {
        await finish(row.id, "skipped", { layer: "elegibilidade", reason: `o agradecimento nao foi entregue (${thanks.deliveryStatus}): a etapa seguinte nao acontece` });
        rec.add("ignorado", "agradecimento_nao_entregue"); continue;
      }
      if (thanks.deliveryStatus && ["pending", "sending", "failed"].includes(thanks.deliveryStatus)) { rec.add("adiado", "agradecimento_em_entrega"); continue; }

      // o que a pessoa escreveu DEPOIS do agradecimento
      const since = await prisma.message.findMany({ where: { conversationId: conv.id, role: { in: ["user", "human"] }, createdAt: { gte: survey.answeredAt } }, orderBy: { createdAt: "asc" }, select: { role: true, content: true, createdAt: true } });
      if (since.some((m) => m.role === "user" && COMPLAINT_AFTER.test(fold(m.content)))) { await finish(row.id, "skipped", { layer: "elegibilidade", reason: "a pessoa reclamou depois da nota" }); rec.add("ignorado", "reclamou_depois"); continue; }

      // exclusoes TEMPORARIAS (espera)
      if (conv.humanTakeover || since.some((m) => m.role === "human" && now.getTime() - m.createdAt.getTime() < 2 * 3_600_000)) { rec.add("adiado", "atendimento_humano"); continue; }
      const lastAny = await prisma.message.findFirst({ where: { conversationId: conv.id, role: { in: ["user", "assistant", "human"] } }, orderBy: { createdAt: "desc" }, select: { createdAt: true, role: true, authorName: true } });
      if (lastAny && now.getTime() - lastAny.createdAt.getTime() < REFERRAL_QUIET_MS) { rec.add("adiado", "conversa_ativa"); continue; }
      const open = openAt({ sendWindowStart: cfg.startHour, sendWindowEnd: cfg.endHour }, cal, now);
      if (!open.open) { rec.add("adiado", `fora_da_janela:${open.reason}`); continue; }

      const fingerprint = `${since.length}|${lastAny?.createdAt.getTime() ?? 0}`;
      const key: FlowKey = { clinicId, patientId: patient.id, conversationId: conv.id, flow: "indicacao", ruleId: null, step: 1, cycleKey: row.cycleKey, dueAt: row.dueAt };
      rec.eligible++;
      if (testBudget <= 0) { rec.add("ignorado", "limite_do_teste_atingido"); continue; }
      const got = await acquireFlow(key, fingerprint, now, runMode);
      if (!got.ok) { rec.add(got.why === "already_handled" || got.why === "exhausted" ? "ignorado" : "adiado", `${got.why}:${got.state ?? "-"}`); continue; }
      // revalidacao imediatamente antes do envio (configuracao lida de novo do banco)
      const permit = await checkResumeSend(clinicId, ["indicacao"], { patientId: patient.id, phone: patient.phone }, { countReserved: false });
      if (!permit.allowed) {
        await finish(got.id, "deferred", { layer: "politica", reason: `modo ${permit.mode}: ${permit.code}`, temporary: true, reevaluateAt: new Date(now.getTime() + DEFER_RETRY_MS), fingerprint });
        rec.add("adiado", `modo_restrito:${permit.code}`); continue;
      }

      const text = cfg.message.replace(/\{primeiro_nome\}|\{nome\}/gi, firstName(patient.name)).replace(/\{unidade\}/gi, info.primaryLocation?.name || info.name).replace(/\{clinica\}/gi, info.name).replace(/\s+,/g, ",").trim();
      let outcome: SendOutcome;
      try {
        outcome = await sendText(clinicId, patient.phone, text, { kind: "indicacao", flow: "indicacao" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isConnectionDownError(err) || isReviewUnavailable(err)) { const d = deferralInfo(err); await finish(got.id, "deferred", { layer: d.layer, reason: d.reason, temporary: true, reevaluateAt: new Date(now.getTime() + DEFER_RETRY_MS), fingerprint }); rec.add("adiado", d.tag); }
        else if (isPermanentSendError(err)) { await finish(got.id, "failed_permanent", { layer: "envio", reason: `numero recusado: ${msg.slice(0, 100)}` }); rec.add("falha", "numero_sem_whatsapp"); }
        else if (isAmbiguousSendError(err)) { await finish(got.id, "unconfirmed", { layer: "envio", reason: "tempo esgotado no provedor: pode ter sido entregue, nao reenviado" }); rec.add("incerto", "envio_nao_confirmado"); }
        else { await finish(got.id, "failed", { layer: "envio", reason: `falha no envio: ${msg.slice(0, 100)}`, temporary: true, reevaluateAt: new Date(now.getTime() + FAIL_GAP_MS) }); rec.add("falha", "envio_falhou_tentara_de_novo"); }
        continue;
      }
      if (outcome === "vetoed") {
        const final = got.vetoes + 1 >= MAX_VETOES;
        await finish(got.id, "vetoed", { layer: "revisao_envio", reason: "revisao por IA barrou o convite (motivo no Diario de atividades)", temporary: !final, reevaluateAt: final ? null : new Date(now.getTime() + VETO_RETRY_MS), fingerprint });
        rec.add("vetado", final ? "revisao_de_envio_definitivo" : "revisao_de_envio_temporario"); continue;
      }
      if (outcome === "blocked") { await finish(got.id, "blocked", { layer: "politica", reason: "envio automatico bloqueado (plano)" }); rec.add("ignorado", "bloqueado_pelo_plano"); continue; }
      if (outcome === "duplicate") { await finish(got.id, "duplicate", { layer: "envio", reason: "mensagem identica ja enviada" }); rec.add("ignorado", "duplicada"); continue; }
      await finish(got.id, "sent", { layer: "envio", reason: "convite de indicacao enviado (mensagem separada)" });
      rec.add("enviado", "convite_de_indicacao");
      testBudget--;
      await recordAutomatedMessage(patient.id, text, REFERRAL_AUTHOR).catch(() => undefined);
      await sleep(3000 + Math.random() * 5000);
    }
  } catch (err) {
    failure = err;
    console.error("[convite-indicacao] a rodada falhou:", err instanceof Error ? err.message : err);
  } finally {
    await rec.save(failure ? "erro" : "ok", failure ?? undefined);
  }
}

export function startReferralJob(): void {
  scheduleLocked("convite-indicacao", "*/15 * * * *", () => runReferralSteps().catch((err) => console.error("Erro no convite de indicacao:", err)));
}

// ---------------------------------------------------------------------------
// DIAGNOSTICO DE UMA PESSOA (pesquisa -> nota -> etapas). So fatos e codigos: sem conteudo de conversa alem do comentario da nota (que a propria pessoa deu).
// ---------------------------------------------------------------------------
export async function surveyTrail(clinicId: string, patientId: string, now = new Date()) {
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { npsEnabled: true, npsThreshold: true, npsHoursAfter: true, googleReviewUrl: true, googleReviewConfirmedAt: true, googleReviewConfirmedBy: true, googleReviewPlace: true, googleReviewLegacyAllowed: true } });
  const identity = await identityPatientIds(clinicId, patientId);
  const last = await lastSurveyAskedAt(clinicId, identity.ids);
  const freq = frequencyVerdict(last, now);
  const [surveys, steps, link] = await Promise.all([
    prisma.satisfactionSurvey.findMany({ where: { clinicId, patientId: { in: identity.ids } }, orderBy: { askedAt: "desc" }, take: 10, select: { id: true, appointmentId: true, score: true, comment: true, askedAt: true, answeredAt: true, answeredByMessageId: true, band: true, hasComplaint: true, linkState: true, reviewLinkSent: true } }),
    prisma.followUpDispatch.findMany({ where: { clinicId, patientId: { in: identity.ids }, flow: { in: ["pesquisa", "indicacao"] } }, orderBy: { decidedAt: "desc" }, take: 30, select: { flow: true, step: true, cycleKey: true, state: true, layer: true, reason: true, temporary: true, reevaluateAt: true, decidedAt: true, version: true, attempt: true } }),
    Promise.resolve(reviewLinkState(clinic)),
  ]);
  const appts = surveys.length ? await prisma.appointment.findMany({ where: { id: { in: surveys.map((s) => s.appointmentId).filter((x): x is string => !!x) } }, select: { id: true, scheduledAt: true, status: true, procedure: { select: { name: true } } } }) : [];
  return {
    versao: REVISION.split(":")[0],
    pesquisaLigada: clinic.npsEnabled,
    notaDeCorte: clinic.npsThreshold,
    frequencia: { ultimaPesquisaEm: last, proximaPermitidaEm: freq.nextEligibleAt, podeReceberAgora: freq.allowed, diasEntrePesquisas: SURVEY_MIN_DAYS, identidade: { pessoas: identity.ids.length, ambigua: identity.ambiguous } },
    pesquisas: surveys.map((s) => ({ ...s, atendimentoDeOrigem: appts.find((a) => a.id === s.appointmentId) ?? null })),
    etapas: steps,
    linkDoGoogle: {
      situacao: link.send ? (link.basis === "confirmado" ? "pode ser enviado" : "pode ser enviado SO POR COMPATIBILIDADE com o comportamento anterior (o destino NUNCA foi conferido)") : `NAO enviado (${link.reason})`,
      base: link.send ? link.basis : null,
      destinoConferido: link.send && link.basis === "confirmado" && link.placeChecked,
      motivo: link.send ? null : link.detail,
      cadastrado: !!clinic.googleReviewUrl?.trim(),
      confirmadoEm: clinic.googleReviewConfirmedAt,
      confirmadoPor: clinic.googleReviewConfirmedBy,
      estabelecimentoConferido: clinic.googleReviewPlace,
    },
  };
}
