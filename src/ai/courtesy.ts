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

// Resposta POSITIVA a mensagem de acompanhamento pos-procedimento ("estou otima e sem roxinho", "amei", "tudo bem"): so se agradece.
const POSITIVE_RE = /(estou|esta|tudo|ficou|foi|to|ta)\s+(otim|bem|perfeit|maravilh|tranquil|lind|joia)|sem (dor|roxo|roxinho|incha|inchaco|problema|nada|vermelh)|amei|adorei|gostei|gracas a deus|nada de (dor|incha|roxo)|resultado (lindo|otimo)/;
const PROBLEM_RE = /\?|\b(dor|doi|doendo|incha\w*|roxo|roxa|vermelh\w*|coceira|ardor|queim\w*|bolha|febre|pus|problema|preocup\w*|incomod\w*|estranho|diferente|nao (gostei|ficou|melhorou|consigo))\b/;

// PURO
export function isPositiveFeedback(text: string): boolean {
  const t = normalized(text);
  if (!t || t.split(" ").length > 20) return false;
  if (text.includes("?")) return false; // pergunta: nao e so feedback (a normalizacao tira a pontuacao, por isso olha o texto original)
  // pedido/pergunta sem "?" ("estou otima, queria saber o endereco", "amei, quero marcar outra"): tambem nao e so feedback
  if (/\b(queria|quero|gostaria|saber|qual|quais|quanto|onde|como|quando|endereco|valor|preco|posso|podem|tem como|agendar|marcar|remarcar|horario|telefone|contato)\b/.test(t)) return false;
  // "sem roxinho" / "sem dor" sao positivos: tira esses trechos antes de procurar problema.
  const withoutNegatedProblem = t.replace(/\bsem (dor|roxo|roxinho|incha\w*|problema\w*|vermelh\w*|nada)\b/g, " ").replace(/\bnada de (dor|incha\w*|roxo)\b/g, " ");
  return POSITIVE_RE.test(t) && !PROBLEM_RE.test(withoutNegatedProblem);
}

export function feedbackThanks(name: string | null): string {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return first ? `Que bom saber, ${first}! 💗 Qualquer dúvida é só chamar.` : "Que bom saber! 💗 Qualquer dúvida é só chamar.";
}
