import { prisma } from "../db/client.js";
import { REVISION } from "../version.js";

// ---------------------------------------------------------------------------
// CONTROLE PERSISTENTE DOS RECONTATOS E RETOMADAS (FollowUpDispatch). Uma linha por (pessoa, fluxo, etapa, ciclo), reservada de forma ATOMICA (indice
// unico do banco) antes de qualquer envio. Cobre: duas rodadas do job, duas copias do servidor, reinicio no meio do envio e o historico do que a
// Alice DECIDIU (camada, motivo, se pode ser reavaliado) - antes, "o recontato nao saiu" nao deixava nenhum rastro.
//
// Ciclo:  (nada) -> reserved -> sent | unconfirmed | blocked | duplicate | failed_permanent | expired | skipped        (desfechos que CONSOMEM a etapa)
//                       \-> vetoed (a revisao por IA disse nao: TEMPORARIO, reavalia quando o contexto muda ou depois de 6 h; 2 vetos = definitivo)
//                       \-> failed (falha definitiva do envio, nada saiu: tenta de novo com intervalo e teto)
//         (nada) -> deferred (juiz de IA indisponivel / conferencia inconclusiva: NAO e decisao de negocio; tenta de novo)
// "reserved" sem desfecho (o processo caiu no meio) vira "unconfirmed": pode ter saido, entao NUNCA reenvia as cegas.
// ---------------------------------------------------------------------------

export type FlowKind = "recontato" | "avaliacao_cancelada" | "avaliacao_sem_fechamento" | "pesquisa" | "indicacao";
export type FlowState = "deferred" | "reserved" | "sent" | "unconfirmed" | "blocked" | "vetoed" | "duplicate" | "failed" | "failed_permanent" | "expired" | "skipped";

export const MAX_VETOES = 2;
export const VETO_RETRY_MS = 6 * 3_600_000;
export const DEFER_RETRY_MS = 15 * 60_000;
export const MAX_DEFERRALS = 8;
export const MAX_SEND_ATTEMPTS = 3;
export const FAIL_GAP_MS = 10 * 60_000;
export const STALE_RESERVED_MS = 30 * 60_000;

export interface FlowKey {
  clinicId: string;
  patientId: string;
  conversationId: string | null;
  flow: FlowKind;
  ruleId: string | null;
  step: number;
  cycleKey: string; // identifica o evento de origem: ultima mensagem da pessoa (recontato) ou a reserva (retomada)
  dueAt: Date | null;
}

export interface DecisionMeta {
  layer?: string; // janela | expediente | elegibilidade | concorrencia | juiz_ia | revisao_envio | envio | politica
  reason?: string; // curto, SEM conteudo da conversa
  temporary?: boolean;
  reevaluateAt?: Date | null;
  fingerprint?: string | null;
  at?: Date; // relogio da rodada (padrao: agora)
  runMode?: string; // normal | restrito (validacao controlada): fica gravado em cada decisao
}

export type FlowAcquire =
  | { ok: true; id: string; attempt: number; vetoes: number } // vetoes = vetos ANTES desta tentativa (o proximo veto e o de numero vetoes + 1)
  | { ok: false; why: "already_handled" | "in_progress" | "too_soon" | "exhausted"; state?: string };

const isUnique = (e: unknown) => (e as { code?: string } | null)?.code === "P2002";
const CONSUMED: FlowState[] = ["sent", "unconfirmed", "blocked", "duplicate", "failed_permanent", "expired", "skipped"];

const cut = (s: string | undefined | null, n = 200) => (s ? s.slice(0, n) : null);

const where = (k: FlowKey) => ({ patientId_flow_step_cycleKey: { patientId: k.patientId, flow: k.flow, step: k.step, cycleKey: k.cycleKey } });

