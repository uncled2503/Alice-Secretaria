// ENTREGA DA RESPOSTA DA ALICE: o estado gravado tem que refletir o que de fato aconteceu com o envio (sent / blocked / unconfirmed / failed /
// failed_permanent), sem entrega duplicada, sem perda silenciosa e sem reenvio cego. Banco de verdade (SQLite temporario), UAZAPI/OpenAI simulados.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dbFile = path.join(os.tmpdir(), `alice-entrega-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY = "test-key";
process.env.AI_SEND_REVIEW = "on";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

let sendMode = "ok"; // ok | timeout | http500 | nowhatsapp | slow
let attempts = 0; // chamadas a /send/text (inclusive as que falharam)
const posts = []; // o que a UAZAPI aceitou: { number, text }
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const completion = (content) => ({ id: "c", object: "chat.completion", created: 1, model: "gpt-4o-mini", choices: [{ index: 0, message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.includes("openai.com")) return jsonRes(200, completion({ decisao: "enviar", confianca: "alta", motivo: "ok" }));
  if (u.hostname.endsWith("uazapi.com") && u.pathname === "/send/text") {
    attempts++;
    const b = JSON.parse(init.body);
    if (sendMode === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    if (sendMode === "http500") return jsonRes(500, { error: "falha interna" });
    if (sendMode === "nowhatsapp") return jsonRes(400, { message: "number is not on WhatsApp" });
    if (sendMode === "slow") await new Promise((r) => setTimeout(r, 120));
    posts.push({ number: b.number, text: b.text });
    return jsonRes(200, { id: "msg" });
  }
  return jsonRes(200, {});
};

const { prisma } = await import("../dist/db/client.js");
const { deliverAliceReply, recoverStuckReplies, maintainUazapiQueue } = await import("../dist/uazapi/client.js");
const { classifyConversationTail, runUnansweredCheck } = await import("../dist/crm/unanswered.js");
const { deliveredOnly } = await import("../dist/ai/delivery.js");
const { resetBreakerForTests } = await import("../dist/ai/sendGate.js");

test.after(async () => {
  await (await import("../dist/jobs/background.js")).drainBackground(); // tarefas em segundo plano terminam ANTES de o banco temporario ser apagado
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* arquivo temporario */ } }
});

const mkClinic = (name, extra = {}) => prisma.clinic.create({
  data: { name, whatsappPhone: `55119${Math.floor(Math.random() * 1e8)}`, timezone: "America/Sao_Paulo", plan: "prime", uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: `tok-${Math.random().toString(36).slice(2)}`, workDays: "0,1,2,3,4,5,6", workStartHour: 0, workEndHour: 24, ...extra },
});
const clinic = await mkClinic("Clinica Entrega");
const clinicFree = await mkClinic("Clinica Gratis", { plan: "free" });

let seq = 0;
const unico = (t) => `${t} ${Math.random().toString(36).slice(2)} (texto longo o bastante para valer como mensagem)`;
// Conversa com a fala da pessoa e a resposta da Alice gravada (como generateReply faz) no estado pedido.
async function cenario({ status = "pending", ageMin = 0, userAgeMin = null, takeover = false, c = clinic, content = unico("Claro! O endereço é a Av. Índico, 294") } = {}) {
  seq++;
  const patient = await prisma.patient.create({ data: { clinicId: c.id, name: `Pessoa ${seq}`, phone: `5511966${String(60000 + seq)}` } });
  const conv = await prisma.conversation.create({ data: { patientId: patient.id, humanTakeover: takeover } });
  const userAt = new Date(Date.now() - ((userAgeMin ?? ageMin + 1) * 60_000));
  await prisma.message.create({ data: { conversationId: conv.id, role: "user", content: "Qual o endereço?", createdAt: userAt } });
  const row = await prisma.message.create({ data: { conversationId: conv.id, role: "assistant", content, deliveryStatus: status, createdAt: new Date(Date.now() - ageMin * 60_000) } });
  return { patient, conv, row, content, c };
}
const statusOf = async (row) => (await prisma.message.findUnique({ where: { id: row.id } })).deliveryStatus;
const convOf = (s) => prisma.conversation.findUnique({ where: { id: s.conv.id } });
const failuresOf = (s) => prisma.activityLog.count({ where: { patientId: s.patient.id, type: "reply_failed" } });
const deliver = (s, text = s.content) => deliverAliceReply(s.c.id, s.patient.phone, s.conv.id, text);
const reset = () => { sendMode = "ok"; attempts = 0; posts.length = 0; resetBreakerForTests(); };

test("sent: a UAZAPI aceitou -> 'sent', uma unica mensagem sai e a conversa nao fica sinalizada", async () => {
  reset();
  const s = await cenario();
  await deliver(s);
  assert.equal(await statusOf(s.row), "sent");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].text, s.content);
  const conv = await convOf(s);
  assert.equal(conv.handoffPending, false);
  assert.equal(await failuresOf(s), 0);
});

