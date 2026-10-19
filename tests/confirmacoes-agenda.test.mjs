// CONFIRMACOES (lembretes) x CLINICA EXPERTS x CONTROLE PERSISTENTE, de ponta a ponta com banco de verdade, RELOGIO CONTROLADO (runReminderCycle({ now })),
// CE e UAZAPI simulados. Cobre o relato da Lisboa de 16/10/2026: horario errado (9h30), confirmacao repetida no mesmo dia, reserva sem procedimento,
// cancelada/remarcada recebendo o horario antigo, e o que fazer quando o CE nao responde.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dbFile = path.join(os.tmpdir(), `alice-confirmacoes-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY = "test-key";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

// ---------------- redes simuladas ----------------
const enviados = []; // { phone, text } aceitos pela UAZAPI
let sendMode = "ok"; // ok | timeout | http500 | nowhatsapp
let sendAttempts = 0;
let vetoNext = false; // a revisao por IA barra a proxima mensagem automatica
const ceCalls = []; // caminhos consultados no CE
let ceDetail = () => ({ status: 404, body: {} }); // GET /bookings/{uuid}
let ceList = () => []; // GET /bookings (lista do dia)
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const completion = (content) => ({ id: "c", object: "chat.completion", created: 1, model: "gpt-4o-mini", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.includes("openai.com")) {
    if (vetoNext) { vetoNext = false; return jsonRes(200, completion({ decisao: "nao_enviar", confianca: "alta", motivo: "teste de veto" })); }
    return jsonRes(200, completion({ decisao: "enviar", confianca: "alta", motivo: "ok" }));
  }
  if (u.hostname.endsWith("uazapi.com") && u.pathname === "/send/text") {
    sendAttempts++;
    const b = JSON.parse(init.body);
    if (sendMode === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    if (sendMode === "http500") return jsonRes(500, { error: "falha interna" });
    if (sendMode === "nowhatsapp") return jsonRes(400, { message: "number is not on WhatsApp" });
    enviados.push({ phone: b.number, text: b.text });
    return jsonRes(200, { id: "m" });
  }
  if (u.hostname.includes("clinicaexperts")) {
    ceCalls.push(u.pathname);
    const mDetail = /\/bookings\/([^/]+)$/.exec(u.pathname);
    if (mDetail) {
      const r = await ceDetail(mDetail[1]);
      if (r instanceof Error) throw r;
      return jsonRes(r.status, r.body);
    }
    if (u.pathname.endsWith("/bookings")) return jsonRes(200, { data: await ceList() });
    return jsonRes(200, { data: [] });
  }
  return jsonRes(200, {});
};

const { prisma } = await import("../dist/db/client.js");
const { encryptSecret } = await import("../dist/meta/secretBox.js");
const { runReminderCycle } = await import("../dist/reminders/cron.js");
const { acquireDispatch, dispatchTrail, bookingKeyOf, MAX_DEFERRALS } = await import("../dist/reminders/ledger.js");
const { pullClinicBookings } = await import("../dist/clinicaexperts/pull.js");
const { PLACEHOLDER_PROCEDURE_NAME } = await import("../dist/clinicaexperts/placeholderProcedure.js");
const { renderMessageTemplate } = await import("../dist/crm/template.js");
const { zonedWallClockToUtc } = await import("../dist/scheduling/time.js");

test.after(async () => {
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* arquivo temporario */ } }
});

// ---------------- cenario ----------------
const SP = "America/Sao_Paulo";
const uniq = () => Math.random().toString(36).slice(2, 8);
const MSG_AMANHA = "Olá, {primeiro_nome}! Tudo bem?\n\n📅 Data: {data} (amanhã)\n⏰ Horário: {hora}\n💆 Procedimento: {procedimento}\n\nPosso confirmar a sua presença?";
const MSG_HOJE = "Bom dia, {primeiro_nome}! Estamos felizes em te receber hoje às {hora} 🥰";
const MSG_COBRANCA = "Olá, {primeiro_nome}! Ainda não recebemos a sua confirmação para amanhã:\n⏰ Horário: {hora}\n💆 Procedimento: {procedimento}";

async function mkClinic(name, { tz = SP, withCe = false } = {}) {
  const clinic = await prisma.clinic.create({
    data: { name, whatsappPhone: `55119${Math.floor(Math.random() * 1e8)}`, timezone: tz, plan: "prime", uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: `tok-${uniq()}${uniq()}`, notifyPhone: `55119${Math.floor(10000000 + Math.random() * 8e7)}`, notifyEvents: "automation_failed" },
  });
  if (withCe) await prisma.clinicaExpertsAccount.create({ data: { clinicId: clinic.id, tokenEnc: encryptSecret("token-de-teste-com-mais-de-vinte-caracteres"), tokenHint: "••••test" } });
  const botox = await prisma.procedure.create({ data: { clinicId: clinic.id, name: "Botox", durationMin: 30, ceId: 111 } });
  const rBase = { clinicId: clinic.id, pauseMinSec: 0, pauseMaxSec: 0, active: true };
  const parent = await prisma.reminderRule.create({ data: { ...rBase, hoursBefore: 24, dayOffset: 1, sendHour: 8, sendMinute: 0, sendEndHour: 11, message: MSG_AMANHA } });
  const hoje = await prisma.reminderRule.create({ data: { ...rBase, hoursBefore: 3, dayOffset: 0, sendHour: 7, sendMinute: 0, sendEndHour: 8, message: MSG_HOJE } });
  const filha = await prisma.reminderRule.create({ data: { ...rBase, hoursBefore: 24, dayOffset: 1, sendHour: 16, sendMinute: 0, sendEndHour: 17, parentRuleId: parent.id, message: MSG_COBRANCA } });
  return { clinic, botox, parent, hoje, filha };
}

