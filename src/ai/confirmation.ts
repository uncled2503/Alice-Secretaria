// ---------------------------------------------------------------------------
// RESPOSTA A CONFIRMACAO DE PRESENCA (pedido da Lisboa, 14/10/2026): quando a pessoa responde "pode sim" ao lembrete de
// confirmacao, a Alice SO agradece a confirmacao (ou manda o preparo do procedimento, se houver). Antes ela tratava como conversa
// nova e perguntava "voce ja fez o peeling antes?". Aqui a decisao e deterministica, sem depender do modelo.
// ---------------------------------------------------------------------------

import { usableFirstName } from "../crm/greeting.js";

function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[^\p{L}\p{N}\s?]/gu, " ").replace(/\s+/g, " ").trim();
}

// Resposta afirmativa curta ("pode sim", "confirmo", "estarei ai", "ok", "sim, combinado", "bom dia, pode sim").
const AFFIRM_RE =
  /\b(pode( contar)?( sim)?|sim|confirm(o|ado|ada|ar)|estarei( ai| la| presente)?|estaremos|vou sim|vou estar|ok|okay|certo|combinado|combinadissimo|claro|com certeza|perfeito|beleza|blz|tudo certo|presenca confirmada|ate la|ate amanha|ate logo|positivo)\b/;

// O que torna a mensagem outra coisa (pergunta, recusa, pedido de mudanca): nunca e so uma confirmacao.
const NOT_JUST_CONFIRM_RE =
  /\?|\b(nao|nem|cancel\w*|remarc\w*|reagend\w*|mudar|trocar|adiantar|atras\w*|infelizmente|imprevisto|desmarc\w*|quanto|onde|qual|quais|que horas|como|porque|por que|preciso|queria|gostaria|posso|poderia|duvida|valor|preco)\b/;

const GREETING_WORDS = new Set(["bom", "boa", "dia", "tarde", "noite", "oi", "ola", "obrigada", "obrigado", "obg", "valeu"]);

// PURO: a mensagem e SO uma confirmacao de presenca? (ate ~8 palavras, afirmativa, sem pergunta/recusa/pedido)
export function isConfirmationReply(text: string): boolean {
  const t = fold(text);
  if (!t || t.split(" ").length > 8) return false;
  if (NOT_JUST_CONFIRM_RE.test(t)) return false;
  if (!AFFIRM_RE.test(t)) return false;
  // sobra alguma palavra que nao e cumprimento/afirmacao? (ex.: "ok, quero um desconto") -> nao e so confirmacao
  const rest = t.replace(new RegExp(AFFIRM_RE.source, "g"), " ").split(" ").filter((w) => w && !GREETING_WORDS.has(w) && !["e", "a", "o", "as", "os", "de", "da", "do", "ai", "la", "tudo"].includes(w));
  return rest.length <= 1;
}

// PURO: resposta fixa. So agradece (o nome entra se houver).
export function confirmationThanks(name: string | null): string {
  const first = usableFirstName(name);
  return first ? `Obrigada pela confirmação, ${first}! 💗` : "Obrigada pela confirmação! 💗";
}
