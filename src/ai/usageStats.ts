import crypto from "node:crypto";
import { prisma } from "../db/client.js";
import { trackBackground } from "../jobs/background.js";
import { estimateUsd, priceFor, priceTable } from "./pricing.js";

// ---------------------------------------------------------------------------
// ONDE VAO OS TOKENS DA OPENAI. Cada TENTATIVA de chamada (inclusive as que falharam, as correcoes e as reescritas) registra aqui, por finalidade e pelo modelo que a OpenAI
// informou ter usado. O CONSUMO de cada tentativa tem um estado explicito (nunca "falhou = zero"):
//   known     a API devolveu o uso (tokens de entrada / cache / saida);
//   unknown   a requisicao FOI enviada e o consumo nao foi informado (timeout, queda no meio, erro HTTP, resposta sem uso). Pode ter sido cobrada: nao entra no custo e e
//             CONTADA a parte; todo total com tentativa unknown e um PISO (custo conhecido), nunca "o total";
//   not_sent  bloqueada localmente (saldo/credencial), nenhuma requisicao saiu: consumo zero de verdade.
// Duas camadas:
//  1) memoria (desde que o servidor subiu): alimenta o painel do admin de imediato (/api/ai-usage);
//  2) banco (AiCall por tentativa, AiUsageDaily agregado): sobrevive a reinicio. Escrita EM LOTE (a cada poucos segundos ou 50 linhas, uma insercao so), nunca no caminho do
//     atendimento. Fila LIMITADA (MAX_QUEUE): se o banco falhar, o lote volta para a fila (com id proprio, entao reenviar nunca duplica) e, passando do limite, os registros MAIS
//     ANTIGOS sao descartados e CONTADOS (telemetry.dropped, visivel no painel e no log). Linhas por tentativa ficam AI_USAGE_KEEP_DAYS (14) e depois sao SOMADAS no agregado
//     diario e apagadas na MESMA transacao.
// PERDA POSSIVEL: queda brusca do processo (kill -9, falta de energia) perde o que ainda esta na fila em memoria (no maximo ~5 s ou 50 linhas); desligamento limpo (SIGTERM) grava
// o que der em ate 5 s e registra no log quantos ficaram. Nada de conteudo de conversa, credencial ou dado pessoal. Custo aqui e ESTIMADO (tokens x tabela de precos por modelo).
// ---------------------------------------------------------------------------

export interface UsageLike {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
}

export type CallOutcome = "ok" | "error" | "blocked";
export type UsageState = "known" | "unknown" | "not_sent";

export interface CallRecord {
  id?: string; // gerado na entrada da fila: reenviar o mesmo registro nunca duplica
  purpose: string;
  clinicId?: string | null;
  conversationId?: string | null;
  traceId?: string | null;
  requestedModel?: string | null;
  model?: string | null; // o que a API devolveu
  usage?: UsageLike | null;
  usageState?: UsageState; // padrao: known se veio uso; senao unknown (a requisicao saiu)
  durationMs?: number;
  outcome?: CallOutcome;
  errorKind?: string | null;
  attemptReason?: string | null;
  attempt?: number;
  at?: Date;
}

interface Bucket { calls: number; ok: number; errors: number; unknown: number; notSent: number; input: number; cached: number; output: number; durationMs: number }
const emptyBucket = (): Bucket => ({ calls: 0, ok: 0, errors: 0, unknown: 0, notSent: 0, input: 0, cached: 0, output: 0, durationMs: 0 });
const buckets = new Map<string, Bucket>(); // "finalidade\u0000modelo"
const startedAt = new Date();

export const MAX_QUEUE = 2000; // teto de registros esperando para gravar
const BATCH = 500;
const FLUSH_EVERY_MS = 5_000;
const FLUSH_AT = 50;
let queue: (CallRecord & { id: string })[] = [];
let timer: NodeJS.Timeout | null = null;
let flushing: Promise<void> | null = null;
const telemetry = { persisted: 0, dropped: 0, failedBatches: 0, consecutiveFailures: 0, lastError: null as string | null, lastErrorAt: null as string | null, lostOnShutdown: 0 };

