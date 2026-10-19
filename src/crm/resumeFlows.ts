import { scheduleLocked } from "../jobs/lock.js";
import { prisma } from "../db/client.js";
import { sendText, isPermanentSendError, isAmbiguousSendError, type SendOutcome } from "../uazapi/client.js";
import { renderMessageTemplate, getClinicTemplateInfo } from "./template.js";
import { PAID_CLINIC_WHERE } from "./plan.js";
import { getFunnelStages } from "./stages.js";
import { recordAutomatedMessage } from "./conversationLog.js";
import { judgeResumeContact } from "./recontactJudge.js";
import { openAt, MIN_GAP_BETWEEN_AUTOMATED_MS, type SendCalendar } from "./followupSchedule.js";
import { acquireFlow, competingContact, conversationFingerprint, finishFlow as finishFlowAt, recordFlowDecision as recordFlowDecisionAt, MAX_VETOES, VETO_RETRY_MS, DEFER_RETRY_MS, FAIL_GAP_MS, type DecisionMeta, type FlowKey, type FlowKind, type FlowState } from "./followupLedger.js";
import { RunRecorder } from "./automationRuns.js";
import { wallClockInZone, zonedWallClockToUtc } from "../scheduling/time.js";
import { checkResumeSend, modeOf, readRestriction, testSendsSoFar, type GuardFields } from "./resumeGuard.js";

// ---------------------------------------------------------------------------
// RETOMADAS (17-18/10/2026, Lisboa): dois fluxos SEPARADOS do recontato por silencio, cada um com a propria configuracao, elegibilidade e controle.
//   avaliacao_cancelada      - quem CANCELOU a avaliacao e nao remarcou nem voltou por outro caminho.
//   avaliacao_sem_fechamento - quem fez a avaliacao e ainda nao fechou, SO se a equipe marcou a pessoa (o sistema nao enxerga o "fechou", que acontece
//                              fora da Alice: nao existe evidencia confiavel para varrer a base inteira, entao nao ha disparo em massa).
// Nasce DESLIGADO e sem texto (ResumeFlowConfig). Dia/horario/publico sao da clinica: nada e presumido. Nada de mensagem antiga em massa: so o que
// aconteceu nos ultimos `lookbackDays`, no maximo `maxPerRun` por rodada e `maxPerDay` por dia.
// ---------------------------------------------------------------------------

export const RESUME_CANCELLED = "avaliacao_cancelada" as const;
export const RESUME_NOCLOSE = "avaliacao_sem_fechamento" as const;
export const AUTHOR_CANCELLED = "Retomada de avaliação";
export const AUTHOR_NOCLOSE = "Retomada pós-avaliação";

// Origens do cancelamento que PROVAM que a pessoa/clinica cancelou (nao e rollback do sistema nem reserva que sumiu do CE).
export const RELIABLE_CANCEL_SOURCES = ["paciente_whatsapp", "equipe_painel", "api_externa", "ce_cancelada"] as const;

export const DEFAULT_CANCELLED_TEXT =
  "Oi, {primeiro_nome}! 💗 Aqui é a Alice, da {unidade}. Vi que a sua avaliação não pôde acontecer. Se você ainda tiver interesse, é só me responder por aqui que eu te ajudo a retomar, sem compromisso. ✨";
export const DEFAULT_NOCLOSE_TEXT =
  "Oi, {primeiro_nome}! 💗 Aqui é a Alice, da {unidade}. Passando para saber como você está depois da sua avaliação e se ficou alguma dúvida. Se quiser, é só me responder por aqui. ✨";

const isEvaluationName = (n: string) => /valia/i.test(n);
const validPhone = (p: string) => /^55\d{10,11}$/.test(p.replace(/\D/g, ""));
const DAY_MS = 24 * 3_600_000;

export interface ResumeConfig {
  clinicId: string;
  flow: FlowKind;
  enabled: boolean;
  weekday: number | null;
  startHour: number | null;
  endHour: number | null;
  lookbackDays: number;
  maxPerRun: number;
  maxPerDay: number;
  message: string | null;
  guard: GuardFields; // modo de execucao (normal | restrito com contatos de teste e limite)
}

export async function getResumeConfig(clinicId: string, flow: FlowKind): Promise<ResumeConfig | null> {
  const row = await prisma.resumeFlowConfig.findUnique({ where: { clinicId_flow: { clinicId, flow } } });
  return row ? { clinicId, flow, enabled: row.enabled, weekday: row.weekday, startHour: row.startHour, endHour: row.endHour, lookbackDays: row.lookbackDays, maxPerRun: row.maxPerRun, maxPerDay: row.maxPerDay, message: row.message, guard: { runMode: row.runMode, testPatientIds: row.testPatientIds, testMaxSends: row.testMaxSends, testStartedAt: row.testStartedAt } } : null;
}

