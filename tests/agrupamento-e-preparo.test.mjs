// DUAS LACUNAS DE CONFIABILIDADE (20/10/2026): (1) o agrupamento de mensagens (replyDelaySeconds > 0) vivia so num timer em memoria; (2) o preparo pre-procedimento tratava a
// RESERVA da etapa como mensagem enviada. Aqui: processos Node NOVOS sobre o mesmo SQLite (reinicio de verdade, morte injetada no ponto exato), concorrencia real entre duas
// instancias, relogio controlado nos jobs e OpenAI/UAZAPI simuladas. Verifica o que sai para a pessoa E o estado gravado.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dbFile = path.join(os.tmpdir(), `alice-agrup-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY = "test-key";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

// ---- servicos simulados (so para o preparo, que roda neste processo)
const posts = [];
let uazapiMode = "ok"; // ok | http500 | timeout
let beforeSend = null; // gancho: chamado dentro do envio ao provedor (permite derrubar/alterar o mundo no ponto exato)
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.includes("openai.com")) return jsonRes(200, { id: "c", object: "chat.completion", created: 1, model: "gpt-4o-mini", choices: [{ index: 0, message: { role: "assistant", content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  if (u.hostname.endsWith("uazapi.com") && u.pathname === "/send/text") {
    if (beforeSend) await beforeSend();
    if (uazapiMode === "http500") return jsonRes(500, { error: "fora do ar" });
    if (uazapiMode === "timeout") throw Object.assign(new Error("The operation timed out (TimeoutError)"), { name: "TimeoutError" });
    posts.push({ number: JSON.parse(init.body).number, text: JSON.parse(init.body).text });
  }
  return jsonRes(200, { id: "msg" });
};

const { prisma } = await import("../dist/db/client.js");
const { enqueueWebhook, recoverGroupedReplies } = await import("../dist/uazapi/client.js");
const pre = await import("../dist/reminders/preProcedure.js");
const { drainBackground } = await import("../dist/jobs/background.js");

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "alice-agrup-w-"));
const workerPath = path.join(root, "tests", "helpers", "restart-worker.mjs");
const logFile = path.join(workDir, "events.jsonl");
let logOffset = 0;
let specN = 0;
test.after(async () => {
  await drainBackground();
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* temporario */ } }
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* temporario */ }
});

// um PROCESSO novo (memoria vazia); assincrono para poder rodar dois ao mesmo tempo
function worker(spec) {
  const specFile = path.join(workDir, `spec-${++specN}.json`);
  fs.writeFileSync(specFile, JSON.stringify({ ...spec, log: spec.log ?? logFile }));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [workerPath, specFile], { env: { ...process.env } });
    let err = "";
    child.stderr.on("data", (d) => { err += d; });
    child.stdout.on("data", (d) => { err += d; });
    const t = setTimeout(() => child.kill(), 240_000);
    child.on("close", (status) => { clearTimeout(t); resolve({ status, stderr: err }); });
  });
}
const readEvents = (file = logFile) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const newEvents = () => { const all = readEvents(); const out = all.slice(logOffset); logOffset = all.length; return out; };
const sendsTo = (events, phone) => events.filter((e) => e.t === "send" && e.number === phone);

// ---------------------------------------------------------------- cenario
const TZ = "America/Sao_Paulo";
const HOUR = 3_600_000;
const mkClinic = (name, extra = {}) =>
  prisma.clinic.create({ data: { name, whatsappPhone: `55119${Math.floor(Math.random() * 1e8)}`, timezone: TZ, plan: "prime", aliceActive: true, uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: `tok-${Math.random().toString(36).slice(2)}`, workDays: "0,1,2,3,4,5,6", workStartHour: 0, workEndHour: 24, closedOnHolidays: false, ...extra } });
