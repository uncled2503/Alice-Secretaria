import crypto from "crypto";

// Criptografia simetrica pro token da API de Conversoes da Meta. AES-256-GCM
// com chave de 32 bytes em META_ENCRYPTION_KEY (base64 ou hex). O token nunca
// e gravado em texto puro nem volta pro navegador.

function key(): Buffer | null {
  const raw = process.env.META_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  let buf: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) buf = Buffer.from(raw, "hex");
  else buf = Buffer.from(raw, "base64");
  return buf.length === 32 ? buf : null;
}

export function encryptionAvailable(): boolean {
  return key() !== null;
}

export function encryptSecret(plain: string): string {
  const k = key();
  if (!k) throw new Error("META_ENCRYPTION_KEY nao configurada (ou nao tem 32 bytes)");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function decryptSecret(enc: string): string {
  const k = key();
  if (!k) throw new Error("META_ENCRYPTION_KEY nao configurada");
  const [version, ivB64, tagB64, ctB64] = enc.split(":");
  if (version !== "v1" || !ivB64 || !tagB64 || !ctB64) throw new Error("token criptografado invalido");
  const decipher = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

// "••••••••1234" a partir do token em texto puro.
export function maskToken(token: string): string {
  const tail = token.slice(-4);
  return `${"•".repeat(12)}${tail}`;
}