// ---------------------------------------------------------------------------
// ELEGIBILIDADE (funcoes que respondem "esta pessoa entra?" com um codigo; definitivo = nunca mais para este evento; temporario = reavalia depois)
// ---------------------------------------------------------------------------
export interface Exclusion {
  code: string;
  definitive: boolean;
  detail: string;
}

interface PatientFacts {
  id: string;
  name: string | null;
  phone: string;
  optedOut: boolean;
  noInterest: boolean;
  callbackAt: Date | null;
  funnelStage: string;
  birthDate: Date | null;
}

// Sinais da pessoa que valem para os DOIS fluxos (o que ja fez, o que combinou, se esta falando agora).
async function commonExclusion(p: PatientFacts, clinicId: string, afterAt: Date, now: Date, exceptAppointmentId?: string): Promise<Exclusion | null> {
  if (p.optedOut) return { code: "pediu_para_nao_receber", definitive: true, detail: "pediu para nao receber mensagens" };
  if (p.noInterest) return { code: "sem_interesse", definitive: true, detail: "disse que nao tem interesse" };
  if (!validPhone(p.phone)) return { code: "telefone_invalido", definitive: true, detail: "telefone fora do padrao" };
  if (p.callbackAt && p.callbackAt.getTime() > now.getTime()) return { code: "retorno_combinado_futuro", definitive: false, detail: "pediu para ser chamada numa data futura" };
  const stages = await getFunnelStages(clinicId);
  const won = stages.find((s) => s.stageId === p.funnelStage)?.kind === "ganho";
  if (won) return { code: "ja_e_cliente", definitive: true, detail: "ja esta numa etapa de venda ganha" };

  // Marcou/fez algo DEPOIS (remarcacao, nova reserva com outro id, avaliacao feita depois, compra): nao e mais "quem ficou sem retomar".
  const later = await prisma.appointment.findFirst({
    where: {
      patientId: p.id,
      ...(exceptAppointmentId ? { id: { not: exceptAppointmentId } } : {}),
      OR: [
        { status: { in: ["confirmed", "completed"] }, scheduledAt: { gte: afterAt } },
        { status: { in: ["confirmed", "completed", "no_show"] }, createdAt: { gte: new Date(afterAt.getTime() - 2 * 3_600_000) } },
      ],
    },
    select: { id: true, status: true },
  });
  if (later) return { code: "ja_remarcou_ou_tem_nova_reserva", definitive: true, detail: `tem outra reserva/atendimento depois (${later.status})` };

  // Conversa: atendimento humano em curso, ou ela esta falando agora, ou a equipe falou com ela ha pouco.
  const conv = await prisma.conversation.findFirst({ where: { patientId: p.id }, orderBy: { lastMessageAt: "desc" }, select: { humanTakeover: true, staffTouchedAt: true, lastMessageAt: true, handoffReason: true } });
  if (conv?.humanTakeover) return { code: "atendimento_humano_em_curso", definitive: false, detail: "a conversa esta com a equipe" };
  if (conv?.staffTouchedAt && now.getTime() - conv.staffTouchedAt.getTime() < 2 * DAY_MS) return { code: "equipe_falou_recentemente", definitive: false, detail: "a equipe falou com ela nas ultimas 48h" };
  if (conv && now.getTime() - conv.lastMessageAt.getTime() < DAY_MS) return { code: "conversa_em_andamento", definitive: false, detail: "ha conversa nas ultimas 24h" };
  return null;
}