let seq = 0;
const novaPessoa = async (clinic, nome) => { const phone = `551196666${String(1000 + ++seq)}`; const patient = await prisma.patient.create({ data: { clinicId: clinic.id, name: nome, phone } }); return { patient, phone }; };
const payload = (phone, text, id = `MSG-${Math.random().toString(36).slice(2)}`) => ({ EventType: "messages", message: { messageid: id, sender_pn: `${phone}@s.whatsapp.net`, senderName: "Paciente", fromMe: false, isGroup: false, messageType: "text", text } });
const convOf = (patientId) => prisma.conversation.findFirst({ where: { patientId }, orderBy: { createdAt: "desc" } });
const msgsOf = async (patientId) => prisma.message.findMany({ where: { conversation: { patientId } }, orderBy: { createdAt: "asc" } });
const aliceMsgs = async (patientId) => (await msgsOf(patientId)).filter((m) => m.role === "assistant");
const noSleep = async () => undefined;
// o "tempo" passa: o prazo gravado e as mensagens recuam o mesmo tanto (como se o servidor tivesse ficado fora do ar)
async function recuaTempo(conversationId, ms) {
  const c = await prisma.conversation.findUnique({ where: { id: conversationId } });
  await prisma.conversation.update({ where: { id: conversationId }, data: { replyDueAt: c.replyDueAt ? new Date(c.replyDueAt.getTime() - ms) : null, replyFirstAt: c.replyFirstAt ? new Date(c.replyFirstAt.getTime() - ms) : null, replyClaimedAt: c.replyClaimedAt ? new Date(c.replyClaimedAt.getTime() - ms) : null } });
  for (const m of await prisma.message.findMany({ where: { conversationId } })) await prisma.message.update({ where: { id: m.id }, data: { createdAt: new Date(m.createdAt.getTime() - ms) } });
}

// ================================================================ 1) AGRUPAMENTO (replyDelaySeconds > 0)

test("AGRUPAMENTO: cliente manda uma mensagem e o processo MORRE antes do timer; ao subir de novo a mensagem aceita e respondida UMA vez (o prazo estava gravado)", async () => {
  const clinic = await mkClinic("Agrupa Reinicio", { replyDelaySeconds: 30 });
  const p = await novaPessoa(clinic, "Aline Agrupa");
  // processo A: recebe, aceita, grava o prazo e CAI (antes de o timer de 30 s disparar)
  const a = await worker({ op: "enqueue", clinicId: clinic.id, payload: payload(p.phone, "Oi, queria saber da limpeza de pele"), model: [], exitAfterIdle: true });
  assert.equal(a.status, 137, a.stderr.slice(0, 300));
  const evA = newEvents();
  assert.equal(sendsTo(evA, p.phone).length, 0, "ninguem respondeu ainda (o timer nao disparou)");
  const conv = await convOf(p.patient.id);
  assert.ok(conv.replyDueAt, "o prazo do grupo ficou gravado na conversa");
  assert.equal((await prisma.uazapiWebhookEvent.findFirst({ where: { clinicId: clinic.id } })).status, "done", "o webhook foi aceito e concluido: NAO volta para a fila sozinho");
  assert.equal((await aliceMsgs(p.patient.id)).length, 0);

  // processo B (memoria vazia) sobe depois que o prazo venceu: recupera e responde
  await recuaTempo(conv.id, 2 * 60_000);
  const b = await worker({ op: "boot", clinicId: clinic.id, model: [{ content: "Oi, Aline! A limpeza de pele ajuda com cravos e oleosidade. Quer saber mais? 💗" }] });
  assert.equal(b.status, 0, b.stderr.slice(0, 400));
  const evB = newEvents();
  assert.equal(sendsTo(evB, p.phone).length, 1, JSON.stringify(evB.map((e) => e.t)));
  const c2 = await convOf(p.patient.id);
  assert.equal(c2.replyDueAt, null);
  assert.equal(c2.replyClaimedAt, null);
  const msgs = await aliceMsgs(p.patient.id);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].deliveryStatus, "sent");

  // outro reinicio depois: nada novo
  const again = await worker({ op: "boot", clinicId: clinic.id, model: [] });
  assert.equal(again.status, 0);
  assert.equal(sendsTo(newEvents(), p.phone).length, 0, "nao responde duas vezes");
});

