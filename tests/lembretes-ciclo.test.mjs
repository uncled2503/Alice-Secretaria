// UMA RODADA COMPLETA de lembretes (runReminderCycle) com banco de verdade (SQLite temporario), UAZAPI e Clinica Experts simulados por um fetch falso.
// Pedido da Lisboa (16/10/2026): quem cancelou/remarcou no CE nao recebe confirmacao do horario velho; reserva sem procedimento recebe a
// confirmacao so com data e horario; se o CE estiver fora do ar o lembrete segue (a conferencia nunca derruba o disparo).
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dbFile = path.join(os.tmpdir(), `alice-lembretes-ciclo-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY ??= "test-key";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const { prisma } = await import("../dist/db/client.js");
const { encryptSecret } = await import("../dist/meta/secretBox.js");
const { runReminderCycle } = await import("../dist/reminders/cron.js");
const { ensurePlaceholderProcedure } = await import("../dist/clinicaexperts/placeholderProcedure.js");

test.after(async () => {
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* arquivo temporario */ } }
});

// Fuso em que AGORA sao 12h: a confirmacao nunca e empurrada para as 7h (o teste nao depende da hora em que roda).
const utcHour = new Date().getUTCHours();
let off = (12 - utcHour + 24) % 24;
if (off > 12) off -= 24;
const tz = off === 0 ? "UTC" : `Etc/GMT${off > 0 ? "-" : "+"}${Math.abs(off)}`;

const clinic = await prisma.clinic.create({
  data: { name: "Clinica Ciclo", whatsappPhone: "5511900000002", timezone: tz, plan: "prime", uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: "token-instancia-teste" },
});
await prisma.clinicaExpertsAccount.create({ data: { clinicId: clinic.id, tokenEnc: encryptSecret("token-de-teste-com-mais-de-vinte-caracteres"), tokenHint: "••••test" } });
const botox = await prisma.procedure.create({ data: { clinicId: clinic.id, name: "Botox", durationMin: 30, ceId: 111 } });
const semProc = await ensurePlaceholderProcedure(clinic.id);
const rule = await prisma.reminderRule.create({
  data: {
    clinicId: clinic.id, hoursBefore: 24, active: true,
    message: "Olá, {primeiro_nome}!\n📅 Data: {data}\n⏰ Horário: {hora}\n💆 Procedimento: {procedimento}\n\nPodemos contar com a sua presença?",
  },
});

// agendamentos que vencem AGORA: o lembrete de 24h antes estava previsto para ha 10 min
const MIN = 60_000;
const quando = new Date(Math.floor((Date.now() + 24 * 60 * MIN - 10 * MIN) / MIN) * MIN);
let n = 0;
async function caso(nome, { uuid = null, procedureId = botox.id } = {}) {
  n++;
  const patient = await prisma.patient.create({ data: { clinicId: clinic.id, name: nome, phone: `551198888${String(1000 + n)}` } });
  const appt = await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: patient.id, procedureId, scheduledAt: quando, ceBookingUuid: uuid, source: "presencial" } });
  return { patient, appt };
}

const enviados = []; // { phone, text }
let ce = () => ({ status: 404, body: {} });
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.endsWith("uazapi.com")) {
    if (u.pathname === "/send/text") {
      const b = JSON.parse(init.body);
      enviados.push({ phone: b.number, text: b.text });
    }
    return jsonRes(200, { id: "msg-1" });
  }
  const r = ce({ method: init.method ?? "GET", path: u.pathname });
  if (r instanceof Error) throw r;
  return jsonRes(r.status, r.body);
};

test("o fuso do teste esta em 12h (garante que o horario do lembrete nao e adiado)", () => {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit" }).format(new Date()));
  assert.equal(h, 12);
});

test("rodada completa: so recebe quem tem horario valido; cancelado/trocado no CE nao recebe; sem procedimento recebe sem a linha do procedimento", async () => {
  const normal = await caso("Ana Normal"); // sem vinculo com o CE
  const cancelada = await caso("Bruna Cancelou", { uuid: "u-cancelada" });
  const trocada = await caso("Maria Trocou", { uuid: "u-trocada" });
  const apagada = await caso("Vania Apagada", { uuid: "u-apagada" });
  const ok = await caso("Carla Ok", { uuid: "u-ok" });
  const foraDoAr = await caso("Rita ForaDoAr", { uuid: "u-fora" });
  const sem = await caso("Milena SemProc", { uuid: "u-sem", procedureId: semProc.id });
  const novoHorario = new Date(quando.getTime() + 48 * 60 * MIN);

  ce = ({ path: p }) => {
    if (p.endsWith("/u-cancelada")) return { status: 200, body: { data: { status: "canceled", starts_at: quando.toISOString() } } };
    if (p.endsWith("/u-trocada")) return { status: 200, body: { data: { status: "scheduled", starts_at: novoHorario.toISOString() } } };
    if (p.endsWith("/u-apagada")) return { status: 404, body: {} };
    if (p.endsWith("/u-ok") || p.endsWith("/u-sem")) return { status: 200, body: { data: { status: "scheduled", starts_at: quando.toISOString() } } };
    if (p.endsWith("/u-fora")) return new Error("socket hang up");
    return { status: 404, body: {} };
  };

  await runReminderCycle();

  const phones = new Set(enviados.map((e) => e.phone));
  const recebeu = (c) => phones.has(c.patient.phone);
  assert.equal(recebeu(normal), true, "horario normal recebe");
  assert.equal(recebeu(ok), true, "reserva conferida no CE recebe");
  assert.equal(recebeu(foraDoAr), false, "CE fora do ar: conferencia inconclusiva ADIA o lembrete (antes seguia sem conferir)");
  assert.equal(recebeu(sem), true, "reserva sem procedimento recebe");
  assert.equal(recebeu(cancelada), false, "cancelada no CE NAO recebe");
  assert.equal(recebeu(trocada), false, "trocada no CE NAO recebe o horario antigo");
  assert.equal(recebeu(apagada), false, "apagada no CE NAO recebe");

  const status = async (c) => (await prisma.appointment.findUnique({ where: { id: c.appt.id } })).status;
  assert.equal(await status(cancelada), "cancelled");
  assert.equal(await status(apagada), "cancelled");
  assert.equal(await status(trocada), "confirmed");
  assert.equal(await status(foraDoAr), "confirmed", "adiar NAO cancela nem altera a reserva");
  assert.equal(await prisma.reminderSent.count({ where: { appointmentId: foraDoAr.appt.id } }), 0, "o lembrete adiado nao foi consumido");
  const adiado = await prisma.reminderDispatch.findFirst({ where: { appointmentId: foraDoAr.appt.id } });
  assert.equal(adiado?.state, "deferred");
  assert.equal(adiado?.attempt, 1);
  assert.equal((await prisma.appointment.findUnique({ where: { id: trocada.appt.id } })).scheduledAt.getTime(), novoHorario.getTime());
  assert.equal(await prisma.reminderSent.count({ where: { appointmentId: cancelada.appt.id } }), 0, "nada foi reservado/enviado para a cancelada");

  // sem procedimento: a linha "Procedimento" sai do texto e o resto fica
  const textoSem = enviados.find((e) => e.phone === sem.patient.phone).text;
  assert.ok(!/rocedimento/.test(textoSem), textoSem);
  assert.match(textoSem, /Olá, Milena!/);
  assert.match(textoSem, /Data:/);
  assert.match(textoSem, /Podemos contar com a sua presença\?/);
  // com procedimento: o texto traz o nome
  assert.match(enviados.find((e) => e.phone === normal.patient.phone).text, /Procedimento: Botox/);
  // cada uma recebeu UMA vez
  for (const c of [normal, ok, sem]) assert.equal(enviados.filter((e) => e.phone === c.patient.phone).length, 1);
  assert.equal(enviados.filter((e) => e.phone === foraDoAr.patient.phone).length, 0);

  // segunda rodada logo em seguida: ninguem recebe de novo
  const antes = enviados.length;
  await runReminderCycle();
  assert.equal(enviados.length, antes, "nao repete");
});

test("quem trocou de horario no CE recebe a confirmacao do horario NOVO quando chegar a hora dele", async () => {
  // o horario novo ja foi corrigido na rodada anterior; a regra da rodada atual ainda nao venceu para ele (48h depois), entao nada sai agora
  const antes = enviados.length;
  await runReminderCycle();
  assert.equal(enviados.length, antes);
  const maria = await prisma.patient.findFirst({ where: { clinicId: clinic.id, name: "Maria Trocou" } });
  const appt = await prisma.appointment.findFirst({ where: { patientId: maria.id } });
  assert.equal(await prisma.reminderSent.count({ where: { appointmentId: appt.id } }), 0, "os lembretes ficam liberados pro horario novo");
});
