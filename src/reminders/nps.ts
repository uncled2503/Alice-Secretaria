import { scheduleLocked } from "../jobs/lock.js";
import { prisma } from "../db/client.js";
import { deferralInfo, sendText, isPermanentSendError, isAmbiguousSendError, isConnectionDownError, type SendOutcome } from "../uazapi/client.js";
import { isReviewUnavailable } from "../ai/sendGate.js";
import { getClinicTemplateInfo } from "../crm/template.js";
import { FREE_PLAN } from "../crm/plan.js";
import { isWithinClinicHours } from "../crm/openHours.js";
import { acquireFlow, competingContact, conversationFingerprint, finishFlow as finishFlowAt, recordFlowDecision as recordFlowDecisionAt, MAX_VETOES, VETO_RETRY_MS, DEFER_RETRY_MS, FAIL_GAP_MS, type DecisionMeta, type FlowKey, type FlowState } from "../crm/followupLedger.js";
import { RunRecorder } from "../crm/automationRuns.js";
import { MIN_GAP_BETWEEN_AUTOMATED_MS } from "../crm/followupSchedule.js";
import { frequencyVerdict, identityPatientIds, lastSurveyAskedAt, SURVEY_AUTHOR, SURVEY_MIN_DAYS } from "./surveyFlow.js";
import { usableFirstName } from "../crm/greeting.js";

const MAX_PER_TICK = 10; // por clinica a cada rodada (15 min)
export const NPS_AFTER_POST_MS = 4 * 3_600_000; // a pesquisa espera pelo menos 4h depois de uma mensagem de pos-procedimento

// PURO: o pos-procedimento desta regra AINDA vai sair (ou acabou de sair) para este atendimento? Entao a pesquisa espera. Avaliacao nao recebe pos.
export function postStillComing(
  appt: { scheduledAt: Date; procedureId: string; procedure: { name: string } },
  rules: { intervalValue: number; intervalUnit: string; procedureIds: string }[],
  sentCount: number,
  now: number,
): boolean {
  if (/avalia/i.test(appt.procedure.name) || sentCount > 0) return false;
  const elapsed = now - appt.scheduledAt.getTime();
  return rules.some((r) => {
    const filter = r.procedureIds.split(",").filter(Boolean);
    if (filter.length && !filter.includes(appt.procedureId)) return false;
    const at = r.intervalUnit === "hours" ? r.intervalValue * 3_600_000 : r.intervalValue * 86_400_000;
    return at <= elapsed + 3_600_000 && elapsed <= at + 3 * 86_400_000; // vence ate 1h daqui e ainda esta dentro da folga de envio do pos
  });
}

const DEFAULT_MESSAGE =
  "Oi {primeiro_nome}! Passando so pra saber como foi sua experiencia com a gente. Numa escala de 0 a 10, o quanto voce recomendaria a {unidade} pra um amigo?";

export interface NpsDeps {
  now?: Date;
  clinicId?: string;
}

// Roda a cada 15 min. Para cada atendimento CONCLUIDO ha "npsHoursAfter" horas (e no maximo 5 dias atras), se a clinica tem NPS ligado, manda a pergunta
// e cria o registro. A nota chega pela conversa e o CODIGO a le (reminders/surveyReply.ts). REGRAS DESTA RODADA (18/10):
//  - no maximo UMA pesquisa a cada 15 dias por PESSOA (janela movel, em qualquer procedimento/profissional/reserva). Quem esta dentro da janela NAO entra em fila:
//    a pesquisa daquele atendimento e descartada (registrada) e nao e disparada quando completar os 15 dias;
//  - cada tentativa fica no controle persistente (FollowUpDispatch, fluxo "pesquisa"): timeout do provedor = "sem confirmacao" (conta como enviada e NAO
//    reenvia), bloqueio/veto/duplicada NAO contam como enviadas (veto e temporario e reavaliavel), falha de envio tenta de novo com intervalo e teto;
//  - o resumo da rodada fica em AutomationRun (candidatas, elegiveis, enviadas, adiadas, ignoradas, motivos).
let npsRunning = false;
export async function runNpsCycle(deps: NpsDeps = {}): Promise<void> {
  if (npsRunning) return;
  npsRunning = true;
  try {
    const clinics = await prisma.clinic.findMany({
      where: { npsEnabled: true, plan: { not: FREE_PLAN }, ...(deps.clinicId ? { id: deps.clinicId } : {}) },
      select: { id: true, npsHoursAfter: true, npsMessage: true, npsEvaluationMessage: true, name: true, timezone: true, workDays: true, workStartHour: true, workEndHour: true, hoursByDay: true },
    });
    for (const clinic of clinics) await runForClinic(clinic, deps.now ?? new Date());
  } finally {
    npsRunning = false;
  }
}