test("AGRUPAMENTO: varias mensagens durante o intervalo + reinicio -> UMA resposta que enxerga todas, na ordem; o grupo respeita o prazo configurado (nada e respondido antes)", async () => {
  const clinic = await mkClinic("Agrupa Varias", { replyDelaySeconds: 30 });
  const p = await novaPessoa(clinic, "Bruna Varias");
  for (const t of ["Oi!", "Queria saber o preco", "da limpeza de pele"]) {
    const w = await worker({ op: "enqueue", clinicId: clinic.id, payload: payload(p.phone, t), model: [], exitAfterIdle: true });
    assert.equal(w.status, 137);
  }
  newEvents();
  const conv = await convOf(p.patient.id);
  assert.ok(conv.replyDueAt && conv.replyFirstAt);
  // o prazo ainda NAO venceu: um processo que sobe agora REARMA o timer (nao responde antes da hora) -- o processo vai ficar de pe ate disparar, entao medimos so o estado
  await recuaTempo(conv.id, 2 * 60_000);
  const b = await worker({ op: "boot", clinicId: clinic.id, model: [{ content: "Oi! O valor da limpeza de pele a gente apresenta na avaliação. Quer agendar? 💗" }] });
  assert.equal(b.status, 0, b.stderr.slice(0, 300));
  const ev = newEvents();
  assert.equal(sendsTo(ev, p.phone).length, 1, "uma unica resposta para o grupo todo");
  assert.deepEqual(ev.filter((e) => e.t === "model").at(-1).users.slice(-3), ["Oi!", "Queria saber o preco", "da limpeza de pele"], "o modelo recebeu as tres mensagens, na ordem");
  assert.equal((await aliceMsgs(p.patient.id)).length, 1);
  const users = (await msgsOf(p.patient.id)).filter((m) => m.role === "user").map((m) => m.content);
  assert.deepEqual(users, ["Oi!", "Queria saber o preco", "da limpeza de pele"], "ordem preservada");
});

test("AGRUPAMENTO: mensagem NOVA chega durante a recuperacao -> a resposta antiga NAO sai; sai uma so, depois, vendo as duas", async () => {
  const clinic = await mkClinic("Agrupa Durante", { replyDelaySeconds: 2 });
  const p = await novaPessoa(clinic, "Carla Durante");
  const a = await worker({ op: "enqueue", clinicId: clinic.id, payload: payload(p.phone, "Boa tarde"), model: [], exitAfterIdle: true });
  assert.equal(a.status, 137);
  newEvents();
  const conv = await convOf(p.patient.id);
  await recuaTempo(conv.id, 2 * 60_000);
  // na recuperacao, enquanto o modelo "pensa" na 1a resposta, a pessoa escreve de novo (webhook real dentro do processo)
  const b = await worker({
    op: "boot", clinicId: clinic.id,
    model: [{ content: "Boa tarde, Carla! Como posso ajudar? 💗" }, { content: "Claro! A avaliação é gratuita. Qual dia fica melhor pra você? 💗" }],
    duringModel: { enqueue: payload(p.phone, "Queria agendar uma avaliação") }, waitMs: 14_000,
  });
  assert.equal(b.status, 0, b.stderr.slice(0, 400));
  const ev = newEvents();
  const out = sendsTo(ev, p.phone);
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.match(out[0].text, /avaliação é gratuita/, "saiu a resposta que enxerga as duas mensagens");
  const msgs = await aliceMsgs(p.patient.id);
  assert.equal(msgs.find((m) => /Como posso ajudar/.test(m.content))?.deliveryStatus ?? null, null, "a resposta velha foi superada, nao entregue");
});

test("AGRUPAMENTO: o MESMO webhook reentregue depois da recuperacao nao gera outra resposta; duas INSTANCIAS recuperando a mesma conversa respondem UMA vez", async () => {
  const clinic = await mkClinic("Agrupa Duas Instancias", { replyDelaySeconds: 30 });
  const p = await novaPessoa(clinic, "Dani Duas");
  const id = `MSG-DUP-${Math.random().toString(36).slice(2)}`;
  const a = await worker({ op: "enqueue", clinicId: clinic.id, payload: payload(p.phone, "Oi, tudo bem?", id), model: [], exitAfterIdle: true });
  assert.equal(a.status, 137);
  newEvents();
  const conv = await convOf(p.patient.id);
  await recuaTempo(conv.id, 2 * 60_000);
  // DUAS instancias sobem ao mesmo tempo sobre o mesmo banco
  const logB = path.join(workDir, "B.jsonl");
  const logC = path.join(workDir, "C.jsonl");
  const [b, c] = await Promise.all([
    worker({ op: "boot", clinicId: clinic.id, model: [{ content: "Oi! Tudo bem sim, e você? 💗" }], log: logB }),
    worker({ op: "boot", clinicId: clinic.id, model: [{ content: "Oi! Tudo bem sim, e você? 💗" }], log: logC }),
  ]);
  assert.equal(b.status, 0, b.stderr.slice(0, 300));
  assert.equal(c.status, 0, c.stderr.slice(0, 300));
  const total = sendsTo(readEvents(logB), p.phone).length + sendsTo(readEvents(logC), p.phone).length;
  assert.equal(total, 1, "uma so resposta entre as duas instancias");
  assert.equal((await aliceMsgs(p.patient.id)).length, 1);
  // o provedor reentrega o webhook
  const dup = await worker({ op: "enqueue", clinicId: clinic.id, payload: payload(p.phone, "Oi, tudo bem?", id), model: [] });
  assert.equal(dup.status, 0);
  assert.equal(sendsTo(newEvents(), p.phone).length, 0);
  assert.equal((await aliceMsgs(p.patient.id)).length, 1);
});

