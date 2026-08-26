import { timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Autenticacao simples por usuario/senha fixos (uso interno da clinica).
// Suficiente pra uma unica clinica auto-hospedada; evoluir para login por
// usuario quando houver mais de uma pessoa da equipe acessando.
export function basicAuth(req: Request, res: Response, next: NextFunction): void {
  const user = process.env.ADMIN_USER ?? "";
  const pass = process.env.ADMIN_PASSWORD ?? "";

  if (!user || !pass) {
    res.status(500).send("ADMIN_USER/ADMIN_PASSWORD nao configurados no .env");
    return;
  }

  const header = req.headers.authorization;
  if (header?.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const [reqUser, reqPass] = decoded.split(":");
    if (reqUser && reqPass && safeEqual(reqUser, user) && safeEqual(reqPass, pass)) {
      next();
      return;
    }
  }

  res.set("WWW-Authenticate", 'Basic realm="Alice Admin"');
  res.status(401).send("Autenticacao necessaria");
}
