import { createHmac, timingSafeEqual } from "crypto";

// Identifica QUEM esta logado e com que papel - isso e o controle de acesso
// de verdade do painel (nao so atribuicao de mensagem). role="admin" opera
// qualquer clinica; role="client" fica travado na propria clinica em toda a
// API (ver getClinic em api/routes.ts). Sessao e um cookie assinado (sem
// tabela de sessao no banco).
const SECRET = process.env.SESSION_SECRET ?? "alice-dev-secret-troque-em-producao";
const COOKIE_NAME = "alice_staff";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface StaffSession {
  id: string;
  name: string;
  clinicId: string | null;
  role: "admin" | "client";
  exp: number;
}

function sign(payload: string): string {
  return createHmac("sha256", SECRET).update(payload).digest("hex");
}

export function createSessionCookie(staff: { id: string; name: string; clinicId: string | null; role: "admin" | "client" }): string {
  const payload = Buffer.from(JSON.stringify({ ...staff, exp: Date.now() + MAX_AGE_MS })).toString("base64url");
  const sig = sign(payload);
  return `${COOKIE_NAME}=${payload}.${sig}; HttpOnly; Path=/; Max-Age=${Math.floor(MAX_AGE_MS / 1000)}; SameSite=Lax`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function readStaffSession(cookieHeader: string | undefined): StaffSession | null {
  const raw = parseCookies(cookieHeader)[COOKIE_NAME];
  if (!raw) return null;

  const dotIndex = raw.lastIndexOf(".");
  if (dotIndex === -1) return null;
  const payload = raw.slice(0, dotIndex);
  const sig = raw.slice(dotIndex + 1);

  const expectedSig = sign(payload);
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expectedSig, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as StaffSession;
    if (typeof data.exp !== "number" || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

declare global {
  namespace Express {
    interface Request {
      staff?: StaffSession | null;
    }
  }
}