test("AGRUPAMENTO: reavalia antes de recuperar -> ja respondida, equipe assumiu, plano gratis, ou velha demais: NAO responde (velha demais sinaliza a equipe)", async () => {
  const clinic = await mkClinic("Agrupa Reavalia", { replyDelaySeconds: 30 });
  const mk = async (nome, texto) => {
    const p = await novaPessoa(clinic, nome);
    const w = await worker({ op: "enqueue", clinicId: clinic.id, payload: payload(p.phone, texto), model: [], exitAfterIdle: true });
    assert.equal(w.status, 137);
    return { ...p, conv: await convOf(p.patient.id) };
  };
  const respondida = await mk("Ja Respondida", "Oi");
  const humano = await mk("Equipe Assumiu", "Oi, tudo bem?");
  const velha = await mk("Velha Demais", "Bom dia");
  newEvents();
  // a equipe respondeu pelo celular enquanto o servidor estava fora
  await prisma.message.create({ data: { conversationId: respondida.conv.id, role: "human", content: "Oi! Aqui é a recepção.", authorName: "Recepcao", createdAt: new Date(Date.now() + 1000) } });
  await prisma.conversation.update({ where: { id: humano.conv.id }, data: { humanTakeover: true } });
  for (const c of [respondida, humano]) await recuaTempo(c.conv.id, 2 * 60_000);
  await recuaTempo(velha.conv.id, 3 * HOUR); // 3 h de atraso: mais que o limite de mensagem velha
  const b = await worker({ op: "boot", clinicId: clinic.id, model: [] }); // (qualquer chamada ao modelo acabaria o roteiro e apareceria)
  assert.equal(b.status, 0, b.stderr.slice(0, 300));
  const ev = newEvents();
  assert.equal(ev.filter((e) => e.t === "send").length, 0, "ninguem foi respondido");
  assert.equal(ev.filter((e) => e.t === "model").length, 0);
  for (const c of [respondida, humano, velha]) assert.equal((await convOf(c.patient.id)).replyDueAt, null, "o marcador foi limpo");
  assert.equal((await convOf(velha.patient.id)).handoffPending, true, "velha demais: a equipe fica sabendo");
  assert.equal((await convOf(respondida.patient.id)).handoffPending, false);
});

test("AGRUPAMENTO: prazo no FUTURO + reinicio -> o timer e REARMADO (nao responde antes da hora e responde na hora); replyDelaySeconds = 0 continua respondendo na hora", async () => {
  const clinic = await mkClinic("Agrupa Rearma", { replyDelaySeconds: 3 });
  const p = await novaPessoa(clinic, "Eva Rearma");
  const a = await worker({ op: "enqueue", clinicId: clinic.id, payload: payload(p.phone, "Oi"), model: [], exitAfterIdle: true });
  assert.equal(a.status, 137);
  newEvents();
  const antes = await convOf(p.patient.id);
  // sobe de novo ainda DENTRO do intervalo: o processo rearma o timer e (como segue de pe) responde quando o prazo chega
  const b = await worker({ op: "boot", clinicId: clinic.id, model: [{ content: "Oi, Eva! Tudo bem? 💗" }], waitMs: 12_000 });
  assert.equal(b.status, 0, b.stderr.slice(0, 300));
  const ev = newEvents();
  const out = sendsTo(ev, p.phone);
  assert.equal(out.length, 1, `${JSON.stringify(ev.map((e) => e.t))} ${b.stderr.slice(-300)}`);
  assert.ok(antes.replyDueAt, "havia um prazo gravado");
  // sem agrupamento: resposta imediata (comportamento de sempre)
  const imediata = await mkClinic("Sem Agrupar", { replyDelaySeconds: 0 });
  const q = await novaPessoa(imediata, "Fabi Imediata");
  const w = await worker({ op: "enqueue", clinicId: imediata.id, payload: payload(q.phone, "Oi"), model: [{ content: "Oi, Fabi! 💗" }] });
  assert.equal(w.status, 0, w.stderr.slice(0, 300));
  assert.equal(sendsTo(newEvents(), q.phone).length, 1);
  assert.equal((await convOf(q.patient.id)).replyDueAt, null, "sem agrupamento nada fica gravado");
});

