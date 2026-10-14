// Mensagem so de cortesia ("ok", "obrigada!", "👍", "Obrigadaa") - nao pede resposta. Usado pela volta da Alice (humanReturn) e pelo
// encerramento depois de agendar (a pessoa agradece: so se finaliza, sem perguntas).

const ACK_WORDS = "ok okay oks blz beleza certo combinado obrigado obrigada obrigadinha obg valeu vlw perfeito show otimo entendi entendido ta bom muito maravilha legal tmj amem de nada disponha imagina".split(" ");

function normalized(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

// "obrigadaa", "okkk", "valeuuu" -> letras repetidas viram uma so (a comparacao e feita nas duas pontas).
const squeeze = (t: string) => t.replace(/(.)\1+/g, "$1");
const ACK = new Set(ACK_WORDS.map(squeeze));

// PURO
export function isCourtesyOnly(text: string): boolean {
  const tokens = normalized(text).split(" ").filter(Boolean);
  if (!tokens.length) return !/^\[(imagem|vídeo|áudio|arquivo)/i.test(text.trim()); // so emoji/pontuacao; anexo NAO e cortesia
  return tokens.length <= 5 && tokens.every((t) => ACK.has(squeeze(t)));
}

// Fechamento curto depois de agendar. Se a ultima fala da Alice ja foi um fechamento ("por nada", "de nada"), nao responde de novo (nao vira
// conversa de despedida sem fim): devolve "".
export function closingReply(name: string | null, lastAssistant: string): string {
  if (/\b(por nada|de nada)\b/i.test(lastAssistant)) return "";
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return first ? `Por nada, ${first}! 💗` : "Por nada! 💗";
}