let seq = 0;
async function mkAppt(c, { when, uuid = null, name = "Maria Silva", procedureId, confirmed = false } = {}) {
  seq++;
  const patient = await prisma.patient.create({ data: { clinicId: c.clinic.id, name, phone: `5511933${String(30000 + seq)}` } });
  const appt = await prisma.appointment.create({
    data: { clinicId: c.clinic.id, patientId: patient.id, procedureId: procedureId ?? c.botox.id, scheduledAt: when, ceBookingUuid: uuid, source: "presencial", patientConfirmed: confirmed },
  });
  return { patient, appt };
}
const sentTo = (patient) => enviados.filter((e) => e.phone === patient.phone);
const resetNet = () => { enviados.length = 0; ceCalls.length = 0; sendMode = "ok"; sendAttempts = 0; vetoNext = false; ceDetail = () => ({ status: 404, body: {} }); ceList = () => []; };
const spUtc = (y, m, d, h, mi = 0, tz = SP) => zonedWallClockToUtc(tz, y, m, d, h, mi);
// Dia do atendimento nos testes de relogio fixo: terca 15/12/2026; a confirmacao do dia seguinte sai na segunda 14/12 entre 8h e 11h.
const T = (h, mi = 0, tz = SP) => spUtc(2026, 12, 15, h, mi, tz);
const DIA_ANTES = (h, mi = 0, tz = SP) => spUtc(2026, 12, 14, h, mi, tz);
const ceBody = (uuid, status, starts) => ({ status: 200, body: { data: { uuid, status, starts_at: starts } } });
// Envelhece o controle (intervalo entre tentativas) sem esperar de verdade.
const envelhecer = (minutos = 20) => prisma.reminderDispatch.updateMany({ data: { updatedAt: new Date(Date.now() - minutos * 60_000) } });
// Fixa o "ultimo movimento" do controle no relogio simulado da rodada (o banco usa a hora real; os testes de intervalo precisam do mesmo relogio).
const marcarEm = (quando) => prisma.reminderDispatch.updateMany({ data: { updatedAt: quando } });

// ================= HORARIO CERTO =================
test("9h30 vira 09:30 na confirmacao (fuso da clinica) - sem CE, e em outro fuso (Manaus) tambem", async () => {
  resetNet();
  const sp = await mkClinic(`Clinica SP ${uniq()}`);
  const a = await mkAppt(sp, { when: T(9, 30), name: "Ana Nove" });
  await runReminderCycle({ now: DIA_ANTES(9, 0) });
  const txt = sentTo(a.patient)[0]?.text ?? "";
  assert.match(txt, /Horário: 09:30/, txt);
  assert.match(txt, /Data: 15\/12\/2026 \(amanhã\)/, txt);
  assert.match(txt, /Procedimento: Botox/);
  assert.equal(sentTo(a.patient).length, 1);

  // Manaus (UTC-4): 9h30 locais = 13h30Z; antes o {hora} era formatado SEMPRE em Sao Paulo (08:30)
  const mn = await mkClinic(`Clinica Manaus ${uniq()}`, { tz: "America/Manaus" });
  const b = await mkAppt(mn, { when: T(9, 30, "America/Manaus"), name: "Bia Manaus" });
  assert.equal(b.appt.scheduledAt.toISOString(), "2026-12-15T13:30:00.000Z");
  await runReminderCycle({ now: DIA_ANTES(9, 0, "America/Manaus") });
  assert.match(sentTo(b.patient)[0]?.text ?? "", /Horário: 09:30/);
  assert.match(sentTo(b.patient)[0]?.text ?? "", /Data: 15\/12\/2026/);
  // o template e puro: o mesmo instante em fusos diferentes
  const ctx = { patientName: "X", patientPhone: "1", clinicName: "C", when: new Date("2026-12-15T12:30:00Z") };
  assert.equal(renderMessageTemplate("{hora}", { ...ctx, timeZone: SP }), "09:30");
  assert.equal(renderMessageTemplate("{hora}", { ...ctx, timeZone: "America/Manaus" }), "08:30");
  assert.equal(renderMessageTemplate("{hora}", ctx), "09:30", "sem fuso informado: Sao Paulo (compatibilidade)");
});

