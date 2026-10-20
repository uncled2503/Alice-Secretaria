import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import type OpenAI from "openai";
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { recordCall, type UsageState } from "./usageStats.js";

// ---------------------------------------------------------------------------
// TODA CHAMADA A OPENAI PASSA POR AQUI. Tres coisas que antes estavam espalhadas (ou faltavam):
//  1) MEDICAO: cada tentativa (inclusive correcao, reescrita e nova tentativa) e registrada com finalidade, modelo devolvido, tokens, duracao, resultado e o motivo da chamada;
//     o contexto (clinica, conversa e o "atendimento" = traceId) vem de um contexto assincrono, entao as funcoes auxiliares nao precisam receber nada. O CONSUMO tem estado
//     explicito: known (a API informou), unknown (a requisicao saiu e nao veio uso: timeout, erro, resposta sem uso; pode ter sido cobrada) ou not_sent (bloqueada localmente);
//  2) CLASSIFICACAO DO ERRO: saldo esgotado / credencial invalida x limite temporario x indisponibilidade x modelo incompativel x timeout;
//  3) TENTATIVAS EM UM SO LUGAR: o SDK fica com maxRetries 0 e a aplicacao decide. Saldo esgotado e credencial invalida NUNCA sao repetidos (a propria OpenAI diz que repetir nao
//     restaura o acesso). O bloqueio e POR CREDENCIAL (impressao digital da chave, nunca a chave): chaves independentes nao se bloqueiam. Passado o intervalo
//     (AI_BLOCK_COOLDOWN_MS, 5 min) UMA unica chamada por credencial vira a tentativa de recuperacao - a proxima chamada REAL e util que chegar, nunca uma chamada artificial paga -
//     e as demais continuam bloqueadas ate ela terminar. Limite temporario (429) e indisponibilidade (5xx) tentam de novo uma vez, respeitando Retry-After. Timeout NAO e
//     repetido (a chamada pode ter sido cobrada). Modelo incompativel nao e repetido no mesmo modelo.
// ---------------------------------------------------------------------------

export interface AiContext { clinicId?: string | null; conversationId?: string | null; traceId?: string | null }
const als = new AsyncLocalStorage<AiContext>();
export const newTraceId = (): string => crypto.randomBytes(6).toString("hex");
export function runWithAiContext<T>(ctx: AiContext, fn: () => Promise<T>): Promise<T> {
  return als.run({ ...(als.getStore() ?? {}), ...ctx }, fn);
}
export const aiContext = (): AiContext => als.getStore() ?? {};

export type OpenAiErrorKind = "quota" | "auth" | "rate_limit" | "unavailable" | "timeout" | "model" | "bad_request" | "other";

export interface ClassifiedError { kind: OpenAiErrorKind; retryable: boolean; retryAfterMs: number | null; status: number | null; code: string | null }

