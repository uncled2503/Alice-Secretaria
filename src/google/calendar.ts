import crypto from "crypto";
import { prisma } from "../db/client.js";
import { encryptSecret, decryptSecret, encryptionAvailable } from "../meta/secretBox.js";
import { formatDateTimeInZone } from "../scheduling/time.js";

// ---------------------------------------------------------------------------
// Integracao com o Google Agenda, nos dois sentidos:
//
//   syncOut   -> o que a Alice agenda vira evento no Google Agenda da clinica.
//   blockBusy -> o que ja esta no Google Agenda (compromisso pessoal, cirurgia,
//                viagem) ocupa a agenda da Alice, entao ela nao oferece um
//                horario que na vida real nao existe.
//
// Falar com o Google e sempre "melhor esforco": nenhuma falha aqui pode
// derrubar um agendamento nem travar a conversa. Quando algo da errado, fica
// registrado em lastError pra aparecer no painel.
//
// Sem as variaveis de ambiente configuradas, tudo isso fica simplesmente
// desligado e o resto do sistema segue igual.
// ---------------------------------------------------------------------------

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

function clientId(): string {
  return process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
}
function clientSecret(): string {
  return process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
}

// A URI de retorno precisa ser IGUAL a cadastrada no Google Cloud Console.
export function redirectUri(): string {
  const explicit = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const base = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
  return base ? `${base}/api/google/callback` : "";
}

export function googleConfigured(): boolean {
  return Boolean(clientId() && clientSecret() && redirectUri() && encryptionAvailable());
}

// Por que falta configurar - mostrado no painel em vez de um "nao disponivel" seco.
export function googleConfigHint(): string | null {
  if (!clientId() || !clientSecret()) return "Faltam GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no servidor.";
  if (!redirectUri()) return "Falta PUBLIC_BASE_URL (ou GOOGLE_REDIRECT_URI) no servidor.";
  if (!encryptionAvailable()) return "Falta META_ENCRYPTION_KEY no servidor (usada para guardar o token do Google).";
  return null;
}

// --- state assinado: amarra o retorno do Google a clinica que iniciou ---

function stateSecret(): string {
  return process.env.SESSION_SECRET ?? "";
}

