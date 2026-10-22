// RECUPERACAO da migracao 20261025100000_disparos num SQLite que ficou PARCIALMENTE migrado (hotfix de 22/10/2026).
//
// O que aconteceu: a versao anterior desta migracao tinha, na tabela "BirthdaySent", a instrucao
//     ALTER TABLE "BirthdaySent" ADD COLUMN "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;
// O SQLite nao aceita ADD COLUMN com default NAO constante (P3018). O Prisma NAO envolve o script do SQLite numa transacao: tudo o que veio ANTES da instrucao
// com erro ficou aplicado (as 8 colunas de ReminderDispatch, o indice e 8 colunas de BirthdaySent), tudo o que veio DEPOIS nao rodou (as 4 tabelas novas), e
// _prisma_migrations ficou com a migracao "falhada" (P3009 em todo boot seguinte). Este script:
//   1) DIAGNOSTICA (padrao, somente leitura): le _prisma_migrations, tabelas, colunas, indices e chaves estrangeiras e diz o que ja foi aplicado e o que falta;
//   2) com --apply: exige um BACKUP consistente e VERIFICADO em armazenamento persistente, completa SOMENTE o que falta, numa UNICA transacao (tudo ou nada),
//      e valida o resultado inteiro (integridade, chaves estrangeiras, forma final das tabelas, contagens e linhas) antes de dizer que terminou.
// Ele NAO escreve em _prisma_migrations: marcar a migracao como aplicada e um passo explicito DEPOIS da validacao (veja o fim da saida).
// Estrategia escolhida: A (completar o que falta). Motivo: as colunas ja aplicadas estao vazias e sao exatamente as da migracao corrigida, entao completar nao
// desfaz nada nem toca em dados; reverter exigiria DROP COLUMN (destrutivo para a tabela de historico de envios) para depois refazer o mesmo.
//
// Uso (na pasta do app, com DATABASE_URL do servico; o servico NAO pode estar escrevendo no banco - use o modo de recuperacao do container):
//   node scripts/recuperar-migracao-disparos.mjs                      # diagnostico / previa (nao escreve nada)
//   node scripts/recuperar-migracao-disparos.mjs --apply --backup-dir /app/data/backups-hotfix
// Opcoes: --aceito-armazenamento-desconhecido (so para desenvolvimento/teste: onde nao ha /proc/self/mountinfo).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "@prisma/client";

const { PrismaClient } = pkg;
export const MIGRATION = "20261025100000_disparos";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const SQL_FILE = path.join(root, "prisma", "migrations", MIGRATION, "migration.sql");

// ----------------------------------------------------------------------------------------------- forma final esperada (conferida de verdade depois do reparo)
const col = (type, { notnull = false, dflt = null, pk = false } = {}) => ({ type, notnull, dflt, pk });
const RD_NEW = { destination: col("TEXT"), providerId: col("TEXT"), attemptedAt: col("DATETIME"), deliveryState: col("TEXT"), deliveryAt: col("DATETIME"), nextAttemptAt: col("DATETIME"), deadlineAt: col("DATETIME"), extendedReason: col("TEXT") };
const BS_FULL = {
  id: col("TEXT", { notnull: true, pk: true }), state: col("TEXT", { notnull: true, dflt: "'legacy'" }), patientId: col("TEXT", { notnull: true }), ruleId: col("TEXT", { notnull: true }),
  year: col("INTEGER", { notnull: true }), sentAt: col("DATETIME", { notnull: true, dflt: "CURRENT_TIMESTAMP" }), attemptedAt: col("DATETIME"), destination: col("TEXT"), providerId: col("TEXT"),
  detail: col("TEXT"), deliveryState: col("TEXT"), deliveryAt: col("DATETIME"), attempts: col("INTEGER", { notnull: true, dflt: "0" }), nextAttemptAt: col("DATETIME"),
  updatedAt: col("DATETIME", { notnull: true, dflt: "CURRENT_TIMESTAMP" }),
};
const LATER_BS_COLUMNS = ["messageText"];
const NEW_TABLES = ["PhoneResolution", "DispatchPolicy", "DispatchRun", "DispatchRunItem"];
const EXPECTED_INDEXES = {
  ReminderDispatch_providerId_idx: { table: "ReminderDispatch", unique: false, cols: ["providerId"] },
  BirthdaySent_patientId_ruleId_year_key: { table: "BirthdaySent", unique: true, cols: ["patientId", "ruleId", "year"] },
  PhoneResolution_clinicId_originalDigits_key: { table: "PhoneResolution", unique: true, cols: ["clinicId", "originalDigits"] },
  PhoneResolution_clinicId_validatedAt_idx: { table: "PhoneResolution", unique: false, cols: ["clinicId", "validatedAt"] },
  DispatchPolicy_clinicId_kind_key: { table: "DispatchPolicy", unique: true, cols: ["clinicId", "kind"] },
  DispatchRun_clinicId_createdAt_idx: { table: "DispatchRun", unique: false, cols: ["clinicId", "createdAt"] },
  DispatchRun_state_leaseUntil_idx: { table: "DispatchRun", unique: false, cols: ["state", "leaseUntil"] },
  DispatchRunItem_activeKey_key: { table: "DispatchRunItem", unique: true, cols: ["activeKey"] },
  DispatchRunItem_runId_refKey_key: { table: "DispatchRunItem", unique: true, cols: ["runId", "refKey"] },
  DispatchRunItem_runId_state_idx: { table: "DispatchRunItem", unique: false, cols: ["runId", "state"] },
  DispatchRunItem_clinicId_state_idx: { table: "DispatchRunItem", unique: false, cols: ["clinicId", "state"] },
};
const EXPECTED_FKS = { BirthdaySent: [["patientId", "Patient", "id"], ["ruleId", "BirthdayRule", "id"]], DispatchRunItem: [["runId", "DispatchRun", "id"]] };
const COUNT_TABLES = ["Clinic", "Patient", "Appointment", "ReminderRule", "ReminderSent", "ReminderDispatch", "BirthdayRule", "BirthdaySent"];

