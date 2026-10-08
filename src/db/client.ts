import { PrismaClient } from "@prisma/client";

// SQLite com varios jobs gravando (importacao, lembretes, recontato, webhooks)
// e o painel lendo ao mesmo tempo: o padrao do Prisma espera so ~5s por um lock
// e depois devolve erro (vira "HTTP 500 Erro interno" no painel). Aumenta a espera
// por lock (socket_timeout) se a URL ainda nao definiu um valor.
function withLockTimeout(url: string | undefined): string | undefined {
  if (!url || !url.startsWith("file:")) return url;
  const [base, query = ""] = url.split("?");
  const params = new URLSearchParams(query);
  if (!params.has("socket_timeout")) params.set("socket_timeout", "30");
  return `${base}?${params.toString()}`;
}

const url = withLockTimeout(process.env.DATABASE_URL);
export const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : new PrismaClient();

// Modo WAL: leituras nao travam enquanto alguem grava (e vice-versa). E uma
// propriedade do ARQUIVO do banco - basta ligar uma vez; o backup (VACUUM INTO)
// continua consistente. Melhor esforco: se falhar, segue no modo anterior.
export async function enableWalMode(): Promise<void> {
  if (!process.env.DATABASE_URL?.startsWith("file:")) return;
  // Trocar o modo do diario exige o banco livre por um instante: tenta algumas
  // vezes antes de desistir (na subida pode haver outra conexao usando o arquivo).
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL");
      return;
    } catch (err) {
      if (attempt === 6) console.error("[db] nao consegui ligar o modo WAL:", err);
      else await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}
