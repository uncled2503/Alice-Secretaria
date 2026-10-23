// LOTES 3 e 4 (22/10/2026): banco de objecoes aprovado/versionado, trocas proibidas, agenda fraca 48-72h, Central com pesquisa/indicacao/aviso de agendamento
// e MIGRACOES 20261029 + 20261030 aplicadas sobre banco COM DADOS do estado anterior. Banco isolado; nenhuma mensagem real (fetch falso).
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.TZ = "UTC";
const dbFile = path.join(os.tmpdir(), `alice-lotes34-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY ??= "test-key";
process.env.AI_SEND_REVIEW = "off";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const enviados = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.endsWith("uazapi.com") && u.pathname === "/send/text") enviados.push(JSON.parse(init.body));
  return new Response(JSON.stringify({ id: `m${enviados.length}` }), { status: 200, headers: { "Content-Type": "application/json" } });
};

const { prisma } = await import("../dist/db/client.js");
const ob = await import("../dist/crm/objectionBank.js");
const conduct = await import("../dist/ai/conduct.js");
const wa = await import("../dist/crm/weakAgenda.js");
const model = await import("../dist/dispatch/model.js");
const { detectObjection } = await import("../dist/ai/turnReading.js");

test.after(async () => {
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* temporario */ } }
});
const TZ = "America/Sao_Paulo";
let n = 0;
const clinica = (extra = {}) => prisma.clinic.create({ data: { name: `L34 ${++n}`, whatsappPhone: `55117${Math.floor(Math.random() * 1e8)}`, timezone: TZ, plan: "prime", uazapiBaseUrl: "https://t.uazapi.com", uazapiToken: `tk-${n}-${Date.now()}`, ...extra } });

test("OBJECOES: codigo por fala (dor e parcelamento antes de medo/preco; 'vou pensar' = indecisao); so a APROVADA vale; nova versao substitui e preserva o historico", async () => {
  const code = (t, intent) => ob.objectionCodeOf(t, detectObjection(t), intent);
  assert.equal(code("achei caro"), "preco");
  assert.equal(code("tenho medo de ficar artificial"), "medo");
  assert.equal(code("vai doer muito?"), "dor");
  assert.equal(code("da pra parcelar no cartao?"), "parcelamento");
  assert.equal(code("nao tenho tempo agora"), "tempo");
  assert.equal(code("vou pensar e te aviso"), "indecisao");
  assert.equal(code("ok", "hesitate"), "indecisao");
  assert.equal(code("qual o endereco?"), null);
  const c = await clinica();
  assert.equal((await ob.saveObjectionAnswer(c.id, "desconto", "texto qualquer aqui", true, "Aline")).ok, false, "codigo fora da lista");
  const d = await ob.saveObjectionAnswer(c.id, "preco", "Entendo! O valor inclui avaliação e acompanhamento; posso te mostrar as formas de pagamento.", false, "Aline");
  assert.equal(await ob.approvedObjectionAnswer(c.id, "preco"), null, "rascunho nao e usado pela Alice");
  assert.equal((await ob.approveObjectionDraft(c.id, d.id, "Aline")).ok, true);
  assert.equal((await ob.approvedObjectionAnswer(c.id, "preco")).version, 1);
  const v2 = await ob.saveObjectionAnswer(c.id, "preco", "Entendo você! Posso te explicar o que está incluso e as formas de pagamento cadastradas.", true, "Aline");
  assert.equal(v2.version, 2);
  const all = await prisma.objectionAnswer.findMany({ where: { clinicId: c.id, code: "preco" }, orderBy: { version: "asc" } });
  assert.deepEqual(all.map((x) => x.status), ["substituida", "aprovada"], "historico preservado");
  assert.match(ob.objectionDirective("preco", (await ob.approvedObjectionAnswer(c.id, "preco")).text), /SEM acrescentar desconto, brinde, escassez, garantia/);
  const outra = await clinica();
  assert.equal(await ob.approvedObjectionAnswer(outra.id, "preco"), null, "isolamento por empresa");
});

test("TROCAS PROIBIDAS: pediu Lavieen -> a frase que oferece carboxiterapia sai; negacao fica; sem pedido de Lavieen nada muda", () => {
  const swaps = conduct.parseForbiddenSwaps("Lavieen > carboxiterapia; LEDterapia > luz pulsada; x>y");
  assert.deepEqual(swaps, [{ asked: "Lavieen", forbidden: "carboxiterapia" }, { asked: "LEDterapia", forbidden: "luz pulsada" }]);
  assert.deepEqual(conduct.swapTermsFor(["oi, quero saber do lavieen"], swaps), ["carboxiterapia"]);
  assert.deepEqual(conduct.swapTermsFor(["quero carboxiterapia ou lavieen?"], swaps), [], "ela mesma perguntou dos dois: pode comparar");
  assert.deepEqual(conduct.swapTermsFor(["quero botox"], swaps), []);
  const split = (t) => t.split(/(?<=[.!?])\s+/);
  const remove = (t, bad) => bad.reduce((acc, s) => acc.replace(s, ""), t);
  const out = conduct.stripNotOffered("O Lavieen trata textura e manchas. Também temos a carboxiterapia, que pode ser uma alternativa! Quer agendar?", ["carboxiterapia"], split, remove);
  assert.doesNotMatch(out, /carboxi/);
  assert.match(out, /Lavieen trata/);
});

test("AGENDA FRACA: blocos livres reais (jornada, almoco, reservas), ocupacao por profissional, o que cabe; alerta so com limite e uma vez por data", async () => {
  assert.deepEqual(wa.freeBlocks(720, 1260, null, [[720, 840]]), [[840, 1260]]);
  assert.deepEqual(wa.freeBlocks(480, 1020, [720, 780], [[600, 660], [650, 700]]), [[480, 600], [700, 720], [780, 1020]]);
  const c = await clinica({ notifyPhone: "5511900002222", workDays: "1,2,3,4,5,6", workStartHour: 9, workEndHour: 18 });
  const pro = await prisma.professional.create({ data: { clinicId: c.id, name: "Suelen", workStartHour: 12, workEndHour: 21 } });
  const proc = await prisma.procedure.create({ data: { clinicId: c.id, name: "Limpeza de pele", durationMin: 60, professionals: { connect: [{ id: pro.id }] } } });
  await prisma.procedure.create({ data: { clinicId: c.id, name: "Protocolo longo", durationMin: 450, professionals: { connect: [{ id: pro.id }] } } });
  const p = await prisma.patient.create({ data: { clinicId: c.id, name: "X", phone: "5511900003333" } });
  await prisma.appointment.create({ data: { clinicId: c.id, patientId: p.id, procedureId: proc.id, professionalId: pro.id, scheduledAt: new Date("2026-10-29T12:00:00-03:00"), endsAt: new Date("2026-10-29T14:00:00-03:00"), source: "presencial" } });
  const occ = await wa.agendaOccupancy(c.id, ["2026-10-29"]);
  const d = occ.dias.find((x) => x.professionalId === pro.id);
  assert.equal(d.jornadaMin, 540);
  assert.equal(d.reservadoMin, 120);
  assert.equal(d.ocupacaoPct, 22);
  assert.deepEqual(d.livres, [{ start: "14:00", end: "21:00", minutes: 420 }]);
  assert.deepEqual(d.cabem, ["Limpeza de pele"], "o protocolo de 450 min nao cabe (maior janela livre: 420) em nenhuma janela livre");
  assert.match(occ.fonte, /não entram na conta/);
  assert.deepEqual(wa.weakWindowDates(new Date("2026-10-27T15:00:00Z"), TZ), ["2026-10-29", "2026-10-30"]);
  assert.equal(await wa.runWeakAgendaAlert(new Date("2026-10-27T13:00:00Z")), 0, "sem limite configurado: nenhum alerta");
  await prisma.clinic.update({ where: { id: c.id }, data: { weakAgendaPct: 50 } });
  enviados.length = 0;
  await wa.runWeakAgendaAlert(new Date("2026-10-27T13:00:00Z"));
  const alerts = () => enviados.filter((e) => e.number === "5511900002222" && /Agenda de 29\/10/.test(e.text));
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0].text, /Suelen 22%/);
  await wa.runWeakAgendaAlert(new Date("2026-10-27T13:30:00Z"));
  assert.equal(alerts().length, 1, "nao repete para a mesma data");
});

test("CENTRAL: pesquisa e convite de indicacao aparecem com o proprio nome (antes: 'retomada'); aviso de agendamento do painel/API aparece", async () => {
  const c = await clinica();
  const p = await prisma.patient.create({ data: { clinicId: c.id, name: "Pesquisada", phone: "5511900004444" } });
  const proc = await prisma.procedure.create({ data: { clinicId: c.id, name: "Botox", durationMin: 30 } });
  const a = await prisma.appointment.create({ data: { clinicId: c.id, patientId: p.id, procedureId: proc.id, scheduledAt: new Date("2026-10-23T15:00:00Z"), source: "painel" } });
  const at = new Date("2026-10-22T15:00:00Z");
  const fu = (flow, step = 1) => prisma.followUpDispatch.create({ data: { clinicId: c.id, patientId: p.id, flow, step, dueAt: at, cycleKey: `${flow}-${Math.random()}`, state: "sent", decidedAt: at } });
  await fu("pesquisa"); await fu("indicacao"); await fu("recontato", 2);
  await prisma.appointmentConfirmation.create({ data: { clinicId: c.id, appointmentId: a.id, patientId: p.id, startsAt: a.scheduledAt, state: "sent", attempts: 1, attemptedAt: at, finalAt: at } });
  const v = await model.buildDispatchView(c.id, { from: "2026-10-22", to: "2026-10-31" }, new Date("2026-10-22T18:00:00Z")); // (createdAt/updatedAt usam o relogio real: periodo largo)
  const kinds = v.items.map((i) => `${i.kind}|${i.ruleName ?? i.rule ?? ""}`);
  assert.ok(kinds.some((k) => k.startsWith("pesquisa|")), kinds.join(" ; "));
  assert.ok(kinds.some((k) => k.startsWith("indicacao|")));
  assert.ok(kinds.some((k) => k.startsWith("recontato|")));
  assert.ok(kinds.some((k) => k.startsWith("aviso_agendamento|")));
  assert.ok(!kinds.some((k) => k.startsWith("retomada|")), "nada disso e retomada");
});

test("MIGRACOES 20261029 + 20261030: aplicam sobre banco COM DADOS do estado anterior; linhas preservadas, defaults seguros, schema sem divergencia", async () => {
  const { cachedPreDb, makeProject, migrationsBefore, cli, urlOf } = await import("./helpers-migracao.mjs");
  const A = "20261029100000_confirmacoes_versao_etapas";
  const B = "20261030100000_ofertas_parcelamento";
  const prismaCli = path.join(root, "node_modules", "prisma", "build", "index.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alice-mig-l34-"));
  const dbPath = path.join(tmp, "pre.db");
  fs.copyFileSync(await cachedPreDb(A), dbPath);
  const url = urlOf(dbPath);
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ datasources: { db: { url: `${url}?connection_limit=1` } } });
  try {
    const ins = async (table, values) => {
      const info = await db.$queryRawUnsafe(`PRAGMA table_info("${table}")`);
      const row = { ...values };
      for (const col of info) { if (col.name in row || Number(col.notnull) !== 1 || col.dflt_value != null) continue; const ty = String(col.type).toUpperCase(); row[col.name] = ty === "TEXT" ? `${table}-${col.name}-${Math.random()}` : ty === "DATETIME" ? new Date().toISOString() : 0; }
      const cols = Object.keys(row);
      await db.$executeRawUnsafe(`INSERT INTO "${table}" (${cols.map((x) => `"${x}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`, ...Object.values(row));
    };
    await ins("Clinic", { id: "c1", name: "Lisboa", whatsappPhone: "5511900000001" });
    await ins("Patient", { id: "p1", clinicId: "c1", phone: "5511900000002" });
    await ins("Procedure", { id: "pr1", clinicId: "c1", name: "Lavieen", durationMin: 60, price: 597, maxInstallments: 5, offerInstallments: 1 });
    await ins("Appointment", { id: "ap1", clinicId: "c1", patientId: "p1", procedureId: "pr1", scheduledAt: "2026-11-24 14:00:00", status: "confirmed", patientConfirmed: 1 });
    await ins("DispatchPolicy", { id: "dp1", clinicId: "c1", kind: "confirmacao", extendUntil: "17:00", minLeadMin: 90 });
    await ins("SpecialDate", { id: "sd1", clinicId: "c1", kind: "campanha", name: "Lavieen Day", startsOn: "2026-11-17", status: "aprovada", conditionText: "condição antiga" });
    await ins("ReminderDispatch", { id: "rd1", clinicId: "c1", bookingKey: "appt:ap1", appointmentId: "ap1", patientId: "p1", ruleId: "r1", kind: "dia_seguinte", startsAt: "2026-11-24 14:00:00", sendDay: "2026-11-23", state: "sent", messageText: "texto enviado" });
  } finally { await db.$disconnect(); }
  const schema = makeProject(path.join(tmp, "proj"), migrationsBefore(A), [A, B]);
  const up = cli(["migrate", "deploy"], dbPath, schema);
  assert.equal(up.status, 0, up.out.slice(-800));
  const db2 = new PrismaClient({ datasources: { db: { url: `${url}?connection_limit=1` } } });
  try {
    const ap = (await db2.$queryRawUnsafe(`SELECT patientConfirmed, rescheduleRequestedAt, missingProcedureAlertAt, offerId, offerVersion, offerTerms FROM "Appointment"`))[0];
    assert.deepEqual([Number(ap.patientConfirmed), ap.rescheduleRequestedAt, ap.missingProcedureAlertAt, ap.offerId, ap.offerVersion, ap.offerTerms], [1, null, null, null, null, null], "confirmacao existente preservada; colunas novas vazias");
    const dp = (await db2.$queryRawUnsafe(`SELECT extendUntil, minLeadMin, lateStartHour, lateEndHour, stepMinGapMin FROM "DispatchPolicy"`))[0];
    assert.deepEqual([dp.extendUntil, Number(dp.minLeadMin), dp.lateStartHour, dp.lateEndHour, dp.stepMinGapMin], ["17:00", 90, null, null, null], "politica editada intacta; limites novos = padrao do codigo");
    const sd = (await db2.$queryRawUnsafe(`SELECT status, conditionText, version, origin, responseMode, items FROM "SpecialDate"`))[0];
    assert.deepEqual([sd.status, sd.conditionText, Number(sd.version), sd.origin, sd.responseMode, sd.items], ["aprovada", "condição antiga", 1, "todos", "alice", null], "data aprovada intacta; origem/modo = comportamento de hoje");
    const cl = (await db2.$queryRawUnsafe(`SELECT installmentMax, installmentMinCents, forbiddenSwaps, weakAgendaPct FROM "Clinic"`))[0];
    assert.deepEqual([cl.installmentMax, cl.installmentMinCents, cl.forbiddenSwaps, cl.weakAgendaPct], [null, null, null, null], "sem politica nova ate a clinica aprovar");
    assert.equal((await db2.$queryRawUnsafe(`SELECT messageText FROM "ReminderDispatch"`))[0].messageText, "texto enviado", "historico de envio intacto");
    for (const t of ["SpecialDateRevision", "GiftCard", "ObjectionAnswer"]) assert.equal(Number((await db2.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM "${t}"`))[0].n), 0, t);
    assert.equal((await db2.$queryRawUnsafe("PRAGMA integrity_check"))[0].integrity_check, "ok");
  } finally { await db2.$disconnect(); }
  assert.match(cli(["migrate", "status"], dbPath, schema).out, /up to date/i);
  // Coluna a coluna (tipo, obrigatoriedade, default) e indices contra um banco criado DIRETO do schema. (O "migrate diff" recria tabelas so pela ORDEM das colunas - o ADD COLUMN do
  // SQLite acrescenta no fim - por isso a comparacao e por conjunto, que e o que importa para o Prisma.)
  const fresh = path.join(tmp, "fresh.db");
  assert.equal(spawnSync(process.execPath, [prismaCli, "db", "push", "--skip-generate", "--schema", schema], { cwd: root, env: { ...process.env, DATABASE_URL: urlOf(fresh) }, encoding: "utf8" }).status, 0);
  // closedOnHolidays: default divergente por migracao ANTIGA (anterior a este lote; registrado na entrega), fora do escopo destas migracoes
  const shape = async (file) => {
    const c = new PrismaClient({ datasources: { db: { url: `${urlOf(file)}?connection_limit=1` } } });
    try {
      const out = {};
      for (const t of ["Clinic", "Appointment", "SpecialDate", "DispatchPolicy", "SpecialDateRevision", "GiftCard", "ObjectionAnswer", "ReminderDispatch"]) {
        const cols = await c.$queryRawUnsafe(`PRAGMA table_info("${t}")`);
        const idx = await c.$queryRawUnsafe(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = '${t}' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
        out[t] = { cols: cols.filter((x) => !(t === "Clinic" && x.name === "closedOnHolidays")).map((x) => `${x.name}|${String(x.type).toUpperCase()}|${Number(x.notnull)}|${x.dflt_value ?? ""}`).sort(), idx: idx.map((x) => x.name) };
      }
      return out;
    } finally { await c.$disconnect(); }
  };
  assert.deepEqual(await shape(dbPath), await shape(fresh), "banco migrado = banco do schema (colunas, tipos, defaults, indices)");
  fs.rmSync(tmp, { recursive: true, force: true });
});
