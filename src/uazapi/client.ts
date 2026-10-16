import crypto, { timingSafeEqual } from "crypto";
import dns from "dns/promises";
import net from "net";
import OpenAI from "openai";
import { toFile } from "openai";
import { prisma } from "../db/client.js";
import { recordIncomingMessage, generateReply, recordOutgoingFromDevice } from "../ai/alice.js";
import { isFreePlan } from "../crm/plan.js";
import { isOptOutRequest, applyOptOut, OPTOUT_CONFIRMATION } from "../crm/optout.js";
import { reviewOutbound, type OutboundKind } from "../ai/sendGate.js";
import { scheduleBriefingRefresh } from "../ai/leadBriefing.js";

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
  imageMessageId?: string; // foto a interpretar (visao) / mostrar no painel
  // Anexo recebido (imagem/video/documento/audio) pra mostrar no painel.
  media?: {
    kind: "image" | "video" | "document" | "audio";
    messageId: string;
    url?: string; // se o webhook ja traz uma URL da midia
    base64?: string; // se o webhook ja traz o base64 (data URI ou cru)
    mime?: string;
    filename?: string;
  };
  pushName?: string;
  referral?: IncomingReferralData; // Click-to-WhatsApp (so no 1o contato)
  // true = a mensagem SAIU deste WhatsApp, mas nao foi a Alice nem o painel -
  // a pessoa respondeu direto pelo celular ou pelo WhatsApp Web (ver
  // recordOutgoingFromDevice). O eco do que a propria API envia (wasSentByApi)
  // continua descartado antes de chegar aqui.
  fromMe?: boolean;
}

export interface IncomingReferralData {
  ctwaClid?: string;
  sourceUrl?: string;
  adCampaignName?: string;
  adsetName?: string;
  adName?: string;
  // Campos CRUS do referral (atribuicao de anuncios): ID do anuncio, tipo, titulo, texto, midia e os nomes dos campos recebidos.
  sourceId?: string;
  sourceType?: string;
  headline?: string;
  body?: string;
  mediaType?: string;
  rawKeys?: string;
}

const REQUEST_TIMEOUT_MS = 25_000;
const AVATAR_TTL_MS = 6 * 60 * 60 * 1000;
const STATUS_TTL_MS = 4_000;
const avatarCache = new Map<string, { url: string | null; fetchedAt: number }>();
const statusCache = new Map<string, { status: UazapiConnectionStatus; fetchedAt: number }>();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60_000, maxRetries: 1 });
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

// Plano grátis: a equipe responde na mão (manual = true passa direto), mas
// NADA sai automaticamente pelo número - nem a Alice, nem lembrete, nem
// recontato. Guarda de última linha; a Alice e os crons já pulam o plano
// grátis antes de chegar aqui.
async function automatedSendBlocked(clinicId: string, manual: boolean): Promise<boolean> {
  if (manual) return false;
  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { plan: true } });
  if (isFreePlan(clinic?.plan)) {
    console.warn(`[uazapi] envio automatico bloqueado: clinica ${clinicId} esta no plano gratuito.`);
    return true;
  }
  return false;
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

// version 0 = assinatura original (so o id da clinica); a partir da 1a rotacao entra a versao no HMAC.
export function webhookSignature(clinicId: string, version = 0): string {
  const data = version > 0 ? `${clinicId}:v${version}` : clinicId;
  return crypto.createHmac("sha256", webhookSecret()).update(data).digest("hex");
}

export function verifyWebhookSignature(clinicId: string, signature: string, version = 0): boolean {
  try {
    const expected = Buffer.from(webhookSignature(clinicId, version), "utf8");
    const received = Buffer.from(signature, "utf8");
    return expected.length === received.length && timingSafeEqual(expected, received);
  } catch {
    return false;
  }
}

