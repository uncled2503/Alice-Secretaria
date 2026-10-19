// PESQUISA DE SATISFACAO, LINK DO GOOGLE E CONVITE DE INDICACAO (pedido da Lisboa, 18/10/2026). Relogio controlado, banco temporario, OpenAI e UAZAPI simuladas.
//  1) frequencia: no maximo 1 pesquisa a cada 15 dias por PESSOA (janela movel);  2) a nota e lida pelo CODIGO (numero de horario/quantidade nao e nota);
//  3) link do Google: so depois de CONFIRMADO (nenhuma URL inventada; as de teste so existem aqui);  4) convite de indicacao: mensagem SEPARADA, com controle;
//  5) fluxo integrado: atendimento elegivel -> pesquisa -> nota -> agradecimento + link de teste -> indicacao separada -> tudo persistido.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.TZ = "UTC";
const dbFile = path.join(os.tmpdir(), `alice-pesquisa-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY = "test-key";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

// ---- servicos simulados
const posts = []; // mensagens que a UAZAPI aceitou: { number, text }
let uazapiMode = "ok"; // ok | http500 | timeout
let reviewDecision = { decisao: "enviar", confianca: "alta", motivo: "ok" };
const modelCalls = [];
const reviewCalls = [];
let modelScript = [];
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const plain = (content) => ({ id: "c", object: "chat.completion", created: 1, model: "gpt-4o-mini", choices: [{ index: 0, message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.includes("openai.com")) {
    const body = JSON.parse(init.body);
    const system = String(body.messages?.[0]?.content ?? "");
    if (/REVISOR (DE ENVIO|das respostas)/.test(system)) { reviewCalls.push(body); return jsonRes(200, plain(reviewDecision)); }
    if (body.tools) {
      modelCalls.push(body);
      const next = modelScript.shift();
      if (next === undefined) throw new Error("o roteiro do modelo acabou (o modelo NAO deveria ser chamado)");
      return jsonRes(200, plain(next));
    }
    return jsonRes(200, plain("{}"));
  }
  if (u.hostname.endsWith("uazapi.com") && u.pathname === "/send/text") {
    if (uazapiMode === "http500") return jsonRes(500, { error: "fora do ar" });
    if (uazapiMode === "timeout") throw Object.assign(new Error("The operation timed out (TimeoutError)"), { name: "TimeoutError" });
    const b = JSON.parse(init.body);
    posts.push({ number: b.number, text: b.text });
  }
  return jsonRes(200, { id: "msg" });
};

const { prisma } = await import("../dist/db/client.js");
const { generateReply } = await import("../dist/ai/alice.js");
const { runNpsCycle } = await import("../dist/reminders/nps.js");
const reply = await import("../dist/reminders/surveyReply.js");
const link = await import("../dist/reminders/reviewLink.js");
const flow = await import("../dist/reminders/surveyFlow.js");
const { trySurveyReply } = await import("../dist/reminders/surveyHandler.js");
const { deliverAliceReply } = await import("../dist/uazapi/client.js");
const { isFixedReply } = await import("../dist/ai/fixedReplies.js");
const { reviewOutbound, resetBreakerForTests } = await import("../dist/ai/sendGate.js");
const { prepararGoogleLisboa } = await import("../dist/maintenance/lisboaGoogle.js");
const { diagnoseJobs } = await import("../dist/crm/automationRuns.js");

test.after(async () => {
  await (await import("../dist/jobs/background.js")).drainBackground(); // tarefas em segundo plano terminam ANTES de o banco temporario ser apagado
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* arquivo temporario */ } }
});

const TZ = "America/Sao_Paulo";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const sp = (iso) => new Date(`${iso}-03:00`);
const noSleep = async () => undefined;
// URL SO DE TESTE (formato valido de link g.page): nunca e a da Lisboa nem de outra clinica real.
const TEST_LINK = "https://g.page/r/TESTE-APENAS-NOS-TESTES/review";

let seq = 0;
let current = null;
const use = (c) => (current = c);
async function mkClinic(name, over = {}) {
  return prisma.clinic.create({
    data: {
      name, whatsappPhone: `55119${Math.floor(Math.random() * 1e8)}`, timezone: TZ, plan: "prime", aliceActive: true, uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: `tok-${Math.random().toString(36).slice(2)}`,
      workDays: "0,1,2,3,4,5,6", workStartHour: 0, workEndHour: 24, closedOnHolidays: false,
      npsEnabled: true, npsHoursAfter: 1, npsThreshold: 9, npsMessage: "Oi {primeiro_nome}! Como foi sua experiencia? De 0 a 10, qual nota voce daria?", npsEvaluationMessage: "Oi {primeiro_nome}! Como foi a sua avaliacao? De 0 a 10, qual nota voce daria?",
      silentHandoff: true, ...over,
    },
  });
}
const confirmedLink = (extra = {}) => ({ googleReviewUrl: TEST_LINK, googleReviewConfirmedAt: new Date(), googleReviewConfirmedBy: "teste", googleReviewPlace: "Estabelecimento de Teste", ...extra });
async function patientOf(clinic, name = "Maria Teste", extra = {}) {
  seq++;
  return prisma.patient.create({ data: { clinicId: clinic.id, name, phone: `551197777${String(1000 + seq)}`, ...extra } });
}
async function procOf(clinic, name) {
  return (await prisma.procedure.findFirst({ where: { clinicId: clinic.id, name } })) ?? prisma.procedure.create({ data: { clinicId: clinic.id, name, durationMin: 30 } });
}
async function done(clinic, patient, scheduledAt, procName = "Limpeza de Pele", status = "completed", extra = {}) {
  const procedure = await procOf(clinic, procName);
  return prisma.appointment.create({ data: { clinicId: clinic.id, patientId: patient.id, procedureId: procedure.id, scheduledAt, status, source: "presencial", ...extra } });
}
const reset = () => { posts.length = 0; modelCalls.length = 0; reviewCalls.length = 0; modelScript = []; uazapiMode = "ok"; reviewDecision = { decisao: "enviar", confianca: "alta", motivo: "ok" }; process.env.AI_SEND_REVIEW = "off"; resetBreakerForTests(); };
const runAt = (iso) => runNpsCycle({ now: sp(iso), clinicId: current.id });
const ledgerOf = (patientId, f = "pesquisa") => prisma.followUpDispatch.findMany({ where: { patientId, flow: f }, orderBy: { createdAt: "asc" } });
const surveysOf = (patientId) => prisma.satisfactionSurvey.findMany({ where: { patientId }, orderBy: { askedAt: "asc" } });

// ================================================================ 1) FREQUENCIA

test("frequencia (puro): janela MOVEL de 15 dias; no instante exato dos 15 dias ja pode; um minuto antes, nao", () => {
  const last = new Date("2026-10-01T10:00:00Z");
  assert.deepEqual(flow.frequencyVerdict(null, last), { allowed: true, nextEligibleAt: null });
  assert.equal(flow.frequencyVerdict(last, new Date("2026-10-16T09:59:00Z")).allowed, false);
  assert.equal(flow.frequencyVerdict(last, new Date("2026-10-16T10:00:00Z")).allowed, true);
  assert.equal(flow.frequencyVerdict(last, new Date("2026-10-16T10:00:00Z")).nextEligibleAt.toISOString(), "2026-10-16T10:00:00.000Z");
});

test("DOIS atendimentos da mesma pessoa no mesmo dia (procedimentos e profissionais diferentes): so UMA pesquisa; a outra e descartada e registrada, sem fila", async () => {
  reset();
  const c = use(await mkClinic("Clinica Pesquisa 1"));
  const p = await patientOf(c, "Ana Dois");
  const a1 = await done(c, p, sp("2026-10-15T09:00"), "Limpeza de Pele");
  const a2 = await done(c, p, sp("2026-10-15T10:30"), "Drenagem");
  await runAt("2026-10-15T13:00");
  assert.equal(posts.length, 1, "uma pesquisa so");
  assert.equal((await surveysOf(p.id)).length, 1);
  const rows = await ledgerOf(p.id);
  const byAppt = Object.fromEntries(rows.map((r) => [r.cycleKey, r]));
  assert.equal(byAppt[a1.id].state, "sent");
  assert.equal(byAppt[a2.id].state, "skipped");
  assert.equal(byAppt[a2.id].layer, "politica");
  assert.match(byAppt[a2.id].reason, /frequencia.*nao fica na fila/);
  // rodadas seguintes (mesmo dia e depois): nada novo, nada acumula
  await runAt("2026-10-15T13:30");
  await runAt("2026-10-16T09:00");
  assert.equal(posts.length, 1);
});

test("limite exato: 15 dias bloqueia ate o instante dos 15 dias; sem fila nem compensacao quando completa; entre clinicas nao se mistura", async () => {
  reset();
  const c = use(await mkClinic("Clinica Pesquisa 2"));
  const outra = await mkClinic("Clinica Pesquisa 2b");
  const p = await patientOf(c, "Bia Limite");
  // ultima pesquisa ha 15 dias menos 1 minuto -> bloqueia; a pesquisa daquele atendimento e DESCARTADA
  await prisma.satisfactionSurvey.create({ data: { clinicId: c.id, patientId: p.id, askedAt: new Date(sp("2026-10-15T13:00").getTime() - 15 * DAY + 60_000) } });
  const bloqueada = await done(c, p, sp("2026-10-15T09:00"));
  await runAt("2026-10-15T13:00");
  assert.equal(posts.length, 0);
  assert.equal((await ledgerOf(p.id))[0].state, "skipped");
  // a "compensacao": quando completar os 15 dias, a pesquisa descartada NAO dispara (continua descartada)
  await runAt("2026-10-15T13:02");
  assert.equal(posts.length, 0, "a de ontem nao volta quando completa os 15 dias");
  assert.equal((await ledgerOf(p.id)).length, 1);
  // um atendimento NOVO depois dos 15 dias exatos recebe
  const q = await patientOf(c, "Caio Exato");
  await prisma.satisfactionSurvey.create({ data: { clinicId: c.id, patientId: q.id, askedAt: new Date(sp("2026-10-15T13:00").getTime() - 15 * DAY) } });
  await done(c, q, sp("2026-10-15T09:00"));
  await runAt("2026-10-15T13:00");
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /^Oi Caio!/);
  // outra clinica, mesma pessoa de telefone: linhas de paciente diferentes, nada em comum
  use(outra);
  const r = await prisma.patient.create({ data: { clinicId: outra.id, name: "Dani Outra", phone: p.phone } });
  await done(outra, r, sp("2026-10-15T09:00"));
  await runAt("2026-10-15T13:00");
  assert.ok(posts.some((x) => x.number === p.phone), "a regra e por clinica: a pesquisa de outra clinica nao bloqueia esta");
  assert.ok(bloqueada);
});

test("nao exige resposta anterior: quem nunca respondeu a pesquisa recebe a proxima passados os 15 dias", async () => {
  reset();
  const c = use(await mkClinic("Clinica Pesquisa 3"));
  const p = await patientOf(c, "Eva Sem Resposta");
  await prisma.satisfactionSurvey.create({ data: { clinicId: c.id, patientId: p.id, askedAt: new Date(sp("2026-10-15T13:00").getTime() - 16 * DAY) } }); // nunca respondeu
  await done(c, p, sp("2026-10-15T09:00"));
  await runAt("2026-10-15T13:00");
  assert.equal(posts.length, 1);
});

test("resultado do envio: falha de envio NAO conta como enviada (tenta de novo); timeout e 'sem confirmacao' (conta como enviada e NAO reenvia); veto e temporario; ninguem recebe duas", async () => {
  reset();
  const c = use(await mkClinic("Clinica Pesquisa 4"));
  const falha = await patientOf(c, "Fabi Falha");
  await done(c, falha, sp("2026-10-15T09:00"));
  uazapiMode = "http500";
  await runAt("2026-10-15T13:00");
  assert.equal((await surveysOf(falha.id)).length, 0, "nada saiu: nao conta como pesquisa enviada");
  assert.deepEqual((await ledgerOf(falha.id)).map((r) => [r.state, r.layer, r.temporary]), [["failed", "envio", true]]);
  uazapiMode = "ok";
  await runAt("2026-10-15T13:05"); // antes do intervalo minimo entre tentativas
  assert.equal(posts.length, 0);
  await runAt("2026-10-15T13:20");
  assert.equal(posts.length, 1);
  assert.deepEqual((await ledgerOf(falha.id)).map((r) => [r.state, r.attempt]), [["sent", 2]]);

  const amb = await patientOf(c, "Gabi Timeout");
  await done(c, amb, sp("2026-10-15T09:00"));
  uazapiMode = "timeout";
  await runAt("2026-10-15T14:00");
  assert.deepEqual((await ledgerOf(amb.id)).map((r) => r.state), ["unconfirmed"]);
  assert.equal((await surveysOf(amb.id)).length, 1, "pode ter chegado: a pesquisa fica registrada (a nota dela sera associada) e conta para a frequencia");
  uazapiMode = "ok";
  const antes = posts.length;
  await runAt("2026-10-15T14:30");
  await runAt("2026-10-15T20:00");
  assert.equal(posts.length, antes, "nunca reenvia as cegas");

  reset();
  process.env.AI_SEND_REVIEW = "on";
  reviewDecision = { decisao: "nao_enviar", confianca: "alta", motivo: "ela reclamou ontem" };
  const veto = await patientOf(c, "Vera Veto");
  await done(c, veto, sp("2026-10-16T09:00"));
  await runAt("2026-10-16T13:00");
  assert.equal(posts.length, 0);
  assert.equal((await surveysOf(veto.id)).length, 0, "barrada pela revisao: nao conta como enviada");
  assert.deepEqual((await ledgerOf(veto.id)).map((r) => [r.state, r.layer, r.temporary]), [["vetoed", "revisao_envio", true]]);
});

test("exclusoes que ja existiam continuam: cancelado, falta, quem pediu para sair e atendimento humano em curso nao recebem; avaliacao usa o texto proprio e conta na frequencia", async () => {
  reset();
  const c = use(await mkClinic("Clinica Pesquisa 5"));
  const canc = await patientOf(c, "Cancelou");
  await done(c, canc, sp("2026-10-15T09:00"), "Limpeza de Pele", "cancelled");
  const falta = await patientOf(c, "Faltou");
  await done(c, falta, sp("2026-10-15T09:00"), "Limpeza de Pele", "no_show");
  const saiu = await patientOf(c, "Saiu", { optedOut: true });
  await done(c, saiu, sp("2026-10-15T09:00"));
  const humano = await patientOf(c, "Humano");
  await done(c, humano, sp("2026-10-15T09:00"));
  await prisma.conversation.create({ data: { patientId: humano.id, humanTakeover: true } });
  const aval = await patientOf(c, "Avaliada");
  await done(c, aval, sp("2026-10-15T09:00"), "Avaliação Estética");
  await runAt("2026-10-15T13:00");
  assert.equal(posts.length, 1, posts.map((x) => x.text).join(" | "));
  assert.equal(posts[0].number, aval.phone);
  assert.match(posts[0].text, /como foi a sua avaliacao/i, "a avaliacao usa o texto proprio da avaliacao");
  // a avaliacao ja contou: um procedimento logo depois NAO gera outra pesquisa
  await done(c, aval, sp("2026-10-15T11:00"), "Limpeza de Pele");
  await runAt("2026-10-15T13:30");
  assert.equal(posts.length, 1);
  assert.ok(canc && falta && saiu);
});

test("identidade: duas linhas com o MESMO vinculo do Clinica Experts sao a mesma pessoa; telefones parecidos sem vinculo NAO se juntam", async () => {
  reset();
  const c = use(await mkClinic("Clinica Pesquisa 6"));
  const a = await patientOf(c, "Ines CE", { ceUuid: "ce-pessoa-1" });
  const b = await patientOf(c, "Ines CE (duplicada)", { ceUuid: "ce-pessoa-1" });
  const outra = await patientOf(c, "Outra Pessoa");
  const id = await flow.identityPatientIds(c.id, a.id);
  assert.deepEqual([id.ids.length, id.ambiguous], [2, true], "o vinculo junta as duas linhas e o diagnostico sinaliza");
  assert.deepEqual((await flow.identityPatientIds(c.id, outra.id)).ids, [outra.id]);
  await prisma.satisfactionSurvey.create({ data: { clinicId: c.id, patientId: a.id, askedAt: sp("2026-10-10T10:00") } });
  await done(c, b, sp("2026-10-15T09:00"));
  await runAt("2026-10-15T13:00");
  assert.equal(posts.length, 0, "a pesquisa foi para a mesma pessoa pela outra linha: bloqueia");
});

// ================================================================ 2) INTERPRETACAO DA NOTA

const SURVEY_Q = { role: "assistant", content: "Oi Maria! Como foi sua experiencia? De 0 a 10, qual nota voce daria?", authorName: "Pesquisa de satisfação" };
const read = (text, between = []) => reply.readSurveyReply(text, [SURVEY_Q, ...between, { role: "user", content: text }]);

test("interpretacao (puro): numero sozinho depois da pesquisa e nota; marca explicita vale sempre; horario, data, quantidade e idade nunca", () => {
  for (const [t, n] of [["10", 10], ["9!", 9], ["dez", 10], ["nove", 9], ["0", 0], ["Nota 9", 9], ["dou 10", 10], ["10/10", 10], ["8 de 10", 8], ["nota dez", 10], ["daria um 8", 8]]) {
    const r = read(t);
    assert.deepEqual([r.kind, r.score], ["score", n], t);
  }
  for (const t of ["Pode ser às 10", "10h", "às 10:30", "tenho 10 sessões", "dia 10", "10/11", "tenho 10 anos", "quero 10 reais de desconto", "9,5", "uma", "um", "11", "marcar dia 10 às 14h", "10 e 20"]) {
    assert.equal(read(t).kind, "other", t);
  }
  assert.equal(read("9,5").reason, "nota_fracionada");
  assert.equal(read("Pode ser às 10").reason, "numero_nao_e_nota");
});

test("interpretacao (puro): 'Nota 9, mas tive um problema' e nota COM RECLAMACAO; elogio nao e reclamacao; 'um' sozinho nao e nota", () => {
  const r = read("Nota 9, mas tive um problema na pele");
  assert.equal(r.kind, "score");
  assert.equal(r.score, 9);
  assert.equal(r.complaint, true);
  assert.match(r.comment, /problema/);
  assert.equal(read("10, amei o atendimento").complaint, false);
  assert.equal(read("10 mas demorou muito para me atenderem").complaint, true);
  assert.equal(read("Nota 8, a moça foi super atenciosa").complaint, false);
});

test("interpretacao (puro): numero sozinho so vale se a ULTIMA pergunta foi a pesquisa (mensagens intermediarias)", () => {
  // depois da pesquisa a Alice ofereceu horarios; "10" agora e escolha de horario, nao nota
  const ofertaHorario = { role: "assistant", content: "Tenho amanha as 10h ou as 14h. Qual prefere?", authorName: null };
  const r = read("10", [{ role: "user", content: "queria marcar de novo" }, ofertaHorario]);
  assert.deepEqual([r.kind, r.reason], ["other", "fora_do_contexto_da_pesquisa"]);
  // mas "nota 10" explicito vale mesmo assim
  assert.equal(read("nota 10", [ofertaHorario]).kind, "score");
  // sem pergunta de pesquisa na conversa, numero sozinho nao e nota
  assert.equal(reply.readSurveyReply("10", [{ role: "assistant", content: "Posso te ajudar?", authorName: null }, { role: "user", content: "10" }]).kind, "other");
  assert.deepEqual([reply.scoreBand(6, 9), reply.scoreBand(7, 9), reply.scoreBand(8, 9), reply.scoreBand(9, 9), reply.scoreBand(10, 9), reply.scoreBand(8, 8)], ["baixa", "neutra", "neutra", "positiva", "positiva", "positiva"]);
});

// ================================================================ 3) LINK DO GOOGLE

test("link (puro): so link de avaliacao do Google; pagina de busca, outro dominio e http nao valem; sem confirmacao o link NAO e enviado", () => {
  assert.equal(link.validateReviewUrl(TEST_LINK).ok, true);
  assert.equal(link.validateReviewUrl("https://search.google.com/local/writereview?placeid=ChIJteste").ok, true);
  assert.equal(link.validateReviewUrl("https://maps.app.goo.gl/AbCdEf").ok, true);
  assert.deepEqual([link.validateReviewUrl("").problem, link.validateReviewUrl("http://g.page/r/x/review").problem, link.validateReviewUrl("https://www.google.com/search?q=lisboa+beauty").problem, link.validateReviewUrl("https://exemplo.com/avaliar").problem, link.validateReviewUrl("https://g.page/lisboa").problem, link.validateReviewUrl("isso nao e url").problem],
    ["vazio", "nao_e_https", "pagina_de_busca", "dominio_nao_reconhecido", "sem_caminho_de_avaliacao", "url_invalida"]);
  assert.equal(link.reviewLinkState({ googleReviewUrl: TEST_LINK, googleReviewConfirmedAt: new Date() }).send, true);
  assert.deepEqual(link.reviewLinkState({ googleReviewUrl: TEST_LINK, googleReviewConfirmedAt: null }), { send: false, reason: "nao_confirmado", detail: "o link esta cadastrado mas ninguem confirmou que o destino e o estabelecimento certo" });
  assert.equal(link.reviewLinkState({ googleReviewUrl: null, googleReviewConfirmedAt: new Date() }).reason, "ausente");
  assert.equal(link.reviewLinkState({ googleReviewUrl: "https://www.google.com/search?q=x", googleReviewConfirmedAt: new Date() }).reason, "invalido");
});

test("a Lisboa NAO tem link inventado: a migracao deixa o link de 16/10 SEM confirmacao, o seed nao grava link, e o codigo nao carrega nenhuma URL do Google fora do teste", () => {
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
  const mig = read("../prisma/migrations/20261018110000_pesquisa_google_indicacao/migration.sql");
  assert.match(mig, /"name" <> 'Lisboa Beauty Center'/, "so as OUTRAS clinicas (que cadastraram o proprio link) ficam confirmadas");
  assert.doesNotMatch(read("../src/maintenance/seedLisboa.ts"), /googleReviewUrl:\s*"/);
  // nenhuma URL do Google em arquivo de codigo (src) alem dos dominios de validacao
  const srcFiles = [];
  const walk = (dir) => { for (const e of fs.readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) { const rel = `${dir}${e.name}`; if (e.isDirectory()) walk(`${rel}/`); else if (/\.ts$/.test(e.name)) srcFiles.push(rel); } };
  walk("../src/");
  for (const f of srcFiles) assert.doesNotMatch(read(f), /g\.page\/r\/[A-Za-z0-9_-]{6,}/, `${f} carrega um link de avaliacao`);
});

test("a nota alta SEM link confirmado: agradece normalmente, NAO manda link, registra a pendencia para a equipe e a conversa nao fica sem resposta", async () => {
  reset();
  const c = await mkClinic("Clinica Link Pendente", { googleReviewUrl: TEST_LINK /* cadastrado, NAO confirmado */, notifyPhone: "5511977776666", notifyEvents: "automation_failed,human_handoff" });
  const { conv, patient } = await conversaComPesquisa(c, "Rita Pendente");
  await falar(conv, "10");
  const r = await generateReply(conv.id);
  assert.match(r, /^Que bom saber, Rita! /);
  assert.doesNotMatch(r, /https?:|google/i, "nenhum link");
  assert.equal(modelCalls.length, 0, "a nota foi tratada pelo codigo, sem o modelo");
  const s = (await surveysOf(patient.id))[0];
  assert.deepEqual([s.score, s.band, s.linkState, s.reviewLinkSent], [10, "positiva", "pendente_confirmacao", false]);
  assert.ok(await prisma.activityLog.findFirst({ where: { patientId: patient.id, type: "google_review_pending" } }), "pendencia registrada");
  assert.ok(posts.some((x) => x.number === "5511977776666" && /NÃO enviei o link/.test(x.text)), "a equipe foi avisada");
  assert.equal(await prisma.message.count({ where: { conversationId: conv.id, role: "assistant", deliveryStatus: "pending" } }), 1);
});

test("manutencao do link da Lisboa: previa nao grava; confirmar exige quem conferiu e o ESTABELECIMENTO de destino; link de busca e recusado; idempotente; outra clinica intacta; nada vira 'confirmado' sozinho", async () => {
  const lisboa = await mkClinic("Lisboa Beauty Center", { googleReviewUrl: TEST_LINK });
  const outra = await mkClinic("Outra Clinica Link", { googleReviewUrl: "https://g.page/r/OUTRA-CLINICA/review" });
  await prisma.clinicFaq.create({ data: { clinicId: lisboa.id, question: "Onde avalio?", answer: "Avalie em https://g.page/r/OUTRO-LINK-ANTIGO/review obrigada" } });
  const previa = await prepararGoogleLisboa(lisboa.id, { dryRun: true });
  assert.equal(previa.dryRun, true);
  assert.equal(previa.atual.valida, true);
  assert.equal(previa.atual.confirmadoEm, null);
  assert.match(previa.atual.origem, /SEM conferência/);
  assert.match(previa.situacao, /NÃO envia link \(nao_confirmado/);
  assert.equal(previa.outrosLinksNoCadastro.length, 1);
  assert.equal(previa.outrosLinksNoCadastro[0].igualAoCadastrado, false);
  assert.ok(previa.perguntasPendentes.some((q) => /qual é o link de avaliação/i.test(q)));
  assert.ok(previa.perguntasPendentes.some((q) => /diferente do cadastrado/.test(q)));
  assert.equal((await prisma.clinic.findUnique({ where: { id: lisboa.id } })).googleReviewConfirmedAt, null, "previa nao confirma");

  await assert.rejects(prepararGoogleLisboa(lisboa.id, { dryRun: false, confirmar: { url: "https://www.google.com/search?q=lisboa", confirmadoPor: "Admin", estabelecimento: "Lisboa" } }), /busca/);
  await assert.rejects(prepararGoogleLisboa(lisboa.id, { dryRun: false, confirmar: { url: TEST_LINK, confirmadoPor: "", estabelecimento: "Lisboa" } }), /quem conferiu/);
  await assert.rejects(prepararGoogleLisboa(lisboa.id, { dryRun: false, confirmar: { url: TEST_LINK, confirmadoPor: "Admin", estabelecimento: "" } }), /estabelecimento/);
  const ok = await prepararGoogleLisboa(lisboa.id, { dryRun: false, actorName: "Admin", confirmar: { url: TEST_LINK, confirmadoPor: "Dra. Aline", estabelecimento: "Estabelecimento de Teste" } });
  assert.equal(ok.aplicado.linkConfirmado, true);
  assert.equal(ok.atual.estabelecimento, "Estabelecimento de Teste");
  assert.match(ok.situacao, /envia o link confirmado/);
  const again = await prepararGoogleLisboa(lisboa.id, { dryRun: false, confirmar: { url: TEST_LINK, confirmadoPor: "Dra. Aline", estabelecimento: "Estabelecimento de Teste" } });
  assert.equal(again.aplicado.linkConfirmado, false, "idempotente");
  assert.equal((await prisma.clinic.findUnique({ where: { id: outra.id } })).googleReviewConfirmedAt, null, "outra clinica nao foi tocada");
});

test("salvar o link no painel: recusa link invalido; confirmar = digitar um link NOVO; salvar outra configuracao com o mesmo link nao confirma", () => {
  const routes = fs.readFileSync(new URL("../src/api/routes.ts", import.meta.url), "utf8");
  assert.match(routes, /Link de avaliação do Google recusado/);
  assert.match(routes, /const changed = current\?\.googleReviewUrl\?\.trim\(\) !== v\.url/);
  assert.match(routes, /\.\.\.\(changed \? \{ googleReviewConfirmedAt: new Date\(\)/);
  assert.match(routes, /"\/clinics\/lisboa-google"/);
  assert.match(routes, /\/patients\/:id\/pesquisa-diagnostico/);
});

// ================================================================ 4) A NOTA NA CONVERSA (generateReply + modelo simulado)

async function conversaComPesquisa(clinic, name, { askedAgo = HOUR, authorName = "Pesquisa de satisfação" } = {}) {
  const patient = await patientOf(clinic, name);
  const conv = await prisma.conversation.create({ data: { patientId: patient.id, status: "active" } });
  const askedAt = new Date(Date.now() - askedAgo);
  await prisma.message.create({ data: { conversationId: conv.id, role: "assistant", content: `Oi ${name.split(" ")[0]}! Como foi sua experiencia? De 0 a 10, qual nota voce daria?`, authorName, createdAt: askedAt } });
  await prisma.satisfactionSurvey.create({ data: { clinicId: clinic.id, patientId: patient.id, askedAt } });
  return { patient, conv };
}
let tick = 0;
const falar = (conv, text) => prisma.message.create({ data: { conversationId: conv.id, role: "user", content: text, createdAt: new Date(Date.now() - 60_000 + ++tick) } });

test("nota ALTA com link CONFIRMADO: agradece e manda o link (resposta fixa, sem o modelo); grava de forma atomica; a revisao por IA nao mexe na resposta", async () => {
  reset();
  process.env.AI_SEND_REVIEW = "on";
  const c = await mkClinic("Clinica Nota Alta", confirmedLink());
  const { conv, patient } = await conversaComPesquisa(c, "Sara Alta");
  await falar(conv, "10");
  const r = await generateReply(conv.id);
  assert.equal(r, `Que bom saber, Sara! 💗 Ficamos muito felizes com a sua nota. Se puder, deixa a sua avaliação no Google, ajuda muito a gente: ${TEST_LINK}`);
  assert.equal(modelCalls.length, 0);
  const s = (await surveysOf(patient.id))[0];
  assert.deepEqual([s.score, s.band, s.hasComplaint, s.linkState, s.reviewLinkSent], [10, "positiva", false, "enviado", true]);
  assert.ok(s.answeredAt && s.answeredByMessageId);
  // o agradecimento e texto FIXO do sistema: nao passa pela revisao por IA (que poderia reescrever ou acrescentar convite)
  assert.equal(isFixedReply(r), true);
  const v = await reviewOutbound({ clinicId: c.id, phone: patient.phone, text: r, kind: "resposta_alice" });
  assert.deepEqual([v.reviewed, v.reason], [false, "resposta fixa do sistema"]);
  assert.equal(reviewCalls.length, 0);
});

test("nota alta COM reclamacao: sem link e sem convite de indicacao; a equipe e avisada. Nota baixa: aviso a equipe, sem link. Neutra: so agradece", async () => {
  reset();
  const c = await mkClinic("Clinica Nota Faixas", { ...confirmedLink(), notifyPhone: "5511966665555", notifyEvents: "human_handoff,automation_failed" });
  await prisma.resumeFlowConfig.create({ data: { clinicId: c.id, flow: "indicacao", enabled: true, message: link.DEFAULT_REFERRAL_TEXT, delayMinutes: 30 } });
  const comp = await conversaComPesquisa(c, "Lia Reclama");
  await falar(comp.conv, "Nota 9, mas tive um problema com a pele depois");
  const r1 = await generateReply(comp.conv.id);
  assert.match(r1, /^Obrigada pelo retorno, Lia! /);
  assert.doesNotMatch(r1, /https?:|google|avalia/i);
  assert.equal((await surveysOf(comp.patient.id))[0].hasComplaint, true);
  assert.equal(await prisma.followUpDispatch.count({ where: { patientId: comp.patient.id, flow: "indicacao" } }), 0, "nenhum convite agendado");
  assert.ok(posts.some((x) => x.number === "5511966665555" && /com reclamação/.test(x.text)));

  const baixa = await conversaComPesquisa(c, "Bia Baixa");
  await falar(baixa.conv, "5");
  const r2 = await generateReply(baixa.conv.id);
  assert.match(r2, /^Obrigada pela sinceridade, Bia! /);
  assert.doesNotMatch(r2, /https?:|google/i);
  assert.ok(posts.some((x) => /Avaliação baixa \(5\/10\)/.test(x.text)));

  const neutra = await conversaComPesquisa(c, "Nina Neutra");
  await falar(neutra.conv, "8");
  const r3 = await generateReply(neutra.conv.id);
  assert.match(r3, /^Obrigada pelo retorno, Nina! /);
  assert.doesNotMatch(r3, /https?:|google/i);
  assert.equal((await surveysOf(neutra.patient.id))[0].band, "neutra");
  assert.equal(modelCalls.length, 0);
  for (const t of [r1, r2, r3]) assert.equal(isFixedReply(t), true, t);
});

test("numero que NAO e nota nao grava: 'Pode ser as 10' e 'tenho 10 sessoes' seguem para o fluxo normal e a pesquisa continua pendente", async () => {
  reset();
  const c = await mkClinic("Clinica Nao Nota", confirmedLink());
  for (const texto of ["Pode ser às 10", "Tenho 10 sessões compradas"]) {
    const { conv, patient } = await conversaComPesquisa(c, "Pedro Horario");
    await falar(conv, texto);
    modelScript = ["Combinado! Prefere manhã ou tarde? 💗"];
    modelCalls.length = 0;
    await generateReply(conv.id);
    assert.equal(modelCalls.length >= 1, true, "o modelo cuidou da conversa");
    const s = (await surveysOf(patient.id))[0];
    assert.equal(s.answeredAt, null, `"${texto}" nao pode virar nota`);
    assert.equal(s.score, null);
    const prompt = modelCalls[0].messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    assert.match(prompt, /um numero solto no meio de uma frase \(horario, quantidade, idade, data\) NAO e nota/);
    assert.doesNotMatch(prompt, /Quando o paciente responder com um numero, chame record_satisfaction/);
  }
});

test("a mesma mensagem nunca grava duas vezes (webhook reentregue / rodada refeita): uma pesquisa, um aviso, o mesmo agradecimento", async () => {
  reset();
  const c = await mkClinic("Clinica Idempotente", { ...confirmedLink(), notifyPhone: "5511955554444", notifyEvents: "human_handoff" });
  const { conv, patient } = await conversaComPesquisa(c, "Dora Duas Vezes");
  const m = await falar(conv, "3");
  const history = await prisma.message.findMany({ where: { conversationId: conv.id }, orderBy: { createdAt: "asc" } });
  const one = await trySurveyReply({ clinicId: c.id, conversationId: conv.id, patientId: patient.id, history });
  const two = await trySurveyReply({ clinicId: c.id, conversationId: conv.id, patientId: patient.id, history });
  assert.equal(one, two, "o mesmo agradecimento");
  assert.equal((await surveysOf(patient.id)).length, 1);
  assert.equal(posts.filter((x) => /Avaliação baixa/.test(x.text)).length, 1, "a equipe foi avisada UMA vez");
  assert.equal(await prisma.activityLog.count({ where: { patientId: patient.id, type: "satisfaction_recorded" } }), 1);
  assert.equal(await prisma.message.count({ where: { conversationId: conv.id, role: "assistant", content: one } }), 1, "uma resposta gravada");
  // a ferramenta do modelo seguindo a mesma regra: depois de respondida, nao grava outra
  const again = await flow.recordSurveyAnswer({ clinicId: c.id, patientId: patient.id, score: 9, comment: null, complaint: false });
  assert.deepEqual(again, { ok: false, motivo: "sem_pesquisa_pendente" });
  assert.ok(m);
});

test("obrigada/ok depois da pesquisa ou do convite so agradece (sem avaliacao clinica, horarios ou venda); pergunta nova e atendida normalmente", async () => {
  reset();
  const c = await mkClinic("Clinica Obrigada", confirmedLink());
  const { conv, patient } = await conversaComPesquisa(c, "Olga Obrigada");
  await falar(conv, "Obrigada!");
  const r = await generateReply(conv.id);
  assert.match(r, /^Por nada, Olga/);
  assert.doesNotMatch(r, /avalia|hor[aá]rio|agendar/i);
  assert.equal(modelCalls.length, 0);
  // apos o convite de indicacao: "ok" tambem so agradece
  const p2 = await patientOf(c, "Paula Convite");
  const conv2 = await prisma.conversation.create({ data: { patientId: p2.id, status: "active" } });
  await prisma.message.create({ data: { conversationId: conv2.id, role: "assistant", content: link.DEFAULT_REFERRAL_TEXT, authorName: flow.REFERRAL_AUTHOR, createdAt: new Date(Date.now() - HOUR), deliveryStatus: "sent" } });
  await falar(conv2, "Obrigada!");
  const r2 = await generateReply(conv2.id);
  assert.doesNotMatch(r2, /avalia|hor[aá]rio|agendar/i);
  assert.equal(modelCalls.length, 0);
  // pergunta nova explicita: atendida
  const { conv: conv3 } = await conversaComPesquisa(c, "Rosa Pergunta");
  await falar(conv3, "Qual o endereço de vocês?");
  modelScript = ["Ficamos na Av. Índico, 294. 💗"];
  const r3 = await generateReply(conv3.id);
  assert.match(r3, /Av\. Índico/);
  assert.equal(modelCalls.length, 1);
  assert.ok(patient);
});

// ================================================================ 5) CONVITE DE INDICACAO (mensagem SEPARADA, com controle)

test("texto do convite: pede que a PROPRIA cliente compartilhe o contato da clinica; recusa pedir dados de terceiros e qualquer recompensa", () => {
  assert.equal(link.validateReferralText(link.DEFAULT_REFERRAL_TEXT).ok, true);
  for (const t of ["Me passa o telefone da sua amiga?", "Manda o contato de um familiar que queira conhecer", "Qual o nome e o número da sua amiga?", "Indique uma amiga e ganhe 10% de desconto", "Quem indicar ganha um brinde", ""]) {
    assert.equal(link.validateReferralText(t).ok, false, t);
  }
});

async function pronto(nome, { thanksStatus = "sent", delay = 30, referral = {} } = {}) {
  const c = await mkClinic(`Clinica Convite ${++seq}`, confirmedLink());
  await prisma.resumeFlowConfig.create({ data: { clinicId: c.id, flow: "indicacao", enabled: true, message: link.DEFAULT_REFERRAL_TEXT, delayMinutes: delay, ...referral } });
  const { conv, patient } = await conversaComPesquisa(c, nome, { askedAgo: 3 * HOUR });
  await falar(conv, "10");
  const out = await generateReply(conv.id); // o agradecimento (com o link de teste) e o agendamento do convite
  await prisma.message.updateMany({ where: { conversationId: conv.id, role: "assistant", content: out }, data: { deliveryStatus: thanksStatus } });
  const survey = (await surveysOf(patient.id))[0];
  return { c, conv, patient, survey, out };
}
const referralAt = (iso, c) => flow.runReferralSteps({ now: sp(iso), clinicId: c.id, sleep: noSleep });

test("o convite e uma mensagem SEPARADA do agradecimento: sai depois do intervalo, no horario da clinica, so uma vez, e fica persistido", async () => {
  reset();
  const { c, patient, survey, out } = await pronto("Tina Separada");
  assert.match(out, new RegExp(TEST_LINK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "o agradecimento leva o link de teste");
  assert.doesNotMatch(out, /amig|famil|indica/i, "o agradecimento NAO traz a indicacao junto");
  const agendado = await prisma.followUpDispatch.findFirst({ where: { patientId: patient.id, flow: "indicacao" } });
  assert.deepEqual([agendado.state, agendado.cycleKey, agendado.temporary], ["deferred", survey.id, true]);
  const antes = new Date(survey.answeredAt.getTime() + 10 * 60_000);
  await flow.runReferralSteps({ now: antes, clinicId: c.id, sleep: noSleep });
  assert.equal(posts.length, 0, "ainda nao passou o intervalo");
  const depois = new Date(survey.answeredAt.getTime() + 90 * 60_000);
  await flow.runReferralSteps({ now: depois, clinicId: c.id, sleep: noSleep });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].text, link.DEFAULT_REFERRAL_TEXT.replace("{unidade}", c.name));
  assert.doesNotMatch(posts[0].text, /https?:/, "o convite nao leva link");
  const row = await prisma.followUpDispatch.findFirst({ where: { patientId: patient.id, flow: "indicacao" } });
  assert.deepEqual([row.state, row.layer], ["sent", "envio"]);
  assert.ok(await prisma.message.findFirst({ where: { conversation: { patientId: patient.id }, authorName: flow.REFERRAL_AUTHOR } }));
  await flow.runReferralSteps({ now: new Date(depois.getTime() + 30 * 60_000), clinicId: c.id, sleep: noSleep });
  assert.equal(posts.length, 1, "uma vez so");
});

test("sem politica definida o convite NAO existe: sem texto/intervalo configurados nada e agendado; sem link confirmado nao ha convite", async () => {
  reset();
  const c = await mkClinic("Clinica Sem Politica", confirmedLink());
  const a = await conversaComPesquisa(c, "Uma Sem Convite");
  await falar(a.conv, "10");
  await generateReply(a.conv.id);
  assert.equal(await prisma.followUpDispatch.count({ where: { patientId: a.patient.id, flow: "indicacao" } }), 0);
  await prisma.resumeFlowConfig.create({ data: { clinicId: c.id, flow: "indicacao", enabled: true, message: link.DEFAULT_REFERRAL_TEXT, delayMinutes: null } });
  const b = await conversaComPesquisa(c, "Bia Sem Intervalo");
  await falar(b.conv, "10");
  await generateReply(b.conv.id);
  assert.equal(await prisma.followUpDispatch.count({ where: { patientId: b.patient.id, flow: "indicacao" } }), 0, "intervalo nao definido: desligado");
  const semLink = await mkClinic("Clinica Sem Link", { googleReviewUrl: TEST_LINK });
  await prisma.resumeFlowConfig.create({ data: { clinicId: semLink.id, flow: "indicacao", enabled: true, message: link.DEFAULT_REFERRAL_TEXT, delayMinutes: 5 } });
  const d = await conversaComPesquisa(semLink, "Duda Sem Link");
  await falar(d.conv, "10");
  await generateReply(d.conv.id);
  assert.equal(await prisma.followUpDispatch.count({ where: { patientId: d.patient.id, flow: "indicacao" } }), 0);
});

test("antes de convidar: etapa anterior falhou de vez = nao convida; em andamento = espera; conversa ativa nao e interrompida; reclamacao, opt-out e atendimento humano seguram", async () => {
  reset();
  // agradecimento NAO entregue (falha definitiva)
  const f = await pronto("Fran Falhou", { thanksStatus: "failed_permanent" });
  await referralAt("2026-10-18T10:00", f.c);
  const quando = new Date(f.survey.answeredAt.getTime() + 90 * 60_000);
  await flow.runReferralSteps({ now: quando, clinicId: f.c.id, sleep: noSleep });
  assert.equal(posts.length, 0);
  assert.equal((await ledgerOf(f.patient.id, "indicacao"))[0].state, "skipped");
  assert.match((await ledgerOf(f.patient.id, "indicacao"))[0].reason, /agradecimento nao foi entregue/);

  // agradecimento ainda em entrega: espera
  const e = await pronto("Edna Entrega", { thanksStatus: "pending" });
  await flow.runReferralSteps({ now: new Date(e.survey.answeredAt.getTime() + 90 * 60_000), clinicId: e.c.id, sleep: noSleep });
  assert.equal(posts.length, 0);
  assert.equal((await ledgerOf(e.patient.id, "indicacao"))[0].state, "deferred");

  // conversa ativa (mensagem ha menos de 30 min): nao interrompe; quieta, envia
  const a = await pronto("Alda Ativa");
  const t0 = new Date(a.survey.answeredAt.getTime() + 90 * 60_000);
  await prisma.message.create({ data: { conversationId: a.conv.id, role: "user", content: "Aproveitando, quanto custa a drenagem?", createdAt: new Date(t0.getTime() - 10 * 60_000) } });
  await flow.runReferralSteps({ now: t0, clinicId: a.c.id, sleep: noSleep });
  assert.equal(posts.length, 0, "conversa ativa nao e interrompida");
  await flow.runReferralSteps({ now: new Date(t0.getTime() + 40 * 60_000), clinicId: a.c.id, sleep: noSleep });
  assert.equal(posts.length, 1);

  // reclamacao depois do agradecimento, opt-out e atendimento humano
  posts.length = 0;
  const r = await pronto("Rute Reclamou");
  await prisma.message.create({ data: { conversationId: r.conv.id, role: "user", content: "Na verdade a pele ficou vermelha, tive um problema", createdAt: new Date(r.survey.answeredAt.getTime() + 20 * 60_000) } });
  await flow.runReferralSteps({ now: new Date(r.survey.answeredAt.getTime() + 120 * 60_000), clinicId: r.c.id, sleep: noSleep });
  assert.equal(posts.length, 0);
  assert.match((await ledgerOf(r.patient.id, "indicacao"))[0].reason, /reclamou depois da nota/);
  const o = await pronto("Ofelia Saiu");
  await prisma.patient.update({ where: { id: o.patient.id }, data: { optedOut: true } });
  await flow.runReferralSteps({ now: new Date(o.survey.answeredAt.getTime() + 120 * 60_000), clinicId: o.c.id, sleep: noSleep });
  assert.equal(posts.length, 0);
  const h = await pronto("Helena Humano");
  await prisma.conversation.update({ where: { id: h.conv.id }, data: { humanTakeover: true } });
  await flow.runReferralSteps({ now: new Date(h.survey.answeredAt.getTime() + 120 * 60_000), clinicId: h.c.id, sleep: noSleep });
  assert.equal(posts.length, 0);
  assert.equal((await ledgerOf(h.patient.id, "indicacao"))[0].state, "deferred", "atendimento humano: espera, nao descarta");
});

test("o convite respeita o horario da clinica, expira com contexto velho, nao se repete e reinicio nao repete etapas ja concluidas", async () => {
  reset();
  const p = await pronto("Lia Horario");
  await prisma.clinic.update({ where: { id: p.c.id }, data: { workStartHour: 9, workEndHour: 18 } });
  const fora = new Date(p.survey.answeredAt.getTime() + 60 * 60_000);
  // forca um horario fora do expediente: 23h em Sao Paulo
  // 23h de SP do dia seguinte ao de HOJE (data fixa quebrava quando o relogio real passava dela: a conversa "recente" ficava no futuro do relogio da rodada)
  const amanhaSp = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + DAY));
  const noite = sp(`${amanhaSp}T23:00`);
  await prisma.followUpDispatch.updateMany({ where: { patientId: p.patient.id, flow: "indicacao" }, data: { dueAt: new Date(noite.getTime() - 60_000) } });
  await flow.runReferralSteps({ now: noite, clinicId: p.c.id, sleep: noSleep });
  assert.equal(posts.length, 0, "fora do expediente");
  assert.equal(JSON.parse((await prisma.automationRun.findFirst({ where: { clinicId: p.c.id, job: "convite-indicacao" }, orderBy: { finishedAt: "desc" } })).reasons)["adiado:fora_da_janela:fora_do_expediente"], 1);
  // passou mais de 24h do previsto: nao envia com contexto velho
  await flow.runReferralSteps({ now: new Date(noite.getTime() + 2 * DAY), clinicId: p.c.id, sleep: noSleep });
  assert.equal(posts.length, 0);
  assert.equal((await ledgerOf(p.patient.id, "indicacao"))[0].state, "expired");
  // reinicio: o agradecimento NAO e reenviado (so existe um) e nao ha segundo convite
  assert.equal(await prisma.message.count({ where: { conversationId: p.conv.id, role: "assistant", authorName: null } }), 1);
  assert.ok(fora);
});

test("falhas na etapa do convite: provedor fora do ar tenta de novo com intervalo; timeout nao reenvia; veto da revisao e temporario; a falha NAO repete a etapa anterior", async () => {
  reset();
  const a = await pronto("Alice Falha");
  const t = new Date(a.survey.answeredAt.getTime() + 90 * 60_000);
  uazapiMode = "http500";
  await flow.runReferralSteps({ now: t, clinicId: a.c.id, sleep: noSleep });
  assert.equal(posts.length, 0);
  assert.deepEqual((await ledgerOf(a.patient.id, "indicacao")).map((r) => [r.state, r.layer]), [["failed", "envio"]]);
  uazapiMode = "ok";
  await flow.runReferralSteps({ now: new Date(t.getTime() + 20 * 60_000), clinicId: a.c.id, sleep: noSleep });
  assert.equal(posts.length, 1);
  assert.equal((await ledgerOf(a.patient.id, "indicacao"))[0].state, "sent");
  assert.equal(await prisma.satisfactionSurvey.count({ where: { patientId: a.patient.id } }), 1, "a nota nao foi gravada de novo");

  const b = await pronto("Bruna Timeout");
  uazapiMode = "timeout";
  await flow.runReferralSteps({ now: new Date(b.survey.answeredAt.getTime() + 90 * 60_000), clinicId: b.c.id, sleep: noSleep });
  assert.equal((await ledgerOf(b.patient.id, "indicacao"))[0].state, "unconfirmed");
  uazapiMode = "ok";
  const antes = posts.length;
  await flow.runReferralSteps({ now: new Date(b.survey.answeredAt.getTime() + 4 * HOUR), clinicId: b.c.id, sleep: noSleep });
  assert.equal(posts.length, antes, "nunca reenvia as cegas");

  reset();
  process.env.AI_SEND_REVIEW = "on";
  const c = await pronto("Clara Veto");
  reviewDecision = { decisao: "nao_enviar", confianca: "alta", motivo: "ela esta de luto" };
  await flow.runReferralSteps({ now: new Date(c.survey.answeredAt.getTime() + 90 * 60_000), clinicId: c.c.id, sleep: noSleep });
  assert.equal(posts.length, 0);
  assert.deepEqual((await ledgerOf(c.patient.id, "indicacao")).map((r) => [r.state, r.layer, r.temporary]), [["vetoed", "revisao_envio", true]]);
});

test("o convite nao se repete para a mesma pessoa em 90 dias", async () => {
  reset();
  const a = await pronto("Dani Repete");
  await flow.runReferralSteps({ now: new Date(a.survey.answeredAt.getTime() + 90 * 60_000), clinicId: a.c.id, sleep: noSleep });
  assert.equal(posts.length, 1);
  // outra pesquisa (30 dias depois, nota alta de novo) para a mesma pessoa
  const s2 = await prisma.satisfactionSurvey.create({ data: { clinicId: a.c.id, patientId: a.patient.id, askedAt: new Date(Date.now() - HOUR), answeredAt: new Date(), score: 10, band: "positiva", linkState: "enviado" } });
  await prisma.message.create({ data: { conversationId: a.conv.id, role: "assistant", content: "Que bom saber, Dani!", createdAt: new Date(s2.answeredAt.getTime() + 1000), deliveryStatus: "sent" } });
  await prisma.followUpDispatch.create({ data: { clinicId: a.c.id, patientId: a.patient.id, flow: "indicacao", step: 1, cycleKey: s2.id, state: "deferred", attempt: 0, dueAt: new Date(s2.answeredAt.getTime() + 30 * 60_000), reevaluateAt: new Date(s2.answeredAt.getTime() + 30 * 60_000) } });
  await flow.runReferralSteps({ now: new Date(s2.answeredAt.getTime() + 2 * HOUR), clinicId: a.c.id, sleep: noSleep });
  assert.equal(posts.length, 1);
  assert.match((await prisma.followUpDispatch.findFirst({ where: { cycleKey: s2.id } })).reason, /ja enviado nos ultimos 90 dias/);
});

// ================================================================ 6) FLUXO INTEGRADO + DIAGNOSTICO

test("INTEGRADO: atendimento elegivel -> pesquisa -> nota -> agradecimento + link de TESTE -> convite SEPARADO -> tudo persistido e diagnosticavel", async () => {
  reset();
  const c = use(await mkClinic("Clinica Integrada Pesquisa", { ...confirmedLink() }));
  await prisma.resumeFlowConfig.create({ data: { clinicId: c.id, flow: "indicacao", enabled: true, message: link.DEFAULT_REFERRAL_TEXT, delayMinutes: 20 } });
  const p = await patientOf(c, "Julia Integrada");
  const a = await done(c, p, sp("2026-10-15T09:00"));

  // 1) a pesquisa sai (uma vez) e fica no chat
  await runAt("2026-10-15T13:00");
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /De 0 a 10/);
  const survey = (await surveysOf(p.id))[0];
  assert.equal(survey.appointmentId, a.id);
  const conv = await prisma.conversation.findFirst({ where: { patientId: p.id } });
  assert.ok(await prisma.message.findFirst({ where: { conversationId: conv.id, authorName: "Pesquisa de satisfação" } }));

  // 2) ela responde 10: o codigo grava e a Alice agradece com o link
  await prisma.message.create({ data: { conversationId: conv.id, role: "user", content: "10", createdAt: new Date(Date.now() - 30_000) } });
  await prisma.satisfactionSurvey.update({ where: { id: survey.id }, data: { askedAt: new Date(Date.now() - 3 * HOUR) } }); // o "agora" da conversa e o relogio real
  await prisma.message.updateMany({ where: { conversationId: conv.id, authorName: "Pesquisa de satisfação" }, data: { createdAt: new Date(Date.now() - 3 * HOUR) } });
  const thanks = await generateReply(conv.id);
  assert.match(thanks, new RegExp(`Se puder, deixa a sua avaliação no Google.*${TEST_LINK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  await deliverAliceReply(c.id, p.phone, conv.id, thanks);
  assert.ok(posts.some((x) => x.text === thanks), "o agradecimento foi entregue");
  assert.equal((await prisma.message.findFirst({ where: { conversationId: conv.id, content: thanks } })).deliveryStatus, "sent");
  const answered = (await surveysOf(p.id))[0];
  assert.deepEqual([answered.score, answered.band, answered.linkState, answered.reviewLinkSent], [10, "positiva", "enviado", true]);

  // 3) o convite sai DEPOIS, em outra mensagem
  const t = new Date(answered.answeredAt.getTime() + 60 * 60_000);
  const antes = posts.length;
  await flow.runReferralSteps({ now: t, clinicId: c.id, sleep: noSleep });
  assert.equal(posts.length, antes + 1);
  const invite = posts.at(-1).text;
  assert.notEqual(invite, thanks);
  assert.equal(invite, link.DEFAULT_REFERRAL_TEXT.replace("{unidade}", c.name));
  assert.doesNotMatch(invite, /https?:/);

  // 4) persistencia: etapas, ordem, versao
  const steps = await prisma.followUpDispatch.findMany({ where: { patientId: p.id }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(steps.map((s) => [s.flow, s.state]), [["pesquisa", "sent"], ["indicacao", "sent"]]);
  assert.ok(steps.every((s) => /^2026-10-1/.test(s.version)));

  // 5) diagnostico da pessoa
  const trail = await flow.surveyTrail(c.id, p.id, t);
  assert.equal(trail.frequencia.podeReceberAgora, false);
  assert.equal(trail.frequencia.diasEntrePesquisas, 15);
  assert.equal(trail.pesquisas[0].score, 10);
  assert.equal(trail.pesquisas[0].atendimentoDeOrigem.id, a.id);
  assert.deepEqual(trail.etapas.map((e) => [e.flow, e.state]).sort(), [["indicacao", "sent"], ["pesquisa", "sent"]]);
  assert.equal(trail.linkDoGoogle.situacao, "pode ser enviado");
  assert.equal(trail.linkDoGoogle.confirmadoPor, "teste");
  assert.match(trail.versao, /^2026-10-1/);
  const jobs = await diagnoseJobs(c.id, sp("2026-10-15T00:00"), sp("2026-10-16T00:00"), sp("2026-10-15T13:10"));
  assert.ok(jobs.find((j) => j.job === "pesquisa-satisfacao" && j.sent === 1));
});

test("diagnostico: ausencia de configuracao, bloqueio por frequencia e falha tecnica aparecem como coisas DIFERENTES", async () => {
  reset();
  const semLink = await mkClinic("Clinica Diag Sem Link", { googleReviewUrl: null });
  const t1 = await flow.surveyTrail(semLink.id, (await patientOf(semLink, "X")).id);
  assert.match(t1.linkDoGoogle.situacao, /ausente/);
  assert.equal(t1.linkDoGoogle.cadastrado, false);
  const pend = await mkClinic("Clinica Diag Pendente", { googleReviewUrl: TEST_LINK });
  const t2 = await flow.surveyTrail(pend.id, (await patientOf(pend, "Y")).id);
  assert.match(t2.linkDoGoogle.situacao, /nao_confirmado/);
  const c = use(await mkClinic("Clinica Diag Frequencia"));
  const p = await patientOf(c, "Z");
  await prisma.satisfactionSurvey.create({ data: { clinicId: c.id, patientId: p.id, askedAt: sp("2026-10-10T10:00") } });
  const t3 = await flow.surveyTrail(c.id, p.id, sp("2026-10-15T10:00"));
  assert.equal(t3.frequencia.podeReceberAgora, false);
  assert.equal(t3.frequencia.proximaPermitidaEm.toISOString(), sp("2026-10-25T10:00").toISOString());
  await done(c, p, sp("2026-10-15T09:00"));
  await runAt("2026-10-15T13:00");
  const bloqueio = (await ledgerOf(p.id))[0];
  assert.deepEqual([bloqueio.state, bloqueio.layer], ["skipped", "politica"]);
  uazapiMode = "http500";
  const q = await patientOf(c, "W");
  await done(c, q, sp("2026-10-15T09:00"));
  await runAt("2026-10-15T14:00");
  const falha = (await ledgerOf(q.id))[0];
  assert.deepEqual([falha.state, falha.layer], ["failed", "envio"]);
});

test("trilha de rotas e jobs: o job do convite esta registrado e o diagnostico lista pesquisa e convite", () => {
  const server = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.match(server, /startReferralJob\(\)/);
  const runs = fs.readFileSync(new URL("../src/crm/automationRuns.ts", import.meta.url), "utf8");
  assert.match(runs, /job: "pesquisa-satisfacao"/);
  assert.match(runs, /job: "convite-indicacao"/);
});
