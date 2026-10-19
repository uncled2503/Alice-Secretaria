// RESPOSTA FINAL SEGURA + DISJUNTOR POR CLINICA. A revisao por IA nunca deixa a pessoa sem resposta e nunca libera texto que falhou numa trava
// deterministica (acao que nao aconteceu, horario que nenhuma ferramenta devolveu, oferta indevida...). Banco de verdade, OpenAI/UAZAPI simulados.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dbFile = path.join(os.tmpdir(), `alice-final-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY = "test-key";
process.env.AI_SEND_REVIEW = "on";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const posts = [];
const reviews = []; // chamadas da revisao (corpo)
const mainCalls = []; // chamadas ao modelo da conversa (com ferramentas): a entrega NUNCA pode fazer
let reviewMode = "enviar"; // enviar | fn | timeout | http500 | invalidjson | empty
let reviewFn = () => ({ decisao: "enviar", confianca: "alta", motivo: "ok" });
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const completion = (content) => ({ id: "c", object: "chat.completion", created: 1, model: "gpt-4o-mini", choices: [{ index: 0, message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.includes("openai.com")) {
    const body = JSON.parse(init.body);
    if (body.tools) { mainCalls.push(body); return jsonRes(200, completion("{}")); }
    if (/REVISOR (DE ENVIO|das respostas)/.test(body.messages[0].content)) {
      reviews.push(body);
      if (reviewMode === "timeout") throw Object.assign(new Error("tempo esgotado"), { name: "TimeoutError" });
      if (reviewMode === "http500") return jsonRes(500, { error: { message: "fora do ar" } });
      if (reviewMode === "invalidjson") return jsonRes(200, completion("isto nao e json"));
      if (reviewMode === "empty") return jsonRes(200, completion(""));
      return jsonRes(200, completion(reviewFn(body)));
    }
    return jsonRes(200, completion("{}"));
  }
  if (u.hostname.endsWith("uazapi.com") && u.pathname === "/send/text") {
    const b = JSON.parse(init.body);
    posts.push({ number: b.number, text: b.text });
  }
  return jsonRes(200, { id: "msg" });
};

const { prisma } = await import("../dist/db/client.js");
const { deliverAliceReply } = await import("../dist/uazapi/client.js");
const { rememberReplyContext, forgetReplyContext } = await import("../dist/ai/replyGuard.js");
const { newSlotState } = await import("../dist/ai/slotGuard.js");
const { emptyRequest } = await import("../dist/ai/slotRequest.js");
const { reviewOutbound, noteVerdict, breakerOpen, resetBreakerForTests, breakerStateSize, BREAKER_WINDOW_MS, BREAKER_CONSECUTIVE } = await import("../dist/ai/sendGate.js");

test.after(async () => {
  await (await import("../dist/jobs/background.js")).drainBackground(); // tarefas em segundo plano terminam ANTES de o banco temporario ser apagado
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* arquivo temporario */ } }
});

const mkClinic = (name, extra = {}) => prisma.clinic.create({
  data: { name, whatsappPhone: `55119${Math.floor(Math.random() * 1e8)}`, timezone: "America/Sao_Paulo", plan: "prime", uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: `tok-${Math.random().toString(36).slice(2)}`, ...extra },
});
const clinic = await mkClinic("Clinica Final");
const clinicSilent = await mkClinic("Clinica Silenciosa", { silentHandoff: true });
const loja = await mkClinic("Loja Laleblu", { businessType: "geral" });

let seq = 0;
const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const mkCtx = (conversationId, over = {}) => ({
  conversationId, tz: "America/Sao_Paulo", now: new Date(), todayIso, situationKind: "faq",
  forbidEvaluationOffer: false, forbidSlotOffer: false, request: emptyRequest(), trusted: false, agenda: true,
  actions: { booked: false, cancelled: false, rescheduled: false, transferred: false },
  evidence: { cancelledRecently: false, rescheduledRecently: false },
  slots: { state: newSlotState(), toolUsed: false, strict: { times: new Set(), dates: new Set() }, loose: { times: new Set(), dates: new Set() }, toolDates: [] },
  upcoming: [], complaintTexts: ["Qual o endereço?"], silentHandoff: false, ...over,
});

