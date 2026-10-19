// LEMBRETES COM A REVISAO POR IA FORA DO AR (disjuntor aberto) E COM O WHATSAPP DESCONECTADO. Banco de verdade, rodada de lembretes real, OpenAI / UAZAPI / Clinica Experts simulados.
//  1) Disjuntor ABERTO: o lembrete NAO passa pela IA, mas as protecoes deterministicas seguem: reserva cancelada ou remarcada no CE nao recebe o lembrete do horario velho,
//     a reserva valida recebe UM lembrete.
//  2) WhatsApp desconectado: o lembrete NAO e tentado, NAO gasta tentativa (o teto de 3 desistiria dele em 45 min) e, quando a conexao volta, sai UMA vez.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dbFile = path.join(os.tmpdir(), `alice-disjuntor-lemb-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY = "test-key";
process.env.AI_SEND_REVIEW = "on";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const posts = []; // { token, number, text }
const openaiCalls = [];
let ceHandler = () => new Response("{}", { status: 404 });
const providerMode = { "tok-ce": "ok", "tok-sem-ce": "ok" };
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.includes("openai.com")) { openaiCalls.push(1); return jsonRes(500, { error: { message: "revisao fora do ar" } }); } // a revisao por IA esta FORA DO AR
  if (u.hostname.endsWith("uazapi.com")) {
    const token = init.headers?.token;
    if (u.pathname === "/send/text") {
      if (providerMode[token] === "down") return jsonRes(503, { error: "WhatsApp disconnected: session is not reconnectable" });
      const b = JSON.parse(init.body);
      posts.push({ token, number: b.number, text: b.text });
      return jsonRes(200, { id: "msg" });
    }
    if (u.pathname === "/instance/status") return jsonRes(200, providerMode[token] === "down" ? { instance: { status: "disconnected" }, status: { connected: false } } : { instance: { status: "connected" }, status: { connected: true } });
    return jsonRes(200, {});
  }
  return ceHandler({ method: init.method ?? "GET", path: u.pathname, query: u.searchParams });
};

const { prisma } = await import("../dist/db/client.js");
const { encryptSecret } = await import("../dist/meta/secretBox.js");
const { runReminderCycle } = await import("../dist/reminders/cron.js");
const { noteVerdict, breakerOpen, resetBreakerForTests, BREAKER_CONSECUTIVE } = await import("../dist/ai/sendGate.js");

test.after(async () => {
  await (await import("../dist/jobs/background.js")).drainBackground();
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* arquivo temporario */ } }
});

const HOUR = 3_600_000;
// fuso em que AGORA sao 12h (o horario do lembrete nao e adiado por janela)
const utcHour = new Date().getUTCHours();
let off = (12 - utcHour + 24) % 24;
if (off > 12) off -= 24;
const tz = off === 0 ? "UTC" : `Etc/GMT${off > 0 ? "-" : "+"}${Math.abs(off)}`;
const quando = new Date(Math.floor((Date.now() + 24 * HOUR - 10 * 60_000) / 60_000) * 60_000);

async function mkClinic(name, token) {
  const c = await prisma.clinic.create({ data: { name, whatsappPhone: `55119${Math.floor(Math.random() * 1e8)}`, timezone: tz, plan: "prime", uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: token } });
  const proc = await prisma.procedure.create({ data: { clinicId: c.id, name: "Botox", durationMin: 30, ceId: 111 } });
  await prisma.reminderRule.create({ data: { clinicId: c.id, hoursBefore: 24, active: true, message: "Olá, {primeiro_nome}! Confirmando {data} às {hora}: {procedimento}. Podemos contar com você?" } });
  return { c, proc };
}
let n = 0;
async function reserva(K, nome, uuid) {
  n++;
  const p = await prisma.patient.create({ data: { clinicId: K.c.id, name: nome, phone: `5511966${String(20000 + n)}` } });
  const a = await prisma.appointment.create({ data: { clinicId: K.c.id, patientId: p.id, procedureId: K.proc.id, scheduledAt: quando, ceBookingUuid: uuid ?? null, source: uuid ? "presencial" : "alice" } });
  return { p, a };
}
const enviouPara = (x) => posts.filter((m) => m.number === x.p.phone).length;
const abreDisjuntor = (clinicId) => { for (let i = 0; i < BREAKER_CONSECUTIVE; i++) noteVerdict(clinicId, { send: true, reason: "x", confidence: "baixa", reviewed: false, technical: "api_error" }); };