// ----------------------------------------------------------------------------------------------- SQL da migracao (fonte unica do DDL)
export function readMigrationStatements(file = SQL_FILE) {
  const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  return text.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
}
const unq = (s) => s.replace(/^"|"$/g, "");

export function sqlitePathOf(databaseUrl) {
  if (!databaseUrl || !databaseUrl.startsWith("file:")) throw new Error("DATABASE_URL precisa ser um SQLite (file:...). Valor atual nao e.");
  const p = databaseUrl.slice(5).split("?")[0];
  return path.isAbsolute(p) || /^[A-Za-z]:/.test(p) ? p : path.resolve(root, "prisma", p);
}

export function storageKind(dir, mountinfo) {
  let info = mountinfo;
  if (info === undefined) { try { info = fs.readFileSync("/proc/self/mountinfo", "utf8"); } catch { return "desconhecido"; } }
  const target = dir.startsWith("/") ? path.posix.normalize(dir) : path.resolve(dir).replace(/\\/g, "/");
  let best = "";
  for (const line of info.split("\n")) {
    const mp = line.split(" ")[4];
    if (mp && (target === mp || target.startsWith(mp.endsWith("/") ? mp : mp + "/")) && mp.length > best.length) best = mp;
  }
  if (!best) return "desconhecido";
  return best === "/" ? "raiz_do_container" : "volume";
}

// ----------------------------------------------------------------------------------------------- inspecao do banco
async function inspect(db) {
  const q = (sql) => db.$queryRawUnsafe(sql);
  const out = { migration: null, otherFailed: [], tables: {}, indexes: {}, fks: {}, counts: {} };
  let hasMig = true;
  try { await q('SELECT 1 FROM "_prisma_migrations" LIMIT 1'); } catch { hasMig = false; }
  out.hasMigrationsTable = hasMig;
  if (hasMig) {
    const rows = await q(`SELECT migration_name, started_at, finished_at, rolled_back_at, applied_steps_count, logs FROM "_prisma_migrations" WHERE migration_name = '${MIGRATION}' ORDER BY started_at`);
    out.migrationRows = rows.map((r) => ({ name: r.migration_name, startedAt: String(r.started_at), finishedAt: r.finished_at ? String(r.finished_at) : null, rolledBackAt: r.rolled_back_at ? String(r.rolled_back_at) : null, steps: Number(r.applied_steps_count), logs: r.logs ? String(r.logs).slice(0, 240) : null }));
    out.migration = out.migrationRows.at(-1) ?? null;
    const failed = await q(`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL AND migration_name <> '${MIGRATION}'`);
    out.otherFailed = failed.map((r) => r.migration_name);
  }
  const names = (await q(`SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`));
  const tableNames = names.filter((r) => r.type === "table").map((r) => r.name);
  for (const t of ["ReminderDispatch", "BirthdaySent", ...NEW_TABLES]) {
    if (!tableNames.includes(t)) { out.tables[t] = null; continue; }
    const info = await q(`PRAGMA table_info("${t}")`);
    out.tables[t] = Object.fromEntries(info.map((c) => [c.name, { type: String(c.type).toUpperCase(), notnull: Number(c.notnull) === 1, dflt: c.dflt_value == null ? null : String(c.dflt_value), pk: Number(c.pk) > 0 }]));
    const fk = await q(`PRAGMA foreign_key_list("${t}")`);
    out.fks[t] = fk.map((f) => [f.from, f.table, f.to]);
  }
  for (const [name] of Object.entries(EXPECTED_INDEXES)) {
    const found = names.find((r) => r.type === "index" && r.name === name);
    if (!found) { out.indexes[name] = null; continue; }
    const info = await q(`PRAGMA index_info("${name}")`);
    const meta = (await q(`PRAGMA index_list("${EXPECTED_INDEXES[name].table}")`)).find((i) => i.name === name);
    out.indexes[name] = { cols: info.sort((a, b) => Number(a.seqno) - Number(b.seqno)).map((i) => i.name), unique: Number(meta?.unique) === 1 };
  }
  for (const t of COUNT_TABLES) if (tableNames.includes(t)) out.counts[t] = Number((await q(`SELECT COUNT(*) AS n FROM "${t}"`))[0].n);
  return out;
}