// Uma conversa com a fala da pessoa e a resposta gerada ("pending"), e o contexto da geracao registrado como generateReply faz.
async function entrega({ original, userText = "Qual o endereço?", review = { mode: "enviar" }, ctx = {}, c = clinic, withCtx = true, keepBreaker = false }) {
  seq++;
  posts.length = 0; reviews.length = 0; mainCalls.length = 0;
  if (!keepBreaker) resetBreakerForTests(); // cada caso comeca com o disjuntor fechado (varias reescritas seguidas abririam o da clinica de proposito)
  reviewMode = review.mode;
  if (review.fn) reviewFn = review.fn;
  const patient = await prisma.patient.create({ data: { clinicId: c.id, name: `Pessoa ${seq}`, phone: `5511955${String(50000 + seq)}` } });
  const conv = await prisma.conversation.create({ data: { patientId: patient.id } });
  await prisma.message.create({ data: { conversationId: conv.id, role: "user", content: userText, createdAt: new Date(Date.now() - 60_000) } });
  const row = await prisma.message.create({ data: { conversationId: conv.id, role: "assistant", content: original, deliveryStatus: "pending" } });
  if (withCtx) rememberReplyContext(mkCtx(conv.id, ctx), original);
  await deliverAliceReply(c.id, patient.phone, conv.id, original);
  forgetReplyContext(conv.id, original);
  return { patient, conv, row, sent: posts.map((p) => p.text), status: (await prisma.message.findUnique({ where: { id: row.id } })).deliveryStatus };
}
const rewriteTo = (texto, extra = {}) => ({ mode: "fn", fn: () => ({ decisao: "reescrever", confianca: "alta", motivo: "melhor", texto, ...extra }) });
const ENDERECO = "O endereço é Av. Índico, 294.";

test("revisao devolve 'nao_enviar' (sem texto): a pessoa NAO fica sem resposta, a original sai uma vez", async () => {
  const r = await entrega({ original: ENDERECO, review: { mode: "fn", fn: () => ({ decisao: "nao_enviar", confianca: "alta", motivo: "talvez nao faca sentido" }) } });
  assert.deepEqual(r.sent, [ENDERECO]);
  assert.equal(r.status, "sent");
  assert.equal(reviews.length, 1, "uma unica revisao, sem laco");
  assert.equal(mainCalls.length, 0, "a entrega nunca chama o modelo da conversa nem refaz ferramentas");
});

test("falha da revisao (timeout, erro 500, JSON invalido, resposta vazia, reescrita vazia): a resposta original sai, nada derruba o atendimento", async () => {
  for (const review of [{ mode: "timeout" }, { mode: "http500" }, { mode: "invalidjson" }, { mode: "empty" }, rewriteTo("")]) {
    const r = await entrega({ original: ENDERECO, review });
    assert.deepEqual(r.sent, [ENDERECO], JSON.stringify(review.mode));
    assert.equal(r.status, "sent");
    assert.equal(mainCalls.length, 0);
  }
});

test("reescrita que AFIRMA cancelamento sem ferramenta bem-sucedida e recusada: sai a original (ou a original so sai se continuar valida)", async () => {
  const r = await entrega({ original: ENDERECO, review: rewriteTo(`Pronto, cancelei seu horário. ${ENDERECO}`) });
  assert.deepEqual(r.sent, [ENDERECO]);
  assert.ok(!/cancelei/i.test(r.sent[0]));
  // com o cancelamento de fato executado nesta rodada, a mesma reescrita e aceita
  const ok = await entrega({ original: ENDERECO, review: rewriteTo(`Pronto, cancelei seu horário. ${ENDERECO}`), ctx: { actions: { booked: false, cancelled: true, rescheduled: false, transferred: false } } });
  assert.deepEqual(ok.sent, [`Pronto, cancelei seu horário. ${ENDERECO}`]);
});

test("reescrita que diz 'agendei'/'remarquei' sem a ferramenta tambem e recusada", async () => {
  for (const t of ["Agendei sua avaliação, tudo certo!", "Remarquei seu horário, combinado!"]) {
    const r = await entrega({ original: "Posso te ajudar com isso. Me conta mais?", review: rewriteTo(t) });
    assert.ok(!/agendei|remarquei/i.test(r.sent[0]), r.sent[0]);
    assert.equal(r.sent.length, 1);
  }
});