test("formatos de horario do CE na importacao: com fuso, Z, sem fuso (horario de parede da clinica), com espaco e com fracao viram o MESMO instante (09:30 de SP)", async () => {
  resetNet();
  const c = await mkClinic(`Clinica Formatos ${uniq()}`, { withCe: true });
  const amanha = new Intl.DateTimeFormat("en-CA", { timeZone: SP, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + 26 * 3_600_000));
  const alvoUtc = new Date(`${amanha}T12:30:00.000Z`);
  const formatos = [`${amanha}T09:30:00-03:00`, `${amanha}T12:30:00Z`, `${amanha}T09:30:00`, `${amanha} 09:30:00`, `${amanha}T09:30:00.000000-03:00`, `${amanha}T12:30:00.000Z`];
  ceList = () => formatos.map((f, i) => ({ uuid: `fmt-${i}`, status: "scheduled", starts_at: f, patient: { uuid: `pf-${i}`, name: `Fmt ${i}`, phone: `+55 11 98888-70${String(i).padStart(2, "0")}` }, procedures: [{ id: 111 }] }));
  const r = await pullClinicBookings(c.clinic.id);
  assert.equal(r.created, formatos.length, JSON.stringify(r));
  for (let i = 0; i < formatos.length; i++) {
    const a = await prisma.appointment.findFirst({ where: { clinicId: c.clinic.id, ceBookingUuid: `fmt-${i}` } });
    assert.equal(a?.scheduledAt.toISOString(), alvoUtc.toISOString(), `formato ${formatos[i]}`);
  }
  // importacao repetida: uma unica identidade por reserva
  await pullClinicBookings(c.clinic.id);
  await pullClinicBookings(c.clinic.id);
  assert.equal(await prisma.appointment.count({ where: { clinicId: c.clinic.id } }), formatos.length);
});

// ================= RESERVA SEM PROCEDIMENTO =================
test("reserva SEM procedimento: e importada (uma identidade so), confirmada com data/hora certas, sem nome tecnico nem 'avaliacao'; ao vincular o procedimento depois NAO reenvia", async () => {
  resetNet();
  const c = await mkClinic(`Clinica SemProc ${uniq()}`, { withCe: true });
  const amanha = new Intl.DateTimeFormat("en-CA", { timeZone: SP, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + 26 * 3_600_000));
  const [yy, mm, dd] = amanha.split("-").map(Number);
  let procedures = [];
  ceList = () => [{ uuid: "sem-proc-1", status: "scheduled", starts_at: `${amanha}T09:30:00-03:00`, patient: { uuid: "pp-1", name: "Milena Brandao", phone: "+55 11 97777-0001" }, procedures }];
  ceDetail = (uuid) => ceBody(uuid, "scheduled", `${amanha}T09:30:00-03:00`);
  await pullClinicBookings(c.clinic.id);
  await pullClinicBookings(c.clinic.id); // repetida
  const appts = await prisma.appointment.findMany({ where: { clinicId: c.clinic.id }, include: { procedure: true, patient: true } });
  assert.equal(appts.length, 1, "uma unica reserva, mesmo importada duas vezes");
  assert.equal(appts[0].procedure.name, PLACEHOLDER_PROCEDURE_NAME);
  assert.equal(appts[0].ceBookingUuid, "sem-proc-1", "a identidade da reserva no CE foi preservada");

  const noon = (d) => spUtc(yy, mm, d - 1 < 1 ? 1 : dd, 9, 0); // placeholder, recalculado abaixo
  void noon;
  const diaAntes = new Date(spUtc(yy, mm, dd, 9, 0).getTime() - 24 * 3_600_000);
  ceDetail = (uuid) => ceBody(uuid, "scheduled", `${amanha}T09:30:00-03:00`);
  await runReminderCycle({ now: diaAntes });
  const msgs = sentTo(appts[0].patient);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].text, /Horário: 09:30/);
  assert.match(msgs[0].text, new RegExp(`Data: ${String(dd).padStart(2, "0")}/${String(mm).padStart(2, "0")}/${yy}`));
  assert.ok(!/rocedimento|sem procedimento|Cl[ií]nica Experts|avalia/i.test(msgs[0].text), msgs[0].text);

  // a recepcao escolhe o procedimento no CE: a importacao troca pelo de verdade e NAO ha segundo envio
  procedures = [{ id: 111 }];
  await pullClinicBookings(c.clinic.id);
  const depois = await prisma.appointment.findFirst({ where: { clinicId: c.clinic.id }, include: { procedure: true } });
  assert.equal(depois.procedure.name, "Botox");
  assert.equal(await prisma.appointment.count({ where: { clinicId: c.clinic.id } }), 1);
  await runReminderCycle({ now: new Date(diaAntes.getTime() + 20 * 60_000) });
  assert.equal(sentTo(appts[0].patient).length, 1, "trocar o procedimento nao provoca reenvio");
});