test("blocked (plano): NAO vira 'sent', nada sai, a conversa fica sinalizada com o motivo e a pessoa conta como sem resposta", async () => {
  reset();
  const s = await cenario({ c: clinicFree });
  await deliver(s);
  assert.equal(await statusOf(s.row), "blocked");
  assert.equal(posts.length, 0);
  const conv = await convOf(s);
  assert.equal(conv.handoffPending, true);
  assert.match(conv.handoffReason ?? "", /Alice não conseguiu responder/);
  assert.equal(await failuresOf(s), 1);
  // historico: a fala que nunca chegou nao conta como dita
  const delivered = await prisma.message.findMany({ where: { conversationId: s.conv.id, ...deliveredOnly } });
  assert.ok(!delivered.some((m) => m.id === s.row.id));
  // e o aviso de "sem resposta" enxerga que a resposta nao saiu (antes tratava bloqueada como respondida)
  const msgs = await prisma.message.findMany({ where: { conversationId: s.conv.id }, orderBy: { createdAt: "desc" }, select: { role: true, createdAt: true, deliveryStatus: true } });
  const tail = classifyConversationTail(msgs);
  assert.equal(tail.unanswered, true);
  assert.match(tail.cause ?? "", /bloqueado pelo plano/);
});

test("timeout ambiguo: fica 'unconfirmed' (nao e entrega confirmada), nao lanca e NUNCA reenvia sozinha", async () => {
  reset();
  sendMode = "timeout";
  const s = await cenario();
  await deliver(s); // nao pode lancar
  assert.equal(await statusOf(s.row), "unconfirmed");
  assert.equal(attempts, 1);
  sendMode = "ok";
  await recoverStuckReplies();
  await maintainUazapiQueue();
  assert.equal(attempts, 1, "nenhuma nova tentativa depois do timeout");
  assert.equal(posts.length, 0);
  assert.equal(await statusOf(s.row), "unconfirmed");
  assert.equal((await convOf(s)).handoffPending, false, "envio incerto nao e tratado como falha da Alice");
});

test("falha do envio: 'failed' e a rotina de reenvio entrega depois; no total sai UMA mensagem", async () => {
  reset();
  sendMode = "http500";
  const s = await cenario();
  await assert.rejects(deliver(s));
  assert.equal(await statusOf(s.row), "failed");
  sendMode = "ok";
  await maintainUazapiQueue();
  assert.equal(await statusOf(s.row), "sent");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].text, s.content);
});

test("falha que nao para: depois do teto de reenvios a resposta EXPIRA, nada sai e a conversa vai para a equipe", async () => {
  reset();
  sendMode = "http500";
  const s = await cenario();
  await assert.rejects(deliver(s));
  for (let i = 0; i < 7; i++) await maintainUazapiQueue();
  assert.equal(await statusOf(s.row), "expired");
  assert.equal(posts.length, 0);
  const conv = await convOf(s);
  assert.equal(conv.handoffPending, true);
  assert.equal(await failuresOf(s), 1);
  const before = attempts;
  sendMode = "ok";
  await maintainUazapiQueue();
  assert.equal(attempts, before, "expirada nao e mais reenviada");
});

test("falha definitiva (numero sem WhatsApp): 'failed_permanent', sem lancar, sem insistir, equipe sinalizada", async () => {
  reset();
  sendMode = "nowhatsapp";
  const s = await cenario();
  await deliver(s);
  assert.equal(await statusOf(s.row), "failed_permanent");
  const after = attempts;
  sendMode = "ok";
  await maintainUazapiQueue();
  assert.equal(attempts, after);
  assert.equal(posts.length, 0);
  assert.equal((await convOf(s)).handoffPending, true);
});

test("a mesma resposta ja entregue ha pouco nao sai de novo (a linha repetida e descartada, sem falha)", async () => {
  reset();
  const s = await cenario({ status: "sent" });
  const dup = await prisma.message.create({ data: { conversationId: s.conv.id, role: "assistant", content: s.content, deliveryStatus: "pending" } });
  await deliver(s);
  assert.equal(posts.length, 0);
  assert.equal(await statusOf(dup), null);
  assert.equal(await failuresOf(s), 0);
});

test("a mesma resposta SENDO enviada por outra rodada: esta nao envia e NAO e descartada (se a outra falhar, a retomada a envia)", async () => {
  reset();
  const s = await cenario({ status: "sending" });
  const second = await prisma.message.create({ data: { conversationId: s.conv.id, role: "assistant", content: s.content, deliveryStatus: "pending" } });
  await deliver(s);
  assert.equal(posts.length, 0);
  assert.equal(await statusOf(second), "pending", "continua pendente, nao foi perdida");
  // a outra rodada falhou de vez (nada saiu): a retomada envia a que ficou
  await prisma.message.update({ where: { id: s.row.id }, data: { deliveryStatus: "expired" } });
  await prisma.message.updateMany({ where: { conversationId: s.conv.id, role: "user" }, data: { createdAt: new Date(Date.now() - 9 * 60_000) } });
  await prisma.message.update({ where: { id: second.id }, data: { createdAt: new Date(Date.now() - 6 * 60_000) } });
  await prisma.message.update({ where: { id: s.row.id }, data: { createdAt: new Date(Date.now() - 7 * 60_000) } });
  await recoverStuckReplies();
  await maintainUazapiQueue();
  assert.equal(await statusOf(second), "sent");
  assert.equal(posts.length, 1);
});