// Compara o que existe com o esperado; devolve a lista do que falta/difere (vazia = forma final correta).
export function compareToExpected(s) {
  const missing = [];
  const same = (a, b) => a.type === b.type && a.notnull === b.notnull && a.dflt === b.dflt && a.pk === b.pk;
  const rd = s.tables.ReminderDispatch;
  if (!rd) missing.push("tabela ReminderDispatch inexistente (banco inesperado)");
  else for (const [c, spec] of Object.entries(RD_NEW)) { if (!rd[c]) missing.push(`ReminderDispatch.${c}: coluna ausente`); else if (!same(rd[c], spec)) missing.push(`ReminderDispatch.${c}: definicao diferente`); }
  const bs = s.tables.BirthdaySent;
  if (!bs) missing.push("tabela BirthdaySent inexistente (banco inesperado)");
  else {
    for (const [c, spec] of Object.entries(BS_FULL)) { if (!bs[c]) missing.push(`BirthdaySent.${c}: coluna ausente`); else if (!same(bs[c], spec)) missing.push(`BirthdaySent.${c}: definicao diferente (esperado ${JSON.stringify(spec)}, atual ${JSON.stringify(bs[c])})`); }
    // colunas acrescentadas por migracoes POSTERIORES (20261027: messageText) nao sao "inesperadas": a recuperacao tambem pode ser conferida depois do deploy seguinte
    for (const c of Object.keys(bs)) if (!BS_FULL[c] && !LATER_BS_COLUMNS.includes(c)) missing.push(`BirthdaySent.${c}: coluna inesperada`);
  }
  for (const t of NEW_TABLES) if (!s.tables[t]) missing.push(`tabela ${t}: ausente`);
  for (const [t, fks] of Object.entries(EXPECTED_FKS)) {
    if (!s.tables[t]) continue;
    for (const [from, tbl, to] of fks) if (!s.fks[t].some((f) => f[0] === from && f[1] === tbl && f[2] === to)) missing.push(`${t}: chave estrangeira ${from} -> ${tbl}.${to} ausente`);
  }
  for (const [name, spec] of Object.entries(EXPECTED_INDEXES)) {
    const got = s.indexes[name];
    if (!got) { if (s.tables[spec.table] !== null) missing.push(`indice ${name}: ausente`); else missing.push(`indice ${name}: ausente (tabela ainda nao existe)`); }
    else if (got.unique !== spec.unique || got.cols.join(",") !== spec.cols.join(",")) missing.push(`indice ${name}: definicao diferente`);
  }
  return missing;
}

