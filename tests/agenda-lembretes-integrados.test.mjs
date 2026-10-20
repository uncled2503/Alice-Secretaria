// LEMBRETES / PREVIA / ACOMPANHANTE / ANIVERSARIO / PREPARO / POS - revisao integrada 21/10/2026.
// Banco de verdade (SQLite temporario), relogio controlado, WhatsApp e OpenAI simulados. Nada e enviado de verdade. Dados ficticios.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dbFile = path.join(os.tmpdir(), `alice-agenda-integrada-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY = "test-key";
process.env.AI_SEND_REVIEW = "on";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const posts = [];
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const completion = (content) => ({ id: "c", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.includes("openai.com")) {
    const body = JSON.parse(init.body);
    if (/REVISOR (DE ENVIO|das respostas)/.test(String(body.messages?.[0]?.content))) return jsonRes(200, completion({ decisao: "enviar", confianca: "alta", motivo: "ok", categoria: "outro" }));
    return jsonRes(200, completion("{}"));
  }
  if (u.hostname.endsWith("uazapi.com")) {
    if (u.pathname === "/send/text") { const b = JSON.parse(init.body); posts.push({ number: b.number, text: b.text }); return jsonRes(200, { id: "msg" }); }
    return jsonRes(200, { instance: { status: "connected" }, status: { connected: true } });
  }
  return jsonRes(404, {});
};

const { prisma } = await import("../dist/db/client.js");
const cron = await import("../dist/reminders/cron.js");
const { previewReminders } = await import("../dist/reminders/preview.js");
const ledger = await import("../dist/reminders/ledger.js");
const { runBirthdayCycle, isBirthdayToday } = await import("../dist/reminders/birthday.js");
const { runPostProcedureCycle, skipsPostForEvaluation, postProcedureNameFor } = await import("../dist/reminders/postProcedure.js");
const pre = await import("../dist/reminders/preProcedure.js");
const { resolveCompanionTarget } = await import("../dist/scheduling/companions.js");
const { zonedWallClockToUtc, wallClockInZone, isoDateInZone } = await import("../dist/scheduling/time.js");

test.after(async () => {
  await (await import("../dist/jobs/background.js")).drainBackground();
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* temporario */ } }
});

const TZ = "America/Sao_Paulo";
let tokenSeq = 0;
const mkClinic = (name, extra = {}) => prisma.clinic.create({
  data: { name, whatsappPhone: `55119${Math.floor(Math.random() * 1e8)}`, timezone: TZ, plan: "prime", active: true, aliceActive: true, uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: `tok-${++tokenSeq}`, ...extra },
});
let n = 0;
const phone = () => `5511966${String(40000 + ++n)}`;
const mkPatient = (clinic, extra = {}) => prisma.patient.create({ data: { clinicId: clinic.id, name: `Pessoa ${n + 1}`, phone: phone(), ...extra } });
const w0 = () => wallClockInZone(new Date(), TZ);
const dayAs = (offset, h, min = 0) => { const w = w0(); const d = new Date(Date.UTC(w.year, w.month - 1, w.day + offset)); return zonedWallClockToUtc(TZ, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), h, min); };
const hojeAs = (h, min = 0) => dayAs(0, h, min);
const amanhaAs = (h, min = 0) => dayAs(1, h, min);
const mkProc = (clinic, name, extra = {}) => prisma.procedure.create({ data: { clinicId: clinic.id, name, durationMin: 30, ...extra } });
const mkAppt = (clinic, patient, procedure, scheduledAt, extra = {}) => prisma.appointment.create({ data: { clinicId: clinic.id, patientId: patient.id, procedureId: procedure.id, scheduledAt, source: "whatsapp", createdAt: hojeAs(6, 0), ...extra } });

