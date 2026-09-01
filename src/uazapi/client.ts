import crypto, { timingSafeEqual } from "crypto";
import OpenAI from "openai";
import { toFile } from "openai";
import { prisma } from "../db/client.js";
import { recordIncomingMessage, generateReply } from "../ai/alice.js";

type JsonRecord = Record<string, unknown>;

export interface UazapiCredentials {
  baseUrl: string;
  token: string;
}

export interface UazapiConnectionStatus {
  configured: boolean;
  connected: boolean;
  connecting: boolean;
  qr: string | null;
  lastError: string | null;
  profileName?: string | null;
  phone?: string | null;
}

export interface IncomingUazapiMessage {
  externalId: string;
  phone: string;
  text?: string;
  mediaMessageId?: string; // audio/ptt a transcrever
  imageMessageId?: string; // foto a interpretar (visao)
  pushName?: string;
  referral?: IncomingReferralData; // Click-to-WhatsApp (so no 1o contato)
}

export interface IncomingReferralData {
  ctwaClid?: string;
  sourceUrl?: string;
  adCampaignName?: string;
  adsetName?: string;
  adName?: string;
}

const REQUEST_TIMEOUT_MS = 25_000;
const AVATAR_TTL_MS = 6 * 60 * 60 * 1000;
const STATUS_TTL_MS = 4_000;
const avatarCache = new Map<string, { url: string | null; fetchedAt: number }>();
const statusCache = new Map<string, { status: UazapiConnectionStatus; fetchedAt: number }>();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
let webhookWorkerRunning = false;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function textValue(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function boolValue(...values: unknown[]): boolean {
  return values.some((value) => value === true || value === "true" || value === 1);
}

function normalizeHttpsBaseUrl(value: string): string {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "https:") throw new Error("A URL precisa usar HTTPS");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("URL invalida");
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

export function normalizeUazapiBaseUrl(value: string): string {
  const normalized = normalizeHttpsBaseUrl(value);
  const hostname = new URL(normalized).hostname.toLowerCase();
  if (hostname !== "uazapi.com" && !hostname.endsWith(".uazapi.com")) {
    throw new Error("Endereco de servidor invalido. Use a URL exata da instancia, comecando com https://.");
  }
  return normalized;
}

async function clinicCredentials(clinicId: string): Promise<UazapiCredentials> {
  const clinic = await prisma.clinic.findUniqueOrThrow({
    where: { id: clinicId },
    select: { uazapiBaseUrl: true, uazapiToken: true },
  });
  if (!clinic.uazapiBaseUrl || !clinic.uazapiToken) {
    throw new Error("Configure a URL do servidor e o token da instancia desta clinica");
  }
  return { baseUrl: normalizeUazapiBaseUrl(clinic.uazapiBaseUrl), token: clinic.uazapiToken };
}

// Traduz as falhas mais comuns de configuracao (URL do servidor errada ou
// token que nao pertence aquela instancia) numa mensagem acionavel. Cada conta
// fica num subdominio proprio: um token valido num servidor responde 401
// "Invalid token." em outro, e um host inexistente responde 404.
function explainCredentialError(error: unknown, baseUrl: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/HTTP 401/.test(message)) {
    return new Error(
      `O servidor recusou o token (401). Confirme que ${baseUrl} e a URL exata da instancia e que voce ` +
        "colou o token da instancia (nao o token de administracao), sem espacos."
    );
  }
  if (/HTTP 404/.test(message)) {
    return new Error(
      `${baseUrl} nao respondeu como esperado (404). Confirme a URL do servidor da instancia, comecando com https://.`
    );
  }
  return error instanceof Error ? error : new Error(message);
}

function uazapiError(status: number, body: unknown): Error {
  const data = record(body);
  const message = textValue(
    data?.message_ptbr,
    data?.provider_message_ptbr,
    data?.error,
    data?.message,
    data?.provider_message
  );
  return new Error(`Servidor de conexao HTTP ${status}${message ? `: ${message}` : ""}`);
}

