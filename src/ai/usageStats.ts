// ---------------------------------------------------------------------------
// ONDE VAO OS TOKENS DA OPENAI (pedido do dono, 16/10/2026: "economizar token sem interferir no fluxo"). Cada chamada a OpenAI registra aqui, por
// FINALIDADE (conversa da Alice, segunda leitura, revisao de envio, memoria do lead, resumo do CRM, juiz de recontato...), quantos tokens gastou
// (entrada, parte reaproveitada do cache, saida). So em memoria (zera quando o servidor reinicia); a tela do admin le /api/ai-usage.
// ---------------------------------------------------------------------------

export interface UsageLike {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
}

interface Bucket { calls: number; input: number; cached: number; output: number }
const buckets = new Map<string, Bucket>();
const startedAt = new Date();

export function recordUsage(purpose: string, usage: UsageLike | null | undefined): void {
  if (!usage) return;
  const b = buckets.get(purpose) ?? { calls: 0, input: 0, cached: 0, output: 0 };
  b.calls += 1;
  b.input += usage.prompt_tokens ?? 0;
  b.cached += usage.prompt_tokens_details?.cached_tokens ?? 0;
  b.output += usage.completion_tokens ?? 0;
  buckets.set(purpose, b);
}

// Preco aproximado do gpt-4o-mini (USD por 1 milhao de tokens): entrada 0,15 · entrada em cache 0,075 · saida 0,60. Outro modelo custa diferente.
const PRICE = { input: 0.15, cached: 0.075, output: 0.6 };

export function usageSnapshot() {
  const purposes = [...buckets.entries()]
    .map(([purpose, b]) => ({
      purpose,
      ...b,
      cacheRate: b.input ? Math.round((b.cached / b.input) * 100) : 0,
      avgInput: b.calls ? Math.round(b.input / b.calls) : 0,
      estimatedUsd: Number((((b.input - b.cached) * PRICE.input + b.cached * PRICE.cached + b.output * PRICE.output) / 1_000_000).toFixed(4)),
    }))
    .sort((a, b) => b.estimatedUsd - a.estimatedUsd);
  return {
    since: startedAt.toISOString(),
    note: "Estimativa em USD pelo preco do gpt-4o-mini; zera quando o servidor reinicia. 'cacheRate' = parte da entrada que a OpenAI reaproveitou do cache (desconto de 50%).",
    totalEstimatedUsd: Number(purposes.reduce((s, p) => s + p.estimatedUsd, 0).toFixed(4)),
    purposes,
  };
}

export function resetUsageForTests(): void {
  buckets.clear();
}