// regras A, B, C, D (as quatro da clinica): A confirma o dia seguinte (8-11h do dia anterior), B bom dia no dia (7-8h), C 4h antes, D cobranca de quem nao confirmou (17-18h do dia anterior)
async function regras(clinic) {
  const base = { clinicId: clinic.id, pauseMinSec: 0, pauseMaxSec: 0, active: true };
  const A = await prisma.reminderRule.create({ data: { ...base, hoursBefore: 24, dayOffset: 1, sendHour: 8, sendMinute: 0, sendEndHour: 11, message: "Olá, {primeiro_nome}!\n📅 Data: {data} (amanhã)\n⏰ Horário: {hora}\n💆 Procedimento: {procedimento}\nPosso confirmar a sua presença?" } });
  const B = await prisma.reminderRule.create({ data: { ...base, hoursBefore: 3, dayOffset: 0, sendHour: 7, sendMinute: 0, sendEndHour: 8, message: "Bom dia, {primeiro_nome}! Te esperamos hoje às {hora}." } });
  const C = await prisma.reminderRule.create({ data: { ...base, hoursBefore: 4, message: "Lembrete: hoje às {hora} voce tem {procedimento}." } });
  const D = await prisma.reminderRule.create({ data: { ...base, hoursBefore: 24, dayOffset: 1, sendHour: 17, sendMinute: 0, sendEndHour: 18, parentRuleId: A.id, message: "Olá, {primeiro_nome}! Ainda não recebemos a sua confirmação de amanhã às {hora}." } });
  return { A, B, C, D };
}
const msgOf = (row, rule) => row.messages.find((m) => m.ruleId === rule.id);

// ===================================================================== previa x regras A-D
test("previa: as 4 regras para uma reserva de amanha 14h - o que sai, quando e por que; sobreposicao B x C explicada", async () => {
  const c = await mkClinic("Previa ABCD");
  const { A, B, C, D } = await regras(c);
  const proc = await mkProc(c, "Botox");
  const p = await mkPatient(c, { name: "Ana Prado" });
  const a = await mkAppt(c, p, proc, amanhaAs(14, 0));
  const pv = await previewReminders(c.id, { day: "tomorrow", now: hojeAs(7, 30) });
  assert.equal(pv.rows.length, 1);
  const row = pv.rows[0];
  assert.equal(msgOf(row, A).status, "aguarda_janela");
  assert.equal(msgOf(row, B).status, "aguarda_janela");
  assert.equal(msgOf(row, C).status, "aguarda_janela");
  assert.equal(msgOf(row, D).status, "aguarda_regra_mae");
  assert.match(msgOf(row, A).reason, /08:00.*11:00/);
  assert.equal(msgOf(row, A).purpose, "dia_seguinte");
  assert.equal(msgOf(row, B).purpose, "do_dia");
  assert.equal(msgOf(row, C).purpose, "do_dia");
  assert.equal(msgOf(row, D).purpose, "cobranca");
  assert.equal(new Date(msgOf(row, C).from).getTime(), amanhaAs(10, 0).getTime(), "C = 4h antes de 14h");
  assert.equal(pv.overlaps.length, 1);
  assert.deepEqual([pv.overlaps[0].kind, pv.overlaps[0].gapMin], ["proximas", 120]);
  assert.match(pv.overlaps[0].control, /UMA por dia/, "B e C sao do mesmo tipo: o controle deixa sair so uma - dito na previa");
  void a;
});

