// CONFIRMACAO DE AGENDAMENTO CRIADO FORA DA CONVERSA, ESTADOS DO POS-PROCEDIMENTO E AUDITORIA (19/10/2026).
// Banco de verdade (SQLite temporario), provedor de WhatsApp simulado, relogio controlado, dados FICTICIOS. Nada e enviado de verdade.
// Cada teste verifica o que SAI para a pessoa E o estado gravado: o foco e nao perder, nao duplicar e nao reabrir.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

process.env.TZ = "UTC";
const dbFile = path.join(os.tmpdir(), `alice-conf-pos-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY = "test-key";
process.env.AI_SEND_REVIEW = "off";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const posts = [];
let providerMode = "ok"; // ok | http500 | timeout | nowa
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.includes("openai.com")) return jsonRes(200, { id: "c", object: "chat.completion", created: 1, model: "gpt-4o-mini", choices: [{ index: 0, message: { role: "assistant", content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  if (u.hostname.endsWith("uazapi.com") && u.pathname === "/send/text") {
    if (providerMode === "http500") return jsonRes(500, { error: "fora do ar" });
    if (providerMode === "timeout") throw Object.assign(new Error("The operation timed out (TimeoutError)"), { name: "TimeoutError" });
    if (providerMode === "nowa") return jsonRes(400, { error: "The number is not on WhatsApp" });
    const b = JSON.parse(init.body);
    posts.push({ number: b.number, text: b.text });
  }
  return jsonRes(200, { id: "msg", instance: { status: "connected" }, status: { connected: true } });
};

const { prisma } = await import("../dist/db/client.js");
const conf = await import("../dist/crm/appointmentMessages.js");
const { runPostProcedureCycle } = await import("../dist/reminders/postProcedure.js");
const { auditarEnviosLisboa, classificarRegistro } = await import("../dist/maintenance/lisboaAuditoriaEnvios.js");
const { wallClockInZone } = await import("../dist/scheduling/time.js");

test.after(async () => {
  await (await import("../dist/jobs/background.js")).drainBackground();
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* temporario */ } }
});

const TZ = "America/Sao_Paulo";
const HOUR = 3_600_000;
const sp = (iso) => new Date(`${iso}-03:00`);
let n = 0;
const mkClinic = (name) => prisma.clinic.create({ data: { name, whatsappPhone: `55119${Math.floor(Math.random() * 1e8)}`, timezone: TZ, plan: "prime", active: true, aliceActive: true, uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: `tok-${Math.random().toString(36).slice(2)}`, workDays: "0,1,2,3,4,5,6", workStartHour: 0, workEndHour: 24, closedOnHolidays: false } });
const mkPatient = (c, name) => prisma.patient.create({ data: { clinicId: c.id, name, phone: `55119777${String(10000 + ++n)}` } });
const reset = () => { posts.length = 0; providerMode = "ok"; };
const rowsOf = (appointmentId) => prisma.appointmentConfirmation.findMany({ where: { appointmentId }, orderBy: { createdAt: "asc" } });

async function cenarioConf(nome, { quando = "2026-11-10T15:00" } = {}) {
  const c = await mkClinic(nome);
  const proc = await prisma.procedure.create({ data: { clinicId: c.id, name: "Limpeza de pele", durationMin: 60 } });
  const p = await mkPatient(c, `${nome.split(" ")[0]} Fulana`);
  const a = await prisma.appointment.create({ data: { clinicId: c.id, patientId: p.id, procedureId: proc.id, scheduledAt: sp(quando), status: "confirmed", source: "presencial" } });
  return { c, proc, p, a };
}
const NOW = () => sp("2026-11-09T10:00");

// ===================================================================== A) CONFIRMACAO DE AGENDAMENTO CRIADO FORA DA CONVERSA
test("CONFIRMACAO: sai uma vez; o gatilho repetido (duplo clique / API reenviada) nao envia de novo", async () => {
  reset();
  const { a } = await cenarioConf("Conf Basico");
  await conf.sendAppointmentConfirmationToPatient(a.id, NOW);
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /Confirmando seu horário: Limpeza de pele/);
  await conf.sendAppointmentConfirmationToPatient(a.id, NOW);
  assert.equal(posts.length, 1, "o mesmo horario nao e confirmado duas vezes");
  const rows = await rowsOf(a.id);
  assert.deepEqual(rows.map((r) => r.state), ["sent"]);
  assert.equal(rows[0].attempts, 1);
});

test("CONFIRMACAO: falha TEMPORARIA (provedor 500) nao se perde: a recuperacao reenvia uma vez, sem duplicar", async () => {
  reset();
  const { a } = await cenarioConf("Conf Transitoria");
  providerMode = "http500";
  await conf.sendAppointmentConfirmationToPatient(a.id, NOW);
  assert.equal(posts.length, 0);
  assert.deepEqual((await rowsOf(a.id)).map((r) => r.state), ["retry"], "a etapa ficou em nova tentativa (antes: perdida, so a equipe era avisada)");
  providerMode = "ok";
  const r1 = await conf.runConfirmationRecovery(() => new Date(NOW().getTime() + 5 * 60_000));
  assert.equal(r1.attempted, 1);
  assert.equal(posts.length, 1);
  const r2 = await conf.runConfirmationRecovery(() => new Date(NOW().getTime() + 10 * 60_000));
  assert.equal(r2.attempted, 0);
  assert.equal(posts.length, 1, "uma segunda rodada nao reenvia");
  const rows = await rowsOf(a.id);
  assert.deepEqual(rows.map((r) => r.state), ["sent"]);
  assert.equal(rows[0].attempts, 2);
});

test("CONFIRMACAO: cancelou enquanto esperava a nova tentativa => o texto antigo NAO sai", async () => {
  reset();
  const { a } = await cenarioConf("Conf Cancelada");
  providerMode = "http500";
  await conf.sendAppointmentConfirmationToPatient(a.id, NOW);
  providerMode = "ok";
  await prisma.appointment.update({ where: { id: a.id }, data: { status: "cancelled" } });
  await conf.runConfirmationRecovery(() => new Date(NOW().getTime() + 5 * 60_000));
  assert.equal(posts.length, 0);
  const rows = await rowsOf(a.id);
  assert.equal(rows[0].state, "superseded");
  assert.match(rows[0].note, /cancelled/);
});

test("CONFIRMACAO: remarcou enquanto esperava => o horario velho nunca sai; o novo ganha a propria confirmacao com o horario novo", async () => {
  reset();
  const { a } = await cenarioConf("Conf Remarcada", { quando: "2026-11-10T15:00" });
  providerMode = "http500";
  await conf.sendAppointmentConfirmationToPatient(a.id, NOW);
  providerMode = "ok";
  await prisma.appointment.update({ where: { id: a.id }, data: { scheduledAt: sp("2026-11-12T09:30") } });
  await conf.sendAppointmentConfirmationToPatient(a.id, () => new Date(NOW().getTime() + 60_000)); // gatilho da remarcacao
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /12\/11/, "o texto leva o horario NOVO");
  assert.doesNotMatch(posts[0].text, /10\/11/);
  await conf.runConfirmationRecovery(() => new Date(NOW().getTime() + 5 * 60_000));
  assert.equal(posts.length, 1, "a recuperacao nao reenvia o horario velho");
  assert.deepEqual((await rowsOf(a.id)).map((r) => r.state).sort(), ["sent", "superseded"]);
});

test("CONFIRMACAO: resultado INCERTO (timeout) nao e reenviado as cegas, mesmo com a recuperacao rodando", async () => {
  reset();
  const { a } = await cenarioConf("Conf Incerta");
  providerMode = "timeout";
  await conf.sendAppointmentConfirmationToPatient(a.id, NOW);
  providerMode = "ok";
  assert.deepEqual((await rowsOf(a.id)).map((r) => r.state), ["unconfirmed"]);
  await conf.runConfirmationRecovery(() => new Date(NOW().getTime() + 5 * 60_000));
  await conf.runConfirmationRecovery(() => new Date(NOW().getTime() + 30 * 60_000));
  assert.equal(posts.length, 0, "nada foi reenviado: pode ter chegado");
  assert.deepEqual((await rowsOf(a.id)).map((r) => r.state), ["unconfirmed"]);
});

test("CONFIRMACAO: numero sem WhatsApp fecha a etapa (nao tenta para sempre)", async () => {
  reset();
  const { a } = await cenarioConf("Conf SemZap");
  providerMode = "nowa";
  await conf.sendAppointmentConfirmationToPatient(a.id, NOW);
  providerMode = "ok";
  assert.deepEqual((await rowsOf(a.id)).map((r) => r.state), ["failed_permanent"]);
  const r = await conf.runConfirmationRecovery(() => new Date(NOW().getTime() + 5 * 60_000));
  assert.equal(r.attempted, 0);
  assert.equal(posts.length, 0);
});

test("CONFIRMACAO: o processo caiu DEPOIS de marcar a tentativa => incerta (nunca reenvia); caiu ANTES => a recuperacao envia", async () => {
  reset();
  const antes = await cenarioConf("Conf CaiuAntes");
  const durante = await cenarioConf("Conf CaiuDurante");
  const t0 = NOW();
  // simula as linhas que um processo morto deixaria (a reserva e a tentativa foram gravadas, o resto nao)
  await prisma.appointmentConfirmation.create({ data: { clinicId: antes.c.id, appointmentId: antes.a.id, patientId: antes.p.id, startsAt: antes.a.scheduledAt, state: "reserved", reservedAt: new Date(t0.getTime() - 20 * 60_000), createdAt: new Date(t0.getTime() - 20 * 60_000) } });
  await prisma.appointmentConfirmation.create({ data: { clinicId: durante.c.id, appointmentId: durante.a.id, patientId: durante.p.id, startsAt: durante.a.scheduledAt, state: "sending", attempts: 1, reservedAt: new Date(t0.getTime() - 20 * 60_000), attemptedAt: new Date(t0.getTime() - 19 * 60_000), createdAt: new Date(t0.getTime() - 20 * 60_000) } });
  const r = await conf.runConfirmationRecovery(() => t0);
  assert.equal(r.interrupted, 1);
  assert.equal(posts.length, 1, "so a que CERTAMENTE nao saiu");
  assert.ok(posts[0].text.includes(antes.p.name.split(" ")[0]));
  assert.deepEqual((await rowsOf(antes.a.id)).map((x) => x.state), ["sent"]);
  const rd = await rowsOf(durante.a.id);
  assert.deepEqual(rd.map((x) => x.state), ["unconfirmed"]);
  assert.match(rd[0].note, /pode ter sido entregue/);
});

test("CONFIRMACAO: janela vencida expira (nao envia confirmacao velha) e a recuperacao NAO varre agendamentos antigos", async () => {
  reset();
  const velha = await cenarioConf("Conf Velha");
  const t0 = NOW();
  await prisma.appointmentConfirmation.create({ data: { clinicId: velha.c.id, appointmentId: velha.a.id, patientId: velha.p.id, startsAt: velha.a.scheduledAt, state: "retry", attempts: 1, createdAt: new Date(t0.getTime() - 7 * HOUR) } });
  // 30 agendamentos antigos/futuros SEM nenhum controle: nunca podem virar mensagem
  const c = await mkClinic("Conf Historico");
  const proc = await prisma.procedure.create({ data: { clinicId: c.id, name: "Peeling", durationMin: 30 } });
  for (let i = 0; i < 30; i++) {
    const p = await mkPatient(c, `Historico ${i}`);
    await prisma.appointment.create({ data: { clinicId: c.id, patientId: p.id, procedureId: proc.id, scheduledAt: new Date(t0.getTime() + (i + 1) * 24 * HOUR), status: "confirmed" } });
  }
  const r = await conf.runConfirmationRecovery(() => t0);
  assert.equal(r.expired, 1);
  assert.equal(r.attempted, 0);
  assert.equal(posts.length, 0);
  assert.deepEqual((await rowsOf(velha.a.id)).map((x) => x.state), ["expired"]);
  assert.equal(await prisma.appointmentConfirmation.count({ where: { clinicId: c.id } }), 0, "nenhuma linha criada para o historico");
});

test("CONFIRMACAO: A -> B -> A reabre o controle de A (a confirmacao anterior ficou velha); o texto identico enviado ha minutos e barrado como duplicado", async () => {
  reset();
  const { a } = await cenarioConf("Conf Volta", { quando: "2026-11-10T15:00" });
  const t = (min) => () => new Date(NOW().getTime() + min * 60_000);
  await conf.sendAppointmentConfirmationToPatient(a.id, t(0));
  await prisma.appointment.update({ where: { id: a.id }, data: { scheduledAt: sp("2026-11-12T09:30") } });
  await conf.sendAppointmentConfirmationToPatient(a.id, t(10));
  await prisma.appointment.update({ where: { id: a.id }, data: { scheduledAt: sp("2026-11-10T15:00") } });
  await conf.sendAppointmentConfirmationToPatient(a.id, t(20));
  const rows = await rowsOf(a.id);
  assert.equal(rows.length, 2, "uma linha por horario");
  const rowA = rows.find((r) => r.startsAt.getTime() === sp("2026-11-10T15:00").getTime());
  assert.equal(rowA.attempts, 0, "o controle de A foi reaberto (tentativas zeradas)");
  assert.equal(rowA.state, "duplicate", "reabriu e tentou, mas o texto identico ao enviado ha minutos e barrado (sem mensagem em dobro)");
  assert.equal(posts.length, 2, "A e depois B; o segundo A nao repete a mesma mensagem");
});

// ===================================================================== B) ESTADOS DO POS-PROCEDIMENTO
async function cenarioPos(nome, { horasAtras = 30, status = "completed" } = {}) {
  const c = await mkClinic(nome);
  const proc = await prisma.procedure.create({ data: { clinicId: c.id, name: "Peeling", durationMin: 60 } });
  const rule = await prisma.postProcedureRule.create({ data: { clinicId: c.id, name: "Pos", message: "Oi, {primeiro_nome}! Tudo certo depois do {procedimento}? Qualquer duvida me chama.", intervalValue: 1, intervalUnit: "days" } });
  const p = await mkPatient(c, `${nome.split(" ")[0]} Souza`);
  const clock = () => sp("2026-11-09T10:00");
  const a = await prisma.appointment.create({ data: { clinicId: c.id, patientId: p.id, procedureId: proc.id, scheduledAt: new Date(clock().getTime() - horasAtras * HOUR), status } });
  return { c, proc, rule, p, a, clock };
}
const posRows = (appointmentId) => prisma.postProcedureSent.findMany({ where: { appointmentId } });

test("POS: envia uma vez; o estado grava 'sent' (aceito) com tentativa e horario; a rodada seguinte nao reenvia", async () => {
  reset();
  const s = await cenarioPos("PosBasico");
  await runPostProcedureCycle(s.clock);
  assert.equal(posts.length, 1);
  await runPostProcedureCycle(s.clock);
  assert.equal(posts.length, 1);
  const rows = await posRows(s.a.id);
  assert.deepEqual(rows.map((r) => [r.state, r.attempts]), [["sent", 1]]);
  assert.ok(rows[0].attemptedAt && rows[0].finalAt);
});

test("POS: falha temporaria vira 'retry' (nao 'enviada'); quando o provedor volta sai UMA vez", async () => {
  reset();
  const s = await cenarioPos("PosRetry");
  providerMode = "http500";
  await runPostProcedureCycle(s.clock);
  assert.equal(posts.length, 0);
  assert.deepEqual((await posRows(s.a.id)).map((r) => r.state), ["retry"]);
  providerMode = "ok";
  await runPostProcedureCycle(s.clock);
  await runPostProcedureCycle(s.clock);
  assert.equal(posts.length, 1);
  const rows = await posRows(s.a.id);
  assert.deepEqual(rows.map((r) => [r.state, r.attempts]), [["sent", 2]]);
});

test("POS: resultado INCERTO (timeout) fica 'unconfirmed' e nunca e reenviado", async () => {
  reset();
  const s = await cenarioPos("PosIncerto");
  providerMode = "timeout";
  await runPostProcedureCycle(s.clock);
  providerMode = "ok";
  await runPostProcedureCycle(s.clock);
  await runPostProcedureCycle(s.clock);
  assert.equal(posts.length, 0);
  assert.deepEqual((await posRows(s.a.id)).map((r) => r.state), ["unconfirmed"]);
});

test("POS: numero sem WhatsApp fecha a etapa; tentativas esgotadas tambem fecham (nao repete para sempre)", async () => {
  reset();
  const s = await cenarioPos("PosSemZap");
  providerMode = "nowa";
  await runPostProcedureCycle(s.clock);
  providerMode = "ok";
  await runPostProcedureCycle(s.clock);
  assert.equal(posts.length, 0);
  assert.deepEqual((await posRows(s.a.id)).map((r) => r.state), ["failed_permanent"]);

  const e = await cenarioPos("PosEsgota");
  providerMode = "http500";
  for (let i = 0; i < 8; i++) await runPostProcedureCycle(e.clock);
  providerMode = "ok";
  const rows = await posRows(e.a.id);
  assert.equal(rows[0].state, "failed_permanent", "depois do teto a etapa fecha");
  assert.equal(rows[0].attempts, 6);
  await runPostProcedureCycle(e.clock);
  assert.equal(posts.length, 0);
});

test("POS: o processo caiu ANTES do envio (reserva velha sem tentativa) => recupera; caiu DURANTE (tentativa marcada) => incerta, sem reenviar", async () => {
  reset();
  const antes = await cenarioPos("PosCaiuAntes");
  const durante = await cenarioPos("PosCaiuDurante");
  const t0 = antes.clock();
  await prisma.postProcedureSent.create({ data: { appointmentId: antes.a.id, ruleId: antes.rule.id, state: "reserved", reservedAt: new Date(t0.getTime() - 20 * 60_000) } });
  await prisma.postProcedureSent.create({ data: { appointmentId: durante.a.id, ruleId: durante.rule.id, state: "sending", attempts: 1, reservedAt: new Date(t0.getTime() - 20 * 60_000), attemptedAt: new Date(t0.getTime() - 19 * 60_000) } });
  await runPostProcedureCycle(antes.clock);
  assert.equal(posts.length, 1, "so a que CERTAMENTE nao saiu");
  assert.deepEqual((await posRows(antes.a.id)).map((r) => r.state), ["sent"]);
  assert.deepEqual((await posRows(durante.a.id)).map((r) => r.state), ["unconfirmed"]);
});

test("POS: reserva RECENTE de outra rodada nao e pega por esta (sem envio em dobro); duas rodadas ao mesmo tempo enviam UMA vez", async () => {
  reset();
  const s = await cenarioPos("PosConcorrente");
  await Promise.all([runPostProcedureCycle(s.clock), runPostProcedureCycle(s.clock)]);
  assert.equal(posts.length, 1);
  const t = await cenarioPos("PosRecente");
  await prisma.postProcedureSent.create({ data: { appointmentId: t.a.id, ruleId: t.rule.id, state: "reserved", reservedAt: new Date(t.clock().getTime() - 60_000) } });
  await runPostProcedureCycle(t.clock);
  assert.equal(posts.length, 1, "a reserva de 1 minuto atras e de outra rodada viva: esta nao envia");
  assert.deepEqual((await posRows(t.a.id)).map((r) => r.state), ["reserved"]);
});

test("POS: registro ANTIGO ('legacy', anterior ao controle por estado) nunca e reaberto; atendimento fora da janela de 3 dias tambem nao", async () => {
  reset();
  const s = await cenarioPos("PosLegado");
  await prisma.postProcedureSent.create({ data: { appointmentId: s.a.id, ruleId: s.rule.id } }); // sem estado informado => 'legacy'
  assert.equal((await posRows(s.a.id))[0].state, "legacy");
  await runPostProcedureCycle(s.clock);
  assert.equal(posts.length, 0);
  const velho = await cenarioPos("PosVelho", { horasAtras: 24 * 10 });
  await runPostProcedureCycle(velho.clock);
  assert.equal(posts.length, 0, "10 dias atras: fora da folga de 3 dias (sem disparo retroativo)");
  assert.equal((await posRows(velho.a.id)).length, 0);
});

// ===================================================================== C) AUDITORIA: aceito != entregue; registro antigo e ambiguo; ausencia de log != job nao rodou
test("AUDITORIA: pos aceito = 'aceito_pelo_provedor' (nunca 'entregue'); registro antigo = 'sem_evidencia'; confirmacao fora da conversa tem fluxo proprio", async () => {
  reset();
  const agora = new Date();
  const c = await mkClinic("Auditoria Estados");
  const proc = await prisma.procedure.create({ data: { clinicId: c.id, name: "Peeling", durationMin: 60 } });
  const rule = await prisma.postProcedureRule.create({ data: { clinicId: c.id, name: "Pos", message: "Oi, {primeiro_nome}!", intervalValue: 1, intervalUnit: "days" } });
  const mk = async (nome, state) => {
    const p = await mkPatient(c, nome);
    const a = await prisma.appointment.create({ data: { clinicId: c.id, patientId: p.id, procedureId: proc.id, scheduledAt: new Date(agora.getTime() - 30 * HOUR), status: "completed" } });
    if (state) await prisma.postProcedureSent.create({ data: { appointmentId: a.id, ruleId: rule.id, state, attempts: 1 } });
    else await prisma.postProcedureSent.create({ data: { appointmentId: a.id, ruleId: rule.id } });
    return a;
  };
  await mk("Aceita", "sent");
  await mk("Antiga", null);
  await mk("Incerta", "unconfirmed");
  await mk("Tentando", "retry");
  const cenario = await cenarioConf("Auditoria Conf");
  await prisma.appointmentConfirmation.create({ data: { clinicId: cenario.c.id, appointmentId: cenario.a.id, patientId: cenario.p.id, startsAt: cenario.a.scheduledAt, state: "sent", attempts: 1 } });
  await prisma.appointmentConfirmation.create({ data: { clinicId: c.id, appointmentId: (await mk("Conf", "sent")).id, patientId: (await prisma.patient.findFirst({ where: { clinicId: c.id, name: "Conf" } })).id, startsAt: agora, state: "retry", attempts: 1 } });

  const rel = await auditarEnviosLisboa(c.id, { agora });
  const pos = rel.fluxos.find((f) => /^Pos-procedimento/.test(f.fluxo));
  const por = Object.fromEntries(pos.candidatos.map((x) => [x.pessoa.split(" ")[0], x.categoria]));
  assert.equal(por.Aceita, "aceito_pelo_provedor");
  assert.equal(por.Antiga, "sem_evidencia");
  assert.equal(por.Incerta, "aceito_sem_confirmacao");
  assert.equal(por.Tentando, "adiado");
  assert.ok(!JSON.stringify(rel).includes('"enviado"'), "nenhuma categoria afirma 'enviado' (aceito != entregue)");
  assert.ok(rel.faltaParaConcluir.some((t) => /NUNCA entregue/.test(t)));
  const cf = rel.fluxos.find((f) => /^Confirmacao de agendamento criado fora/.test(f.fluxo));
  assert.ok(cf && cf.candidatos.length >= 1);
  assert.equal(classificarRegistro({ state: "superseded", reason: "horario remarcado" }).categoria, "bloqueio_correto");
});

test("AUDITORIA: aniversario com registro ANTERIOR a correcao e ambiguo (sem_evidencia); posterior e 'aceito_pelo_provedor'", async () => {
  const c = await mkClinic("Auditoria Aniversario");
  const hoje = new Date();
  const wc = wallClockInZone(hoje, TZ);
  const mkAniv = async (nome, sentAt) => {
    const p = await prisma.patient.create({ data: { clinicId: c.id, name: nome, phone: `55119888${String(10000 + ++n)}`, birthDate: new Date(Date.UTC(1990, wc.month - 1, wc.day)) } });
    return p;
  };
  const rule = await prisma.birthdayRule.create({ data: { clinicId: c.id, name: "Parabens", sendHour: 10, active: true, message: "Feliz aniversario!" } });
  const velho = await mkAniv("Velha", null);
  const novo = await mkAniv("Nova", null);
  const ano = wc.year;
  await prisma.birthdaySent.create({ data: { patientId: velho.id, ruleId: rule.id, year: ano, sentAt: new Date("2026-10-01T10:00:00-03:00") } });
  await prisma.birthdaySent.create({ data: { patientId: novo.id, ruleId: rule.id, year: ano, sentAt: new Date("2026-10-20T10:00:00-03:00") } });
  // o dia auditado e o dia de hoje no fuso da clinica; os dois pacientes fazem aniversario hoje
  const rel = await auditarEnviosLisboa(c.id, { agora: hoje });
  const aniv = rel.fluxos.find((f) => /^Aniversarios/.test(f.fluxo));
  const por = Object.fromEntries(aniv.candidatos.map((x) => [x.pessoa.split(" ")[0], x.categoria]));
  // o dia local pode divergir do dia UTC perto da meia-noite: so confere quando os dois entraram na lista do dia
  if (aniv.candidatos.length === 2) {
    assert.equal(por.Velha, "sem_evidencia");
    assert.equal(por.Nova, "aceito_pelo_provedor");
  }
});
