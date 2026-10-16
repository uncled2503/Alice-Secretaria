// Lembrete x Clinica Experts COM banco de verdade (SQLite temporario) e o CE simulado por um fetch falso.
// Garante o pedido da Lisboa de 16/10: quem cancelou ou remarcou no CE nao recebe confirmacao do horario velho, e a reserva SEM procedimento
// entra na Alice (com procedimento interno) para receber a confirmacao so com data e horario.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dbFile = path.join(os.tmpdir(), `alice-lembrete-vivo-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY ??= "test-key";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const { prisma } = await import("../dist/db/client.js");
const { encryptSecret } = await import("../dist/meta/secretBox.js");
const { verifyBookingLive, applyLiveVerdict } = await import("../dist/clinicaexperts/liveCheck.js");
const { pullClinicBookings } = await import("../dist/clinicaexperts/pull.js");
const { PLACEHOLDER_PROCEDURE_NAME, displayProcedureName } = await import("../dist/clinicaexperts/placeholderProcedure.js");

test.after(async () => {
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* arquivo temporario */ } }
});

const clinic = await prisma.clinic.create({ data: { name: "Clinica Lembrete Vivo", whatsappPhone: "5511900000001", timezone: "America/Sao_Paulo" } });
await prisma.clinicaExpertsAccount.create({ data: { clinicId: clinic.id, tokenEnc: encryptSecret("token-de-teste-com-mais-de-vinte-caracteres"), tokenHint: "••••test" } });
const botox = await prisma.procedure.create({ data: { clinicId: clinic.id, name: "Botox", durationMin: 30, ceId: 111 } });
const rule = await prisma.reminderRule.create({ data: { clinicId: clinic.id, hoursBefore: 24, message: "Confirmando {data} {hora}", active: true } });

const HOUR = 3_600_000;
const inHours = (h) => new Date(Math.floor((Date.now() + h * HOUR) / 60_000) * 60_000);
let n = 0;
async function paciente(nome) {
  n++;
  return prisma.patient.create({ data: { clinicId: clinic.id, name: nome, phone: `55119999${String(1000 + n)}` } });
}
async function agendamento(p, { when, uuid, procedureId = botox.id }) {
  return prisma.appointment.create({ data: { clinicId: clinic.id, patientId: p.id, procedureId, scheduledAt: when, ceBookingUuid: uuid, source: "presencial" } });
}

let handler;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  return handler({ method: init.method ?? "GET", path: u.pathname, query: u.searchParams });
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const TZ = "America/Sao_Paulo";

test("reserva CANCELADA no CE: o lembrete nao sai e o agendamento e cancelado aqui", async () => {
  const p = await paciente("Bruna");
  const appt = await agendamento(p, { when: inHours(20), uuid: "cancelada-no-ce" });
  handler = ({ path }) => (path.endsWith("/bookings/cancelada-no-ce") ? json(200, { data: { uuid: "cancelada-no-ce", status: "canceled", starts_at: appt.scheduledAt.toISOString() } }) : json(404, {}));
  const verdict = await verifyBookingLive(appt, TZ);
  assert.equal(verdict.kind, "gone");
  assert.equal(await applyLiveVerdict(appt, verdict, "Bruna"), true); // true = pular o lembrete
  assert.equal((await prisma.appointment.findUnique({ where: { id: appt.id } })).status, "cancelled");
  const log = await prisma.activityLog.findFirst({ where: { clinicId: clinic.id, patientId: p.id, type: "appointment_cancelled" } });
  assert.ok(log, "fica registrado no diario");
});

test("reserva APAGADA no CE (404): idem", async () => {
  const p = await paciente("Vania");
  const appt = await agendamento(p, { when: inHours(20), uuid: "apagada" });
  handler = () => json(404, { error: { user_message: "Not found" } });
  assert.equal(await applyLiveVerdict(appt, await verifyBookingLive(appt, TZ), "Vania"), true);
  assert.equal((await prisma.appointment.findUnique({ where: { id: appt.id } })).status, "cancelled");
});

test("horario TROCADO no CE: corrige aqui, zera a confirmacao antiga e libera os lembretes pro horario novo", async () => {
  const p = await paciente("Maria");
  const appt = await agendamento(p, { when: inHours(20), uuid: "trocada" });
  await prisma.appointment.update({ where: { id: appt.id }, data: { patientConfirmed: true, confirmedAt: new Date() } });
  await prisma.reminderSent.create({ data: { appointmentId: appt.id, ruleId: rule.id } });
  const novo = inHours(44);
  handler = () => json(200, { data: { uuid: "trocada", status: "scheduled", starts_at: novo.toISOString() } });
  const verdict = await verifyBookingLive(appt, TZ);
  assert.equal(verdict.kind, "moved");
  assert.equal(await applyLiveVerdict(appt, verdict, "Maria"), true); // nao manda o do horario antigo
  const after = await prisma.appointment.findUnique({ where: { id: appt.id } });
  assert.equal(after.scheduledAt.getTime(), novo.getTime());
  assert.equal(after.patientConfirmed, false);
  assert.equal(await prisma.reminderSent.count({ where: { appointmentId: appt.id } }), 0);
  assert.equal(after.status, "confirmed");
});