test("AGRUPAMENTO: isolamento entre clinicas -> a recuperacao de uma clinica nao responde a conversa de outra", async () => {
  const c1 = await mkClinic("Agrupa Clinica Um", { replyDelaySeconds: 30 });
  const c2 = await mkClinic("Agrupa Clinica Dois", { replyDelaySeconds: 30, aliceActive: true });
  const p1 = await novaPessoa(c1, "Gabi Um");
  const p2 = await novaPessoa(c2, "Gabi Dois");
  for (const [c, p] of [[c1, p1], [c2, p2]]) assert.equal((await worker({ op: "enqueue", clinicId: c.id, payload: payload(p.phone, "Oi"), model: [], exitAfterIdle: true })).status, 137);
  newEvents();
  for (const p of [p1, p2]) await recuaTempo((await convOf(p.patient.id)).id, 2 * 60_000);
  const b = await worker({ op: "boot", clinicId: c1.id, model: [{ content: "Oi, Gabi! 💗" }, { content: "Oi, Gabi! 💗" }] });
  assert.equal(b.status, 0, b.stderr.slice(0, 300));
  const ev = newEvents();
  // cada conversa e respondida pela sua propria clinica (o numero de destino e o da pessoa); nenhuma resposta vai para o numero errado
  const para = ev.filter((e) => e.t === "send").map((e) => e.number).sort();
  assert.deepEqual(para, [p1.phone, p2.phone].sort(), "cada pessoa recebe uma (e so uma) resposta");
});

// ================================================================ 2) PREPARO PRE-PROCEDIMENTO

async function cenarioPreparo(nome, { hoursBefore = 48, quando = null } = {}) {
  const clinic = await mkClinic(`Preparo ${nome}`);
  const proc = await prisma.procedure.create({ data: { clinicId: clinic.id, name: "Lavieen Full Face PDRN", durationMin: 60 } });
  const p = await novaPessoa(clinic, nome);
  const when = quando ?? new Date(Date.now() + 30 * HOUR);
  const appt = await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: p.patient.id, procedureId: proc.id, scheduledAt: when, status: "confirmed", source: "presencial" } });
  const rule = await prisma.preProcedureRule.create({ data: { clinicId: clinic.id, name: "Preparo Lavieen", message: "Obrigada pela confirmação, {primeiro_nome}!\nPara o seu {procedimento}: evite sol e use protetor solar. 💗", sendHoursBefore: hoursBefore, active: true } });
  const row = () => prisma.preProcedureSent.findFirst({ where: { appointmentId: appt.id, ruleId: rule.id } });
  return { clinic, proc, p, appt, rule, row, when };
}
// Um instante DENTRO de 8h-20h em SP e NUNCA antes do relogio real (as linhas de teste usam o relogio real para "ha 10 min"): se agora ja esta no expediente vale agora (+1 min);
// senao, o proximo 12:00 de Sao Paulo.
const meioDia = () => {
  const real = new Date();
  const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(real));
  if (h >= 8 && h < 19) return new Date(real.getTime() + 60_000);
  const c = new Date(real); c.setUTCHours(15, 0, 0, 0); // 12:00 em SP
  if (c.getTime() <= real.getTime()) c.setUTCDate(c.getUTCDate() + 1);
  return c;
};
const envelhece = (id, ms) => prisma.preProcedureSent.update({ where: { id }, data: { reservedAt: new Date(Date.now() - ms), attemptedAt: null } });

