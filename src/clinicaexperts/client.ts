import { prisma } from "../db/client.js";
import { decryptSecret, encryptSecret, encryptionAvailable, maskToken } from "../meta/secretBox.js";
import { wallClockInZone, zoneOffsetMinutes } from "../scheduling/time.js";
import { listMeta } from "./contract.js";

// Cliente da API do Clinica Experts (sistema de agenda usado por clinicas
// como a Lisboa Beauty Center). Autenticacao por Bearer token gerado pela
// propria clinica em Configuracoes > Integracoes. O token fica criptografado
// no banco e nunca volta pro navegador.

const BASE = (process.env.CLINICA_EXPERTS_API_URL?.trim() || "https://api.clinicaexperts.com.br/api/v1").replace(/\/+$/, "");
const TIMEOUT_MS = 12_000;

// Falhas DISTINTAS: autenticacao (401), permissao (403), limite de chamadas (429), validacao (400/422), nao encontrado (404/410), servidor (5xx), rede/tempo esgotado (0) e
// resposta invalida (HTTP 200 com corpo vazio / JSON quebrado: NAO e confirmacao de sucesso). Cada uma pede um tratamento diferente (ver isUncertain).
export type CeErrorKind = "auth" | "forbidden" | "rate_limit" | "validation" | "not_found" | "server" | "network" | "invalid_response" | "other";
export type CeResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; error: string; kind: CeErrorKind; retryAfterSec?: number };

export function ceErrorKind(status: number): CeErrorKind {
  if (status === 0) return "network";
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limit";
  if (status === 400 || status === 422) return "validation";
  if (status === 404 || status === 410) return "not_found";
  if (status >= 500) return "server";
  return "other";
}

// RESULTADO INCERTO de uma ESCRITA: nao da pra saber se o CE aplicou (rede caiu, tempo esgotado, 5xx, ou 200 com corpo invalido). Nunca se repete uma criacao as cegas
// depois disso: reconcilia (procura a reserva la) primeiro. 401/403/422/404 sao recusas DEFINITIVAS (nada foi criado).
export function isUncertain(res: CeResult<unknown>): boolean {
  return !res.ok && (res.kind === "network" || res.kind === "server" || res.kind === "invalid_response");
}

// Limite de chamadas: a documentacao diz 100/min (Status of returns) e 120/min (Request limits). Usamos o MENOR com folga (90/min por conta) e, ao receber 429, respeitamos a
// pausa antes de qualquer nova chamada daquela conta. Chamadas de leitura que passariam do limite esperam um pouco; escrita nunca e repetida automaticamente.
const RATE_PER_MIN = Number(process.env.CE_RATE_PER_MIN) > 0 ? Number(process.env.CE_RATE_PER_MIN) : 90;
const MAX_LOCAL_WAIT_MS = 20_000;
const windows = new Map<string, number[]>();
const blockedUntil = new Map<string, number>();
const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export function resetCeRateLimitForTests(): void { windows.clear(); blockedUntil.clear(); }

