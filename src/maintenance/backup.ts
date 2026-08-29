import "dotenv/config";
import fs from "fs";
import path from "path";
import { prisma } from "../db/client.js";

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sqlitePath(databaseUrl: string): string {
  if (!databaseUrl.startsWith("file:")) {
    throw new Error("O backup automatico atual suporta somente DATABASE_URL do SQLite (file:...).");
  }

  const rawPath = databaseUrl.slice("file:".length).split("?")[0];
  if (!rawPath) throw new Error("DATABASE_URL nao contem o caminho do banco SQLite.");

  // Caminhos relativos do Prisma sao resolvidos a partir da pasta do schema.
  return path.isAbsolute(rawPath)
    ? rawPath
    : path.resolve(process.cwd(), "prisma", rawPath);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL nao configurada.");

  const sourceDatabase = sqlitePath(databaseUrl);
  if (!fs.existsSync(sourceDatabase)) {
    throw new Error(`Banco SQLite nao encontrado em ${sourceDatabase}.`);
  }

  const backupRoot = path.resolve(process.env.BACKUP_DIR ?? path.join(process.cwd(), "backups"));
  const destination = path.join(backupRoot, timestamp());
  fs.mkdirSync(destination, { recursive: true });

  const databaseBackup = path.join(destination, "database.db");
  const escapedBackupPath = databaseBackup.replace(/'/g, "''");

  // VACUUM INTO cria uma copia transacionalmente consistente mesmo enquanto a
  // aplicacao esta recebendo mensagens e gravando no SQLite.
  await prisma.$executeRawUnsafe(`VACUUM INTO '${escapedBackupPath}'`);

  const manifest = {
    createdAt: new Date().toISOString(),
    databaseFile: "database.db",
    whatsappProvider: "uazapi",
    nodeVersion: process.version,
  };
  fs.writeFileSync(path.join(destination, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(`Backup criado em ${destination}`);
}

main()
  .catch((error) => {
    console.error("Falha ao criar backup:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
