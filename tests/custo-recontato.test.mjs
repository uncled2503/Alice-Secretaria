// RECONTATO x CENTRALIZACAO DAS CHAMADAS A OPENAI: a medicao/classificacao central nao acrescentou chamadas, nao consumiu etapas indevidamente e nao alterou a politica comercial.
// Os numeros abaixo sao os MESMOS medidos no checkout do commit e405310 (scripts/comparar-custo.mjs); aqui ficam como regressao. OpenAI e WhatsApp simulados.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.TZ = "UTC";
const dbFile = path.join(os.tmpdir(), `alice-custo-recontato-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY = "test-key";
process.env.AI_SEND_REVIEW = "off";
process.env.AI_APP_RETRIES = "1"; // como em producao: antes o SDK repetia 1 vez; agora a aplicacao repete 1 vez
process.env.AI_BLOCK_COOLDOWN_MS = "600000";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const judgeCalls = [];
const posts = [];
let openaiMode = "ok";
let uazapiMode = "ok";
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.includes("openai.com")) {
    judgeCalls.push(1);
    if (openaiMode === "http500") return jsonRes(500, { error: { message: "fora do ar" } });
    if (openaiMode === "quota") return jsonRes(429, { error: { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" } });
    const body = JSON.parse(init.body);
    return jsonRes(200, { id: "c", object: "chat.completion", created: 1, model: "gpt-4o-mini-2024-07-18", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ recontact: true, reason: "pediu informacao e sumiu", categoria: "outro" }) }, finish_reason: "stop" }], usage: { prompt_tokens: Math.ceil(JSON.stringify(body.messages).length / 4), completion_tokens: 20 } });
  }
  if (u.hostname.endsWith("uazapi.com") && u.pathname === "/send/text") {
    if (uazapiMode === "http500") return jsonRes(500, { error: "fora do ar" });
    posts.push(JSON.parse(init.body).number);
  }
  return jsonRes(200, { id: "msg", data: {} });
};

const { prisma } = await import("../dist/db/client.js");
const { runFollowUpCheck } = await import("../dist/crm/followup.js");
const oc = await import("../dist/ai/openaiCall.js");

test.after(async () => {
  await (await import("../dist/ai/usageStats.js")).flushUsage();
  await (await import("../dist/jobs/background.js")).drainBackground();
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* temporario */ } }
});

const TZ = "America/Sao_Paulo";
const sp = (iso) => new Date(`${iso}-03:00`);
let seq = 0;
async function clinica(nome) {
  const c = await prisma.clinic.create({ data: { name: nome, whatsappPhone: `55119${Math.floor(Math.random() * 1e8)}`, timezone: TZ, plan: "prime", aliceActive: true, uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: `tok-${Math.random().toString(36).slice(2)}`, workDays: "1,2,3,4,5,6", workStartHour: 8, workEndHour: 21, hoursByDay: JSON.stringify({ 6: [8, 15] }), closedOnHolidays: false } });
  await prisma.followUpRule.create({ data: { clinicId: c.id, order: 1, name: "4 horas", afterDays: 1, afterMinutes: 240, message: "Oi, {primeiro_nome}! Recontato 1.", repeatMode: "once", skipIfHumanTakeover: true, skipIfUpcomingAppt: true, active: true } });
  return c;
}
async function lead(c, nome, { optedOut = false, humano = false, comHorario = false } = {}) {
  seq++;
  const p = await prisma.patient.create({ data: { clinicId: c.id, name: nome, phone: `551198888${String(3000 + seq)}`, interestNote: "limpeza de pele", optedOut } });
  const userAt = sp("2026-10-15T09:00");
  const conv = await prisma.conversation.create({ data: { patientId: p.id, status: "active", lastMessageAt: new Date(userAt.getTime() + 60_000), humanTakeover: humano } });
  await prisma.message.create({ data: { conversationId: conv.id, role: "user", content: "Quero saber sobre limpeza de pele", createdAt: userAt } });
  await prisma.message.create({ data: { conversationId: conv.id, role: "assistant", content: "Claro! A limpeza de pele custa a avaliacao gratuita. Quer ver um horario?", createdAt: new Date(userAt.getTime() + 60_000), deliveryStatus: "sent" } });
  if (comHorario) {
    const proc = await prisma.procedure.create({ data: { clinicId: c.id, name: "Limpeza de pele", durationMin: 30 } });
    await prisma.appointment.create({ data: { clinicId: c.id, patientId: p.id, procedureId: proc.id, scheduledAt: sp("2026-10-16T10:00"), source: "presencial", status: "confirmed" } });
  }
  return { p, conv };
}
const estado = async (l) => {
  const conv = await prisma.conversation.findUnique({ where: { id: l.conv.id } });
  const rows = await prisma.followUpDispatch.findMany({ where: { patientId: l.p.id, flow: "recontato" }, orderBy: { createdAt: "asc" } });
  return { ponteiro: conv.lastFollowUpOrder, controle: rows.map((r) => `${r.state}${r.layer ? `/${r.layer}` : ""}`), vetos: rows.reduce((s, r) => s + r.vetoes, 0) };
};
const rodar = (c, iso) => runFollowUpCheck({ now: sp(iso), sleep: async () => undefined, clinicId: c.id });
const zera = () => { judgeCalls.length = 0; posts.length = 0; openaiMode = "ok"; uazapiMode = "ok"; oc.resetOpenAiHealthForTests(); };

test("RECONTATO elegivel: 1 consulta ao juiz, 1 mensagem, a etapa 1 consumida (igual ao commit anterior)", async () => {
  zera();
  const c = await clinica("Rec Elegivel"); const a = await lead(c, "Maria Elegivel");
  await rodar(c, "2026-10-15T14:30");
  assert.equal(judgeCalls.length, 1);
  assert.equal(posts.length, 1);
  assert.deepEqual(await estado(a), { ponteiro: 1, controle: ["sent/envio"], vetos: 0 });
});

test("RECONTATO inelegivel (reserva vigente, pediu para sair, equipe atendendo): nenhuma chamada paga, nenhuma mensagem, nenhuma etapa consumida", async () => {
  zera();
  const c = await clinica("Rec Inelegivel");
  const L = [await lead(c, "Com Horario", { comHorario: true }), await lead(c, "Pediu Sair", { optedOut: true }), await lead(c, "Com Equipe", { humano: true })];
  await rodar(c, "2026-10-15T14:30");
  assert.equal(judgeCalls.length, 0);
  assert.equal(posts.length, 0);
  for (const l of L) assert.deepEqual(await estado(l), { ponteiro: 0, controle: [], vetos: 0 });
});

test("RECONTATO veredito reaproveitado: o envio falha, a nova rodada NAO consulta o juiz de novo e a mensagem sai uma vez", async () => {
  zera();
  const c = await clinica("Rec Reaproveita"); const a = await lead(c, "Maria Reaproveita");
  uazapiMode = "http500";
  await rodar(c, "2026-10-15T14:30");
  assert.equal(posts.length, 0);
  uazapiMode = "ok";
  await rodar(c, "2026-10-15T14:50");
  assert.equal(judgeCalls.length, 1, "o veredito foi reaproveitado (mesmo contexto)");
  assert.equal(posts.length, 1);
  assert.equal((await estado(a)).ponteiro, 1);
});

test("RECONTATO com servico indisponivel (500): 2 consultas (1 + 1 nova tentativa, como o SDK fazia), etapa NAO consumida, sem veto; quando volta, sai UMA mensagem", async () => {
  zera();
  const c = await clinica("Rec Indisponivel"); const a = await lead(c, "Maria Indisponivel");
  openaiMode = "http500";
  await rodar(c, "2026-10-15T14:30");
  assert.equal(judgeCalls.length, 2, "uma tentativa + uma nova tentativa (igual ao commit anterior)");
  assert.equal(posts.length, 0);
  assert.deepEqual(await estado(a), { ponteiro: 0, controle: ["deferred/juiz_ia"], vetos: 0 });
  openaiMode = "ok";
  await rodar(c, "2026-10-15T14:50");
  assert.equal(posts.length, 1);
  assert.deepEqual(await estado(a), { ponteiro: 1, controle: ["sent/envio"], vetos: 0 });
});

test("RECONTATO com SALDO ESGOTADO: 1 consulta no total (antes: 8 em 2 rodadas com 2 candidatas), nenhuma etapa consumida, sem veto, sem mensagem; recuperado o saldo, as duas saem uma vez", async () => {
  zera();
  const c = await clinica("Rec Saldo"); const L = [await lead(c, "Quota Um"), await lead(c, "Quota Dois")];
  openaiMode = "quota";
  await rodar(c, "2026-10-15T14:30");
  await rodar(c, "2026-10-15T14:50");
  assert.equal(judgeCalls.length, 1, "uma unica requisicao real; as demais foram bloqueadas localmente");
  assert.equal(posts.length, 0);
  for (const l of L) assert.deepEqual(await estado(l), { ponteiro: 0, controle: ["deferred/juiz_ia"], vetos: 0 });
  assert.equal(oc.openAiHealth().state, "sem_saldo");
  // saldo recarregado: a proxima chamada real e a verificacao; as demais esperam ela terminar
  openaiMode = "ok";
  oc.expireOpenAiBlockForTests();
  await rodar(c, "2026-10-15T15:10");
  await rodar(c, "2026-10-15T15:30");
  assert.equal(oc.openAiHealth().state, "ok");
  assert.equal(posts.length, 2, "as duas candidatas recebem, uma vez cada (nada acumulado nem duplicado)");
  for (const l of L) assert.equal((await estado(l)).ponteiro, 1);
});