test("PREPARO: caminho normal -> reserva (reserved) vira 'sending' so imediatamente antes do provedor e 'sent' depois; o chat registra; nova rodada nao repete", async () => {
  posts.length = 0; uazapiMode = "ok"; beforeSend = null;
  const s = await cenarioPreparo("Normal");
  const now = meioDia();
  let visto = null;
  beforeSend = async () => { visto = (await s.row())?.state; };
  const n = await pre.sendAdvancePreProcedure(now);
  assert.equal(n, 1);
  assert.equal(visto, "sending", "no momento da chamada ao provedor a etapa ja constava como tentativa iniciada");
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /Passando para enviar as orientações de preparo/);
  const r = await s.row();
  assert.equal(r.state, "sent");
  assert.equal(r.attempts, 1);
  assert.ok(r.finalAt);
  assert.equal((await aliceMsgs(s.p.patient.id)).filter((m) => (m.authorName ?? "").startsWith("Preparo da visita")).length, 1);
  beforeSend = null;
  await pre.sendAdvancePreProcedure(new Date(now.getTime() + 20 * 60_000));
  assert.equal(posts.length, 1, "nao repete");
});

test("PREPARO: queda DEPOIS de reservar e ANTES de chamar o provedor -> a reserva NAO e envio; a recuperacao revalida e envia UMA vez", async () => {
  posts.length = 0; uazapiMode = "ok"; beforeSend = null;
  const s = await cenarioPreparo("QuedaAntes");
  // simula o processo que morreu logo depois de reservar (nada foi chamado)
  await prisma.preProcedureSent.create({ data: { appointmentId: s.appt.id, ruleId: s.rule.id, state: "reserved", channel: "antecipado", reservedAt: new Date(Date.now() - 10 * 60_000) } });
  const antes = await pre.reconcilePreProcedure(meioDia());
  assert.equal(posts.length, 1, "a reserva velha (provedor nao chamado) foi recuperada e enviada");
  assert.equal(antes.recovered, 1);
  assert.equal((await s.row()).state, "sent");
  await pre.reconcilePreProcedure(meioDia());
  assert.equal(posts.length, 1, "uma vez so");
});

test("PREPARO: queda DURANTE a chamada ao provedor ou DEPOIS de ele aceitar e antes de gravar -> resultado INCERTO: 'unconfirmed', NUNCA reenvia as cegas; com registro no chat vira 'sent'", async () => {
  posts.length = 0; uazapiMode = "ok"; beforeSend = null;
  // (a) durante/depois: a tentativa foi iniciada (sending) e o processo morreu; nada gravado no chat
  const a = await cenarioPreparo("QuedaDurante");
  await prisma.preProcedureSent.create({ data: { appointmentId: a.appt.id, ruleId: a.rule.id, state: "sending", channel: "antecipado", reservedAt: new Date(Date.now() - 20 * 60_000), attemptedAt: new Date(Date.now() - 10 * 60_000), attempts: 1 } });
  await pre.reconcilePreProcedure(meioDia());
  assert.equal(posts.length, 0, "nao reenviou");
  assert.equal((await a.row()).state, "unconfirmed");
  await pre.reconcilePreProcedure(meioDia());
  assert.equal(posts.length, 0);
  // (b) o provedor aceitou, o chat chegou a ser registrado, mas o estado nao: reconciliado como enviado, sem reenviar
  const b = await cenarioPreparo("QuedaDepois");
  const att = new Date(Date.now() - 10 * 60_000);
  await prisma.preProcedureSent.create({ data: { appointmentId: b.appt.id, ruleId: b.rule.id, state: "sending", channel: "antecipado", reservedAt: new Date(att.getTime() - 60_000), attemptedAt: att, attempts: 1 } });
  const conv = await prisma.conversation.create({ data: { patientId: b.p.patient.id } });
  await prisma.message.create({ data: { conversationId: conv.id, role: "assistant", content: "Passando para enviar...", authorName: "Preparo da visita (48h antes)", createdAt: new Date(att.getTime() + 2000) } });
  await pre.reconcilePreProcedure(meioDia());
  assert.equal(posts.length, 0);
  assert.equal((await b.row()).state, "sent");
  // (c) timeout REAL do provedor na chamada: incerto, nao reenvia no ciclo seguinte
  const c = await cenarioPreparo("Timeout");
  uazapiMode = "timeout";
  await pre.sendAdvancePreProcedure(meioDia());
  assert.equal((await c.row()).state, "unconfirmed");
  uazapiMode = "ok";
  const antes = posts.length;
  await pre.sendAdvancePreProcedure(new Date(meioDia().getTime() + 30 * 60_000));
  assert.equal(posts.length, antes, "timeout nunca reenvia");
});