// Classifica o estado para decidir o que fazer. Qualquer coisa fora do roteiro previsto INTERROMPE (nada e escrito).
export function classify(s) {
  if (!s.hasMigrationsTable) return { kind: "inesperado", why: "o banco nao tem a tabela _prisma_migrations (nao e o banco do app?)" };
  if (s.otherFailed.length) return { kind: "inesperado", why: `outra(s) migracao(oes) tambem esta(ao) falhada(s): ${s.otherFailed.join(", ")} - resolva-as antes` };
  const missing = compareToExpected(s);
  const m = s.migration;
  if (!m) {
    const anyNew = NEW_TABLES.some((t) => s.tables[t]) || (s.tables.ReminderDispatch && Object.keys(RD_NEW).some((c) => s.tables.ReminderDispatch[c]));
    if (anyNew) return { kind: "inesperado", why: "ha objetos desta migracao no banco, mas nao ha registro dela em _prisma_migrations", missing };
    return { kind: "nao_iniciada", why: "a migracao ainda nao foi tentada neste banco: nao ha o que recuperar (faca o deploy normal da versao corrigida)", missing };
  }
  if (m.finishedAt && !m.rolledBackAt) {
    return missing.length ? { kind: "aplicada_divergente", why: "registrada como aplicada, mas a forma das tabelas difere do esperado", missing } : { kind: "aplicada_integra", why: "registrada como aplicada e a forma final confere: nada a fazer", missing };
  }
  if (m.rolledBackAt) return { kind: "inesperado", why: "a migracao esta marcada como rolled-back, mas o SQL parcial continua no banco: o 'migrate deploy' repetiria o SQL e falharia. Nao prossiga as cegas; peca revisao", missing };
  return missing.length ? { kind: "falhada_parcial", why: "migracao registrada como FALHADA (P3009) com alteracoes parciais: e o estado esperado do incidente", missing } : { kind: "falhada_completa", why: "registrada como falhada, mas o schema ja esta completo: falta so marcar como aplicada", missing };
}

// Plano de escrita: SOMENTE o que falta.
export function buildPlan(s) {
  const stmts = readMigrationStatements();
  const plan = [];
  const rd = s.tables.ReminderDispatch ?? {};
  for (const st of stmts) {
    const m = /^ALTER TABLE "ReminderDispatch" ADD COLUMN "(\w+)"/.exec(st);
    if (m && !rd[m[1]]) plan.push({ what: `ReminderDispatch: adicionar coluna ${m[1]}`, sql: st });
  }
  const bs = s.tables.BirthdaySent;
  const needRebuild = bs && compareToExpected({ ...s, tables: { ...s.tables, ReminderDispatch: s.tables.ReminderDispatch, BirthdaySent: bs } }).some((x) => x.startsWith("BirthdaySent"));
  if (needRebuild) {
    const create = stmts.find((x) => /^CREATE TABLE "new_BirthdaySent"/.test(x));
    const idx = stmts.find((x) => /^CREATE UNIQUE INDEX "BirthdaySent_patientId_ruleId_year_key"/.test(x));
    if (!create || !idx) throw new Error("migration.sql nao tem o bloco de reconstrucao de BirthdaySent (arquivo inesperado)");
    const target = Object.keys(BS_FULL);
    const copy = target.filter((c) => c in bs);
    const select = copy.map((c) => `"${c}"`);
    const insertCols = [...copy];
    if (!("updatedAt" in bs)) { insertCols.push("updatedAt"); select.push('"sentAt"'); } // updatedAt das linhas antigas = sentAt (ultima alteracao conhecida), nunca uma data inventada
    plan.push({ what: `BirthdaySent: reconstruir a tabela copiando ${copy.length} coluna(s) existente(s) de TODAS as linhas${"updatedAt" in bs ? "" : " (updatedAt = sentAt)"}`, sql: create });
    plan.push({ what: "BirthdaySent: copiar as linhas", sql: `INSERT INTO "new_BirthdaySent" (${insertCols.map((c) => `"${c}"`).join(", ")}) SELECT ${select.join(", ")} FROM "BirthdaySent"` });
    plan.push({ what: "BirthdaySent: remover a tabela antiga", sql: 'DROP TABLE "BirthdaySent"' });
    plan.push({ what: "BirthdaySent: renomear a nova", sql: 'ALTER TABLE "new_BirthdaySent" RENAME TO "BirthdaySent"' });
    plan.push({ what: "BirthdaySent: recriar o indice unico (idempotencia por pessoa/regra/ano)", sql: idx });
  }
  for (const st of stmts) {
    const t = /^CREATE TABLE "(\w+)"/.exec(st);
    if (t && NEW_TABLES.includes(t[1]) && !s.tables[t[1]]) plan.push({ what: `criar tabela ${t[1]}`, sql: st });
  }
  for (const st of stmts) {
    const i = /^CREATE (?:UNIQUE )?INDEX "(\w+)"/.exec(st);
    if (!i || i[1] === "BirthdaySent_patientId_ruleId_year_key") continue;
    const spec = EXPECTED_INDEXES[i[1]];
    if (spec && !s.indexes[i[1]] && (s.tables[spec.table] || NEW_TABLES.includes(spec.table))) plan.push({ what: `criar indice ${i[1]}`, sql: st });
  }
  return plan;
}