async function rateGate(key: string): Promise<{ wait: number } | { fail: string }> {
  const now = Date.now();
  const block = blockedUntil.get(key) ?? 0;
  if (block > now) return { fail: `o Clinica Experts pediu para esperar (limite de chamadas); nova tentativa em ${Math.ceil((block - now) / 1000)}s` };
  const w = (windows.get(key) ?? []).filter((t) => now - t < 60_000);
  let wait = 0;
  if (w.length >= RATE_PER_MIN) {
    wait = w[0] + 60_000 - now;
    if (wait > MAX_LOCAL_WAIT_MS) return { fail: "limite local de chamadas ao Clinica Experts atingido; tente novamente em instantes" };
  }
  windows.set(key, [...w, now + wait]);
  return { wait: Math.max(0, wait) };
}


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
  const gateKey = token.slice(-12);
  const gate = await rateGate(gateKey);
  if ("fail" in gate) return { ok: false, status: 429, kind: "rate_limit", error: gate.fail };
  if (gate.wait > 0) await sleepMs(gate.wait);
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
    const text = await res.text().catch(() => "");
    let json: any = null;
    let parsed = false;
    if (text.trim()) { try { json = JSON.parse(text); parsed = true; } catch { parsed = false; } }
    if (!res.ok) {
      // 422: `errors` = { campo: [mensagens] }; 401/outros: `message`
      const errs = json?.errors && typeof json.errors === "object" ? ` ${JSON.stringify(json.errors).slice(0, 160)}` : "";
      const fields = json?.error?.fields ? ` ${JSON.stringify(json.error.fields)}` : "";
      const msg = json?.error?.user_message ?? json?.message ?? `HTTP ${res.status}`;
      const retry = Number(res.headers.get("retry-after"));
      if (res.status === 429) blockedUntil.set(gateKey, Date.now() + (Number.isFinite(retry) && retry > 0 ? retry * 1000 : 15_000));
      return { ok: false, status: res.status, kind: ceErrorKind(res.status), error: `${msg}${errs}${fields}`.slice(0, 300), ...(Number.isFinite(retry) && retry > 0 ? { retryAfterSec: retry } : {}) };
    }
    // HTTP 2xx: 204 e corpo vazio so valem como sucesso quando o endpoint nao devolve dado; JSON quebrado/vazio num endpoint que devolve dado NAO e confirmacao.
    if (res.status === 204) return { ok: true, status: res.status, data: null as T };
    if (!parsed || json === null || typeof json !== "object") {
      return { ok: false, status: res.status, kind: "invalid_response", error: text.trim() ? "resposta do Clinica Experts ilegivel (JSON invalido)" : "resposta do Clinica Experts vazia" };
    }
    return { ok: true, status: res.status, data: json as T };
  } catch (err) {
    const aborted = (err as Error).name === "AbortError";
    return { ok: false, status: 0, kind: "network", error: aborted ? "tempo esgotado falando com o Clinica Experts" : `falha de rede: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

// TODAS as paginas de uma listagem. per_page maximo documentado = 1000, mas isso NAO garante resposta completa: segue `meta.last_page` (e, sem meta, continua enquanto a pagina vier
// cheia) e CONFERE o total (`meta.of`). `complete:false` quando passou do teto de paginas ou o total nao fechou: quem chama NAO conclui "nao existe" a partir de lista incompleta.
export async function ceListAll<T = any>(
  clinicId: string,
  path: string,
  query: Query = {},
  opts: { perPage?: number; maxPages?: number } = {},
): Promise<{ ok: true; items: T[]; pages: number; complete: boolean } | { ok: false; status: number; kind: CeErrorKind; error: string }> {
  const perPage = Math.min(1000, Math.max(1, opts.perPage ?? 1000));
  const maxPages = opts.maxPages ?? 50;
  const items: T[] = [];
  let expected: number | null = null;
  for (let page = 1; page <= maxPages; page++) {
    const res = await ceRequest<{ data: T[]; meta?: unknown }>(clinicId, path, { query: { ...query, per_page: perPage, page } });
    if (!res.ok) return { ok: false, status: res.status, kind: res.kind, error: res.error };
    const body = res.data as { data?: unknown; meta?: unknown } | null;
    if (!body || !Array.isArray(body.data)) return { ok: false, status: res.status, kind: "invalid_response", error: `resposta de ${path} sem a lista \`data\`` };
    items.push(...(body.data as T[]));
    const meta = listMeta(body.meta);
    if (meta?.of != null) expected = meta.of;
    const last = meta ? meta.lastPage : body.data.length >= perPage ? page + 1 : page;
    if (page >= last) return { ok: true, items, pages: page, complete: expected == null ? true : items.length >= expected };
  }
  return { ok: true, items, pages: maxPages, complete: false };
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
  if (!account) return { ok: false, status: 0, kind: "other", error: "Clinica Experts nao conectado" };
  let token: string;
  try {
    token = decryptSecret(account.tokenEnc);
  } catch {
    const error = "Nao foi possivel ler o token salvo (a chave de criptografia mudou?). Reconecte o Clinica Experts.";
    await noteError(clinicId, error);
    return { ok: false, status: 0, kind: "other", error };
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

// Desconectar NAO apaga o uuid das reservas nem dos pacientes/profissionais: sao o vinculo que permite reconciliar se a clinica reconectar a MESMA conta. Sem conta, nada e
// consultado nem sincronizado (liveCheck trata como "sem integracao"). Trocar de conta e uma acao explicita: `resetCeLinks`.
export async function disconnectAccount(clinicId: string): Promise<void> {
  await prisma.clinicaExpertsAccount.deleteMany({ where: { clinicId } });
}

// Troca de conta (outra clinica no CE): os uuids antigos nao valem mais. Acao EXPLICITA (nunca automatica) e que registra o que foi desvinculado.
export async function resetCeLinks(clinicId: string): Promise<{ appointments: number; patients: number; professionals: number; procedures: number }> {
  const appointments = (await prisma.appointment.updateMany({ where: { clinicId, ceBookingUuid: { not: null } }, data: { ceBookingUuid: null, ceStatus: null, ceUpdatedAt: null, ceSyncedAt: null } })).count;
  const patients = (await prisma.patient.updateMany({ where: { clinicId, ceUuid: { not: null } }, data: { ceUuid: null } })).count;
  const professionals = (await prisma.professional.updateMany({ where: { clinicId, ceUuid: { not: null } }, data: { ceUuid: null } })).count;
  const procedures = (await prisma.procedure.updateMany({ where: { clinicId, ceId: { not: null } }, data: { ceId: null } })).count;
  return { appointments, patients, professionals, procedures };
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