const QUOTA_CODES = new Set(["insufficient_quota", "credit_balance_exhausted", "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "organization_usage_limit_exceeded", "billing_hard_limit_reached"]);

// PURO: o que o erro do SDK significa. Nunca lanca.
export function classifyOpenAiError(err: unknown): ClassifiedError {
  const e = (err ?? {}) as { status?: number; code?: string | null; type?: string | null; name?: string; message?: string; headers?: Record<string, string> | { get?: (k: string) => string | null } };
  const status = typeof e.status === "number" ? e.status : null;
  const code = typeof e.code === "string" ? e.code : null;
  const type = typeof e.type === "string" ? e.type : null;
  const message = typeof e.message === "string" ? e.message : "";
  const name = typeof e.name === "string" ? e.name : "";
  const retryAfter = (() => {
    try {
      const h = e.headers as { get?: (k: string) => string | null } & Record<string, string>;
      const raw = typeof h?.get === "function" ? h.get("retry-after") : h?.["retry-after"];
      const s = Number(raw);
      return Number.isFinite(s) && s > 0 ? Math.min(s * 1000, 30_000) : null;
    } catch { return null; }
  })();
  const out = (kind: OpenAiErrorKind, retryable: boolean): ClassifiedError => ({ kind, retryable, retryAfterMs: retryable ? retryAfter : null, status, code });
  if (/timeout|timed out/i.test(name) || /timed? ?out/i.test(message) || name === "AbortError") return out("timeout", false);
  if (/APIConnectionError/i.test(name) && status === null) return out("unavailable", true);
  if (status === 401 || code === "invalid_api_key" || type === "authentication_error") return out("auth", false);
  if (QUOTA_CODES.has(code ?? "") || QUOTA_CODES.has(type ?? "") || (status === 429 && /quota|billing|credit|spend limit|usage limit/i.test(message))) return out("quota", false);
  if (status === 429) return out("rate_limit", true);
  if (code === "model_not_found" || status === 404 || /does not exist|do(es)? not have access to (the )?model|model .* not found/i.test(message)) return out("model", false);
  if (status === 403) return out("auth", false);
  if (status === 400 || status === 422) {
    return /unsupported|not supported|unrecognized request argument|max_tokens|max_completion_tokens|temperature|reasoning_effort|frequency_penalty|presence_penalty|invalid.*parameter/i.test(message) ? out("model", false) : out("bad_request", false);
  }
  if (status !== null && status >= 500) return out("unavailable", true);
  return out("other", false);
}

// ---------------------------------------------------------------------------
// CREDENCIAL: identificada por uma impressao digital curta da chave (sha256), NUNCA a chave nem um pedaco dela. Hoje o servidor tem UMA chave (todas as clinicas dependem dela:
// se ela esgota, esgota para todas); se um dia houver chaves por clinica, cada uma tem o proprio estado e uma nao bloqueia a outra.
// ---------------------------------------------------------------------------
export function credentialIdOf(client: { apiKey?: unknown } | null | undefined): string {
  const key = typeof client?.apiKey === "string" ? client.apiKey : "";
  return key ? `cred-${crypto.createHash("sha256").update(key).digest("hex").slice(0, 8)}` : "cred-padrao";
}

export class OpenAiBlockedError extends Error {
  readonly status: number;
  readonly code: string;
  readonly aiKind: OpenAiErrorKind;
  constructor(kind: "quota" | "auth", readonly since: Date, readonly credential: string = "cred-padrao") {
    super(kind === "quota" ? "OpenAI sem saldo/limite esgotado: chamadas pausadas ate a proxima verificacao (nenhuma requisicao foi enviada)" : "Credencial da OpenAI invalida: chamadas pausadas ate a proxima verificacao (nenhuma requisicao foi enviada)");
    this.name = "OpenAiBlockedError";
    this.status = kind === "quota" ? 429 : 401;
    this.code = kind === "quota" ? "insufficient_quota" : "invalid_api_key";
    this.aiKind = kind;
  }
}
export const isOpenAiBlocked = (e: unknown): e is OpenAiBlockedError => e instanceof OpenAiBlockedError;

interface Block { kind: "quota" | "auth"; since: Date; probeAt: number; probing: boolean; lastDetail: string; fastFails: number }
const blocks = new Map<string, Block>(); // por credencial
let signaled = new Map<string, number>(); // "credencial|clinica" -> ultima vez que avisou a equipe
const cooldownMs = () => Math.max(1_000, Number(process.env.AI_BLOCK_COOLDOWN_MS ?? 300_000) || 300_000);
const SIGNAL_EVERY_MS = 3_600_000;

export function openAiHealth() {
  const list = [...blocks.entries()].map(([id, b]) => ({ credential: id, state: b.kind === "quota" ? "sem_saldo" : "credencial_invalida", since: b.since.toISOString(), nextCheckAt: new Date(b.probeAt).toISOString(), recoveryInProgress: b.probing, callsSkipped: b.fastFails, detail: b.lastDetail }));
  return { state: list[0]?.state ?? "ok", credentials: list, callsSkipped: list.reduce((s, c) => s + c.callsSkipped, 0), since: list[0]?.since ?? null, nextCheckAt: list[0]?.nextCheckAt ?? null, detail: list[0]?.detail ?? null };
}
export function resetOpenAiHealthForTests(): void { blocks.clear(); signaled = new Map(); }
// Testes: faz o intervalo de espera valer como VENCIDO agora (a proxima chamada e a de recuperacao), sem depender de relogio.
export function expireOpenAiBlockForTests(): void { for (const b of blocks.values()) { b.probeAt = 0; b.probing = false; } }

// Avisa o dono: Diario de atividades + WhatsApp interno, no maximo 1 vez por hora por credencial E clinica (cada clinica afetada e avisada uma vez). NAO usa a OpenAI (o aviso
// interno e texto fixo enviado pelo WhatsApp, kind "interna", que nao passa pela revisao por IA): sem dependencia do servico bloqueado e sem recursao. Nunca lanca nem atrasa a chamada.
function signalBlocked(kind: "quota" | "auth", credential: string, clinicId: string | null | undefined): void {
  if (!clinicId) return;
  const key = `${credential}|${clinicId}`;
  const last = signaled.get(key) ?? 0;
  if (Date.now() - last < SIGNAL_EVERY_MS) return;
  signaled.set(key, Date.now()); // marcado ANTES do envio assincrono: tentativas simultaneas nao repetem
  if (signaled.size > 1000) for (const [k, at] of signaled) if (Date.now() - at > SIGNAL_EVERY_MS) signaled.delete(k);
  const text = kind === "quota"
    ? "⚠️ A IA (OpenAI) está SEM SALDO ou no limite de gasto: a Alice não consegue gerar respostas e as automações com IA estão pausadas. Recarregue os créditos na conta da OpenAI. A conversa dos pacientes fica para a equipe até lá."
    : "⚠️ A chave da IA (OpenAI) está INVÁLIDA: a Alice não consegue gerar respostas. Confira a chave configurada no servidor. A conversa dos pacientes fica para a equipe até lá.";
  void (async () => {
    try {
      const { logActivity } = await import("../crm/activity.js");
      await logActivity({ clinicId, type: "openai_blocked", area: "automacoes", title: kind === "quota" ? "IA sem saldo (OpenAI)" : "Chave da IA inválida (OpenAI)", description: text.replace(/^⚠️ /, ""), actorName: null });
      const { notifyStaff } = await import("../crm/notify.js");
      await notifyStaff(clinicId, "automation_failed", text);
    } catch { /* sinalizacao e melhor esforco */ }
  })();
}

function markBlocked(credential: string, kind: "quota" | "auth", detail: string, clinicId: string | null | undefined): void {
  const prev = blocks.get(credential);
  blocks.set(credential, { kind, since: prev?.since ?? new Date(), probeAt: Date.now() + cooldownMs(), probing: false, lastDetail: detail.slice(0, 160), fastFails: prev?.fastFails ?? 0 });
  if (!prev) console.error(`[openai] ${credential}: ${kind === "quota" ? "SEM SALDO / limite de gasto" : "CREDENCIAL INVALIDA"}: novas chamadas pausadas por ${Math.round(cooldownMs() / 1000)}s; depois, a proxima chamada real faz a verificacao. Detalhe: ${detail.slice(0, 120)}`);
  signalBlocked(kind, credential, clinicId);
}

function clearBlocked(credential: string): void {
  const b = blocks.get(credential);
  if (!b) return;
  console.warn(`[openai] ${credential}: chamadas normalizadas (estava ${b.kind === "quota" ? "sem saldo" : "com credencial invalida"} desde ${b.since.toISOString()}; ${b.fastFails} chamada(s) puladas)`);
  blocks.delete(credential);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Nova tentativa da aplicacao (alem do SDK, que fica com maxRetries 0). Padrao 1; nos testes (chave "test-key") 0, a menos que AI_APP_RETRIES seja definido.
const appRetries = (): number => {
  const raw = process.env.AI_APP_RETRIES;
  if (raw !== undefined && raw.trim() !== "") return Math.max(0, Math.min(3, Number(raw) || 0));
  return process.env.OPENAI_API_KEY?.trim() === "test-key" ? 0 : 1;
};

export interface CallMeta {
  purpose: string;
  reason?: string | null; // answer | tool_result | correction:<qual> | fallback_model ... (o motivo desta chamada dentro do atendimento)
  clinicId?: string | null;
  conversationId?: string | null;
  traceId?: string | null;
  retries?: number; // sobrescreve o numero de novas tentativas desta chamada (0 = nenhuma)
  credential?: string; // credencial usada (credentialIdOf); padrao: a unica do servidor
}

interface Extract<T> { usage?: ChatCompletion["usage"] | null; model?: string | null; value: T }

// Nucleo generico: mede, classifica, decide a nova tentativa e controla o bloqueio por saldo/credencial.
export async function trackedRequest<T>(meta: CallMeta, requestedModel: string | null, run: () => Promise<Extract<T>>): Promise<T> {
  const ctx = aiContext();
  const credential = meta.credential ?? "cred-padrao";
  const base = { purpose: meta.purpose, clinicId: meta.clinicId ?? ctx.clinicId ?? null, conversationId: meta.conversationId ?? ctx.conversationId ?? null, traceId: meta.traceId ?? ctx.traceId ?? null, requestedModel };
  let recovery = false; // esta chamada e a de verificacao da credencial bloqueada
  const b = blocks.get(credential);
  if (b) {
    if (b.probing || Date.now() < b.probeAt) {
      // bloqueada localmente: NENHUMA requisicao sai (consumo zero de verdade) - registrada como not_sent, e a clinica afetada e avisada (1x por hora)
      b.fastFails++;
      recordCall({ ...base, durationMs: 0, outcome: "blocked", usageState: "not_sent", errorKind: b.kind, attemptReason: meta.reason ?? "answer", attempt: 1 });
      signalBlocked(b.kind, credential, base.clinicId);
      throw new OpenAiBlockedError(b.kind, b.since, credential);
    }
    b.probing = true; // intervalo vencido: ESTA chamada real e a unica de recuperacao; as demais ficam bloqueadas ate ela terminar
    recovery = true;
  }
  const max = meta.retries ?? appRetries();
  try {
    for (let attempt = 1; ; attempt++) {
      const started = Date.now();
      const reason = attempt > 1 ? `retry:${(meta.reason ?? "answer").split(":")[0]}` : meta.reason ?? "answer";
      try {
        const r = await run();
        const known = !!r.usage && (r.usage.prompt_tokens !== undefined || r.usage.completion_tokens !== undefined);
        recordCall({ ...base, model: r.model ?? requestedModel, usage: r.usage ?? null, usageState: (known ? "known" : "unknown") as UsageState, durationMs: Date.now() - started, outcome: "ok", attemptReason: reason, attempt });
        clearBlocked(credential);
        recovery = false;
        return r.value;
      } catch (err) {
        const c = classifyOpenAiError(err);
        // a requisicao SAIU e nao veio uso: o consumo e DESCONHECIDO (pode ter sido cobrado, ex.: timeout). Nunca vira "zero tokens".
        recordCall({ ...base, durationMs: Date.now() - started, outcome: "error", usageState: "unknown", errorKind: c.kind, attemptReason: reason, attempt });
        if (c.kind === "quota" || c.kind === "auth") {
          markBlocked(credential, c.kind, `HTTP ${c.status ?? "?"}${c.code ? ` ${c.code}` : ""}`, base.clinicId);
          recovery = false; // markBlocked ja reiniciou o intervalo e liberou a verificacao
        }
        if (c.retryable && attempt <= max && !blocks.has(credential)) {
          await sleep(Math.min(c.retryAfterMs ?? 700 * 2 ** (attempt - 1) + Math.floor(Math.random() * 300), 15_000));
          continue;
        }
        try { (err as { aiKind?: OpenAiErrorKind }).aiKind = c.kind; } catch { /* erro congelado: segue sem a etiqueta */ }
        throw err;
      }
    }
  } finally {
    if (recovery) {
      // a verificacao terminou sem confirmar nem derrubar a credencial (ex.: timeout): libera a vez para a proxima, depois de um novo intervalo
      const cur = blocks.get(credential);
      if (cur) { cur.probing = false; cur.probeAt = Date.now() + cooldownMs(); }
    }
  }
}

// Conversa (Chat Completions). Devolve a resposta inteira, como o SDK.
export async function trackedChat(client: OpenAI, params: ChatCompletionCreateParamsNonStreaming, meta: CallMeta, options?: { timeout?: number }): Promise<ChatCompletion> {
  const model = typeof params.model === "string" ? params.model : null;
  return trackedRequest<ChatCompletion>({ credential: credentialIdOf(client), ...meta }, model, async () => {
    const res = await client.chat.completions.create({ ...params, stream: false }, options);
    return { usage: res.usage ?? null, model: res.model ?? null, value: res };
  });
}

// Atalho: troca `openai.chat.completions.create(...)` por `tracked(openai, "finalidade").chat.completions.create(...)` sem mexer no resto da chamada.
export function tracked(client: OpenAI, purpose: string, meta: Omit<CallMeta, "purpose"> = {}) {
  return { chat: { completions: { create: (params: ChatCompletionCreateParamsNonStreaming, options?: { timeout?: number }) => trackedChat(client, params, { purpose, ...meta }, options) } } };
}