test("previa dentro da janela: 'vai_enviar' com o texto como sairia; janela fechada = nao sai depois; reserva criada depois da janela = reposicao", async () => {
  const c = await mkClinic("Previa janelas");
  const { A } = await regras(c);
  const proc = await mkProc(c, "Botox");
  const p1 = await mkPatient(c, { name: "Bia Lima" });
  const p2 = await mkPatient(c, { name: "Carla Dias" });
  const p3 = await mkPatient(c, { name: "Dani Reis" });
  const a1 = await mkAppt(c, p1, proc, amanhaAs(14, 0));
  const a2 = await mkAppt(c, p2, proc, amanhaAs(15, 0), { createdAt: hojeAs(6, 0) });
  const a3 = await mkAppt(c, p3, proc, amanhaAs(16, 0), { createdAt: hojeAs(11, 30) }); // marcada DEPOIS de a janela das 8-11h fechar
  const dentro = await previewReminders(c.id, { day: "tomorrow", now: hojeAs(9, 0) });
  const r1 = dentro.rows.find((r) => r.appointmentId === a1.id);
  assert.equal(msgOf(r1, A).status, "vai_enviar");
  assert.match(msgOf(r1, A).text, /Bia/);
  assert.match(msgOf(r1, A).text, /\(amanhã\)/);
  const depois = await previewReminders(c.id, { day: "tomorrow", now: hojeAs(12, 0) });
  assert.equal(msgOf(depois.rows.find((r) => r.appointmentId === a2.id), A).status, "janela_encerrada");
  assert.match(msgOf(depois.rows.find((r) => r.appointmentId === a2.id), A).reason, /sem lote atrasado/);
  const rep = msgOf(depois.rows.find((r) => r.appointmentId === a3.id), A);
  assert.equal(rep.status, "vai_enviar");
  assert.match(rep.reason, /reposição/);
});

test("previa: a mesma conta do envio - ruleWindow e sendWindowOf concordam em todos os instantes (inclusive a virada de dia)", async () => {
  const c = await mkClinic("Previa equivalencia");
  const rs = await regras(c);
  const longeAntes = new Date(hojeAs(0, 0).getTime() - 30 * 24 * 3_600_000);
  for (const hora of [0, 7, 9, 14, 23]) {
    const scheduledAt = amanhaAs(hora, hora === 23 ? 30 : 0);
    for (const rule of Object.values(rs)) {
      const win = cron.ruleWindow(rule, scheduledAt, TZ);
      for (let min = -60 * 60; min <= 0; min += 20) {
        const now = new Date(scheduledAt.getTime() + min * 60_000);
        const inside = win.kind === "janela" ? now >= win.from && now < win.to : now >= win.from && now <= win.to;
        const s = cron.sendWindowOf(rule, { scheduledAt, createdAt: longeAntes }, now, TZ);
        assert.equal(s === "window", inside && scheduledAt > now, `${rule.id} ${hora}h ${now.toISOString()}`);
      }
    }
  }
});

test("cobranca (regra D): para quando o paciente confirma ou responde; so sai para quem recebeu a mae e nao reagiu", async () => {
  const c = await mkClinic("Cobranca");
  const { A, D } = await regras(c);
  const proc = await mkProc(c, "Botox");
  const p = await mkPatient(c, { name: "Eva Lopes" });
  const a = await mkAppt(c, p, proc, amanhaAs(14, 0));
  await prisma.reminderSent.create({ data: { appointmentId: a.id, ruleId: A.id, sentAt: hojeAs(9, 0) } });
  const agora = hojeAs(17, 30);
  let pv = await previewReminders(c.id, { day: "tomorrow", now: agora });
  assert.equal(msgOf(pv.rows[0], D).status, "vai_enviar");
  // respondeu depois da mensagem-mae
  const conv = await prisma.conversation.create({ data: { patientId: p.id } });
  await prisma.message.create({ data: { conversationId: conv.id, role: "user", content: "pode ser", createdAt: hojeAs(10, 0) } });
  pv = await previewReminders(c.id, { day: "tomorrow", now: agora });
  assert.equal(msgOf(pv.rows[0], D).status, "nao_se_aplica");
  assert.match(msgOf(pv.rows[0], D).reason, /respondeu/);
  await prisma.message.deleteMany({ where: { conversationId: conv.id } });
  // confirmou
  await prisma.appointment.update({ where: { id: a.id }, data: { patientConfirmed: true, confirmedAt: hojeAs(12, 0) } });
  pv = await previewReminders(c.id, { day: "tomorrow", now: agora });
  assert.match(msgOf(pv.rows[0], D).reason, /já confirmou/);
  // e o ENVIO real tambem nao cobra quem confirmou
  posts.length = 0;
  await cron.runReminderCycle({ now: agora });
  assert.equal(posts.filter((x) => x.number === p.phone).length, 0);
  // sem confirmar, a cobranca sai UMA vez
  await prisma.appointment.update({ where: { id: a.id }, data: { patientConfirmed: false, confirmedAt: null } });
  await cron.runReminderCycle({ now: agora });
  assert.equal(posts.filter((x) => x.number === p.phone && /Ainda não recebemos/.test(x.text)).length, 1);
  await cron.runReminderCycle({ now: new Date(agora.getTime() + 15 * 60_000) });
  assert.equal(posts.filter((x) => x.number === p.phone && /Ainda não recebemos/.test(x.text)).length, 1, "nao repete");
});

