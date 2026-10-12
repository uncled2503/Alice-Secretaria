import fs from "fs";
import path from "path";
import crypto from "crypto";
import { prisma } from "../db/client.js";

// Backup consistente do SQLite (VACUUM INTO) + criptografia opcional + retencao. Usado pelo comando
// `npm run backup` e pelo job diario do servidor (backupJob.ts).

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function sqlitePath(databaseUrl: string): string {
  if (!databaseUrl.startsWith("file:")) {
    throw new Error("O backup automatico atual suporta somente DATABASE_URL do SQLite (file:...).");
  }

  const rawPath = databaseUrl.slice("file:".length).split("?")[0];
  if (!rawPath) throw new Error("DATABASE_URL nao contem o caminho do banco SQLite.");

  // Caminhos relativos do Prisma sao resolvidos a partir da pasta do schema.
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), "prisma", rawPath);
}

// Chave AES-256 do backup (BACKUP_ENCRYPTION_KEY: 32 bytes em base64 ou 64 hex). Sem chave o backup fica em claro
// (continua protegido so pelo acesso ao disco) - com chave, o arquivo guardado e database.db.enc.
function backupKey(): Buffer | null {
  const raw = process.env.BACKUP_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("BACKUP_ENCRYPTION_KEY precisa ter 32 bytes (base64 ou 64 caracteres hex).");
  return buf;
}

// Formato: [12 bytes IV][texto cifrado AES-256-GCM][16 bytes de tag]. Para restaurar: ver docs/backup.md.
async function encryptFile(source: string, destination: string, key: Buffer): Promise<void> {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const input = fs.createReadStream(source);
  const out = fs.createWriteStream(destination);
  out.write(iv);
  await new Promise<void>((resolve, reject) => {
    input.on("error", reject);
    cipher.on("error", reject);
    out.on("error", reject);
    cipher.on("end", () => out.end(cipher.getAuthTag(), () => resolve()));
    input.pipe(cipher).pipe(out, { end: false });
  });
}

export async function createBackup(): Promise<string> {
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

  const key = backupKey();
  let databaseFile = "database.db";
  if (key) {
    await encryptFile(databaseBackup, `${databaseBackup}.enc`, key);
    fs.rmSync(databaseBackup);
    databaseFile = "database.db.enc";
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    databaseFile,
    encrypted: Boolean(key),
    whatsappProvider: "uazapi",
    nodeVersion: process.version,
  };
  fs.writeFileSync(path.join(destination, "manifest.json"), JSON.stringify(manifest, null, 2));
  return destination;
}

// Mantem so os `keep` backups mais recentes (as pastas tem nome com data, entao ordenar o nome ordena no tempo).
export function pruneBackups(keep: number): number {
  const backupRoot = path.resolve(process.env.BACKUP_DIR ?? path.join(process.cwd(), "backups"));
  if (!fs.existsSync(backupRoot)) return 0;
  const dirs = fs
    .readdirSync(backupRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(d.name))
    .map((d) => d.name)
    .sort();
  const remove = dirs.slice(0, Math.max(0, dirs.length - keep));
  for (const name of remove) fs.rmSync(path.join(backupRoot, name), { recursive: true, force: true });
  return remove.length;
}