test("reescrita que oferece/confirma horario: o horario ESTAR no historico (a pessoa citou) NAO prova disponibilidade -> recusada", async () => {
  const r = await entrega({
    original: "Me conta qual procedimento você quer fazer?",
    userText: "Hoje às 14:00 você tem horário?",
    review: rewriteTo("Tenho sim, às 14:00 está livre! Qual procedimento você quer?"),
  });
  assert.ok(!/14:00/.test(r.sent[0]), r.sent[0]);
  assert.equal(r.sent[0], "Me conta qual procedimento você quer fazer?");
});

test("reescrita valida chega ao envio no lugar da original", async () => {
  const melhor = "Claro! Fica na Av. Índico, 294. Te espero por lá! 💗";
  const r = await entrega({ original: ENDERECO, review: rewriteTo(melhor) });
  assert.deepEqual(r.sent, [melhor]);
  assert.equal(r.status, "sent");
  assert.equal(reviews.length, 1);
});

test("original invalida E reescrita invalida: sai uma resposta curta e SEGURA (sem fato inventado, sem afirmar acao nao feita, sem prometer voltar)", async () => {
  const r = await entrega({ original: "Pronto, cancelei seu horário!", review: rewriteTo("Cancelei sim, tudo certo!") });
  assert.equal(r.sent.length, 1);
  assert.ok(!/cancelei/i.test(r.sent[0]), r.sent[0]);
  assert.ok(!/\d{1,2}[:h]\d{0,2}|já volto|volto já|um instante/i.test(r.sent[0]), r.sent[0]);
  assert.match(r.sent[0], /\?/); // pede o que falta em vez de afirmar
  assert.equal(r.status, "sent");
});

test("o texto diz que ENCAMINHOU a equipe: o encaminhamento e executado de verdade (uma vez) e so depois a mensagem sai", async () => {
  const original = "Já encaminhei sua dúvida para a equipe, eles te respondem em breve.";
  const r = await entrega({ original });
  assert.deepEqual(r.sent, [original]);
  const conv = await prisma.conversation.findUnique({ where: { id: r.conv.id } });
  assert.equal(conv.humanTakeover, true);
  assert.equal(conv.handoffPending, true);
  assert.equal(await prisma.activityLog.count({ where: { patientId: r.patient.id, type: "human_takeover" } }), 1, "transferiu uma unica vez");
  // entregar de novo a mesma resposta nao transfere nem envia outra vez
  await deliverAliceReply(clinic.id, r.patient.phone, r.conv.id, original);
  assert.equal(posts.length, 1);
  assert.equal(await prisma.activityLog.count({ where: { patientId: r.patient.id, type: "human_takeover" } }), 1);
});

test("clinica em transferencia SILENCIOSA: encaminha, sinaliza a equipe e NAO escreve nada para a pessoa", async () => {
  const r = await entrega({ original: "Já encaminhei sua dúvida para a equipe, eles te respondem em breve.", c: clinicSilent, ctx: { silentHandoff: true } });
  assert.equal(r.sent.length, 0);
  const conv = await prisma.conversation.findUnique({ where: { id: r.conv.id } });
  assert.equal(conv.humanTakeover, true);
  assert.equal(conv.handoffPending, true);
  assert.equal(r.status, null, "superada: a equipe responde, nao ha mensagem pendente");
});

test("sem contexto da geracao (reinicio, TTL): a reescrita so vale se nao traz acao/horario/oferta que a original nao tinha", async () => {
  const r = await entrega({ original: ENDERECO, review: rewriteTo(`Pronto, cancelei seu horário. ${ENDERECO}`), withCtx: false });
  assert.deepEqual(r.sent, [ENDERECO]);
  const ok = await entrega({ original: ENDERECO, review: rewriteTo("Claro! Fica na Av. Índico, 294. 💗"), withCtx: false });
  assert.deepEqual(ok.sent, ["Claro! Fica na Av. Índico, 294. 💗"]);
});