test("casal no mesmo telefone: cada PESSOA recebe a propria confirmacao (com o proprio nome); a mesma pessoa com 2 horarios recebe uma so", async () => {
  const c = await mkClinic("Casal lembrete");
  const { A } = await regras(c);
  const proc = await mkProc(c, "Botox");
  const dela = await mkPatient(c, { name: "Maria Souza" });
  const att = await prisma.attendee.create({ data: { clinicId: c.id, contactPatientId: dela.id, name: "Carlos Souza" } });
  const a1 = await mkAppt(c, dela, proc, amanhaAs(14, 0));
  const a2 = await mkAppt(c, dela, proc, amanhaAs(14, 30), { attendeeId: att.id, bookedByPatientId: dela.id });
  const a3 = await mkAppt(c, dela, proc, amanhaAs(15, 0)); // segundo horario DELA no mesmo dia
  const pv = await previewReminders(c.id, { day: "tomorrow", now: hojeAs(9, 0) });
  const r = (id) => pv.rows.find((x) => x.appointmentId === id);
  assert.equal(msgOf(r(a1.id), A).status, "vai_enviar");
  assert.equal(msgOf(r(a2.id), A).status, "vai_enviar", "o marido e outra pessoa");
  assert.match(msgOf(r(a2.id), A).text, /Carlos/);
  assert.equal(msgOf(r(a3.id), A).status, "nao_se_aplica");
  assert.match(msgOf(r(a3.id), A).reason, /primeiro horário do dia/);
  posts.length = 0;
  await cron.runReminderCycle({ now: hojeAs(9, 0) });
  const meus = posts.filter((x) => x.number === dela.phone);
  assert.equal(meus.length, 2);
  assert.ok(meus.some((x) => /Maria/.test(x.text)) && meus.some((x) => /Carlos/.test(x.text)));
  await cron.runReminderCycle({ now: hojeAs(9, 20) });
  assert.equal(posts.filter((x) => x.number === dela.phone).length, 2, "segunda rodada nao repete");
  void a3;
});

test("WhatsApp fora do ar: a previa avisa e marca 'aguarda_conexao'; reserva ja passada nao recebe nada", async () => {
  const c = await mkClinic("Previa whatsapp", { uazapiDownSince: new Date(Date.now() - 3_600_000), uazapiDownReason: "desconectado" });
  const { A } = await regras(c);
  const proc = await mkProc(c, "Botox");
  const p = await mkPatient(c);
  await mkAppt(c, p, proc, amanhaAs(14, 0));
  const passada = await mkAppt(c, await mkPatient(c), proc, hojeAs(8, 0));
  const pv = await previewReminders(c.id, { day: "tomorrow", now: hojeAs(9, 0) });
  assert.equal(pv.whatsapp.paused, true);
  assert.equal(msgOf(pv.rows[0], A).status, "aguarda_conexao");
  const hoje = await previewReminders(c.id, { day: "today", now: hojeAs(12, 0) });
  const rowPassada = hoje.rows.find((r) => r.appointmentId === passada.id);
  assert.ok(rowPassada.messages.every((m) => m.status === "nao_se_aplica"));
});

