// ---------------------------------------------------------------------------
// Quem NAO precisa de recontato. Recontato e pra lead que sumiu no meio da
// conversa - nao pra quem ja agendou, ja esta na clinica hoje ou encerrou a
// conversa com um "ok" / "estarei ai".
// ---------------------------------------------------------------------------

const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

// Mensagem curta que FECHA o assunto ("ok", "estarei ai", "obrigada", "combinado", 👍).
const CLOSING =
  /^(ok+|okay|oks|okk+|certo|certinho|combinado|blz|beleza|perfeito|show|fechado|tranquilo|obrigad[oa]s?( [a-z]+)?|valeu|vlw|estarei (ai|la)|to indo|ate (la|logo|amanha|breve|mais)|^agradeco|sim|isso mesmo)\b[ !.,]*$/;

export function isClosingMessage(text: string | null | undefined): boolean {
  const raw = (text ?? "").trim();
  if (!raw || raw.length > 40) return false;
  const letters = fold(raw).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!letters) return true; // so emoji/figurinha (👍 ❤️ 🙏): conversa encerrada
  return CLOSING.test(letters);
}

// RECUSA EXPLICITA do interesse na ULTIMA mensagem da pessoa ("nao tenho interesse", "desisti", "ja fechei em outro lugar", "pode esquecer"): respeitar e consentimento, nao politica
// nova de contato. So frases inequivocas; "nao quero agora" / "vou pensar" ficam com o juiz (podem voltar). Texto longo e conversa, nao recusa.
const REFUSAL =
  /\b(nao tenho (mais )?interesse|sem interesse|nao (me )?interessa|nao quero (mais )?(fazer|o procedimento|agendar|marcar|nada)|desisti|ja (fiz|fechei|resolvi|contratei)( isso| tudo)? (em|com|na|no) (outr[oa]|outra clinica)|pode (me )?esquecer|nao precisa (mais )?(me )?(chamar|procurar|retornar)|deixa (pra la|quieto))\b/;

export function isExplicitRefusal(text: string | null | undefined): boolean {
  const raw = (text ?? "").trim();
  if (!raw || raw.length > 160) return false;
  const letters = fold(raw).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  if (/\b(talvez|depois|mais tarde|por enquanto|agora nao|semana que vem|mes que vem)\b/.test(letters)) return false; // adiamento, nao recusa
  return REFUSAL.test(letters);
}
