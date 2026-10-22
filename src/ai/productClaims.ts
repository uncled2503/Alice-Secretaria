// ---------------------------------------------------------------------------
// AFIRMACOES SOBRE PRODUTO/COMPOSICAO (caso Taise, 21/10/2026). A cliente disse "ele tambem tem refrescancia, eu nao uso produtos com refrescancia" e a Alice respondeu "o produto
// utilizado na Limpeza de Pele tem refrescancia": a fala da cliente virou FATO sobre o produto da clinica, e uma marca citada numa fala anterior (ate da propria Alice) virou fonte.
// Composicao, sensacao (frescor/gelado), fragrancia e presenca de ativos so existem se estiverem no CADASTRO aprovado (descricoes, FAQ, regras, mensagens). Tudo PURO.
// ---------------------------------------------------------------------------

function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

// Termos de composicao/sensacao. Cada grupo vale por RAIZ: "refrescancia", "refrescante" e "frescor" sao a mesma familia.
const FAMILIES: { id: string; re: RegExp }[] = [
  { id: "frescor", re: /\b(refresc\w+|frescor|fresquinh\w+|gelad\w+|sensacao de frio|efeito (frio|gelado))\b/ },
  { id: "fragrancia", re: /\b(perfum\w+|fragranc\w+|cheiro\w*|aroma\w*|essencia\w*|cheirosa?)\b/ },
  { id: "mentol", re: /\b(mentol|hortela|menta|canfora|eucalipto)\b/ },
  { id: "ativo", re: /\b(acido\w*|alcool|parabeno\w*|silicone|sulfato|vitamina c|retinol|salicilic\w*|glicolic\w*|ativos?)\b/ },
];

const SUBJECT_RE = /\b(produto\w*|marca\w*|linha|cosmetic\w*|creme|gel|esfoliante|mascara|serum|tonico|sabonete|locao|formula\w*|composicao|cosmobeauty|dermage|vichy|la roche|principia|adcos)\b/;
const VERB_RE = /\b(tem|tem sim|contem|possui|inclui|leva|nao (tem|contem|possui|leva)|e livre de|sem|livre de|causa|deixa|da|libera|sente-se|sente|sao)\b/;

export interface ProductClaim { sentence: string; family: string }

// PURO: frases da resposta que AFIRMAM composicao/sensacao/fragrancia de um produto ou marca (ha um sujeito "produto/marca/linha...", um verbo de posse/ausencia e um termo de composicao).
// Pergunta (termina em "?") nao e afirmacao.
export function productClaimSentences(text: string, split: (t: string) => string[]): ProductClaim[] {
  const out: ProductClaim[] = [];
  for (const s of split(text)) {
    const f = fold(s);
    if (/\?\s*$/.test(s.trim())) continue;
    if (!SUBJECT_RE.test(f) || !VERB_RE.test(f)) continue;
    const fam = FAMILIES.find((x) => x.re.test(f));
    if (fam) out.push({ sentence: s, family: fam.id });
  }
  return out;
}

// PURO: das afirmacoes, as que o CADASTRO aprovado NAO sustenta (a familia do termo nao aparece no texto aprovado). O que a pessoa disse e o que a propria Alice disse antes NAO sao fonte.
export function unsupportedProductClaims(text: string, approvedText: string, split: (t: string) => string[]): ProductClaim[] {
  const approved = fold(approvedText);
  return productClaimSentences(text, split).filter((c) => !FAMILIES.find((x) => x.id === c.family)!.re.test(approved));
}

// Pergunta curta e gentil que desfaz a ambiguidade de "refrescancia" (frescor x fragrancia) sem corrigir a cliente.
export const CLARIFY_FRESHNESS = "Quando você fala em refrescância, você quer dizer a sensação de frescor/gelado na pele ou o perfume/cheiro do produto? Assim eu entendo certinho o que você evita e confirmo com a equipe. 💗";
export function clarifyProductTerm(term: string): string {
  if (/refresc|gelad|frescor/.test(fold(term))) return CLARIFY_FRESHNESS;
  return `Pode me contar um pouquinho mais sobre o que você quer evitar em relação a ${term}? Assim eu entendo certinho e confirmo com a equipe. 💗`;
}

// Familias de composicao/sensacao que o texto APROVADO (cadastro, FAQ, regras, mensagens) sustenta: vai no contexto da resposta (pequeno) para a entrega conferir tambem o que a revisao reescrever.
export function approvedProductFamilies(approvedText: string): string[] {
  const approved = fold(approvedText);
  return FAMILIES.filter((x) => x.re.test(approved)).map((x) => x.id);
}
export function claimsOutsideFamilies(text: string, approved: string[], split: (t: string) => string[]): ProductClaim[] {
  return productClaimSentences(text, split).filter((c) => !approved.includes(c.family));
}
