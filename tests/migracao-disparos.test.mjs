// HOTFIX 22/10/2026: a migracao 20261025100000_disparos falhava no SQLite (P3018: ADD COLUMN com default nao constante) e deixava o banco parcialmente migrado (P3009 em todo boot).
// Estes testes usam o SQL REAL pelo CLI do Prisma (migrate deploy/resolve/status/diff), nao `db push`: banco novo, banco populado no estado anterior, banco no estado parcial do incidente,
// segunda execucao do reparo, preservacao de contagens/linhas/vinculos e o comportamento do boot. Nada de WhatsApp, nada de rede; bancos temporarios; nenhum dado de producao.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pkg from "@prisma/client";

const { PrismaClient } = pkg;
const root = fileURLToPath(new URL("..", import.meta.url));
const prismaCli = path.join(root, "node_modules", "prisma", "build", "index.js");
const MIG = "20261025100000_disparos";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alice-mig-disparos-"));
const urlOf = (f) => `file:${f.replace(/\\/g, "/")}`;
const repoSchema = path.join(root, "prisma", "schema.prisma");
const { classifyMigrateFailure } = await import(pathToFileURL(path.join(root, "scripts", "migracao-erros.mjs")).href);
const rec = await import(pathToFileURL(path.join(root, "scripts", "recuperar-migracao-disparos.mjs")).href);

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temporario */ } });

