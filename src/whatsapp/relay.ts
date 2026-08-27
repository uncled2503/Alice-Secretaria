import crypto from "crypto";
import fs from "fs";
import path from "path";
import { authDir, connectClinic, disconnectClinic } from "./manager.js";

// Ponte pra parear WhatsApp usando a rede de um agente externo (ex: um PC em
// casa) quando a VPS estiver sendo recusada pelo WhatsApp na hora de gerar QR
// (visto em producao: mesmo sessao 100% nova cai com statusCode=428 direto da
// VPS, mas funciona normalmente de uma rede residencial). O agente roda
// scripts/relay-agent.mjs, faz heartbeat aqui pra pegar trabalho, pareia
// localmente e devolve a sessao pronta pra VPS assumir o atendimento.
//
// Autenticado por segredo estatico (RELAY_SECRET) + um token por job -
// sem RELAY_SECRET configurado, o recurso fica completamente desligado.

const RELAY_SECRET = process.env.RELAY_SECRET;
const JOB_TTL_MS = 3 * 60_000; // pareamento tem que acontecer em ate 3min, senao o job expira
const AGENT_OFFLINE_MS = 10_000; // sem heartbeat ha mais que isso, considera o agente offline

interface RelayJob {
  jobToken: string;
  createdAt: number;
}

interface RelayState {
  status: "connecting" | "qr" | "open" | "error";
  qr: string | null;
  message: string | null;
  updatedAt: number;
}

const pendingJobs = new Map<string, RelayJob>(); // clinicId -> job aguardando o agente pegar
const activeJobs = new Map<string, RelayJob>(); // clinicId -> job que o agente ja pegou
const relayState = new Map<string, RelayState>();
let agentLastSeenAt = 0;

export function relayEnabled(): boolean {
  return !!RELAY_SECRET;
}

export function isAgentOnline(): boolean {
  return relayEnabled() && Date.now() - agentLastSeenAt < AGENT_OFFLINE_MS;
}

function checkSecret(secret: unknown): boolean {
  return relayEnabled() && typeof secret === "string" && secret === RELAY_SECRET;
}

function validJob(clinicId: string, jobToken: unknown): boolean {
  const job = activeJobs.get(clinicId);
  return !!job && typeof jobToken === "string" && jobToken === job.jobToken;
}

// Chamado pelo /whatsapp/connect - alem da VPS tentar por conta propria,
// deixa um job disponivel pro agente local pegar no proximo heartbeat.
export function requestPairing(clinicId: string): void {
  if (!relayEnabled()) return;
  pendingJobs.set(clinicId, { jobToken: crypto.randomBytes(16).toString("hex"), createdAt: Date.now() });
  relayState.set(clinicId, { status: "connecting", qr: null, message: null, updatedAt: Date.now() });
}

export function heartbeat(secret: unknown): { job: { clinicId: string; jobToken: string } | null } | null {
  if (!checkSecret(secret)) return null;
  agentLastSeenAt = Date.now();

  for (const [clinicId, job] of pendingJobs) {
    pendingJobs.delete(clinicId);
    if (Date.now() - job.createdAt > JOB_TTL_MS) continue; // expirou antes do agente pegar - descarta
    activeJobs.set(clinicId, job);
    return { job: { clinicId, jobToken: job.jobToken } };
  }
  return { job: null };
}

export function reportEvent(
  secret: unknown,
  clinicId: unknown,
  jobToken: unknown,
  event: unknown,
  data?: { qr?: unknown; message?: unknown }
): boolean {
  if (!checkSecret(secret) || typeof clinicId !== "string" || !validJob(clinicId, jobToken)) return false;

  if (event === "qr" && typeof data?.qr === "string") {
    relayState.set(clinicId, { status: "qr", qr: data.qr, message: null, updatedAt: Date.now() });
  } else if (event === "close" || event === "error") {
    const message = typeof data?.message === "string" ? data.message : "Falha ao parear pela rede local.";
    relayState.set(clinicId, { status: "error", qr: null, message, updatedAt: Date.now() });
    activeJobs.delete(clinicId);
  } else {
    return false;
  }
  return true;
}

// Nomes de arquivo de sessao da Baileys (useMultiFileAuthState): letras,
// numeros, ponto e hifen - nunca barra, entao nao da pra escapar de authDir.
const SAFE_FILENAME = /^[\w.-]+\.json$/;

export async function adoptSession(
  secret: unknown,
  clinicId: unknown,
  jobToken: unknown,
  files: unknown
): Promise<boolean> {
  if (!checkSecret(secret) || typeof clinicId !== "string" || !validJob(clinicId, jobToken)) return false;
  if (!files || typeof files !== "object") return false;

  // Limpa qualquer tentativa da VPS em andamento e a sessao velha antes de
  // escrever a nova - garante um estado limpo independente do que a VPS
  // estava tentando sozinha em paralelo.
  await disconnectClinic(clinicId);
  fs.mkdirSync(authDir(clinicId), { recursive: true });

  for (const [name, base64] of Object.entries(files as Record<string, unknown>)) {
    if (!SAFE_FILENAME.test(name) || typeof base64 !== "string") continue;
    fs.writeFileSync(path.join(authDir(clinicId), name), Buffer.from(base64, "base64"));
  }

  activeJobs.delete(clinicId);
  relayState.delete(clinicId);
  await connectClinic(clinicId); // VPS assume a sessao pareada pela rede local
  return true;
}

export function getRelayStatus(clinicId: string): { connecting: boolean; qr: string | null; lastError: string | null } | null {
  const state = relayState.get(clinicId);
  if (!state) return null;
  if (Date.now() - state.updatedAt > JOB_TTL_MS) {
    relayState.delete(clinicId);
    return null;
  }
  return {
    connecting: state.status === "connecting" || state.status === "qr",
    qr: state.status === "qr" ? state.qr : null,
    lastError: state.status === "error" ? state.message : null,
  };
}