test("regra do mesmo tipo ja tratou a reserva: a previa mostra o bloqueio por duplicidade; clinicas nao se misturam", async () => {
  const c = await mkClinic("Previa dedup");
  const { B, C } = await regras(c);
  const proc = await mkProc(c, "Botox");
  const p = await mkPatient(c);
  const a = await mkAppt(c, p, proc, amanhaAs(14, 0));
  await prisma.reminderDispatch.create({ data: { clinicId: c.id, bookingKey: `appt:${a.id}`, appointmentId: a.id, patientId: p.id, ruleId: B.id, kind: "do_dia", startsAt: a.scheduledAt, sendDay: isoDateInZone(a.scheduledAt, TZ), state: "sent" } });
  const pv = await previewReminders(c.id, { day: "today", now: amanhaAs(7, 30) }); // (agora = amanha 7h30: a reserva e "hoje")
  assert.equal(msgOf(pv.rows[0], B).status, "enviado");
  assert.equal(msgOf(pv.rows[0], C).status, "bloqueado");
  assert.match(msgOf(pv.rows[0], C).reason, /mesmo tipo/);
  const outra = await mkClinic("Outra clinica");
  assert.equal((await previewReminders(outra.id, { day: "today", now: amanhaAs(7, 30) })).rows.length, 0);
});

test("controle de envio: duas rodadas ao mesmo tempo reservam UMA vez so; reserva sem desfecho vira 'sem confirmacao' (nunca reenvia)", async () => {
  const c = await mkClinic("Ledger");
  const { A } = await regras(c);
  const proc = await mkProc(c, "Botox");
  const p = await mkPatient(c);
  const a = await mkAppt(c, p, proc, amanhaAs(14, 0));
  const key = { clinicId: c.id, bookingKey: `appt:${a.id}`, appointmentId: a.id, patientId: p.id, ruleId: A.id, kind: "dia_seguinte", startsAt: a.scheduledAt, sendDay: isoDateInZone(hojeAs(9), TZ) };
  const [x, y] = await Promise.all([ledger.acquireDispatch(key), ledger.acquireDispatch(key)]);
  assert.equal([x, y].filter((r) => r.ok).length, 1);
  // o processo caiu depois de reservar: passado o tempo, a linha vira 'unconfirmed' e ninguem mais envia
  const depois = new Date(Date.now() + 31 * 60_000);
  const z = await ledger.acquireDispatch(key, depois);
  assert.equal(z.ok, false);
  assert.equal((await prisma.reminderDispatch.findFirst({ where: { bookingKey: key.bookingKey, ruleId: A.id } })).state, "unconfirmed");
});

// ===================================================================== acompanhante (agendar para outra pessoa)
test("agendar para a outra pessoa: nome completo + como falar com ela; telefone dividido so se a pessoa disser", async () => {
  const c = await mkClinic("Companheiro");
  const eu = await mkPatient(c, { name: "Maria Souza" });
  let r = await resolveCompanionTarget(c.id, eu.id, { fullName: "Carlos" });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /NOME COMPLETO/);
  r = await resolveCompanionTarget(c.id, eu.id, { fullName: "Carlos Souza" });
  assert.equal(r.ok, false, "sem dizer como falar com ele, nada e cadastrado");
  assert.equal(await prisma.attendee.count({ where: { clinicId: c.id } }), 0);
  r = await resolveCompanionTarget(c.id, eu.id, { fullName: "Maria  souza" });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /propria pessoa/);
  r = await resolveCompanionTarget(c.id, eu.id, { fullName: "Carlos Souza", relation: "marido", sharesPhone: true });
  assert.equal(r.ok, true);
  assert.equal(r.shared, true);
  assert.equal(r.patientId, eu.id);
  assert.ok(r.attendeeId);
  const again = await resolveCompanionTarget(c.id, eu.id, { fullName: "carlos souza", sharesPhone: true });
  assert.equal(again.attendeeId, r.attendeeId, "idempotente: nao cria outro acompanhante");
  assert.equal((await prisma.patient.findUnique({ where: { id: eu.id } })).name, "Maria Souza", "o cadastro de quem conversa nao muda");
});

