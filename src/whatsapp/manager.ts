import path from "path";
import fs from "fs";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  downloadMediaMessage,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import QRCode from "qrcode";
import OpenAI from "openai";
import { toFile } from "openai";
import { prisma } from "../db/client.js";
import { handleIncomingMessage } from "../ai/alice.js";
import { processHistorySync } from "./import.js";

// Sessao (credenciais do "aparelho conectado") persistida em disco, uma pasta
// por clinica. Em producao isso PRECISA estar num volume persistente - se
// nao, a clinica perde a conexao e tem que escanear o QR de novo a cada deploy.
const AUTH_ROOT = process.env.WHATSAPP_AUTH_DIR ?? path.join(process.cwd(), "whatsapp-auth");

const logger = pino({ level: process.env.WHATSAPP_LOG_LEVEL ?? "silent" });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

interface ClinicConnection {
  sock: WASocket;
  status: "connecting" | "open" | "close";
  qr: string | null; // ultimo QR code cru (ainda nao virou imagem)
}

const connections = new Map<string, ClinicConnection>();

// Reconexao automatica apos queda tenta de novo a cada 5s, mas desiste depois
// de algumas tentativas seguidas sem sucesso - foi um loop infinito de retry
// (batendo no WhatsApp com erro 428 pra sempre) que ja derrubou clinicas em
// producao. Uma conexao/desconexao manual pelo painel zera esse contador.
const reconnectAttempts = new Map<string, number>();
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 5000;

// Ultimo motivo de falha por clinica - o painel usa pra explicar o que rolou
// quando a conexao desiste de tentar sozinha, em vez de so mostrar "Desconectado".
const lastConnectError = new Map<string, string>();

export function authDir(clinicId: string): string {
  return path.join(AUTH_ROOT, clinicId);
}

function toJid(phone: string): string {
  return `${phone.replace(/\D/g, "")}@s.whatsapp.net`;
}

// O WhatsApp agora usa "lid" (id vinculado) como identificador principal por
// privacidade; o numero de telefone de verdade fica em remoteJidAlt quando
// remoteJid termina em @lid. Confirmado na integracao anterior com a UazAPI -
// mesma mecanica por baixo, já que ambas falam com o mesmo protocolo.
function extractPhone(msg: WAMessage): string | null {
  const key = msg.key as WAMessage["key"] & { remoteJidAlt?: string };
  const raw = key.remoteJid?.endsWith("@lid") ? key.remoteJidAlt : key.remoteJid;
  if (!raw) return null;
  return raw.split("@")[0].replace(/\D/g, "") || null;
}

async function transcribeAudio(buffer: Buffer): Promise<string | null> {
  try {
    const file = await toFile(buffer, "audio.ogg");
    const result = await openai.audio.transcriptions.create({ file, model: "whisper-1" });
    return result.text?.trim() || null;
  } catch (err) {
    console.error("Falha ao transcrever audio:", err);
    return null;
  }
}

// Simula "digitando..." antes de responder - alem de parecer mais humano,
// da um respiro natural entre mensagens em vez de rajadas instantaneas.
async function humanDelay(sock: WASocket, jid: string, text: string): Promise<void> {
  const ms = Math.min(3500, 500 + text.length * 25);
  try {
    await sock.presenceSubscribe(jid);
    await sock.sendPresenceUpdate("composing", jid);
    await new Promise((resolve) => setTimeout(resolve, ms));
    await sock.sendPresenceUpdate("paused", jid);
  } catch {
    // presenca e cosmetica - se falhar, so manda a mensagem mesmo assim
  }
}

export async function sendText(clinicId: string, phone: string, text: string): Promise<void> {
  const conn = connections.get(clinicId);
  if (!conn || conn.status !== "open") {
    throw new Error(`WhatsApp da clinica ${clinicId} nao esta conectado`);
  }
  const jid = toJid(phone);
  await humanDelay(conn.sock, jid, text);
  await conn.sock.sendMessage(jid, { text });
}

export function getStatus(clinicId: string): { connected: boolean; connecting: boolean; lastError: string | null } {
  const conn = connections.get(clinicId);
  return {
    connected: conn?.status === "open",
    connecting: conn?.status === "connecting",
    lastError: lastConnectError.get(clinicId) ?? null,
  };
}