async function configureWebhook(clinicId: string, credentials: UazapiCredentials, versionOverride?: number): Promise<void> {
  const version = versionOverride ?? (await prisma.clinic.findUnique({ where: { id: clinicId }, select: { webhookVersion: true } }))?.webhookVersion ?? 0;
  const url = `${publicBaseUrl()}/api/uazapi/webhook/${encodeURIComponent(clinicId)}/${webhookSignature(clinicId, version)}`;
  await request(credentials, "/webhook", {
    method: "POST",
    body: JSON.stringify({
      enabled: true,
      url,
      events: ["messages", "connection", "presence"],
      // "fromMeYes" NAO entra aqui de proposito: precisamos receber o que sai
      // deste WhatsApp pelo celular/WhatsApp Web direto, pra sincronizar no
      // painel (ver fromMe em parseWebhookPayload). O eco da propria API
      // (wasSentByApi) continua excluido - esse ja foi gravado no envio.
      excludeMessages: ["wasSentByApi", "isGroupYes"],
      // Estes DOIS ficam false: eles nao incluem a midia no payload - so
      // adicionam o evento / o tipo da mensagem como path na URL do webhook, o
      // que quebraria a nossa rota (/api/uazapi/webhook/:clinicId/:signature).
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

// Troca a assinatura que vai na URL do webhook (ex.: a URL vazou em log de proxy). Primeiro configura a UAZAPI com a
// assinatura nova; so depois grava a versao - se a UAZAPI recusar, a URL antiga continua valendo.
export async function rotateWebhookSignature(clinicId: string): Promise<void> {
  const credentials = await clinicCredentials(clinicId);
  const current = (await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { webhookVersion: true } })).webhookVersion;
  const next = current + 1;
  await configureWebhook(clinicId, credentials, next);
  await prisma.clinic.update({ where: { id: clinicId }, data: { webhookVersion: next } });
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

// `manual` = mensagem escrita por uma pessoa da equipe no painel. Só isso pode
// sair pelo WhatsApp de uma clinica no plano gratuito.
// Campo que ficou SEM preencher na mensagem ("[PROCEDIMENTO]", "[NOME]", "{primeiro_nome}"):
// mensagem assim nunca pode ir para um paciente.
// Falha que nao adianta repetir: o numero nao tem WhatsApp. Sem isto a automacao tentava de novo
// (e avisava a equipe) a cada 15 minutos para sempre.
export function isPermanentSendError(err: unknown): boolean {
  return /not on whatsapp|n[aã]o (est[aá]|tem) no whatsapp/i.test(err instanceof Error ? err.message : String(err));
}

export function hasUnresolvedPlaceholder(text: string): string | null {
  const m = /\[[A-ZÀ-ÚÇ][A-ZÀ-ÚÇ0-9 _\/]{2,}\]|\{[a-zà-ú_]{3,}\}/.exec(text);
  return m ? m[0] : null;
}

// Mesmo texto (>= 40 caracteres) para o mesmo numero em poucos minutos: e duplicata
// (duas rodadas de automacao, dois servidores no ar na troca de versao...).
const recentSends = new Map<string, number>();
const DUPLICATE_WINDOW_MS = 10 * 60_000;
function sendKey(clinicId: string, phone: string, text: string): string {
  return `${clinicId}|${phone.replace(/\D/g, "")}|${text.trim().replace(/\s+/g, " ")}`;
}

export function isDuplicateSend(clinicId: string, phone: string, text: string, now = Date.now()): boolean {
  if (text.trim().length < 40) return false;
  for (const [k, at] of recentSends) if (now - at > DUPLICATE_WINDOW_MS) recentSends.delete(k);
  const key = sendKey(clinicId, phone, text);
  if (recentSends.has(key)) return true;
  recentSends.set(key, now);
  return false;
}

// O envio falhou: o texto NAO saiu, entao a proxima tentativa (ex.: o proximo ciclo do cron) nao pode ser
// barrada como "duplicada".
export function forgetSend(clinicId: string, phone: string, text: string): void {
  recentSends.delete(sendKey(clinicId, phone, text));
}

// Celular brasileiro cadastrado com/sem o 9o digito (o 9 foi acrescentado em 2012-2016 e muita agenda ainda tem o
// numero antigo, ex.: 55 11 9494-4707 em vez de 55 11 99494-4707). Devolve a outra forma do numero, ou null se nao se aplica.
export function alternateBrazilianMobile(digits: string): string | null {
  const d = digits.replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("55") && /^[6-9]/.test(d.slice(4))) return `${d.slice(0, 4)}9${d.slice(4)}`; // sem o 9 -> com o 9
  if (d.length === 13 && d.startsWith("55") && d[4] === "9") return `${d.slice(0, 4)}${d.slice(5)}`; // com o 9 -> sem o 9
  return null;
}

const placeholderAlerted = new Map<string, number>();

// "sent" = saiu pelo WhatsApp. "blocked" = plano gratis (nada automatico sai). "duplicate" = o mesmo texto ja saiu
// ha pouco para o mesmo numero. Quem grava a mensagem no chat so deve fazer isso quando o resultado e "sent".
// "vetoed" = a revisao por IA barrou (nao faz sentido enviar agora): nada saiu, o motivo fica no Diario de atividades.
export type SendOutcome = "sent" | "blocked" | "duplicate" | "vetoed";

export async function sendText(clinicId: string, phone: string, text: string, opts: { manual?: boolean; alice?: boolean; kind?: OutboundKind } = {}): Promise<SendOutcome> {
  if (await automatedSendBlocked(clinicId, opts.manual === true)) return "blocked";
  let reservedDuplicateKey = false;
  if (opts.manual !== true) {
    const missing = hasUnresolvedPlaceholder(text);
    if (missing) {
      // Avisa a equipe (no maximo 1x por hora por clinica+campo) e NAO envia.
      const k = `${clinicId}|${missing}`;
      if (Date.now() - (placeholderAlerted.get(k) ?? 0) > 3_600_000) {
        placeholderAlerted.set(k, Date.now());
        const { notifyStaff } = await import("../crm/notify.js");
        await notifyStaff(clinicId, "automation_failed", `⚠️ Bloqueei o envio de uma mensagem automática porque o campo ${missing.replace(/[\[\]{}]/g, "")} ficou sem preencher no texto. Corrija o texto da automação: os campos do paciente vão entre chaves (nome, procedimento, profissional, data, hora).`);
      }
      throw new Error(`Mensagem bloqueada: campo sem preencher ${missing}`);
    }
    // A conversa da Alice NAO passa pela trava de duplicados: ela ja tem a propria (uma resposta por vez por
    // conversa + descarte de resposta repetida em generateReply). Aqui a trava barrava uma resposta legitima
    // igual a anterior (ex.: o paciente pergunta o endereco duas vezes) e o paciente ficava sem resposta.
    if (opts.alice !== true) {
      if (isDuplicateSend(clinicId, phone, text)) {
        // Mostra o inicio do texto e quem chamou: sem isso o log so dizia "duplicado" e nao dava pra achar a origem.
        const caller = (new Error().stack ?? "").split("\n").slice(2, 5).map((l) => l.trim().replace(/^at /, "").replace(/\(.*[\\/]/, "(")).join(" < ");
        console.warn(`[uazapi] envio duplicado descartado para ${phone.slice(-4)}: "${text.trim().replace(/\s+/g, " ").slice(0, 60)}" [${caller}]`);
        return "duplicate";
      }
      reservedDuplicateKey = text.trim().length >= 40;
      // Automacao: olha o BANCO - se outra rodada/processo ja mandou exatamente este texto, nao manda de novo.
      if (text.trim().length >= 40) {
        const already = await prisma.message.findFirst({
          where: { role: "assistant", content: text, createdAt: { gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) }, conversation: { patient: { clinicId, phone } } },
          select: { id: true },
        });
        if (already) {
          console.warn(`[uazapi] envio duplicado (ja registrado no chat) descartado para ${phone.slice(-4)}`);
          return "duplicate";
        }
      }
    }
  }
  // REVISAO POR IA de toda mensagem automatica (a resposta da Alice e revisada em deliverAliceReply; envio manual da equipe nao e revisado).
  if (opts.manual !== true && opts.alice !== true) {
    const verdict = await reviewOutbound({ clinicId, phone, text, kind: opts.kind ?? "outra" });
    if (!verdict.send) {
      if (reservedDuplicateKey) forgetSend(clinicId, phone, text);
      return "vetoed";
    }
  }
  try {
    const [credentials, config] = await Promise.all([
      clinicCredentials(clinicId),
      prisma.clinic.findUnique({
        where: { id: clinicId },
        select: { splitLongMessages: true, splitMaxMessages: true, splitThresholdChars: true },
      }),
    ]);
    // Confirmacao, lembrete, recontato etc. vao SEMPRE numa mensagem so; so a conversa da Alice quebra em bolhas.
    const parts = opts.alice === true && config?.splitLongMessages && text.length > config.splitThresholdChars
      ? splitMessage(text, Math.max(config.splitMaxMessages, 1))
      : [text];

    let target = phone.replace(/\D/g, "");
    for (let index = 0; index < parts.length; index++) {
      const delay = Math.min(3500, 500 + parts[index].length * 25);
      const post = (number: string) =>
        request(credentials, "/send/text", { method: "POST", body: JSON.stringify({ number, text: parts[index], delay, async: false }) });
      try {
        await post(target);
      } catch (err) {
        // "Nao esta no WhatsApp": antes de desistir, tenta a outra forma do numero (com/sem o 9o digito).
        const alt = index === 0 && isPermanentSendError(err) ? alternateBrazilianMobile(target) : null;
        if (!alt) throw err;
        await post(alt);
        target = alt;
      }
      if (index < parts.length - 1) await new Promise((resolve) => setTimeout(resolve, 1000 + Math.random() * 2000));
    }

  } catch (err) {
    if (reservedDuplicateKey) forgetSend(clinicId, phone, text); // nao saiu: a proxima tentativa nao e duplicata
    throw err;
  }
  return "sent";
}

// Envia a resposta da Alice e atualiza o estado de entrega da mensagem que generateReply gravou como "pending".
// Se o envio falhar a mensagem fica "failed" (o painel mostra) e o erro sobe: o evento do webhook volta pra fila e a
// proxima tentativa reenvia ESTA resposta em vez de gerar outra.
// Falha de rede em que o WhatsApp PODE ter entregado a mensagem (a resposta e que se perdeu). Reenviar nesse caso causava a mesma resposta
// 6 vezes seguidas (caso da Elaine, 14/10): nao reenvia, so registra.
export function isAmbiguousSendError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  const msg = err instanceof Error ? err.message : String(err);
  return /^(TimeoutError|AbortError)$/.test(name) || /timed? ?out|aborted|socket hang up|ECONNRESET|UND_ERR_(HEADERS|BODY)_TIMEOUT/i.test(msg);
}

export const BURST_DUPLICATE_MS = 3 * 60_000;

export async function deliverAliceReply(clinicId: string, phone: string, conversationId: string, replyIn: string): Promise<void> {
  let reply = replyIn;
  const pending = await prisma.message.findFirst({
    where: { conversationId, role: "assistant", authorName: null, content: reply, deliveryStatus: { in: ["pending", "failed"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  // Esta mesma resposta JA foi entregue ha pouco (outra linha, mesmo texto): nao manda de novo.
  const alreadySent = await prisma.message.findFirst({
    where: {
      conversationId, role: "assistant", authorName: null, content: reply, deliveryStatus: "sent",
      createdAt: { gte: new Date(Date.now() - BURST_DUPLICATE_MS) },
      ...(pending ? { id: { not: pending.id } } : {}),
    },
    select: { id: true },
  });
  if (alreadySent) {
    console.warn(`[uazapi] resposta repetida da Alice descartada (conv ${conversationId}): "${reply.trim().replace(/\s+/g, " ").slice(0, 60)}"`);
    if (pending) await prisma.message.update({ where: { id: pending.id }, data: { deliveryStatus: null } }).catch(() => undefined);
    return;
  }
  // REVISAO POR IA da resposta (ficha da pessoa + a mensagem): barra o que nao faz sentido agora ou reescreve um trecho errado, sem inventar fato novo.
  // NUNCA fica sem resposta: se a revisao achou problema, ela escreve uma resposta MELHOR e essa e a que sai; sem alternativa valida, sai a original.
  const verdict = await reviewOutbound({ clinicId, phone, text: reply, kind: "resposta_alice" });
  if (verdict.rewritten) {
    if (pending) await prisma.message.update({ where: { id: pending.id }, data: { content: verdict.rewritten } }).catch(() => undefined);
    reply = verdict.rewritten;
  }
  try {
    await sendText(clinicId, phone, reply, { alice: true });
    if (pending) await prisma.message.update({ where: { id: pending.id }, data: { deliveryStatus: "sent" } });
    void prisma.conversation.findUnique({ where: { id: conversationId }, select: { patientId: true } }).then((c) => { if (c) scheduleBriefingRefresh(c.patientId, { delayMs: 60_000 }); }).catch(() => undefined);
  } catch (err) {
    if (isAmbiguousSendError(err)) {
      // Pode ter chegado: marca como enviada e NAO deixa o reenvio automatico repetir.
      console.warn(`[uazapi] envio sem confirmacao (conv ${conversationId}), nao vai reenviar: ${err instanceof Error ? err.message : err}`);
      if (pending) await prisma.message.update({ where: { id: pending.id }, data: { deliveryStatus: "sent" } }).catch(() => undefined);
      return;
    }
    if (pending) await prisma.message.update({ where: { id: pending.id }, data: { deliveryStatus: "failed" } }).catch(() => undefined);
    throw err;
  }
}

// Reenvia a ultima resposta da Alice que nao chegou (deliveryStatus "failed"), se ainda for a ultima fala da conversa.
// true = havia uma resposta pendente de entrega (enviada ou nao); false = nada a reenviar.
async function resendFailedAliceReply(clinicId: string, phone: string, conversationId: string): Promise<boolean> {
  const failed = await prisma.message.findFirst({
    where: { conversationId, role: "assistant", authorName: null, deliveryStatus: "failed" },
    orderBy: { createdAt: "desc" },
  });
  if (!failed) return false;
  const later = await prisma.message.findFirst({
    where: { conversationId, createdAt: { gt: failed.createdAt }, role: { in: ["assistant", "human"] } },
    select: { id: true },
  });
  if (later) {
    await prisma.message.update({ where: { id: failed.id }, data: { deliveryStatus: null } }); // superada por outra fala: nao reenvia
    return false;
  }
  await deliverAliceReply(clinicId, phone, conversationId, failed.content);
  return true;
}

export type OutgoingMediaKind = "image" | "video" | "document" | "audio" | "ptt";

// Envia uma foto / video / arquivo pelo WhatsApp da clinica (atendimento
// humano). `dataUrl` = data URI (data:<mime>;base64,<...>).
export async function sendMedia(
  clinicId: string,
  phone: string,
  opts: { dataUrl: string; kind: OutgoingMediaKind; caption?: string; filename?: string; manual?: boolean },
): Promise<void> {
  if (await automatedSendBlocked(clinicId, opts.manual === true)) return;
  const credentials = await clinicCredentials(clinicId);
  const mimeMatch = opts.dataUrl.match(/^data:([\w.+-]+\/[\w.+-]+)(?:;[\w.+=%-]+)*;base64,/);
  const body: Record<string, unknown> = {
    number: phone.replace(/\D/g, ""),
    type: opts.kind,
    file: opts.dataUrl,
    delay: 0,
    async: false,
  };
  if (mimeMatch) body.mimetype = mimeMatch[1];
  if (opts.caption?.trim()) body.text = opts.caption.trim();
  if (opts.kind === "document" && opts.filename) body.docName = opts.filename;
  await request(credentials, "/send/media", { method: "POST", body: JSON.stringify(body) });
}

// Versao pra listas: NUNCA espera a rede. Devolve o que estiver em cache (ou null) e, se faltar, busca em segundo plano
// (poucas por vez) pra aparecer na proxima atualizacao. Antes a lista de conversas esperava uma chamada a UAZAPI por
// contato sem foto em cache, a cada atualizacao do painel.
const avatarInFlight = new Set<string>();
export function getProfilePicUrlCached(clinicId: string, phone: string): string | null {
  const cacheKey = `${clinicId}:${phone}`;
  const cached = avatarCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < AVATAR_TTL_MS) return cached.url;
  if (!avatarInFlight.has(cacheKey) && avatarInFlight.size < 4) {
    avatarInFlight.add(cacheKey);
    void getProfilePicUrl(clinicId, phone).finally(() => avatarInFlight.delete(cacheKey));
  }
  return cached?.url ?? null;
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
  if (avatarCache.size > 5000) avatarCache.clear(); // cresce com cada contato: limite simples
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
  // Campos crus (o ID do anuncio NAO e nome: ele vai separado pra atribuicao).
  const sourceId = textValue(ref?.source_id, ref?.sourceId, typeof ref?.source_id === "number" ? String(ref.source_id) : undefined);
  const sourceType = textValue(ref?.source_type, ref?.sourceType);
  const headline = textValue(ref?.headline, ref?.title);
  const body = textValue(ref?.body);
  const mediaTypeRaw = ref?.media_type ?? ref?.mediaType;
  const mediaType = textValue(typeof mediaTypeRaw === "number" ? String(mediaTypeRaw) : mediaTypeRaw);
  const rawKeys = ref ? Object.keys(ref).slice(0, 25).join(",") : undefined;

  if (!ctwaClid && !sourceUrl && !adName && !adCampaignName && !sourceId) return undefined;
  return {
    ...(ctwaClid ? { ctwaClid } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(adName ? { adName } : {}),
    ...(adCampaignName ? { adCampaignName } : {}),
    ...(sourceId ? { sourceId } : {}),
    ...(sourceType ? { sourceType } : {}),
    ...(headline ? { headline } : {}),
    ...(body ? { body } : {}),
    ...(mediaType ? { mediaType } : {}),
    ...(rawKeys ? { rawKeys } : {}),
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
    // Eco do que a propria API mandou (Alice, painel): sempre descarta - ja foi
    // gravado no momento do envio. Mensagem so "fromMe" (sem ter saido pela API)
    // e a PROPRIA clinica respondendo pelo celular/WhatsApp Web direto - essa
    // passa e e tratada mais abaixo (fromMe, ver handleQueuedPayload).
    if (boolValue(message.wasSentByApi, message.was_sent_by_api)) continue;
    if (boolValue(message.isGroup, message.is_group)) continue;
    const fromMe = boolValue(message.fromMe, message.from_me);

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
    // `content` pode vir como objeto OU como JSON serializado em string (doc:
    // "Conteudo bruto da mensagem - JSON serializado ou texto").
    let content = record(message.content);
    if (!content && typeof message.content === "string" && message.content.trim().startsWith("{")) {
      try { content = record(JSON.parse(message.content)); } catch { /* ignore */ }
    }
    // Eventos que NAO sao uma fala do contato: reacao (emoji em cima de uma
    // mensagem), apagar/editar mensagem, voto de enquete. Tratar como mensagem
    // fazia a Alice responder ("Que otimo!") a algo que a pessoa nunca escreveu.
    if (/reaction|protocol|revoke|pollupdate|keepinchat|senderkeydistribution|edited/.test(type)) continue;
    if (content && (content.reactionMessage || content.protocolMessage || content.pollUpdateMessage || content.editedMessage || content.keepInChatMessage)) continue;
    const imgNode = record(content?.imageMessage);
    const vidNode = record(content?.videoMessage);
    const audNode = record(content?.audioMessage);
    const docNode = record(content?.documentMessage);
    const text = textValue(
      message.text, message.caption, message.body, content?.text, content?.conversation,
      imgNode?.caption, vidNode?.caption, docNode?.caption,
    );

    // Amostra pro diagnóstico: forma da mensagem recebida (sem conteúdo, só as
    // chaves) - ajuda quando a foto do cliente não aparece.
    lastWebhookSamples.unshift({
      at: new Date().toISOString(),
      type: textValue(message.messageType, message.type) || "(sem type)",
      messageKeys: Object.keys(message).join(","),
      contentKeys: content ? Object.keys(content).join(",") : `(content: ${typeof message.content})`,
      hasText: !!text,
      mimetype: textValue(message.mimetype, content?.mimetype, imgNode?.mimetype, docNode?.mimetype) || "",
      fileURL: textValue(message.fileURL, message.fileUrl, content?.fileURL) || "",
    });
    if (lastWebhookSamples.length > 15) lastWebhookSamples.length = 15;

    // Detecta o tipo de midia por: messageType, no aninhado em content, mimetype.
    const mime = textValue(
      message.mimetype, message.mimeType, content?.mimetype,
      imgNode?.mimetype, vidNode?.mimetype, audNode?.mimetype, docNode?.mimetype,
    );
    let mediaKind: "image" | "video" | "document" | "audio" | null = null;
    if (type === "image" || type.includes("image") || imgNode || mime?.startsWith("image/")) mediaKind = "image";
    else if (type === "video" || type === "videoplay" || type === "ptv" || type.includes("video") || vidNode || mime?.startsWith("video/")) mediaKind = "video";
    else if (["audio", "myaudio", "ptt"].includes(type) || type.includes("audio") || type.includes("ptt") || audNode || mime?.startsWith("audio/")) mediaKind = "audio";
    else if (type === "document" || type.includes("document") || docNode || (mime && !mime.startsWith("image/") && !mime.startsWith("video/") && !mime.startsWith("audio/") && !mime.startsWith("text/"))) mediaKind = "document";

    // So confiamos na fileURL que a propria UAZAPI expoe (nao no url criptografado
    // do proto do WhatsApp, que nao da pra baixar direto).
    const mediaUrl = textValue(message.fileURL, message.fileUrl, message.file_url, content?.fileURL);
    const mediaBase64 = textValue(message.base64, message.fileBase64, message.file_base64, message.mediaBase64, content?.base64);
    const filename = textValue(message.filename, message.fileName, message.file_name, docNode?.fileName, docNode?.title);

    const isAudio = mediaKind === "audio";

    output.push({
      externalId,
      phone,
      text,
      mediaMessageId: !text && isAudio ? externalId : undefined,
      imageMessageId: mediaKind === "image" ? externalId : undefined,
      media: mediaKind
        ? {
            kind: mediaKind,
            messageId: externalId,
            ...(mediaUrl ? { url: mediaUrl } : {}),
            ...(mediaBase64 ? { base64: mediaBase64 } : {}),
            ...(mime ? { mime } : {}),
            ...(filename ? { filename } : {}),
          }
        : undefined,
      pushName: textValue(message.senderName, message.sender_name, message.pushName, message.push_name),
      referral: extractReferral(message),
      fromMe,
    });
  }
  return output;
}

async function transcribeAudio(clinicId: string, messageId: string): Promise<string | null> {
  try {
    const credentials = await clinicCredentials(clinicId);
    const response = record(await request(credentials, "/message/download", {
      method: "POST",
      body: JSON.stringify({ id: messageId, messageid: messageId, return_base64: true, return_link: false, generate_mp3: true, transcribe: false }),
    }));
    const encoded = textValue(response?.base64Data, response?.base64, response?.data, response?.fileBase64, record(response?.data)?.base64);
    if (!encoded) {
      console.warn(`[UAZAPI] download de audio sem base64. chaves: ${Object.keys(response ?? {}).join(",")}`);
      return null;
    }
    const base64 = encoded.includes(",") ? encoded.slice(encoded.indexOf(",") + 1) : encoded;
    const file = await toFile(Buffer.from(base64, "base64"), "audio.mp3");
    const result = await openai.audio.transcriptions.create({ file, model: "whisper-1" });
    return result.text?.trim() || null;
  } catch (error) {
    console.error("[UAZAPI] Falha ao transcrever audio:", error);
    return null;
  }
}

const MEDIA_MAX_BYTES = 16_000_000; // ~12MB de arquivo (base64)

// Diagnostico das ultimas resolucoes de midia recebida (so em memoria). Fica
// visivel pro admin em GET /whatsapp/media-debug pra ajudar quando a foto do
// cliente nao aparece.
interface MediaDebugEntry {
  at: string;
  clinicId: string;
  kind: string;
  messageId: string;
  hadWebhookUrl: boolean;
  hadWebhookBase64: boolean;
  downloadKeys?: string;
  downloadStatus?: string;
  resolved: boolean;
}
const mediaDebug: MediaDebugEntry[] = [];
function pushMediaDebug(entry: MediaDebugEntry): void {
  mediaDebug.unshift(entry);
  if (mediaDebug.length > 15) mediaDebug.length = 15;
}
const lastWebhookSamples: {
  at: string;
  type: string;
  messageKeys: string;
  contentKeys: string;
  hasText: boolean;
  mimetype: string;
  fileURL: string;
}[] = [];
export function getMediaDebug(): { downloads: MediaDebugEntry[]; webhookSamples: typeof lastWebhookSamples } {
  return { downloads: mediaDebug, webhookSamples: lastWebhookSamples };
}

function toDataUri(encoded: string, mimeHint?: string): string | null {
  const raw = encoded.trim();
  if (!raw) return null;
  if (raw.startsWith("data:")) return raw.length > MEDIA_MAX_BYTES ? null : raw;
  const base64 = raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
  if (!base64 || base64.length > MEDIA_MAX_BYTES) return null;
  return `data:${mimeHint || "application/octet-stream"};base64,${base64}`;
}

// IP que nunca e destino legitimo de midia do WhatsApp: loopback, rede privada, link-local (metadados de nuvem),
// CGNAT etc. Evita que um webhook forjado faca o servidor buscar enderecos internos (SSRF).
export function isPrivateIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (v === 6) {
    const low = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low);
    if (mapped) return isPrivateIp(mapped[1]);
    return low === "::" || low === "::1" || low.startsWith("fc") || low.startsWith("fd") || /^fe[89ab]/.test(low) || low.startsWith("ff");
  }
  return true; // nao e IP valido
}

async function assertPublicHttpsUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("URL de midia precisa ser HTTPS");
  if (url.username || url.password) throw new Error("URL de midia invalida");
  const addresses = net.isIP(url.hostname) ? [{ address: url.hostname }] : await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((a) => isPrivateIp(a.address))) throw new Error("URL de midia aponta para endereco interno");
  return url;
}

// fetch que so vai pra hosts publicos e revalida a cada redirecionamento (maximo 3).
async function safeFetch(rawUrl: string): Promise<Response> {
  let current = rawUrl;
  for (let hop = 0; hop <= 3; hop++) {
    const url = await assertPublicHttpsUrl(current);
    const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      current = new URL(r.headers.get("location")!, url).toString();
      continue;
    }
    return r;
  }
  throw new Error("redirecionamentos demais");
}

async function urlToDataUri(url: string, fallbackMime = "application/octet-stream"): Promise<string | null> {
  try {
    const r = await safeFetch(url);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > (MEDIA_MAX_BYTES * 3) / 4) return null;
    // Sem content-type, um video viraria application/octet-stream e o
    // navegador nao tocaria - por isso o chamador manda o tipo esperado.
    const mime = r.headers.get("content-type")?.split(";")[0]?.trim() || fallbackMime;
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch (error) {
    console.error("[UAZAPI] Falha ao baixar midia pela URL:", error);
    return null;
  }
}

// Resolve o anexo do cliente pra um data URI (pra mostrar no painel / a Alice
// enxergar). Tenta, nesta ordem: base64/URL que ja veio no webhook -> endpoint
// /message/download -> URL retornada pelo /message/download.
async function resolveIncomingMedia(
  clinicId: string,
  media: { kind?: string; messageId: string; url?: string; base64?: string; mime?: string },
): Promise<string | null> {
  const dbg: MediaDebugEntry = {
    at: new Date().toISOString(),
    clinicId,
    kind: media.kind ?? "?",
    messageId: media.messageId,
    hadWebhookUrl: !!media.url,
    hadWebhookBase64: !!media.base64,
    resolved: false,
  };
  const done = (uri: string | null) => {
    dbg.resolved = !!uri;
    pushMediaDebug(dbg);
    return uri;
  };

  // Tipo esperado pelo tipo de anexo. Sem isto, um anexo que chega sem
  // mimetype vira "image/jpeg"/"application/octet-stream" e o navegador nao
  // consegue tocar video nem audio.
  const fallbackMime =
    { image: "image/jpeg", video: "video/mp4", audio: "audio/ogg", document: "application/octet-stream" }[
      media.kind ?? "image"
    ] ?? "application/octet-stream";

  if (media.base64) {
    const fromB64 = toDataUri(media.base64, media.mime || fallbackMime);
    if (fromB64) return done(fromB64);
  }
  if (media.url) {
    const fromUrl = await urlToDataUri(media.url, fallbackMime);
    if (fromUrl) return done(fromUrl);
  }
  try {
    const credentials = await clinicCredentials(clinicId);
    // Resposta documentada: { fileURL, mimetype, base64Data, transcription }
    const response = record(await request(credentials, "/message/download", {
      method: "POST",
      body: JSON.stringify({ id: media.messageId, return_base64: true, return_link: true, transcribe: false }),
    }));
    dbg.downloadKeys = Object.keys(response ?? {}).join(",");
    const encoded = textValue(response?.base64Data, response?.base64, response?.data, response?.fileBase64);
    const mimeHint = textValue(response?.mimetype, response?.mimeType, media.mime) || fallbackMime;
    if (encoded) {
      const uri = toDataUri(encoded, mimeHint);
      if (uri) return done(uri);
      dbg.downloadStatus = `base64 grande demais (${encoded.length} chars)`;
    }
    const link = textValue(response?.fileURL, response?.fileUrl, response?.url, response?.link);
    if (link) {
      const uri = await urlToDataUri(link, mimeHint);
      if (!uri) dbg.downloadStatus = "fileURL nao baixou";
      return done(uri);
    }
    dbg.downloadStatus = dbg.downloadStatus || "sem base64Data nem fileURL";
    console.warn(`[UAZAPI] /message/download sem midia. chaves: ${dbg.downloadKeys}`);
    return done(null);
  } catch (error) {
    dbg.downloadStatus = `erro: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200);
    console.error("[UAZAPI] Falha ao baixar midia:", error);
    return done(null);
  }
}

// Compat: usado por quem so precisa da imagem (visao da Alice).
async function downloadImageDataUrl(clinicId: string, messageId: string): Promise<string | null> {
  return resolveIncomingMedia(clinicId, { kind: "image", messageId, mime: "image/jpeg" });
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
        if (reply) return deliverAliceReply(clinicId, phone, conversationId, reply);
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

// Evento reprocessado depois de mais que isso: a mensagem entra no chat, mas a Alice NAO responde sozinha (a resposta
// seria de uma conversa velha); a conversa fica "nao lida" pra equipe.
const STALE_REPLY_MS = 30 * 60_000;

async function findRecordedMessage(clinicId: string, externalId: string) {
  return prisma.message.findFirst({
    where: { externalId, conversation: { patient: { clinicId } } },
    select: { conversationId: true, conversation: { select: { humanTakeover: true } } },
  });
}

async function handleQueuedPayload(clinicId: string, body: unknown, ageMs = 0): Promise<void> {
  // Plano grátis: o lead ainda entra (recordIncomingMessage cria contato +
  // evento Lead + atribuicao), mas a Alice nao responde e nao gastamos
  // transcricao de audio.
  const planClinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { plan: true } });
  const freePlan = isFreePlan(planClinic?.plan);
  const stale = ageMs > STALE_REPLY_MS;

  for (const incoming of parseWebhookPayload(body)) {
    let text = incoming.text ?? null;
    let imageDataUrl: string | undefined;
    let media: { type: "image" | "video" | "document" | "audio"; dataUrl: string; name?: string } | undefined;

    // REPROCESSAMENTO: este evento ja foi (pelo menos em parte) tratado numa tentativa anterior. Nao grava a mensagem
    // de novo nem baixa/transcreve midia outra vez: so garante que o paciente receba a resposta.
    const already = await findRecordedMessage(clinicId, incoming.externalId);
    if (already) {
      if (incoming.fromMe || freePlan || already.conversation.humanTakeover || stale) continue;
      // 1) existe resposta gravada que nao chegou ao paciente: reenvia ESSA (nao gera outra)
      if (await resendFailedAliceReply(clinicId, incoming.phone, already.conversationId)) continue;
      // 2) a mensagem foi gravada mas a resposta nunca foi gerada (falha/queda no meio): gera agora.
      //    generateReply nao responde de novo se a ultima fala da conversa ja e da Alice.
      const late = await generateReply(already.conversationId, {});
      if (late) await deliverAliceReply(clinicId, incoming.phone, already.conversationId, late);
      continue;
    }

    // Mensagem que SAIU deste WhatsApp sem passar pela Alice nem pelo painel -
    // a clínica respondeu direto pelo celular ou pelo WhatsApp Web. So resolve
    // midia (pra aparecer no painel) e grava como atendimento humano: sem
    // transcrever audio, sem gerar resposta da Alice.
    if (incoming.fromMe) {
      if (incoming.media) {
        const dataUrl = await resolveIncomingMedia(clinicId, { ...incoming.media });
        if (dataUrl) media = { type: incoming.media.kind, dataUrl, name: incoming.media.filename };
      }
      if (!text && !media) continue;
      await recordOutgoingFromDevice({
        clinicId,
        patientPhone: incoming.phone,
        // NAO usa o pushName: em mensagem enviada pela clinica ele e o nome do PROPRIO numero da clinica ("Lisboa Beauty
        // Center"), que virava o nome da paciente e era salvo assim na agenda do celular.
        patientName: undefined,
        text: text ?? "",
        media,
        externalId: incoming.externalId,
      });
      continue;
    }

    if (incoming.media) {
      // Audio sem legenda: transcreve pra Alice entender. Os outros (e audio com
      // legenda) sao baixados pra aparecer no painel.
      if (incoming.media.kind === "audio" && !text && !freePlan) {
        text = await transcribeAudio(clinicId, incoming.media.messageId);
      }
      const dataUrl = await resolveIncomingMedia(clinicId, { ...incoming.media });
      if (dataUrl) {
        media = { type: incoming.media.kind, dataUrl, name: incoming.media.filename };
        if (incoming.media.kind === "image") imageDataUrl = dataUrl;
      } else if (!text) {
        // Nao conseguiu baixar o anexo: registra mesmo assim (com um marcador),
        // pra conversa nao ficar com um "buraco" e o atendente saber que chegou.
        const label: Record<string, string> = { image: "foto", video: "vídeo", audio: "áudio", document: "arquivo" };
        text = `[${label[incoming.media.kind] ?? "anexo"} que não consegui carregar — peça pra reenviar]`;
      }
    } else if (!text && incoming.mediaMessageId) {
      text = freePlan ? "[áudio]" : await transcribeAudio(clinicId, incoming.mediaMessageId);
    }

    if (!text && !media) continue;

    const recorded = await recordIncomingMessage({
      clinicId,
      patientPhone: incoming.phone,
      patientName: incoming.pushName,
      text: text ?? "",
      imageDataUrl,
      media,
      referral: incoming.referral,
      externalId: incoming.externalId,
    });
    if (!recorded) continue;

    // Pediu pra PARAR de receber mensagem: liga o optedOut (nenhuma automacao manda mais nada) e confirma. Nao passa
    // pelo modelo - e uma resposta fixa.
    if (text && !recorded.probableEcho && isOptOutRequest(text)) {
      await applyOptOut(clinicId, recorded.patientId);
      if (!freePlan && !recorded.humanTakeover) {
        await prisma.message.create({
          data: { conversationId: recorded.conversationId, role: "assistant", content: OPTOUT_CONFIRMATION, deliveryStatus: "pending" },
        });
        await deliverAliceReply(clinicId, incoming.phone, recorded.conversationId, OPTOUT_CONFIRMATION);
      }
      continue;
    }

    // Plano grátis: a Alice nao atende. A conversa e sempre da equipe e entra
    // como "nao lida" pra alguem responder na mao.
    if (freePlan) {
      await prisma.conversation.update({
        where: { id: recorded.conversationId },
        data: { humanTakeover: true, handoffPending: true },
      });
      continue;
    }

    if (recorded.humanTakeover) continue;
    if (recorded.probableEcho) continue;

    if (stale) {
      await prisma.conversation.update({
        where: { id: recorded.conversationId },
        data: { handoffPending: true, handoffReason: "mensagem recebida com atraso (falha no processamento)" },
      });
      continue;
    }

    if (recorded.replyDelayMs > 0) {
      scheduleGroupedReply(clinicId, incoming.phone, recorded.conversationId, recorded.replyDelayMs, imageDataUrl);
      continue;
    }

    // A pessoa costuma mandar a ideia em pedacos ("Qual o valor da hidrolipoclasia" / "Tambem"): respondia cada pedaco
    // separado e saiam 2 respostas. Espera um instante e, se ja chegou outra mensagem dela na fila, deixa a PROXIMA
    // (que enxerga as duas) responder uma vez so.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    if (await newerIncomingPending(clinicId, incoming.phone, new Date(Date.now() - ageMs))) continue;

    const reply = await generateReply(recorded.conversationId, { imageDataUrl });
    if (reply) await deliverAliceReply(clinicId, incoming.phone, recorded.conversationId, reply);
  }
}

const SETTLE_MS = 2500;

// Existe, na fila, evento MAIS NOVO desta clinica com mensagem (nao enviada por nos) da mesma pessoa?
async function newerIncomingPending(clinicId: string, phone: string, since: Date): Promise<boolean> {
  const events = await prisma.uazapiWebhookEvent.findMany({
    where: { clinicId, status: "pending", createdAt: { gt: since }, payload: { contains: phone } },
    select: { payload: true },
    take: 10,
  });
  for (const e of events) {
    try {
      if (parseWebhookPayload(JSON.parse(e.payload)).some((m) => m.phone === phone && !m.fromMe && (m.text || m.media || m.mediaMessageId))) return true;
    } catch {
      /* payload ilegivel: ignora */
    }
  }
  return false;
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

// --- Fila de webhooks ------------------------------------------------------------------------------------
// - Clinicas diferentes processam em paralelo (ate MAX_PARALLEL); dentro de UMA clinica a ordem e preservada (um
//   evento por vez). Antes era uma fila unica global: uma chamada lenta travava o atendimento de todas as clinicas.
// - Cada evento tem prazo (EVENT_TIMEOUT_MS): se estourar vira "failed" e volta pra fila.
// - "processing" abandonado (container reiniciado no meio) e devolvido pra fila por uma varredura periodica
//   (STALE_PROCESSING_MS) e no boot - antes so voltava no boot e so se tivesse mais de 5 min, entao o evento de
//   um deploy ficava preso pra sempre.
// - Reprocessar um evento e seguro: a mensagem do paciente tem externalId (nao duplica) e a resposta que nao saiu e reenviada.
const MAX_PARALLEL = 4;
const EVENT_TIMEOUT_MS = 150_000;
const STALE_PROCESSING_MS = 180_000; // maior que EVENT_TIMEOUT_MS: um evento vivo nunca e confundido com um abandonado
const MAX_ATTEMPTS = 3;
const activeClinics = new Set<string>();
const activeEventIds = new Set<string>();
let webhookRerun = false;
let shuttingDown = false;

async function processWebhookEvent(event: { id: string; clinicId: string; payload: string; createdAt: Date }): Promise<void> {
  activeEventIds.add(event.id);
  try {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("tempo esgotado processando o evento")), EVENT_TIMEOUT_MS);
    });
    try {
      await Promise.race([handleQueuedPayload(event.clinicId, JSON.parse(event.payload), Date.now() - event.createdAt.getTime()), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    await prisma.uazapiWebhookEvent.update({ where: { id: event.id }, data: { status: "done" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.uazapiWebhookEvent
      .update({ where: { id: event.id }, data: { status: "failed", error: message.slice(0, 1000) } })
      .catch(() => undefined);
    console.error(`[UAZAPI] Evento ${event.id} falhou:`, error);
  } finally {
    activeEventIds.delete(event.id);
  }
}

export async function processUazapiWebhookQueue(): Promise<void> {
  if (webhookWorkerRunning) {
    webhookRerun = true; // chegou evento novo enquanto o worker corre: ele varre de novo antes de parar
    return;
  }
  webhookWorkerRunning = true;
  const running = new Set<Promise<void>>();
  try {
    do {
      webhookRerun = false;
      while (!shuttingDown) {
        let started = 0;
        if (running.size < MAX_PARALLEL) {
          const busy = [...activeClinics];
          const events = await prisma.uazapiWebhookEvent.findMany({
            where: {
              status: { in: ["pending", "failed"] },
              attempts: { lt: MAX_ATTEMPTS },
              ...(busy.length ? { clinicId: { notIn: busy } } : {}),
            },
            orderBy: { createdAt: "asc" },
            take: MAX_PARALLEL * 4,
          });
          for (const event of events) {
            if (running.size >= MAX_PARALLEL) break;
            if (activeClinics.has(event.clinicId)) continue; // um por clinica: preserva a ordem das mensagens
            // RESERVA atomica: so uma copia do servidor processa cada evento.
            const claimed = await prisma.uazapiWebhookEvent.updateMany({
              where: { id: event.id, status: event.status },
              data: { status: "processing", attempts: { increment: 1 }, error: null },
            });
            if (claimed.count !== 1) continue; // outra copia pegou
            activeClinics.add(event.clinicId);
            const task: Promise<void> = processWebhookEvent(event).finally(() => {
              activeClinics.delete(event.clinicId);
              running.delete(task);
            });
            running.add(task);
            started++;
          }
        }
        if (running.size === 0 && started === 0) break; // nada pendente e nada em andamento
        if (started === 0 || running.size >= MAX_PARALLEL) await Promise.race(running);
      }
    } while (webhookRerun && !shuttingDown);
  } finally {
    await Promise.allSettled([...running]);
    webhookWorkerRunning = false;
  }
}

// Reenvia respostas da Alice que ficaram "failed" (o envio falhou e nenhum evento vai reprocessar, ex.: resposta
// agrupada por replyDelaySeconds). So as dos ultimos 30 min e que ainda sao a ultima fala da conversa.
async function retryFailedAliceReplies(): Promise<void> {
  const failed = await prisma.message.findMany({
    where: { role: "assistant", authorName: null, deliveryStatus: "failed", createdAt: { gte: new Date(Date.now() - STALE_REPLY_MS) } },
    select: { conversationId: true, conversation: { select: { humanTakeover: true, patient: { select: { clinicId: true, phone: true } } } } },
    take: 20,
  });
  const seen = new Set<string>();
  for (const m of failed) {
    if (seen.has(m.conversationId)) continue;
    seen.add(m.conversationId);
    if (m.conversation.humanTakeover) continue;
    try {
      await resendFailedAliceReply(m.conversation.patient.clinicId, m.conversation.patient.phone, m.conversationId);
    } catch (err) {
      if (isPermanentSendError(err)) {
        // numero sem WhatsApp: nao adianta insistir
        await prisma.message.updateMany({ where: { conversationId: m.conversationId, deliveryStatus: "failed" }, data: { deliveryStatus: "failed_permanent" } });
      } else {
        console.error("[UAZAPI] reenvio de resposta falhou:", err instanceof Error ? err.message : err);
      }
    }
  }
}

let lastCleanupAt = 0;

// Roda a cada minuto: devolve eventos abandonados, reprocessa os que falharam, reenvia respostas que nao chegaram
// e (1x por hora) limpa tabelas que so cresciam.
export async function maintainUazapiQueue(): Promise<void> {
  if (shuttingDown) return;
  await prisma.uazapiWebhookEvent.updateMany({
    where: { status: "processing", updatedAt: { lt: new Date(Date.now() - STALE_PROCESSING_MS) }, id: { notIn: [...activeEventIds] } },
    data: { status: "pending" },
  });
  await processUazapiWebhookQueue();
  await retryFailedAliceReplies();

  if (Date.now() - lastCleanupAt > 3_600_000) {
    lastCleanupAt = Date.now();
    const day = 24 * 60 * 60_000;
    await prisma.uazapiWebhookEvent.deleteMany({ where: { status: "done", createdAt: { lt: new Date(Date.now() - 7 * day) } } });
    await prisma.uazapiWebhookEvent.deleteMany({ where: { status: "failed", attempts: { gte: MAX_ATTEMPTS }, createdAt: { lt: new Date(Date.now() - 30 * day) } } });
    await prisma.apiIdempotencyKey.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 7 * day) } } });
  }
}

export async function startUazapiWebhookWorker(): Promise<void> {
  await resetStaleHistoryImports();
  // No boot esta copia ainda nao processou nada: o que estiver "processing" ha mais de 90 s e de uma copia que
  // caiu/foi substituida. (Na troca de versao a copia antiga pode estar viva ainda: 90 s cobre um evento normal.)
  await prisma.uazapiWebhookEvent.updateMany({
    where: { status: "processing", updatedAt: { lt: new Date(Date.now() - 90_000) } },
    data: { status: "pending" },
  });
  await processUazapiWebhookQueue();
  setInterval(() => {
    maintainUazapiQueue().catch((err) => console.error("[UAZAPI] manutencao da fila falhou:", err));
  }, 60_000).unref();
}

// SIGTERM (deploy): para de pegar eventos novos, espera os em andamento ate graceMs e devolve pra fila os que nao deram tempo.
export async function shutdownUazapiWorker(graceMs = 20_000): Promise<void> {
  shuttingDown = true;
  const deadline = Date.now() + graceMs;
  while (webhookWorkerRunning && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  if (activeEventIds.size) {
    await prisma.uazapiWebhookEvent.updateMany({
      where: { id: { in: [...activeEventIds] }, status: "processing" },
      data: { status: "pending", attempts: { decrement: 1 } },
    });
  }
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
          // Ja entra arquivada: e so historico, nao polui o painel. Volta pra
          // lista automaticamente se o contato mandar mensagem nova.
          conversation = await prisma.conversation.create({
            data: { patientId: patient.id, status: "closed", humanTakeover: true, archived: true },
          });
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

// Salva o contato na agenda do celular da clinica (POST /contact/add da UAZAPI).
// "invalid" = numero invalido / conta comercial / grupo (nao adianta repetir);
// "retry" = sem sessao ou erro do servidor (tenta depois).
export async function saveContactToPhone(clinicId: string, phone: string, name: string): Promise<"ok" | "invalid" | "retry"> {
  try {
    const credentials = await clinicCredentials(clinicId);
    await request(credentials, "/contact/add", {
      method: "POST",
      body: JSON.stringify({ number: phone.replace(/[^0-9]/g, ""), name }),
    });
    return "ok";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/HTTP 400|invalid|not on whatsapp|business/i.test(msg) || msg.includes("inválido")) return "invalid";
    console.error("[contatos] falha ao salvar " + phone.slice(-4) + " na agenda do celular:", msg.slice(0, 160));
    return "retry";
  }
}