// Reserva de forma atomica. Nao envia nada. Falha com o motivo quando outra rodada ja cuidou disto ou ainda nao e hora de tentar de novo.
export async function acquireFlow(key: FlowKey, fingerprint: string | null, now = new Date(), runMode?: string): Promise<FlowAcquire> {
  try {
    const row = await prisma.followUpDispatch.create({ data: { ...key, state: "reserved", attempt: 1, fingerprint, version: REVISION.split(":")[0], decidedAt: now, ...(runMode ? { runMode } : {}) } });
    return { ok: true, id: row.id, attempt: 1, vetoes: 0 };
  } catch (e) {
    if (!isUnique(e)) throw e;
  }
  const row = await prisma.followUpDispatch.findUnique({ where: where(key) });
  if (!row) return { ok: false, why: "in_progress" };

  if (row.state === "reserved") {
    // Quem reservou pode estar enviando agora. Se ficou muito tempo assim, o processo caiu: desfecho desconhecido, nunca reenvia.
    if (now.getTime() - row.updatedAt.getTime() > STALE_RESERVED_MS) {
      await prisma.followUpDispatch.updateMany({ where: { id: row.id, state: "reserved" }, data: { state: "unconfirmed", layer: "envio", reason: "reserva sem desfecho (processo caiu no envio): pode ter saido, nao reenviado", temporary: false } });
      return { ok: false, why: "already_handled", state: "unconfirmed" };
    }
    return { ok: false, why: "in_progress", state: "reserved" };
  }
  if (CONSUMED.includes(row.state as FlowState)) return { ok: false, why: "already_handled", state: row.state };

  let allowed = false;
  if (row.state === "vetoed") {
    if (row.vetoes >= MAX_VETOES) return { ok: false, why: "exhausted", state: row.state };
    const changed = !!fingerprint && !!row.fingerprint && fingerprint !== row.fingerprint; // o contexto mudou: reavalia agora
    allowed = changed || (!!row.reevaluateAt && now.getTime() >= row.reevaluateAt.getTime());
  } else if (row.state === "deferred") {
    if (row.deferrals >= MAX_DEFERRALS) return { ok: false, why: "exhausted", state: row.state };
    allowed = !row.reevaluateAt || now.getTime() >= row.reevaluateAt.getTime() || (!!fingerprint && !!row.fingerprint && fingerprint !== row.fingerprint);
  } else if (row.state === "failed") {
    if (row.failures >= MAX_SEND_ATTEMPTS) return { ok: false, why: "exhausted", state: row.state };
    allowed = !row.reevaluateAt || now.getTime() >= row.reevaluateAt.getTime();
  }
  if (!allowed) return { ok: false, why: "too_soon", state: row.state };
  // So uma rodada vence a disputa: a que troca o estado antigo por reserved.
  const claimed = await prisma.followUpDispatch.updateMany({
    where: { id: row.id, state: row.state, updatedAt: row.updatedAt },
    data: { state: "reserved", attempt: { increment: 1 }, fingerprint, dueAt: key.dueAt, decidedAt: now, ...(runMode ? { runMode } : {}) },
  });
  return claimed.count === 1 ? { ok: true, id: row.id, attempt: row.attempt + 1, vetoes: row.vetoes } : { ok: false, why: "in_progress", state: row.state };
}

export async function finishFlow(id: string, state: FlowState, meta: DecisionMeta = {}): Promise<void> {
  await prisma.followUpDispatch
    .update({
      where: { id },
      data: {
        state,
        layer: meta.layer ?? null,
        reason: cut(meta.reason),
        temporary: meta.temporary ?? false,
        reevaluateAt: meta.reevaluateAt ?? null,
        ...(meta.fingerprint !== undefined ? { fingerprint: meta.fingerprint } : {}),
        ...(meta.runMode ? { runMode: meta.runMode } : {}),
        version: REVISION.split(":")[0],
        decidedAt: meta.at ?? new Date(),
        // cada tipo de desfecho tem o PROPRIO contador (um veto nao gasta tentativa de envio e vice-versa)
        ...(state === "vetoed" ? { vetoes: { increment: 1 } } : state === "deferred" ? { deferrals: { increment: 1 } } : state === "failed" ? { failures: { increment: 1 } } : {}),
      },
    })
    .catch((err) => console.error(`[recontato] nao consegui gravar o estado "${state}" do controle ${id}:`, err instanceof Error ? err.message : err));
}