test("acompanhante com telefone PROPRIO vira cadastro proprio; telefone ja de outra pessoa nao e usado; o mesmo telefone dito como proprio e compartilhado", async () => {
  const c = await mkClinic("Companheiro 2");
  const eu = await mkPatient(c, { name: "Ana Prado", phone: "5511911112222" });
  const r = await resolveCompanionTarget(c.id, eu.id, { fullName: "Paulo Prado", phone: "(11) 93333-4444" });
  assert.equal(r.ok, true);
  assert.equal(r.shared, false);
  assert.notEqual(r.patientId, eu.id);
  assert.equal(r.bookedByPatientId, eu.id);
  const novo = await prisma.patient.findUnique({ where: { id: r.patientId } });
  assert.equal(novo.phone, "5511933334444");
  assert.equal(novo.name, "Paulo Prado");
  await prisma.patient.create({ data: { clinicId: c.id, name: "Rosa Tavares", phone: "5511955556666" } });
  const conflito = await resolveCompanionTarget(c.id, eu.id, { fullName: "Paulo Prado", phone: "11955556666" });
  assert.equal(conflito.ok, false);
  assert.match(conflito.motivo, /outra pessoa/);
  const mesmo = await resolveCompanionTarget(c.id, eu.id, { fullName: "Paulo Prado", phone: "11 91111-2222" });
  assert.equal(mesmo.ok, true);
  assert.equal(mesmo.shared, true);
  assert.equal((await resolveCompanionTarget(c.id, eu.id, { fullName: "Paulo Prado", phone: "123" })).ok, false);
});

// ===================================================================== aniversario
test("aniversario: 29/02 comemora em 28/02 nos anos nao bissextos; data guardada em UTC nao desloca o dia", () => {
  const nasc = new Date(Date.UTC(1996, 1, 29));
  assert.equal(isBirthdayToday(nasc, { year: 2027, month: 2, day: 28 }), true);
  assert.equal(isBirthdayToday(nasc, { year: 2027, month: 3, day: 1 }), false);
  assert.equal(isBirthdayToday(nasc, { year: 2028, month: 2, day: 29 }), true);
  assert.equal(isBirthdayToday(nasc, { year: 2028, month: 2, day: 28 }), false, "no ano bissexto vale o proprio 29");
  assert.equal(isBirthdayToday(new Date(Date.UTC(1990, 2, 1)), { year: 2027, month: 3, day: 1 }), true);
  assert.equal(isBirthdayToday(new Date(Date.UTC(1990, 2, 1)), { year: 2027, month: 2, day: 28 }), false);
});