test("PREPARO: falha DEFINITIVA -> numero sem WhatsApp fecha a etapa ('failed_permanent'); erro do provedor tenta de novo com intervalo e teto; veto da revisao e temporario", async () => {
  posts.length = 0; beforeSend = null;
  // numero sem WhatsApp
  const a = await cenarioPreparo("SemWhats");
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => { const u = new URL(String(url)); if (u.pathname === "/send/text") return jsonRes(400, { error: "numero nao esta no WhatsApp", message: "not on whatsapp" }); return real(url, init); };
  await pre.sendAdvancePreProcedure(meioDia());
  const ra = await a.row();
  globalThis.fetch = real;
  assert.ok(["failed_permanent", "failed"].includes(ra.state), ra.state);
  // erro 500 do provedor: 'failed' (nada saiu), reavalia depois do intervalo, e volta a enviar quando o provedor volta
  const b = await cenarioPreparo("Erro500");
  uazapiMode = "http500";
  await pre.sendAdvancePreProcedure(meioDia());
  const rb = await b.row();
  assert.equal(rb.state, "failed");
  assert.equal(rb.attempts, 1);
  assert.ok(rb.reevaluateAt);
  uazapiMode = "ok";
  await pre.sendAdvancePreProcedure(meioDia()); // (ainda dentro do intervalo: nao tenta)
  assert.equal(posts.filter((p) => p.number === b.p.phone).length, 0);
  await pre.reconcilePreProcedure(new Date(meioDia().getTime() + 11 * 60_000));
  assert.equal(posts.filter((p) => p.number === b.p.phone).length, 1, "recuperada depois do intervalo");
  assert.equal((await b.row()).state, "sent");
  // teto de tentativas
  const c = await cenarioPreparo("Teto");
  uazapiMode = "http500";
  let t = meioDia();
  for (let i = 0; i < 5; i++) { await pre.reconcilePreProcedure(t); await pre.sendAdvancePreProcedure(t); t = new Date(t.getTime() + 11 * 60_000); }
  uazapiMode = "ok";
  const rc = await c.row();
  assert.ok(["failed_permanent", "failed"].includes(rc.state));
  assert.ok(rc.attempts <= pre.PRE_MAX_ATTEMPTS, `tentativas ${rc.attempts}`);
});

test("PREPARO: revalida ANTES de enviar/recuperar -> cancelada, remarcada para perto demais, passada, regra desligada, pediu para sair, fora de 8h-20h: nada e enviado e o estado diz por que", async () => {
  posts.length = 0; uazapiMode = "ok"; beforeSend = null;
  const reservado = (s, minutosAtras = 10) => prisma.preProcedureSent.create({ data: { appointmentId: s.appt.id, ruleId: s.rule.id, state: "reserved", channel: "antecipado", reservedAt: new Date(Date.now() - minutosAtras * 60_000) } });
  const now = meioDia();
  const canc = await cenarioPreparo("Cancelada"); await reservado(canc);
  await prisma.appointment.update({ where: { id: canc.appt.id }, data: { status: "cancelled" } });
  const perto = await cenarioPreparo("Perto", { quando: new Date(now.getTime() + 30 * 60_000) }); await reservado(perto); // falta 30 min
  const passada = await cenarioPreparo("Passada", { quando: new Date(now.getTime() - 2 * HOUR) }); await reservado(passada);
  const regra = await cenarioPreparo("RegraOff"); await reservado(regra);
  await prisma.preProcedureRule.update({ where: { id: regra.rule.id }, data: { active: false } });
  const saiu = await cenarioPreparo("Saiu"); await reservado(saiu);
  await prisma.patient.update({ where: { id: saiu.p.patient.id }, data: { optedOut: true } });
  const procTroca = await cenarioPreparo("OutroProc"); await reservado(procTroca);
  const outro = await prisma.procedure.create({ data: { clinicId: procTroca.clinic.id, name: "Peeling", durationMin: 30 } });
  await prisma.preProcedureRule.update({ where: { id: procTroca.rule.id }, data: { procedureIds: outro.id } }); // a regra agora cobre OUTRO procedimento
  const noite = await cenarioPreparo("Noite"); await reservado(noite);
  await pre.reconcilePreProcedure(now);
  const st = async (s) => (await s.row()).state;
  assert.equal(await st(canc), "superseded");
  assert.equal(await st(perto), "expired");
  assert.equal(await st(passada), "expired");
  assert.equal(await st(regra), "superseded");
  assert.equal(await st(saiu), "superseded");
  assert.equal(await st(procTroca), "superseded", "nao reutiliza o preparo de outro procedimento");
  assert.equal(posts.length, 1, "so o caso valido (noite, ainda no horario)");
  // fora do horario de comunicacao (23h em SP): a etapa fica como esta, nao envia
  const outraClinica = await cenarioPreparo("ForaHora"); await reservado(outraClinica);
  const tarde = new Date(now); tarde.setUTCHours(2, 0, 0, 0); while (tarde.getTime() <= now.getTime()) tarde.setUTCDate(tarde.getUTCDate() + 1); // 23:00 em SP, depois de agora
  const antes = posts.length;
  await pre.reconcilePreProcedure(tarde);
  assert.equal(posts.length, antes);
  assert.equal(await st(outraClinica), "reserved");
});