test("Laleblu (modo loja, sem agenda): nenhuma regra de clinica entra - 'cancelei seu pedido' nao e tratado como agendamento e nada de avaliacao", async () => {
  const original = "Cancelei seu pedido, tudo certo! Quer ver outras cores?";
  const r = await entrega({ original, c: loja, ctx: { agenda: false }, userText: "Pode cancelar meu pedido?" });
  assert.deepEqual(r.sent, [original]);
  assert.ok(!/avalia|hor[aá]rio|agend/i.test(r.sent[0]));
});

// ===================== DISJUNTOR POR CLINICA (= SAUDE do servico de revisao; vetos e reescritas NAO o abrem) =====================
const reescrita = { send: true, reason: "r", confidence: "alta", reviewed: true, rewritten: "texto melhor" };
const bom = { send: true, reason: "r", confidence: "alta", reviewed: true };
const falha = { send: true, reason: "r", confidence: "baixa", reviewed: false, technical: "api_error" };
const abre = (id, now) => { for (let i = 0; i < BREAKER_CONSECUTIVE; i++) noteVerdict(id, falha, now); };

test("disjuntor: a clinica A abre o dela (falhas tecnicas do servico) e a clinica B continua sendo revisada; reset por clinica", async () => {
  resetBreakerForTests();
  const titulo = "Revisão da IA suspensa";
  const avisosAntes = {
    a: await prisma.activityLog.count({ where: { clinicId: clinic.id, title: { contains: titulo } } }),
    b: await prisma.activityLog.count({ where: { clinicId: clinicSilent.id, title: { contains: titulo } } }),
  };
  const pa = await prisma.patient.create({ data: { clinicId: clinic.id, name: "Pessoa A", phone: "5511944440001" } });
  const pb = await prisma.patient.create({ data: { clinicId: clinicSilent.id, name: "Pessoa B", phone: "5511944440002" } });
  abre(clinic.id);
  assert.equal(breakerOpen(clinic.id), true);
  assert.equal(breakerOpen(clinicSilent.id), false);
  let chamadasA = 0, chamadasB = 0;
  const callA = async () => { chamadasA++; return JSON.stringify({ decisao: "enviar", confianca: "alta", motivo: "ok" }); };
  const callB = async () => { chamadasB++; return JSON.stringify({ decisao: "enviar", confianca: "alta", motivo: "ok" }); };
  const a = await reviewOutbound({ clinicId: clinic.id, phone: pa.phone, text: "Texto da clinica A, longo o bastante para valer.", kind: "resposta_alice" }, { call: callA });
  const b = await reviewOutbound({ clinicId: clinicSilent.id, phone: pb.phone, text: "Texto da clinica B, longo o bastante para valer.", kind: "resposta_alice" }, { call: callB });
  assert.equal(chamadasA, 0, "A: servico suspenso, nao chama a IA");
  assert.equal(a.send, true, "resposta da Alice nunca fica parada");
  assert.equal(a.reviewed, false);
  assert.equal(chamadasB, 1, "B: segue revisada");
  assert.equal(b.reviewed, true);
  // automacao de relacionamento com o disjuntor aberto: RETIDA (nao e veto)
  const retida = await reviewOutbound({ clinicId: clinic.id, phone: pa.phone, text: "Oi! Vamos agendar sua avaliacao esta semana?", kind: "recontato" }, { call: callA });
  assert.equal(retida.send, false);
  assert.equal(retida.held, true);
  assert.equal(chamadasA, 0);
  // o aviso no diario vai para a clinica CERTA (um novo aviso so para A)
  const avisos = (id) => prisma.activityLog.count({ where: { clinicId: id, title: { contains: titulo } } });
  for (let i = 0; i < 20 && (await avisos(clinic.id)) === avisosAntes.a; i++) await new Promise((r) => setTimeout(r, 150));
  assert.equal(await avisos(clinic.id), avisosAntes.a + 1);
  assert.equal(await avisos(clinicSilent.id), avisosAntes.b);
  resetBreakerForTests(clinic.id);
  assert.equal(breakerOpen(clinic.id), false);
});