test("aniversario: fora (opt-out, inativo, telefone invalido), telefone repetido recebe uma vez, reserva antes do envio, regra nova no mesmo dia nao repete", async () => {
  const c = await mkClinic("Aniversario integrado");
  const regra = await prisma.birthdayRule.create({ data: { clinicId: c.id, name: "Parabéns", sendHour: 10, active: true, message: "Feliz aniversário, {primeiro_nome}!" } });
  const w = w0();
  const nasc = new Date(Date.UTC(1990, w.month - 1, w.day));
  const ok = await mkPatient(c, { name: "Ok Pessoa", birthDate: nasc });
  const optout = await mkPatient(c, { name: "Sai Fora", birthDate: nasc, optedOut: true });
  const inativo = await mkPatient(c, { name: "Inativo", birthDate: nasc, active: false });
  const semTel = await prisma.patient.create({ data: { clinicId: c.id, name: "Sem Telefone", phone: "12345", birthDate: nasc } });
  const dup1 = await prisma.patient.create({ data: { clinicId: c.id, name: "Dupla Um", phone: "5511977771111", birthDate: nasc, createdAt: new Date(Date.now() - 5000) } });
  const dup2 = await prisma.patient.create({ data: { clinicId: c.id, name: "Dupla Dois", phone: "11977771111", birthDate: nasc } });
  posts.length = 0;
  await runBirthdayCycle(hojeAs(10, 5), { clinicId: c.id });
  const nums = posts.map((x) => x.number).sort();
  assert.deepEqual(nums, [dup1.phone, ok.phone].sort(), "so quem pode receber, e o mesmo telefone uma vez");
  const estados = await prisma.birthdaySent.findMany({ where: { ruleId: regra.id } });
  assert.equal(estados.length, 2);
  assert.ok(estados.every((e) => e.state === "sent"));
  for (const x of [optout, inativo, semTel, dup2]) assert.equal(posts.some((p) => p.number === x.phone), false);
  // outra regra ativa no mesmo dia (ou a mensagem editada): quem ja recebeu neste ano nao recebe de novo
  await prisma.birthdayRule.create({ data: { clinicId: c.id, name: "Parabéns 2", sendHour: 10, active: true, message: "Parabéns, {primeiro_nome}!" } });
  await runBirthdayCycle(hojeAs(11, 5), { clinicId: c.id });
  assert.equal(posts.length, 2);
});

test("aniversario: reserva sem desfecho (processo caiu no envio) vira 'sem confirmacao' e NUNCA e reenviada", async () => {
  const c = await mkClinic("Aniversario reserva");
  const regra = await prisma.birthdayRule.create({ data: { clinicId: c.id, name: "Parabéns", sendHour: 10, active: true, message: "Feliz aniversário!" } });
  const w = w0();
  const p = await mkPatient(c, { name: "Caiu No Meio", birthDate: new Date(Date.UTC(1991, w.month - 1, w.day)) });
  await prisma.birthdaySent.create({ data: { patientId: p.id, ruleId: regra.id, year: w.year, state: "reserved", sentAt: new Date(hojeAs(11, 5).getTime() - 2 * 3_600_000) } });
  posts.length = 0;
  await runBirthdayCycle(hojeAs(11, 5), { clinicId: c.id });
  assert.equal(posts.length, 0);
  assert.equal((await prisma.birthdaySent.findFirst({ where: { patientId: p.id } })).state, "unconfirmed");
});

// ===================================================================== pos-procedimento e preparo
test("pos: reserva com varios procedimentos vale pelo que a regra lista; cita o procedimento certo e o nome de quem foi ATENDIDO; confirmada (so passou a hora) e historico antigo nao saem", async () => {
  const c = await mkClinic("Pos integrado");
  const procA = await mkProc(c, "Limpeza de pele");
  const procB = await mkProc(c, "Peeling");
  const regra = await prisma.postProcedureRule.create({ data: { clinicId: c.id, name: "Pós peeling", message: "Oi {primeiro_nome}, como foi o {procedimento}?", intervalValue: 1, intervalUnit: "days", onlyIfCompleted: true, procedureIds: procB.id } });
  const dela = await mkPatient(c, { name: "Maria Souza" });
  const att = await prisma.attendee.create({ data: { clinicId: c.id, contactPatientId: dela.id, name: "Carlos Souza" } });
  const dois = dayAs(-2, 11, 0);
  const a1 = await mkAppt(c, dela, procA, dois, { status: "completed", attendeeId: att.id });
  await prisma.appointmentProcedure.createMany({ data: [{ appointmentId: a1.id, procedureId: procA.id, name: "Limpeza de pele", position: 0 }, { appointmentId: a1.id, procedureId: procB.id, name: "Peeling", position: 1 }] });
  const outra = await mkPatient(c, { name: "Nao Atendida" });
  await mkAppt(c, outra, procB, dois, { status: "confirmed" }); // so passou a hora: nao e atendimento
  const velha = await mkPatient(c, { name: "Historico Velho" });
  await mkAppt(c, velha, procB, dayAs(-6, 11, 0), { status: "completed" }); // registrado muito depois: nao varre o historico
  posts.length = 0;
  await runPostProcedureCycle(() => hojeAs(12, 0));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].number, dela.phone);
  assert.match(posts[0].text, /Carlos/);
  assert.match(posts[0].text, /Peeling/);
  await runPostProcedureCycle(() => hojeAs(12, 30));
  assert.equal(posts.length, 1, "uma vez por atendimento e regra");
  assert.equal(postProcedureNameFor({ procedureId: procA.id, procedure: { name: "A" }, procedures: [{ procedureId: procB.id, name: "B" }] }, [procB.id]), "B");
  assert.equal(skipsPostForEvaluation({ procedureId: "x", procedure: { name: "Avaliação" }, procedures: [{ procedureId: "y", name: "Botox" }] }, []), false);
  assert.equal(skipsPostForEvaluation({ procedureId: "x", procedure: { name: "Avaliação" }, procedures: [] }, []), true);
  void regra;
});

