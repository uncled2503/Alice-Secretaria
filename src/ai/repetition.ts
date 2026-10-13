// ---------------------------------------------------------------------------
// ANTI-REPETICAO POR FRASE. O modelo as vezes "re-responde" perguntas antigas dentro da resposta nova (repete o valor, o
// endereco, o aviso de marca-passo...) e fecha todas as mensagens com a mesma pergunta. Aqui a gente detecta frases da
// resposta nova que a Alice JA disse nas ultimas respostas, pra reescrever ou cortar antes de enviar.
// ---------------------------------------------------------------------------

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function words(s: string): string[] {
  return normalize(s).split(" ").filter(Boolean);
}

function jaccard(a: string, b: string): number {
  const wa = new Set(words(a));
  const wb = new Set(words(b));
  if (!wa.size || !wb.size) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter);
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
export function repeatedSentences(draft: string, priorReplies: string[], threshold = 0.75): string[] {
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