// ================= CE: cancelada / apagada / remarcada / atendida / falta =================
test("CE: cancelada, apagada, remarcada, atendida e falta NAO recebem o lembrete do horario antigo - e cada estado mantem o SEU significado", async () => {
  resetNet();
  const c = await mkClinic(`Clinica Estados ${uniq()}`, { withCe: true });
  const mk = (n, uuid) => mkAppt(c, { when: T(10, 0), uuid, name: n });
  const cancelada = await mk("Bruna Cancelou", "u-canc");
  const apagada = await mk("Vania Apagada", "u-apag");
  const trocada = await mk("Maria Trocou", "u-troc");
  const atendida = await mk("Rita Atendida", "u-atend");
  const faltou = await mk("Joana Faltou", "u-falta");
  const ok = await mk("Carla Ok", "u-ok");
  const novoHorario = T(15, 0);
  ceDetail = (uuid) => ({
    "u-canc": ceBody(uuid, "canceled", T(10, 0).toISOString()),
    "u-apag": { status: 404, body: {} },
    "u-troc": ceBody(uuid, "scheduled", novoHorario.toISOString()),
    "u-atend": ceBody(uuid, "completed", T(10, 0).toISOString()),
    "u-falta": ceBody(uuid, "no_show", T(10, 0).toISOString()),
    "u-ok": ceBody(uuid, "scheduled", T(10, 0).toISOString()),
  })[uuid] ?? { status: 404, body: {} };
  await runReminderCycle({ now: DIA_ANTES(9, 0) });
  for (const x of [cancelada, apagada, trocada, atendida, faltou]) assert.equal(sentTo(x.patient).length, 0, x.patient.name);
  assert.equal(sentTo(ok.patient).length, 1);
  const st = async (x) => (await prisma.appointment.findUnique({ where: { id: x.appt.id } }));
  assert.equal((await st(cancelada)).status, "cancelled");
  assert.equal((await st(apagada)).status, "cancelled");
  assert.equal((await st(atendida)).status, "completed", "atendida NAO vira 'cancelada'");
  assert.equal((await st(faltou)).status, "no_show", "falta NAO vira 'cancelada'");
  assert.equal((await st(trocada)).status, "confirmed");
  assert.equal((await st(trocada)).scheduledAt.getTime(), novoHorario.getTime(), "horario corrigido a partir do CE");
  assert.ok(await prisma.activityLog.findFirst({ where: { patientId: atendida.patient.id, type: "appointment_completed" } }));
  assert.ok(await prisma.activityLog.findFirst({ where: { patientId: faltou.patient.id, type: "appointment_no_show" } }));
  // nenhuma delas consumiu o controle de envio
  assert.equal(await prisma.reminderDispatch.count({ where: { appointmentId: { in: [cancelada, apagada, atendida, faltou].map((x) => x.appt.id) } } }), 0);
});

// ================= CE inconclusivo: ADIA =================
test("CE com timeout / 401 / 500 / payload insuficiente: ADIA (nao envia, nao cancela, nao altera, nao consome); aviso unico agregado para a equipe; CE fora do ar nao e martelado", async () => {
  resetNet();
  const c = await mkClinic(`Clinica Inconclusivo ${uniq()}`, { withCe: true });
  const casos = [];
  for (const [nome, uuid] of [["Rede", "i-rede"], ["Token", "i-token"], ["Servidor", "i-500"], ["Payload", "i-payload"], ["Vazio", "i-vazio"]]) casos.push(await mkAppt(c, { when: T(10, 0), uuid, name: nome }));
  ceDetail = (uuid) => {
    if (uuid === "i-rede") return new Error("socket hang up");
    if (uuid === "i-token") return { status: 401, body: {} };
    if (uuid === "i-500") return { status: 500, body: {} };
    if (uuid === "i-payload") return { status: 200, body: { data: { uuid, starts_at: T(10, 0).toISOString() } } }; // sem status
    return { status: 200, body: null }; // 200 sem corpo
  };
  const avisosAntes = enviados.length;
  await runReminderCycle({ now: DIA_ANTES(9, 0) });
  for (const x of casos) {
    assert.equal(sentTo(x.patient).length, 0, `${x.patient.name}: nada enviado`);
    const a = await prisma.appointment.findUnique({ where: { id: x.appt.id } });
    assert.equal(a.status, "confirmed", "nao cancelou");
    assert.equal(a.scheduledAt.getTime(), T(10, 0).getTime(), "nao alterou o horario");
    assert.equal(await prisma.reminderSent.count({ where: { appointmentId: x.appt.id } }), 0, "nao consumiu o lembrete");
    const d = await prisma.reminderDispatch.findFirst({ where: { appointmentId: x.appt.id } });
    assert.equal(d?.state, "deferred", x.patient.name);
    assert.equal(d?.attempt, 1);
    assert.ok(d?.detail && d.detail.length > 0, "motivo registrado");
  }
  // aviso agregado e UNICO para a equipe (nao um por reserva) e o evento fica no diario
  const clinicRow = await prisma.clinic.findUnique({ where: { id: c.clinic.id } });
  const avisos = enviados.filter((e) => e.phone === clinicRow.notifyPhone.replace(/\D/g, ""));
  assert.equal(avisos.length, 1, "um aviso agregado");
  assert.match(avisos[0].text, /Não consegui conferir 5 agendamento\(s\) no Clínica Experts/);
  assert.ok(await prisma.activityLog.findFirst({ where: { clinicId: c.clinic.id, type: "reminder_deferred" } }));
  void avisosAntes;
  // rede/token/5xx (de sistema) 3x seguidas: o CE e dado como fora do ar e as demais nem chegam a ser consultadas
  assert.ok(ceCalls.filter((p) => /\/bookings\/i-/.test(p)).length <= 5);
});

