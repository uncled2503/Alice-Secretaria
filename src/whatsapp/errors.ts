export function describeWhatsAppConnectionError(
  statusCode: number | undefined,
  rawMessage: string,
  usingProxy: boolean
): string {
  if (statusCode === 428) {
    return usingProxy
      ? "O WhatsApp recusou a conexão pela proxy (erro 428). Verifique se a proxy está ativa, é estável e não troca de IP."
      : "O WhatsApp recusou o IP da VPS (erro 428). Configure WHATSAPP_PROXY_URL com uma proxy residencial ou móvel estável.";
  }
  if (statusCode === 408) {
    return "A VPS não conseguiu abrir a conexão com o WhatsApp (erro 408). Verifique firewall, saída WebSocket e a proxy configurada.";
  }
  if (statusCode === 401) {
    return "A sessão do WhatsApp foi encerrada (erro 401). Gere um QR Code novo.";
  }
  if (statusCode === 515) {
    return "O WhatsApp pediu para reiniciar a conexão após o pareamento (erro 515). A reconexão será feita automaticamente.";
  }

  const suffix = statusCode ? ` (erro ${statusCode})` : "";
  const detail = rawMessage && rawMessage !== "?" ? `: ${rawMessage}` : "";
  return `Não foi possível conectar ao WhatsApp${suffix}${detail}.`;
}
