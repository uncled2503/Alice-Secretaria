// ---------------------------------------------------------------------------
// ANTI-REPETICAO. O modelo as vezes "re-responde" perguntas antigas dentro da resposta nova (repete o valor, o
// endereco, o aviso de marca-passo...) e fecha todas as mensagens com a mesma pergunta. Aqui a gente:
//  1) monta a "memoria da conversa" (o que ja foi dito/perguntado) pra o modelo LER antes de responder;
//  2) detecta o que, mesmo assim, o rascunho repete: frase quase igual, mesmo assunto (valor/endereco/horario) com
//     outras palavras, e a mesma pergunta de fechamento. O codigo reescreve ou corta antes de enviar.
// ---------------------------------------------------------------------------

function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function normalize(s: string): string {
  return fold(s)
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function words(s: string): string[] {
  return normalize(s).split(" ").filter(Boolean);
}

const STOP = new Set(
  "a o os as de do da dos das e em no na nos nas um uma uns umas que para pra por com se ao aos voce vc te me eu ou ja so la ai ele ela seu sua".split(" "),
);

function contentWords(s: string): string[] {
  return words(s).filter((w) => w.length > 2 && !STOP.has(w));
}

function jaccard(a: string, b: string): number {
  const wa = new Set(words(a));
  const wb = new Set(words(b));
  if (!wa.size || !wb.size) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter);
}

// Quanto da frase MENOR esta dentro da outra (palavras de conteudo). Pega a mesma ideia com outras palavras.
function overlap(a: string, b: string): number {
  const wa = new Set(contentWords(a));
  const wb = new Set(contentWords(b));
  if (wa.size < 3 || wb.size < 3) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / Math.min(wa.size, wb.size);
}

// Quebra em frases (ponto, !, ? ou quebra de linha). Mantem a pontuacao no fim de cada uma.
export function splitSentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?…])\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
}

const MIN_WORDS = 4; // frase curta ("Claro!", "Perfeito!") se repete sem problema

// Frases do rascunho que repetem (>= threshold de palavras em comum) alguma frase das respostas anteriores.
export function repeatedSentences(draft: string, priorReplies: string[], threshold = 0.7): string[] {
  const prior = priorReplies.flatMap(splitSentences).filter((s) => words(s).length >= MIN_WORDS);
  if (!prior.length) return [];
  return splitSentences(draft).filter((sentence) => words(sentence).length >= MIN_WORDS && prior.some((p) => jaccard(sentence, p) >= threshold));
}

export function removeSentences(text: string, remove: string[]): string {
  const drop = new Set(remove);
  return splitSentences(text)
    .filter((s) => !drop.has(s))
    .join(" ")
    .trim();
}

// A pessoa repetiu a propria pergunta (ai repetir a resposta e legitimo).
export function askedAgain(lastUserText: string, previousUserTexts: string[], threshold = 0.8): boolean {
  return previousUserTexts.some((m) => words(m).length >= 3 && jaccard(m, lastUserText) >= threshold);
}

// ---------------------------------------------------------------------------
// Assuntos que a Alice tem o habito de repetir. "tell" = a frase fala do assunto; "ask" = a pessoa esta perguntando
// disso agora (ai repetir e legitimo). Largo de proposito no "ask": cortar uma resposta util e pior que deixar passar.
// ---------------------------------------------------------------------------
interface Topic {
  label: string;
  tell: RegExp;
  ask: RegExp;
}

const TOPICS: Topic[] = [
  {
    label: "valor/investimento",
    tell: /\b(valor|valores|investimento|preco|precos|custa|custam|orcamento|parcelas?|parcelamento)\b|r\$\s?\d/,
    ask: /quanto|valor|preco|custa|custo|orcamento|investimento|parcel|pagamento|pagar|pix|cartao|credito|debito|vezes|sessao|sessoes|pacote|desconto|promocao|combo|entrada|sinal|forma/,
  },
  {
    label: "endereco/localizacao",
    tell: /\b(endereco|localizad[oa]s?|localizacao|ficamos|fica (na|no|em)|estacionamento|bairro)\b|\b(rua|avenida|av\.)\s/,
    ask: /onde|endereco|localiz|fica|chegar|mapa|estacionamento|bairro|cidade|regiao|perto|longe|rua|avenida/,
  },
  {
    label: "dias e horarios de atendimento",
    tell: /\b(atendemos|funcionamos|funcionamento|expediente|abrimos|horarios? de atendimento)\b|segunda a (sexta|sabado)|das \d{1,2}h?(:\d\d)? (as|a|ate) \d{1,2}/,
    ask: /horario|hora|dia|dias|quando|funciona|atende|abre|aberto|sabado|domingo|semana|manha|tarde|noite|disponivel|agenda|vaga|feriado/,
  },
];