test("recuperacao DENTRO da janela envia; FORA da janela nao dispara lembrete atrasado; e nunca duas vezes", async () => {
  resetNet();
  const c = await mkClinic(`Clinica Recupera ${uniq()}`, { withCe: true });
  const a = await mkAppt(c, { when: T(10, 0), uuid: "r-1", name: "Rosa Recupera" });
  const b = await mkAppt(c, { when: T(10, 0), uuid: "r-2", name: "Bete Tardia" });
  // 9h: CE fora do ar para as duas
  ceDetail = () => new Error("ECONNRESET");
  await runReminderCycle({ now: DIA_ANTES(9, 0) });
  assert.equal(enviados.filter((e) => [a, b].some((x) => x.patient.phone === e.phone)).length, 0);
  // 9h20: o CE voltou (e o intervalo entre tentativas passou): a Rosa recebe; a rodada tem o mesmo relogio da janela
  ceDetail = (uuid) => ceBody(uuid, "scheduled", T(10, 0).toISOString());
  await envelhecer(15);
  await runReminderCycle({ now: DIA_ANTES(9, 20) });
  assert.equal(sentTo(a.patient).length, 1);
  assert.equal(sentTo(b.patient).length, 1);
  const da = await prisma.reminderDispatch.findFirst({ where: { appointmentId: a.appt.id } });
  assert.equal(da.state, "sent");
  assert.equal(da.attempt, 2, "segunda tentativa registrada");
  // nao reenvia nas rodadas seguintes
  await runReminderCycle({ now: DIA_ANTES(9, 40) });
  assert.equal(sentTo(a.patient).length, 1);

  // FORA da janela: o CE so volta depois das 11h (janela 8h-11h encerrada)
  resetNet();
  const d = await mkAppt(c, { when: T(11, 0), uuid: "r-3", name: "Dora Atrasada" });
  ceDetail = () => new Error("ECONNRESET");
  await runReminderCycle({ now: DIA_ANTES(10, 50) });
  ceDetail = (uuid) => ceBody(uuid, "scheduled", T(11, 0).toISOString());
  await envelhecer(15);
  await runReminderCycle({ now: DIA_ANTES(11, 5) });
  assert.equal(sentTo(d.patient).length, 0, "janela encerrada: lembrete atrasado nao e disparado para compensar a falha");
  assert.equal(await prisma.reminderSent.count({ where: { appointmentId: d.appt.id } }), 0);
});

test("intervalo entre tentativas: adiado ha 5 min nao consulta o CE de novo; depois de 10 min consulta (e envia se o CE voltou)", async () => {
  resetNet();
  const c = await mkClinic(`Clinica Intervalo ${uniq()}`, { withCe: true });
  const x = await mkAppt(c, { when: T(10, 0), uuid: "iv-1", name: "Ivone Intervalo" });
  ceDetail = () => new Error("sem rede");
  await runReminderCycle({ now: DIA_ANTES(9, 0) });
  assert.equal(ceCalls.filter((p) => p.endsWith("/bookings/iv-1")).length, 1);
  await marcarEm(DIA_ANTES(9, 0));
  await runReminderCycle({ now: DIA_ANTES(9, 5) });
  assert.equal(ceCalls.filter((p) => p.endsWith("/bookings/iv-1")).length, 1, "5 min depois: nao martela o CE");
  ceDetail = (uuid) => ceBody(uuid, "scheduled", T(10, 0).toISOString());
  await runReminderCycle({ now: DIA_ANTES(9, 12) });
  assert.equal(ceCalls.filter((p) => p.endsWith("/bookings/iv-1")).length, 2);
  assert.equal(sentTo(x.patient).length, 1);
});

test("o teto de adiamentos desiste do lembrete, avisa a equipe e nao tenta mais", async () => {
  resetNet();
  const c = await mkClinic(`Clinica Teto ${uniq()}`, { withCe: true });
  const x = await mkAppt(c, { when: T(10, 0), uuid: "t-1", name: "Tereza Teto" });
  ceDetail = () => ({ status: 503, body: {} });
  for (let i = 0; i < MAX_DEFERRALS + 2; i++) {
    await envelhecer(30);
    await runReminderCycle({ now: DIA_ANTES(8, 5 + i) });
  }
  const d = await prisma.reminderDispatch.findFirst({ where: { appointmentId: x.appt.id } });
  assert.equal(d.state, "exhausted");
  assert.equal(d.attempt, MAX_DEFERRALS);
  const chamadas = ceCalls.filter((p) => p.endsWith("/bookings/t-1")).length;
  assert.equal(chamadas, MAX_DEFERRALS, "parou de consultar depois do teto");
  const clinicRow = await prisma.clinic.findUnique({ where: { id: c.clinic.id } });
  assert.ok(enviados.some((e) => e.phone === clinicRow.notifyPhone.replace(/\D/g, "") && /NÃO foram enviados/.test(e.text)), "a equipe foi avisada da desistencia");
  assert.equal(sentTo(x.patient).length, 0);
});