function cli(args, dbFile, schema = repoSchema) {
  const r = spawnSync(process.execPath, [prismaCli, ...args, "--schema", schema], { cwd: root, env: { ...process.env, DATABASE_URL: urlOf(dbFile) }, encoding: "utf8", timeout: 240_000 });
  return { status: r.status, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

// Projeto Prisma temporario com as migracoes do repositorio SEM a do Disparos (estado "imediatamente anterior"), opcionalmente com a versao ORIGINAL (quebrada) dela.
function projectDir(name, { withOriginalBroken = false } = {}) {
  const dir = path.join(tmp, name, "prisma");
  fs.mkdirSync(path.join(dir, "migrations"), { recursive: true });
  fs.copyFileSync(repoSchema, path.join(dir, "schema.prisma"));
  for (const d of fs.readdirSync(path.join(root, "prisma", "migrations"), { withFileTypes: true })) {
    if (d.isFile()) fs.copyFileSync(path.join(root, "prisma", "migrations", d.name), path.join(dir, "migrations", d.name));
    else if (d.name < MIG) {
      // (fs.cpSync derruba o Node 24 no Windows: copia manual)
      fs.mkdirSync(path.join(dir, "migrations", d.name));
      for (const f of fs.readdirSync(path.join(root, "prisma", "migrations", d.name))) fs.copyFileSync(path.join(root, "prisma", "migrations", d.name, f), path.join(dir, "migrations", d.name, f));
    }
  }
  if (withOriginalBroken) {
    fs.mkdirSync(path.join(dir, "migrations", MIG));
    fs.copyFileSync(path.join(root, "tests", "fixtures", "migracao-disparos-original-quebrada.sql"), path.join(dir, "migrations", MIG, "migration.sql"));
  }
  return path.join(dir, "schema.prisma");
}

const open = (file) => new PrismaClient({ datasources: { db: { url: `${urlOf(file)}?connection_limit=1` } } });
let n = 0;
// Insere uma linha preenchendo as colunas NOT NULL sem default (o esquema real decide quais sao).
async function insert(db, table, values) {
  const info = await db.$queryRawUnsafe(`PRAGMA table_info("${table}")`);
  const row = { ...values };
  for (const c of info) {
    if (c.name in row || Number(c.notnull) !== 1 || c.dflt_value != null) continue;
    const t = String(c.type).toUpperCase();
    row[c.name] = t === "TEXT" ? `${table}-${c.name}-${++n}` : t === "DATETIME" ? new Date().toISOString() : 0;
  }
  const cols = Object.keys(row);
  await db.$executeRawUnsafe(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`, ...Object.values(row));
}

// Banco "producao antes do deploy": migracoes ate a anterior + dados reais (clinica, pacientes, regras, historico de envios).
const preSchema = projectDir("pre");
const templateDb = path.join(tmp, "template-pre.db");
const emptyDb = path.join(tmp, "template-vazio.db"); // sequencia completa SEM a do Disparos e SEM dados (base do teste de banco novo)
const SENT = ["2026-09-01 10:05:00", "2026-10-02 11:00:00", "2026-10-20 10:07:30"];
test("preparo: banco no estado imediatamente anterior, populado", async () => {
  const r = cli(["migrate", "deploy"], templateDb, preSchema);
  assert.equal(r.status, 0, r.out.slice(-600));
  fs.copyFileSync(templateDb, emptyDb);
  const db = open(templateDb);
  try {
    await insert(db, "Clinic", { id: "c1", name: "Clinica Teste", whatsappPhone: "5511900000001" });
    for (let i = 1; i <= 3; i++) await insert(db, "Patient", { id: `p${i}`, clinicId: "c1", phone: `551190000000${i}`, name: `Pessoa ${i}` });
    await insert(db, "BirthdayRule", { id: "br1", clinicId: "c1", name: "Parabens", message: "Feliz aniversario" });
    await insert(db, "BirthdaySent", { id: "bs1", patientId: "p1", ruleId: "br1", year: 2026, sentAt: SENT[0], state: "legacy" });
    await insert(db, "BirthdaySent", { id: "bs2", patientId: "p2", ruleId: "br1", year: 2026, sentAt: SENT[1], state: "sent" });
    await insert(db, "BirthdaySent", { id: "bs3", patientId: "p3", ruleId: "br1", year: 2025, sentAt: SENT[2], state: "unconfirmed" });
    await insert(db, "ReminderRule", { id: "rr1", clinicId: "c1", message: "Oi", hoursBefore: 24 });
    await insert(db, "Procedure", { id: "pr1", clinicId: "c1", name: "Lavieen", durationMin: 30 });
    await insert(db, "Appointment", { id: "ap1", clinicId: "c1", patientId: "p1", procedureId: "pr1", scheduledAt: "2026-10-23 14:00:00" });
    for (let i = 1; i <= 2; i++) await insert(db, "ReminderDispatch", { id: `rd${i}`, clinicId: "c1", bookingKey: `appt:ap${i}`, appointmentId: "ap1", patientId: "p1", ruleId: "rr1", kind: i === 1 ? "dia_seguinte" : "do_dia", startsAt: "2026-10-23 14:00:00", sendDay: "2026-10-22", state: i === 1 ? "sent" : "failed" });
    assert.equal(Number((await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "BirthdaySent"'))[0].n), 3);
  } finally { await db.$disconnect(); }
});
const canBackup = rec.storageKind(tmp) !== "raiz_do_container"; // so ha como provar volume persistente fora da raiz do container (no Windows/dev a prova e "desconhecido" e o teste usa a opcao explicita)
const copyOf = (name) => { const f = path.join(tmp, `${name}.db`); fs.copyFileSync(templateDb, f); return f; };

async function snapshot(file) {
  const db = open(file);
  try {
    const q = (s) => db.$queryRawUnsafe(s);
    return {
      schema: (await q("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")).map((r) => `${r.type}:${r.name}:${r.sql}`),
      mig: (await q("SELECT migration_name, finished_at IS NOT NULL AS fin, rolled_back_at IS NOT NULL AS rb FROM _prisma_migrations ORDER BY migration_name")).map((r) => `${r.migration_name}:${r.fin}:${r.rb}`),
      bs: await q('SELECT * FROM "BirthdaySent" ORDER BY id'),
      rd: await q('SELECT id, state, kind, sendDay FROM "ReminderDispatch" ORDER BY id'),
    };
  } finally { await db.$disconnect(); }
}
const partialSchema = projectDir("partial", { withOriginalBroken: true });
// Reproduz o incidente: aplica a versao ORIGINAL (quebrada) sobre o banco populado.
function makePartial(name) {
  const f = copyOf(name);
  const r = cli(["migrate", "deploy"], f, partialSchema);
  return { file: f, deploy: r };
}

test("CAUSA: a versao original falha com P3018 em ALTER TABLE BirthdaySent ADD COLUMN updatedAt ... DEFAULT CURRENT_TIMESTAMP; o retry cai em P3009; ambos sao DETERMINISTICOS", async () => {
  const sql = fs.readFileSync(path.join(root, "tests", "fixtures", "migracao-disparos-original-quebrada.sql"), "utf8");
  assert.match(sql, /ALTER TABLE "BirthdaySent" ADD COLUMN "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP/);
  const { file, deploy } = makePartial("causa");
  assert.notEqual(deploy.status, 0);
  assert.match(deploy.out, /P3018/);
  assert.match(deploy.out, /non-constant default/i);
  assert.equal(classifyMigrateFailure(deploy.out), "deterministica");
  const again = cli(["migrate", "deploy"], file, partialSchema);
  assert.notEqual(again.status, 0);
  assert.match(again.out, /P3009/);
  assert.equal(classifyMigrateFailure(again.out), "deterministica");
  // o estado parcial e o descrito: colunas anteriores aplicadas, a da falha e as tabelas novas ausentes, migracao registrada como falhada
  const db = open(file);
  try {
    const bs = (await db.$queryRawUnsafe('PRAGMA table_info("BirthdaySent")')).map((c) => c.name);
    assert.ok(bs.includes("attempts") && bs.includes("nextAttemptAt") && !bs.includes("updatedAt"));
    const rd = (await db.$queryRawUnsafe('PRAGMA table_info("ReminderDispatch")')).map((c) => c.name);
    assert.ok(rd.includes("providerId") && rd.includes("extendedReason"));
    const tables = (await db.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table'")).map((r) => r.name);
    assert.ok(!tables.includes("DispatchRun") && !tables.includes("PhoneResolution"));
    const row = (await db.$queryRawUnsafe(`SELECT finished_at, rolled_back_at FROM _prisma_migrations WHERE migration_name='${MIG}'`))[0];
    assert.equal(row.finished_at, null);
  } finally { await db.$disconnect(); }
});

test("classificador do boot: P3009/P3018/SQL invalido = deterministica; banco ocupado/indisponivel = transitoria; resto = desconhecida", () => {
  for (const t of ["Error: P3009\nmigrate found failed migrations in the target database", "Error: P3018 A migration failed to apply", "Cannot add a column with non-constant default", "duplicate column name: providerId", "near \"x\": syntax error"]) assert.equal(classifyMigrateFailure(t), "deterministica", t);
  for (const t of ["Error: database is locked", "SQLITE_BUSY: database is locked", "P1001: Can't reach database server", "Socket timeout (the database failed to respond to a query within the configured timeout)", "connect ETIMEDOUT"]) assert.equal(classifyMigrateFailure(t), "transitoria", t);
  assert.equal(classifyMigrateFailure("algo estranho"), "desconhecida");
  assert.equal(classifyMigrateFailure(""), "desconhecida");
  // deterministica vence quando as duas aparecem (nao fica repetindo um erro que nao muda)
  assert.equal(classifyMigrateFailure("P3009 ... database is locked"), "deterministica");
});

// Tabelas/objetos que o Prisma cita no diff (uma linha por item: "[*] Redefined table `Clinic`", "[+] Added tables", etc.)
const diffMentions = (stdout) => [...String(stdout).matchAll(/`(\w+)`/g)].map((m) => m[1]);
const DISPAROS_OBJECTS = ["BirthdaySent", "ReminderDispatch", "PhoneResolution", "DispatchPolicy", "DispatchRun", "DispatchRunItem"];

test("BANCO NOVO: toda a sequencia de migracoes (as anteriores + a versao corrigida) aplica; o schema final nao diverge do schema.prisma em NADA do Disparos", () => {
  const f = path.join(tmp, "novo.db");
  fs.copyFileSync(emptyDb, f); // as migracoes anteriores acabaram de ser aplicadas do zero no preparo; aqui entra a do Disparos
  const r = cli(["migrate", "deploy"], f);
  assert.equal(r.status, 0, r.out.slice(-800));
  const diff = spawnSync(process.execPath, [prismaCli, "migrate", "diff", "--from-url", urlOf(f), "--to-schema-datamodel", repoSchema, "--script"], { cwd: root, env: { ...process.env, DATABASE_URL: urlOf(f) }, encoding: "utf8" });
  // (qualquer divergencia ANTERIOR a esta migracao, como a reconstrucao de "Clinic" que ja existia, nao e do Disparos: aqui importa que o Disparos nao deixe nenhuma)
  const hit = diffMentions(diff.stdout).filter((t) => DISPAROS_OBJECTS.includes(t));
  assert.deepEqual(hit, [], `divergencia em objetos do Disparos:\n${diff.stdout}`);
  const st = cli(["migrate", "status"], f);
  assert.equal(st.status, 0, st.out);
  assert.match(st.out, /up to date/i);
});

test("ESTADO ANTERIOR POPULADO: a migracao corrigida aplica preservando TODAS as linhas; updatedAt = sentAt (nunca data fixa); defaults e indice unico funcionam", async () => {
  const f = copyOf("anterior");
  const before = await snapshot(f);
  const r = cli(["migrate", "deploy"], f);
  assert.equal(r.status, 0, r.out.slice(-800));
  const after = await snapshot(f);
  assert.equal(after.bs.length, 3);
  assert.deepEqual(after.bs.map((x) => x.id), ["bs1", "bs2", "bs3"]);
  for (const b of before.bs) {
    const a = after.bs.find((x) => x.id === b.id);
    assert.equal(a.patientId, b.patientId); assert.equal(a.ruleId, b.ruleId); assert.equal(Number(a.year), Number(b.year)); assert.equal(a.state, b.state);
    assert.equal(String(a.sentAt), String(b.sentAt));
    assert.equal(String(a.updatedAt), String(b.sentAt), "updatedAt das linhas antigas = sentAt (ultima alteracao conhecida)");
    assert.equal(Number(a.attempts), 0, "registro anterior ao controle por tentativa");
    assert.equal(a.providerId, null);
  }
  assert.deepEqual(after.rd, before.rd, "historico de ReminderDispatch intacto");
  const db = open(f);
  try {
    // novo default dinamico funciona para linhas futuras
    await insert(db, "Patient", { id: "p9", clinicId: "c1", phone: "5511900000009", name: "Nova" });
    await db.$executeRawUnsafe(`INSERT INTO "BirthdaySent" ("id","patientId","ruleId","year") VALUES ('bs9','p9','br1',2026)`);
    const novo = (await db.$queryRawUnsafe(`SELECT updatedAt, sentAt, state, attempts FROM "BirthdaySent" WHERE id='bs9'`))[0];
    assert.ok(novo.updatedAt && novo.sentAt && novo.state === "legacy" && Number(novo.attempts) === 0);
    // idempotencia por pessoa/regra/ano preservada
    await assert.rejects(() => db.$executeRawUnsafe(`INSERT INTO "BirthdaySent" ("id","patientId","ruleId","year") VALUES ('bsx','p9','br1',2026)`));
    // chaves estrangeiras preservadas
    await db.$executeRawUnsafe("PRAGMA foreign_keys=ON");
    await assert.rejects(() => db.$executeRawUnsafe(`INSERT INTO "BirthdaySent" ("id","patientId","ruleId","year") VALUES ('bsy','inexistente','br1',2030)`));
    assert.equal((await db.$queryRawUnsafe("PRAGMA integrity_check"))[0].integrity_check, "ok");
    assert.equal((await db.$queryRawUnsafe("PRAGMA foreign_key_check")).length, 0);
  } finally { await db.$disconnect(); }
});

test("RECUPERACAO: diagnostico NAO escreve; aplicar faz backup verificado, completa so o que falta numa transacao, valida tudo; segunda execucao nao altera nada; resolve --applied e status ficam limpos", { skip: !canBackup }, async () => {
  const { file } = makePartial("recup");
  const env = { DATABASE_URL: urlOf(file) };
  const logs = [];
  const log = (s) => logs.push(s);

  // ---- 1) diagnostico (padrao): somente leitura
  const snap0 = await snapshot(file);
  const d = await rec.run([], env, log);
  assert.equal(d.state, "falhada_parcial");
  const text = logs.join("\n");
  assert.match(text, /ReminderDispatch|BirthdaySent\.updatedAt: coluna ausente/);
  assert.match(text, /tabela DispatchRun: ausente/);
  assert.ok(!/ReminderDispatch\.providerId: coluna ausente/.test(text), "o que JA foi aplicado nao e listado como faltante");
  assert.deepEqual(await snapshot(file), snap0, "o diagnostico nao alterou NADA (schema, migracoes, linhas)");

  // ---- 2) aplicar exige backup em armazenamento provadamente persistente (sem isso, interrompe e nao escreve)
  if (rec.storageKind(path.join(tmp, "backups")) === "desconhecido") {
    await assert.rejects(() => rec.run(["--apply", "--backup-dir", path.join(tmp, "backups")], env, log), /nao consegui provar.*volume persistente/i);
    assert.deepEqual(await snapshot(file), snap0, "sem backup aceito, nada foi escrito");
  }
  assert.equal(rec.storageKind("/app/backups", "36 25 0:30 / / rw - overlay overlay rw\n"), "raiz_do_container");
  assert.equal(rec.storageKind("/app/data/backups-hotfix", "36 25 0:30 / / rw - overlay overlay rw\n80 36 8:1 / /app/data rw - ext4 /dev/sda1 rw\n"), "volume");
  await assert.rejects(() => rec.run(["--apply", "--backup-dir", "/app/backups"], env, log).catch((e) => { throw e; }), /RAIZ do container|nao consegui provar/i);

  // ---- 3) aplicar
  const backupDir = path.join(tmp, "backups-hotfix");
  const logs2 = [];
  const res = await rec.run(["--apply", "--backup-dir", backupDir, "--aceito-armazenamento-desconhecido"], env, (s) => logs2.push(s));
  assert.equal(res.validation.ok, true, JSON.stringify(res.validation));
  assert.ok(res.applied.length >= 8, `passos aplicados: ${res.applied.length}`);
  assert.ok(res.applied.every((a) => !/ReminderDispatch: adicionar coluna/.test(a)), "colunas de ReminderDispatch ja existiam: nao reaplicadas");
  assert.ok(fs.existsSync(res.backup.file));
  const bdb = open(res.backup.file);
  try {
    assert.equal((await bdb.$queryRawUnsafe("PRAGMA integrity_check"))[0].integrity_check, "ok");
    assert.equal(Number((await bdb.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "BirthdaySent"'))[0].n), 3, "o backup tem o estado ANTERIOR ao reparo");
    const cols = (await bdb.$queryRawUnsafe('PRAGMA table_info("BirthdaySent")')).map((c) => c.name);
    assert.ok(!cols.includes("updatedAt"));
  } finally { await bdb.$disconnect(); }
  assert.match(res.next.join(" "), new RegExp(`migrate resolve --applied ${MIG}`));

  const after = await snapshot(file);
  assert.deepEqual(after.rd, snap0.rd, "historico de ReminderDispatch intacto");
  assert.equal(after.bs.length, 3);
  for (const b of snap0.bs) {
    const a = after.bs.find((x) => x.id === b.id);
    assert.equal(String(a.sentAt), String(b.sentAt)); assert.equal(a.state, b.state); assert.equal(String(a.updatedAt), String(b.sentAt));
  }
  // a migracao continua registrada como FALHADA ate o passo explicito (o script nao escreve em _prisma_migrations)
  assert.deepEqual(after.mig, snap0.mig);

  // ---- 4) segunda execucao: nada a fazer no schema, nada muda
  const logs3 = [];
  const again = await rec.run(["--apply", "--backup-dir", backupDir, "--aceito-armazenamento-desconhecido"], env, (s) => logs3.push(s));
  assert.equal(again.state, "falhada_completa");
  assert.equal(again.applied.length, 0);
  assert.equal(again.validation.ok, true);
  assert.deepEqual(await snapshot(file), after, "segunda execucao nao alterou nada");

  // ---- 5) marcar como aplicada (agora que a validacao passou) e conferir o Prisma
  const resolve = cli(["migrate", "resolve", "--applied", MIG], file);
  assert.equal(resolve.status, 0, resolve.out);
  // (a migracao seguinte, 20261026100000, ainda nao foi aplicada neste banco: e o que o boot normal aplica depois)
  const status = cli(["migrate", "status"], file);
  assert.match(status.out, /20261026100000_nao_pacientes_campanhas_datas/, "so a migracao seguinte fica pendente");
  assert.ok(!/20261025100000_disparos/.test(status.out.split("have not yet been applied")[1] ?? ""), "a do Disparos consta como aplicada");
  const dep = cli(["migrate", "deploy"], file);
  assert.equal(dep.status, 0, dep.out);
  const status2 = cli(["migrate", "status"], file);
  assert.equal(status2.status, 0, status2.out);
  assert.match(status2.out, /up to date/i);
  const dep2 = cli(["migrate", "deploy"], file);
  assert.equal(dep2.status, 0, dep2.out);
  assert.match(dep2.out, /No pending migrations/i);
  const final = await rec.run([], env, () => {});
  assert.equal(final.state, "aplicada_integra");

  // ---- 6) nenhum objeto do Disparos diverge do schema.prisma no banco recuperado (a divergencia "Clinic" e anterior e alheia a esta migracao)
  const diff = spawnSync(process.execPath, [prismaCli, "migrate", "diff", "--from-url", urlOf(file), "--to-schema-datamodel", repoSchema, "--script"], { cwd: root, env: { ...process.env, DATABASE_URL: urlOf(file) }, encoding: "utf8" });
  assert.deepEqual(diffMentions(diff.stdout).filter((t) => DISPAROS_OBJECTS.includes(t)), [], `banco recuperado diverge do schema.prisma em objetos do Disparos:
${diff.stdout}`);

  // ---- 7) o cliente Prisma do app (gerado do schema novo) le e grava os dados antigos e novos
  const app = new PrismaClient({ datasources: { db: { url: `${urlOf(file)}?connection_limit=1` } } });
  try {
    const rows = await app.birthdaySent.findMany({ orderBy: { id: "asc" } });
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.updatedAt instanceof Date && r.attempts === 0));
    const created = await app.birthdaySent.create({ data: { patientId: "p2", ruleId: "br1", year: 2027, state: "reserved", attempts: 1 } });
    assert.ok(created.updatedAt instanceof Date);
    await app.dispatchRun.create({ data: { clinicId: "c1", note: "teste" } });
    const rd = await app.reminderDispatch.update({ where: { id: "rd1" }, data: { providerId: "owner:ABC123", deliveryState: "accepted" } });
    assert.equal(rd.providerId, "owner:ABC123");
  } finally { await app.$disconnect(); }
});

test("ESTADO INESPERADO interrompe sem escrever: migracao marcada rolled-back com SQL parcial, e banco sem registro mas com objetos da migracao", { skip: !canBackup }, async () => {
  const { file } = makePartial("inesperado1");
  const db = open(file);
  try { await db.$executeRawUnsafe(`UPDATE _prisma_migrations SET rolled_back_at = CURRENT_TIMESTAMP WHERE migration_name='${MIG}'`); } finally { await db.$disconnect(); }
  const s1 = await snapshot(file);
  const r1 = await rec.run(["--apply", "--backup-dir", path.join(tmp, "b1"), "--aceito-armazenamento-desconhecido"], { DATABASE_URL: urlOf(file) }, () => {});
  assert.equal(r1.state, "inesperado");
  assert.equal(r1.backup, null);
  assert.deepEqual(await snapshot(file), s1, "nada escrito");
  assert.ok(!fs.existsSync(path.join(tmp, "b1")), "nem backup foi criado");

  const { file: f2 } = makePartial("inesperado2");
  const db2 = open(f2);
  try { await db2.$executeRawUnsafe(`DELETE FROM _prisma_migrations WHERE migration_name='${MIG}'`); } finally { await db2.$disconnect(); }
  const r2 = await rec.run([], { DATABASE_URL: urlOf(f2) }, () => {});
  assert.equal(r2.state, "inesperado");
  const f3 = copyOf("naoiniciada");
  const r3 = await rec.run(["--apply"], { DATABASE_URL: urlOf(f3) }, () => {});
  assert.equal(r3.state, "nao_iniciada");
  assert.equal(r3.backup, null);
});

test("transacao tudo-ou-nada: se um passo do reparo falha no FIM do plano, NADA fica aplicado (nem a reconstrucao de BirthdaySent, nem as tabelas novas)", { skip: !canBackup }, async () => {
  const { file } = makePartial("atomico");
  // um objeto com o nome de um indice esperado faz o ultimo CREATE INDEX falhar (nome de indice e tabela dividem o mesmo espaco no SQLite)
  const db = open(file);
  try { await db.$executeRawUnsafe('CREATE TABLE "DispatchRunItem_runId_state_idx" ("x" TEXT)'); } finally { await db.$disconnect(); }
  const s = await snapshot(file);
  await assert.rejects(() => rec.run(["--apply", "--backup-dir", path.join(tmp, "b-atomico"), "--aceito-armazenamento-desconhecido"], { DATABASE_URL: urlOf(file) }, () => {}));
  assert.deepEqual(await snapshot(file), s, "o banco ficou exatamente como estava (rollback completo)");
  const db2 = open(file);
  try { assert.equal(Number((await db2.$queryRawUnsafe("PRAGMA foreign_keys"))[0].foreign_keys) >= 0, true); } finally { await db2.$disconnect(); }
});

test("BOOT: migracao falhada = encerra NA HORA (sem retry de 15x e sem iniciar o servidor) com a instrucao de recuperacao; modo de recuperacao mantem o container vivo sem migrar", async () => {
  const { file } = makePartial("boot");
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["scripts/start.mjs"], { cwd: root, env: { ...process.env, DATABASE_URL: urlOf(file), PORT: "0" }, encoding: "utf8", timeout: 60_000 });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 1, out);
  assert.ok(Date.now() - t0 < 30_000, "sem laco de tentativas");
  assert.match(out, /FALHADA/);
  assert.match(out, /recuperar-migracao-disparos\.mjs/);
  assert.ok(!/tentativa 2\//.test(out), "nao repetiu");
  assert.ok(!/Alice rodando na porta/.test(out), "o servidor NAO iniciou sobre schema incompleto");

  // falha deterministica SEM registro de falhada (objetos da migracao no banco, mas sem a linha): o 'migrate deploy' falha uma vez e o boot desiste, sem repetir
  const f2 = copyOf("boot2");
  const db = open(f2);
  try { await db.$executeRawUnsafe('ALTER TABLE "ReminderDispatch" ADD COLUMN "destination" TEXT'); } finally { await db.$disconnect(); }
  const t1 = Date.now();
  const r2 = spawnSync(process.execPath, ["scripts/start.mjs"], { cwd: root, env: { ...process.env, DATABASE_URL: urlOf(f2), PORT: "0" }, encoding: "utf8", timeout: 120_000 });
  const out2 = `${r2.stdout}\n${r2.stderr}`;
  assert.equal(r2.status, 1, out2);
  assert.match(out2, /DETERMINISTICA/);
  assert.ok(!/tentativa 2\//.test(out2) && Date.now() - t1 < 100_000);
  assert.ok(!/Alice rodando na porta/.test(out2));

  // modo de recuperacao: nao migra, nao inicia o servidor, continua vivo
  const child = spawn(process.execPath, ["scripts/start.mjs"], { cwd: root, env: { ...process.env, DATABASE_URL: urlOf(file), ALICE_MODO_RECUPERACAO: "1", PORT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  let buf = "";
  child.stdout.on("data", (d) => (buf += d));
  child.stderr.on("data", (d) => (buf += d));
  for (let i = 0; i < 160 && !/ouvindo na porta/.test(buf) && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 250)); // espera o servidor de /health abrir
  await new Promise((r) => setTimeout(r, 1500)); // e confirma que NAO saiu logo depois
  const alive = child.exitCode === null;
  const porta = /ouvindo na porta ([0-9]+)/.exec(buf)?.[1];
  let health = null;
  if (porta) { try { health = await (await fetch("http://127.0.0.1:" + porta + "/health")).json(); } catch { /* abaixo */ } }
  child.kill();
  assert.ok(alive, "container em modo de recuperacao deve continuar vivo");
  assert.equal(health?.modo, "recuperacao", "o HEALTHCHECK do container passa (200) e diz que e o modo de recuperacao: o Swarm nao reinicia o container no meio do reparo");
  assert.match(buf, /ALICE_MODO_RECUPERACAO=1/);
  assert.ok(!/Alice rodando na porta/.test(buf));
  assert.ok(!/migrate deploy/.test(buf.replace(/Repetir 'migrate deploy'[^\n]*/g, "")), "nao tentou migrar");
});

test("MODO DE RECUPERACAO SEM CONSOLE: o container imprime o diagnostico no log; com ALICE_RECUPERACAO_APLICAR=1 aplica, valida e so entao marca a migracao como aplicada", { skip: !canBackup }, async () => {
  const { file } = makePartial("semconsole");
  const before = await snapshot(file);
  const run1 = spawn(process.execPath, ["scripts/start.mjs"], { cwd: root, env: { ...process.env, DATABASE_URL: urlOf(file), ALICE_MODO_RECUPERACAO: "1", PORT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  let b1 = "";
  run1.stdout.on("data", (d) => (b1 += d)); run1.stderr.on("data", (d) => (b1 += d));
  for (let i = 0; i < 80 && !/Plano|falhada_parcial/.test(b1); i++) await new Promise((r) => setTimeout(r, 250));
  await new Promise((r) => setTimeout(r, 1500));
  run1.kill();
  assert.match(b1, /Estado: falhada_parcial/);
  assert.ok(b1.includes("diagnostico (somente leitura)"), b1.slice(-400));
  assert.deepEqual(await snapshot(file), before, "sem ALICE_RECUPERACAO_APLICAR nada e escrito");

  const run2 = spawn(process.execPath, ["scripts/start.mjs"], { cwd: root, env: { ...process.env, DATABASE_URL: urlOf(file), ALICE_MODO_RECUPERACAO: "1", ALICE_RECUPERACAO_APLICAR: "1", ALICE_RECUPERACAO_ACEITA_ARMAZENAMENTO_DESCONHECIDO: "1", PORT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  let b2 = "";
  run2.stdout.on("data", (d) => (b2 += d)); run2.stderr.on("data", (d) => (b2 += d));
  for (let i = 0; i < 480 && !/CONCLUIDO|NAO remova|nada foi marcado|ERRO:/.test(b2); i++) await new Promise((r) => setTimeout(r, 250));
  run2.kill();
  assert.match(b2, /VALIDACAO OK/, b2.slice(-1500));
  assert.match(b2, /CONCLUIDO/, b2.slice(-1500));
  const st = cli(["migrate", "status"], file);
  assert.match(st.out, /20261026100000_nao_pacientes_campanhas_datas/, "so a migracao seguinte fica pendente (o boot normal a aplica)");
  assert.ok(!/20261025100000_disparos/.test(st.out.split("have not yet been applied")[1] ?? ""));
  assert.equal(cli(["migrate", "deploy"], file).status, 0);
  assert.match(cli(["migrate", "status"], file).out, /up to date/i);
  const back = fs.readdirSync(path.join(path.dirname(file), "backups-hotfix"));
  assert.ok(back.some((n) => /^prod-antes-.*.db$/.test(n)), "backup criado antes de escrever");
});
