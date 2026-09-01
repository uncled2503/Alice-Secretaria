import { decryptSecret } from "./secretBox.js";
import type { MetaConfig } from "@prisma/client";

// Cliente da Graph API (endpoint /events da API de Conversoes). Nunca loga o
// token nem PII; classifica o erro em temporario (retenta) ou permanente (para).

const DEFAULT_GRAPH_VERSION = process.env.META_GRAPH_VERSION?.trim() || "v21.0";
const REQUEST_TIMEOUT_MS = 15_000;

export interface CapiEvent {
  event_name: string;
  event_time: number; // unix seconds
  event_id: string;
  action_source: "website";
  event_source_url?: string;
  user_data: Record<string, unknown>;
  custom_data?: Record<string, unknown>;
}

export interface CapiResult {
  ok: boolean;
  httpStatus: number;
  eventsReceived?: number;
  fbtraceId?: string;
  messages?: string[];
  error?: string;
  permanent: boolean; // true = nao adianta retentar
}

export function graphVersionOf(config: Pick<MetaConfig, "graphVersion">): string {
  return config.graphVersion?.trim() || DEFAULT_GRAPH_VERSION;
}

// Codigos da Graph API que nao adianta retentar (token/pixel/param invalido).
const PERMANENT_CODES = new Set([190, 200, 100, 803, 2500]);

function classifyError(httpStatus: number, code: number | undefined, subcode: number | undefined): boolean {
  if (httpStatus === 400 && code !== undefined && PERMANENT_CODES.has(code)) return true;
  if (httpStatus === 401 || httpStatus === 403) return true;
  if (code === 190) return true; // token invalido/expirado
  if (subcode === 33) return true; // objeto inexistente (pixel errado)
  // 4/17/32/613 (rate limit), 5xx, timeout, rede -> temporario
  return false;
}

function sanitizeMessages(body: unknown): string[] {
  const msgs: string[] = [];
  const err = (body as { error?: Record<string, unknown> })?.error;
  if (err) {
    for (const key of ["message", "error_user_msg", "error_user_title"]) {
      const v = err[key];
      if (typeof v === "string" && v.trim()) msgs.push(v.trim());
    }
  }
  return msgs.slice(0, 3);
}

// Envia UM evento. `config` precisa ter accessTokenEnc e pixelId.
export async function sendCapiEvent(
  config: Pick<MetaConfig, "pixelId" | "accessTokenEnc" | "graphVersion">,
  event: CapiEvent,
  testEventCode?: string | null,
): Promise<CapiResult> {
  if (!config.pixelId || !config.accessTokenEnc) {
    return { ok: false, httpStatus: 0, error: "Pixel/token nao configurados", permanent: true };
  }

  let token: string;
  try {
    token = decryptSecret(config.accessTokenEnc);
  } catch {
    return { ok: false, httpStatus: 0, error: "Nao foi possivel ler o token (chave de criptografia mudou?)", permanent: true };
  }

  const url = `https://graph.facebook.com/${graphVersionOf(config)}/${encodeURIComponent(config.pixelId)}/events`;
  const payload: Record<string, unknown> = { data: [event], access_token: token };
  if (testEventCode) payload.test_event_code = testEventCode;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      httpStatus: 0,
      error: err instanceof Error ? `rede: ${err.name}` : "falha de rede",
      permanent: false,
    };
  }

  const raw = await response.text();
  let body: unknown = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }

  if (response.ok) {
    const b = body as { events_received?: number; fbtrace_id?: string; messages?: string[] } | null;
    return {
      ok: true,
      httpStatus: response.status,
      eventsReceived: b?.events_received,
      fbtraceId: b?.fbtrace_id,
      messages: Array.isArray(b?.messages) ? b!.messages!.slice(0, 3) : undefined,
      permanent: false,
    };
  }

  const err = (body as { error?: { code?: number; error_subcode?: number; fbtrace_id?: string } })?.error;
  return {
    ok: false,
    httpStatus: response.status,
    fbtraceId: err?.fbtrace_id,
    messages: sanitizeMessages(body),
    error: `HTTP ${response.status}${err?.code ? ` (code ${err.code})` : ""}: ${sanitizeMessages(body).join("; ") || raw.slice(0, 200)}`,
    permanent: classifyError(response.status, err?.code, err?.error_subcode),
  };
}

// GET no proprio pixel: valida token + pixel de uma vez.
export async function testCapiConnection(
  config: Pick<MetaConfig, "pixelId" | "accessTokenEnc" | "graphVersion">,
): Promise<{ ok: boolean; detail: string }> {
  if (!config.pixelId || !config.accessTokenEnc) return { ok: false, detail: "Pixel/token nao configurados" };
  let token: string;
  try {
    token = decryptSecret(config.accessTokenEnc);
  } catch {
    return { ok: false, detail: "Nao foi possivel ler o token" };
  }
  const url = `https://graph.facebook.com/${graphVersionOf(config)}/${encodeURIComponent(config.pixelId)}?fields=id,name&access_token=${encodeURIComponent(token)}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const body = (await r.json().catch(() => null)) as { id?: string; name?: string; error?: { message?: string } } | null;
    if (r.ok && body?.id) return { ok: true, detail: `Pixel "${body.name ?? body.id}" acessivel.` };
    return { ok: false, detail: body?.error?.message?.slice(0, 200) || `HTTP ${r.status}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.name : "falha de rede" };
  }
}