test("uma reserva com problema NAO trava as outras da mesma clinica, e o CE falhando para uma clinica nao afeta outra", async () => {
  resetNet();
  const c1 = await mkClinic(`Clinica Flaky ${uniq()}`, { withCe: true });
  const c2 = await mkClinic(`Clinica Boa ${uniq()}`, { withCe: true });
  const ruim = await mkAppt(c1, { when: T(10, 0), uuid: "f-ruim", name: "Ruim" });
  const bom1 = await mkAppt(c1, { when: T(10, 0), uuid: "f-bom1", name: "Bom Um" });
  const bom2 = await mkAppt(c1, { when: T(10, 0), uuid: "f-bom2", name: "Bom Dois" });
  const outra = await mkAppt(c2, { when: T(10, 0), uuid: "g-1", name: "Outra Clinica" });
  ceDetail = (uuid) => (uuid === "f-ruim" ? new Error("socket hang up") : ceBody(uuid, "scheduled", T(10, 0).toISOString()));
  await runReminderCycle({ now: DIA_ANTES(9, 0) });
  assert.equal(sentTo(ruim.patient).length, 0);
  assert.equal(sentTo(bom1.patient).length, 1);
  assert.equal(sentTo(bom2.patient).length, 1);
  assert.equal(sentTo(outra.patient).length, 1);
});

// ================= DUPLICIDADE =================
test("duas execucoes ao mesmo tempo, duas regras do mesmo tipo e copias da mesma reserva: UMA confirmacao; reinicio nao perde o controle", async () => {
  resetNet();
  const c = await mkClinic(`Clinica Duplicada ${uniq()}`, { withCe: true });
  // regra irma: texto diferente, mesmo tipo ("amanha")
  await prisma.reminderRule.create({ data: { clinicId: c.clinic.id, hoursBefore: 24, dayOffset: 1, sendHour: 8, sendMinute: 0, sendEndHour: 11, pauseMinSec: 0, pauseMaxSec: 0, active: true, message: "Oi {primeiro_nome}, confirmando sua visita de amanhã às {hora}. Pode confirmar?" } });
  const a = await mkAppt(c, { when: T(10, 0), uuid: "d-1", name: "Duda Dupla" });
  // copia local da MESMA reserva do CE (mesmo uuid), como uma importacao repetida/corrida poderia deixar
  const copia = await prisma.appointment.create({ data: { clinicId: c.clinic.id, patientId: a.patient.id, procedureId: c.botox.id, scheduledAt: T(10, 0), ceBookingUuid: "d-1", source: "presencial" } });
  void copia;
  ceDetail = (uuid) => ceBody(uuid, "scheduled", T(10, 0).toISOString());
  await Promise.all([runReminderCycle({ now: DIA_ANTES(9, 0) }), runReminderCycle({ now: DIA_ANTES(9, 0) })]);
  await runReminderCycle({ now: DIA_ANTES(9, 15) });
  assert.equal(sentTo(a.patient).length, 1, `uma unica confirmacao: ${JSON.stringify(sentTo(a.patient).map((e) => e.text.slice(0, 30)))}`);
  // "reinicio": o controle em memoria some e ate o registro ReminderSent e perdido; o controle persistente impede o reenvio
  await prisma.reminderSent.deleteMany({});
  await runReminderCycle({ now: DIA_ANTES(9, 30) });
  assert.equal(sentTo(a.patient).length, 1, "o controle persistente sobrevive");
  assert.equal(await prisma.reminderDispatch.count({ where: { bookingKey: "ce:d-1", state: "sent" } }), 1);
  // diagnostico: a trilha responde "o que foi decidido para esta reserva"
  const trilha = await dispatchTrail(c.clinic.id, { appointmentId: a.appt.id });
  assert.equal(trilha.length, 1);
  assert.deepEqual([trilha[0].state, trilha[0].kind, trilha[0].bookingKey], ["sent", "dia_seguinte", "ce:d-1"]);
});

test("reserva atomica: 12 tentativas simultaneas da mesma reserva/regra -> exatamente UMA adquire", async () => {
  resetNet();
  const c = await mkClinic(`Clinica Atomica ${uniq()}`);
  const a = await mkAppt(c, { when: T(10, 0), name: "Atomica" });
  const key = { clinicId: c.clinic.id, bookingKey: bookingKeyOf(a.appt), appointmentId: a.appt.id, patientId: a.patient.id, ruleId: c.parent.id, kind: "dia_seguinte", startsAt: a.appt.scheduledAt, sendDay: "2026-12-14" };
  const r = await Promise.all(Array.from({ length: 12 }, () => acquireDispatch(key)));
  assert.equal(r.filter((x) => x.ok).length, 1);
  assert.ok(r.filter((x) => !x.ok).every((x) => x.why === "in_progress" || x.why === "already_handled"));
  // outra regra do MESMO tipo no mesmo dia: bloqueada; regra de tipo diferente (hoje) no mesmo dia: permitida
  const outraRegraMesmoTipo = await acquireDispatch({ ...key, ruleId: "outra-regra-igual" });
  assert.equal(outraRegraMesmoTipo.ok, false);
  assert.equal(outraRegraMesmoTipo.why, "same_kind_today");
  assert.equal((await acquireDispatch({ ...key, ruleId: c.hoje.id, kind: "do_dia" })).ok, true);
});