export const keepDays = () => Math.max(1, Number(process.env.AI_USAGE_KEEP_DAYS ?? 14) || 14);

export function usageStateOf(r: Pick<CallRecord, "usage" | "usageState" | "outcome">): UsageState {
  if (r.usageState) return r.usageState;
  if (r.outcome === "blocked") return "not_sent";
  return r.usage && (r.usage.prompt_tokens !== undefined || r.usage.completion_tokens !== undefined) ? "known" : "unknown";
}

export function recordCall(r: CallRecord): void {
  try {
    const state = usageStateOf(r);
    const model = (r.model ?? r.requestedModel ?? "") || "";
    const key = `${r.purpose}\u0000${model}`;
    const b = buckets.get(key) ?? emptyBucket();
    const u = state === "known" ? r.usage : null;
    b.calls += 1;
    if (state === "not_sent") b.notSent += 1;
    else if ((r.outcome ?? "ok") === "ok") b.ok += 1;
    else b.errors += 1;
    if (state === "unknown") b.unknown += 1;
    b.input += u?.prompt_tokens ?? 0;
    b.cached += u?.prompt_tokens_details?.cached_tokens ?? 0;
    b.output += u?.completion_tokens ?? 0;
    b.durationMs += r.durationMs ?? 0;
    buckets.set(key, b);
    if (process.env.AI_USAGE_PERSIST === "off") return;
    enqueue({ ...r, usageState: state, id: r.id ?? crypto.randomUUID(), at: r.at ?? new Date() } as CallRecord & { id: string });
    if (queue.length >= FLUSH_AT) void flushUsage();
    else scheduleFlush(FLUSH_EVERY_MS);
  } catch { /* a medicao nunca interrompe o atendimento */ }
}

function enqueue(rec: CallRecord & { id: string }): void {
  queue.push(rec);
  if (queue.length > MAX_QUEUE) {
    const over = queue.length - MAX_QUEUE;
    queue = queue.slice(over); // descarta os MAIS ANTIGOS; a perda fica CONTADA e visivel (telemetry.dropped)
    telemetry.dropped += over;
    if (telemetry.dropped === over || telemetry.dropped % 1000 < over) console.error(`[medicao-ia] fila cheia (${MAX_QUEUE}): ${telemetry.dropped} registro(s) descartado(s) no total; o atendimento nao foi afetado`);
  }
}

// Devolve um lote que nao foi gravado para a frente da fila. Acima do limite, descarta os mais antigos e CONTA.
function requeueFront(batch: (CallRecord & { id: string })[]): void {
  queue = [...batch, ...queue];
  if (queue.length > MAX_QUEUE) {
    const over = queue.length - MAX_QUEUE;
    queue = queue.slice(over);
    telemetry.dropped += over;
  }
}

function scheduleFlush(ms: number): void {
  if (timer) return;
  timer = setTimeout(() => { timer = null; void flushUsage(); }, ms);
  timer.unref?.();
}

// Compatibilidade: chamadas antigas que so informavam a finalidade e o uso.
export function recordUsage(purpose: string, usage: UsageLike | null | undefined, extra: Partial<CallRecord> = {}): void {
  if (!usage) return;
  recordCall({ purpose, usage, ...extra });
}

const toRow = (r: CallRecord & { id: string }) => ({
  id: r.id,
  at: r.at ?? new Date(),
  clinicId: r.clinicId ?? null,
  conversationId: r.conversationId ?? null,
  traceId: r.traceId ?? null,
  purpose: r.purpose.slice(0, 60),
  requestedModel: r.requestedModel?.slice(0, 80) ?? null,
  model: r.model?.slice(0, 80) ?? null,
  inputTokens: r.usageState === "known" ? r.usage?.prompt_tokens ?? 0 : 0,
  cachedTokens: r.usageState === "known" ? r.usage?.prompt_tokens_details?.cached_tokens ?? 0 : 0,
  outputTokens: r.usageState === "known" ? r.usage?.completion_tokens ?? 0 : 0,
  durationMs: Math.max(0, Math.round(r.durationMs ?? 0)),
  outcome: r.outcome ?? "ok",
  usageState: r.usageState ?? "unknown",
  errorKind: r.errorKind ?? null,
  attemptReason: r.attemptReason?.slice(0, 60) ?? null,
  attempt: r.attempt ?? 1,
});