test("entregas simultaneas da MESMA resposta: so uma mensagem sai", async () => {
  reset();
  sendMode = "slow";
  const s = await cenario();
  await Promise.all([deliver(s), deliver(s), deliver(s)]);
  assert.equal(posts.length, 1);
  assert.equal(attempts, 1);
  assert.equal(await statusOf(s.row), "sent");
});

test("retomada: 'pending' parado e ainda a ultima fala volta pra fila e SAI; 'sending' parado vira sem confirmacao e nao sai; velha demais expira", async () => {
  reset();
  const parado = await cenario({ status: "pending", ageMin: 10 });
  const enviando = await cenario({ status: "sending", ageMin: 10 });
  const velha = await cenario({ status: "pending", ageMin: 45 });
  const recente = await cenario({ status: "pending", ageMin: 1 });
  const r = await recoverStuckReplies();
  assert.equal(r.resumed, 1);
  assert.equal(r.unconfirmed, 1);
  assert.equal(r.expired, 1);
  assert.equal(await statusOf(enviando.row), "unconfirmed");
  assert.equal(await statusOf(velha.row), "expired");
  assert.equal(await statusOf(recente.row), "pending", "o que ainda esta dentro do prazo normal nao e mexido");
  assert.equal((await convOf(velha)).handoffPending, true);
  await maintainUazapiQueue();
  assert.equal(await statusOf(parado.row), "sent");
  assert.deepEqual(posts.map((p) => p.text), [parado.content], "so a recuperavel foi enviada; nada antigo em massa");
});

test("retomada: resposta superada (pessoa escreveu depois), equipe assumiu ou mesma fala ja entregue = descartada sem falha e sem envio", async () => {
  reset();
  const superada = await cenario({ status: "pending", ageMin: 10 });
  await prisma.message.create({ data: { conversationId: superada.conv.id, role: "user", content: "Alguem ai?" } });
  const equipe = await cenario({ status: "pending", ageMin: 10, takeover: true });
  const jaEntregue = await cenario({ status: "pending", ageMin: 10 });
  await prisma.message.create({ data: { conversationId: jaEntregue.conv.id, role: "assistant", content: jaEntregue.content, deliveryStatus: "sent", createdAt: new Date(Date.now() - 60_000) } });
  // a "ja entregue" e mais nova que a pendente -> tambem a supera; o caso de conteudo igual e coberto pelo teste de burst acima
  const r = await recoverStuckReplies();
  assert.equal(r.superseded, 3);
  for (const s of [superada, equipe, jaEntregue]) assert.equal(await statusOf(s.row), null);
  await maintainUazapiQueue();
  assert.equal(posts.length, 0);
  assert.equal(await failuresOf(superada), 0);
});

test("aviso de 'sem resposta': resposta bloqueada/expirada conta como SEM resposta (e explica por que); a equipe respondendo conta como respondida", async () => {
  reset();
  const msgs = (arr) => arr.map(([role, deliveryStatus]) => ({ role, deliveryStatus: deliveryStatus ?? null, createdAt: new Date() }));
  assert.deepEqual(classifyConversationTail(msgs([["assistant", "sent"], ["user"]])).unanswered, false);
  assert.deepEqual(classifyConversationTail(msgs([["assistant", "unconfirmed"], ["user"]])).unanswered, false);
  assert.deepEqual(classifyConversationTail(msgs([["human"], ["user"]])).unanswered, false);
  assert.deepEqual(classifyConversationTail(msgs([["assistant", null], ["user"]])).unanswered, false);
  for (const [st, re] of [["blocked", /bloqueado pelo plano/], ["vetoed", /barrada/], ["expired", /expirou/], ["failed_permanent", /sem WhatsApp/], ["failed", /ainda não saiu/]]) {
    const t = classifyConversationTail(msgs([["assistant", st], ["user"]]));
    assert.equal(t.unanswered, true, st);
    assert.match(t.cause ?? "", re, st);
  }
  assert.equal(classifyConversationTail(msgs([["user"]])).cause, null, "sem resposta por silencio: sem causa de defeito");

  // integrado: a conversa com resposta bloqueada ha 20 min entra no aviso
  const s = await cenario({ status: "blocked", ageMin: 19, userAgeMin: 20 });
  await prisma.conversation.update({ where: { id: s.conv.id }, data: { lastMessageAt: new Date(Date.now() - 19 * 60_000) } });
  const alerted = await runUnansweredCheck(new Date());
  assert.ok(alerted >= 1);
  const conv = await convOf(s);
  assert.ok(conv.unansweredAlertAt, "avisou uma vez");
});
