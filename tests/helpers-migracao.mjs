// Ajuda dos testes de migracao: constroi UMA vez (por maquina e por conteudo das migracoes) o banco "estado imediatamente anterior" aplicando as migracoes REAIS com o CLI do Prisma, e entrega
// copias. Antes cada arquivo de teste reaplicava ~115 migracoes (2-4 min cada) e, com a suite inteira em paralelo, estourava o tempo. O cache e invalidado sozinho se qualquer migracao anterior mudar.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const prismaCli = path.join(root, "node_modules", "prisma", "build", "index.js");
const migDir = path.join(root, "prisma", "migrations");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const urlOf = (f) => `file:${f.replace(/\\/g, "/")}`;

// Pastas de migracao com nome MENOR que `cut` (o estado imediatamente anterior a ela).
export function migrationsBefore(cut) {
  return fs.readdirSync(migDir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name < cut).map((d) => d.name).sort();
}

function hashOf(names, schemaFile) {
  const h = crypto.createHash("sha1");
  for (const n of names) h.update(n).update(fs.readFileSync(path.join(migDir, n, "migration.sql")));
  h.update(fs.readFileSync(schemaFile)); // o schema entra para o CLI (migrate deploy nao o usa para aplicar, mas o diretorio de trabalho e o mesmo)
  return h.digest("hex").slice(0, 16);
}

// Copia a pasta de migracoes (so as `names`) + o schema atual para um projeto temporario.
export function makeProject(dir, names, extra = []) {
  const p = path.join(dir, "prisma");
  fs.mkdirSync(path.join(p, "migrations"), { recursive: true });
  fs.copyFileSync(path.join(root, "prisma", "schema.prisma"), path.join(p, "schema.prisma"));
  for (const f of fs.readdirSync(migDir, { withFileTypes: true })) if (f.isFile()) fs.copyFileSync(path.join(migDir, f.name), path.join(p, "migrations", f.name));
  for (const n of [...names, ...extra]) {
    fs.mkdirSync(path.join(p, "migrations", n), { recursive: true });
    for (const f of fs.readdirSync(path.join(migDir, n))) fs.copyFileSync(path.join(migDir, n, f), path.join(p, "migrations", n, f));
  }
  return path.join(p, "schema.prisma");
}

export function cli(args, dbFile, schema) {
  const r = spawnSync(process.execPath, [prismaCli, ...args, "--schema", schema], { cwd: root, env: { ...process.env, DATABASE_URL: urlOf(dbFile) }, encoding: "utf8", timeout: 1_800_000 });
  return { status: r.status, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

// Caminho de um banco com TODAS as migracoes anteriores a `cut` aplicadas (cacheado). Quem chama copia o arquivo antes de escrever nele.
export async function cachedPreDb(cut) {
  const names = migrationsBefore(cut);
  const key = hashOf(names, path.join(root, "prisma", "schema.prisma"));
  const base = path.join(os.tmpdir(), `alice-premig-${key}`);
  const dbFile = `${base}.db`;
  if (fs.existsSync(dbFile)) return dbFile;
  const lock = `${base}.lock`;
  let have = false;
  try { fs.mkdirSync(lock); have = true; } catch { /* outro processo esta construindo */ }
  if (have) {
    try {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), "alice-premig-work-"));
      const schema = makeProject(work, names);
      const tmpDb = `${base}.${process.pid}.tmp.db`;
      const r = cli(["migrate", "deploy"], tmpDb, schema);
      if (r.status !== 0) throw new Error(`migrate deploy do estado anterior falhou:\n${r.out.slice(-800)}`);
      fs.renameSync(tmpDb, dbFile);
      fs.rmSync(work, { recursive: true, force: true });
    } finally { try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* ok */ } }
    return dbFile;
  }
  for (let i = 0; i < 3600; i++) {
    if (fs.existsSync(dbFile)) return dbFile;
    try { if (Date.now() - fs.statSync(lock).mtimeMs > 30 * 60_000) { fs.rmSync(lock, { recursive: true, force: true }); return cachedPreDb(cut); } } catch { /* o outro terminou */ }
    await sleep(1000);
  } // ate 1 h esperando o outro processo
  throw new Error("o banco do estado anterior nao ficou pronto a tempo");
}