export async function getQrDataUrl(clinicId: string): Promise<string | null> {
  const conn = connections.get(clinicId);
  if (!conn?.qr) return null;
  return QRCode.toDataURL(conn.qr);
}

// Cache da foto de perfil - evita bater no WhatsApp a cada poll do painel (a
// cada 5s); foto de perfil muda raramente, TTL de horas e mais que suficiente.
const AVATAR_TTL_MS = 6 * 60 * 60 * 1000;
const avatarCache = new Map<string, { url: string | null; fetchedAt: number }>();

export async function getProfilePicUrl(clinicId: string, phone: string): Promise<string | null> {
  const conn = connections.get(clinicId);
  if (!conn || conn.status !== "open") return null;

  const cacheKey = `${clinicId}:${phone}`;
  const cached = avatarCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < AVATAR_TTL_MS) return cached.url;

  let url: string | null = null;
  try {
    url = (await conn.sock.profilePictureUrl(toJid(phone), "image")) ?? null;
  } catch {
    url = null; // sem foto ou privacidade restrita a "so meus contatos"
  }
  avatarCache.set(cacheKey, { url, fetchedAt: Date.now() });
  return url;
}

async function handleIncomingWAMessage(clinicId: string, msg: WAMessage): Promise<void> {
  if (!msg.message) return;
  if (msg.key.fromMe) return; // eco do que a propria Alice mandou
  if (msg.key.remoteJid?.endsWith("@g.us")) return; // secretaria atende so conversa individual
  if (msg.key.remoteJid === "status@broadcast") return;

  const phone = extractPhone(msg);
  if (!phone) return;

  let text = msg.message.conversation || msg.message.extendedTextMessage?.text || undefined;

  if (!text && msg.message.audioMessage) {
    try {
      const buffer = (await downloadMediaMessage(msg, "buffer", {})) as Buffer;
      text = (await transcribeAudio(buffer)) ?? undefined;
    } catch (err) {
      console.error("Falha ao baixar audio:", err);
    }
  }

  if (!text) return; // midia sem transcricao (imagem/video/documento) - ignorado por ora

  const pushName = msg.pushName ?? undefined;

  const reply = await handleIncomingMessage({ clinicId, patientPhone: phone, patientName: pushName, text });
  if (reply) await sendText(clinicId, phone, reply);
}

export async function connectClinic(clinicId: string): Promise<void> {
  const existing = connections.get(clinicId);
  if (existing && existing.status !== "close") return; // ja conectado ou conectando

  fs.mkdirSync(authDir(clinicId), { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(authDir(clinicId));

  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: Browsers.macOS("Desktop"), // fingerprint de dispositivo real, menos suspeito que o padrao da lib
    // O WhatsApp so manda o historico completo (messaging-history.set) num
    // pareamento de aparelho novo - "Importar do WhatsApp" (triggerHistoryImport)
    // apaga a sessao e forca um QR novo justamente por isso; deixar ligado
    // aqui garante que o historico chegue nessa reconexao.
    syncFullHistory: true,
    markOnlineOnConnect: false, // nao fica "online" o tempo todo feito bot
  });

  connections.set(clinicId, { sock, status: "connecting", qr: null });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const conn = connections.get(clinicId);
    if (!conn) return;

    if (update.qr) {
      conn.qr = update.qr;
      conn.status = "connecting";
    }

    if (update.connection === "open") {
      conn.status = "open";
      conn.qr = null;
      reconnectAttempts.delete(clinicId);
      lastConnectError.delete(clinicId);
      const ownJid = sock.user?.id?.split(":")[0]?.split("@")[0];
      if (ownJid) {
        await prisma.clinic.update({ where: { id: clinicId }, data: { whatsappPhone: ownJid } }).catch(() => {});
      }
      console.log(`WhatsApp conectado para a clinica ${clinicId} (${ownJid ?? "?"})`);
    }

    if (update.connection === "close") {
      conn.status = "close";
      const statusCode = (update.lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        console.log(`Clinica ${clinicId} desconectada (logout) - apagando sessao, precisa de novo QR.`);
        connections.delete(clinicId);
        reconnectAttempts.delete(clinicId);
        lastConnectError.delete(clinicId);
        fs.rmSync(authDir(clinicId), { recursive: true, force: true });
        return;
      }

      // Qualquer outra queda (inclusive restartRequired/515, que o WhatsApp
      // pede logo apos o pareamento) e so uma reconexao de rotina - tenta de
      // novo em 5s, ate o limite de tentativas seguidas.
      const attempts = (reconnectAttempts.get(clinicId) ?? 0) + 1;
      reconnectAttempts.set(clinicId, attempts);

      if (attempts > MAX_RECONNECT_ATTEMPTS) {
        const boomMsg = (update.lastDisconnect?.error as Boom | undefined)?.message ?? "?";
        console.error(
          `Clinica ${clinicId} falhou ${attempts - 1} vezes seguidas ao reconectar (statusCode=${statusCode ?? "?"}, msg="${boomMsg}") - parando de tentar sozinho. Reconecte pelo painel.`
        );
        lastConnectError.set(
          clinicId,
          `Não foi possível reconectar (erro do WhatsApp: ${statusCode ?? "?"}). Aguarde alguns minutos e clique em "Gerar QR Code".`
        );
        connections.delete(clinicId);
        return;
      }

      console.log(`Conexao da clinica ${clinicId} caiu (${statusCode ?? "?"}), tentativa ${attempts}/${MAX_RECONNECT_ATTEMPTS}, reconectando em 5s...`);
      setTimeout(() => connectClinic(clinicId).catch((err) => console.error("Falha ao reconectar:", err)), RECONNECT_DELAY_MS);
    }
  });

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      handleIncomingWAMessage(clinicId, msg).catch((err) => console.error("Erro processando mensagem recebida:", err));
    }
  });

  sock.ev.on("messaging-history.set", (data) => {
    processHistorySync(clinicId, data).catch((err) => console.error(`Erro importando historico da clinica ${clinicId}:`, err));
  });
}