function topicsIn(text: string): Topic[] {
  const f = fold(text);
  return TOPICS.filter((t) => t.tell.test(f));
}

// Frases do rascunho que falam de um assunto (valor, endereco, horario) que a Alice JA tinha dito, de novo e com a mesma
// ideia, sem a pessoa ter perguntado disso agora.
export function repeatedTopicSentences(draft: string, priorReplies: string[], userNow: string): string[] {
  const priorSentences = priorReplies.flatMap(splitSentences);
  if (!priorSentences.length) return [];
  const userFold = fold(userNow);
  return splitSentences(draft).filter((sentence) => {
    const f = fold(sentence);
    return TOPICS.some(
      (t) => t.tell.test(f) && !t.ask.test(userFold) && priorSentences.some((p) => t.tell.test(fold(p)) && overlap(sentence, p) >= 0.5),
    );
  });
}

// Ultima pergunta da mensagem (a "pergunta de fechamento"), se ela termina com "?".
export function closingQuestion(text: string): string | null {
  const last = splitSentences(text).at(-1);
  return last && /\?\s*$/.test(last) ? last : null;
}

export function repeatedClosingQuestion(draft: string, priorReplies: string[]): string | null {
  const q = closingQuestion(draft);
  if (!q) return null;
  for (const reply of priorReplies) {
    const pq = closingQuestion(reply);
    if (pq && (jaccard(q, pq) >= 0.6 || overlap(q, pq) >= 0.6)) return q;
  }
  return null;
}

// Tudo que o rascunho repete: frase quase igual + mesmo assunto + mesma pergunta de fechamento.
export function findRepetitions(draft: string, priorReplies: string[], userNow: string): string[] {
  const found = new Set(repeatedSentences(draft, priorReplies));
  for (const s of repeatedTopicSentences(draft, priorReplies, userNow)) found.add(s);
  const q = repeatedClosingQuestion(draft, priorReplies);
  if (q) found.add(q);
  return splitSentences(draft).filter((s) => found.has(s));
}

// ---------------------------------------------------------------------------
// MEMORIA DA CONVERSA: o que a Alice ja disse e ja perguntou, e o que a pessoa ja perguntou e foi respondido.
// Vai no ultimo aviso ao modelo, pra ele continuar de onde a conversa parou em vez de recomecar.
// ---------------------------------------------------------------------------
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

export function conversationMemory(priorReplies: string[], answeredUserMessages: string[]): string {
  const told = new Set<string>();
  for (const r of priorReplies) for (const t of topicsIn(r)) told.add(t.label);

  const questions: string[] = [];
  for (const r of priorReplies.slice(-6)) {
    const q = closingQuestion(r);
    if (q && !questions.includes(q)) questions.push(q);
  }

  const answered = answeredUserMessages.map((m) => m.trim()).filter((m) => m && m !== "[imagem]").slice(-4);

  const lines: string[] = [];
  if (told.size) lines.push(`- Informacoes que voce JA deu: ${[...told].join(", ")}. So volte a elas se a pessoa pedir de novo.`);
  if (questions.length) lines.push(`- Perguntas que voce JA fez a ela (nao faca de novo, avance pra um assunto novo): ${questions.slice(-4).map((q) => `"${clip(q, 120)}"`).join("; ")}.`);
  if (answered.length) lines.push(`- Mensagens da pessoa que voce JA respondeu (nao responda de novo): ${answered.map((m) => `"${clip(m, 120)}"`).join("; ")}.`);
  if (!lines.length) return "";
  return `O QUE JA ACONTECEU NESTA CONVERSA (leia antes de responder e continue de onde ela parou):\n${lines.join("\n")}`;
}
