// Chave de comparacao de nomes de procedimento entre a Alice e o Clinica Experts: sem acento, minusculas, pontuacao vira espaco,
// espacos colapsados. "Criolipólise - Abdômen" e "criolipolise abdomen" dao a mesma chave. NAO remove palavras (nem "(2 placas)"):
// "Criolipólise Abdômen (2 placas)" e "Criolipólise Abdômen" sao procedimentos DIFERENTES e nunca podem ser vinculados entre si.

export function procKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// PURO: semelhanca de 0 a 1 entre dois nomes (palavras em comum / palavras no total). So para SUGERIR, nunca para vincular sozinho.
export function nameSimilarity(a: string, b: string): number {
  const wa = new Set(procKey(a).split(" ").filter((w) => w.length > 1));
  const wb = new Set(procKey(b).split(" ").filter((w) => w.length > 1));
  if (!wa.size || !wb.size) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / new Set([...wa, ...wb]).size;
}
