// A Alice le o que a CLINICA (equipe e lembretes) ja escreveu e nunca diz um horario diferente (caso Rita, 15/10: recepcao disse 09h30, a Alice 08:00).
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dbFile = path.join(os.tmpdir(), `alice-horario-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "cd".repeat(32);
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const { prisma } = await import("../dist/db/client.js");
const { encryptSecret } = await import("../dist/meta/secretBox.js");
const { clinicTimeStatements, findTimeConflicts, statementsNote } = await import("../dist/ai/clinicStatements.js");
const { checkClinicTimeConflicts } = await import("../dist/ai/timeConflict.js");

test.after(async () => {
  await (await import("../dist/jobs/background.js")).drainBackground(); // tarefas em segundo plano terminam ANTES de o banco temporario ser apagado
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* Windows pode segurar o arquivo por um instante: e temporario */ } }
});

const TZ = "America/Sao_Paulo";
// ---- com banco e Clinica Experts simulado ----
const clinic = await prisma.clinic.create({ data: { name: "Clinica Teste Horario", whatsappPhone: "5511900000003", timezone: TZ } });
await prisma.clinicaExpertsAccount.create({ data: { clinicId: clinic.id, tokenEnc: encryptSecret("token-de-teste-com-mais-de-vinte-caracteres"), tokenHint: "••••test" } });
const proc = await prisma.procedure.create({ data: { clinicId: clinic.id, name: "Lavieen", durationMin: 30 } });
let handler = () => new Response("{}", { status: 404 });
globalThis.fetch = async (url, init = {}) => handler(new URL(String(url)), init);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function paciente(nome, uuid) {
  const p = await prisma.patient.create({ data: { clinicId: clinic.id, name: nome, phone: "5511" + Math.floor(Math.random() * 1e9), ceUuid: uuid } });
  const a = await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: p.id, procedureId: proc.id, scheduledAt: new Date("2026-10-20T11:00:00Z"), source: "presencial" } }); // 08:00
  return { p, a };
}

const NOW = new Date("2026-10-15T18:16:00Z"); // 15:16 em Sao Paulo
const RECEPCAO = "Olá, *Rita*! ❤️ Tudo bem?\nAqui é a Isa, da Clínica Lisboa Beauty Center ✨\nPassando para confirmar o seu agendamento conosco:\n📅 Data: 20/10/2026\n⏰ Horário: 09h30\n\n📍 Endereço: Av. Índico, 294 – São Bernardo do Campo/SP – 09750-600\n🚗 Disponibilizamos estacionamento próprio e também temos convênio com desconto no endereço: Av. Índico, 231 – Jardim do Mar – São Bernardo do Campo.";
const hist = [
  { role: "human", content: RECEPCAO, authorName: null, createdAt: new Date("2026-10-15T17:52:00Z") },
  { role: "user", content: "Olá, meninas\nTudo bem? E\n\nConfirmado…", authorName: null, createdAt: new Date("2026-10-15T18:00:00Z") },
];

test("le o horario que a recepcao escreveu (09h30 em 20/10) e ignora o que nao e afirmacao", () => {
  const st = clinicTimeStatements(hist, TZ, NOW);
  assert.equal(st.length, 1);
  assert.deepEqual([st[0].dd, st[0].mm, st[0].time, st[0].from], [20, 10, "09:30", "equipe"]);
  // oferta de varios horarios, fala da propria Alice e mensagem antiga nao contam
  assert.equal(clinicTimeStatements([{ role: "human", content: "Tenho 08:30 e 10:30 no dia 20/10, qual prefere?", createdAt: NOW }], TZ, NOW).length, 0);
  assert.equal(clinicTimeStatements([{ role: "assistant", authorName: null, content: "Seu agendamento está confirmado para 20/10 às 08:00", createdAt: NOW }], TZ, NOW).length, 0);
  assert.equal(clinicTimeStatements([{ ...hist[0], createdAt: new Date("2026-09-01T12:00:00Z") }], TZ, NOW).length, 0);
});

test("lembrete automatico 'hoje as 15:30' vira data de hoje", () => {
  const st = clinicTimeStatements([{ role: "assistant", authorName: "Lembrete de consulta", content: "Bom dia, Renata! Estamos muito felizes em te receber hoje às 15:30 🥰", createdAt: new Date("2026-10-15T10:04:00Z") }], TZ, NOW);
  assert.deepEqual([st[0].dd, st[0].mm, st[0].time, st[0].from], [15, 10, "15:30", "automatica"]);
});

test("divergencia: agenda 08:00 x clinica 09:30 no mesmo dia; igual ou outro dia nao e conflito; a fala mais nova vale", () => {
  const st = clinicTimeStatements(hist, TZ, NOW);
  const c = findTimeConflicts([{ dd: 20, mm: 10, time: "08:00" }], st);
  assert.equal(c.length, 1);
  assert.deepEqual([c[0].clinicTime, c[0].localTimes], ["09:30", ["08:00"]]);
  assert.equal(findTimeConflicts([{ dd: 20, mm: 10, time: "09:30" }], st).length, 0);
  assert.equal(findTimeConflicts([{ dd: 21, mm: 10, time: "08:00" }], st).length, 0, "agenda de outro dia nao conflita");
  assert.equal(findTimeConflicts([], st).length, 0);
  const later = [...st, { ...st[0], time: "08:00", at: new Date("2026-10-15T18:10:00Z") }];
  assert.equal(findTimeConflicts([{ dd: 20, mm: 10, time: "08:00" }], later).length, 0, "a ultima afirmacao da clinica e a que vale");
  assert.match(statementsNote(st), /20\/10 as 09:30 \(equipe\)/);
});

test("agenda velha: o CE tem 09:30 -> a Alice corrige o horario e nao ha mais divergencia", async () => {
  const { p, a } = await paciente("Rita Oliveira", "uuid-rita");
  handler = (u) => (u.pathname.endsWith("/bookings") ? json({ data: [{ uuid: "res-1", starts_at: "2026-10-20T09:30:00-03:00", status: "scheduled", patient: { uuid: "uuid-rita", name: "Rita Oliveira" } }] }) : json({}, 404));
  const r = await checkClinicTimeConflicts(clinic.id, { id: p.id, name: p.name, ceUuid: p.ceUuid }, hist, TZ);
  assert.equal(r.healed, 1);
  assert.equal(r.remaining.length, 0);
  const depois = await prisma.appointment.findUnique({ where: { id: a.id } });
  assert.equal(depois.scheduledAt.toISOString(), "2026-10-20T12:30:00.000Z");
  assert.equal(depois.ceBookingUuid, "res-1");
  assert.ok(await prisma.activityLog.findFirst({ where: { patientId: p.id, title: "Horário corrigido pelo Clínica Experts" } }));
});

test("o CE tambem nao confirma o horario da clinica: sobra a divergencia (a Alice nao afirma nada)", async () => {
  const { p, a } = await paciente("Maria Souza", "uuid-maria");
  handler = (u) => (u.pathname.endsWith("/bookings") ? json({ data: [{ uuid: "res-2", starts_at: "2026-10-20T08:00:00-03:00", status: "scheduled", patient: { uuid: "uuid-maria", name: "Maria Souza" } }] }) : json({}, 404));
  const r = await checkClinicTimeConflicts(clinic.id, { id: p.id, name: p.name, ceUuid: p.ceUuid }, hist, TZ);
  assert.equal(r.healed, 0);
  assert.equal(r.remaining.length, 1);
  assert.equal((await prisma.appointment.findUnique({ where: { id: a.id } })).scheduledAt.toISOString(), "2026-10-20T11:00:00.000Z", "nada e alterado");
});

test("CE fora do ar: nao corrige nada e a divergencia continua (equipe resolve)", async () => {
  const { p } = await paciente("Joana Lima", "uuid-joana");
  handler = () => { throw new Error("rede caiu"); };
  const r = await checkClinicTimeConflicts(clinic.id, { id: p.id, name: p.name, ceUuid: p.ceUuid }, hist, TZ);
  assert.equal(r.healed, 0);
  assert.equal(r.remaining.length, 1);
});

test("sem nada escrito pela clinica, nada muda", async () => {
  const { p } = await paciente("Sem Historico", "uuid-sh");
  const r = await checkClinicTimeConflicts(clinic.id, { id: p.id, name: p.name, ceUuid: p.ceUuid }, [{ role: "user", content: "oi", authorName: null, createdAt: NOW }], TZ);
  assert.deepEqual([r.healed, r.remaining.length, r.statements.length], [0, 0, 0]);
});

test("a Alice confere antes de responder e passa pra equipe se nao resolver", () => {
  const src = fs.readFileSync(new URL("../src/ai/alice.ts", import.meta.url), "utf8");
  assert.match(src, /checkClinicTimeConflicts\(clinicId, \{ id: patient\.id, name: patient\.name, ceUuid: patient\.ceUuid \}, history, tcTz\)/);
  assert.match(src, /Horário divergente entre a agenda e a mensagem da clínica/);
  assert.match(src, /statementsInfo \? statementsInfo \+ "\\n\\n" : ""/);
});

test("Helia: 'Confirmado' a uma confirmacao pedida pela EQUIPE so agradece (nao oferece horarios)", async () => {
  // a decisao de "confirmou presenca" saiu de alice.ts para ai/presenceConfirmation.ts (decisao deterministica sobre o que esta gravado); a Alice so a consulta
  const presence = fs.readFileSync(new URL("../src/ai/presenceConfirmation.ts", import.meta.url), "utf8");
  assert.ok(presence.includes('const humanAsked = lastNonUser?.role === "human"'));
  assert.ok(presence.includes("const evidence = chatReminder || humanAsked ||"));
  const alice = fs.readFileSync(new URL("../src/ai/alice.ts", import.meta.url), "utf8");
  assert.ok(alice.includes("await resolvePresence({ clinicId, patient: { id: patient.id, phone: patient.phone }, history"));
  const { isConfirmationReply } = await import("../dist/ai/confirmation.js");
  assert.equal(isConfirmationReply("Confirmado 😉"), true);
  assert.equal(isConfirmationReply("Confirmado, mas queria remarcar"), false);
});
