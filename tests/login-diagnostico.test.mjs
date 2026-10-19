// Login do painel: diagnostico de "nao consigo entrar" (Laleblu, 16/10/2026) com banco de verdade e o apiRouter real.
// Toda tentativa que falha fica registrada com o MOTIVO provavel (nunca a senha) e o admin ve no modal "Acesso do cliente".
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dbFile = path.join(os.tmpdir(), `alice-login-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.SESSION_SECRET ??= "y".repeat(40);
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const { prisma } = await import("../dist/db/client.js");
const { apiRouter } = await import("../dist/api/routes.js");
const { hashPassword } = await import("../dist/api/passwords.js");
const { default: express } = await import("express");

const clinic = await prisma.clinic.create({ data: { name: "Laleblu Teste", whatsappPhone: "5511900000077" } });
const SENHA = "laleblu12345";
const staff = await prisma.staffUser.create({
  data: { clinicId: clinic.id, name: "Laleblu", username: "laleblu@aliceconversa.com", passwordHash: hashPassword(SENHA), passwordChangedAt: new Date("2026-10-16T19:49:00Z"), role: "client" },
});

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.staff = req.get("x-admin") ? { role: "admin" } : null; next(); });
app.use("/api", apiRouter);
const server = http.createServer(app).listen(0);
const port = server.address().port;
const base = "http://127.0.0.1:" + port + "/api";
const login = (username, password) =>
  fetch(base + "/staff/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/130 Safari/537" },
    body: JSON.stringify({ username, password }),
  });
const diag = async () => (await fetch(base + "/clinics/" + clinic.id + "/login-diagnostics", { headers: { "x-admin": "1" } })).json();
const lastFailure = (where) => prisma.loginFailure.findFirst({ where, orderBy: { createdAt: "desc" } });

test.after(async () => {
  server.close();
  await (await import("../dist/jobs/background.js")).drainBackground(); // tarefas em segundo plano terminam ANTES de o banco temporario ser apagado
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* arquivo temporario */ } }
});

test("senha certa entra (e e-mail com maiusculas/espaco tambem)", async () => {
  assert.equal((await login("laleblu@aliceconversa.com", SENHA)).status, 200);
  assert.equal((await login("  Laleblu@AliceConversa.com ", SENHA)).status, 200);
});

test("senha com espaco sobrando (copiar/colar) entra", async () => {
  assert.equal((await login("laleblu@aliceconversa.com", " " + SENHA + " ")).status, 200);
  assert.equal((await login("laleblu@aliceconversa.com", SENHA + "\n")).status, 200);
});

test("senha errada: 401 igual pra quem tentou, e o motivo provavel fica registrado (sem a senha)", async () => {
  const r = await login("laleblu@aliceconversa.com", "laleblu1234");
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { error: "Usuario ou senha invalidos" });
  const f1 = await lastFailure({ username: "laleblu@aliceconversa.com" });
  assert.equal(f1.reason, "senha_incorreta");
  assert.equal(f1.staffId, staff.id);
  assert.equal(f1.clinicId, clinic.id);
  assert.match(f1.hint, /senha diferente da cadastrada \(11 caracteres digitados\); senha trocada em 2026-10-16 19:49 UTC/);
  assert.match(f1.userAgent, /Chrome/);
});

test("dica de erro de digitacao: maiuscula/minuscula trocada (nao aceita, mas o admin descobre)", async () => {
  assert.equal((await login("laleblu@aliceconversa.com", "Laleblu12345")).status, 401);
  assert.match((await lastFailure({ username: "laleblu@aliceconversa.com" })).hint, /1a letra em maiuscula\/minuscula trocada/);
  assert.equal((await login("laleblu@aliceconversa.com", "LALEBLU12345")).status, 401);
  assert.match((await lastFailure({ username: "laleblu@aliceconversa.com" })).hint, /maiusculas\/minusculas trocadas/);
});

test("e-mail nao cadastrado: registra como tal (e o cliente nao descobre quais contas existem)", async () => {
  const r = await login("laleblu@aliceconversa.co", SENHA);
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { error: "Usuario ou senha invalidos" });
  const f = await lastFailure({ username: "laleblu@aliceconversa.co" });
  assert.equal(f.reason, "usuario_inexistente");
  assert.equal(f.staffId, null);
});

test("clinica inativa: 403 e registra 'conta bloqueada'", async () => {
  await prisma.clinic.update({ where: { id: clinic.id }, data: { active: false } });
  assert.equal((await login("laleblu@aliceconversa.com", SENHA)).status, 403);
  assert.equal((await lastFailure({ reason: "conta_bloqueada" })).staffId, staff.id);
  await prisma.clinic.update({ where: { id: clinic.id }, data: { active: true } });
});

test("o admin ve as contas, quando a senha foi trocada e as tentativas que falharam; so admin acessa; a senha nunca e guardada", async () => {
  const semAdmin = await fetch(base + "/clinics/" + clinic.id + "/login-diagnostics");
  assert.ok(semAdmin.status === 401 || semAdmin.status === 403);
  const d = await diag();
  assert.equal(d.accounts.length, 1);
  assert.equal(d.accounts[0].username, "laleblu@aliceconversa.com");
  assert.equal(new Date(d.accounts[0].passwordChangedAt).toISOString(), "2026-10-16T19:49:00.000Z");
  const reasons = d.failures.map((x) => x.reason);
  for (const r of ["senha_incorreta", "usuario_inexistente", "conta_bloqueada"]) assert.ok(reasons.includes(r), r);
  const tudo = JSON.stringify(d) + JSON.stringify(await prisma.loginFailure.findMany());
  assert.ok(!tudo.includes(SENHA), "a senha certa nunca vai para o registro");
  assert.ok(!tudo.includes("laleblu1234\""), "nem a senha errada que foi digitada");
});

test("trocar a senha no painel registra quando (passwordChangedAt) e derruba as sessoes", () => {
  const src = fs.readFileSync(new URL("../src/api/routes.ts", import.meta.url), "utf8");
  assert.match(src, /passwordHash: hashPassword\(password\), passwordChangedAt: new Date\(\), sessionEpoch: \{ increment: 1 \}/);
});
