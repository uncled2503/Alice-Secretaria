// CONEXAO DO WHATSAPP POR CLINICA: quando o provedor diz "WhatsApp disconnected: session is not reconnectable" a CLINICA fica marcada (e so ela), os envios automaticos
// dela param de bater no provedor, a equipe ve o aviso em Canais SEM depender do WhatsApp, nada se perde (campanha e retorno combinado esperam) e a marca cai sozinha.
// Banco de verdade (SQLite temporario), apiRouter real e o provedor simulado por um fetch falso (um comportamento por token = por clinica).
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dbFile = path.join(os.tmpdir(), `alice-conexao-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY = "test-key";
process.env.AI_SEND_REVIEW = "off";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

// provedor: comportamento por token
const behavior = { "tok-a": "down", "tok-b": "ok" }; // down | ok | unreachable
const calls = { "tok-a": { send: 0, status: 0 }, "tok-b": { send: 0, status: 0 } };
const sent = []; // { token, number }
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.endsWith("uazapi.com")) {
    const token = init.headers?.token;
    const mode = behavior[token];
    if (mode === "unreachable") throw Object.assign(new Error("fetch failed"), { name: "TypeError" });
    if (u.pathname === "/send/text") {
      calls[token].send++;
      if (mode === "down") return jsonRes(503, { error: "WhatsApp disconnected: session is not reconnectable" });
      sent.push({ token, number: JSON.parse(init.body).number });
      return jsonRes(200, { id: "msg" });
    }
    if (u.pathname === "/instance/status") {
      calls[token].status++;
      return jsonRes(200, mode === "down" ? { instance: { status: "disconnected" }, status: { connected: false } } : { instance: { status: "connected" }, status: { connected: true } });
    }
    return jsonRes(200, {});
  }
  if (u.hostname === "127.0.0.1") return realFetch(url, init); // chamadas do proprio teste ao apiRouter
  return jsonRes(404, {});
};

const { prisma } = await import("../dist/db/client.js");
const { sendText, connectionNotice, connectionUsable, isConnectionDownError, isSendDeferred } = await import("../dist/uazapi/client.js");
const { apiRouter } = await import("../dist/api/routes.js");
const { runBroadcastTick } = await import("../dist/crm/broadcast.js");
const { runCallbackCheck } = await import("../dist/crm/hotLeads.js");
const { default: express } = await import("express");

const app = express();
app.use(express.json());
let who = null; // quem esta "logado" nas chamadas ao apiRouter
app.use((req, _res, next) => { req.staff = who; next(); });
app.use("/api", apiRouter);
const server = http.createServer(app).listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;

test.after(async () => {
  server.close();
  await (await import("../dist/jobs/background.js")).drainBackground();
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* arquivo temporario */ } }
});

const mk = (name, token) => prisma.clinic.create({
  data: {
    name, whatsappPhone: `55119${Math.floor(Math.random() * 1e8)}`, timezone: "America/Sao_Paulo", plan: "prime", aliceActive: true,
    uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: token,
    workDays: "0,1,2,3,4,5,6", workStartHour: 0, workEndHour: 24, hoursByDay: null, closedOnHolidays: false, // sempre aberta: o teste nao depende da hora do dia
  },
});
const A = await mk("Clinica A (desconectada)", "tok-a");
const B = await mk("Clinica B (normal)", "tok-b");
let n = 0;
const pessoa = (clinic, extra = {}) => { n++; return prisma.patient.create({ data: { clinicId: clinic.id, name: `Pessoa ${n}`, phone: `5511977${String(10000 + n)}`, ...extra } }); };
const texto = (s) => `${s} ${Math.random().toString(36).slice(2)} - mensagem automatica de teste com tamanho suficiente.`;
const activities = (clinicId, type) => prisma.activityLog.count({ where: { clinicId, type } });
// o diario e gravado em segundo plano: espera ate 3 s pelo valor esperado
const waitActivities = async (clinicId, type, want) => { let c = 0; for (let i = 0; i < 30; i++) { c = await activities(clinicId, type); if (c >= want) break; await new Promise((r) => setTimeout(r, 100)); } return c; };
const get = async (p, staff) => { who = staff; const r = await fetch(base + p); who = null; return { status: r.status, body: await r.json() }; };

test("o provedor diz 'sessao desconectada': so a CLINICA que recebeu o erro fica marcada; a outra segue enviando", async () => {
  const pa = await pessoa(A);
  // automatico: o chamador recebe o erro tipado (adia, nao gasta tentativa); a equipe (manual) recebe o erro cru do provedor
  await assert.rejects(() => sendText(A.id, pa.phone, texto("Confirmando seu horario"), { kind: "lembrete" }), (e) => isConnectionDownError(e) && isSendDeferred(e));
  const a = await prisma.clinic.findUnique({ where: { id: A.id } });
  assert.ok(a.uazapiDownSince, "A marcada");
  assert.match(a.uazapiDownReason, /not reconnectable|disconnected/i);
  const b = await prisma.clinic.findUnique({ where: { id: B.id } });
  assert.equal(b.uazapiDownSince, null, "B nao foi tocada");
  const pb = await pessoa(B);
  assert.equal(await sendText(B.id, pb.phone, texto("Confirmando seu horario"), { kind: "lembrete" }), "sent");
  assert.equal(sent.filter((x) => x.token === "tok-b").length, 1);
  assert.equal(await waitActivities(A.id, "whatsapp_disconnected", 1), 1);
  assert.equal(await activities(B.id, "whatsapp_disconnected"), 0);
});

test("clinica marcada: o envio AUTOMATICO nem chega no provedor (e nao repete o aviso); o envio MANUAL da equipe continua tentando para a pessoa ver o erro", async () => {
  const antes = calls["tok-a"].send;
  for (let i = 0; i < 3; i++) {
    const p = await pessoa(A);
    await assert.rejects(() => sendText(A.id, p.phone, texto("Recontato"), { kind: "recontato" }), (e) => isConnectionDownError(e) && isSendDeferred(e));
  }
  assert.equal(calls["tok-a"].send, antes, "nenhuma chamada ao provedor para envio automatico");
  const p = await pessoa(A);
  await assert.rejects(() => sendText(A.id, p.phone, "Oi, aqui e a recepcao, tudo bem?", { manual: true }), /503/);
  assert.equal(calls["tok-a"].send, antes + 1, "a equipe tentou de verdade");
  assert.equal(await activities(A.id, "whatsapp_disconnected"), 1, "um aviso so, nao um por envio");
});

test("CANAIS: o aviso vem do banco - aparece mesmo com o provedor INALCANCAVEL; cliente nao ve o erro cru, admin ve; a outra clinica nao mostra nada", async () => {
  behavior["tok-a"] = "unreachable";
  try {
    const cli = await get("/whatsapp/status", { role: "client", clinicId: A.id, name: "Dona A" });
    assert.equal(cli.status, 200);
    assert.equal(cli.body.connected, false);
    assert.ok(cli.body.sendsPaused, "aviso presente");
    assert.ok(cli.body.sendsPaused.since);
    assert.equal(cli.body.sendsPaused.reason, null, "conta de clinica nao ve a resposta crua do provedor");
    const adm = await get(`/whatsapp/status?clinicId=${A.id}`, { role: "admin" });
    assert.match(adm.body.sendsPaused.reason, /disconnected|reconnectable/i, "admin ve o motivo tecnico");
    const outra = await get("/whatsapp/status", { role: "client", clinicId: B.id, name: "Dona B" });
    assert.equal(outra.body.sendsPaused, null);
    assert.equal(outra.body.connected, true);
    // a lista do admin tambem sinaliza (so a clinica A)
    const lista = await get("/clinics", { role: "admin" });
    const porNome = Object.fromEntries(lista.body.map((c) => [c.id, c.uazapiDownSince]));
    assert.ok(porNome[A.id]);
    assert.equal(porNome[B.id] ?? null, null);
  } finally { behavior["tok-a"] = "down"; }
  const notice = await connectionNotice(A.id);
  assert.equal(notice.paused, true);
  assert.equal((await connectionNotice(B.id)).paused, false);
});

test("o painel (Canais) tem o aviso e as duas telas o mostram", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const js = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.ok(html.includes('id="channel-paused-notice"') && html.includes('id="channel-paused-text"'));
  assert.ok(js.includes("status.sendsPaused") && js.includes('getElementById("channel-paused-notice")'));
  assert.ok(js.includes("Envios pausados"), "etiqueta na lista de clinicas do admin");
});

test("nada se perde: campanha e retorno combinado ESPERAM a conexao voltar (destinatario segue pendente, retorno devolvido, sem aviso repetido)", async () => {
  // campanha: 2 destinatarios pendentes
  const p1 = await pessoa(A); const p2 = await pessoa(A);
  const camp = await prisma.broadcastCampaign.create({ data: { clinicId: A.id, title: "Promo", message: "Oi, {primeiro_nome}! Temos uma novidade para voce esta semana, vem conferir.", scheduledFor: new Date(Date.now() - 60_000), status: "sending" } });
  await prisma.broadcastRecipient.createMany({ data: [{ campaignId: camp.id, patientId: p1.id }, { campaignId: camp.id, patientId: p2.id }] });
  const antes = calls["tok-a"].send;
  await runBroadcastTick();
  const rec = await prisma.broadcastRecipient.findMany({ where: { campaignId: camp.id } });
  assert.deepEqual(rec.map((r) => r.status), ["pending", "pending"], "ninguem virou 'failed': a campanha espera");
  assert.equal((await prisma.broadcastCampaign.findUnique({ where: { id: camp.id } })).status, "sending");
  assert.equal(calls["tok-a"].send, antes, "o provedor nao foi chamado");

  // retorno combinado vencido
  const due = new Date(Date.now() - 5 * 60_000);
  const q = await pessoa(A, { callbackAt: due, callbackNote: "depois do almoco" });
  const staffMsgs = await prisma.activityLog.count({ where: { clinicId: A.id, type: "automation_failed" } });
  await runCallbackCheck();
  const depois = await prisma.patient.findUnique({ where: { id: q.id } });
  assert.ok(depois.callbackAt, "o retorno combinado foi devolvido para a proxima rodada, nao apagado");
  assert.equal(depois.callbackNote, "depois do almoco");
  assert.equal(await prisma.activityLog.count({ where: { clinicId: A.id, type: "automation_failed" } }), staffMsgs, "sem aviso repetido por rodada");
  assert.equal(calls["tok-a"].send, antes, "o provedor continua sem ser chamado");
});

test("RECUPERACAO: quando o provedor volta, a marca cai sozinha (conferencia de status, sem enviar nada), avisa 'reconectado' uma vez e a campanha retomada envia", async () => {
  behavior["tok-a"] = "ok";
  const antesSend = calls["tok-a"].send;
  // dentro dos 10 min a clinica segue marcada (nao martela o provedor)
  assert.equal((await connectionUsable(A.id, new Date(Date.now() + 60_000))).usable, false);
  assert.equal(calls["tok-a"].send, antesSend);
  // passado o intervalo, a CONSULTA DE STATUS (nao um envio) libera
  const r = await connectionUsable(A.id, new Date(Date.now() + 11 * 60_000));
  assert.equal(r.usable, true);
  assert.equal((await connectionNotice(A.id)).paused, false);
  assert.equal(calls["tok-a"].send, antesSend, "a liberacao nao enviou mensagem nenhuma");
  assert.equal(await waitActivities(A.id, "whatsapp_reconnected", 1), 1);
  const st = await get("/whatsapp/status", { role: "client", clinicId: A.id, name: "Dona A" });
  assert.equal(st.body.sendsPaused, null, "o aviso some do painel");
  // o que ficou pendente segue agora: UM envio por destinatario (nada em dobro)
  const camp = await prisma.broadcastCampaign.findFirst({ where: { clinicId: A.id, title: "Promo" } });
  const rodar = runBroadcastTick();
  await rodar; // pausa aleatoria de 4-10 s entre os dois envios
  const rec = await prisma.broadcastRecipient.findMany({ where: { campaignId: camp.id } });
  assert.deepEqual(rec.map((x) => x.status), ["sent", "sent"]);
  const porNumero = new Map();
  for (const s of sent.filter((x) => x.token === "tok-a")) porNumero.set(s.number, (porNumero.get(s.number) ?? 0) + 1);
  assert.ok([...porNumero.values()].every((c) => c === 1), "cada pessoa recebeu uma vez");
  // o retorno combinado devolvido tambem sai agora, uma vez
  await runCallbackCheck();
  assert.equal(await prisma.patient.count({ where: { clinicId: A.id, callbackAt: { not: null } } }), 0);
});
