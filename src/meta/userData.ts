import crypto from "crypto";

// Monta o user_data do evento da CAPI. Meta exige SHA-256 (hex minusculo) nos
// campos de identificacao (email, telefone, external_id). fbp e fbc NUNCA sao
// criptografados. Nunca colocamos email/telefone crus em log nem no payload
// salvo - so o hash.

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// So numeros, com codigo do pais. A base da Alice ja guarda "55DDDNUMERO".
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits;
}

export interface LeadForMeta {
  id: string;
  phone: string;
  email?: string | null;
  metaFbc?: string | null;
  metaFbp?: string | null;
}

export interface MetaUserData {
  em?: string[];
  ph?: string[];
  external_id?: string[];
  fbc?: string;
  fbp?: string;
  client_ip_address?: string;
  client_user_agent?: string;
}

export function buildUserData(lead: LeadForMeta, extra: { ip?: string | null; userAgent?: string | null } = {}): MetaUserData {
  const out: MetaUserData = {};

  if (lead.email && lead.email.trim()) out.em = [sha256Hex(normalizeEmail(lead.email))];

  const phone = normalizePhone(lead.phone || "");
  if (phone.length >= 10) out.ph = [sha256Hex(phone)];

  // external_id estavel pelo telefone normalizado (ou id do lead, na falta)
  const externalSeed = phone.length >= 10 ? phone : lead.id;
  out.external_id = [sha256Hex(externalSeed)];

  if (lead.metaFbc && lead.metaFbc.trim()) out.fbc = lead.metaFbc.trim();
  if (lead.metaFbp && lead.metaFbp.trim()) out.fbp = lead.metaFbp.trim();

  if (extra.ip) out.client_ip_address = extra.ip;
  if (extra.userAgent) out.client_user_agent = extra.userAgent;

  return out;
}

// Formata o ctwa_clid do Click-to-WhatsApp no padrao fbc da Meta:
// fb.1.<timestamp_ms>.<ctwa_clid>
export function ctwaClidToFbc(ctwaClid: string, whenMs: number = Date.now()): string {
  return `fb.1.${whenMs}.${ctwaClid}`;
}