const isUnique = (e: unknown) => (e as { code?: string } | null)?.code === "P2002";

// Uma gravacao que nao responde (banco travado) nao pode prender a fila nem os relatorios para sempre: passado o prazo ela conta como falha e o lote continua na fila.
const writeTimeoutMs = () => Math.max(50, Number(process.env.AI_USAGE_WRITE_TIMEOUT_MS ?? 15_000) || 15_000);
const withDeadline = <T>(p: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => { const t = setTimeout(() => reject(new Error("gravacao da medicao nao respondeu no prazo")), writeTimeoutMs()); t.unref?.(); p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); }); });

// Grava a fila em lotes. Nunca lanca. Falha: o lote VOLTA para a frente da fila (bounded) e uma nova tentativa e agendada com espera crescente. Cada registro tem id proprio,
// entao regravar um lote que na verdade ja entrou (ex.: erro depois do commit) cai em conflito de chave e e tratado como "ja gravado": nunca duplica.
export function flushUsage(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null; }
  if (flushing) return flushing;
  if (queue.length === 0) return Promise.resolve();
  flushing = trackBackground((async () => {
    try {
      while (queue.length > 0) {
        // o lote SAI da fila antes de gravar (nada de fatiar por indice depois do await: a fila pode ter crescido, estourado ou sido trocada enquanto a gravacao estava em curso)
        const batch = queue.splice(0, BATCH);
        try {
          try {
            await withDeadline(prisma.aiCall.createMany({ data: batch.map(toRow) }));
          } catch (err) {
            if (!isUnique(err)) throw err;
            // parte do lote ja estava gravada: insere um a um ignorando so o conflito
            for (const r of batch) {
              try { await withDeadline(prisma.aiCall.create({ data: toRow(r) })); } catch (e) { if (!isUnique(e)) throw e; }
            }
          }
        } catch (err) {
          requeueFront(batch); // volta para a FRENTE da fila (ordem preservada), respeitando o limite
          throw err;
        }
        telemetry.persisted += batch.length;
        telemetry.consecutiveFailures = 0;
      }
    } catch (err) {
      // o lote continua na fila (nao foi removido antes de gravar): a fila ja e limitada
      telemetry.failedBatches += 1;
      telemetry.consecutiveFailures += 1;
      telemetry.lastError = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 160);
      telemetry.lastErrorAt = new Date().toISOString();
      console.error(`[medicao-ia] nao consegui gravar (tentativa ${telemetry.consecutiveFailures}; ${queue.length} na fila; o atendimento nao foi afetado): ${telemetry.lastError}`);
      scheduleFlush(Math.min(5_000 * 2 ** Math.min(telemetry.consecutiveFailures, 4), 80_000));
    } finally {
      flushing = null;
    }
  })());
  return flushing;
}

// Desligamento limpo: tenta gravar o que esta na fila por NO MAXIMO `timeoutMs`; o que sobrar e contado e registrado no log (nao trava o desligamento).
export async function flushUsageWithin(timeoutMs = 5_000): Promise<{ remaining: number }> {
  const deadline = Date.now() + timeoutMs;
  while (queue.length > 0 && Date.now() < deadline) {
    const left = deadline - Date.now();
    await Promise.race([flushUsage(), new Promise((r) => setTimeout(r, left))]);
    if (queue.length > 0 && telemetry.consecutiveFailures > 0) break; // banco falhando: nao insiste ate o prazo
  }
  if (queue.length > 0) {
    telemetry.lostOnShutdown += queue.length;
    console.error(`[medicao-ia] desligamento: ${queue.length} registro(s) de medicao NAO foram gravados (banco indisponivel ou prazo de ${timeoutMs} ms); o atendimento nao foi afetado`);
  }
  return { remaining: queue.length };
}

