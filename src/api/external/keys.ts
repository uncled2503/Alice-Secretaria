import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { prisma } from "../../db/client.js";

// Escopos disponiveis para uma chave de API.
export const API_SCOPES = [
  { id: "identity.read", label: "Ler identidade da clínica (/me)" },
  { id: "contacts.read", label: "Ler contatos" },
  { id: "contacts.write", label: "Criar e editar contatos" },
  { id: "crm.read", label: "Ler funil e etapas" },
  { id: "crm.write", label: "Mover contato de etapa" },
  { id: "agenda.read", label: "Ler agenda e disponibilidade" },
  { id: "agenda.write", label: "Criar e alterar agendamentos" },
  { id: "catalog.read", label: "Ler procedimentos e produtos" },
  { id: "professionals.read", label: "Ler profissionais" },
] as const;

export const API_SCOPE_IDS = API_SCOPES.map((s) => s.id);

const KEY_PREFIX = "alk_";
const LOOKUP_LEN = 14;

export interface GeneratedKey {
  secret: string; // mostrado uma unica vez
  lookup: string;
  hash: string;
}

export function generateApiKey(): GeneratedKey {
  const secret = KEY_PREFIX + randomBytes(30).toString("base64url");
  return {
    secret,
    lookup: secret.slice(0, LOOKUP_LEN),
    hash: createHash("sha256").update(secret).digest("hex"),
  };
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export interface ResolvedKey {
  id: string;
  clinicId: string;
  name: string;
  scopes: string[];
}

// Resolve o header Authorization: Bearer <chave>. Retorna null se invalida,
// revogada ou ausente.
export async function resolveApiKey(authHeader: string | undefined): Promise<ResolvedKey | null> {
  if (!authHeader) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());
  const token = m?.[1];
  if (!token || !token.startsWith(KEY_PREFIX) || token.length < 24) return null;

  const record = await prisma.apiKey.findUnique({ where: { lookup: token.slice(0, LOOKUP_LEN) } });
  if (!record || record.revokedAt) return null;

  const presented = createHash("sha256").update(token).digest("hex");
  if (!safeEqualHex(presented, record.hash)) return null;

  // Toque leve no lastUsedAt (no maximo uma vez por minuto).
  if (!record.lastUsedAt || Date.now() - record.lastUsedAt.getTime() > 60_000) {
    prisma.apiKey.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  }

  return {
    id: record.id,
    clinicId: record.clinicId,
    name: record.name,
    scopes: record.scopes.split(",").map((s) => s.trim()).filter(Boolean),
  };
}

export function maskedKey(lookup: string): string {
  return `${lookup}…`;
}

declare global {
  namespace Express {
    interface Request {
      apiKey?: ResolvedKey;
    }
  }
}