// ================= RESULTADO DO ENVIO =================
test("resultado do envio: timeout ambiguo -> sem confirmacao e SEM reenvio; falha definitiva libera e tenta de novo (com teto); veto, duplicado e numero sem WhatsApp nao viram 'enviado'", async () => {
  resetNet();
  const c = await mkClinic(`Clinica Envio ${uniq()}`);
  const mk = (n) => mkAppt(c, { when: T(10, 0), name: n });

  // 1) timeout: pode ter chegado
  const amb = await mk("Ambigua");
  sendMode = "timeout";
  await runReminderCycle({ now: DIA_ANTES(9, 0) });
  const dAmb = await prisma.reminderDispatch.findFirst({ where: { appointmentId: amb.appt.id } });
  assert.equal(dAmb.state, "unconfirmed");
  assert.equal(await prisma.reminderSent.count({ where: { appointmentId: amb.appt.id } }), 1, "a reserva fica (nao libera pra reenviar)");
  sendMode = "ok";
  const antes = sendAttempts;
  await envelhecer(60);
  await runReminderCycle({ now: DIA_ANTES(9, 30) });
  assert.equal(sendAttempts, antes, "nenhum reenvio apos o timeout");
  assert.equal(sentTo(amb.patient).length, 0, "e nao consta como entregue");

  // 2) falha definitiva (HTTP 500): libera e tenta de novo depois do intervalo; ate o teto
  resetNet();
  const f = await mk("Falha");
  sendMode = "http500";
  await runReminderCycle({ now: DIA_ANTES(9, 0) });
  let dF = await prisma.reminderDispatch.findFirst({ where: { appointmentId: f.appt.id } });
  assert.equal(dF.state, "failed");
  assert.equal(await prisma.reminderSent.count({ where: { appointmentId: f.appt.id } }), 0, "reserva devolvida");
  await marcarEm(DIA_ANTES(9, 0));
  await runReminderCycle({ now: DIA_ANTES(9, 3) });
  assert.equal(sendAttempts, 1, "dentro do intervalo entre tentativas nao insiste");
  sendMode = "ok";
  await runReminderCycle({ now: DIA_ANTES(9, 20) });
  assert.equal(sentTo(f.patient).length, 1);
  dF = await prisma.reminderDispatch.findFirst({ where: { appointmentId: f.appt.id } });
  assert.deepEqual([dF.state, dF.attempt], ["sent", 2]);

  // 3) veto da revisao por IA: nao sai, fica registrado como vetado e nao e repetido
  resetNet();
  const v = await mk("Vetada");
  process.env.AI_SEND_REVIEW = "on";
  vetoNext = true;
  try {
    await runReminderCycle({ now: DIA_ANTES(9, 0) });
  } finally {
    delete process.env.AI_SEND_REVIEW;
  }
  assert.equal(sentTo(v.patient).length, 0);
  const dV = await prisma.reminderDispatch.findFirst({ where: { appointmentId: v.appt.id } });
  assert.equal(dV.state, "vetoed");
  await envelhecer(60);
  await runReminderCycle({ now: DIA_ANTES(9, 30) });
  assert.equal(sentTo(v.patient).length, 0, "vetado nao e reenviado sozinho");

  // 4) duplicado: o mesmo texto ja consta no chat
  resetNet();
  const dup = await mk("Duplicada");
  const texto = renderMessageTemplate(MSG_AMANHA, { patientName: "Duplicada", patientPhone: dup.patient.phone, clinicName: c.clinic.name, procedureName: "Botox", when: T(10, 0), timeZone: SP });
  const conv = await prisma.conversation.create({ data: { patientId: dup.patient.id } });
  await prisma.message.create({ data: { conversationId: conv.id, role: "assistant", content: texto } });
  await runReminderCycle({ now: DIA_ANTES(9, 0) });
  assert.equal(sentTo(dup.patient).length, 0);
  assert.equal((await prisma.reminderDispatch.findFirst({ where: { appointmentId: dup.appt.id } })).state, "duplicate");

  // 5) numero sem WhatsApp: falha definitiva sem insistir
  resetNet();
  const nw = await mk("SemZap");
  sendMode = "nowhatsapp";
  await runReminderCycle({ now: DIA_ANTES(9, 0) });
  assert.equal((await prisma.reminderDispatch.findFirst({ where: { appointmentId: nw.appt.id } })).state, "failed_permanent");
  const tent = sendAttempts;
  sendMode = "ok";
  await envelhecer(60);
  await runReminderCycle({ now: DIA_ANTES(9, 30) });
  assert.equal(sendAttempts, tent);
});