test("disjuntor: limiares (3 falhas tecnicas seguidas, ou 60% de 6+ chamadas); veto/reescrita em excesso NUNCA abrem; janela de cada clinica propria", () => {
  resetBreakerForTests();
  for (let i = 0; i < BREAKER_CONSECUTIVE - 1; i++) noteVerdict("clin-x", falha);
  assert.equal(breakerOpen("clin-x"), false, "2 falhas ainda nao abrem");
  noteVerdict("clin-x", falha);
  assert.equal(breakerOpen("clin-x"), true, "3 falhas seguidas abrem");
  for (let i = 0; i < 20; i++) noteVerdict("clin-y", bom);
  assert.equal(breakerOpen("clin-y"), false, "eventos bons de outra clinica nao diluem nem somam");
  // 20 reescritas e 20 vetos: qualidade nao e saude do servico
  for (let i = 0; i < 20; i++) noteVerdict("clin-q", reescrita);
  for (let i = 0; i < 20; i++) noteVerdict("clin-q", { send: false, reason: "r", confidence: "alta", reviewed: true });
  assert.equal(breakerOpen("clin-q"), false, "vetos e reescritas em excesso nao abrem o disjuntor");
  // 60% de 6 (sem 3 seguidas): falha,falha,ok,falha,falha -> 5 chamadas nao abrem; a 6a (ok) fecha a conta em 4/6 = 67% e abre
  const seq = [falha, falha, bom, falha, falha];
  for (const v of seq) noteVerdict("clin-r", v);
  assert.equal(breakerOpen("clin-r"), false, "5 chamadas ainda nao abrem");
  noteVerdict("clin-r", bom);
  assert.equal(breakerOpen("clin-r"), true, "4 de 6 (67%) abrem");
  // 5 boas + 5 falhas alternadas = 50% e nunca 3 seguidas: nao abre
  for (let i = 0; i < 5; i++) { noteVerdict("clin-z", bom); noteVerdict("clin-z", falha); }
  assert.equal(breakerOpen("clin-z"), false);
});

test("disjuntor: estado expirado e removido (memoria nao cresce sem limite) e fecha sozinho depois dos 30 min", () => {
  resetBreakerForTests();
  const t0 = Date.now();
  for (let i = 0; i < 210; i++) noteVerdict(`velha-${i}`, reescrita, t0);
  assert.ok(breakerStateSize() >= 210);
  noteVerdict("nova", reescrita, t0 + BREAKER_WINDOW_MS + 31 * 60_000);
  assert.ok(breakerStateSize() <= 5, `estados expirados tem que sair: ${breakerStateSize()}`);
  // aberta em t0 -> fechada 31 min depois
  resetBreakerForTests();
  abre("abre", t0);
  assert.equal(breakerOpen("abre", t0 + 60_000), true);
  assert.equal(breakerOpen("abre", t0 + 31 * 60_000), false);
});

test("disjuntor ABERTO: resposta INSEGURA continua barrada pelas travas deterministicas (acao que nao aconteceu, oferta que ela nao pediu, avaliacao proibida) - e a pessoa recebe resposta", async () => {
  const casos = [
    ["Pronto, cancelei seu horário!", {}, /cancelei/i],
    ["Agendei você para amanhã às 10h, combinado!", {}, /agendei/i],
    ["Tenho estes horários: hoje às 15:30, amanhã às 10:00. Qual você prefere?", { forbidSlotOffer: true }, /15:30|10:00/],
    ["Posso agendar uma avaliação gratuita pra você?", { forbidEvaluationOffer: true }, /avalia[cç][aã]o gratuita/i],
  ];
  for (const [original, ctx, proibido] of casos) {
    resetBreakerForTests();
    abre(clinic.id);
    assert.equal(breakerOpen(clinic.id), true);
    const r = await entrega({ original, ctx, keepBreaker: true });
    assert.equal(reviews.length, 0, "sem chamada de revisao com o disjuntor aberto");
    assert.equal(r.sent.length, 1, `a pessoa recebe resposta (${original})`);
    assert.ok(!proibido.test(r.sent[0]), `a trava segue barrando (${original}) -> saiu: ${r.sent[0]}`);
    assert.equal(r.status, "sent");
  }
  resetBreakerForTests();
});