test("DISJUNTOR ABERTO: reserva CANCELADA ou REMARCADA no CE nao recebe o lembrete do horario velho; a valida recebe UM; a IA nem e consultada", async () => {
  resetBreakerForTests();
  const K = await mkClinic("Clinica Lembrete Disjuntor", "tok-ce");
  await prisma.clinicaExpertsAccount.create({ data: { clinicId: K.c.id, tokenEnc: encryptSecret("token-de-teste-com-mais-de-vinte-caracteres"), tokenHint: "••••test" } });
  const cancelada = await reserva(K, "Cancelada Silva", "ce-cancelada");
  const remarcada = await reserva(K, "Remarcada Souza", "ce-remarcada");
  const valida = await reserva(K, "Valida Lima", "ce-valida");
  const novoHorario = new Date(quando.getTime() + 72 * HOUR);
  ceHandler = ({ path: p }) => {
    if (p.endsWith("/bookings/ce-cancelada")) return jsonRes(200, { data: { uuid: "ce-cancelada", status: "canceled", starts_at: quando.toISOString() } });
    if (p.endsWith("/bookings/ce-remarcada")) return jsonRes(200, { data: { uuid: "ce-remarcada", status: "scheduled", starts_at: novoHorario.toISOString() } });
    if (p.endsWith("/bookings/ce-valida")) return jsonRes(200, { data: { uuid: "ce-valida", status: "scheduled", starts_at: quando.toISOString() } });
    return jsonRes(404, {});
  };
  abreDisjuntor(K.c.id);
  assert.equal(breakerOpen(K.c.id), true, "premissa: o disjuntor desta clinica esta ABERTO");
  posts.length = 0; openaiCalls.length = 0;
  await runReminderCycle();

  assert.equal(enviouPara(cancelada), 0, "cancelada no CE: nenhum lembrete");
  assert.equal(enviouPara(remarcada), 0, "remarcada no CE: nenhum lembrete do horario velho");
  assert.equal(enviouPara(valida), 1, "a reserva valida recebe UM lembrete mesmo sem a revisao por IA");
  assert.equal(openaiCalls.length, 0, "disjuntor aberto: a IA de revisao nao e chamada");
  assert.equal((await prisma.appointment.findUnique({ where: { id: cancelada.a.id } })).status, "cancelled", "o cancelamento do CE foi aplicado aqui");
  assert.equal((await prisma.appointment.findUnique({ where: { id: remarcada.a.id } })).scheduledAt.getTime(), novoHorario.getTime(), "o horario novo do CE foi aplicado aqui");
  const d = await prisma.reminderDispatch.findMany({ where: { clinicId: K.c.id } });
  assert.deepEqual(d.filter((x) => x.patientId === valida.p.id).map((x) => x.state), ["sent"]);
  // outra rodada: nada em dobro
  await runReminderCycle();
  assert.equal(enviouPara(valida), 1);
  assert.equal(enviouPara(cancelada) + enviouPara(remarcada), 0);
  resetBreakerForTests();
});

test("WHATSAPP DESCONECTADO: o lembrete nao e tentado nem desistido (sem gastar tentativa); quando a conexao volta sai UMA vez", async () => {
  resetBreakerForTests();
  const K = await mkClinic("Clinica Lembrete Desconectada", "tok-sem-ce");
  const x = await reserva(K, "Espera Reconectar");
  providerMode["tok-sem-ce"] = "down";
  posts.length = 0;

  // rodada 1: o provedor recusa por desconexao (a clinica fica marcada); 4 rodadas depois (> teto de 3 tentativas): nada foi desistido
  await runReminderCycle();
  assert.equal((await prisma.clinic.findUnique({ where: { id: K.c.id } })).uazapiDownSince !== null, true, "a clinica ficou marcada");
  for (let i = 0; i < 4; i++) await runReminderCycle();
  assert.equal(enviouPara(x), 0);
  const rows = await prisma.reminderDispatch.findMany({ where: { clinicId: K.c.id } });
  assert.ok(rows.every((r) => r.state === "deferred" && r.attempt <= 2), `adiado, sem gastar tentativas: ${JSON.stringify(rows.map((r) => [r.state, r.attempt]))}`);
  assert.equal(await prisma.reminderSent.count({ where: { appointmentId: x.a.id } }), 0, "nenhum registro de 'enviado' ficou para tras");

  // a conexao volta: a conferencia de status libera (o tempo de espera e antecipado no banco) e o lembrete sai UMA vez
  providerMode["tok-sem-ce"] = "ok";
  const velho = new Date(Date.now() - 11 * 60_000);
  await prisma.clinic.update({ where: { id: K.c.id }, data: { uazapiDownCheckedAt: velho } });
  await prisma.reminderDispatch.updateMany({ where: { clinicId: K.c.id }, data: { updatedAt: velho } });
  await runReminderCycle();
  assert.equal(enviouPara(x), 1, "saiu uma vez");
  assert.equal((await prisma.clinic.findUnique({ where: { id: K.c.id } })).uazapiDownSince, null, "marca removida");
  await runReminderCycle();
  await runReminderCycle();
  assert.equal(enviouPara(x), 1, "nenhum envio acumulado nem duplicado");
  assert.deepEqual((await prisma.reminderDispatch.findMany({ where: { clinicId: K.c.id } })).map((r) => r.state), ["sent"]);
});