// PURO: o cancelamento serve de evidencia?
export function cancelEvidence(a: { cancelledAt: Date | null; cancelSource: string | null }): { ok: true } | { ok: false; code: string; detail: string } {
  if (!a.cancelledAt) return { ok: false, code: "cancelamento_sem_data", detail: "cancelado antes do registro de origem existir: nao da pra afirmar quando nem por quem" };
  if (!a.cancelSource) return { ok: false, code: "origem_nao_comprovada", detail: "sem origem do cancelamento" };
  if (!(RELIABLE_CANCEL_SOURCES as readonly string[]).includes(a.cancelSource)) {
    const why = a.cancelSource === "ce_apagada" ? "a reserva sumiu do Clinica Experts (pode ser remarcacao/troca, nao prova desistencia)" : a.cancelSource === "sistema_desfeito" ? "foi desfeita pelo sistema porque o Clinica Experts recusou, nao foi decisao da pessoa" : "origem nao reconhecida";
    return { ok: false, code: "origem_nao_comprovada", detail: why };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// A RODADA
// ---------------------------------------------------------------------------
export interface ResumeDeps {
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
  clinicId?: string; // rodada dirigida a UMA clinica
}
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let resumeRunning = false;
export async function runResumeFlows(deps: ResumeDeps = {}): Promise<void> {
  if (resumeRunning) return;
  resumeRunning = true;
  try {
    const now = deps.now ?? new Date();
    const clinics = await prisma.clinic.findMany({ where: { ...PAID_CLINIC_WHERE, active: true, aliceActive: true, ...(deps.clinicId ? { id: deps.clinicId } : {}) }, select: { id: true } });
    for (const c of clinics) {
      await runOneFlow(c.id, RESUME_CANCELLED, "retomada-avaliacao-cancelada", now, deps.sleep ?? realSleep);
      await runOneFlow(c.id, RESUME_NOCLOSE, "retomada-avaliacao-sem-fechamento", now, deps.sleep ?? realSleep);
    }
  } finally {
    resumeRunning = false;
  }
}

interface Candidate {
  cycleKey: string; // evento de origem (id da reserva cancelada / id da marcacao da equipe)
  patient: PatientFacts;
  eventAt: Date; // quando cancelou / quando foi marcada
  procedureName: string;
  targetId?: string;
  baseAppointmentId?: string; // a avaliacao que originou o evento (nao conta como "outra reserva")
}

async function runOneFlow(clinicId: string, flow: typeof RESUME_CANCELLED | typeof RESUME_NOCLOSE, job: string, now: Date, sleep: (ms: number) => Promise<void>): Promise<void> {
  const cfg = await getResumeConfig(clinicId, flow);
  if (!cfg) return; // fluxo nunca configurado nesta clinica: nada a registrar
  const rec = new RunRecorder(job, clinicId, now);
  const restriction = readRestriction(cfg.guard);
  const runMode = modeOf(restriction);
  rec.mode = runMode; // o modo de execucao fica registrado na rodada e em cada decisao
  const finishFlow = (id: string, state: FlowState, meta: DecisionMeta = {}) => finishFlowAt(id, state, { ...meta, at: now, runMode }); // relogio da rodada
  const recordFlowDecision = (key: FlowKey, state: FlowState, meta: DecisionMeta = {}) => recordFlowDecisionAt(key, state, { ...meta, at: now, runMode });
  let failure: unknown = null;
  try {
    if (!cfg.enabled) { rec.add("ignorado", "fluxo_desligado"); return; }
    if (!cfg.message?.trim()) { rec.add("ignorado", "sem_texto_aprovado"); return; }
    // MODO RESTRITO (validacao controlada): configuracao incompleta/invalida BLOQUEIA a rodada inteira; nunca cai no publico todo.
    if (restriction.mode === "restrito" && !restriction.valid) { rec.add("ignorado", "modo_restrito_invalido"); console.warn(`[${job}] clinica ${clinicId}: modo restrito invalido (${restriction.problem}); nada foi enviado`); return; }
    const onlyIds = restriction.mode === "restrito" && restriction.valid ? restriction.patientIds : undefined;
    const clinic = await prisma.clinic.findUniqueOrThrow({
      where: { id: clinicId },
      select: { timezone: true, workDays: true, workStartHour: true, workEndHour: true, hoursByDay: true, closedOnHolidays: true, holidayOpen: true, importStatus: true },
    });
    if (clinic.importStatus === "running") { rec.add("ignorado", "importando_historico"); return; }
    const tz = clinic.timezone || "America/Sao_Paulo";
    const cal: SendCalendar = { ...clinic, timezone: tz };

    // dia/horario/janela da clinica para ESTA retomada (nada e presumido: sem configuracao de dia, vale qualquer dia de atendimento)
    const wc = wallClockInZone(now, tz);
    if (cfg.weekday != null && wc.weekday !== cfg.weekday) { rec.add("ignorado", "fora_do_dia_da_semana_configurado"); return; }
    const open = openAt({ sendWindowStart: cfg.startHour, sendWindowEnd: cfg.endHour }, cal, now);
    if (!open.open) { rec.add("ignorado", `fora_da_janela:${open.reason}`); return; }

    // teto do dia (somando o que ja saiu hoje neste fluxo)
    const dayStart = zonedWallClockToUtc(tz, wc.year, wc.month, wc.day, 0, 0);
    const sentToday = await prisma.followUpDispatch.count({ where: { clinicId, flow, state: { in: ["sent", "unconfirmed", "reserved"] }, decidedAt: { gte: dayStart } } });
    let budget = Math.max(0, Math.min(cfg.maxPerRun, cfg.maxPerDay - sentToday));
    if (budget === 0) { rec.add("ignorado", "teto_do_dia_atingido"); return; }
    if (restriction.mode === "restrito" && restriction.valid) {
      const used = await testSendsSoFar(clinicId, flow, restriction.startedAt, true);
      budget = Math.min(budget, Math.max(0, restriction.maxSends - used));
      if (budget === 0) { rec.add("ignorado", "limite_do_teste_atingido"); return; }
    }

    // no modo restrito a consulta ja traz SO os contatos autorizados: os demais nem sao lidos, nem recebem registro de controle
    const candidates = flow === RESUME_CANCELLED ? await cancelledCandidates(clinicId, cfg, now, rec, { onlyPatientIds: onlyIds }) : await noCloseCandidates(clinicId, cfg, now, rec, { onlyPatientIds: onlyIds });
    const info = await getClinicTemplateInfo(clinicId);

    for (const cand of candidates) {
      if (budget <= 0) { rec.add("adiado", "limite_por_rodada"); continue; }
      const key: FlowKey = { clinicId, patientId: cand.patient.id, conversationId: null, flow, ruleId: null, step: 1, cycleKey: cand.cycleKey, dueAt: cand.eventAt };
      const ex = await commonExclusion(cand.patient, clinicId, cand.eventAt, now, cand.baseAppointmentId);
      if (ex) {
        if (ex.definitive) {
          await recordFlowDecision(key, "skipped", { layer: "elegibilidade", reason: `${ex.code}: ${ex.detail}`, temporary: false });
          if (cand.targetId) await prisma.resumeTarget.updateMany({ where: { id: cand.targetId, status: "pending" }, data: { status: "ineligible", resultNote: `${ex.code}: ${ex.detail}`.slice(0, 200) } });
        }
        rec.add("ignorado", ex.code);
        continue;
      }
      const compete = await competingContact({ patientId: cand.patient.id, flow, now, minGapMs: MIN_GAP_BETWEEN_AUTOMATED_MS });
      if (compete) { rec.add("ignorado", `concorrencia:${compete.code}`); continue; }
      // outro contato EQUIVALENTE ja feito (recontato por silencio nas ultimas 48h)
      const recentRecontact = await prisma.message.findFirst({ where: { role: "assistant", authorName: "Recontato automático", createdAt: { gte: new Date(now.getTime() - 2 * DAY_MS) }, conversation: { patientId: cand.patient.id } }, select: { id: true } });
      if (recentRecontact) { rec.add("ignorado", "contato_equivalente_recente"); continue; }

      rec.eligible++;
      const conv = await prisma.conversation.findFirst({ where: { patientId: cand.patient.id }, orderBy: { lastMessageAt: "desc" }, select: { id: true } });
      const fingerprint = conv ? await conversationFingerprint(conv.id, cand.patient.id) : `sem-conversa|${cand.patient.optedOut}`;
      const got = await acquireFlow({ ...key, conversationId: conv?.id ?? null }, fingerprint, now, runMode);
      if (!got.ok) { rec.add(got.why === "already_handled" || got.why === "exhausted" ? "ignorado" : "adiado", `${got.why}:${got.state ?? "-"}`); continue; }

      // Ultima palavra: o juiz le o contexto (reclamacao, recusa, saude, retorno combinado...). Falha tecnica da IA nao e decisao de negocio: adia.
      const judged = await judgeResumeContact(flow, { patientId: cand.patient.id, clinicName: info.name, now });
      if (judged.kind === "unavailable") {
        await finishFlow(got.id, "deferred", { layer: "juiz_ia", reason: `falha tecnica do juiz de IA (${judged.why}) - nao e decisao de negocio`, temporary: true, reevaluateAt: new Date(now.getTime() + DEFER_RETRY_MS), fingerprint });
        rec.add("incerto", "juiz_de_IA_indisponivel");
        continue;
      }
      if (!judged.verdict.recontact) {
        const final = got.vetoes + 1 >= MAX_VETOES;
        await finishFlow(got.id, "vetoed", { layer: "juiz_ia", reason: `juiz de IA: ${judged.verdict.reason || "sem motivo"}`, temporary: !final, reevaluateAt: final ? null : new Date(now.getTime() + VETO_RETRY_MS), fingerprint });
        rec.add("vetado", final ? "juiz_de_IA_definitivo" : "juiz_de_IA_temporario");
        continue;
      }

      const text = renderMessageTemplate(cfg.message, { patientName: cand.patient.name, patientPhone: cand.patient.phone, clinicName: info.name, locationName: info.primaryLocation?.name, locationAddress: info.primaryLocation?.fullAddress, procedureName: cand.procedureName, birthDate: cand.patient.birthDate });
      // REVALIDACAO imediatamente antes do envio: le a configuracao DE NOVO do banco (ela pode ter mudado desde o inicio da rodada) e confere selecao e limite do teste.
      const permit = await checkResumeSend(clinicId, [flow], { patientId: cand.patient.id, phone: cand.patient.phone }, { countReserved: false });
      if (!permit.allowed) {
        await finishFlow(got.id, "deferred", { layer: "politica", reason: `modo ${permit.mode}: ${permit.code} (${permit.detail ?? "-"})`, temporary: true, reevaluateAt: new Date(now.getTime() + DEFER_RETRY_MS), fingerprint });
        rec.add("adiado", `modo_restrito:${permit.code}`);
        continue;
      }
      let outcome: SendOutcome;
      try {
        outcome = await sendText(clinicId, cand.patient.phone, text, { kind: "retomada", flow });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isPermanentSendError(err)) { await finishFlow(got.id, "failed_permanent", { layer: "envio", reason: `numero recusado pelo provedor: ${msg.slice(0, 100)}` }); rec.add("falha", "numero_sem_whatsapp"); }
        else if (isAmbiguousSendError(err)) { await finishFlow(got.id, "unconfirmed", { layer: "envio", reason: "tempo esgotado no provedor: pode ter sido entregue, nao reenviado" }); rec.add("incerto", "envio_nao_confirmado"); }
        else { await finishFlow(got.id, "failed", { layer: "envio", reason: `falha no envio: ${msg.slice(0, 100)}`, temporary: true, reevaluateAt: new Date(now.getTime() + FAIL_GAP_MS) }); rec.add("falha", "envio_falhou_tentara_de_novo"); }
        continue;
      }
      if (outcome === "vetoed") {
        const final = got.vetoes + 1 >= MAX_VETOES;
        await finishFlow(got.id, "vetoed", { layer: "revisao_envio", reason: "revisao por IA barrou a mensagem (motivo no Diario de atividades)", temporary: !final, reevaluateAt: final ? null : new Date(now.getTime() + VETO_RETRY_MS), fingerprint });
        rec.add("vetado", final ? "revisao_de_envio_definitivo" : "revisao_de_envio_temporario");
        continue;
      }
      if (outcome === "blocked") { await finishFlow(got.id, "blocked", { layer: "politica", reason: "envio automatico bloqueado para esta clinica (plano gratuito)" }); rec.add("ignorado", "envio_bloqueado_pelo_plano"); continue; }
      if (outcome === "duplicate") { await finishFlow(got.id, "duplicate", { layer: "envio", reason: "mensagem identica ja enviada a esta pessoa" }); rec.add("ignorado", "mensagem_duplicada"); continue; }

      await finishFlow(got.id, "sent", { layer: "envio", reason: `${flow} enviada` });
      rec.add("enviado", flow);
      budget--;
      await recordAutomatedMessage(cand.patient.id, text, flow === RESUME_CANCELLED ? AUTHOR_CANCELLED : AUTHOR_NOCLOSE).catch(() => undefined);
      if (cand.targetId) await prisma.resumeTarget.updateMany({ where: { id: cand.targetId }, data: { status: "sent", resultNote: `enviada em ${now.toISOString()}` } });
      await sleep(3000 + Math.random() * 5000);
    }
  } catch (err) {
    failure = err;
    console.error(`[${job}] a rodada falhou:`, err instanceof Error ? err.message : err);
  } finally {
    await rec.save(failure ? "erro" : "ok", failure ?? undefined);
  }
}

// ---- candidatos
interface CandidateOpts {
  onlyPatientIds?: string[]; // modo restrito: so estes pacientes sao lidos
  dry?: boolean; // previa: nao grava nenhum registro de controle
}

async function cancelledCandidates(clinicId: string, cfg: ResumeConfig, now: Date, rec: RunRecorder, opts: CandidateOpts = {}): Promise<Candidate[]> {
  const since = new Date(now.getTime() - cfg.lookbackDays * DAY_MS);
  const rows = await prisma.appointment.findMany({
    where: { clinicId, status: "cancelled", cancelledAt: { gte: since, lte: now }, procedure: { name: { contains: "valia" } }, ...(opts.onlyPatientIds ? { patientId: { in: opts.onlyPatientIds } } : {}) },
    include: { patient: true, procedure: { select: { name: true } } },
    orderBy: { cancelledAt: "desc" },
    take: 200,
  });
  const out: Candidate[] = [];
  const seenPatient = new Set<string>();
  rec.candidates += rows.length;
  for (const a of rows) {
    if (!isEvaluationName(a.procedure.name)) continue;
    const ev = cancelEvidence(a);
    if (!ev.ok) {
      // pendencia registrada UMA vez por reserva (aparece no diagnostico); nunca entra na retomada
      if (!opts.dry) {
        await recordFlowDecisionAt(
          { clinicId, patientId: a.patientId, conversationId: null, flow: RESUME_CANCELLED, ruleId: null, step: 1, cycleKey: a.id, dueAt: a.cancelledAt },
          "skipped", { layer: "elegibilidade", reason: `${ev.code}: ${ev.detail}`, temporary: false, at: now, runMode: opts.onlyPatientIds ? "restrito" : "normal" },
        );
      }
      rec.add("ignorado", ev.code);
      continue;
    }
    if (seenPatient.has(a.patientId)) { rec.add("ignorado", "outra_avaliacao_cancelada_da_mesma_pessoa"); continue; }
    seenPatient.add(a.patientId);
    out.push({ cycleKey: a.id, patient: a.patient, eventAt: a.cancelledAt!, procedureName: a.procedure.name, baseAppointmentId: a.id });
  }
  return out;
}

async function noCloseCandidates(clinicId: string, cfg: ResumeConfig, now: Date, rec: RunRecorder, opts: CandidateOpts = {}): Promise<Candidate[]> {
  const targets = await prisma.resumeTarget.findMany({ where: { clinicId, flow: RESUME_NOCLOSE, status: "pending", ...(opts.onlyPatientIds ? { patientId: { in: opts.onlyPatientIds } } : {}) }, orderBy: { markedAt: "asc" }, take: 200 });
  const out: Candidate[] = [];
  rec.candidates += targets.length;
  for (const t of targets) {
    if (now.getTime() - t.markedAt.getTime() > cfg.lookbackDays * DAY_MS * 4) { rec.add("ignorado", "marcacao_antiga_demais"); continue; }
    const patient = await prisma.patient.findUnique({ where: { id: t.patientId } });
    if (!patient || patient.clinicId !== clinicId) { rec.add("ignorado", "pessoa_nao_encontrada"); continue; }
    // "fechou" = atendimento concluido de OUTRO procedimento depois da avaliacao
    const evalDone = await prisma.appointment.findFirst({ where: { patientId: patient.id, status: "completed", procedure: { name: { contains: "valia" } } }, orderBy: { scheduledAt: "desc" }, select: { id: true, scheduledAt: true } });
    out.push({ cycleKey: `${t.id}:${t.markedAt.getTime()}`, patient, eventAt: evalDone?.scheduledAt ?? t.markedAt, procedureName: "avaliação", targetId: t.id, baseAppointmentId: evalDone?.id });
  }
  return out;
}

// ---------------------------------------------------------------------------
// PREVIA (so leitura): quem seria selecionado numa rodada AGORA, com a regra, o evento, o motivo da elegibilidade ou da exclusao e o que ja existe no controle.
// NAO envia, NAO reserva nem consome tentativa, NAO grava registro de controle (nem "pulada") e NAO consulta o juiz de IA (ele decide so na hora do envio).
// So dados minimos da pessoa: id interno e primeiro nome com a inicial do sobrenome; telefone nunca aparece.
// ---------------------------------------------------------------------------
export interface PreviewCandidate {
  ref: string; // id interno do paciente
  nome: string; // "Maria S."
  regra: string; // fluxo
  evento: string; // ISO: cancelamento / marcacao
  procedimento: string;
  situacao: "elegivel" | "excluido";
  motivo: string; // codigo curto (sem conteudo de conversa)
  definitivo: boolean | null;
  controleExistente: string | null; // estado ja gravado para este evento (sent, vetoed...), se houver
}
export interface ResumePreview {
  fluxo: string;
  configurado: boolean;
  ligado: boolean;
  temTexto: boolean;
  modo: "normal" | "restrito";
  restricao: { valida: boolean; problema: string | null; contatosAutorizados: number; limiteDeEnvios: number | null; enviadosNoTeste: number | null } | null;
  agora: { diaConfiguradoOk: boolean; janelaAberta: boolean; motivoJanela: string | null };
  tetoRestante: number | null;
  resumo: { noEscopo: number; elegiveis: number; excluidos: number; foraDaSelecao: number; elegiveisNoModoNormal: number };
  candidatos: PreviewCandidate[];
  aviso: string;
}

const maskName = (n: string | null) => {
  const parts = (n ?? "").trim().split(/\s+/).filter(Boolean);
  return parts.length === 0 ? "(sem nome)" : parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0]}.`;
};

export async function previewResumeFlow(clinicId: string, flow: typeof RESUME_CANCELLED | typeof RESUME_NOCLOSE, now = new Date()): Promise<ResumePreview> {
  const aviso = "Prévia: nada foi enviado, nenhuma tentativa foi consumida, nenhum registro de controle foi gravado e o juiz de IA não foi consultado (ele decide só na hora do envio).";
  const cfg = await getResumeConfig(clinicId, flow);
  const empty: ResumePreview = { fluxo: flow, configurado: false, ligado: false, temTexto: false, modo: "normal", restricao: null, agora: { diaConfiguradoOk: false, janelaAberta: false, motivoJanela: "fluxo nao configurado" }, tetoRestante: null, resumo: { noEscopo: 0, elegiveis: 0, excluidos: 0, foraDaSelecao: 0, elegiveisNoModoNormal: 0 }, candidatos: [], aviso };
  if (!cfg) return empty;
  const restriction = readRestriction(cfg.guard);
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { timezone: true, workDays: true, workStartHour: true, workEndHour: true, hoursByDay: true, closedOnHolidays: true, holidayOpen: true } });
  const tz = clinic.timezone || "America/Sao_Paulo";
  const wc = wallClockInZone(now, tz);
  const open = openAt({ sendWindowStart: cfg.startHour, sendWindowEnd: cfg.endHour }, { ...clinic, timezone: tz }, now);
  const dayStart = zonedWallClockToUtc(tz, wc.year, wc.month, wc.day, 0, 0);
  const sentToday = await prisma.followUpDispatch.count({ where: { clinicId, flow, state: { in: ["sent", "unconfirmed", "reserved"] }, decidedAt: { gte: dayStart } } });
  let teto = Math.max(0, Math.min(cfg.maxPerRun, cfg.maxPerDay - sentToday));
  let restricao: ResumePreview["restricao"] = null;
  if (restriction.mode === "restrito") {
    if (restriction.valid) {
      const used = await testSendsSoFar(clinicId, flow, restriction.startedAt, true);
      teto = Math.min(teto, Math.max(0, restriction.maxSends - used));
      restricao = { valida: true, problema: null, contatosAutorizados: restriction.patientIds.length, limiteDeEnvios: restriction.maxSends, enviadosNoTeste: used };
    } else {
      restricao = { valida: false, problema: restriction.problem, contatosAutorizados: 0, limiteDeEnvios: null, enviadosNoTeste: null };
    }
  }

  const rec = new RunRecorder("previa", clinicId, now); // descartavel: nunca e salvo
  const all = flow === RESUME_CANCELLED ? await cancelledCandidates(clinicId, cfg, now, rec, { dry: true }) : await noCloseCandidates(clinicId, cfg, now, rec, { dry: true });
  const scope = restriction.mode === "restrito" ? (restriction.valid ? new Set(restriction.patientIds) : new Set<string>()) : null;

  const evaluate = async (cand: Candidate): Promise<PreviewCandidate> => {
    const base = { ref: cand.patient.id, nome: maskName(cand.patient.name), regra: flow, evento: cand.eventAt.toISOString(), procedimento: cand.procedureName };
    const key = { patientId_flow_step_cycleKey: { patientId: cand.patient.id, flow, step: 1, cycleKey: cand.cycleKey } };
    const ledger = await prisma.followUpDispatch.findUnique({ where: key, select: { state: true } });
    const controleExistente = ledger?.state ?? null;
    const ex = await commonExclusion(cand.patient, clinicId, cand.eventAt, now, cand.baseAppointmentId);
    if (ex) return { ...base, situacao: "excluido", motivo: ex.code, definitivo: ex.definitive, controleExistente };
    const compete = await competingContact({ patientId: cand.patient.id, flow, now, minGapMs: MIN_GAP_BETWEEN_AUTOMATED_MS });
    if (compete) return { ...base, situacao: "excluido", motivo: `concorrencia:${compete.code}`, definitivo: false, controleExistente };
    const recent = await prisma.message.findFirst({ where: { role: "assistant", authorName: "Recontato automático", createdAt: { gte: new Date(now.getTime() - 2 * DAY_MS) }, conversation: { patientId: cand.patient.id } }, select: { id: true } });
    if (recent) return { ...base, situacao: "excluido", motivo: "contato_equivalente_recente", definitivo: false, controleExistente };
    if (controleExistente && ["sent", "unconfirmed", "blocked", "duplicate", "failed_permanent", "expired", "skipped"].includes(controleExistente)) return { ...base, situacao: "excluido", motivo: `ja_tratada:${controleExistente}`, definitivo: true, controleExistente };
    return { ...base, situacao: "elegivel", motivo: "passa_nas_regras_de_elegibilidade", definitivo: null, controleExistente };
  };

  const evaluated: { cand: Candidate; row: PreviewCandidate }[] = [];
  for (const cand of all) evaluated.push({ cand, row: await evaluate(cand) });
  const inScope = evaluated.filter((e) => !scope || scope.has(e.cand.patient.id));
  return {
    fluxo: flow, configurado: true, ligado: cfg.enabled, temTexto: !!cfg.message?.trim(), modo: modeOf(restriction), restricao,
    agora: { diaConfiguradoOk: cfg.weekday == null || wc.weekday === cfg.weekday, janelaAberta: open.open, motivoJanela: open.open ? null : open.reason },
    tetoRestante: teto,
    resumo: {
      noEscopo: inScope.length,
      elegiveis: inScope.filter((e) => e.row.situacao === "elegivel").length,
      excluidos: inScope.filter((e) => e.row.situacao === "excluido").length,
      foraDaSelecao: evaluated.length - inScope.length,
      elegiveisNoModoNormal: evaluated.filter((e) => e.row.situacao === "elegivel").length,
    },
    candidatos: inScope.map((e) => e.row),
    aviso,
  };
}

// Pessoas que PODEM ter ficado sem fechar a avaliacao (sugestao para a equipe revisar e marcar; NUNCA dispara sozinha).
export async function suggestNoCloseCandidates(clinicId: string, days = 30, now = new Date()): Promise<{ patientId: string; name: string | null; phone: string; evaluatedAt: Date }[]> {
  const since = new Date(now.getTime() - days * DAY_MS);
  const evals = await prisma.appointment.findMany({
    where: { clinicId, status: "completed", scheduledAt: { gte: since, lte: now }, procedure: { name: { contains: "valia" } } },
    include: { patient: true },
    orderBy: { scheduledAt: "desc" },
    take: 300,
  });
  const out: { patientId: string; name: string | null; phone: string; evaluatedAt: Date }[] = [];
  const seen = new Set<string>();
  for (const e of evals) {
    if (seen.has(e.patientId)) continue;
    seen.add(e.patientId);
    if (e.patient.optedOut || e.patient.noInterest) continue;
    const after = await prisma.appointment.findFirst({ where: { patientId: e.patientId, id: { not: e.id }, OR: [{ scheduledAt: { gte: e.scheduledAt } }, { createdAt: { gte: e.scheduledAt } }], status: { in: ["confirmed", "completed", "no_show"] } }, select: { id: true } });
    if (after) continue;
    out.push({ patientId: e.patientId, name: e.patient.name, phone: e.patient.phone, evaluatedAt: e.scheduledAt });
  }
  return out;
}

export async function markResumeTarget(clinicId: string, patientId: string, by: string | null, note: string | null): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const patient = await prisma.patient.findFirst({ where: { id: patientId, clinicId }, select: { id: true } });
  if (!patient) return { ok: false, error: "pessoa nao encontrada nesta clinica" };
  const existing = await prisma.resumeTarget.findUnique({ where: { patientId_flow: { patientId, flow: RESUME_NOCLOSE } } });
  if (existing && existing.status === "sent" && Date.now() - existing.updatedAt.getTime() < 30 * DAY_MS) return { ok: false, error: "ja recebeu a retomada nos ultimos 30 dias" };
  const row = await prisma.resumeTarget.upsert({
    where: { patientId_flow: { patientId, flow: RESUME_NOCLOSE } },
    create: { clinicId, patientId, flow: RESUME_NOCLOSE, note, markedBy: by, status: "pending" },
    update: { note, markedBy: by, markedAt: new Date(), status: "pending", resultNote: null },
  });
  return { ok: true, id: row.id };
}

export function startResumeFlowsJob(): void {
  scheduleLocked("retomada-avaliacao", "*/15 * * * *", () => runResumeFlows().catch((err) => console.error("Erro nas retomadas de avaliacao:", err)));
}
