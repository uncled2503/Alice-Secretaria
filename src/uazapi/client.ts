import axios from "axios";

// Credenciais da instancia UazAPI de UMA clinica. Cada clinica com WhatsApp
// proprio tem seu par baseUrl/token (guardado em Clinic.uazapiBaseUrl/
// uazapiToken); quando nulos, cai no .env (modo legado de clinica unica).
export interface UazapiCreds {
  baseUrl?: string | null;
  token?: string | null;
}

export function creds(clinic: { uazapiBaseUrl?: string | null; uazapiToken?: string | null }): UazapiCreds {
  return { baseUrl: clinic.uazapiBaseUrl, token: clinic.uazapiToken };
}

function client(c?: UazapiCreds) {
  const baseURL = c?.baseUrl || process.env.UAZAPI_BASE_URL!;
  const token = c?.token || process.env.UAZAPI_TOKEN!; // token da INSTANCIA (nao o admintoken usado so pra criar/listar instancias)
  return axios.create({ baseURL, headers: { token }, timeout: 15_000 });
}

// Endpoints confirmados contra o OpenAPI real da uazapiGO (motor por tras da
// UazAPI). O header "token" identifica a instancia sozinho, sem precisar de
// um campo "instance" no corpo.

export async function sendText(phone: string, text: string, c?: UazapiCreds): Promise<void> {
  await client(c).post("/send/text", {
    number: phone,
    text,
  });
}

export async function getConnectionStatus(c?: UazapiCreds): Promise<unknown> {
  const { data } = await client(c).get("/instance/status");
  return data;
}

// A uazapiGO ja transcreve audio pra gente (usa a mesma chave OpenAI que a
// Alice usa pra conversar) - evita ter que baixar o arquivo e chamar o
// Whisper por conta propria. Retorna null se a mensagem nao for audio
// (ex: imagem/video/documento, que nao tem transcricao).
export async function transcribeAudio(messageId: string, c?: UazapiCreds): Promise<string | null> {
  const { data } = await client(c).post("/message/download", {
    id: messageId,
    transcribe: true,
    openai_apikey: process.env.OPENAI_API_KEY,
    return_link: false,
    return_base64: false,
  });
  return data?.transcription || null;
}

export interface IncomingMessage {
  phone: string;
  text?: string;
  mediaMessageId?: string; // presente quando a mensagem e midia (audio/imagem/etc) sem texto direto
  pushName?: string;
  instanceToken?: string; // token da instancia que recebeu a mensagem - identifica a clinica
}

// Normaliza o payload cru do webhook da uazapiGO (evento "messages") pro
// formato interno. Confirmado empiricamente com uma mensagem real - o
// WhatsApp agora usa "lid" (id vinculado) como sender por padrao, entao o
// telefone de verdade vem em chat.phone/message.sender_pn, nao em message.sender.
export function parseWebhookPayload(body: any): IncomingMessage | null {
  const message = body?.message;
  if (!message) return null;
  if (message.fromMe || message.wasSentByApi) return null; // eco do que a propria Alice/API mandou
  if (message.isGroup) return null; // secretaria atende so conversa individual

  const phone: string | undefined = body?.chat?.phone ?? message.sender_pn?.replace(/@.*/, "");
  if (!phone) return null;

  // message.text e sempre string quando ha texto legivel. message.content e o
  // payload bruto do whatsmeow: as vezes objeto mesmo pra mensagem de texto
  // (contextInfo etc), e SEMPRE objeto pra midia (audio/imagem/video) - nunca
  // deve ser usado como texto diretamente.
  const text: string | undefined = typeof message.text === "string" && message.text ? message.text : undefined;
  const isMedia = !text && message.content && typeof message.content === "object";

  return {
    phone: phone.replace(/\D/g, ""),
    text,
    mediaMessageId: isMedia ? message.messageid : undefined,
    pushName: message.senderName || undefined,
    instanceToken: body?.token || undefined,
  };
}
