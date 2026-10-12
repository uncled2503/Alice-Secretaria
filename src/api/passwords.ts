import { scryptSync, scrypt, randomBytes, timingSafeEqual } from "crypto";

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const hashBuf = Buffer.from(hash, "hex");
  const candidateBuf = scryptSync(password, salt, 64);
  if (candidateBuf.length !== hashBuf.length) return false;
  return timingSafeEqual(candidateBuf, hashBuf);
}

// Versao NAO bloqueante pro login: o scrypt sincrono segurava o servidor inteiro (webhooks, painel, jobs) por dezenas
// de ms a cada tentativa - e o login e a rota publica. Mesmo resultado de verifyPassword.
export function verifyPasswordAsync(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return Promise.resolve(false);
  const hashBuf = Buffer.from(hash, "hex");
  return new Promise((resolve) => {
    scrypt(password, salt, 64, (err, candidate) => {
      if (err || candidate.length !== hashBuf.length) return resolve(false);
      resolve(timingSafeEqual(candidate, hashBuf));
    });
  });
}