// ================= REMARCACAO / CONFIRMACAO DA PACIENTE =================
test("remarcacao NAO apaga a trilha do horario antigo; o horario novo recebe o proprio controle (uma vez); a cobranca respeita a confirmacao da paciente", async () => {
  resetNet();
  const c = await mkClinic(`Clinica Remarca ${uniq()}`);
  const a = await mkAppt(c, { when: T(10, 0), name: "Regina Remarca" });
  await runReminderCycle({ now: DIA_ANTES(9, 0) });
  assert.match(sentTo(a.patient)[0].text, /Horário: 10:00/);
  // remarcada para 15h (a Alice/painel/CE zeram a confirmacao e liberam os lembretes do horario novo)
  await prisma.appointment.update({ where: { id: a.appt.id }, data: { scheduledAt: T(15, 0), patientConfirmed: false, confirmedAt: null } });
  await prisma.reminderSent.deleteMany({ where: { appointmentId: a.appt.id } });
  await runReminderCycle({ now: DIA_ANTES(9, 30) });
  const msgs = sentTo(a.patient);
  assert.equal(msgs.length, 2, "um aviso para o horario novo");
  assert.match(msgs[1].text, /Horário: 15:00/);
  const trilha = await dispatchTrail(c.clinic.id, { appointmentId: a.appt.id });
  assert.equal(trilha.length, 2, "as duas linhas existem: a trilha do horario antigo foi preservada");
  assert.deepEqual(trilha.map((t) => t.startsAt.toISOString()).sort(), [T(10, 0).toISOString(), T(15, 0).toISOString()].sort());
  // nao repete nem para o antigo nem para o novo
  await runReminderCycle({ now: DIA_ANTES(9, 45) });
  assert.equal(sentTo(a.patient).length, 2);

  // cobranca (regra-filha) as 16h: quem JA confirmou nao recebe; quem nao respondeu recebe uma vez
  resetNet();
  const confirmou = await mkAppt(c, { when: T(11, 0), name: "Celia Confirmou", confirmed: true });
  const calada = await mkAppt(c, { when: T(11, 30), name: "Cacau Calada" });
  for (const x of [confirmou, calada]) await prisma.reminderSent.create({ data: { appointmentId: x.appt.id, ruleId: c.parent.id, sentAt: new Date(DIA_ANTES(9, 0).getTime()) } });
  await runReminderCycle({ now: DIA_ANTES(16, 10) });
  assert.equal(sentTo(confirmou.patient).length, 0, "a resposta da paciente confirmando presenca e respeitada");
  const cobr = sentTo(calada.patient);
  assert.equal(cobr.length, 1);
  assert.match(cobr[0].text, /Ainda não recebemos a sua confirmação/);
  await runReminderCycle({ now: DIA_ANTES(16, 25) });
  assert.equal(sentTo(calada.patient).length, 1, "a cobranca sai uma vez");
});

test("a reserva muda DEPOIS da selecao (cancelada durante a rodada): nao recebe", async () => {
  resetNet();
  const c = await mkClinic(`Clinica Fresca ${uniq()}`, { withCe: true });
  const primeira = await mkAppt(c, { when: T(9, 0), uuid: "x-1", name: "Primeira" });
  const segunda = await mkAppt(c, { when: T(10, 0), uuid: "x-2", name: "Segunda" });
  // durante a conferencia da primeira, a importacao cancela a segunda
  ceDetail = async (uuid) => {
    if (uuid === "x-1") await prisma.appointment.update({ where: { id: segunda.appt.id }, data: { status: "cancelled" } });
    return ceBody(uuid, "scheduled", uuid === "x-1" ? T(9, 0).toISOString() : T(10, 0).toISOString());
  };
  await runReminderCycle({ now: DIA_ANTES(9, 0) });
  assert.equal(sentTo(primeira.patient).length, 1);
  assert.equal(sentTo(segunda.patient).length, 0, "estado fresco: a cancelada nao recebe");
});

test("reserva local SEM vinculo com o CE continua funcionando mesmo com o CE fora do ar (nada a conferir la)", async () => {
  resetNet();
  const c = await mkClinic(`Clinica Local ${uniq()}`, { withCe: true });
  const local = await mkAppt(c, { when: T(10, 0), uuid: null, name: "Local Sem CE" });
  const comCe = await mkAppt(c, { when: T(10, 0), uuid: "l-1", name: "Com CE" });
  ceDetail = () => new Error("sem rede");
  await runReminderCycle({ now: DIA_ANTES(9, 0) });
  assert.equal(sentTo(local.patient).length, 1);
  assert.equal(sentTo(comCe.patient).length, 0, "a vinculada ao CE aguarda a conferencia");
  assert.equal((await prisma.reminderDispatch.findFirst({ where: { appointmentId: local.appt.id } })).bookingKey, `appt:${local.appt.id}`);
});
