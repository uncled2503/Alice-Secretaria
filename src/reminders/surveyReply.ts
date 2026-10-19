// ---------------------------------------------------------------------------
// COMO A ALICE LE A RESPOSTA DA PESQUISA DE SATISFACAO (0 a 10). Tudo PURO (testavel). Antes quem decidia se "10" era nota era o modelo, lendo uma
// instrucao no prompt: qualquer numero depois da pesquisa podia virar nota ("pode ser as 10", "tenho 10 sessoes"), a mesma mensagem podia ser gravada duas
// vezes e uma nota alta com reclamacao ganhava link e pedido de indicacao. Agora o codigo decide e so entrega ao modelo o que NAO e numero.
//
// Regras:
//  - numero SOZINHO ("10", "9!", "dez") so vale se a ultima pergunta da Alice foi a pesquisa (ninguem perguntou outra coisa depois);
//  - numero com MARCA clara de nota vale sempre: "nota 9", "dou 10", "9 de 10", "10/10", "nota dez";
//  - horario ("as 10", "10h", "10:30"), data ("dia 10", "10/11"), quantidade ("10 sessoes", "10 reais") e idade ("tenho 10 anos") NUNCA sao nota;
//  - so inteiros de 0 a 10 ("9,5" nao e nota: o modelo pergunta de novo);
//  - o que vem junto do numero e comentario; comentario com problema/queixa marca a nota como COM RECLAMACAO.
// ---------------------------------------------------------------------------

function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

const WORDS: Record<string, number> = { zero: 0, um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10 };
const NUM = "(\\d{1,2}|zero|uma?|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez)";
const NUM_BARE = "(\\d{1,2}|zero|tres|quatro|cinco|seis|sete|oito|nove|dez)"; // sozinho, "um/uma/dois/duas" sao artigo/contagem comuns: so valem com marca de nota