test("reserva igual ao que a Alice tem: segue e o lembrete sai normalmente", async () => {
  const p = await paciente("Ana");
  const appt = await agendamento(p, { when: inHours(20), uuid: "igual" });
  handler = () => json(200, { data: { uuid: "igual", status: "scheduled", starts_at: appt.scheduledAt.toISOString() } });
  const verdict = await verifyBookingLive(appt, TZ);
  assert.equal(verdict.kind, "ok");
  assert.equal(await applyLiveVerdict(appt, verdict, "Ana"), false);
  assert.equal((await prisma.appointment.findUnique({ where: { id: appt.id } })).status, "confirmed");
});

test("CE fora do ar / resposta estranha: nao conclui nada (o lembrete segue) e nunca lanca", async () => {
  const p = await paciente("Rede");
  const appt = await agendamento(p, { when: inHours(20), uuid: "rede-caiu" });
  handler = () => { throw new Error("socket hang up"); };
  assert.equal((await verifyBookingLive(appt, TZ)).kind, "unknown");
  handler = () => json(500, {});
  assert.equal((await verifyBookingLive(appt, TZ)).kind, "unknown");
  handler = () => json(200, { data: { status: { name: "canceled" }, starts_at: "2026-10-20T13:30:00" } }); // formato inesperado
  assert.equal((await verifyBookingLive(appt, TZ)).kind, "ok");
  assert.equal((await prisma.appointment.findUnique({ where: { id: appt.id } })).status, "confirmed");
  const semUuid = await agendamento(p, { when: inHours(22), uuid: null });
  assert.equal((await verifyBookingLive(semUuid, TZ)).kind, "ok"); // nao veio do CE: nada a conferir
});

test("a importacao: reserva SEM procedimento entra com procedimento interno (e e a unica sem telefone que fica de fora)", async () => {
  const amanha = inHours(26).toISOString();
  handler = ({ path }) => {
    if (path.endsWith("/bookings")) {
      return json(200, {
        data: [
          { uuid: "sem-proc", status: "scheduled", starts_at: amanha, patient: { uuid: "p-sem", name: "Milena Brandao", phone: "+55 11 99999-0001" }, procedures: [] },
          { uuid: "sem-fone", status: "scheduled", starts_at: amanha, patient: { uuid: "p-nofone", name: "Sem Telefone", phone: null }, procedures: [] },
          { uuid: "com-proc", status: "scheduled", starts_at: amanha, patient: { uuid: "p-com", name: "Carla Dias", phone: "11988887777" }, procedures: [{ id: 111 }] },
        ],
      });
    }
    return json(200, { data: {} }); // detalhe da reserva: sem procedimento tambem
  };
  const r = await pullClinicBookings(clinic.id);
  assert.equal(r.error, undefined);
  assert.equal(r.created, 2);
  const milena = await prisma.patient.findFirst({ where: { clinicId: clinic.id, phone: "5511999990001" } });
  const a = await prisma.appointment.findFirst({ where: { patientId: milena.id }, include: { procedure: true } });
  assert.equal(a.procedure.name, PLACEHOLDER_PROCEDURE_NAME);
  assert.equal(a.procedure.internalOnly, true); // a Alice nunca oferece nem agenda isso
  assert.equal(a.status, "confirmed");
  assert.equal(a.ceBookingUuid, "sem-proc");
  assert.deepEqual(r.skipDetails.map((s) => s.reason), ["sem_telefone"]);
  const carla = await prisma.patient.findFirst({ where: { clinicId: clinic.id, phone: "5511988887777" } });
  assert.equal((await prisma.appointment.findFirst({ where: { patientId: carla.id }, include: { procedure: true } })).procedure.name, "Botox");
  assert.match(displayProcedureName(PLACEHOLDER_PROCEDURE_NAME), /horario ja marcado/); // a Alice nunca fala o nome tecnico
  // rodar de novo nao duplica
  const r2 = await pullClinicBookings(clinic.id);
  assert.equal(r2.created, 0);
  assert.equal(await prisma.appointment.count({ where: { patientId: milena.id } }), 1);
});

