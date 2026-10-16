// Combinado com a Lisboa (14/10/2026): a Alice oferece NO MAXIMO 3 horarios por vez. A ferramenta de agenda ja devolve ate 3; esta trava
// corta o excesso quando o modelo lista mais (uma linha por horario, com marcador).

const BULLET_RE = /^\s*(?:[-•*·]|\d+[.)])\s+/;
const TIME_RE = /\b\d{1,2}\s?(?::|h)\s?\d{0,2}\b|\b\d{1,2}h\b/;

const DATE_WORD_RE = /\b\d{1,2}\/\d{1,2}\b|\b(hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo)\b/i;
const HOURS_RANGE_RE = /\b(?:das?|de|entre)\s+\d{1,2}(?::\d{2}|h\d{0,2})?\s*(?:as|a|ate|e)\s+\d{1,2}/;
const SLOT_SENTENCE_RE =
  /(horarios? (disponiveis|livres)|(temos|tenho) (alguns |estes |esses )?horarios|qual (desses|deles|dessas)|quais desses|para agendar (a |uma )?avaliacao|funciona melhor pra voce|fica melhor pra voce)/;
const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

// PURO: tira da resposta a lista de horarios e as frases que a apresentam ("Para agendar a avaliacao, temos alguns horarios:", "Qual desses funciona
// melhor pra voce?"). Usado quando a pessoa NAO pediu horario: a Alice nao pode oferecer horarios do nada.
export function stripSlotOffers(text: string): string {
  const kept = text
    .split("\n")
    .filter((l) => {
      if (HOURS_RANGE_RE.test(fold(l))) return true; // "das 9h as 19h" e horario de funcionamento, nao oferta
      return !(TIME_RE.test(l) && (BULLET_RE.test(l) || DATE_WORD_RE.test(fold(l))));
    })
    .filter((l) => !SLOT_SENTENCE_RE.test(fold(l)) || l.trim().length > 140);
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// PURO: mantem as 'max' primeiras linhas de horario (com marcador) e remove as demais.
export function capSlotLines(text: string, max = 3): string {
  const lines = text.split("\n");
  const slotIdx = lines.map((l, i) => (BULLET_RE.test(l) && TIME_RE.test(l) ? i : -1)).filter((i) => i >= 0);
  if (slotIdx.length <= max) return text;
  const drop = new Set(slotIdx.slice(max));
  return lines.filter((_, i) => !drop.has(i)).join("\n").replace(/\n{3,}/g, "\n\n");
}