export function telemetryStatus() {
  return { queued: queue.length, maxQueue: MAX_QUEUE, persisted: telemetry.persisted, dropped: telemetry.dropped, failedBatches: telemetry.failedBatches, lostOnShutdown: telemetry.lostOnShutdown, lastError: telemetry.lastError, lastErrorAt: telemetry.lastErrorAt, complete: telemetry.dropped === 0 && telemetry.lostOnShutdown === 0 };
}

// Soma no agregado diario as linhas por tentativa mais antigas que `keepDays` e as apaga, na MESMA transacao: ou entra tudo (agregado + exclusao) ou nada. Idempotente e segura contra
// duas execucoes ao mesmo tempo: o agregado so recebe o que ESTA transacao apagou (contagem conferida); se outra execucao ja levou as linhas, esta desfaz e nao soma nada.
export async function pruneAiUsage(now = new Date()): Promise<{ rolledUp: number }> {
  await flushUsage();
  const cutoff = new Date(now.getTime() - keepDays() * 24 * 3_600_000);
  let total = 0;
  for (let round = 0; round < 20; round++) {
    const rows = await prisma.aiCall.findMany({
      where: { at: { lt: cutoff } },
      select: { id: true },
      take: 5_000,
    });
    if (rows.length === 0) break;
    let moved = 0;
    try {
      moved = await prisma.$transaction(async (tx) => {
        const full = await tx.aiCall.findMany({ where: { id: { in: rows.map((r) => r.id) } } });
        const del = await tx.aiCall.deleteMany({ where: { id: { in: full.map((r) => r.id) } } });
        if (del.count !== full.length) throw new Error("outra execucao levou estas linhas: desfazendo sem somar");
        const agg = new Map<string, { day: string; clinicId: string; purpose: string; model: string; calls: number; ok: number; err: number; unk: number; ns: number; i: number; c: number; o: number; d: number }>();
        for (const r of full) {
          const day = r.at.toISOString().slice(0, 10);
          const k = `${day}|${r.clinicId ?? ""}|${r.purpose}|${r.model ?? ""}`;
          const a = agg.get(k) ?? { day, clinicId: r.clinicId ?? "", purpose: r.purpose, model: r.model ?? "", calls: 0, ok: 0, err: 0, unk: 0, ns: 0, i: 0, c: 0, o: 0, d: 0 };
          a.calls++;
          if (r.usageState === "not_sent") a.ns++; else if (r.outcome === "ok") a.ok++; else a.err++;
          if (r.usageState === "unknown") a.unk++;
          a.i += r.inputTokens; a.c += r.cachedTokens; a.o += r.outputTokens; a.d += r.durationMs;
          agg.set(k, a);
        }
        for (const a of agg.values()) {
          await tx.aiUsageDaily.upsert({
            where: { day_clinicId_purpose_model: { day: a.day, clinicId: a.clinicId, purpose: a.purpose, model: a.model } },
            create: { day: a.day, clinicId: a.clinicId, purpose: a.purpose, model: a.model, calls: a.calls, okCalls: a.ok, errorCalls: a.err, unknownCalls: a.unk, notSentCalls: a.ns, inputTokens: a.i, cachedTokens: a.c, outputTokens: a.o, durationMs: a.d },
            update: { calls: { increment: a.calls }, okCalls: { increment: a.ok }, errorCalls: { increment: a.err }, unknownCalls: { increment: a.unk }, notSentCalls: { increment: a.ns }, inputTokens: { increment: a.i }, cachedTokens: { increment: a.c }, outputTokens: { increment: a.o }, durationMs: { increment: a.d } },
          });
        }
        return full.length;
      }, { timeout: 30_000 });
    } catch (err) {
      console.warn(`[medicao-ia] agregacao desfeita (nada foi somado nem apagado): ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`);
      break;
    }
    total += moved;
    if (rows.length < 5_000) break;
  }
  return { rolledUp: total };
}

