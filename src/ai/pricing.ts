// ---------------------------------------------------------------------------
// PRECOS DA OPENAI POR MODELO (USD por 1 milhao de tokens). Servem para ESTIMAR custo: cobranca real so a fatura/painel de uso da OpenAI mostra.
// Regras:
//  - cada modelo tem o proprio preco; modelo sem preco conhecido NUNCA vira zero nem usa o preco de outro modelo: o custo fica "nao calculado";
//  - o nome devolvido pela API pode ser um snapshot datado ("gpt-4o-mini-2024-07-18"): so o sufixo de data e removido para achar o preco (nada de casar por prefixo: "gpt-4o" != "gpt-4o-mini");
//  - a tabela abaixo e o PADRAO; um preco novo ou diferente entra por OPENAI_PRICES_JSON (sem mexer no codigo), no formato
//      {"modelo":{"input":0.15,"cachedInput":0.075,"output":0.6,"source":"onde conferiu","checkedAt":"AAAA-MM-DD"}}
//    e vale por cima do padrao. Tabela de modelo que a clinica usa e nao esta aqui: acrescente por la.
// Fonte do padrao: https://developers.openai.com/api/docs/pricing (nivel padrao, contexto curto, sem desconto de lote/prioridade), conferido em 19/10/2026;
// a pagina nao mostra data de vigencia dos precos.
// ---------------------------------------------------------------------------

export interface ModelPrice {
  input: number; // USD / 1M tokens de entrada (nao cacheados)
  cachedInput: number | null; // USD / 1M tokens de entrada que vieram do cache (null = a OpenAI nao informa desconto: cobra como entrada)
  output: number; // USD / 1M tokens de saida
  source: string;
  checkedAt: string;
}

const SRC = "https://developers.openai.com/api/docs/pricing";
const DAY = "2026-10-19";
const p = (input: number, cachedInput: number | null, output: number): ModelPrice => ({ input, cachedInput, output, source: SRC, checkedAt: DAY });

export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  "gpt-4o-mini": p(0.15, 0.075, 0.6),
  "gpt-4o": p(2.5, 1.25, 10),
  "gpt-4.1": p(2, 0.5, 8),
  "gpt-4.1-mini": p(0.4, 0.1, 1.6),
  "gpt-4.1-nano": p(0.1, 0.025, 0.4),
  "gpt-5": p(1.25, 0.125, 10),
  "gpt-5-mini": p(0.25, 0.025, 2),
  "gpt-5.1": p(1.25, 0.125, 10),
  "gpt-5.2": p(1.75, 0.175, 14),
  "gpt-5.4": p(2.5, 0.25, 15),
  "gpt-5.4-mini": p(0.75, 0.075, 4.5),
  "gpt-5.4-nano": p(0.2, 0.02, 1.25),
  "gpt-5.5": p(5, 0.5, 30),
  "gpt-5.6-sol": p(4, 0.4, 20),
  "gpt-5.6-terra": p(2, 0.2, 12),
  "gpt-5.6-luna": p(0.2, 0.02, 1.2),
  "gpt-6-astra": p(10, 1, 50),
  "gpt-6.1-sol": p(2, 0.1, 10),
  "gpt-6-sol": p(2, 0.2, 10),
  "gpt-6-luna": p(0.1, 0.01, 0.5),
};

let overrideCache: { raw: string; table: Record<string, ModelPrice> } | null = null;

// PURO: interpreta OPENAI_PRICES_JSON. Entrada invalida e IGNORADA (item a item), nunca derruba nada nem zera preco.
export function parsePriceOverrides(raw: string | undefined): Record<string, ModelPrice> {
  const out: Record<string, ModelPrice> = {};
  if (!raw?.trim()) return out;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return out; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const [model, v] of Object.entries(parsed as Record<string, unknown>)) {
    const o = v as { input?: unknown; cachedInput?: unknown; output?: unknown; source?: unknown; checkedAt?: unknown } | null;
    if (!o || typeof o !== "object") continue;
    const input = Number(o.input);
    const output = Number(o.output);
    if (!Number.isFinite(input) || !Number.isFinite(output) || input <= 0 || output <= 0) continue; // preco zero/negativo nao e preco
    const cachedRaw = o.cachedInput === null || o.cachedInput === undefined ? null : Number(o.cachedInput);
    const cachedInput = cachedRaw !== null && Number.isFinite(cachedRaw) && cachedRaw > 0 ? cachedRaw : null;
    out[model.trim().toLowerCase()] = { input, cachedInput, output, source: typeof o.source === "string" ? o.source.slice(0, 200) : "OPENAI_PRICES_JSON", checkedAt: typeof o.checkedAt === "string" ? o.checkedAt.slice(0, 10) : "informado pelo operador" };
  }
  return out;
}

export function priceTable(): Record<string, ModelPrice> {
  const raw = process.env.OPENAI_PRICES_JSON ?? "";
  if (!overrideCache || overrideCache.raw !== raw) overrideCache = { raw, table: { ...DEFAULT_PRICES, ...parsePriceOverrides(raw) } };
  return overrideCache.table;
}

// PURO: preco do modelo (exato, ou sem o sufixo de data do snapshot). null = desconhecido.
export function priceFor(model: string | null | undefined): { key: string; price: ModelPrice } | null {
  const m = (model ?? "").trim().toLowerCase();
  if (!m) return null;
  const table = priceTable();
  if (table[m]) return { key: m, price: table[m] };
  const base = m.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  if (base !== m && table[base]) return { key: base, price: table[base] };
  return null;
}

export interface TokenCounts { input: number; cached: number; output: number }

// PURO: custo ESTIMADO em USD, ou null quando o modelo nao tem preco (custo nao calculado: nunca 0). `input` inclui `cached`.
export function estimateUsd(model: string | null | undefined, t: TokenCounts): number | null {
  const found = priceFor(model);
  if (!found) return null;
  const { price } = found;
  const cached = Math.min(Math.max(t.cached, 0), Math.max(t.input, 0));
  const fresh = Math.max(t.input - cached, 0);
  const cachedRate = price.cachedInput ?? price.input;
  return (fresh * price.input + cached * cachedRate + Math.max(t.output, 0) * price.output) / 1_000_000;
}
