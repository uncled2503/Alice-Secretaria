// Combinado com a Lisboa (14/10/2026): a Alice oferece NO MAXIMO 3 horarios por vez. A ferramenta de agenda ja devolve ate 3; esta trava
// corta o excesso quando o modelo lista mais (uma linha por horario, com marcador).

const BULLET_RE = /^\s*(?:[-•*·]|\d+[.)])\s+/;
const TIME_RE = /\b\d{1,2}\s?(?::|h)\s?\d{0,2}\b|\b\d{1,2}h\b/;

// PURO: mantem as 'max' primeiras linhas de horario (com marcador) e remove as demais.
export function capSlotLines(text: string, max = 3): string {
  const lines = text.split("\n");
  const slotIdx = lines.map((l, i) => (BULLET_RE.test(l) && TIME_RE.test(l) ? i : -1)).filter((i) => i >= 0);
  if (slotIdx.length <= max) return text;
  const drop = new Set(slotIdx.slice(max));
  return lines.filter((_, i) => !drop.has(i)).join("\n").replace(/\n{3,}/g, "\n\n");
}