export interface PurposeRow {
  purpose: string;
  calls: number; // todas as tentativas registradas (inclui bloqueadas localmente)
  okCalls: number;
  errorCalls: number; // requisicoes enviadas que falharam
  notSentCalls: number; // bloqueadas localmente: nenhuma requisicao, consumo zero
  unknownUsageCalls: number; // enviadas SEM consumo informado: podem ter sido cobradas
  input: number; // tokens conhecidos
  cached: number;
  output: number;
  cacheRate: number;
  avgInput: number;
  avgDurationMs: number;
  estimatedUsd: number | null; // custo CONHECIDO e estimado (null = nenhum modelo desta finalidade tem preco)
  unpricedCalls: number;
  complete: boolean; // false = ha tentativas com consumo desconhecido ou sem preco: os totais sao um PISO
  costNote: string | null;
  models: { model: string; calls: number; input: number; cached: number; output: number; estimatedUsd: number | null }[];
}

function summarize(entries: { purpose: string; model: string; b: Bucket }[]): PurposeRow[] {
  const by = new Map<string, PurposeRow>();
  for (const { purpose, model, b } of entries) {
    const usd = estimateUsd(model, { input: b.input, cached: b.cached, output: b.output });
    const row = by.get(purpose) ?? { purpose, calls: 0, okCalls: 0, errorCalls: 0, notSentCalls: 0, unknownUsageCalls: 0, input: 0, cached: 0, output: 0, cacheRate: 0, avgInput: 0, avgDurationMs: 0, estimatedUsd: null, unpricedCalls: 0, complete: true, costNote: null, models: [] };
    row.calls += b.calls; row.okCalls += b.ok; row.errorCalls += b.errors; row.notSentCalls += b.notSent; row.unknownUsageCalls += b.unknown;
    row.input += b.input; row.cached += b.cached; row.output += b.output; row.avgDurationMs += b.durationMs;
    if (usd === null) row.unpricedCalls += Math.max(b.ok - b.unknown, 0); // chamadas com uso conhecido de modelo sem preco
    else row.estimatedUsd = (row.estimatedUsd ?? 0) + usd;
    row.models.push({ model: model || "(nao informado)", calls: b.calls, input: b.input, cached: b.cached, output: b.output, estimatedUsd: usd === null ? null : Number(usd.toFixed(6)) });
    by.set(purpose, row);
  }
  return [...by.values()].map((r) => {
    const unpricedModels = [...new Set(r.models.filter((m) => priceFor(m.model) === null && m.input + m.output > 0).map((m) => m.model))];
    const notes: string[] = [];
    if (unpricedModels.length) notes.push(`custo nao calculado: modelo sem preco conhecido (${unpricedModels.join(", ")})`);
    if (r.unknownUsageCalls) notes.push(`${r.unknownUsageCalls} tentativa(s) enviada(s) com consumo DESCONHECIDO (timeout/erro/sem uso): fora do custo, que e um piso`);
    return {
      ...r,
      cacheRate: r.input ? Math.round((r.cached / r.input) * 100) : 0,
      avgInput: r.okCalls - r.unknownUsageCalls > 0 ? Math.round(r.input / (r.okCalls - r.unknownUsageCalls)) : 0,
      avgDurationMs: r.calls ? Math.round(r.avgDurationMs / r.calls) : 0,
      estimatedUsd: r.estimatedUsd === null ? null : Number(r.estimatedUsd.toFixed(6)),
      unpricedCalls: unpricedModels.length ? r.unpricedCalls : 0,
      complete: notes.length === 0,
      costNote: notes.length ? notes.join("; ") : null,
    };
  }).sort((a, b) => (b.estimatedUsd ?? -1) - (a.estimatedUsd ?? -1) || b.calls - a.calls);
}

const NOTE = "Custo ESTIMADO (tokens x tabela de precos por modelo, ver pricing.ts); NAO e a cobranca real, que so a fatura/painel de uso da OpenAI mostra. O total e o custo CONHECIDO: tentativas enviadas sem consumo informado (timeout, erro) nao entram e sao contadas em 'unknownUsageCalls'; quando houver, 'totalIsComplete' e false. 'cacheRate' = parte da entrada reaproveitada do cache.";