// ----------------------------------------------------------------------------------------------- backup
async function makeBackup(db, dbFile, dir, { allowUnknown }) {
  const kind = storageKind(dir);
  if (kind === "raiz_do_container") throw new Error(`o diretorio de backup ${dir} esta na RAIZ do container (nenhum volume montado ali): o backup sumiria num redeploy. Use um caminho dentro de um volume (ex.: ao lado do banco).`);
  if (kind === "desconhecido" && !allowUnknown) throw new Error(`nao consegui provar que ${dir} e um volume persistente (sem /proc/self/mountinfo). Se voce SABE que e, repita com --aceito-armazenamento-desconhecido.`);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `prod-antes-${MIGRATION}-${stamp}.db`);
  if (fs.existsSync(file)) throw new Error(`o arquivo de backup ${file} ja existe`);
  // VACUUM INTO: copia transacionalmente consistente, inclusive com o banco em WAL (nao basta copiar so o .db).
  await db.$executeRawUnsafe(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const bdb = new PrismaClient({ datasources: { db: { url: `file:${file}?connection_limit=1` } } });
  try {
    const integ = String((await bdb.$queryRawUnsafe("PRAGMA integrity_check"))[0].integrity_check);
    if (integ !== "ok") throw new Error(`o backup NAO passou no integrity_check (${integ}): nao use este arquivo e interrompa`);
    const counts = {};
    for (const t of COUNT_TABLES) {
      try { counts[t] = Number((await bdb.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM "${t}"`))[0].n); } catch { counts[t] = null; }
    }
    return { file, bytes: fs.statSync(file).size, storage: kind, counts };
  } finally { await bdb.$disconnect(); }
}

// ----------------------------------------------------------------------------------------------- principal
export async function run(argv, env = process.env, log = console.log) {
  const apply = argv.includes("--apply");
  const allowUnknown = argv.includes("--aceito-armazenamento-desconhecido");
  const bi = argv.indexOf("--backup-dir");
  const dbFile = sqlitePathOf(env.DATABASE_URL);
  if (!fs.existsSync(dbFile)) throw new Error(`banco nao encontrado em ${dbFile}`);
  const backupDir = bi >= 0 ? argv[bi + 1] : path.join(path.dirname(dbFile), "backups-hotfix");
  const db = new PrismaClient({ datasources: { db: { url: `file:${dbFile}?connection_limit=1` } } });
  const result = { dbFile, apply, state: null, applied: [], backup: null, validation: null, next: [] };
  try {
    if (!apply) await db.$executeRawUnsafe("PRAGMA query_only=ON"); // diagnostico: o proprio SQLite recusa qualquer escrita nesta conexao
    log(`Banco: ${dbFile}  |  modo: ${apply ? "APLICAR" : "DIAGNOSTICO (somente leitura)"}`);
    const before = await inspect(db);
    const st = classify(before);
    result.state = st.kind;
    log(`Estado: ${st.kind} - ${st.why}`);
    if (before.migration) log(`Registro em _prisma_migrations: iniciada ${before.migration.startedAt}; finalizada ${before.migration.finishedAt ?? "NAO"}; rolled-back ${before.migration.rolledBackAt ?? "NAO"}; passos ${before.migration.steps}`);
    log(`Contagens atuais: ${JSON.stringify(before.counts)}`);
    for (const m of st.missing ?? []) log(`  falta/difere: ${m}`);

    if (["inesperado", "aplicada_divergente"].includes(st.kind)) { result.next.push("INTERROMPIDO: estado fora do roteiro previsto. Nada foi escrito. Nao use 'migrate resolve' as cegas; envie esta saida para revisao."); log(result.next[0]); return result; }
    if (st.kind === "nao_iniciada") { result.next.push("Nada a recuperar: faca o deploy normal (o boot aplica a migracao corrigida)."); log(result.next[0]); return result; }
    if (st.kind === "aplicada_integra") { result.next.push("Nada a fazer."); log(result.next[0]); return result; }

    const plan = st.kind === "falhada_completa" ? [] : buildPlan(before);
    log(plan.length ? `Plano (${plan.length} passo(s), numa unica transacao):` : "Plano: nenhuma alteracao de schema pendente.");
    plan.forEach((p, i) => log(`  ${i + 1}. ${p.what}`));

    if (!apply) {
      result.next.push("Previa apenas. Para aplicar: node scripts/recuperar-migracao-disparos.mjs --apply --backup-dir <pasta em volume persistente>");
      log(result.next[0]);
      return result;
    }

    // ---- aplicar: backup obrigatorio ANTES de qualquer escrita
    result.backup = await makeBackup(db, dbFile, backupDir, { allowUnknown });
    log(`Backup verificado: ${result.backup.file} (${result.backup.bytes} bytes, armazenamento=${result.backup.storage}, integrity_check=ok)`);
    for (const t of COUNT_TABLES) if (result.backup.counts[t] != null && before.counts[t] != null && result.backup.counts[t] !== before.counts[t]) throw new Error(`o backup tem ${result.backup.counts[t]} linha(s) em ${t} e o banco ${before.counts[t]}: algo escreveu durante o backup. Pare o servico e repita.`);

    const bsBefore = before.tables.BirthdaySent ? await db.$queryRawUnsafe('SELECT "id", "sentAt", "state" FROM "BirthdaySent" ORDER BY "id"') : [];
    if (plan.length) {
      await db.$executeRawUnsafe("PRAGMA foreign_keys=OFF"); // fora da transacao (dentro dela o SQLite ignora); conexao unica (connection_limit=1)
      try {
        await db.$transaction(async (tx) => {
          for (const p of plan) await tx.$executeRawUnsafe(p.sql);
          const fk = await tx.$queryRawUnsafe("PRAGMA foreign_key_check");
          if (fk.length) throw new Error(`foreign_key_check encontrou ${fk.length} violacao(oes): transacao desfeita, nada foi alterado`);
        }, { timeout: 120_000, maxWait: 30_000 });
      } finally { await db.$executeRawUnsafe("PRAGMA foreign_keys=ON"); }
      result.applied = plan.map((p) => p.what);
      log(`Aplicado: ${plan.length} passo(s).`);
    }

    // ---- validacao completa
    const after = await inspect(db);
    const problems = compareToExpected(after);
    const integrity = String((await db.$queryRawUnsafe("PRAGMA integrity_check"))[0].integrity_check);
    const fkAfter = await db.$queryRawUnsafe("PRAGMA foreign_key_check");
    if (integrity !== "ok") problems.push(`integrity_check: ${integrity}`);
    if (fkAfter.length) problems.push(`foreign_key_check: ${fkAfter.length} violacao(oes)`);
    for (const t of COUNT_TABLES) if (before.counts[t] != null && after.counts[t] !== before.counts[t]) problems.push(`contagem de ${t} mudou: ${before.counts[t]} -> ${after.counts[t]}`);
    const bsAfter = await db.$queryRawUnsafe('SELECT "id", "sentAt", "state", "updatedAt", "attempts" FROM "BirthdaySent" ORDER BY "id"');
    if (bsAfter.length !== bsBefore.length) problems.push("BirthdaySent: numero de linhas diferente");
    const byId = new Map(bsAfter.map((r) => [r.id, r]));
    for (const r of bsBefore) {
      const a = byId.get(r.id);
      if (!a) problems.push(`BirthdaySent: linha ${r.id} sumiu`);
      else if (String(a.sentAt) !== String(r.sentAt) || a.state !== r.state) problems.push(`BirthdaySent: linha ${r.id} mudou de sentAt/state`);
      else if (a.updatedAt == null) problems.push(`BirthdaySent: linha ${r.id} ficou sem updatedAt`);
    }
    result.validation = { ok: problems.length === 0, problems, counts: after.counts, integrity };
    if (problems.length) { log("VALIDACAO FALHOU:"); problems.forEach((p) => log(`  - ${p}`)); log("NAO marque a migracao como aplicada. Se precisar voltar: restaure o backup acima."); process.exitCode = 1; return result; }
    log(`VALIDACAO OK: schema final confere, integrity_check=ok, foreign_key_check vazio, contagens e linhas preservadas (${JSON.stringify(after.counts)}).`);
    result.next.push(`npx prisma migrate resolve --applied ${MIGRATION}`, "npx prisma migrate status");
    log("Proximo passo (somente agora): " + result.next.join("  &&  "));
    return result;
  } finally { await db.$disconnect(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).catch((e) => { console.error(`ERRO: ${e instanceof Error ? e.message : e}`); process.exit(1); });
}