// O WhatsApp so manda o historico completo (contatos + ate 30 dias de
// mensagens) num pareamento de aparelho genuinamente NOVO - uma reconexao
// simples de uma sessao ja autenticada nao reenvia nada. Por isso essa funcao
// apaga a sessao atual e gera um QR Code novo pra escanear; o historico chega
// pelo listener de "messaging-history.set" assim que o QR for lido, e fica
// em Clinic.importStatus/importStats.
const IMPORT_COOLDOWN_MS = 10 * 60 * 1000;

export async function triggerHistoryImport(clinicId: string): Promise<void> {
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { importUpdatedAt: true } });
  if (clinic.importUpdatedAt && Date.now() - clinic.importUpdatedAt.getTime() < IMPORT_COOLDOWN_MS) {
    const waitMin = Math.ceil((IMPORT_COOLDOWN_MS - (Date.now() - clinic.importUpdatedAt.getTime())) / 60000);
    throw new Error(`Aguarde mais ${waitMin} minuto(s) antes de importar de novo - tentativas repetidas em sequencia podem fazer o WhatsApp bloquear a conexao temporariamente.`);
  }

  await prisma.clinic.update({
    where: { id: clinicId },
    data: {
      importStatus: "running",
      importStats: JSON.stringify({ found: 0, created: 0, merged: 0, ignored: 0, conversations: 0, partialHistory: 0 }),
      importUpdatedAt: new Date(),
    },
  });

  await disconnectClinic(clinicId);
  await connectClinic(clinicId);
}

export async function disconnectClinic(clinicId: string): Promise<void> {
  const conn = connections.get(clinicId);
  if (conn) {
    await conn.sock.logout().catch(() => {});
    connections.delete(clinicId);
  }
  reconnectAttempts.delete(clinicId);
  lastConnectError.delete(clinicId);
  fs.rmSync(authDir(clinicId), { recursive: true, force: true });
}

// Reconecta sozinho, na subida do servidor, toda clinica que ja tinha sessao
// salva - sem isso, um restart do processo exigiria escanear o QR de novo
// pra cada clinica manualmente. Espaca cada reconexao em vez de disparar todas
// juntas no boot, pra nao abrir uma rajada de conexoes do mesmo IP.
const RESTORE_STAGGER_MS = 3000;

export async function restoreAllConnections(): Promise<void> {
  if (!fs.existsSync(AUTH_ROOT)) return;
  const clinicIds = fs.readdirSync(AUTH_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const clinicId of clinicIds) {
    await connectClinic(clinicId).catch((err) => console.error(`Falha ao restaurar conexao de ${clinicId}:`, err));
    await new Promise((resolve) => setTimeout(resolve, RESTORE_STAGGER_MS));
  }
}