function totals(purposes: PurposeRow[]) {
  const unknown = purposes.reduce((s, p) => s + p.unknownUsageCalls, 0);
  const unpriced = purposes.reduce((s, p) => s + p.unpricedCalls, 0);
  const tel = telemetryStatus();
  return {
    totalEstimatedUsd: Number(purposes.reduce((s, p) => s + (p.estimatedUsd ?? 0), 0).toFixed(6)), // custo CONHECIDO
    unknownUsageCalls: unknown,
    notSentCalls: purposes.reduce((s, p) => s + p.notSentCalls, 0),
    unpricedCalls: unpriced,
    totalIsComplete: unknown === 0 && unpriced === 0 && tel.complete,
    totalNote: unknown === 0 && unpriced === 0 && tel.complete
      ? "Sem lacunas conhecidas nesta medicao."
      : `Total PARCIAL (piso): ${unknown} tentativa(s) enviada(s) com consumo desconhecido, ${unpriced} chamada(s) sem preco${tel.complete ? "" : `, ${tel.dropped + tel.lostOnShutdown} registro(s) de medicao perdido(s)`}.`,
  };
}

// Desde que o servidor subiu (memoria). Mantem o formato antigo e acrescenta o que falta.
export function usageSnapshot() {
  const purposes = summarize([...buckets.entries()].map(([k, b]) => { const [purpose, model] = k.split("\u0000"); return { purpose, model, b }; }));
  return {
    since: startedAt.toISOString(),
    note: NOTE,
    billedUsd: null as number | null, // cobranca real: nao disponivel aqui
    billedNote: "Cobranca real indisponivel nesta tela: confira a fatura/painel de uso da OpenAI.",
    ...totals(purposes),
    telemetry: telemetryStatus(),
    secondReading: readingDecisionSnapshot(),
    purposes,
    priceTable: Object.fromEntries(Object.entries(priceTable()).map(([m, p]) => [m, { input: p.input, cachedInput: p.cachedInput, output: p.output, source: p.source, checkedAt: p.checkedAt }])),
  };
}

// UTC: inicio do dia de `now` menos (days-1) dias. As duas partes do relatorio (agregado diario e linhas recentes) usam ESTE mesmo limite, entao um registro nunca e contado
// nas duas nem escapa das duas: ele esta em AiCall (ainda nao somado) OU em AiUsageDaily (ja somado e apagado de AiCall), nunca nos dois (mesma transacao).
export function reportWindowStart(now: Date, days: number): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return new Date(d.getTime() - (Math.min(Math.max(days, 1), 365) - 1) * 24 * 3_600_000);
}

// Periodo persistido (AiUsageDaily + AiCall recente): sobrevive a reinicio. `days` = dias UTC inteiros, contando o de hoje; `clinicId` opcional.
export async function persistedReport(opts: { days?: number; clinicId?: string | null; now?: Date } = {}) {
  await flushUsage();
  const now = opts.now ?? new Date();
  const days = Math.min(Math.max(opts.days ?? 7, 1), 365);
  const from = reportWindowStart(now, days);
  const dayFrom = from.toISOString().slice(0, 10);
  const clinicWhere = opts.clinicId ? { clinicId: opts.clinicId } : {};
  const [daily, recent] = await Promise.all([
    prisma.aiUsageDaily.findMany({ where: { day: { gte: dayFrom }, ...clinicWhere } }),
    prisma.aiCall.groupBy({ by: ["purpose", "model", "outcome", "usageState"], where: { at: { gte: from }, ...clinicWhere }, _count: { _all: true }, _sum: { inputTokens: true, cachedTokens: true, outputTokens: true, durationMs: true } }),
  ]);
  const map = new Map<string, Bucket>();
  const add = (purpose: string, model: string, v: Partial<Bucket>) => {
    const k = `${purpose}\u0000${model}`;
    const b = map.get(k) ?? emptyBucket();
    for (const key of Object.keys(v) as (keyof Bucket)[]) b[key] += v[key] ?? 0;
    map.set(k, b);
  };
  for (const d of daily) add(d.purpose, d.model, { calls: d.calls, ok: d.okCalls, errors: d.errorCalls, unknown: d.unknownCalls, notSent: d.notSentCalls, input: d.inputTokens, cached: d.cachedTokens, output: d.outputTokens, durationMs: d.durationMs });
  for (const r of recent) {
    const n = r._count._all;
    add(r.purpose, r.model ?? "", { calls: n, notSent: r.usageState === "not_sent" ? n : 0, ok: r.usageState !== "not_sent" && r.outcome === "ok" ? n : 0, errors: r.usageState !== "not_sent" && r.outcome !== "ok" ? n : 0, unknown: r.usageState === "unknown" ? n : 0, input: r._sum.inputTokens ?? 0, cached: r._sum.cachedTokens ?? 0, output: r._sum.outputTokens ?? 0, durationMs: r._sum.durationMs ?? 0 });
  }
  const purposes = summarize([...map.entries()].map(([k, b]) => { const [purpose, model] = k.split("\u0000"); return { purpose, model, b }; }));
  return { days, from: from.toISOString(), note: NOTE, billedUsd: null as number | null, ...totals(purposes), telemetry: telemetryStatus(), purposes };
}

