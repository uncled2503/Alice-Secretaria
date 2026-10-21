// POS-PROCEDIMENTO DO LAVIEEN DEPOIS DO FECHAMENTO (Lisboa, 21/10/2026). Banco isolado, relogio controlado, WhatsApp simulado. Nenhuma mensagem real.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.TZ = "UTC";
const dbFile = path.join(os.tmpdir(), `alice-pos-fechamento-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY ??= "test-key";
process.env.AI_SEND_REVIEW = "off";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const enviados = [];
let modo = "ok";
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.endsWith("uazapi.com") && u.pathname === "/send/text") {
    if (modo === "timeout") { const e = new Error("The operation timed out"); e.name = "TimeoutError"; throw e; }
    enviados.push({ phone: JSON.parse(init.body).number, text: JSON.parse(init.body).text });
  }
  return jsonRes(200, { id: "m", data: {} });
};

const { prisma } = await import("../dist/db/client.js");
const pos = await import("../dist/reminders/postProcedure.js");
const { configurarPosDepoisDoFechamento, diagnosticarPosFluxo } = await import("../dist/maintenance/lisboaPosFechamento.js");
const { decideTiming } = await import("../dist/crm/followupSchedule.js");

test.after(async () => {
  await (await import("../dist/jobs/background.js")).drainBackground();
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* temporario */ } }
});

const TZ = "America/Sao_Paulo";
const sp = (iso) => new Date(`${iso}-03:00`);
const TEXTO_POS = "Olá, {primeiro_nome}! Cuidados após o {procedimento}: evite sol e use protetor. Qualquer dúvida, estamos aqui.";
let seq = 0;

async function cenario(nome, { late = 23, intervalo = 1, unidade = "hours", completa = true, procedimentos = "lavieen" } = {}) {
  const c = await prisma.clinic.create({ data: { name: nome, whatsappPhone: `55119${Math.floor(Math.random() * 1e8)}`, timezone: TZ, plan: "prime", uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: `tk-${Math.random().toString(36).slice(2)}-${Date.now()}` } });
  const lav = await prisma.procedure.create({ data: { clinicId: c.id, name: "Lavieen Full Face", durationMin: 60 } });
  const outro = await prisma.procedure.create({ data: { clinicId: c.id, name: "Peeling", durationMin: 30 } });
  const regra = await prisma.postProcedureRule.create({ data: { clinicId: c.id, name: "Pos Lavieen", message: TEXTO_POS, intervalValue: intervalo, intervalUnit: unidade, onlyIfCompleted: completa, procedureIds: procedimentos === "lavieen" ? lav.id : "", lateSendUntilHour: late } });
  return { c, lav, outro, regra };
}
async function atende(S, nome, inicio, { proc = S.lav, status = "completed" } = {}) {
  seq++;
  const p = await prisma.patient.create({ data: { clinicId: S.c.id, name: nome, phone: `55119666${String(10000 + seq)}` } });
  const a = await prisma.appointment.create({ data: { clinicId: S.c.id, patientId: p.id, procedureId: proc.id, scheduledAt: sp(inicio), source: "presencial", status } });
  return { p, a };
}
const roda = (iso) => pos.runPostProcedureCycle(() => sp(iso));
const para = (p) => enviados.filter((e) => e.phone === p.phone);
const estado = async (x, S) => (await prisma.postProcedureSent.findFirst({ where: { appointmentId: x.a.id, ruleId: S.regra.id } }))?.state ?? null;

test("o que inicia o prazo: horas = FIM da reserva (inicio + duracao), dias = INICIO; limites do portao de horario", () => {
  const rule = { intervalValue: 1, intervalUnit: "hours" };
  const appt = { scheduledAt: sp("2026-10-20T19:30"), endsAt: null, procedure: { durationMin: 60 } };
  assert.equal(pos.postDueAt(rule, appt).toISOString(), sp("2026-10-20T21:30").toISOString());
  assert.equal(pos.postDueAt({ intervalValue: 1, intervalUnit: "days" }, appt).toISOString(), sp("2026-10-21T19:30").toISOString());
  assert.equal(pos.postDueAt(rule, { ...appt, endsAt: sp("2026-10-20T21:00") }).toISOString(), sp("2026-10-20T22:00").toISOString(), "ends_at do CE manda");
  assert.deepEqual(pos.postHourGate({}, 21), { allowed: false, afterHours: false });
  assert.deepEqual(pos.postHourGate({ lateSendUntilHour: 23 }, 21), { allowed: true, afterHours: true });
  assert.deepEqual(pos.postHourGate({ lateSendUntilHour: 23 }, 23), { allowed: false, afterHours: false }, "ate 23h exclusivo");
  assert.deepEqual(pos.postHourGate({ lateSendUntilHour: 24 }, 23), { allowed: true, afterHours: true });
  assert.deepEqual(pos.postHourGate({ lateSendUntilHour: 23 }, 3), { allowed: false, afterHours: false }, "madrugada nunca");
  assert.deepEqual(pos.postHourGate({ lateSendUntilHour: 23 }, 10), { allowed: true, afterHours: false });
  assert.equal(pos.validLateUntilHour(20), false);
  assert.equal(pos.validLateUntilHour(25), false);
});

test("Lavieen das 19h30 (fim 20h30, pos 1 h depois = 21h30): com a autorizacao da regra o pos sai as 21h45; sem ela espera a manha", async () => {
  enviados.length = 0; modo = "ok";
  const A = await cenario("Pos Com Autorizacao");
  const B = await cenario("Pos Sem Autorizacao", { late: null });
  const a = await atende(A, "Lavieen Ana", "2026-10-20T19:30");
  const b = await atende(B, "Lavieen Bia", "2026-10-20T19:30");
  await roda("2026-10-20T20:45"); // ainda nao venceu (21h30)
  assert.equal(enviados.length, 0);
  await roda("2026-10-20T21:45");
  assert.equal(para(a.p).length, 1, "depois do fechamento, autorizado");
  assert.equal(para(b.p).length, 0, "sem a autorizacao: portao padrao 21h-7h");
  assert.match(para(a.p)[0].text, /Cuidados após o Lavieen Full Face/, "so o texto cadastrado");
  assert.equal(await estado(a, A), "sent");
  await roda("2026-10-21T03:00"); // madrugada: nunca
  assert.equal(para(b.p).length, 0);
  await roda("2026-10-21T07:05");
  assert.equal(para(b.p).length, 1, "sem a autorizacao sai de manha, como sempre foi");
  await roda("2026-10-21T07:20");
  assert.equal(para(a.p).length, 1);
  assert.equal(para(b.p).length, 1, "sem duplicidade");
});

test("nao infere que o procedimento foi feito: sem conclusao registrada nada sai, mesmo depois do horario", async () => {
  enviados.length = 0;
  const S = await cenario("Pos Sem Conclusao");
  const x = await atende(S, "Nao Concluido", "2026-10-20T19:30", { status: "confirmed" });
  await roda("2026-10-20T21:45");
  await roda("2026-10-21T08:00");
  assert.equal(para(x.p).length, 0);
  // marcado como concluido: a camada do banco registra QUANDO (evidencia), e o pos sai
  await prisma.appointment.update({ where: { id: x.a.id }, data: { status: "completed" } });
  const f = await prisma.appointment.findUnique({ where: { id: x.a.id } });
  assert.ok(f.completedAt, "registro de conclusao gravado");
  await prisma.appointment.update({ where: { id: x.a.id }, data: { status: "completed" } });
  const igual = await prisma.appointment.findUnique({ where: { id: x.a.id } });
  assert.equal(igual.completedAt.getTime(), f.completedAt.getTime(), "regravar 'concluido' nao muda a data");
  await roda("2026-10-21T08:15");
  assert.equal(para(x.p).length, 1);
});

test("depois do fechamento so sai quem venceu ha pouco: o acumulado antigo espera a manha; nada de lote a noite; outro procedimento nao e tocado", async () => {
  enviados.length = 0;
  const S = await cenario("Pos Acumulado");
  const antigo = await atende(S, "Venceu Cedo", "2026-10-20T12:00"); // fim 13h, vencia 14h
  const recente = await atende(S, "Venceu Agora", "2026-10-20T19:30");
  const peeling = await atende(S, "Outro Procedimento", "2026-10-20T19:30", { proc: S.outro });
  await roda("2026-10-20T22:00");
  assert.equal(para(recente.p).length, 1);
  assert.equal(para(antigo.p).length, 0, "venceu ha 8h: espera o horario normal");
  assert.equal(para(peeling.p).length, 0, "a regra e so do Lavieen");
  await roda("2026-10-21T07:05");
  assert.equal(para(antigo.p).length, 1);
});

test("envio incerto (timeout) nao e reenviado; etapa ja enviada nao e reaberta nem reenviada; reinicio no meio nao duplica", async () => {
  enviados.length = 0;
  const S = await cenario("Pos Incerto");
  const x = await atende(S, "Timeout", "2026-10-20T19:30");
  modo = "timeout";
  await roda("2026-10-20T21:45");
  assert.equal(await estado(x, S), "unconfirmed");
  modo = "ok";
  await roda("2026-10-20T22:00");
  await roda("2026-10-21T07:30");
  assert.equal(para(x.p).length, 0, "resultado incerto: nunca reenvia as cegas");
  // 'reserved' deixado por um processo que caiu ANTES de chamar o provedor e reivindicavel; depois da tentativa ('sending') vira incerto
  const y = await atende(S, "Caiu Antes", "2026-10-20T19:45");
  await prisma.postProcedureSent.create({ data: { appointmentId: y.a.id, ruleId: S.regra.id, state: "sending", reservedAt: sp("2026-10-20T21:50"), attemptedAt: sp("2026-10-20T21:50") } });
  await roda("2026-10-20T22:30");
  assert.equal(await estado(y, S), "unconfirmed");
  assert.equal(para(y.p).length, 0);
});

test("outras automacoes mantem as proprias restricoes: o recontato continua fechado a noite; o pos do Lavieen nao libera nada alem do proprio fluxo", () => {
  const cal = { timezone: TZ, workDays: "1,2,3,4,5,6", workStartHour: 9, workEndHour: 19, hoursByDay: null, closedOnHolidays: false, holidayOpen: null };
  const rule = { afterMinutes: 240, afterDays: 0, nextDayHour: null, sendWindowStart: null, sendWindowEnd: null };
  const ultima = sp("2026-10-20T16:00"); // vence 20h, fora do expediente
  const t = decideTiming(rule, ultima, sp("2026-10-20T21:30"), cal);
  assert.equal(t.action, "wait");
  assert.equal(t.code, "fora_do_expediente");
});

test("diagnostico do pos: a linha do tempo real comprova a causa (portao 21h-7h) e mostra a conclusao registrada", async () => {
  enviados.length = 0;
  const S = await cenario("Pos Diagnostico", { late: null });
  const x = await atende(S, "Diag Lavieen", "2026-10-20T19:30");
  await roda("2026-10-20T21:45");
  await roda("2026-10-21T07:05");
  const d = await diagnosticarPosFluxo(S.c.id, { agora: sp("2026-10-21T09:00"), dias: 3 });
  const linha = d.linhas.find((l) => l.agendamento === x.a.id);
  assert.ok(linha);
  assert.equal(linha.posEstado, "sent");
  assert.equal(linha.causa.comprovada, true);
  assert.match(linha.causa.texto, /portão de horário/);
  assert.match(d.oQueIniciaOPrazo, /FIM da reserva/);
  assert.equal(d.regras[0].depoisDoFechamentoAte, null);
});

test("configuracao especifica: so a regra do Lavieen; regra de todos os procedimentos vira pendencia; aplicar exige aprovacao; texto e intervalo intactos", async () => {
  const S = await cenario("Pos Config", { late: null });
  const todos = await prisma.postProcedureRule.create({ data: { clinicId: S.c.id, name: "Pos geral", message: "Texto geral", intervalValue: 1, intervalUnit: "days", procedureIds: "" } });
  const previa = await configurarPosDepoisDoFechamento(S.c.id);
  assert.equal(previa.somentePrevia, true);
  assert.equal(previa.regras.find((r) => r.id === S.regra.id).acao, "ligar");
  assert.equal(previa.regras.find((r) => r.id === todos.id).acao, "pendencia");
  assert.equal((await prisma.postProcedureRule.findUnique({ where: { id: S.regra.id } })).lateSendUntilHour, null, "previa nao altera");
  await assert.rejects(() => configurarPosDepoisDoFechamento(S.c.id, { ateHora: 19 }), /entre 21 e 24/);
  const ap = await configurarPosDepoisDoFechamento(S.c.id, { dryRun: false, ateHora: 23 });
  assert.equal(ap.aplicado, true);
  const r = await prisma.postProcedureRule.findUnique({ where: { id: S.regra.id } });
  assert.deepEqual([r.lateSendUntilHour, r.message, r.intervalValue, r.intervalUnit], [23, TEXTO_POS, 1, "hours"]);
  assert.equal((await prisma.postProcedureRule.findUnique({ where: { id: todos.id } })).lateSendUntilHour, null, "a regra geral nao foi tocada");
  // decisao da clinica (21/10): vale para o pos de TODOS os atendimentos
  const tudo = await configurarPosDepoisDoFechamento(S.c.id, { dryRun: false, ateHora: 23, todosProcedimentos: true });
  assert.equal(tudo.regras.find((r) => r.id === todos.id).acao, "ligar");
  const g = await prisma.postProcedureRule.findUnique({ where: { id: todos.id } });
  assert.deepEqual([g.lateSendUntilHour, g.message, g.intervalValue, g.intervalUnit], [23, "Texto geral", 1, "days"], "so o limite muda; texto e intervalo intactos");
});