// Registra uma decisao que NAO passou pela reserva (etapa expirada, pulada por politica, juiz indisponivel...). Nunca sobrescreve um desfecho que consumiu a etapa.
export async function recordFlowDecision(key: FlowKey, state: FlowState, meta: DecisionMeta = {}): Promise<{ created: boolean }> {
  const data = {
    state,
    layer: meta.layer ?? null,
    reason: cut(meta.reason),
    temporary: meta.temporary ?? false,
    reevaluateAt: meta.reevaluateAt ?? null,
    fingerprint: meta.fingerprint ?? null,
    ...(meta.runMode ? { runMode: meta.runMode } : {}),
    version: REVISION.split(":")[0],
    decidedAt: meta.at ?? new Date(),
  };
  try {
    await prisma.followUpDispatch.create({ data: { ...key, attempt: 1, ...data } });
    return { created: true };
  } catch (e) {
    if (!isUnique(e)) throw e;
  }
  const row = await prisma.followUpDispatch.findUnique({ where: where(key) });
  if (!row || CONSUMED.includes(row.state as FlowState) || row.state === "reserved") return { created: false };
  await prisma.followUpDispatch.updateMany({ where: { id: row.id, state: row.state, updatedAt: row.updatedAt }, data: { ...data, attempt: row.attempt + (state === "deferred" ? 1 : 0), ...(state === "deferred" ? { deferrals: { increment: 1 } } : {}) } });
  return { created: false };
}

export interface DayStats {
  flow: string;
  enviados: number;
  naoConfirmados: number;
  barradosTemporarios: number;
  barradosDefinitivos: number;
  adiados: number;
  falhas: number;
  janelaPerdida: number;
  pulados: number;
}

// O que o sistema REGISTROU (nao so o que foi tentado) no periodo, por fluxo. "Enviado" = o provedor aceitou; tentativa barrada/adiada/falha nao entra nessa conta.
export async function dayStats(clinicId: string, from: Date, to: Date): Promise<DayStats[]> {
  const rows = await prisma.followUpDispatch.groupBy({ by: ["flow", "state", "temporary"], where: { clinicId, decidedAt: { gte: from, lt: to } }, _count: { _all: true } });
  const by = new Map<string, DayStats>();
  for (const r of rows) {
    const s = by.get(r.flow) ?? { flow: r.flow, enviados: 0, naoConfirmados: 0, barradosTemporarios: 0, barradosDefinitivos: 0, adiados: 0, falhas: 0, janelaPerdida: 0, pulados: 0 };
    const n = r._count._all;
    if (r.state === "sent") s.enviados += n;
    else if (r.state === "unconfirmed") s.naoConfirmados += n;
    else if (r.state === "vetoed") (r.temporary ? (s.barradosTemporarios += n) : (s.barradosDefinitivos += n));
    else if (r.state === "deferred") s.adiados += n;
    else if (r.state === "failed" || r.state === "failed_permanent") s.falhas += n;
    else if (r.state === "expired") s.janelaPerdida += n;
    else if (r.state === "skipped" || r.state === "blocked" || r.state === "duplicate") s.pulados += n;
    by.set(r.flow, s);
  }
  return [...by.values()];
}