// Chamadas (tentativas) de UM atendimento, na ordem: quantas foram necessarias, quantas foram correcao e quantas foram nova tentativa, com a soma de entrada e saida.
export async function traceReport(traceId: string) {
  await flushUsage();
  const rows = await prisma.aiCall.findMany({ where: { traceId }, orderBy: { at: "asc" } });
  const usd = rows.reduce((s, r) => s + (estimateUsd(r.model ?? r.requestedModel, { input: r.inputTokens, cached: r.cachedTokens, output: r.outputTokens }) ?? 0), 0);
  const kinds = { answer: 0, tool: 0, correction: 0, retry: 0, other: 0 };
  for (const r of rows) {
    const reason = r.attemptReason ?? "";
    if (reason === "answer") kinds.answer++; else if (reason === "tool_result") kinds.tool++; else if (reason.startsWith("correction")) kinds.correction++; else if (reason.startsWith("retry") || reason === "fallback_model") kinds.retry++; else kinds.other++;
  }
  const unknown = rows.filter((r) => r.usageState === "unknown").length;
  return {
    traceId, attempts: rows.length, ...kinds,
    unknownUsageCalls: unknown, notSentCalls: rows.filter((r) => r.usageState === "not_sent").length,
    input: rows.reduce((s, r) => s + r.inputTokens, 0), output: rows.reduce((s, r) => s + r.outputTokens, 0),
    estimatedUsd: Number(usd.toFixed(6)), complete: unknown === 0, rows,
  };
}

export function resetUsageForTests(): void {
  buckets.clear();
  queue = [];
  telemetry.persisted = 0; telemetry.dropped = 0; telemetry.failedBatches = 0; telemetry.consecutiveFailures = 0; telemetry.lastError = null; telemetry.lastErrorAt = null; telemetry.lostOnShutdown = 0;
  if (timer) { clearTimeout(timer); timer = null; }
  readingDecisions.executed.clear();
  readingDecisions.skipped.clear();
}

// ---------------------------------------------------------------------------
// DECISOES DA SEGUNDA LEITURA (executada x dispensada, e por que). Contador em memoria + log; nao ha linha por decisao no banco (a chamada executada ja aparece em AiCall).
// ---------------------------------------------------------------------------
const readingDecisions = { executed: new Map<string, number>(), skipped: new Map<string, number>() };
export function noteReadingDecision(run: boolean, reason: string): void {
  const m = run ? readingDecisions.executed : readingDecisions.skipped;
  m.set(reason, (m.get(reason) ?? 0) + 1);
}
export function readingDecisionSnapshot() {
  const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  return { executed: sum(readingDecisions.executed), skipped: sum(readingDecisions.skipped), executedBy: Object.fromEntries(readingDecisions.executed), skippedBy: Object.fromEntries(readingDecisions.skipped) };
}