async function runForClinic(
  clinic: { id: string; npsHoursAfter: number; npsMessage: string | null; npsEvaluationMessage: string | null; name: string; timezone: string; workDays: string; workStartHour: number; workEndHour: number; hoursByDay: string | null },
  nowDate: Date,
): Promise<void> {
  const rec = new RunRecorder("pesquisa-satisfacao", clinic.id, nowDate);
  const finishFlow = (id: string, state: FlowState, meta: DecisionMeta = {}) => finishFlowAt(id, state, { ...meta, at: nowDate });
  const recordFlowDecision = (key: FlowKey, state: FlowState, meta: DecisionMeta = {}) => recordFlowDecisionAt(key, state, { ...meta, at: nowDate });
  let failure: unknown = null;
  try {
    // So pergunta dentro do expediente da clinica (antes mandava de madrugada).
    if (!isWithinClinicHours(clinic, nowDate)) { rec.add("ignorado", "fora_do_expediente"); return; }
    const now = nowDate.getTime();
    const cutoff = new Date(now - clinic.npsHoursAfter * 3_600_000);
    const floor = new Date(now - 5 * 24 * 3_600_000);

    // Ja tratados (pesquisa registrada OU decisao no controle) ficam de fora da consulta (senao o teto por rodada seria gasto com eles).
    const [surveyed, handled] = await Promise.all([
      prisma.satisfactionSurvey.findMany({ where: { clinicId: clinic.id, appointmentId: { not: null }, askedAt: { gte: floor } }, select: { appointmentId: true } }),
      prisma.followUpDispatch.findMany({
        where: { clinicId: clinic.id, flow: "pesquisa", OR: [{ state: { in: ["sent", "unconfirmed", "blocked", "duplicate", "failed_permanent", "expired", "skipped", "reserved"] } }, { state: "vetoed", vetoes: { gte: MAX_VETOES } }] },
        select: { cycleKey: true },
      }),
    ]);
    const doneIds = [...new Set([...surveyed.map((s) => s.appointmentId as string), ...handled.map((h) => h.cycleKey)])];

    const due = await prisma.appointment.findMany({
      where: {
        clinicId: clinic.id,
        ...(doneIds.length ? { id: { notIn: doneIds } } : {}),
        status: "completed",
        scheduledAt: { lte: cutoff, gte: floor },
        patient: { optedOut: false, contactKind: "paciente" },
      },
      include: { patient: true, procedure: { select: { name: true } } },
      orderBy: { scheduledAt: "asc" },
      take: MAX_PER_TICK * 3, // folga: parte sai por frequencia/pos e nao conta no teto de envios
    });
    rec.candidates = due.length;
    if (due.length === 0) return;

    // Quem recebeu mensagem de pos-procedimento nas ultimas horas espera: pesquisa e acompanhamento no mesmo minuto parecem robo.
    const recentPost = await prisma.postProcedureSent.findMany({
      where: { sentAt: { gte: new Date(now - NPS_AFTER_POST_MS) }, appointment: { patientId: { in: due.map((d) => d.patientId) } } },
      select: { appointment: { select: { patientId: true } } },
    });
    const waitingPost = new Set(recentPost.map((r) => r.appointment.patientId));
    const postRules = await prisma.postProcedureRule.findMany({ where: { clinicId: clinic.id, active: true }, select: { intervalValue: true, intervalUnit: true, procedureIds: true } });
    const postSent = postRules.length
      ? await prisma.postProcedureSent.groupBy({ by: ["appointmentId"], where: { appointmentId: { in: due.map((d) => d.id) } }, _count: { _all: true } })
      : [];
    const postSentBy = new Map(postSent.map((s) => [s.appointmentId, s._count._all]));
    const info = await getClinicTemplateInfo(clinic.id);

    let sentNow = 0;
    for (const appt of due) {
      if (sentNow >= MAX_PER_TICK) { rec.add("adiado", "limite_por_rodada"); continue; }
      if (waitingPost.has(appt.patientId) || postStillComing(appt, postRules, postSentBy.get(appt.id) ?? 0, now)) { rec.add("adiado", "aguardando_pos_procedimento"); continue; }

      const key: FlowKey = { clinicId: clinic.id, patientId: appt.patientId, conversationId: null, flow: "pesquisa", ruleId: null, step: 1, cycleKey: appt.id, dueAt: new Date(appt.scheduledAt.getTime() + clinic.npsHoursAfter * 3_600_000) };

      // FREQUENCIA: no maximo 1 pesquisa a cada 15 dias por PESSOA (qualquer procedimento, profissional ou reserva). Dentro da janela = descartada, sem fila.
      const identity = await identityPatientIds(clinic.id, appt.patientId);
      const last = await lastSurveyAskedAt(clinic.id, identity.ids);
      const freq = frequencyVerdict(last, nowDate);
      if (!freq.allowed) {
        await recordFlowDecision(key, "skipped", { layer: "politica", reason: `frequencia: ja recebeu pesquisa em ${last!.toISOString().slice(0, 10)}; a proxima so a partir de ${freq.nextEligibleAt!.toISOString().slice(0, 10)} (${SURVEY_MIN_DAYS} dias). Esta pesquisa foi descartada, nao fica na fila${identity.ambiguous ? " [identidade: mais de uma linha com o mesmo vinculo do Clinica Experts]" : ""}` });
        rec.add("ignorado", "frequencia_15_dias");
        continue;
      }

      // contexto: atendimento humano em curso (reclamacao, negociacao): a pesquisa espera
      const conv = await prisma.conversation.findFirst({ where: { patientId: appt.patientId }, orderBy: { lastMessageAt: "desc" }, select: { id: true, humanTakeover: true } });
      if (conv?.humanTakeover) { rec.add("adiado", "atendimento_humano_em_curso"); continue; }
      const compete = await competingContact({ patientId: appt.patientId, flow: "pesquisa", now: nowDate, minGapMs: MIN_GAP_BETWEEN_AUTOMATED_MS });
      if (compete) { rec.add("adiado", `concorrencia:${compete.code}`); continue; }

      rec.eligible++;
      const fingerprint = conv ? await conversationFingerprint(conv.id, appt.patientId) : null;
      const got = await acquireFlow({ ...key, conversationId: conv?.id ?? null }, fingerprint, nowDate);
      if (!got.ok) { rec.add(got.why === "already_handled" || got.why === "exhausted" ? "ignorado" : "adiado", `${got.why}:${got.state ?? "-"}`); continue; }

      const firstName = usableFirstName(appt.patient.name);
      const isEvaluation = /avalia/i.test(appt.procedure.name);
      const text = ((isEvaluation && clinic.npsEvaluationMessage?.trim()) || clinic.npsMessage?.trim() || DEFAULT_MESSAGE)
        .replace(/\{primeiro_nome\}/gi, firstName)
        .replace(/\{nome\}/gi, firstName)
        .replace(/\{unidade\}/gi, info.primaryLocation?.name || info.name)
        .replace(/\{clinica\}/gi, info.name)
        .trim();

      let outcome: SendOutcome;
      let unconfirmed = false;
      try {
        outcome = await sendText(clinic.id, appt.patient.phone, text, { kind: "pesquisa" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`NPS: falha ao enviar para ${appt.patient.phone}:`, msg);
        if (isConnectionDownError(err) || isReviewUnavailable(err)) { const d = deferralInfo(err); await finishFlow(got.id, "deferred", { layer: d.layer, reason: d.reason, temporary: true, reevaluateAt: new Date(now + DEFER_RETRY_MS) }); rec.add("adiado", d.tag); continue; }
        if (isPermanentSendError(err)) { await finishFlow(got.id, "failed_permanent", { layer: "envio", reason: `numero recusado pelo provedor: ${msg.slice(0, 100)}` }); rec.add("falha", "numero_sem_whatsapp"); continue; }
        if (!isAmbiguousSendError(err)) { await finishFlow(got.id, "failed", { layer: "envio", reason: `falha no envio: ${msg.slice(0, 100)}`, temporary: true, reevaluateAt: new Date(now + FAIL_GAP_MS) }); rec.add("falha", "envio_falhou_tentara_de_novo"); continue; }
        // timeout depois de submetido: PODE ter chegado. Conta como enviada para a frequencia e nunca reenvia as cegas (antes: sem registro, reenviava na proxima rodada).
        unconfirmed = true;
        outcome = "sent";
      }
      if (outcome === "vetoed") {
        const final = got.vetoes + 1 >= MAX_VETOES;
        await finishFlow(got.id, "vetoed", { layer: "revisao_envio", reason: "revisao por IA barrou a pesquisa (motivo no Diario de atividades)", temporary: !final, reevaluateAt: final ? null : new Date(now + VETO_RETRY_MS), fingerprint });
        rec.add("vetado", final ? "revisao_de_envio_definitivo" : "revisao_de_envio_temporario");
        continue;
      }
      if (outcome === "blocked") { await finishFlow(got.id, "blocked", { layer: "politica", reason: "envio automatico bloqueado para esta clinica" }); rec.add("ignorado", "envio_bloqueado_pelo_plano"); continue; }
      if (outcome === "duplicate") { await finishFlow(got.id, "duplicate", { layer: "envio", reason: "mensagem identica ja enviada a esta pessoa" }); rec.add("ignorado", "mensagem_duplicada"); continue; }

      // Saiu (ou pode ter saido). A pesquisa fica registrada AGORA: e ela que associa a nota, a frequencia e a deduplicacao.
      await prisma.satisfactionSurvey.create({ data: { clinicId: clinic.id, patientId: appt.patientId, appointmentId: appt.id, askedAt: nowDate } });
      await finishFlow(got.id, unconfirmed ? "unconfirmed" : "sent", { layer: "envio", reason: unconfirmed ? "tempo esgotado no provedor: pode ter sido entregue, nao reenviado" : "pesquisa enviada" });
      rec.add(unconfirmed ? "incerto" : "enviado", unconfirmed ? "envio_nao_confirmado" : "pesquisa");
      sentNow++;

      // Deixa a pergunta na conversa pra Alice ter contexto quando o paciente responder.
      let c = await prisma.conversation.findFirst({ where: { patientId: appt.patientId, status: { in: ["active", "qualified", "scheduled"] } }, orderBy: { createdAt: "desc" } });
      if (!c) c = await prisma.conversation.create({ data: { patientId: appt.patientId } });
      await prisma.message.create({ data: { conversationId: c.id, role: "assistant", content: text, authorName: SURVEY_AUTHOR, ...(unconfirmed ? { deliveryStatus: "unconfirmed" } : {}) } });
      await prisma.conversation.update({ where: { id: c.id }, data: { status: "active", lastMessageAt: nowDate, lastFollowUpOrder: 0 } });
    }
  } catch (err) {
    failure = err;
    console.error("[pesquisa-satisfacao] a rodada falhou:", err instanceof Error ? err.message : err);
  } finally {
    await rec.save(failure ? "erro" : "ok", failure ?? undefined, new Date());
  }
}

export function startNpsJob(): void {
  scheduleLocked("pesquisa-satisfacao", "*/15 * * * *", () => runNpsCycle().catch((err) => console.error("Erro na pesquisa de satisfacao:", err)));
}
