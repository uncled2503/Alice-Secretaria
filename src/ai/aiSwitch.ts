// Liga/desliga os recursos que dependem da OpenAI alem da conversa (revisao de envio, memoria do lead). Producao: ligado quando ha chave da OpenAI.
// Nos testes (chave "test-key") fica desligado a menos que o teste ligue de proposito (AI_SEND_REVIEW=on / AI_BRIEFING=on); "off" desliga em qualquer lugar.
export function aiExtraEnabled(flag: "AI_SEND_REVIEW" | "AI_BRIEFING"): boolean {
  const v = (process.env[flag] ?? "").trim().toLowerCase();
  if (v === "off") return false;
  if (v === "on") return true;
  const key = process.env.OPENAI_API_KEY?.trim();
  return !!key && key !== "test-key";
}