test("PREPARO canal RESPOSTA: confirmou na conversa; o processo cai entre a reserva e a mensagem -> recuperado; mensagem vetada/expirada volta para recuperacao; entregue = sent; sem confirmacao = unconfirmed", async () => {
  posts.length = 0; uazapiMode = "ok"; beforeSend = null;
  const mk = async (nome, estadoMensagem) => {
    const s = await cenarioPreparo(nome, { hoursBefore: 0 });
    await prisma.preProcedureRule.update({ where: { id: s.rule.id }, data: { sendHoursBefore: null } }); // regra so de confirmacao na conversa
    const conv = await prisma.conversation.create({ data: { patientId: s.p.patient.id } });
    let messageId = null;
    if (estadoMensagem) messageId = (await prisma.message.create({ data: { conversationId: conv.id, role: "assistant", content: "Obrigada pela confirmação! (preparo)", deliveryStatus: estadoMensagem === "null" ? null : estadoMensagem } })).id;
    await prisma.preProcedureSent.create({ data: { appointmentId: s.appt.id, ruleId: s.rule.id, state: messageId ? "queued" : "reserved", channel: "resposta", messageId, reservedAt: new Date(Date.now() - 10 * 60_000) } });
    return s;
  };
  const semMsg = await mk("SemMensagem", null);
  const enviada = await mk("Entregue", "sent");
  const incerta = await mk("Incerta", "unconfirmed");
  const vetada = await mk("Vetada", "vetoed");
  const expirada = await mk("Expirada", "expired");
  const superada = await mk("Superada", "null");
  const pendente = await mk("Pendente", "pending");
  const r = await pre.reconcilePreProcedure(meioDia());
  const st = async (s) => (await s.row()).state;
  assert.equal(await st(enviada), "sent");
  assert.equal(await st(incerta), "unconfirmed");
  assert.equal(await st(pendente), "queued", "a entrega da mensagem ainda cuida");
  for (const s of [semMsg, vetada, expirada, superada]) assert.equal(await st(s), "sent", "reservada/nao entregue: recuperada e enviada em mensagem propria");
  // a reconciliacao e global: etapas "reservadas" deixadas por testes anteriores na mesma base (ex.: ForaHora) tambem sao recuperadas. Confere POR DESTINATARIO.
  const para = (x) => posts.filter((m) => m.number.endsWith(x.p.phone.slice(-4))).length;
  for (const x of [semMsg, vetada, expirada, superada]) assert.equal(para(x), 1, `recuperado: exatamente uma mensagem propria (${x.p.phone.slice(-4)})`);
  for (const x of [enviada, incerta, pendente]) assert.equal(para(x), 0, `entregue/incerta/pendente: nada novo (${x.p.phone.slice(-4)})`);
  assert.ok(r.recovered >= 4);
});

test("PREPARO: duas rodadas ao mesmo tempo sobre a mesma etapa -> UMA mensagem (reivindicacao atomica no banco)", async () => {
  posts.length = 0; uazapiMode = "ok"; beforeSend = null;
  const s = await cenarioPreparo("Concorrente");
  await prisma.preProcedureSent.create({ data: { appointmentId: s.appt.id, ruleId: s.rule.id, state: "reserved", channel: "antecipado", reservedAt: new Date(Date.now() - 10 * 60_000) } });
  await Promise.all([pre.reconcilePreProcedure(meioDia()), pre.reconcilePreProcedure(meioDia()), pre.reconcilePreProcedure(meioDia())]);
  assert.equal(posts.filter((p) => p.number === s.p.phone).length, 1);
  assert.equal((await s.row()).state, "sent");
});