// "Impressao digital" do contexto que importa para decidir um recontato: se qualquer parte muda, decisoes temporarias e veredictos em cache deixam de valer.
export async function conversationFingerprint(conversationId: string, patientId: string): Promise<string> {
  const [last, conv, patient, upcoming, lastAppt] = await Promise.all([
    prisma.message.findFirst({ where: { conversationId, role: { in: ["user", "assistant", "human"] } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    prisma.conversation.findUnique({ where: { id: conversationId }, select: { humanTakeover: true, staffTouchedAt: true } }),
    prisma.patient.findUnique({ where: { id: patientId }, select: { optedOut: true, noInterest: true, callbackAt: true, funnelStage: true } }),
    prisma.appointment.count({ where: { patientId, status: "confirmed", scheduledAt: { gte: new Date() } } }),
    prisma.appointment.findFirst({ where: { patientId }, orderBy: { createdAt: "desc" }, select: { createdAt: true, status: true } }),
  ]);
  return [
    last?.createdAt.getTime() ?? 0,
    conv?.humanTakeover ? 1 : 0,
    conv?.staffTouchedAt?.getTime() ?? 0,
    patient?.optedOut ? 1 : 0,
    patient?.noInterest ? 1 : 0,
    patient?.callbackAt?.getTime() ?? 0,
    patient?.funnelStage ?? "",
    upcoming,
    lastAppt ? `${lastAppt.createdAt.getTime()}:${lastAppt.status}` : "-",
  ].join("|");
}

// ---------------------------------------------------------------------------
// COORDENACAO ENTRE AUTOMACOES: no momento de enviar, outra automacao ja falou com esta pessoa? Ordem de prioridade (a de cima vence):
//   atendimento/agendamento em curso > retorno combinado com a pessoa > fluxo especifico (retomada de avaliacao) > recontato generico.
// O fluxo generico nunca acompanha um fluxo especifico da mesma pessoa; duas mensagens automaticas nunca saem coladas.
// ---------------------------------------------------------------------------
const FLOW_PRIORITY: Record<FlowKind, number> = { avaliacao_cancelada: 2, avaliacao_sem_fechamento: 2, recontato: 1, pesquisa: 1, indicacao: 1 };

export async function competingContact(p: { patientId: string; flow: FlowKind; now: Date; minGapMs: number }): Promise<{ code: string; detail: string } | null> {
  const since = new Date(p.now.getTime() - p.minGapMs);
  const [patient, recentAuto, otherFlows, reminders, upcoming] = await Promise.all([
    prisma.patient.findUnique({ where: { id: p.patientId }, select: { callbackAt: true } }),
    prisma.message.findFirst({
      where: { role: "assistant", authorName: { not: null }, createdAt: { gte: since }, conversation: { patientId: p.patientId } },
      orderBy: { createdAt: "desc" },
      select: { authorName: true },
    }),
    prisma.followUpDispatch.findMany({
      where: { patientId: p.patientId, flow: { not: p.flow }, state: { in: ["reserved", "sent", "unconfirmed"] }, decidedAt: { gte: new Date(p.now.getTime() - 7 * 24 * 3_600_000) } },
      select: { flow: true, state: true, updatedAt: true },
    }),
    prisma.reminderDispatch.findFirst({
      where: { patientId: p.patientId, state: { in: ["reserved", "sent", "unconfirmed"] }, updatedAt: { gte: since } },
      select: { kind: true },
    }),
    prisma.appointment.findFirst({ where: { patientId: p.patientId, status: "confirmed", scheduledAt: { gte: p.now } }, select: { id: true } }),
  ]);
  // a etapa anterior do MESMO fluxo saiu (ou ficou sem confirmacao) ha pouco: nunca duas etapas coladas (resultado incerto nao deixa mensagem no chat, entao so o controle prova)
  const recentSameFlow = await prisma.followUpDispatch.findFirst({ where: { patientId: p.patientId, flow: p.flow, state: { in: ["sent", "unconfirmed", "reserved"] }, decidedAt: { gte: since, lte: p.now } }, select: { state: true } });
  if (recentSameFlow) return { code: "etapa_anterior_recente", detail: `a etapa anterior deste fluxo foi ${recentSameFlow.state === "sent" ? "enviada" : "tentada (sem confirmacao do resultado)"} ha menos de ${Math.round(p.minGapMs / 3_600_000)}h: etapas nao saem coladas` };
  if (upcoming) return { code: "agendamento_em_curso", detail: "a pessoa tem horario marcado: o contato de venda/retomada nao cabe" };
  if (patient?.callbackAt && patient.callbackAt.getTime() > p.now.getTime()) return { code: "retorno_combinado_futuro", detail: "a pessoa pediu para ser chamada numa data futura" };
  if (reminders) return { code: "lembrete_recente", detail: `lembrete/confirmacao (${reminders.kind}) enviado ha pouco` };
  if (recentAuto) return { code: "automacao_recente", detail: `outra mensagem automatica (${recentAuto.authorName}) saiu nas ultimas ${Math.round(p.minGapMs / 3_600_000)}h` };
  const higher = otherFlows.find((o) => FLOW_PRIORITY[o.flow as FlowKind] > FLOW_PRIORITY[p.flow]);
  if (higher) return { code: "fluxo_especifico_em_andamento", detail: `o fluxo ${higher.flow} ja tratou esta pessoa (${higher.state}): o generico nao acompanha` };
  const sameLevel = otherFlows.find((o) => FLOW_PRIORITY[o.flow as FlowKind] === FLOW_PRIORITY[p.flow]);
  if (sameLevel && FLOW_PRIORITY[p.flow] === 2) return { code: "outro_fluxo_especifico", detail: `o fluxo ${sameLevel.flow} ja tratou esta pessoa (${sameLevel.state})` };
  return null;
}