test("preparo: a regra vale para QUALQUER procedimento da reserva; troca de procedimento invalida a orientacao reservada do antigo", async () => {
  assert.equal(pre.ruleCoversReservation("p1", { procedureId: "p9", procedures: [{ procedureId: "p1" }] }), true);
  assert.equal(pre.ruleCoversReservation("p1", { procedureId: "p9", procedures: [{ procedureId: "p2" }] }), false);
  assert.equal(pre.ruleCoversReservation("", { procedureId: "p9" }), true);
  assert.equal(pre.procedureNameForRule({ procedureIds: "p1" }, { procedureId: "p9", procedure: { name: "Principal" }, procedures: [{ procedureId: "p1", name: "Da regra" }] }), "Da regra");

  const c = await mkClinic("Preparo integrado");
  const procA = await mkProc(c, "Botox");
  const procB = await mkProc(c, "Peeling");
  const regra = await prisma.preProcedureRule.create({ data: { clinicId: c.id, name: "Preparo botox", message: "Obrigada pela confirmação, {primeiro_nome}!\nPreparo do {procedimento}: sem álcool 24h antes.", procedureIds: procA.id, sendHoursBefore: 48, active: true } });
  const p = await mkPatient(c, { name: "Bruna Reis" });
  // reservado para o procedimento A; depois o procedimento da reserva virou B (a recepcao trocou): a orientacao do botox NAO sai
  const a = await mkAppt(c, p, procB, amanhaAs(10, 0));
  await prisma.preProcedureSent.create({ data: { appointmentId: a.id, ruleId: regra.id, state: "reserved", channel: "antecipado", reservedAt: new Date(hojeAs(12, 0).getTime() - 2 * 3_600_000) } });
  posts.length = 0;
  await pre.reconcilePreProcedure(hojeAs(12, 0));
  assert.equal(posts.length, 0);
  assert.equal((await prisma.preProcedureSent.findFirst({ where: { appointmentId: a.id } })).state, "superseded");
  // reserva com DOIS procedimentos, um deles coberto pela regra: sai uma vez, citando o procedimento da regra
  const q = await mkPatient(c, { name: "Carol Dias" });
  const b = await mkAppt(c, q, procB, amanhaAs(11, 0));
  await prisma.appointmentProcedure.createMany({ data: [{ appointmentId: b.id, procedureId: procB.id, name: "Peeling", position: 0 }, { appointmentId: b.id, procedureId: procA.id, name: "Botox", position: 1 }] });
  await pre.sendAdvancePreProcedure(hojeAs(12, 0));
  const dela = posts.filter((x) => x.number === q.phone);
  assert.equal(dela.length, 1);
  assert.match(dela[0].text, /Botox/);
  await pre.sendAdvancePreProcedure(hojeAs(12, 30));
  assert.equal(posts.filter((x) => x.number === q.phone).length, 1, "nao repete");
});