test("a importacao: quando a recepcao escolhe o procedimento no CE, a reserva troca pelo procedimento de verdade", async () => {
  const milena = await prisma.patient.findFirst({ where: { clinicId: clinic.id, phone: "5511999990001" } });
  const amanha = (await prisma.appointment.findFirst({ where: { patientId: milena.id } })).scheduledAt.toISOString();
  handler = ({ path }) => path.endsWith("/bookings")
    ? json(200, { data: [{ uuid: "sem-proc", status: "scheduled", starts_at: amanha, patient: { uuid: "p-sem", name: "Milena Brandao", phone: "+55 11 99999-0001" }, procedures: [{ id: 111 }] }] })
    : json(200, { data: {} });
  await pullClinicBookings(clinic.id);
  const a = await prisma.appointment.findFirst({ where: { patientId: milena.id }, include: { procedure: true } });
  assert.equal(a.procedure.name, "Botox");
});

test("a importacao: reserva que a Alice tem mas o CE NAO devolve mais -> confere ao vivo e cancela (apagada); a que o CE ainda tem fica", async () => {
  const p1 = await paciente("Sumiu");
  const p2 = await paciente("Continua");
  const sumiu = await agendamento(p1, { when: inHours(30), uuid: "sumiu-da-lista" });
  const continua = await agendamento(p2, { when: inHours(31), uuid: "continua-no-ce" });
  handler = ({ path }) => {
    if (path.endsWith("/bookings")) return json(200, { data: [] }); // a listagem nao devolve nenhuma das duas
    if (path.endsWith("/bookings/sumiu-da-lista")) return json(404, {});
    if (path.endsWith("/bookings/continua-no-ce")) return json(200, { data: { uuid: "continua-no-ce", status: "scheduled", starts_at: continua.scheduledAt.toISOString() } });
    return json(404, {});
  };
  await pullClinicBookings(clinic.id);
  assert.equal((await prisma.appointment.findUnique({ where: { id: sumiu.id } })).status, "cancelled");
  assert.equal((await prisma.appointment.findUnique({ where: { id: continua.id } })).status, "confirmed");
});

test("a importacao: a recepcao trocou o horario no CE -> atualiza, zera a confirmacao e libera os lembretes", async () => {
  const p = await paciente("Trocou");
  const appt = await agendamento(p, { when: inHours(30), uuid: "trocou-horario" });
  await prisma.appointment.update({ where: { id: appt.id }, data: { patientConfirmed: true, confirmedAt: new Date() } });
  await prisma.reminderSent.create({ data: { appointmentId: appt.id, ruleId: rule.id } });
  const novo = inHours(52);
  handler = ({ path }) => path.endsWith("/bookings")
    ? json(200, { data: [{ uuid: "trocou-horario", status: "scheduled", starts_at: novo.toISOString(), patient: { uuid: "p-t", name: "Trocou", phone: "+55 11 9999-9999" }, procedures: [{ id: 111 }] }] })
    : json(200, { data: {} });
  await pullClinicBookings(clinic.id);
  const after = await prisma.appointment.findUnique({ where: { id: appt.id } });
  assert.equal(after.scheduledAt.getTime(), novo.getTime());
  assert.equal(after.patientConfirmed, false);
  assert.equal(await prisma.reminderSent.count({ where: { appointmentId: appt.id } }), 0);
});

test("a importacao: o CE devolve a reserva como cancelada -> cancela aqui (sem mandar nada)", async () => {
  const p = await paciente("Cancelou");
  const appt = await agendamento(p, { when: inHours(30), uuid: "cancelou-na-lista" });
  handler = ({ path }) => path.endsWith("/bookings")
    ? json(200, { data: [{ uuid: "cancelou-na-lista", status: "canceled", starts_at: appt.scheduledAt.toISOString(), patient: { uuid: "p-c", name: "Cancelou", phone: "+55 11 9999-9998" }, procedures: [{ id: 111 }] }] })
    : json(200, { data: {} });
  await pullClinicBookings(clinic.id);
  assert.equal((await prisma.appointment.findUnique({ where: { id: appt.id } })).status, "cancelled");
});

test("o disparo dos lembretes confere ao vivo ANTES de reservar e enviar, e tira a linha do procedimento quando nao ha", () => {
  const src = fs.readFileSync(new URL("../src/reminders/cron.ts", import.meta.url), "utf8");
  const confere = src.indexOf("verifyBookingLive(appt, tz)");
  const reserva = src.indexOf("prisma.reminderSent.create");
  const envia = src.indexOf("await sendText(appt.clinicId");
  assert.ok(confere > 0 && reserva > confere && envia > reserva, "conferir -> reservar -> enviar");
  assert.match(src, /stripProcedureLines\(rule\.message\)/);
});
