// Transicao de DADOS das migracoes do link do Google, executando o SQL REAL das pastas de prisma/migrations (nao `db push`):
//   etapa 1: aplica as migracoes ate 20261018100000 num banco temporario; etapa 2: aplica 20261018110000 (que marcava como "confirmado" o link das outras clinicas);
//   etapa 3: aplica o restante (inclusive a migracao compensatoria 20261019100000) com dados no meio. Mostra que compatibilidade nao vira "validacao".
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { PrismaClient } = require(path.join(root, "node_modules", "@prisma", "client"));
const { reviewLinkState } = await import("../dist/reminders/reviewLink.js");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "alice-migr-google-"));
const dbFile = path.join(work, "t.db").replace(/\\/g, "/");
const prismaDir = path.join(work, "prisma");
fs.mkdirSync(path.join(prismaDir, "migrations"), { recursive: true });
fs.copyFileSync(path.join(root, "prisma", "schema.prisma"), path.join(prismaDir, "schema.prisma"));
fs.copyFileSync(path.join(root, "prisma", "migrations", "migration_lock.toml"), path.join(prismaDir, "migrations", "migration_lock.toml"));
const env = { ...process.env, DATABASE_URL: `file:${dbFile}` };
const deploy = () => execFileSync(process.execPath, [path.join(root, "node_modules", "prisma", "build", "index.js"), "migrate", "deploy", "--schema", path.join(prismaDir, "schema.prisma")], { cwd: work, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const all = fs.readdirSync(path.join(root, "prisma", "migrations"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const copyMigrations = (pred) => { for (const n of all) if (pred(n) && !fs.existsSync(path.join(prismaDir, "migrations", n))) { fs.mkdirSync(path.join(prismaDir, "migrations", n), { recursive: true }); fs.copyFileSync(path.join(root, "prisma", "migrations", n, "migration.sql"), path.join(prismaDir, "migrations", n, "migration.sql")); } };
const GOOGLE_OLD = "20261018110000_pesquisa_google_indicacao";
const COMPAT = "20261019100000_google_compat_sem_validacao";

const db = new PrismaClient({ datasources: { db: { url: `file:${dbFile}` } } });
test.after(async () => {
  await db.$disconnect();
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* Windows pode segurar o arquivo por um instante: e temporario */ }
});

let phoneSeq = 0;
// Insere uma clinica com SQL puro, preenchendo as colunas obrigatorias sem padrao (o cliente gerado ja conhece colunas que ainda nao existem nessa etapa).
async function insertClinic(id, name, extra = {}) {
  const info = await db.$queryRawUnsafe('PRAGMA table_info("Clinic")');
  const cols = { id, name, ...extra };
  for (const c of info) {
    if (c.name in cols || !c.notnull || c.dflt_value != null) continue;
    cols[c.name] = c.name === "whatsappPhone" ? `5511900${String(++phoneSeq).padStart(6, "0")}` : /DATETIME/i.test(c.type) ? new Date().toISOString() : /INT|BOOL/i.test(c.type) ? 0 : "x";
  }
  const names = Object.keys(cols);
  await db.$executeRawUnsafe(`INSERT INTO "Clinic" (${names.map((n) => `"${n}"`).join(",")}) VALUES (${names.map(() => "?").join(",")})`, ...names.map((n) => cols[n]));
}
// colunas listadas a cada leitura: um `SELECT *` fica com o conjunto de colunas ja preparado pela conexao e nao enxerga as colunas criadas pelas migracoes seguintes
const row = async (id) => {
  const names = (await db.$queryRawUnsafe('PRAGMA table_info("Clinic")')).map((c) => c.name);
  return (await db.$queryRawUnsafe(`SELECT ${names.map((n) => `"${n}"`).join(",")} FROM "Clinic" WHERE id = ?`, id))[0];
};
const asClinic = (r) => ({ googleReviewUrl: r.googleReviewUrl, googleReviewConfirmedAt: r.googleReviewConfirmedAt ? new Date(r.googleReviewConfirmedAt) : null, googleReviewPlace: r.googleReviewPlace, googleReviewLegacyAllowed: r.googleReviewLegacyAllowed === undefined ? undefined : !!r.googleReviewLegacyAllowed });

const LINK_LISBOA = "https://g.page/r/CVxcf78iE5IhEAE/review"; // o que a migracao de 16/10 gravou na Lisboa (nunca conferido)
const LINK_B = "https://g.page/r/CLINICAB/review";

test("etapa 1-2: com a migracao antiga aplicada, outra clinica fica 'confirmada' por uma marca que ninguem conferiu (o defeito a corrigir) e a Lisboa fica de fora", async () => {
  copyMigrations((n) => n < GOOGLE_OLD);
  deploy();
  await insertClinic("lisboa", "Lisboa Beauty Center", { googleReviewUrl: LINK_LISBOA });
  await insertClinic("outraB", "Clinica B", { googleReviewUrl: LINK_B });
  await insertClinic("semlink", "Clinica C");
  copyMigrations((n) => n === GOOGLE_OLD);
  deploy();
  const b = await row("outraB");
  assert.equal(b.googleReviewConfirmedBy, "migracao: link ja cadastrado pela clinica", "a migracao antiga atribui uma confirmacao que nao houve");
  assert.ok(b.googleReviewConfirmedAt);
  const l = await row("lisboa");
  assert.equal(l.googleReviewConfirmedAt, null, "Lisboa nunca recebeu a marca");
  assert.equal(reviewLinkState(asClinic(l)).send, false);
});

test("etapa 3: a migracao compensatoria separa compatibilidade de confirmacao, sem tocar a historia e sem mexer na Lisboa nem em quem confirmou de verdade", async () => {
  // alguem da clinica C cadastra e CONFIRMA de verdade (quem/quando/estabelecimento) entre as duas migracoes
  await db.$executeRawUnsafe(`UPDATE "Clinic" SET "googleReviewUrl" = ?, "googleReviewConfirmedAt" = ?, "googleReviewConfirmedBy" = ?, "googleReviewPlace" = ? WHERE id = 'semlink'`, "https://g.page/r/CLINICAC/review", new Date().toISOString(), "Maria (recepcao)", "Clinica C Estetica");
  const historiaAntes = fs.readFileSync(path.join(root, "prisma", "migrations", GOOGLE_OLD, "migration.sql"), "utf8");
  copyMigrations(() => true);
  deploy();
  assert.equal(fs.readFileSync(path.join(prismaDir, "migrations", GOOGLE_OLD, "migration.sql"), "utf8"), historiaAntes, "a migracao antiga nao foi reescrita");
  assert.ok(all.includes(COMPAT));

  const b = await row("outraB");
  assert.equal(b.googleReviewConfirmedAt, null, "a confirmacao atribuida sem evidencia foi retirada");
  assert.equal(b.googleReviewConfirmedBy, null);
  assert.equal(!!b.googleReviewLegacyAllowed, true, "o envio continua por COMPATIBILIDADE");
  const sb = reviewLinkState(asClinic(b));
  assert.deepEqual({ send: sb.send, basis: sb.basis, placeChecked: sb.placeChecked }, { send: true, basis: "compatibilidade", placeChecked: false }, "envia como antes, mas nao diz que foi validado");

  const l = await row("lisboa");
  assert.equal(!!l.googleReviewLegacyAllowed, false, "a Lisboa nunca vira 'compatibilidade'");
  assert.equal(l.googleReviewUrl, LINK_LISBOA, "o link nao foi trocado nem apagado");
  assert.equal(reviewLinkState(asClinic(l)).send, false, "Lisboa: agradece sem link ate alguem confirmar o destino");

  const c = await row("semlink");
  assert.equal(c.googleReviewConfirmedBy, "Maria (recepcao)", "confirmacao humana verdadeira e preservada");
  assert.equal(!!c.googleReviewLegacyAllowed, false);
  const sc = reviewLinkState(asClinic(c));
  assert.deepEqual({ send: sc.send, basis: sc.basis, placeChecked: sc.placeChecked }, { send: true, basis: "confirmado", placeChecked: true });
});

test("a migracao compensatoria e idempotente e uma clinica criada depois nao nasce 'confirmada' nem 'compatibilidade'", async () => {
  await db.$executeRawUnsafe(await fs.promises.readFile(path.join(root, "prisma", "migrations", COMPAT, "migration.sql"), "utf8").then((s) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").filter((x) => /UPDATE/.test(x))[0]));
  await insertClinic("nova", "Clinica Nova", { googleReviewUrl: "https://g.page/r/NOVA/review" });
  const n = await row("nova");
  assert.equal(n.googleReviewConfirmedAt, null);
  assert.equal(!!n.googleReviewLegacyAllowed, false);
  assert.equal(reviewLinkState(asClinic(n)).send, false, "link novo sem confirmacao nao e enviado");
  assert.equal(!!(await row("outraB")).googleReviewLegacyAllowed, true, "rodar de novo nao desfaz a compatibilidade");
});

test("banco novo (so migracoes, sem dados) aplica todas sem erro e fica igual ao schema nas colunas do Google", async () => {
  const info = await db.$queryRawUnsafe('PRAGMA table_info("Clinic")');
  const by = Object.fromEntries(info.map((c) => [c.name, c]));
  for (const col of ["googleReviewConfirmedAt", "googleReviewConfirmedBy", "googleReviewPlace", "googleReviewLegacyAllowed"]) assert.ok(by[col], `coluna ${col} existe`);
  assert.equal(Number(by.googleReviewLegacyAllowed.notnull), 1);
  assert.match(String(by.googleReviewLegacyAllowed.dflt_value), /0|false/i);
});
