// Espelho Alice -> Clinica Experts COM banco de verdade (SQLite temporario) e o CE simulado por um fetch falso.
// Garante o que faltou em 15/10 (Lavieen): a Alice so pode dizer "agendado" depois de a reserva existir no CE, e quando o CE
// recusa o motivo exato fica registrado (antes sumia). Tambem: rede que cai no meio NAO vira reserva duplicada nem falsa.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dbFile = path.join(os.tmpdir(), `alice-espelho-ce-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const { prisma } = await import("../dist/db/client.js");
const { encryptSecret } = await import("../dist/meta/secretBox.js");
const { syncAppointment, ceMirrorEnabled } = await import("../dist/clinicaexperts/sync.js");

test.after(async () => {
  await (await import("../dist/jobs/background.js")).drainBackground(); // tarefas em segundo plano terminam ANTES de o banco temporario ser apagado
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* Windows pode segurar o arquivo por um instante: e temporario */ } }
});

// ---- cenario ----
const clinic = await prisma.clinic.create({ data: { name: "Clinica Teste CE", whatsappPhone: "5511900000000", timezone: "America/Sao_Paulo" } });
await prisma.clinicaExpertsAccount.create({ data: { clinicId: clinic.id, tokenEnc: encryptSecret("token-de-teste-com-mais-de-vinte-caracteres"), tokenHint: "••••test" } });
const procedure = await prisma.procedure.create({ data: { clinicId: clinic.id, name: "Lavieen", durationMin: 30, ceId: 1013701 } });
const amanda = await prisma.professional.create({ data: { clinicId: clinic.id, name: "Amanda", ceUuid: "uuid-amanda" } });
const patient = await prisma.patient.create({ data: { clinicId: clinic.id, name: "Richard Silva Queiroz", phone: "5511999990000", ceUuid: "uuid-paciente" } });
const START = new Date("2026-10-17T11:30:00Z"); // sabado 08:30 (UTC-3)

async function novoAgendamento() {
  return prisma.appointment.create({ data: { clinicId: clinic.id, patientId: patient.id, procedureId: procedure.id, professionalId: amanda.id, scheduledAt: START, source: "whatsapp" } });
}

// fetch falso do CE: cada teste define o que POST /bookings e GET /bookings respondem
let handler;
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const method = init.method ?? "GET";
  calls.push(`${method} ${u.pathname}`);
  return handler({ method, path: u.pathname, query: u.searchParams, body: init.body ? JSON.parse(init.body) : null });
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("CE aceita: a reserva fica vinculada (uuid) e o resultado e ok", async () => {
  calls.length = 0;
  handler = ({ method, path, body }) => {
    if (method === "POST" && path.endsWith("/bookings")) {
      assert.equal(body.professional, "uuid-amanda");
      assert.equal(body.procedure, "1013701");
      assert.equal(body.starts_at, "2026-10-17T08:30:00-03:00");
      assert.equal(body.ends_at, "2026-10-17T09:00:00-03:00");
      return json(200, { data: { uuid: "reserva-1" } });
    }
    return json(404, {});
  };
  const appt = await novoAgendamento();
  const r = await syncAppointment(appt.id, { quiet: true });
  assert.deepEqual(r, { ok: true });
  assert.equal((await prisma.appointment.findUnique({ where: { id: appt.id } })).ceBookingUuid, "reserva-1");
  assert.equal(await ceMirrorEnabled(clinic.id), true);
});

test("CE recusa (422): resultado falha DEFINITIVA com o motivo, e o motivo fica no diario de atividades", async () => {
  handler = ({ method, path }) => {
    if (method === "POST" && path.endsWith("/bookings")) {
      return json(422, { error: { code: "API0422", title: "Invalid data", user_message: "The specified data is invalid.", fields: { professional: ["O profissional nao realiza este procedimento."] } } });
    }
    return json(404, {});
  };
  const appt = await novoAgendamento();
  const r = await syncAppointment(appt.id, { quiet: true });
  assert.equal(r.ok, false);
  assert.equal(r.definitive, true);
  assert.match(r.error, /nao realiza este procedimento/);
  assert.equal((await prisma.appointment.findUnique({ where: { id: appt.id } })).ceBookingUuid, null);
  const log = await prisma.activityLog.findFirst({ where: { clinicId: clinic.id, type: "ce_mirror_failed" }, orderBy: { createdAt: "desc" } });
  assert.ok(log, "o erro tem que ficar registrado");
  assert.match(log.description ?? "", /nao realiza este procedimento/);
  assert.equal((await prisma.clinicaExpertsAccount.findUnique({ where: { clinicId: clinic.id } })).lastError?.includes("nao realiza"), true);
});

