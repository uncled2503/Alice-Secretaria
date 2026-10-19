import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import { PrismaClient } from "@prisma/client";
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

// ---------------------------------------------------------------------------
// VERIFICACAO DO BACKUP (21/10/2026). "BACKUP_DIR configurado" nao prova backup valido: o arquivo precisa ABRIR, passar no integrity_check do SQLite e ter as tabelas esperadas.
// A verificacao e feita sobre o arquivo FINAL (se criptografado, decifra para um temporario e confere), e o resultado vai no manifest. VACUUM INTO e consistente tanto no modo
// de diario padrao (DELETE) quanto em WAL: o modo de escrita do banco em producao e gravado no manifest (journal_mode) para conferencia.
// ---------------------------------------------------------------------------
export interface BackupVerification {
  ok: boolean;
  integrity: string; // "ok" ou a mensagem do SQLite
  tables: number;
  clinics: number;
  bytes: number;
  sha256: string;
  problem?: string;
}

async function decryptFile(source: string, destination: string, key: Buffer): Promise<void> {
  const data = fs.readFileSync(source);
  if (data.length < 12 + 16) throw new Error("arquivo cifrado curto demais");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(data.length - 16));
  fs.writeFileSync(destination, Buffer.concat([decipher.update(data.subarray(12, data.length - 16)), decipher.final()]));
}

// Restaura um backup (pasta com manifest.json) para `outFile`, SEM tocar no banco em uso. Criptografado: exige BACKUP_ENCRYPTION_KEY.
export async function restoreBackupTo(backupDir: string, outFile: string): Promise<void> {
  const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, "manifest.json"), "utf8")) as { databaseFile: string; encrypted: boolean };
  const stored = path.join(backupDir, manifest.databaseFile);
  if (manifest.encrypted) {
    const key = backupKey();
    if (!key) throw new Error("backup criptografado: configure BACKUP_ENCRYPTION_KEY para restaurar");
    await decryptFile(stored, outFile, key);
  } else {
    fs.copyFileSync(stored, outFile);
  }
}

export async function verifySqliteFile(file: string): Promise<{ integrity: string; tables: number; clinics: number }> {
  const normalized = file.replace(/\\/g, "/");
  const client = new PrismaClient({ datasources: { db: { url: `file:${normalized}` } } });
  try {
    const integrity = (await client.$queryRawUnsafe<{ integrity_check: string }[]>("PRAGMA integrity_check"))[0]?.integrity_check ?? "sem resposta";
    const tables = Number((await client.$queryRawUnsafe<{ n: bigint | number }[]>("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"))[0]?.n ?? 0);
    const clinics = Number((await client.$queryRawUnsafe<{ n: bigint | number }[]>('SELECT count(*) AS n FROM "Clinic"'))[0]?.n ?? 0);
    return { integrity, tables, clinics };
  } finally {
    await client.$disconnect();
  }
}

// Confere um backup JA GRAVADO restaurando-o para um temporario (nunca em producao) e abrindo-o.
export async function verifyBackupDir(backupDir: string): Promise<BackupVerification> {
  const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, "manifest.json"), "utf8")) as { databaseFile: string };
  const stored = path.join(backupDir, manifest.databaseFile);
  const bytes = fs.statSync(stored).size;
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(stored)).digest("hex");
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "alice-restore-")), "restored.db");
  try {
    await restoreBackupTo(backupDir, tmp);
    const v = await verifySqliteFile(tmp);
    const ok = v.integrity === "ok" && v.tables > 0;
    return { ok, ...v, bytes, sha256, ...(ok ? {} : { problem: v.integrity !== "ok" ? `integrity_check: ${v.integrity}` : "backup sem tabelas" }) };
  } catch (err) {
    return { ok: false, integrity: "nao_verificado", tables: 0, clinics: 0, bytes, sha256, problem: err instanceof Error ? err.message : String(err) };
  } finally {
    for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(tmp + ext, { force: true }); } catch { /* temporario */ } }
    try { fs.rmdirSync(path.dirname(tmp)); } catch { /* temporario */ }
  }
}

// ONDE o backup esta: "volume" (ponto de montagem proprio, nao a raiz do container: sobrevive ao redeploy, a durabilidade do volume em si e do EasyPanel/servidor),
// "raiz_do_container" (some no redeploy) ou "desconhecido" (sem /proc/self/mountinfo: Windows/desenvolvimento). Nao presume nada: le a tabela de montagens do Linux.
export function storageKind(dir: string, mountinfo?: string): "volume" | "raiz_do_container" | "desconhecido" {
  let info = mountinfo;
  if (info === undefined) {
    try { info = fs.readFileSync("/proc/self/mountinfo", "utf8"); } catch { return "desconhecido"; }
  }
  const target = path.resolve(dir).replace(/\\/g, "/");
  let best = "";
  for (const line of info.split("\n")) {
    const mp = line.split(" ")[4];
    if (mp && (target === mp || target.startsWith(mp.endsWith("/") ? mp : mp + "/")) && mp.length > best.length) best = mp;
  }
  if (!best) return "desconhecido";
  return best === "/" ? "raiz_do_container" : "volume";
}

export function backupRootDir(): string {
  return path.resolve(process.env.BACKUP_DIR ?? path.join(process.cwd(), "backups"));
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

  let journalMode = "desconhecido";
  try { journalMode = String((await prisma.$queryRawUnsafe<{ journal_mode: string }[]>("PRAGMA journal_mode"))[0]?.journal_mode ?? "desconhecido"); } catch { /* informativo */ }
  const manifest: Record<string, unknown> = {
    createdAt: new Date().toISOString(),
    databaseFile,
    encrypted: Boolean(key),
    whatsappProvider: "uazapi",
    nodeVersion: process.version,
    journalMode, // modo de escrita do banco de origem (VACUUM INTO e consistente em qualquer um)
    backupDirConfigured: Boolean(process.env.BACKUP_DIR),
    storage: storageKind(backupRoot),
  };
  fs.writeFileSync(path.join(destination, "manifest.json"), JSON.stringify(manifest, null, 2));
  // Confere o backup RECEM-GRAVADO restaurando-o num temporario: so conta como backup se abre e passa no integrity_check.
  const verification = await verifyBackupDir(destination);
  manifest.verification = verification;
  fs.writeFileSync(path.join(destination, "manifest.json"), JSON.stringify(manifest, null, 2));
  if (!verification.ok) throw new Error(`backup criado em ${destination} NAO passou na verificacao (${verification.problem ?? "sem detalhe"}): nao confie neste arquivo`);
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
