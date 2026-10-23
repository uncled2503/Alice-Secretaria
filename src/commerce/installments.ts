// ---------------------------------------------------------------------------
// PARCELAMENTO (geral, por empresa), em CENTAVOS - nunca em ponto flutuante. Regras configuraveis:
//   - maximo de parcelas da empresa (ex.: 10x sem juros) e valor MINIMO de cada parcela (ex.: R$ 100);
//   - limite proprio de uma oferta/procedimento (ex.: HIPRO Papada ate 3x) - so pode REDUZIR, nunca aumentar;
//   - oferta exclusiva no Pix e experiencia nao parcelavel: nada de parcelas.
// max = min(maxEmpresa, floor(total / minimo), limiteDaOferta). Menos de 2 = nao parcela (ex.: abaixo de R$ 200 nao ha 2x).
// Divisao nao exata (R$ 397 em 3x) NUNCA e apresentada como parcelas iguais: as parcelas saem em centavos e o resto vai 1 centavo nas primeiras (ajuste de centavos).
// Nunca inventa juros, desconto ou condicao: sem regra cadastrada, nao ha calculo.
// ---------------------------------------------------------------------------
export interface InstallmentPolicy { maxInstallments: number; minInstallmentCents: number }
export interface InstallmentItem { totalCents: number; offerMax?: number | null; pixOnly?: boolean; notInstallable?: boolean }

export interface InstallmentPlan {
  totalCents: number;
  max: number; // 1 = a vista apenas
  installable: boolean;
  reason: string; // por que o maximo e esse
}
export interface InstallmentSplit { n: number; parcels: number[]; exact: boolean; ok: boolean; reason: string | null }

export const toCents = (reais: number): number => Math.round(reais * 100);
export function formatBRL(cents: number): string {
  const neg = cents < 0;
  const v = Math.abs(Math.round(cents));
  const int = Math.floor(v / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${neg ? "-" : ""}R$ ${int},${String(v % 100).padStart(2, "0")}`;
}

// PURO: o maximo de parcelas permitido para um valor.
export function maxInstallmentsFor(item: InstallmentItem, policy: InstallmentPolicy): InstallmentPlan {
  const total = Math.round(item.totalCents);
  if (!Number.isFinite(total) || total <= 0) return { totalCents: total, max: 1, installable: false, reason: "valor não cadastrado" };
  if (item.notInstallable) return { totalCents: total, max: 1, installable: false, reason: "oferta não parcelável" };
  if (item.pixOnly) return { totalCents: total, max: 1, installable: false, reason: "condição exclusiva no Pix (sem parcelamento)" };
  const byMin = policy.minInstallmentCents > 0 ? Math.floor(total / policy.minInstallmentCents) : policy.maxInstallments;
  const limits: [number, string][] = [[policy.maxInstallments, `máximo da clínica (${policy.maxInstallments}x)`], [byMin, `parcela mínima de ${formatBRL(policy.minInstallmentCents)}`]];
  if (item.offerMax != null && item.offerMax > 0) limits.push([item.offerMax, `limite da oferta (${item.offerMax}x)`]);
  const [max, reason] = limits.reduce((a, b) => (b[0] < a[0] ? b : a));
  return max >= 2 ? { totalCents: total, max, installable: true, reason } : { totalCents: total, max: 1, installable: false, reason: `${reason}: não cabe em 2 parcelas` };
}

// PURO: as parcelas de um pedido de N vezes (centavos; o resto vai 1 centavo nas primeiras parcelas). ok=false quando N passa do permitido.
export function splitInstallments(item: InstallmentItem, policy: InstallmentPolicy, n: number): InstallmentSplit {
  const plan = maxInstallmentsFor(item, policy);
  if (!Number.isInteger(n) || n < 1) return { n, parcels: [], exact: false, ok: false, reason: "quantidade de parcelas inválida" };
  if (n === 1) return { n, parcels: [plan.totalCents], exact: true, ok: true, reason: null };
  if (n > plan.max) return { n, parcels: [], exact: false, ok: false, reason: plan.installable ? `acima do permitido (${plan.reason})` : plan.reason };
  const base = Math.floor(plan.totalCents / n);
  const rest = plan.totalCents - base * n;
  const parcels = Array.from({ length: n }, (_, i) => (i < rest ? base + 1 : base)); // o resto (menos de N centavos) vai 1 centavo nas primeiras parcelas
  return { n, parcels, exact: rest === 0, ok: true, reason: null };
}

// PURO: descricao fiel de um parcelamento ("3x: 1 de R$ 132,34 e 2 de R$ 132,33"; "2x de R$ 198,50").
export function describeSplit(s: InstallmentSplit): string {
  if (!s.ok) return s.reason ?? "não permitido";
  if (s.n === 1) return `à vista ${formatBRL(s.parcels[0])}`;
  if (s.exact) return `${s.n}x de ${formatBRL(s.parcels[0])} sem juros`;
  const hi = s.parcels.filter((p) => p === s.parcels[0]).length;
  return `${s.n}x sem juros: ${hi} de ${formatBRL(s.parcels[0])} e ${s.n - hi} de ${formatBRL(s.parcels[s.n - 1])} (ajuste de centavos)`;
}

export const ASK_INSTALLMENTS_TEXT = "Em quantas vezes ficaria bom para você?";
export function overLimitText(max: number, policy: InstallmentPolicy): string {
  return `Consigo fazer em até ${max}x sem juros para mantermos a parcela mínima de ${formatBRL(policy.minInstallmentCents).replace(",00", "")}. Essa quantidade funciona para você?`;
}

// PURO: linha para o prompt da Alice (o que ela pode dizer sobre parcelas deste valor). Sem politica da empresa = null (comportamento antigo).
export function installmentPromptLine(item: InstallmentItem, policy: InstallmentPolicy): string {
  const plan = maxInstallmentsFor(item, policy);
  if (!plan.installable) return `sem parcelamento (${plan.reason})`;
  const ex = splitInstallments(item, policy, plan.max);
  return `até ${plan.max}x sem juros (${plan.reason}); em ${plan.max}x: ${describeSplit(ex)}; ${plan.max + 1}x ou mais NÃO`;
}

// PURO: todos os valores de parcela que podem aparecer numa resposta (para a conferencia de numeros citados).
export function allowedParcelValues(item: InstallmentItem, policy: InstallmentPolicy): number[] {
  const plan = maxInstallmentsFor(item, policy);
  const out: number[] = [];
  for (let n = 2; n <= plan.max; n++) for (const c of splitInstallments(item, policy, n).parcels) out.push(c / 100);
  return [...new Set(out)];
}