export function buildState(clinicId: string): string {
  const nonce = crypto.randomBytes(8).toString("hex");
  const payload = `${clinicId}.${nonce}`;
  const sig = crypto.createHmac("sha256", stateSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function readState(state: string): string | null {
  const parts = String(state ?? "").split(".");
  if (parts.length !== 3) return null;
  const [clinicId, nonce, sig] = parts;
  const expected = crypto.createHmac("sha256", stateSecret()).update(`${clinicId}.${nonce}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return clinicId;
}

export function buildAuthUrl(clinicId: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES,
    // offline + consent: garante que o Google devolva refresh_token mesmo
    // quando a conta ja autorizou o app antes.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: buildState(clinicId),
  });
  return `${AUTH_URL}?${params.toString()}`;
}

// --- tokens ---

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  return (await res.json()) as TokenResponse;
}

// Troca o "code" do retorno do Google pelos tokens e salva a conexao.
export async function connectFromCode(clinicId: string, code: string): Promise<{ ok: true; email: string | null } | { ok: false; error: string }> {
  if (!googleConfigured()) return { ok: false, error: googleConfigHint() ?? "Integracao nao configurada." };

  const tokens = await postToken({
    code,
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: redirectUri(),
    grant_type: "authorization_code",
  });

  if (!tokens.access_token) {
    return { ok: false, error: tokens.error_description || tokens.error || "O Google nao devolveu o token de acesso." };
  }
  if (!tokens.refresh_token) {
    // Sem refresh_token a conexao morre em 1h. Acontece quando a conta ja
    // autorizou antes e o Google reaproveita o consentimento.
    return {
      ok: false,
      error: "O Google nao devolveu o token de renovacao. Remova o acesso do app em myaccount.google.com/permissions e conecte de novo.",
    };
  }

  let email: string | null = null;
  try {
    const res = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    if (res.ok) email = ((await res.json()) as { email?: string }).email ?? null;
  } catch {
    // e so o rotulo da conta no painel - nao vale falhar a conexao por isso
  }

  const data = {
    googleEmail: email,
    refreshToken: encryptSecret(tokens.refresh_token),
    accessToken: encryptSecret(tokens.access_token),
    accessExpiresAt: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000),
    lastError: null,
  };
  await prisma.googleCalendarAccount.upsert({
    where: { clinicId },
    update: data,
    create: { clinicId, ...data },
  });

  return { ok: true, email };
}

export async function disconnect(clinicId: string): Promise<void> {
  await prisma.googleCalendarAccount.deleteMany({ where: { clinicId } });
  await prisma.appointment.updateMany({ where: { clinicId, googleEventId: { not: null } }, data: { googleEventId: null } });
}

async function noteError(clinicId: string, message: string): Promise<void> {
  console.error(`[google] clinica ${clinicId}: ${message}`);
  await prisma.googleCalendarAccount.updateMany({ where: { clinicId }, data: { lastError: message.slice(0, 300) } });
}

// Access token valido, renovando quando falta menos de 2min pra expirar.
async function accessTokenFor(clinicId: string): Promise<string | null> {
  if (!googleConfigured()) return null;
  const account = await prisma.googleCalendarAccount.findUnique({ where: { clinicId } });
  if (!account) return null;

  if (account.accessToken && account.accessExpiresAt && account.accessExpiresAt.getTime() - Date.now() > 120_000) {
    try {
      return decryptSecret(account.accessToken);
    } catch {
      // cai pro refresh abaixo
    }
  }

  let refresh: string;
  try {
    refresh = decryptSecret(account.refreshToken);
  } catch {
    await noteError(clinicId, "Nao foi possivel ler o token salvo (a chave de criptografia mudou?). Reconecte o Google Agenda.");
    return null;
  }

  const tokens = await postToken({
    refresh_token: refresh,
    client_id: clientId(),
    client_secret: clientSecret(),
    grant_type: "refresh_token",
  });

  if (!tokens.access_token) {
    await noteError(clinicId, `Falha ao renovar o acesso ao Google (${tokens.error ?? "sem detalhe"}). Pode ser preciso reconectar.`);
    return null;
  }

  await prisma.googleCalendarAccount.update({
    where: { clinicId },
    data: {
      accessToken: encryptSecret(tokens.access_token),
      accessExpiresAt: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000),
      lastError: null,
    },
  });
  return tokens.access_token;
}

async function callGoogle(
  clinicId: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ ok: true; data: any } | { ok: false }> {
  const token = await accessTokenFor(clinicId);
  if (!token) return { ok: false };

  try {
    const res = await fetch(`${API}${path}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

    if (res.status === 204) return { ok: true, data: null };
    const data = (await res.json().catch(() => null)) as any;
    if (!res.ok) {
      const detail = data?.error?.message ?? `HTTP ${res.status}`;
      await noteError(clinicId, `Google Agenda recusou a chamada: ${detail}`);
      return { ok: false };
    }
    return { ok: true, data };
  } catch (err) {
    await noteError(clinicId, `Nao foi possivel falar com o Google Agenda: ${(err as Error).message}`);
    return { ok: false };
  }
}

// --- horarios ocupados no Google (entra na agenda da Alice) ---

export interface BusyInterval {
  start: number;
  end: number;
}

// Cache curto: a geracao de horarios chama isso varias vezes seguidas (uma por
// profissional), e sem cache seria uma ida ao Google por chamada.
const busyCache = new Map<string, { at: number; intervals: BusyInterval[] }>();
const BUSY_CACHE_MS = 60_000;
const BUSY_WINDOW_DAYS = 30;

export function invalidateBusyCache(clinicId: string): void {
  busyCache.delete(clinicId);
}

// Intervalos ocupados no Google Agenda da clinica nos proximos dias.
// Devolve [] quando a integracao esta desligada, nao conectada ou falhou -
// nunca quebra a geracao de horarios.
export async function googleBusyIntervals(clinicId: string): Promise<BusyInterval[]> {
  if (!googleConfigured()) return [];

  const cached = busyCache.get(clinicId);
  if (cached && Date.now() - cached.at < BUSY_CACHE_MS) return cached.intervals;

  const account = await prisma.googleCalendarAccount.findUnique({ where: { clinicId } });
  if (!account || !account.blockBusy) {
    busyCache.set(clinicId, { at: Date.now(), intervals: [] });
    return [];
  }

  const timeMin = new Date();
  const timeMax = new Date(Date.now() + BUSY_WINDOW_DAYS * 24 * 3_600_000);
  const res = await callGoogle(clinicId, "/freeBusy", {
    method: "POST",
    body: {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      items: [{ id: account.calendarId }],
    },
  });

  if (!res.ok) {
    // Guarda vazio no cache pra nao martelar o Google a cada horario gerado.
    busyCache.set(clinicId, { at: Date.now(), intervals: [] });
    return [];
  }

  const raw = res.data?.calendars?.[account.calendarId]?.busy ?? [];
  const intervals: BusyInterval[] = raw
    .map((b: { start: string; end: string }) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }))
    .filter((b: BusyInterval) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start);

  busyCache.set(clinicId, { at: Date.now(), intervals });
  await prisma.googleCalendarAccount.updateMany({ where: { clinicId }, data: { lastSyncAt: new Date(), lastError: null } });
  return intervals;
}