// Sinais de que o numero NAO e nota.
const TIME_BEFORE = /\b(as|a partir das|por volta das|ate as|antes das|depois das|so as|umas)\s*$/;
const TIME_AFTER = /^\s*(h\b|hs\b|horas?\b|:\d\d|hrs?\b|min\b|minutos?\b)/;
const DATE_BEFORE = /\b(dia|no dia|em|ate o dia|desde o dia)\s*$/;
const DATE_AFTER = /^\s*(\/|\-)\s*\d|^\s*de\s+(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/;
const QTY_AFTER = /^\s*(sessoes?|sessao|vezes|reais|real|r\$|anos?|meses|mes|dias?|semanas?|unidades?|pessoas?|ml|mg|kg|quilos?|procedimentos?|parcelas?|x\b|pacotes?)/;
const AGE_BEFORE = /\b(tenho|completei|fiz|faz|faco|farei)\s*$/;

// Marca explicita de nota.
const EXPLICIT = [
  new RegExp(`\\bnota\\s*(?:de\\s*)?${NUM}\\b`),
  new RegExp(`\\b(?:dou|daria|dei|merece|mereceu|ficou com|da pra dar)\\s*(?:um\\s*|uma\\s*)?(?:nota\\s*)?${NUM}\\b`),
  new RegExp(`\\b${NUM}\\s*(?:de|\\/)\\s*(?:0 a )?10\\b`),
  new RegExp(`\\b${NUM}\\s*(?:pontos|estrelas)\\b`),
];

// Comentario que traz problema/queixa (a nota alta NAO autoriza link nem indicacao: a equipe cuida primeiro).
const COMPLAINT_RE =
  /\b(mas|porem|so que|entretanto|contudo|infelizmente|problema|problemas|reclam\w*|demor\w*|esper(ei|ou|ar|amos)\b.*\b(muito|bastante|horas)|ruim|pessim\w*|horrivel|nao gostei|nao curti|decepcion\w*|dor\b|doeu|queim\w*|manch\w*|alergi\w*|inch\w*|vermelh\w*|ardeu|arde|machuc\w*|atras\w*|desorganiz\w*|mal atendid\w*|mau atendimento|cobr\w* errad\w*|caro demais|nao resolveu|nao funcionou|sem resultado|nao vi resultado|nao melhorou|piorou)\b/;

export interface SurveyMessageCtx {
  role: string; // user | assistant | human
  content: string;
  authorName?: string | null;
}

export type SurveyReading =
  | { kind: "score"; score: number; comment: string | null; complaint: boolean; explicit: boolean }
  | { kind: "other"; reason: "sem_numero" | "numero_nao_e_nota" | "nota_fracionada" | "fora_do_contexto_da_pesquisa" | "mais_de_um_numero" };

const toNumber = (raw: string): number | null => {
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw in WORDS ? WORDS[raw] : null;
};

// `thread` = a pergunta da pesquisa e tudo o que veio DEPOIS (Alice e pessoa, em ordem), terminando na mensagem atual da pessoa (o ultimo item e a leitura).
export function readSurveyReply(text: string, thread: SurveyMessageCtx[]): SurveyReading {
  const t = fold(text).replace(/\s+/g, " ").trim();
  if (!t) return { kind: "other", reason: "sem_numero" };
  if (/\d[.,]\d/.test(t) && /\b\d[.,]\d\b/.test(t)) return { kind: "other", reason: "nota_fracionada" };

  // 1) marca explicita de nota
  for (const [i, re] of EXPLICIT.entries()) {
    const m = re.exec(t);
    if (!m) continue;
    const n = toNumber(m[1]);
    if (n == null || n < 0 || n > 10) continue;
    // "10/10" e "8 de 10" sao a PROPRIA marca de nota (nao confundir com data): o padrao de razao dispensa o teste de data
    if (isNotAScore(t, m.index + m[0].indexOf(m[1]), m[1], i === 2)) continue;
    const rest = t.replace(m[0], " ").replace(/\s+/g, " ").trim();
    return scoreOf(n, rest, true);
  }

  // 2) numero sozinho (a mensagem inteira e o numero, com pontuacao/emoji no maximo)
  const bare = new RegExp(`^${NUM_BARE}[!.\\s]*$`).exec(t.replace(/[^\p{L}\p{N}\s!.,]/gu, "").trim());
  if (bare) {
    const n = toNumber(bare[1]);
    if (n == null || n < 0 || n > 10) return { kind: "other", reason: "numero_nao_e_nota" };
    // so vale se a ULTIMA fala da Alice/da clinica antes dessa mensagem foi a pesquisa (ninguem perguntou outra coisa depois: horario, procedimento...)
    const lastOut = [...thread.slice(0, -1)].reverse().find((m) => m.role !== "user");
    const asked = !!lastOut && (/pesquisa|satisfa/.test(fold(lastOut.authorName ?? "")) || /\bde 0 a 10\b|escala de 0 a 10|nota de 0 a 10|0 a 10/.test(fold(lastOut.content)));
    if (!asked) return { kind: "other", reason: "fora_do_contexto_da_pesquisa" };
    return scoreOf(n, "", false);
  }

  // 2b) comeca pelo numero e segue com um comentario ("10, amei o atendimento", "9 mas demorou"): nota, se a pesquisa foi a ultima pergunta e o numero nao tem cara de horario/data/quantidade
  const lead = new RegExp(`^${NUM_BARE}(?=[\\s,.!:;\\-])`).exec(t);
  if (lead) {
    const rest = t.slice(lead[0].length);
    const n = toNumber(lead[1]);
    const lastOut = [...thread.slice(0, -1)].reverse().find((m) => m.role !== "user");
    const asked = !!lastOut && (/pesquisa|satisfa/.test(fold(lastOut.authorName ?? "")) || /0 a 10/.test(fold(lastOut.content)));
    if (n != null && n >= 0 && n <= 10 && asked && !/\d/.test(rest) && !isNotAScore(t, 0, lead[1])) return scoreOf(n, rest, false);
  }

  // 3) numero no meio de uma frase sem marca de nota: nao adivinhamos (o modelo pergunta "de 0 a 10, qual nota voce daria?")
  const digits = [...t.matchAll(/\b\d{1,2}\b/g)];
  if (digits.length > 1) return { kind: "other", reason: "mais_de_um_numero" };
  const m = digits[0];
  if (!m) return { kind: "other", reason: "sem_numero" };
  if (Number(m[0]) > 10 || isNotAScore(t, m.index ?? 0, m[0])) return { kind: "other", reason: "numero_nao_e_nota" };
  return { kind: "other", reason: "fora_do_contexto_da_pesquisa" };
}

function isNotAScore(t: string, index: number, token: string, ratio = false): boolean {
  const before = t.slice(Math.max(0, index - 24), index);
  const afterTxt = t.slice(index + token.length, index + token.length + 16);
  return TIME_BEFORE.test(before) || TIME_AFTER.test(afterTxt) || DATE_BEFORE.test(before) || (!ratio && DATE_AFTER.test(afterTxt)) || QTY_AFTER.test(afterTxt) || AGE_BEFORE.test(before);
}

function scoreOf(score: number, rest: string, explicit: boolean): SurveyReading {
  const comment = rest.replace(/^[,;:.!\-\s]+|[,;:.!\-\s]+$/g, "").trim();
  return { kind: "score", score, comment: comment || null, complaint: COMPLAINT_RE.test(comment), explicit };
}

export function hasComplaint(text: string | null | undefined): boolean {
  return COMPLAINT_RE.test(fold(text ?? ""));
}

export type ScoreBand = "baixa" | "neutra" | "positiva";

// A faixa da nota: baixa (<= 6, aviso a equipe), positiva (>= nota de corte da clinica, padrao 9), neutra no meio.
export function scoreBand(score: number, threshold: number): ScoreBand {
  if (score <= 6) return "baixa";
  return score >= threshold ? "positiva" : "neutra";
}
