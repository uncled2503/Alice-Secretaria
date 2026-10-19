// REVISAO DE ENVIO POR IA + MEMORIA DO LEAD, com banco de verdade (SQLite temporario) e OpenAI/UAZAPI simulados por um fetch falso.
// Pedido do dono (16/10/2026): toda mensagem passa pela IA antes de sair ("faz sentido enviar isso agora?") e o briefing de cada lead fica sempre atualizado.
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dbFile = path.join(os.tmpdir(), `alice-revisao-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY = "test-key";
process.env.AI_SEND_REVIEW = "on";
process.env.AI_BRIEFING = "on";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const posts = []; // mensagens que SAIRAM pelo WhatsApp: { number, text }
const reviews = []; // chamadas da revisao: corpo
let reviewAnswer = () => ({ decisao: "enviar", confianca: "alta", motivo: "ok" });
let notesAnswer = () => ({ notas: ["Quer drenagem facial", "So consegue aos sabados"] });
let openaiDown = false;
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const completion = (content) => ({ id: "c", object: "chat.completion", created: 1, model: "gpt-4o-mini", choices: [{ index: 0, message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.includes("openai.com")) {
    if (openaiDown) return jsonRes(500, { error: { message: "fora do ar" } });
    const body = JSON.parse(init.body);
    const system = body.messages[0].content;
    if (/REVISOR (DE ENVIO|das respostas)/.test(system)) {
      reviews.push(body);
      return jsonRes(200, completion(reviewAnswer(body)));
    }
    if (/MEMORIA de um lead/.test(system)) return jsonRes(200, completion(notesAnswer(body)));
    return jsonRes(200, completion("{}"));
  }
  if (u.hostname.endsWith("uazapi.com")) {
    if (u.pathname === "/send/text") {
      const b = JSON.parse(init.body);
      posts.push({ number: b.number, text: b.text });
    }
    return jsonRes(200, { id: "msg" });
  }
  return jsonRes(404, {});
};

const { prisma } = await import("../dist/db/client.js");
const { sendText, deliverAliceReply } = await import("../dist/uazapi/client.js");
const { decide, acceptsRewrite, reviewOutbound } = await import("../dist/ai/sendGate.js");
const { patientFacts, parseNotes, refreshBriefingNotes, runBriefingJob } = await import("../dist/ai/leadBriefing.js");
const { aiExtraEnabled } = await import("../dist/ai/aiSwitch.js");
const { usageSnapshot, resetUsageForTests } = await import("../dist/ai/usageStats.js");
const { isFixedReply } = await import("../dist/ai/fixedReplies.js");
const { resetBreakerForTests } = await import("../dist/ai/sendGate.js");
beforeEach(() => resetBreakerForTests());
const { closingReply, feedbackThanks } = await import("../dist/ai/courtesy.js");
const { confirmationThanks } = await import("../dist/ai/confirmation.js");
const { scheduleBriefingRefresh } = await import("../dist/ai/leadBriefing.js");
const { ensurePlaceholderProcedure } = await import("../dist/clinicaexperts/placeholderProcedure.js");

test.after(async () => {
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* arquivo temporario */ } }
});

const clinic = await prisma.clinic.create({
  data: { name: "Clinica Revisao", whatsappPhone: "5511900000009", timezone: "America/Sao_Paulo", plan: "prime", uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: "tok", notifyPhone: "5511955550000" },
});
const botox = await prisma.procedure.create({ data: { clinicId: clinic.id, name: "Botox", durationMin: 30 } });
let n = 0;
async function pessoa(nome, { optedOut = false } = {}) {
  n++;
  return prisma.patient.create({ data: { clinicId: clinic.id, name: nome, phone: `551196666${String(1000 + n)}`, optedOut } });
}
const HOUR = 3_600_000;
const unico = (t) => `${t} ${Math.random().toString(36).slice(2)} (texto longo o bastante para a trava de duplicados do envio)`;

test("politica: a mensagem AUTOMATICA so e barrada com confianca ALTA; a resposta da ALICE nunca e barrada (reescreve sem fato inventado, ou sai a original)", () => {
  const j = (o) => JSON.stringify(o);
  assert.equal(decide(j({ decisao: "nao_enviar", confianca: "alta", motivo: "cancelado" }), "lembrete", "x").send, false);
  assert.equal(decide(j({ decisao: "nao_enviar", confianca: "media", motivo: "talvez" }), "lembrete", "x").send, true);
  assert.equal(decide(j({ decisao: "nao_enviar", confianca: "baixa", motivo: "?" }), "lembrete", "x").send, true);
  assert.equal(decide(j({ decisao: "enviar", confianca: "alta", motivo: "ok" }), "lembrete", "x").send, true);
  assert.equal(decide(j({ decisao: "reescrever", confianca: "alta", motivo: "m", texto: "Claro! O endereço é Av. Índico, 294." }), "lembrete", "x").rewritten, undefined, "automatica nunca e reescrita");
  // RESPOSTA DA ALICE: nunca send:false
  const orig = "Claro! Posso agendar uma avaliação pra você? O endereço é Av. Índico, 294.";
  const r = decide(j({ decisao: "reescrever", confianca: "alta", motivo: "oferta nao pedida", texto: "Claro! O endereço é Av. Índico, 294." }), "resposta_alice", orig);
  assert.equal(r.send, true);
  assert.equal(r.rewritten, "Claro! O endereço é Av. Índico, 294.");
  // ate "nao_enviar" vira a resposta melhor (ou a original), nunca silencio
  const n = decide(j({ decisao: "nao_enviar", confianca: "alta", motivo: "oferta nao pedida", texto: "Claro! O endereço é Av. Índico, 294." }), "resposta_alice", orig);
  assert.equal(n.send, true);
  assert.equal(n.rewritten, "Claro! O endereço é Av. Índico, 294.");
  const semTexto = decide(j({ decisao: "nao_enviar", confianca: "alta", motivo: "ruim" }), "resposta_alice", orig);
  assert.equal(semTexto.send, true);
  assert.equal(semTexto.rewritten, undefined, "sem resposta melhor: sai a original");
  // fato inventado na reescrita: recusa a reescrita, mas a original SAI
  const inventado = decide(j({ decisao: "reescrever", confianca: "alta", motivo: "m", texto: "Tenho horário às 15:00 com desconto de R$ 50" }), "resposta_alice", orig);
  assert.equal(inventado.send, true);
  assert.equal(inventado.rewritten, undefined);
  // mas fato que esta na FICHA (a agenda da pessoa) pode entrar na resposta melhor
  const comFicha = decide(j({ decisao: "reescrever", confianca: "media", motivo: "agenda", texto: "Seu horário continua amanhã às 15:00, tudo certo!" }), "resposta_alice", "Posso agendar uma avaliação?", "AGENDA (proximos horarios): Hipro em quarta-feira, 21/10 as 15:00");
  assert.equal(comFicha.rewritten, "Seu horário continua amanhã às 15:00, tudo certo!");
  for (const lixo of [null, "", "nao e json", "[]", "{}", j({ decisao: "talvez" })]) {
    assert.equal(decide(lixo, "lembrete", "x").send, true, String(lixo));
    assert.equal(decide(lixo, "resposta_alice", "x").send, true, String(lixo));
  }
  assert.equal(acceptsRewrite("Seu horário é 15:00 amanhã.", "Seu horário é 16:00 amanhã."), false);
  assert.equal(acceptsRewrite("Seu horário é 15:00 amanhã.", "Seu horário é 15:00."), true);
});

test("memoria do lead: parseNotes valida e limita; chave de teste desliga os recursos de IA por padrao", () => {
  assert.equal(parseNotes(JSON.stringify({ notas: ["a", "  b  ", 3, ""] })), "- a\n- b");
  assert.equal(parseNotes(JSON.stringify({ notas: [] })), "");
  assert.equal(parseNotes("lixo"), null);
  assert.equal(parseNotes(JSON.stringify({ notas: Array.from({ length: 20 }, (_, i) => `n${i}`) })).split("\n").length, 10);
  assert.equal(aiExtraEnabled("AI_SEND_REVIEW"), true); // este arquivo liga de proposito
});

test("a ficha ao vivo traz agenda, cancelamentos, automaticas das ultimas 24h, a equipe, a memoria e o aviso de reserva sem procedimento", async () => {
  const p = await pessoa("Clarinda Teste");
  const conv = await prisma.conversation.create({ data: { patientId: p.id, humanTakeover: true } });
  const t = (min) => new Date(Date.now() - min * 60_000);
  await prisma.message.create({ data: { conversationId: conv.id, role: "assistant", content: "Pesquisa: de 0 a 10, que nota?", authorName: "Pesquisa de satisfação", createdAt: t(120) } });
  await prisma.message.create({ data: { conversationId: conv.id, role: "user", content: "Muito bem atendida", createdAt: t(100) } });
  await prisma.message.create({ data: { conversationId: conv.id, role: "human", content: "Posso te auxiliar em algo?", authorName: "Fabiola", createdAt: t(10) } });
  const futuro = new Date(Date.now() + 30 * HOUR);
  await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: p.id, procedureId: botox.id, scheduledAt: futuro } });
  const sem = await ensurePlaceholderProcedure(clinic.id);
  await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: p.id, procedureId: sem.id, scheduledAt: new Date(futuro.getTime() + 2 * HOUR) } });
  await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: p.id, procedureId: botox.id, scheduledAt: new Date(Date.now() + 5 * HOUR), status: "cancelled" } });
  await prisma.patient.update({ where: { id: p.id }, data: { briefingNotes: "- So consegue aos sabados", briefingNotesAt: new Date() } });
  const f = await patientFacts({ clinicId: clinic.id, phone: p.phone });
  assert.match(f.text, /AGENDA \(proximos horarios\): Botox em/);
  assert.match(f.text, /horario ja marcado \(procedimento a confirmar/); // nunca o nome tecnico
  assert.ok(!/Horário sem procedimento \(Clínica Experts\)/.test(f.text));
  assert.match(f.text, /CANCELADOS NOS ULTIMOS 14 DIAS: Botox/);
  assert.match(f.text, /MENSAGENS AUTOMATICAS QUE ELA JA RECEBEU NAS ULTIMAS 24H: nps/);
  assert.match(f.text, /EQUIPE \(pessoa de verdade\) falou/);
  assert.match(f.text, /MEMORIA DO LEAD[\s\S]*So consegue aos sabados/);
  assert.match(f.text, /conversa esta com a EQUIPE/);
  assert.equal(f.lastHumanMinutesAgo, 10);
  assert.equal(f.upcomingCount, 2);
  assert.equal(await patientFacts({ clinicId: clinic.id, phone: "5511000000000" }), null);
});

test("lembrete barrado pela revisao: nada sai, o motivo fica no diario e vai pro relatorio", async () => {
  posts.length = 0; reviews.length = 0;
  const p = await pessoa("Bruna Cancelou");
  await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: p.id, procedureId: botox.id, scheduledAt: new Date(Date.now() + 20 * HOUR), status: "cancelled" } });
  reviewAnswer = () => ({ decisao: "nao_enviar", confianca: "alta", motivo: "o horario foi cancelado e nao esta mais na agenda" });
  const out = await sendText(clinic.id, p.phone, unico("Confirmando seu horário de amanhã às 10:00"), { kind: "lembrete" });
  assert.equal(out, "vetoed");
  assert.equal(posts.length, 0);
  const log = await prisma.activityLog.findFirst({ where: { clinicId: clinic.id, patientId: p.id, type: "message_blocked_ai" } });
  assert.ok(log);
  assert.match(log.description, /cancelado/);
  // a revisao recebeu o tipo da mensagem, a mensagem e a ficha com o cancelamento
  const user = reviews.at(-1).messages[1].content;
  assert.match(user, /lembrete\/confirmacao automatica/);
  assert.match(user, /Confirmando seu horário/);
  assert.match(user, /CANCELADOS NOS ULTIMOS 14 DIAS/);
});

test("revisao aprova: a mensagem sai normalmente", async () => {
  posts.length = 0;
  const p = await pessoa("Ana Normal");
  reviewAnswer = () => ({ decisao: "enviar", confianca: "alta", motivo: "agendamento confere" });
  assert.equal(await sendText(clinic.id, p.phone, unico("Confirmando seu horário"), { kind: "lembrete" }), "sent");
  assert.equal(posts.length, 1);
});

test("a IA com duvida (confianca media) nao derruba o lembrete", async () => {
  posts.length = 0;
  const p = await pessoa("Duvida Media");
  reviewAnswer = () => ({ decisao: "nao_enviar", confianca: "media", motivo: "talvez ja tenha recebido" });
  assert.equal(await sendText(clinic.id, p.phone, unico("Confirmando seu horário"), { kind: "lembrete" }), "sent");
  assert.equal(posts.length, 1);
});

test("IA fora do ar: a mensagem sai como estava (a revisao nunca trava o atendimento)", async () => {
  posts.length = 0;
  const p = await pessoa("Rede Caiu");
  openaiDown = true;
  try {
    assert.equal(await sendText(clinic.id, p.phone, unico("Confirmando seu horário"), { kind: "lembrete" }), "sent");
  } finally {
    openaiDown = false;
  }
  assert.equal(posts.length, 1);
});

test("aviso interno da equipe, numero que nao e paciente e envio manual NAO passam pela revisao", async () => {
  posts.length = 0; reviews.length = 0;
  reviewAnswer = () => ({ decisao: "nao_enviar", confianca: "alta", motivo: "barrar tudo" });
  assert.equal(await sendText(clinic.id, "5511955550000", unico("Aviso interno"), { kind: "interna" }), "sent");
  assert.equal(await sendText(clinic.id, "5511944440000", unico("Numero sem ficha"), { kind: "lembrete" }), "sent");
  const p = await pessoa("Manual");
  assert.equal(await sendText(clinic.id, p.phone, unico("A equipe escreveu"), { manual: true }), "sent");
  assert.equal(reviews.length, 0, "nenhuma chamada a IA: aviso interno, numero sem ficha e envio manual passam direto");
  reviews.length = 0;
  reviewAnswer = () => ({ decisao: "enviar", confianca: "alta", motivo: "ok" });
});

test("a mesma mensagem barrada nao pergunta de novo a IA (reenvios do job)", async () => {
  reviews.length = 0;
  const p = await pessoa("Repete");
  reviewAnswer = () => ({ decisao: "nao_enviar", confianca: "alta", motivo: "ja recebeu" });
  const texto = unico("Como foi sua experiência? De 0 a 10");
  assert.equal(await sendText(clinic.id, p.phone, texto, { kind: "pesquisa" }), "vetoed");
  assert.equal(await sendText(clinic.id, p.phone, texto, { kind: "pesquisa" }), "vetoed");
  assert.equal(reviews.length, 1);
  reviewAnswer = () => ({ decisao: "enviar", confianca: "alta", motivo: "ok" });
});

// ===== 16/10: a revisao barrou TODAS as respostas da Alice =====
// Causa: a resposta que estava sendo entregue ja estava gravada no chat ("pending") e aparecia na ficha como "ultima mensagem da Alice"; a IA a tomava por repetida.
// Regra do dono: lead NUNCA fica sem resposta. A revisao reformula e a melhor resposta sai.
test("REGRESSAO: a resposta que esta sendo entregue NAO aparece na ficha como ja enviada (a IA via 'repetida' e barrava tudo)", async () => {
  posts.length = 0; reviews.length = 0;
  const p = await pessoa("Clarinda Regressao");
  const conv = await prisma.conversation.create({ data: { patientId: p.id } });
  await prisma.message.create({ data: { conversationId: conv.id, role: "user", content: "Oi, qual o endereço da clínica de vocês?", createdAt: new Date(Date.now() - 60_000) } });
  const reply = unico("Estamos na Av. Índico, 294, Jardim do Mar. Quer que eu veja um horário?");
  await prisma.message.create({ data: { conversationId: conv.id, role: "assistant", content: reply, deliveryStatus: "pending" } });
  // uma IA "de verdade": se achar a MESMA resposta ja entre as mensagens enviadas, barra como repetida
  reviewAnswer = (body) => {
    const user = body.messages[1].content;
    const naFicha = user.split(reply.slice(0, 40)).length - 1; // vezes que o texto aparece (uma e a propria mensagem a enviar)
    return naFicha >= 2 ? { decisao: "nao_enviar", confianca: "alta", motivo: "mensagem repetida: ja foi enviada" } : { decisao: "enviar", confianca: "alta", motivo: "ok" };
  };
  await deliverAliceReply(clinic.id, p.phone, conv.id, reply);
  assert.equal(posts.length, 1, "a resposta SAI");
  assert.equal(posts[0].text, reply);
  const user = reviews.at(-1).messages[1].content;
  assert.match(user, /PESSOA \([^)]*\): Oi, qual o endere/, "a ficha mostra o que a pessoa escreveu");
  assert.equal(user.split(reply.slice(0, 40)).length - 1, 1, "a resposta aparece UMA vez (como a mensagem a enviar), nao na lista de enviadas");
  assert.match(reviews.at(-1).messages[0].content, /REVISOR das respostas da Alice/, "resposta da Alice usa o prompt proprio (reescreve, nunca barra)");
  reviewAnswer = () => ({ decisao: "enviar", confianca: "alta", motivo: "ok" });
});

test("a IA acha problema na resposta da Alice: a MELHOR resposta que ela escreveu e a que sai (a pessoa nao fica sem resposta)", async () => {
  posts.length = 0;
  const p = await pessoa("Clarinda Melhor");
  const conv = await prisma.conversation.create({ data: { patientId: p.id } });
  const reply = unico("Para agendar a avaliação, temos alguns horários disponíveis: 15:00 e 16:00. Qual prefere?");
  await prisma.message.create({ data: { conversationId: conv.id, role: "user", content: "Ok", createdAt: new Date(Date.now() - 60_000) } });
  await prisma.message.create({ data: { conversationId: conv.id, role: "assistant", content: reply, deliveryStatus: "pending" } });
  reviewAnswer = () => ({ decisao: "reescrever", confianca: "alta", motivo: "ela so disse ok e ja foi avaliada", texto: "Combinado, qualquer coisa é só me chamar por aqui. 💗" });
  await deliverAliceReply(clinic.id, p.phone, conv.id, reply);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].text, "Combinado, qualquer coisa é só me chamar por aqui. 💗");
  const msg = await prisma.message.findFirst({ where: { conversationId: conv.id, role: "assistant" } });
  assert.equal(msg.content, "Combinado, qualquer coisa é só me chamar por aqui. 💗");
  assert.equal(msg.deliveryStatus, "sent");
  assert.equal((await prisma.conversation.findUnique({ where: { id: conv.id } })).handoffPending, false);
});

test("a IA manda 'nao_enviar' pra uma resposta da Alice e nao escreve alternativa: a ORIGINAL sai (nunca silencio)", async () => {
  posts.length = 0;
  const p = await pessoa("Clarinda Original");
  const conv = await prisma.conversation.create({ data: { patientId: p.id } });
  const reply = unico("Oi! Temos sim. Me conta o que você gostaria de melhorar?");
  await prisma.message.create({ data: { conversationId: conv.id, role: "assistant", content: reply, deliveryStatus: "pending" } });
  reviewAnswer = () => ({ decisao: "nao_enviar", confianca: "alta", motivo: "nao gostei" });
  await deliverAliceReply(clinic.id, p.phone, conv.id, reply);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].text, reply);
  reviewAnswer = () => ({ decisao: "enviar", confianca: "alta", motivo: "ok" });
});

test("a IA inventa fato na resposta nova (horario/valor que nao esta na ficha): a reescrita e recusada e a ORIGINAL sai", async () => {
  posts.length = 0;
  const p = await pessoa("Clarinda Invento");
  const conv = await prisma.conversation.create({ data: { patientId: p.id } });
  const reply = unico("Entendi! O Hipro ajuda na firmeza da pele. Quer saber mais?");
  await prisma.message.create({ data: { conversationId: conv.id, role: "assistant", content: reply, deliveryStatus: "pending" } });
  reviewAnswer = () => ({ decisao: "reescrever", confianca: "alta", motivo: "m", texto: "O Hipro custa R$ 890 e tenho horário amanhã às 14:00!" });
  await deliverAliceReply(clinic.id, p.phone, conv.id, reply);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].text, reply);
  reviewAnswer = () => ({ decisao: "enviar", confianca: "alta", motivo: "ok" });
});

test("a revisao fora do ar ou lenta: a resposta da Alice sai igual (nunca trava)", async () => {
  posts.length = 0;
  const p = await pessoa("Clarinda Fora");
  const conv = await prisma.conversation.create({ data: { patientId: p.id } });
  const reply = unico("Claro! Estou por aqui para te ajudar. Qual procedimento te interessa?");
  await prisma.message.create({ data: { conversationId: conv.id, role: "assistant", content: reply, deliveryStatus: "pending" } });
  openaiDown = true;
  try { await deliverAliceReply(clinic.id, p.phone, conv.id, reply); } finally { openaiDown = false; }
  assert.equal(posts.length, 1);
  assert.equal(posts[0].text, reply);
});

test("DISJUNTOR: se a revisao barrar quase tudo (erro dela), desliga sozinha por 30 min e as mensagens saem sem revisar", async () => {
  posts.length = 0; reviews.length = 0;
  reviewAnswer = () => ({ decisao: "nao_enviar", confianca: "alta", motivo: "barrar tudo (revisao com defeito)" });
  const resultados = [];
  for (let i = 0; i < 8; i++) {
    const p = await pessoa("Disjuntor " + i);
    resultados.push(await sendText(clinic.id, p.phone, unico("Confirmando seu horário " + i), { kind: "lembrete" }));
  }
  // as primeiras sao barradas; quando 6 de 6 foram barradas o disjuntor abre e o resto SAI sem consultar a IA
  assert.deepEqual(resultados.slice(0, 6), ["vetoed", "vetoed", "vetoed", "vetoed", "vetoed", "vetoed"]);
  assert.deepEqual(resultados.slice(6), ["sent", "sent"]);
  assert.equal(reviews.length, 6, "depois de aberto, nem chama a IA");
  let aviso = null; // o aviso e gravado em segundo plano: espera ate 3s
  for (let i = 0; i < 30 && !aviso; i++) { aviso = await prisma.activityLog.findFirst({ where: { clinicId: clinic.id, title: "Revisão da IA desligada por 30 min" } }); if (!aviso) await new Promise((r) => setTimeout(r, 100)); }
  assert.ok(aviso);
  reviewAnswer = () => ({ decisao: "enviar", confianca: "alta", motivo: "ok" });
});

test("resposta da Alice reescrita: sai a versao corrigida e o chat guarda a que foi enviada", async () => {
  posts.length = 0;
  const p = await pessoa("Rewrite Alice");
  const conv = await prisma.conversation.create({ data: { patientId: p.id } });
  const reply = unico("Estamos na Av. Índico, 294. Posso agendar uma avaliação gratuita pra você?");
  await prisma.message.create({ data: { conversationId: conv.id, role: "assistant", content: reply, deliveryStatus: "pending" } });
  reviewAnswer = () => ({ decisao: "reescrever", confianca: "alta", motivo: "oferta nao pedida", texto: "Estamos na Av. Índico, 294." });
  await deliverAliceReply(clinic.id, p.phone, conv.id, reply);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].text, "Estamos na Av. Índico, 294.");
  const msg = await prisma.message.findFirst({ where: { conversationId: conv.id, role: "assistant" } });
  assert.equal(msg.content, "Estamos na Av. Índico, 294.");
  assert.equal(msg.deliveryStatus, "sent");
  reviewAnswer = () => ({ decisao: "enviar", confianca: "alta", motivo: "ok" });
});

test("memoria do lead: a IA escreve as notas, troca as velhas, e so atualiza quando ha novidade", async () => {
  const p = await pessoa("Memoria Maria");
  const conv = await prisma.conversation.create({ data: { patientId: p.id } });
  await prisma.message.create({ data: { conversationId: conv.id, role: "user", content: "Quero drenagem facial, so consigo aos sabados", createdAt: new Date(Date.now() - 20 * 60_000) } });
  await prisma.message.create({ data: { conversationId: conv.id, role: "assistant", content: "Claro! Vou ver os sabados.", createdAt: new Date(Date.now() - 19 * 60_000) } });
  let chamadas = 0;
  notesAnswer = (body) => {
    chamadas++;
    assert.match(body.messages[1].content, /Quero drenagem facial/); // a conversa foi lida
    assert.match(body.messages[1].content, /FICHA AO VIVO/);
    return { notas: ["Quer drenagem facial", "So consegue aos sabados"] };
  };
  const notas = await refreshBriefingNotes(p.id);
  assert.equal(notas, "- Quer drenagem facial\n- So consegue aos sabados");
  const salvo = await prisma.patient.findUnique({ where: { id: p.id } });
  assert.equal(salvo.briefingNotes, notas);
  assert.ok(salvo.briefingNotesAt);
  // nada novo desde a ultima atualizacao: nao gasta chamada
  assert.equal(await refreshBriefingNotes(p.id), null);
  assert.equal(chamadas, 1);
  // aconteceu algo relevante (agendamento mudou): atualiza mesmo sem mensagem nova
  notesAnswer = () => ({ notas: ["Cancelou a drenagem de 16/10", "So consegue aos sabados"] });
  assert.match(await refreshBriefingNotes(p.id, { force: true }), /Cancelou a drenagem/);
  // as notas entram na ficha que Alice e revisao leem
  assert.match((await patientFacts({ patientId: p.id })).text, /Cancelou a drenagem de 16\/10/);
});

test("job de seguranca: atualiza a memoria de quem teve conversa nova e ainda nao esta em dia", async () => {
  const p = await pessoa("Job Joana");
  const conv = await prisma.conversation.create({ data: { patientId: p.id, lastMessageAt: new Date(Date.now() - 30 * 60_000) } });
  await prisma.message.create({ data: { conversationId: conv.id, role: "user", content: "Oi, queria saber de botox", createdAt: new Date(Date.now() - 31 * 60_000) } });
  await prisma.message.create({ data: { conversationId: conv.id, role: "assistant", content: "Oi! Claro, me conta.", createdAt: new Date(Date.now() - 30 * 60_000) } });
  notesAnswer = () => ({ notas: ["Quer saber de botox"] });
  const feitas = await runBriefingJob();
  assert.ok(feitas >= 1);
  assert.equal((await prisma.patient.findUnique({ where: { id: p.id } })).briefingNotes, "- Quer saber de botox");
});

test("reviewOutbound com a IA injetada: recebe o tipo, a hora e a ficha; falha vira envio", async () => {
  const p = await pessoa("Injetada");
  let visto = "";
  const v = await reviewOutbound(
    { clinicId: clinic.id, phone: p.phone, text: unico("Oi, Injetada!"), kind: "recontato" },
    { call: async (system, user) => { visto = `${system}\n${user}`; return JSON.stringify({ decisao: "nao_enviar", confianca: "alta", motivo: "equipe falando agora" }); } },
  );
  assert.equal(v.send, false);
  assert.match(visto, /recontato automatico/);
  assert.match(visto, /FICHA DA PESSOA/);
  assert.match(visto, /AGORA:/);
  const falha = await reviewOutbound({ clinicId: clinic.id, phone: p.phone, text: unico("Outra"), kind: "recontato" }, { call: async () => { throw new Error("boom"); } });
  assert.equal(falha.send, true);
  assert.equal(falha.reviewed, false);
});

test("rodada de lembretes COM a revisao: o barrado nao sai, os outros saem (kind lembrete chega ate a IA)", async () => {
  const { runReminderCycle } = await import("../dist/reminders/cron.js");
  // fuso em que AGORA sao 12h (o horario do lembrete nao e adiado)
  const utcHour = new Date().getUTCHours();
  let off = (12 - utcHour + 24) % 24;
  if (off > 12) off -= 24;
  const tz = off === 0 ? "UTC" : `Etc/GMT${off > 0 ? "-" : "+"}${Math.abs(off)}`;
  const c2 = await prisma.clinic.create({ data: { name: "Clinica Ciclo IA", whatsappPhone: "5511900000010", timezone: tz, plan: "prime", uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: "tok-ciclo-ia" } });
  const proc = await prisma.procedure.create({ data: { clinicId: c2.id, name: "Botox", durationMin: 30 } });
  await prisma.reminderRule.create({ data: { clinicId: c2.id, hoursBefore: 24, active: true, message: "Olá, {primeiro_nome}! Confirmando {data} às {hora}: {procedimento}. Podemos contar com você?" } });
  const quando = new Date(Math.floor((Date.now() + 24 * HOUR - 10 * 60_000) / 60_000) * 60_000);
  const mk = async (nome, tel) => {
    const pt = await prisma.patient.create({ data: { clinicId: c2.id, name: nome, phone: tel } });
    await prisma.appointment.create({ data: { clinicId: c2.id, patientId: pt.id, procedureId: proc.id, scheduledAt: quando } });
    return pt;
  };
  const ok = await mk("Ok Souza", "5511977771001");
  const veto = await mk("Veto Silva", "5511977771002");
  posts.length = 0; reviews.length = 0;
  reviewAnswer = (body) => (/Veto Silva/.test(body.messages[1].content) ? { decisao: "nao_enviar", confianca: "alta", motivo: "pediu para remarcar" } : { decisao: "enviar", confianca: "alta", motivo: "ok" });
  await runReminderCycle();
  const para = posts.map((p) => p.number);
  assert.ok(para.includes(ok.phone), "quem a IA aprovou recebe");
  assert.ok(!para.includes(veto.phone), "quem a IA barrou NAO recebe");
  assert.equal(reviews.length, 2);
  assert.ok(reviews.every((b) => /lembrete\/confirmacao automatica/.test(b.messages[1].content)));
  const bloqueio = await prisma.activityLog.findFirst({ where: { clinicId: c2.id, type: "message_blocked_ai" } });
  assert.ok(bloqueio);
  reviewAnswer = () => ({ decisao: "enviar", confianca: "alta", motivo: "ok" });
});

// ===== economia de tokens (16/10) =====
test("economia: respostas FIXAS do sistema (agradecimento, urgencia, 'sou a assistente') nao passam pela IA - e as de seguranca nunca podem ser barradas", async () => {
  for (const t of [closingReply("Clarinda", ""), confirmationThanks("Ana"), feedbackThanks("Bia"), "Combinado! Qualquer coisa é só me chamar. 💗",
    "Sinto muito que isso esteja acontecendo. Se você está com falta de ar, procure agora um pronto-socorro ou ligue para o SAMU (192).",
    "Sou a Alice, assistente virtual da equipe da Lisboa. 😊 Posso te ajudar por aqui."]) {
    assert.equal(isFixedReply(t), true, t);
  }
  assert.equal(isFixedReply("Oi! Tenho horário amanhã às 10:00. Quer?"), false);
  posts.length = 0; reviews.length = 0;
  reviewAnswer = () => ({ decisao: "nao_enviar", confianca: "alta", motivo: "barrar tudo" });
  const p = await pessoa("Fixa Alice");
  const conv = await prisma.conversation.create({ data: { patientId: p.id } });
  const urgente = "Sinto muito que isso esteja acontecendo. Se você está com falta de ar ou sangramento intenso, procure agora um pronto-socorro ou ligue para o SAMU (192). Já estou avisando a equipe. " + Math.random();
  await prisma.message.create({ data: { conversationId: conv.id, role: "assistant", content: urgente, deliveryStatus: "pending" } });
  await deliverAliceReply(clinic.id, p.phone, conv.id, urgente);
  assert.equal(posts.length, 1, "o aviso de urgencia sai mesmo com a IA mandando barrar tudo");
  assert.equal(reviews.length, 0, "e nem gasta a chamada");
  reviewAnswer = () => ({ decisao: "enviar", confianca: "alta", motivo: "ok" });
});

test("economia: a revisao recebe uma ficha enxuta (so as 8 ultimas mensagens, cortadas) e responde com poucas palavras", async () => {
  reviews.length = 0;
  const p = await pessoa("Ficha Enxuta");
  const conv = await prisma.conversation.create({ data: { patientId: p.id } });
  for (let i = 0; i < 20; i++) await prisma.message.create({ data: { conversationId: conv.id, role: i % 2 ? "assistant" : "user", content: "Mensagem numero " + i + " " + "x".repeat(200), createdAt: new Date(Date.now() - (30 - i) * 60_000) } });
  await sendText(clinic.id, p.phone, unico("Confirmando seu horário"), { kind: "lembrete" });
  const user = reviews.at(-1).messages[1].content;
  const linhas = user.split("\n").filter((l) => /^  (PESSOA|ALICE|EQUIPE|AUTOMATICA) \(/.test(l));
  assert.equal(linhas.length, 8);
  assert.ok(linhas.every((l) => l.length < 150), "cada mensagem cortada");
  assert.ok(user.includes("Mensagem numero 19") && !user.includes("Mensagem numero 5 "));
  assert.equal(reviews.at(-1).max_tokens, 140);
});

test("economia: a memoria so manda as mensagens NOVAS (as notas anteriores carregam o resto) e nao refaz a cada mensagem (intervalo minimo)", async () => {
  const p = await pessoa("Memoria Delta");
  const conv = await prisma.conversation.create({ data: { patientId: p.id } });
  const t0 = Date.now() - 60 * 60_000;
  const add = (role, content, min) => prisma.message.create({ data: { conversationId: conv.id, role, content, createdAt: new Date(t0 + min * 60_000) } });
  await add("user", "Mensagem ANTIGA sobre botox", 0);
  await add("assistant", "Resposta antiga", 1);
  await add("user", "Outra antiga", 2);
  let corpos = [];
  notesAnswer = (body) => { corpos.push(body.messages[1].content); return { notas: ["Quer botox"] }; };
  await refreshBriefingNotes(p.id);
  assert.match(corpos[0], /Mensagem ANTIGA sobre botox/, "primeira vez: le a conversa");
  // chegam mensagens novas depois da memoria
  await prisma.patient.update({ where: { id: p.id }, data: { briefingNotesAt: new Date(t0 + 10 * 60_000) } });
  await add("user", "Mensagem NOVA sobre horario de sabado", 30);
  await add("assistant", "Resposta nova", 31);
  corpos = [];
  await refreshBriefingNotes(p.id);
  assert.equal(corpos.length, 1);
  assert.match(corpos[0], /Mensagem NOVA sobre horario de sabado/);
  assert.ok(!/Mensagem ANTIGA sobre botox/.test(corpos[0]), "a conversa antiga nao e mandada de novo");
  assert.match(corpos[0], /NOTAS ATUAIS:\n- Quer botox/, "as notas atuais seguem junto");
  assert.ok(!/ULTIMAS MENSAGENS/.test(corpos[0]), "a ficha nao repete a conversa");
  // intervalo minimo: duas agendas seguidas = uma atualizacao so
  const q = await pessoa("Memoria Intervalo");
  const cq = await prisma.conversation.create({ data: { patientId: q.id } });
  for (let i = 0; i < 4; i++) await prisma.message.create({ data: { conversationId: cq.id, role: i % 2 ? "assistant" : "user", content: "papo mais longo da conversa numero " + i, createdAt: new Date(Date.now() - (20 - i) * 60_000) } });
  corpos = [];
  // So conta as chamadas DESTA pessoa: o mock da memoria e compartilhado e, com a suite rodando varios arquivos em paralelo (maquina lenta), o
  // agendamento de 60-90 s de OUTRO teste deste arquivo pode disparar no meio e cair aqui.
  const dela = () => corpos.filter((c) => /papo mais longo da conversa/.test(c)).length;
  scheduleBriefingRefresh(q.id, { delayMs: 20 });
  await new Promise((r) => setTimeout(r, 400));
  const primeira = dela();
  await prisma.message.create({ data: { conversationId: cq.id, role: "user", content: "mais uma mensagem", createdAt: new Date() } });
  scheduleBriefingRefresh(q.id, { delayMs: 20 });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(primeira, 1);
  assert.equal(dela(), 1, "a segunda dentro de 15 min nao chama a IA (o job de 20 min pega depois)");
});

test("economia: o painel mostra onde vao os tokens, por finalidade", async () => {
  const snap = usageSnapshot();
  const nomes = snap.purposes.map((p) => p.purpose);
  assert.ok(nomes.includes("revisao_envio") && nomes.includes("memoria_do_lead"), nomes.join(","));
  const r = snap.purposes.find((p) => p.purpose === "revisao_envio");
  assert.ok(r.calls > 0 && r.input > 0 && r.estimatedUsd >= 0);
  assert.ok(snap.totalEstimatedUsd >= 0 && snap.since);
  resetUsageForTests();
  assert.equal(usageSnapshot().purposes.length, 0);
});

test("DISJUNTOR tambem vale se a revisao REESCREVE quase todas as respostas da Alice (e as respostas seguem saindo)", async () => {
  posts.length = 0; reviews.length = 0;
  reviewAnswer = () => ({ decisao: "reescrever", confianca: "alta", motivo: "sempre acha ruim", texto: "Certo! Já te respondo por aqui. 💗" });
  const enviados = [];
  for (let i = 0; i < 9; i++) {
    const p = await pessoa("Reescreve " + i);
    const conv = await prisma.conversation.create({ data: { patientId: p.id } });
    const reply = unico("Resposta numero " + i + " da Alice sobre o procedimento escolhido");
    await prisma.message.create({ data: { conversationId: conv.id, role: "assistant", content: reply, deliveryStatus: "pending" } });
    await deliverAliceReply(clinic.id, p.phone, conv.id, reply);
    enviados.push(posts.at(-1).text === reply ? "original" : "reescrita");
  }
  assert.equal(posts.length, 9, "toda pessoa recebeu resposta");
  assert.equal(reviews.length, 6, "depois de 6 reescritas seguidas o disjuntor abre e para de chamar a IA");
  assert.deepEqual(enviados.slice(6), ["original", "original", "original"]);
  reviewAnswer = () => ({ decisao: "enviar", confianca: "alta", motivo: "ok" });
});