// --- agendamento da Alice -> evento no Google ---

// Espelha um agendamento no Google Agenda. Best-effort: erro aqui nunca
// invalida o agendamento que ja foi criado no banco.
export async function pushAppointment(appointmentId: string): Promise<void> {
  if (!googleConfigured()) return;

  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { patient: true, procedure: true, professional: true, clinic: true },
  });
  if (!appt) return;

  const account = await prisma.googleCalendarAccount.findUnique({ where: { clinicId: appt.clinicId } });
  if (!account || !account.syncOut) return;

  const tz = appt.clinic.timezone || "America/Sao_Paulo";
  const start = appt.scheduledAt;
  const end = new Date(start.getTime() + appt.procedure.durationMin * 60_000);
  const quem = appt.patient.name?.trim() || appt.patient.phone;

  const body = {
    summary: `${appt.procedure.name} - ${quem}`,
    description: [
      `Paciente: ${quem}`,
      `Telefone: ${appt.patient.phone}`,
      appt.professional ? `Profissional: ${appt.professional.name}` : null,
      `Agendado pela Alice em ${formatDateTimeInZone(appt.createdAt, tz)}.`,
    ]
      .filter(Boolean)
      .join("\n"),
    start: { dateTime: start.toISOString(), timeZone: tz },
    end: { dateTime: end.toISOString(), timeZone: tz },
    extendedProperties: { private: { aliceAppointmentId: appt.id } },
  };

  const path = `/calendars/${encodeURIComponent(account.calendarId)}/events`;
  const res = appt.googleEventId
    ? await callGoogle(appt.clinicId, `${path}/${encodeURIComponent(appt.googleEventId)}`, { method: "PATCH", body })
    : await callGoogle(appt.clinicId, path, { method: "POST", body });

  if (!res.ok) return;

  const eventId = res.data?.id as string | undefined;
  if (eventId && eventId !== appt.googleEventId) {
    await prisma.appointment.update({ where: { id: appt.id }, data: { googleEventId: eventId } });
  }
  invalidateBusyCache(appt.clinicId);
  await prisma.googleCalendarAccount.updateMany({ where: { clinicId: appt.clinicId }, data: { lastSyncAt: new Date() } });
}

// Tira do Google o evento de um agendamento cancelado.
export async function removeAppointment(appointmentId: string): Promise<void> {
  if (!googleConfigured()) return;

  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  if (!appt?.googleEventId) return;

  const account = await prisma.googleCalendarAccount.findUnique({ where: { clinicId: appt.clinicId } });
  if (!account) return;

  await callGoogle(
    appt.clinicId,
    `/calendars/${encodeURIComponent(account.calendarId)}/events/${encodeURIComponent(appt.googleEventId)}`,
    { method: "DELETE" },
  );
  await prisma.appointment.update({ where: { id: appt.id }, data: { googleEventId: null } });
  invalidateBusyCache(appt.clinicId);
}

// Dispara a sincronizacao sem prender quem chamou (agendar tem que responder
// rapido pro paciente; o Google pode demorar).
export function pushAppointmentInBackground(appointmentId: string): void {
  void pushAppointment(appointmentId).catch((err) => console.error("[google] pushAppointment:", err));
}

export function removeAppointmentInBackground(appointmentId: string): void {
  void removeAppointment(appointmentId).catch((err) => console.error("[google] removeAppointment:", err));
}

// --- estado pro painel ---

export interface GoogleStatus {
  configured: boolean;
  hint: string | null;
  connected: boolean;
  email: string | null;
  calendarId: string | null;
  syncOut: boolean;
  blockBusy: boolean;
  lastSyncAt: Date | null;
  lastError: string | null;
}

export async function statusFor(clinicId: string): Promise<GoogleStatus> {
  const account = await prisma.googleCalendarAccount.findUnique({ where: { clinicId } });
  return {
    configured: googleConfigured(),
    hint: googleConfigHint(),
    connected: Boolean(account),
    email: account?.googleEmail ?? null,
    calendarId: account?.calendarId ?? null,
    syncOut: account?.syncOut ?? true,
    blockBusy: account?.blockBusy ?? true,
    lastSyncAt: account?.lastSyncAt ?? null,
    lastError: account?.lastError ?? null,
  };
}