async function request<T>(credentials: UazapiCredentials, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${credentials.baseUrl}${path}`, {
    ...init,
    headers: {
      token: credentials.token,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const raw = await response.text();
  let body: unknown = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw;
  }
  if (!response.ok) throw uazapiError(response.status, body);
  return body as T;
}

function qrDataUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const qr = value.trim();
  return qr.startsWith("data:image/") ? qr : `data:image/png;base64,${qr}`;
}

export function normalizeStatusResponse(body: unknown): UazapiConnectionStatus {
  const root = record(body) ?? {};
  const instance = record(root.instance) ?? {};
  const status = record(root.status) ?? {};
  const jid = record(status.jid) ?? record(root.jid) ?? {};
  const state = textValue(instance.status, root.state, root.status);
  const connected = boolValue(status.connected, root.connected, root.loggedIn) || state === "connected";
  const phone = textValue(jid.user, instance.owner)?.replace(/\D/g, "") || null;
  return {
    configured: true,
    connected,
    connecting: !connected && state === "connecting",
    qr: qrDataUrl(instance.qrcode ?? root.qrcode),
    lastError: connected ? null : textValue(instance.lastDisconnectReason, root.error) ?? null,
    profileName: textValue(instance.profileName) ?? null,
    phone,
  };
}

export async function getStatus(clinicId: string): Promise<UazapiConnectionStatus> {
  const cached = statusCache.get(clinicId);
  if (cached && Date.now() - cached.fetchedAt < STATUS_TTL_MS) return cached.status;

  let credentials: UazapiCredentials;
  try {
    credentials = await clinicCredentials(clinicId);
  } catch (error) {
    const status: UazapiConnectionStatus = {
      configured: false,
      connected: false,
      connecting: false,
      qr: null,
      lastError: error instanceof Error ? error.message : "conexao nao configurada",
    };
    statusCache.set(clinicId, { status, fetchedAt: Date.now() });
    return status;
  }

  try {
    const status = normalizeStatusResponse(await request(credentials, "/instance/status"));
    if (status.phone && /^\d{10,15}$/.test(status.phone)) {
      await prisma.clinic.update({ where: { id: clinicId }, data: { whatsappPhone: status.phone } }).catch(() => {});
    }
    statusCache.set(clinicId, { status, fetchedAt: Date.now() });
    return status;
  } catch (error) {
    const status: UazapiConnectionStatus = {
      configured: true,
      connected: false,
      connecting: false,
      qr: null,
      lastError: error instanceof Error ? error.message : "Falha ao consultar o servidor de conexao",
    };
    statusCache.set(clinicId, { status, fetchedAt: Date.now() });
    return status;
  }
}

function webhookSecret(): string {
  const secret = process.env.UAZAPI_WEBHOOK_SECRET?.trim();
  if (!secret || secret.length < 32) throw new Error("Configure UAZAPI_WEBHOOK_SECRET com pelo menos 32 caracteres");
  return secret;
}

function publicBaseUrl(): string {
  const value = process.env.PUBLIC_BASE_URL?.trim();
  if (!value) throw new Error("Configure PUBLIC_BASE_URL com o endereco HTTPS publico da Alice");
  return normalizeHttpsBaseUrl(value);
}

export function webhookSignature(clinicId: string): string {
  return crypto.createHmac("sha256", webhookSecret()).update(clinicId).digest("hex");
}

export function verifyWebhookSignature(clinicId: string, signature: string): boolean {
  try {
    const expected = Buffer.from(webhookSignature(clinicId), "utf8");
    const received = Buffer.from(signature, "utf8");
    return expected.length === received.length && timingSafeEqual(expected, received);
  } catch {
    return false;
  }
}

async function configureWebhook(clinicId: string, credentials: UazapiCredentials): Promise<void> {
  const url = `${publicBaseUrl()}/api/uazapi/webhook/${encodeURIComponent(clinicId)}/${webhookSignature(clinicId)}`;
  await request(credentials, "/webhook", {
    method: "POST",
    body: JSON.stringify({
      enabled: true,
      url,
      events: ["messages", "connection", "presence"],
      excludeMessages: ["wasSentByApi", "fromMeYes", "isGroupYes"],
      addUrlEvents: false,
      addUrlTypesMessages: false,
    }),
  });
}

export async function saveUazapiConfig(
  clinicId: string,
  input: { baseUrl: string; token?: string }
): Promise<{ configured: boolean; webhookConfigured: boolean; status: UazapiConnectionStatus }> {
  const existing = await prisma.clinic.findUniqueOrThrow({
    where: { id: clinicId },
    select: { uazapiToken: true },
  });
  const baseUrl = normalizeUazapiBaseUrl(input.baseUrl);
  const token = input.token?.trim() || existing.uazapiToken;
  if (!token) throw new Error("Informe o token da instancia");

  const credentials = { baseUrl, token };
  let status: UazapiConnectionStatus;
  try {
    status = normalizeStatusResponse(await request(credentials, "/instance/status"));
  } catch (error) {
    throw explainCredentialError(error, baseUrl);
  }
  try {
    await prisma.clinic.update({ where: { id: clinicId }, data: { uazapiBaseUrl: baseUrl, uazapiToken: token } });
  } catch (error) {
    if (record(error)?.code === "P2002") {
      throw new Error("Este token ja esta vinculado a outra clinica");
    }
    throw error;
  }
  statusCache.delete(clinicId);

  let webhookConfigured = false;
  try {
    await configureWebhook(clinicId, credentials);
    webhookConfigured = true;
  } catch (error) {
    console.warn(`[UAZAPI] Credenciais salvas para ${clinicId}, mas o webhook ainda nao foi configurado:`, error);
  }
  return { configured: true, webhookConfigured, status };
}

export async function getUazapiConfig(clinicId: string): Promise<{ configured: boolean; baseUrl: string; tokenHint: string | null }> {
  const clinic = await prisma.clinic.findUniqueOrThrow({
    where: { id: clinicId },
    select: { uazapiBaseUrl: true, uazapiToken: true },
  });
  return {
    configured: !!(clinic.uazapiBaseUrl && clinic.uazapiToken),
    baseUrl: clinic.uazapiBaseUrl ?? "",
    tokenHint: clinic.uazapiToken ? `••••${clinic.uazapiToken.slice(-4)}` : null,
  };
}

// Reaplica a config do webhook na instancia (ex: pra passar a receber os
// eventos de "digitando" numa conta que ja estava conectada).
export async function reapplyWebhook(clinicId: string): Promise<void> {
  const credentials = await clinicCredentials(clinicId);
  await configureWebhook(clinicId, credentials);
}

export async function connectClinic(clinicId: string): Promise<void> {
  const credentials = await clinicCredentials(clinicId);
  // O webhook (recepcao de mensagens) depende de PUBLIC_BASE_URL/UAZAPI_WEBHOOK_SECRET
  // no servidor. Se faltar, ainda assim geramos o QR: conectar o WhatsApp e um passo
  // independente e o webhook pode ser ajustado depois sem reparear.
  try {
    await configureWebhook(clinicId, credentials);
  } catch (error) {
    console.warn(`[UAZAPI] QR gerado para ${clinicId} sem webhook configurado:`, error);
  }
  try {
    await request(credentials, "/instance/connect", {
      method: "POST",
      body: JSON.stringify({ browser: "auto" }),
    });
  } catch (error) {
    throw explainCredentialError(error, credentials.baseUrl);
  }
  statusCache.delete(clinicId);
}

export async function disconnectClinic(clinicId: string): Promise<void> {
  const credentials = await clinicCredentials(clinicId);
  await request(credentials, "/instance/disconnect", { method: "POST" });
  statusCache.delete(clinicId);
}

function splitMessage(text: string, maxParts: number): string[] {
  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  let parts = paragraphs.length > 1 ? paragraphs : text.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length <= 1) return [text];
  while (parts.length > maxParts) {
    let minIndex = 0;
    for (let index = 1; index < parts.length - 1; index++) {
      if (parts[index].length + parts[index + 1].length < parts[minIndex].length + parts[minIndex + 1].length) minIndex = index;
    }
    parts.splice(minIndex, 2, `${parts[minIndex]} ${parts[minIndex + 1]}`);
  }
  return parts;
}

export async function sendText(clinicId: string, phone: string, text: string): Promise<void> {
  const [credentials, config] = await Promise.all([
    clinicCredentials(clinicId),
    prisma.clinic.findUnique({
      where: { id: clinicId },
      select: { splitLongMessages: true, splitMaxMessages: true, splitThresholdChars: true },
    }),
  ]);
  const parts = config?.splitLongMessages && text.length > config.splitThresholdChars
    ? splitMessage(text, Math.max(config.splitMaxMessages, 1))
    : [text];

  for (let index = 0; index < parts.length; index++) {
    const delay = Math.min(3500, 500 + parts[index].length * 25);
    await request(credentials, "/send/text", {
      method: "POST",
      body: JSON.stringify({ number: phone.replace(/\D/g, ""), text: parts[index], delay, async: false }),
    });
    if (index < parts.length - 1) await new Promise((resolve) => setTimeout(resolve, 1000 + Math.random() * 2000));
  }
}

export async function getProfilePicUrl(clinicId: string, phone: string): Promise<string | null> {
  const cacheKey = `${clinicId}:${phone}`;
  const cached = avatarCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < AVATAR_TTL_MS) return cached.url;

  let url: string | null = null;
  try {
    const credentials = await clinicCredentials(clinicId);
    const response = record(await request(credentials, "/chat/details", {
      method: "POST",
      body: JSON.stringify({ number: phone.replace(/\D/g, ""), preview: true }),
    }));
    url = textValue(response?.imagePreview, response?.image) ?? null;
  } catch {
    url = null;
  }
  avatarCache.set(cacheKey, { url, fetchedAt: Date.now() });
  return url;
}

function messageCandidates(body: JsonRecord): JsonRecord[] {
  const data = record(body.data);
  const candidates: unknown[] = [body.message, data?.message];
  if (Array.isArray(body.messages)) candidates.push(...body.messages);
  if (Array.isArray(data?.messages)) candidates.push(...data.messages);
  if (data && (data.messageid || data.messageId || data.sender || data.chatid)) candidates.push(data);
  if (body.messageid || body.messageId || body.sender || body.chatid) candidates.push(body);
  return candidates.map(record).filter((value): value is JsonRecord => !!value);
}

// Dados do anuncio Click-to-WhatsApp que a Meta anexa na 1a mensagem. A forma
// exata varia por gateway; tentamos os formatos conhecidos (WhatsApp Cloud API
// `referral`, Baileys `contextInfo.externalAdReply`, campos achatados). Tudo
// opcional - se nao vier nada, o lead so nao ganha atribuicao de campanha.
function extractReferral(message: JsonRecord): IncomingReferralData | undefined {
  const content = record(message.content) ?? {};
  const ref =
    record(message.referral) ??
    record(content.referral) ??
    record(record(message.contextInfo)?.externalAdReply) ??
    record(record(content.contextInfo)?.externalAdReply) ??
    record(message.externalAdReply);

  const ctwaClid = textValue(
    message.ctwa_clid,
    message.ctwaClid,
    ref?.ctwa_clid,
    ref?.ctwaClid,
    ref?.click_id,
  );
  const sourceUrl = textValue(message.source_url, ref?.source_url, ref?.sourceUrl, ref?.url);
  const adName = textValue(ref?.headline, ref?.title, ref?.source_id, ref?.sourceId);
  const adCampaignName = textValue(ref?.campaign_name, ref?.campaignName, ref?.body);

  if (!ctwaClid && !sourceUrl && !adName && !adCampaignName) return undefined;
  return {
    ...(ctwaClid ? { ctwaClid } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(adName ? { adName } : {}),
    ...(adCampaignName ? { adCampaignName } : {}),
  };
}

function phoneFromJid(value: unknown, allowLid = false): string | null {
  if (typeof value !== "string" || !value) return null;
  if (value.endsWith("@g.us") || value === "status@broadcast" || (!allowLid && value.endsWith("@lid"))) return null;
  const digits = value.split("@")[0].replace(/\D/g, "");
  return /^\d{10,15}$/.test(digits) ? digits : null;
}

export function parseWebhookPayload(bodyValue: unknown): IncomingUazapiMessage[] {
  const body = record(bodyValue);
  if (!body) return [];
  const chat = record(body.chat) ?? record(record(body.data)?.chat) ?? {};
  const output: IncomingUazapiMessage[] = [];

  for (const message of messageCandidates(body)) {
    if (boolValue(message.fromMe, message.from_me, message.wasSentByApi, message.was_sent_by_api)) continue;
    if (boolValue(message.isGroup, message.is_group)) continue;

    const phone =
      phoneFromJid(chat.phone, true) ??
      phoneFromJid(message.sender_pn, true) ??
      phoneFromJid(message.senderPn, true) ??
      phoneFromJid(message.chatid) ??
      phoneFromJid(message.sender);
    if (!phone) continue;

    const externalId = textValue(message.messageid, message.messageId, message.message_id, message.id);
    if (!externalId) continue;
    const type = textValue(message.messageType, message.type)?.toLowerCase() ?? "";
    const content = record(message.content);
    const text = textValue(message.text, message.caption, message.body, content?.text, content?.conversation);
    const isAudio = type.includes("audio") || type.includes("ptt");
    const isImage = type.includes("image");

    output.push({
      externalId,
      phone,
      text,
      mediaMessageId: !text && isAudio ? externalId : undefined,
      imageMessageId: isImage ? externalId : undefined,
      pushName: textValue(message.senderName, message.sender_name, message.pushName, message.push_name),
      referral: extractReferral(message),
    });
  }
  return output;
}

async function transcribeAudio(clinicId: string, messageId: string): Promise<string | null> {
  try {
    const credentials = await clinicCredentials(clinicId);
    const response = record(await request(credentials, "/message/download", {
      method: "POST",
      body: JSON.stringify({ id: messageId, return_base64: true, return_link: false, generate_mp3: true, transcribe: false }),
    }));
    const encoded = textValue(response?.base64Data);
    if (!encoded) return null;
    const base64 = encoded.includes(",") ? encoded.slice(encoded.indexOf(",") + 1) : encoded;
    const file = await toFile(Buffer.from(base64, "base64"), "audio.mp3");
    const result = await openai.audio.transcriptions.create({ file, model: "whisper-1" });
    return result.text?.trim() || null;
  } catch (error) {
    console.error("[UAZAPI] Falha ao transcrever audio:", error);
    return null;
  }
}

// Baixa a foto que o cliente enviou e devolve como data URL, pra Alice
// "ver" a imagem (visao do modelo). Limita a ~4MB pra nao estourar o request.
async function downloadImageDataUrl(clinicId: string, messageId: string): Promise<string | null> {
  try {
    const credentials = await clinicCredentials(clinicId);
    const response = record(await request(credentials, "/message/download", {
      method: "POST",
      body: JSON.stringify({ id: messageId, return_base64: true, return_link: false, transcribe: false }),
    }));
    const encoded = textValue(response?.base64Data, response?.base64, response?.data);
    if (!encoded) return null;
    if (encoded.startsWith("data:")) return encoded.length > 6_000_000 ? null : encoded;
    const base64 = encoded.includes(",") ? encoded.slice(encoded.indexOf(",") + 1) : encoded;
    if (base64.length > 6_000_000) return null; // ~4.5MB de imagem
    const mime = textValue(response?.mimetype, response?.mimeType, record(response?.info)?.mimetype) ?? "image/jpeg";
    return `data:${mime};base64,${base64}`;
  } catch (error) {
    console.error("[UAZAPI] Falha ao baixar imagem:", error);
    return null;
  }
}

// --- Agrupamento de mensagens quebradas ------------------------------------
// O cliente costuma mandar varias mensagens curtas seguidas. Quando a clinica
// configura replyDelaySeconds > 0, a Alice espera esse tempo sem mensagem nova
// antes de responder - e responde a todas de uma vez. Estado em memoria (um
// restart perde os timers pendentes; as mensagens ja estao gravadas).
const MAX_TOTAL_WAIT_MS = 45_000;

interface PendingReply {
  timer: NodeJS.Timeout;
  conversationId: string;
  phone: string;
  imageDataUrl?: string;
  firstAt: number;
}
const pendingReplies = new Map<string, PendingReply>(); // key = `${clinicId}:${phone}`

function scheduleGroupedReply(clinicId: string, phone: string, conversationId: string, delayMs: number, imageDataUrl?: string): void {
  const key = `${clinicId}:${phone}`;
  const existing = pendingReplies.get(key);
  if (existing) clearTimeout(existing.timer);

  const firstAt = existing?.firstAt ?? Date.now();
  const img = imageDataUrl ?? existing?.imageDataUrl;
  const remaining = MAX_TOTAL_WAIT_MS - (Date.now() - firstAt);
  const wait = Math.max(0, Math.min(delayMs, remaining));

  const timer = setTimeout(() => {
    pendingReplies.delete(key);
    const startedAt = new Date();
    generateReply(conversationId, { imageDataUrl: img, guardAgainstNewerThan: startedAt })
      .then((reply) => {
        // Um novo agrupamento comecou enquanto gerava -> nao envia esta.
        if (pendingReplies.has(key)) return;
        if (reply) return sendText(clinicId, phone, reply);
      })
      .catch((err) => console.error("[reply-group] falha ao gerar/enviar:", err));
  }, wait);

  pendingReplies.set(key, { timer, conversationId, phone, imageDataUrl: img, firstAt });
}

// Sinal de "digitando": so ESTENDE um agrupamento ja em curso (nunca inicia).
export function bumpTypingWait(clinicId: string, phone: string, extraMs: number): void {
  const key = `${clinicId}:${phone}`;
  const e = pendingReplies.get(key);
  if (!e) return;
  scheduleGroupedReply(clinicId, phone, e.conversationId, extraMs, e.imageDataUrl);
}

async function handleQueuedPayload(clinicId: string, body: unknown): Promise<void> {
  for (const incoming of parseWebhookPayload(body)) {
    let text = incoming.text ?? null;
    let imageDataUrl: string | undefined;

    if (incoming.imageMessageId) {
      imageDataUrl = (await downloadImageDataUrl(clinicId, incoming.imageMessageId)) ?? undefined;
    } else if (!text && incoming.mediaMessageId) {
      text = await transcribeAudio(clinicId, incoming.mediaMessageId);
    }

    if (!text && !imageDataUrl) continue;

    const recorded = await recordIncomingMessage({
      clinicId,
      patientPhone: incoming.phone,
      patientName: incoming.pushName,
      text: text ?? "",
      imageDataUrl,
      referral: incoming.referral,
    });
    if (!recorded || recorded.humanTakeover) continue;

    if (recorded.replyDelayMs > 0) {
      scheduleGroupedReply(clinicId, incoming.phone, recorded.conversationId, recorded.replyDelayMs, imageDataUrl);
      continue;
    }

    const reply = await generateReply(recorded.conversationId, { imageDataUrl });
    if (reply) await sendText(clinicId, incoming.phone, reply);
  }
}

function webhookExternalId(body: unknown): string {
  const messages = parseWebhookPayload(body);
  const ids = messages.map((message) => message.externalId).sort();
  const stable = ids.length ? ids.join(",") : JSON.stringify(body);
  return crypto.createHash("sha256").update(stable).digest("hex");
}

// Detecta um evento de presenca ("digitando"). A forma exata varia; tentamos
// os campos conhecidos. Devolve o telefone se for "composing"/"recording".
function typingPhoneFromPresence(body: unknown): string | null {
  const root = record(body);
  if (!root) return null;
  const p =
    record(root.presence) ??
    record(record(root.data)?.presence) ??
    (textValue(root.type, root.event, root.EventType)?.toLowerCase().includes("presence") ? record(root.data) ?? root : null);
  if (!p) return null;
  const state = textValue(p.presence, p.lastKnownPresence, p.status, p.state)?.toLowerCase() ?? "";
  if (!state.includes("composing") && !state.includes("recording") && !state.includes("typing")) return null;
  return phoneFromJid(p.id, true) ?? phoneFromJid(p.chatid) ?? phoneFromJid(p.from) ?? phoneFromJid(p.participant);
}

export async function enqueueWebhook(clinicId: string, body: unknown): Promise<"queued" | "duplicate" | "presence"> {
  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { id: true, uazapiToken: true } });
  if (!clinic?.uazapiToken) throw new Error("Clinica sem conexao de WhatsApp configurada");

  const payloadToken = textValue(record(body)?.token);
  if (payloadToken) {
    const expected = Buffer.from(clinic.uazapiToken);
    const received = Buffer.from(payloadToken);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new Error("Token do webhook nao corresponde a clinica");
  }

  // Presenca ("digitando") nao entra na fila durante - so estende um
  // agrupamento ja em curso pra Alice esperar a pessoa terminar de escrever.
  const typingPhone = typingPhoneFromPresence(body);
  if (typingPhone) {
    bumpTypingWait(clinicId, typingPhone, 12_000);
    return "presence";
  }

  try {
    await prisma.uazapiWebhookEvent.create({
      data: { clinicId, externalId: webhookExternalId(body), payload: JSON.stringify(body) },
    });
  } catch (error: unknown) {
    if (record(error)?.code === "P2002") return "duplicate";
    throw error;
  }
  setImmediate(() => processUazapiWebhookQueue().catch((error) => console.error("[UAZAPI] Worker falhou:", error)));
  return "queued";
}

export async function processUazapiWebhookQueue(): Promise<void> {
  if (webhookWorkerRunning) return;
  webhookWorkerRunning = true;
  try {
    while (true) {
      const event = await prisma.uazapiWebhookEvent.findFirst({
        where: { status: { in: ["pending", "failed"] }, attempts: { lt: 3 } },
        orderBy: { createdAt: "asc" },
      });
      if (!event) break;
      await prisma.uazapiWebhookEvent.update({
        where: { id: event.id },
        data: { status: "processing", attempts: { increment: 1 }, error: null },
      });
      try {
        await handleQueuedPayload(event.clinicId, JSON.parse(event.payload));
        await prisma.uazapiWebhookEvent.update({ where: { id: event.id }, data: { status: "done" } });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await prisma.uazapiWebhookEvent.update({ where: { id: event.id }, data: { status: "failed", error: message.slice(0, 1000) } });
        console.error(`[UAZAPI] Evento ${event.id} falhou:`, error);
      }
    }
  } finally {
    webhookWorkerRunning = false;
  }
}

export async function startUazapiWebhookWorker(): Promise<void> {
  await resetStaleHistoryImports();
  await prisma.uazapiWebhookEvent.updateMany({ where: { status: "processing" }, data: { status: "pending" } });
  await prisma.uazapiWebhookEvent.deleteMany({
    where: { status: "done", createdAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60_000) } },
  });
  await processUazapiWebhookQueue();
}

interface ImportStats {
  found: number;
  created: number;
  merged: number;
  ignored: number;
  conversations: number;
  partialHistory: number;
}

function validImportedPhone(chat: JsonRecord): string | null {
  return phoneFromJid(chat.phone, true) ?? phoneFromJid(chat.wa_chatid);
}

async function runHistoryImport(clinicId: string): Promise<void> {
  const credentials = await clinicCredentials(clinicId);
  const stats: ImportStats = { found: 0, created: 0, merged: 0, ignored: 0, conversations: 0, partialHistory: 0 };
  const cutoff = Date.now() - 7 * 24 * 60 * 60_000;
  let offset = 0;
  const limit = 100;

  try {
    while (offset < 5000) {
      const page = record(await request(credentials, "/chat/find", {
        method: "POST",
        body: JSON.stringify({ operator: "AND", sort: "-wa_lastMsgTimestamp", limit, offset, wa_isGroup: false }),
      })) ?? {};
      const chats = Array.isArray(page.chats) ? page.chats.map(record).filter((chat): chat is JsonRecord => !!chat) : [];
      if (!chats.length) break;

      for (const chat of chats) {
        const phone = validImportedPhone(chat);
        if (!phone) { stats.ignored++; continue; }
        stats.found++;
        const name = textValue(chat.name, chat.wa_name, chat.wa_contactName);
        const existing = await prisma.patient.findUnique({ where: { clinicId_phone: { clinicId, phone } } });
        const patient = existing
          ? await prisma.patient.update({ where: { id: existing.id }, data: !existing.name && name ? { name } : {} })
          : await prisma.patient.create({ data: { clinicId, phone, name: name ?? null } });
        existing ? stats.merged++ : stats.created++;

        let conversation = await prisma.conversation.findFirst({ where: { patientId: patient.id } });
        if (!conversation) {
          conversation = await prisma.conversation.create({ data: { patientId: patient.id, status: "closed", humanTakeover: true } });
        }
        stats.conversations++;

        let messageOffset = 0;
        while (messageOffset < 1000) {
          const messagePage = record(await request(credentials, "/message/find", {
            method: "POST",
            body: JSON.stringify({ chatid: textValue(chat.wa_chatid) ?? phone, limit: 100, offset: messageOffset }),
          })) ?? {};
          const messages = Array.isArray(messagePage.messages)
            ? messagePage.messages.map(record).filter((message): message is JsonRecord => !!message)
            : [];
          if (!messages.length) break;
          let reachedCutoff = false;
          for (const message of messages) {
            const rawTimestamp = Number(message.messageTimestamp ?? 0);
            const timestamp = rawTimestamp > 0 && rawTimestamp < 1_000_000_000_000 ? rawTimestamp * 1000 : rawTimestamp;
            if (!timestamp || timestamp < cutoff) { stats.partialHistory++; reachedCutoff = true; continue; }
            const text = textValue(message.text);
            if (!text) continue;
            const createdAt = new Date(timestamp);
            const duplicate = await prisma.message.findFirst({ where: { conversationId: conversation.id, createdAt, content: text } });
            if (!duplicate) {
              await prisma.message.create({
                data: { conversationId: conversation.id, role: boolValue(message.fromMe) ? "human" : "user", content: text, createdAt },
              });
            }
          }
          if (reachedCutoff || !boolValue(messagePage.hasMore)) break;
          messageOffset = Number(messagePage.nextOffset ?? messageOffset + messages.length);
        }
      }

      const pagination = record(page.pagination);
      const total = Number(pagination?.totalRecords ?? 0);
      offset += chats.length;
      // Heartbeat: mantem importUpdatedAt fresco pra uma importacao longa e
      // legitima nao ser confundida com uma presa (ver IMPORT_STALE_MS).
      await prisma.clinic.update({ where: { id: clinicId }, data: { importUpdatedAt: new Date() } });
      if (chats.length < limit || (total > 0 && offset >= total)) break;
    }

    const contactsInBase = await prisma.patient.count({ where: { clinicId } });
    await prisma.clinic.update({
      where: { id: clinicId },
      data: { importStatus: "completed", importStats: JSON.stringify({ ...stats, contactsInBase }), importUpdatedAt: new Date() },
    });
  } catch (error) {
    await prisma.clinic.update({ where: { id: clinicId }, data: { importStatus: "failed", importUpdatedAt: new Date() } });
    throw error;
  }
}

// Uma importacao roda em background e so pode terminar em "completed"/"failed".
// Se o processo morre no meio (deploy, restart), o status fica preso em
// "running" e trava o botao. Depois de IMPORT_STALE_MS sem heartbeat tratamos
// como abandonada e deixamos disparar de novo.
const IMPORT_STALE_MS = 20 * 60_000;

export async function triggerHistoryImport(clinicId: string): Promise<void> {
  await clinicCredentials(clinicId);
  const clinic = await prisma.clinic.findUniqueOrThrow({
    where: { id: clinicId },
    select: { importStatus: true, importUpdatedAt: true },
  });
  const sinceUpdate = Date.now() - (clinic.importUpdatedAt?.getTime() ?? 0);
  if (clinic.importStatus === "running" && sinceUpdate < IMPORT_STALE_MS) {
    throw new Error("Uma importacao ja esta em andamento. Aguarde alguns minutos e tente de novo.");
  }
  await prisma.clinic.update({ where: { id: clinicId }, data: { importStatus: "running", importStats: null, importUpdatedAt: new Date() } });
  void runHistoryImport(clinicId).catch((error) => console.error(`[UAZAPI] Importacao da clinica ${clinicId} falhou:`, error));
}

// Toda "running" encontrada no boot foi abandonada por um processo que morreu -
// nenhuma importacao sobrevive a um restart. Chamado junto do worker de webhook.
export async function resetStaleHistoryImports(): Promise<void> {
  const { count } = await prisma.clinic.updateMany({
    where: { importStatus: "running" },
    data: { importStatus: "failed", importUpdatedAt: new Date() },
  });
  if (count > 0) console.warn(`[UAZAPI] ${count} importacao(oes) presa(s) em "running" marcada(s) como falha no boot`);
}