test("rede cai no POST mas a reserva JA existe no CE: nao falha e nao duplica (confere antes de desistir)", async () => {
  calls.length = 0;
  handler = ({ method, path }) => {
    if (method === "POST" && path.endsWith("/bookings")) throw new Error("socket hang up");
    if (method === "GET" && path.endsWith("/bookings")) {
      return json(200, { data: [{ uuid: "reserva-existente", starts_at: "2026-10-17T08:30:00-03:00", status: "scheduled", patient: { uuid: "uuid-paciente" } }] });
    }
    return json(404, {});
  };
  const appt = await novoAgendamento();
  const r = await syncAppointment(appt.id, { quiet: true });
  assert.deepEqual(r, { ok: true });
  assert.equal((await prisma.appointment.findUnique({ where: { id: appt.id } })).ceBookingUuid, "reserva-existente");
  assert.equal(calls.filter((c) => c === "POST /api/v1/bookings").length, 1, "nao tenta criar de novo");
});

test("rede cai e a reserva NAO esta no CE: falha incerta (definitive=false) - quem agenda desfaz e passa pra equipe", async () => {
  handler = ({ method, path }) => {
    if (method === "POST" && path.endsWith("/bookings")) throw new Error("timeout");
    if (method === "GET" && path.endsWith("/bookings")) return json(200, { data: [{ uuid: "de-outra-pessoa", starts_at: "2026-10-17T08:30:00-03:00", status: "scheduled", patient: { uuid: "outro-paciente" } }] });
    return json(404, {});
  };
  const appt = await novoAgendamento();
  const r = await syncAppointment(appt.id, { quiet: true });
  assert.equal(r.ok, false);
  assert.equal(r.definitive, false);
  assert.equal((await prisma.appointment.findUnique({ where: { id: appt.id } })).ceBookingUuid, null);
});

test("reserva cancelada no CE com o mesmo horario nao conta como 'ja existe'", async () => {
  handler = ({ method, path }) => {
    if (method === "POST" && path.endsWith("/bookings")) throw new Error("timeout");
    if (method === "GET" && path.endsWith("/bookings")) return json(200, { data: [{ uuid: "cancelada", starts_at: "2026-10-17T08:30:00-03:00", status: "canceled", patient: { uuid: "uuid-paciente" } }] });
    return json(404, {});
  };
  const appt = await novoAgendamento();
  const r = await syncAppointment(appt.id, { quiet: true });
  assert.equal(r.ok, false);
});

test("sem vinculo de profissional ou procedimento: falha clara (nunca 'agendado' sem estar no CE)", async () => {
  handler = () => json(500, {});
  const semVinculo = await prisma.professional.create({ data: { clinicId: clinic.id, name: "Sem vinculo" } });
  const appt = await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: patient.id, procedureId: procedure.id, professionalId: semVinculo.id, scheduledAt: START, source: "whatsapp" } });
  const r = await syncAppointment(appt.id, { quiet: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /sem vinculo/);
});

test("Clinica Experts desligado na clinica: nada a espelhar (ok), e a Alice agenda como sempre", async () => {
  await prisma.clinicaExpertsAccount.update({ where: { clinicId: clinic.id }, data: { syncOut: false } });
  assert.equal(await ceMirrorEnabled(clinic.id), false);
  const appt = await novoAgendamento();
  const r = await syncAppointment(appt.id, { quiet: true });
  assert.equal(r.ok, true);
  await prisma.clinicaExpertsAccount.update({ where: { clinicId: clinic.id }, data: { syncOut: true } });
});

// ---- o ponto de entrada da Alice: so confirma depois do CE ----
test("book_appointment espera o CE: cria sem espelhar em segundo plano, confere e desfaz se o CE recusar", () => {
  const alice = fs.readFileSync(new URL("../src/ai/alice.ts", import.meta.url), "utf8");
  const i = alice.indexOf("const mirrorCe = await ceMirrorEnabled(clinicId);");
  assert.ok(i > 0, "book_appointment precisa checar se o CE esta ligado");
  const trecho = alice.slice(i, i + 4500);
  assert.match(trecho, /deferMirror: mirrorCe/);
  assert.match(trecho, /await syncAppointment\(booking\.appointmentId, \{ quiet: true \}\)/);
  assert.match(trecho, /status: "cancelled"/, "desfaz o agendamento quando o CE recusa");
  assert.match(trecho, /transfer_to_human/, "e passa o caso pra equipe");
  // o "agendado: true" so vem DEPOIS do espelho
  assert.ok(alice.indexOf('JSON.stringify({ agendado: true', i) > alice.indexOf("syncAppointment(booking.appointmentId", i));
  const slots = fs.readFileSync(new URL("../src/scheduling/slots.ts", import.meta.url), "utf8");
  assert.match(slots, /if \(result\.ok && !params\.deferMirror\) pushAppointmentInBackground/);
});
