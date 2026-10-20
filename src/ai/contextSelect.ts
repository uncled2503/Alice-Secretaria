// ---------------------------------------------------------------------------
// SELECAO DO CONTEUDO DA CLINICA QUE ENTRA NO PROMPT (FAQ, mensagens prontas, roteiros). Antes TODOS os itens ativos iam em toda chamada. Agora entram os PERTINENTES a esta conversa,
// por pontuacao deterministica (sem outra chamada paga): palavras da pergunta/titulo/"quando usar" do item x palavras das ultimas mensagens da pessoa (as mais novas pesam mais),
// raridade da palavra entre os itens (palavra que so um item tem vale mais), e a situacao da conversa para os roteiros (primeiro atendimento, agendamento, remarcacao, preco, objecao).
// Seguranca:
//  - quem NAO foi selecionado continua ALCANCAVEL: o prompt traz um indice com os titulos e a ferramenta consultar_conteudo_da_clinica devolve o conteudo completo (mesma pontuacao,
//    limiar menor). Ausencia no prompt NUNCA significa "a clinica nao faz/nao tem": o prompt diz isso e manda consultar antes de negar;
//  - ate ALWAYS_IF_AT_MOST itens de um tipo: entram todos (nao ha economia que valha o risco);
//  - AI_CONTEXT_SELECT=off volta a mandar tudo, como antes.
// Tudo PURO (testavel sem banco).
// ---------------------------------------------------------------------------

export const ALWAYS_IF_AT_MOST = 4;
export const MAX_SELECTED = { faq: 8, template: 5, playbook: 4 } as const;
export type ContentKind = keyof typeof MAX_SELECTED;

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
const STOP = new Set(["de", "da", "do", "das", "dos", "e", "a", "o", "as", "os", "um", "uma", "uns", "umas", "para", "pra", "por", "com", "sem", "em", "no", "na", "nos", "nas", "ao", "aos", "que", "se", "eu", "voce", "voces", "vc", "vcs", "tem", "ter", "tenho", "vai", "vou", "ser", "foi", "sao", "esta", "estao", "como", "qual", "quais", "quando", "onde", "porque", "mais", "muito", "muita", "meu", "minha", "seu", "sua", "isso", "esse", "essa", "este", "esta", "ola", "oi", "bom", "boa", "dia", "tarde", "noite", "obrigado", "obrigada", "por favor", "gostaria", "queria", "quero", "pode", "podem", "posso", "ja", "so", "tambem", "mas", "ou", "nao", "sim", "ok"]);

// PURO: palavras significativas (sem acento, sem plural simples, sem palavras de ligacao).
export function contentTokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of fold(text).split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw)) continue;
    out.push(raw.length > 4 && raw.endsWith("s") ? raw.slice(0, -1) : raw);
  }
  return out;
}

export interface ContentItem { id: string; title: string; aux: string }
export interface QueryText { text: string; weight: number }

export interface Scored<T> { item: T; score: number }

// PURO: pontua cada item contra as mensagens. Raridade: palavra presente em menos itens vale mais (1/(1+df)); mensagens mais novas pesam mais.
export function scoreItems<T extends ContentItem>(items: T[], query: QueryText[]): Scored<T>[] {
  const itemTokens = items.map((it) => new Set([...contentTokens(it.title), ...contentTokens(it.aux)]));
  const df = new Map<string, number>();
  for (const set of itemTokens) for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
  const q = new Map<string, number>();
  for (const { text, weight } of query) for (const t of contentTokens(text)) q.set(t, Math.max(q.get(t) ?? 0, weight));
  return items.map((item, i) => {
    let score = 0;
    for (const t of itemTokens[i]) {
      const w = q.get(t);
      if (w) score += w * (1 + 1 / (1 + (df.get(t) ?? 1)));
    }
    return { item, score: Number(score.toFixed(3)) };
  });
}

// PURO: as mensagens recentes viram consultas com peso (a mais nova pesa 3, depois 2, depois 1).
export function queryFromMessages(userTexts: string[]): QueryText[] {
  const last = userTexts.filter((t) => t && t.trim()).slice(-4);
  return last.map((text, i) => { const fromEnd = last.length - 1 - i; return { text, weight: fromEnd === 0 ? 3 : fromEnd === 1 ? 2 : 1 }; }); // a mais nova pesa 3
}

export interface Selection<T> { selected: T[]; rest: T[]; why: Record<string, string> }

export function selectContent<T extends ContentItem>(kind: ContentKind, items: T[], query: QueryText[], opts: { forced?: Set<string>; minScore?: number } = {}): Selection<T> {
  const why: Record<string, string> = {};
  if (items.length <= ALWAYS_IF_AT_MOST) {
    for (const it of items) why[it.id] = "poucos_itens_entram_todos";
    return { selected: items, rest: [], why };
  }
  const min = opts.minScore ?? 1.2;
  const scored = scoreItems(items, query);
  const forced = opts.forced ?? new Set<string>();
  const picked = scored
    .filter((s) => forced.has(s.item.id) || s.score >= min)
    .sort((a, b) => Number(forced.has(b.item.id)) - Number(forced.has(a.item.id)) || b.score - a.score)
    .slice(0, MAX_SELECTED[kind]);
  const ids = new Set(picked.map((p) => p.item.id));
  for (const p of picked) why[p.item.id] = forced.has(p.item.id) ? "situacao_da_conversa" : `palavras_em_comum(${p.score})`;
  return { selected: picked.map((x) => x.item), rest: items.filter((it) => !ids.has(it.id)), why }; // os selecionados vao do mais pertinente para o menos
}

// PURO: quais roteiros a SITUACAO pede, independente de palavras. `scriptType` vem do cadastro (primeiro_atendimento | agendamento | procedimento | preco | objecoes | remarcacao | livre).
export function forcedPlaybookTypes(s: { intent?: string | null; firstContact: boolean; priceAsked: boolean }): Set<string> {
  const t = new Set<string>();
  if (s.firstContact) t.add("primeiro_atendimento");
  if (s.priceAsked) t.add("preco");
  switch (s.intent) {
    case "schedule": case "decline": t.add("agendamento"); break;
    case "manage": t.add("remarcacao"); break;
    case "hesitate": case "refuse": case "objection": t.add("objecoes"); break;
    default: break;
  }
  return t;
}

// PURO: indice dos NAO selecionados (so titulos): cabe em poucos tokens e deixa claro que existem.
export function renderIndex(parts: { label: string; titles: string[] }[]): string {
  const lines = parts.filter((p) => p.titles.length).map((p) => `- ${p.label}: ${p.titles.slice(0, 40).map((t) => t.replace(/\s+/g, " ").trim().slice(0, 70)).join(" | ")}${p.titles.length > 40 ? ` | (+${p.titles.length - 40})` : ""}`);
  if (!lines.length) return "";
  return `\n\nOUTROS ASSUNTOS CADASTRADOS (nao selecionados para esta conversa, mas EXISTEM): se a pessoa perguntar algo que possa estar aqui, chame consultar_conteudo_da_clinica ANTES de responder. Nao estar listado no contexto NAO significa que a clinica nao faz ou nao tem; se a consulta nada trouxer e voce nao souber, encaminhe para a equipe (transfer_to_human) em vez de negar.\n${lines.join("\n")}`;
}

// PURO: busca da ferramenta de consulta (mesma pontuacao, limiar menor, devolve ate `limit` itens por tipo).
export function searchContent<T extends ContentItem>(items: T[], busca: string, limit = 3): T[] {
  const scored = scoreItems(items, [{ text: busca, weight: 3 }]).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.item);
}
