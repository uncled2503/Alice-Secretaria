import { prisma } from "../db/client.js";
import { decryptSecret, encryptSecret, encryptionAvailable, maskToken } from "../meta/secretBox.js";
import { wallClockInZone, zoneOffsetMinutes } from "../scheduling/time.js";

// Cliente da API do Clinica Experts (sistema de agenda usado por clinicas
// como a Lisboa Beauty Center). Autenticacao por Bearer token gerado pela
// propria clinica em Configuracoes > Integracoes. O token fica criptografado
// no banco e nunca volta pro navegador.

const BASE = (process.env.CLINICA_EXPERTS_API_URL?.trim() || "https://api.clinicaexperts.com.br/api/v1").replace(/\/+$/, "");
const TIMEOUT_MS = 12_000;

export type CeResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; error: string };

type Query = Record<string, string | number | boolean | undefined | null>;

function buildUrl(path: string, query?: Query): string {
  const qs = Object.entries(query ?? {})
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return `${BASE}${path}${qs ? `?${qs}` : ""}`;
}

// Chamada crua com um token explicito (usada tambem pra validar o token antes
// de salvar). Nunca lanca: erro de rede/timeout vira { ok:false, status:0 }.
export async function ceCall<T = any>(
  token: string,
  path: string,
  init: { method?: string; query?: Query; body?: unknown } = {},
): Promise<CeResult<T>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(buildUrl(path, init.query), {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: ctrl.signal,
    });
    const json = (await res.json().catch(() => null)) as any;
    if (!res.ok) {
      const fields = json?.error?.fields ? ` ${JSON.stringify(json.error.fields)}` : "";
      const msg = json?.error?.user_message ?? json?.message ?? `HTTP ${res.status}`;
      return { ok: false, status: res.status, error: `${msg}${fields}`.slice(0, 300) };
    }
    return { ok: true, status: res.status, data: json as T };
  } catch (err) {
    const aborted = (err as Error).name === "AbortError";
    return { ok: false, status: 0, error: aborted ? "tempo esgotado falando com o Clinica Experts" : `falha de rede: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function getAccount(clinicId: string) {
  return prisma.clinicaExpertsAccount.findUnique({ where: { clinicId } });
}

export async function noteError(clinicId: string, message: string | null): Promise<void> {
  if (message) console.error(`[clinicaexperts] clinica ${clinicId}: ${message}`);
  await prisma.clinicaExpertsAccount.updateMany({ where: { clinicId }, data: { lastError: message ? message.slice(0, 300) : null } });
}

// Chamada autenticada com o token salvo da clinica. Registra o erro no painel.
export async function ceRequest<T = any>(
  clinicId: string,
  path: string,
  init: { method?: string; query?: Query; body?: unknown } = {},
): Promise<CeResult<T>> {
  const account = await getAccount(clinicId);
  if (!account) return { ok: false, status: 0, error: "Clinica Experts nao conectado" };
  let token: string;
  try {
    token = decryptSecret(account.tokenEnc);
  } catch {
    const error = "Nao foi possivel ler o token salvo (a chave de criptografia mudou?). Reconecte o Clinica Experts.";
    await noteError(clinicId, error);
    return { ok: false, status: 0, error };
  }
  const result = await ceCall<T>(token, path, init);
  if (!result.ok) await noteError(clinicId, `${init.method ?? "GET"} ${path}: ${result.error}`);
  return result;
}

// Conecta (ou troca o token). Valida o token com uma leitura antes de salvar.
export async function connectAccount(clinicId: string, token: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const clean = token.trim();
  if (clean.length < 20) return { ok: false, error: "Token invalido (muito curto)." };
  if (!encryptionAvailable()) return { ok: false, error: "META_ENCRYPTION_KEY nao configurada no servidor: nao da pra guardar o token com seguranca." };

  const check = await ceCall(clean, "/professionals", { query: { per_page: 1 } });
  if (!check.ok) {
    return { ok: false, error: check.status === 401 ? "O Clinica Experts recusou o token (confira se copiou inteiro)." : `Nao consegui validar o token: ${check.error}` };
  }
  await prisma.clinicaExpertsAccount.upsert({
    where: { clinicId },
    create: { clinicId, tokenEnc: encryptSecret(clean), tokenHint: maskToken(clean) },
    update: { tokenEnc: encryptSecret(clean), tokenHint: maskToken(clean), lastError: null },
  });
  return { ok: true };
}

export async function disconnectAccount(clinicId: string): Promise<void> {
  await prisma.clinicaExpertsAccount.deleteMany({ where: { clinicId } });
  await prisma.appointment.updateMany({ where: { clinicId, ceBookingUuid: { not: null } }, data: { ceBookingUuid: null } });
}

// "2026-10-08T14:30:00-03:00" - formato ISO 8601 com offset que a API exige.
export function isoWithOffset(instant: Date, timeZone: string): string {
  // Arredonda pro minuto: segundos/milissegundos do instante contaminariam o
  // calculo do offset (saia "-03:01").
  const whole = new Date(Math.floor(instant.getTime() / 60_000) * 60_000);
  const wc = wallClockInZone(whole, timeZone);
  const off = zoneOffsetMinutes(whole, timeZone);
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${wc.year}-${p(wc.month)}-${p(wc.day)}T${p(wc.hour)}:${p(wc.minute)}:00${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

// Limite de dia INTEIRO ("...T00:00:00" ou "...T23:59:59"). A listagem de
// agendamentos so devolve resultado confiavel com janelas de dia cheio:
// qualquer outro horario nas pontas da janela devolve resultados incompletos.
export function dayBoundIso(instant: Date, timeZone: string, edge: "start" | "end"): string {
  return isoWithOffset(instant, timeZone).replace(/T\d{2}:\d{2}:\d{2}/, edge === "start" ? "T00:00:00" : "T23:59:59");
}

export interface CeStatus {
  connected: boolean;
  tokenHint: string | null;
  syncOut: boolean;
  blockBusy: boolean;
  lastSyncAt: Date | null;
  lastCatalogAt: Date | null;
  lastError: string | null;
  linkedProfessionals: number;
  linkedProcedures: number;
}

export async function ceStatusFor(clinicId: string): Promise<CeStatus> {
  const account = await getAccount(clinicId);
  const [linkedProfessionals, linkedProcedures] = account
    ? await Promise.all([
        prisma.professional.count({ where: { clinicId, ceUuid: { not: null } } }),
        prisma.procedure.count({ where: { clinicId, ceId: { not: null } } }),
      ])
    : [0, 0];
  return {
    connected: Boolean(account),
    tokenHint: account?.tokenHint ?? null,
    syncOut: account?.syncOut ?? true,
    blockBusy: account?.blockBusy ?? true,
    lastSyncAt: account?.lastSyncAt ?? null,
    lastCatalogAt: account?.lastCatalogAt ?? null,
    lastError: account?.lastError ?? null,
    linkedProfessionals,
    linkedProcedures,
  };
}
