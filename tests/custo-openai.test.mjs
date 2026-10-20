// CUSTO DA OPENAI: medicao completa e persistente, preco por modelo, contexto mais enxuto, reescritas consolidadas, segunda leitura seletiva, memoria sem repeticao e tratamento de
// saldo esgotado / erros transitorios. Banco de verdade (SQLite temporario) e OpenAI SIMULADA por um fetch falso: nenhuma chamada paga e nenhuma mensagem real.
// ATENCAO: respostas simuladas provam o CAMINHO (quantas chamadas, o que vai no contexto, o que e medido), nao a qualidade do modelo real. Tokens do simulador = caracteres/4 (estimativa).
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dbFile = path.join(os.tmpdir(), `alice-custo-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY = "test-key";
process.env.AI_SEND_REVIEW = "off";
process.env.AI_BRIEFING = "off";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

// ----------------------------------------------------------------- OpenAI simulada
const calls = []; // { kind: main | rewrite | reading | judge | other, body }
const uazapiPosts = []; // envios de WhatsApp feitos (aviso interno)
let mainScript = []; // respostas do modelo principal, na ordem
let rewriteText = "Resposta reescrita sem repetir o que ja foi dito e com a informacao nova pedida.";
let failure = null; // { status, code, type, message, times } -> as proximas chamadas falham assim
let responseModel = "gpt-4o-mini-2024-07-18";
const jsonRes = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const chars = (messages) => JSON.stringify(messages).length;
function completion(message, finish, messages) {
  const promptTokens = Math.ceil(chars(messages) / 4);
  return { id: "chatcmpl-test", object: "chat.completion", created: Math.floor(Date.now() / 1000), model: responseModel, choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: promptTokens, completion_tokens: 30, total_tokens: promptTokens + 30, prompt_tokens_details: { cached_tokens: 0 } } };
}
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.includes("openai.com")) {
    const body = JSON.parse(init.body);
    const system = String(body.messages?.[0]?.content ?? "");
    const kind = body.tools ? "main" : /Voce reescreve/.test(system) ? "rewrite" : /Voce le a conversa de WhatsApp/.test(system) ? "reading" : /RECONTATO automatico/.test(system) ? "judge" : "other";
    calls.push({ kind, body });
    if (failure && failure.times > 0) {
      failure.times--;
      return jsonRes(failure.status, { error: { message: failure.message ?? "falha simulada", type: failure.type ?? null, code: failure.code ?? null } });
    }
    if (kind === "main") {
      const next = mainScript.shift();
      if (!next) throw new Error("o roteiro do modelo acabou (chamada principal a mais do que o esperado)");
      const message = next.tool
        ? { role: "assistant", content: null, tool_calls: [{ id: `call_${Math.random().toString(36).slice(2)}`, type: "function", function: { name: next.tool.name, arguments: JSON.stringify(next.tool.args) } }] }
        : { role: "assistant", content: next.content };
      return jsonRes(200, completion(message, next.tool ? "tool_calls" : "stop", body.messages));
    }
    if (kind === "rewrite") return jsonRes(200, completion({ role: "assistant", content: rewriteText }, "stop", body.messages));
    if (kind === "reading") return jsonRes(200, completion({ role: "assistant", content: JSON.stringify({ objetivo: "saber mais", momento: "interesse", perguntas_em_aberto: [], ja_dito: [], evitar: [], proximo_passo: "responder a duvida e perguntar o que ela quer melhorar" }) }, "stop", body.messages));
    if (kind === "judge") return jsonRes(200, completion({ role: "assistant", content: JSON.stringify({ recontact: true, reason: "pediu informacao e sumiu", categoria: "outro" }) }, "stop", body.messages));
    return jsonRes(200, completion({ role: "assistant", content: "{}" }, "stop", body.messages));
  }
  if (u.hostname.endsWith("uazapi.com") && u.pathname === "/send/text") uazapiPosts.push({ token: init.headers?.token, number: JSON.parse(init.body).number, text: JSON.parse(init.body).text });
  return jsonRes(200, { id: "msg", data: {} }); // UAZAPI e outros: aceita
};

const { prisma } = await import("../dist/db/client.js");
const pricing = await import("../dist/ai/pricing.js");
const usage = await import("../dist/ai/usageStats.js");
const oc = await import("../dist/ai/openaiCall.js");
const sel = await import("../dist/ai/contextSelect.js");
const analysis = await import("../dist/ai/conversationAnalysis.js");
const { generateReply, consolidatedRewritePrompt } = await import("../dist/ai/alice.js");
const { crmProfileText } = await import("../dist/ai/leadBriefing.js");

// O CENARIO (clinica, FAQs, modelos, roteiros) e semeado ANTES de registrar qualquer teste: com o semeio no meio do arquivo, sob carga as primeiras provas terminavam antes dele,
// o gancho de limpeza apagava o banco temporario e o semeio falhava ("table does not exist"). Falha de teste, nao do produto.
// ----------------------------------------------------------------- cenarios de ponta a ponta
const TZ = "America/Sao_Paulo";
const HOUR = 3_600_000;
const clinic = await prisma.clinic.create({
  data: { name: "Clinica Custo", whatsappPhone: "5511900000774", timezone: TZ, plan: "prime", workDays: "0,1,2,3,4,5,6", workStartHour: 7, workEndHour: 22, closedOnHolidays: false, silentHandoff: true,
    uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: "tok-custo", aliceActive: true },
});
const hipro = await prisma.procedure.create({ data: { clinicId: clinic.id, name: "Hipro", durationMin: 30, description: "Tecnologia para firmeza da pele." } });
await prisma.procedure.create({ data: { clinicId: clinic.id, name: "Avaliação Estética", durationMin: 30 } });
const longo = (t) => `${t} ${"Informacao detalhada cadastrada pela clinica para este assunto, com orientacoes completas e observacoes importantes. ".repeat(2)}`;
for (const f of [
  ["Tem estacionamento?", "Temos estacionamento conveniado ao lado.", "onde estaciono\ntem vaga para carro"], ["Quais formas de pagamento?", "Aceitamos cartao de credito, debito e pix; parcelamos em ate 6x.", "aceita cartao\naceitam pix\nparcelamento"],
  ["Posso ir acompanhada?", "Pode sim, uma pessoa acompanha.", "levar acompanhante"], ["Qual a idade minima?", "A partir de 18 anos.", "menor de idade"], ["Gestante pode fazer?", "Nao indicamos na gestacao.", "gravida\namamentando"],
  ["Quanto tempo dura o atendimento?", "Em media 40 minutos.", "duracao da sessao"], ["Como cancelar ou remarcar?", "Avise com 24h de antecedencia.", "desmarcar horario"], ["Tem wifi na clinica?", "Sim, a senha esta na recepcao: LISBOA2026.", "senha do wifi"],
  ["Qual o endereco?", "Av. Indico, 294, sala 5.", "como chego\nonde fica"], ["Aceita convenio?", "Nao trabalhamos com convenios.", "plano de saude"], ["Precisa de jejum?", "Nao ha jejum.", "preciso comer antes"], ["Atende aos domingos?", "Atendemos de segunda a sabado.", "domingo"],
]) await prisma.clinicFaq.create({ data: { clinicId: clinic.id, question: f[0], answer: longo(f[1]), alternates: f[2] } });
for (const t of ["Boas-vindas", "Pos-procedimento", "Aviso de atraso", "Promocao do mes", "Indicacao de amiga", "Lembrete de retorno", "Agradecimento"]) await prisma.messageTemplate.create({ data: { clinicId: clinic.id, name: t, whenToUse: `quando for o caso de ${t.toLowerCase()}`, body: longo(`Texto da mensagem ${t}.`), mode: "adapt" } });
for (const [name, scriptType, trig] of [["Primeiro atendimento", "primeiro_atendimento", "contato novo"], ["Agendamento", "agendamento", "quer marcar"], ["Preco", "preco", "pergunta de valor"], ["Objecoes", "objecoes", "acha caro ou tem medo"], ["Remarcacao", "remarcacao", "quer trocar o horario"], ["Procedimento", "procedimento", "duvida sobre um procedimento"]])
  await prisma.playbook.create({ data: { clinicId: clinic.id, name, scriptType, triggerText: trig, goal: `Objetivo do roteiro ${name}`, steps: `Passo um do roteiro ${name}\nPasso dois do roteiro ${name}\nPasso tres do roteiro ${name}` } });

function amanha(h, m = 0) {
  const d = new Date(Date.now() + 24 * HOUR);
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const [y, mo, da] = iso.split("-").map(Number);
  return { date: iso, instant: new Date(Date.UTC(y, mo - 1, da, h + 3, m)) };
}
let seq = 0;
async function cenario(nome, mensagens, { appt = null, humano = false } = {}) {
  seq++;
  const patient = await prisma.patient.create({ data: { clinicId: clinic.id, name: nome, phone: `551196666${String(1000 + seq)}` } });
  const conv = await prisma.conversation.create({ data: { patientId: patient.id, humanTakeover: humano } });
  let t = Date.now() - mensagens.length * 60_000;
  for (const [role, content, authorName] of mensagens) await prisma.message.create({ data: { conversationId: conv.id, role, content, authorName: authorName ?? null, createdAt: new Date((t += 60_000)) } });
  const appointment = appt ? await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: patient.id, procedureId: appt.procedureId, scheduledAt: appt.when, source: "presencial" } }) : null;
  return { patient, conv, appointment };
}
const systemOf = (call) => call.body.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");

test.after(async () => {
  await usage.flushUsage();
  await (await import("../dist/jobs/background.js")).drainBackground();
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* temporario */ } }
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const withEnv = async (env, fn) => {
  const old = {};
  for (const [k, v] of Object.entries(env)) { old[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};

// ===================================================================== 1) PRECO POR MODELO
test("PRECO: cada modelo tem o seu; snapshot datado acha o preco base; gpt-4o nunca vira gpt-4o-mini; desconhecido = null (nunca zero, nunca preco de outro)", () => {
  const mini = pricing.estimateUsd("gpt-4o-mini", { input: 1_000_000, cached: 0, output: 1_000_000 });
  assert.equal(mini, 0.15 + 0.6);
  const grande = pricing.estimateUsd("gpt-4o", { input: 1_000_000, cached: 0, output: 1_000_000 });
  assert.equal(grande, 2.5 + 10);
  assert.notEqual(mini, grande);
  assert.equal(pricing.estimateUsd("gpt-4o-mini-2024-07-18", { input: 1000, cached: 0, output: 0 }), pricing.estimateUsd("gpt-4o-mini", { input: 1000, cached: 0, output: 0 }), "o sufixo de data do snapshot e ignorado");
  assert.equal(pricing.priceFor("gpt-4o-2024-08-06").key, "gpt-4o");
  // cache: a parte cacheada da entrada custa o preco de cache, o resto o de entrada
  assert.equal(pricing.estimateUsd("gpt-4o-mini", { input: 1_000_000, cached: 400_000, output: 0 }), (600_000 * 0.15 + 400_000 * 0.075) / 1_000_000);
  // modelo sem preco
  assert.equal(pricing.estimateUsd("modelo-que-nao-existe", { input: 1000, cached: 0, output: 1000 }), null);
  assert.equal(pricing.estimateUsd(null, { input: 1000, cached: 0, output: 1000 }), null);
  assert.equal(pricing.estimateUsd("gpt-4o-mini-extra", { input: 1000, cached: 0, output: 0 }), null, "nao casa por prefixo");
  // todo preco padrao tem fonte e data
  for (const [m, p] of Object.entries(pricing.DEFAULT_PRICES)) { assert.match(p.source, /^https:\/\//, m); assert.match(p.checkedAt, /^\d{4}-\d{2}-\d{2}$/, m); assert.ok(p.input > 0 && p.output > 0, m); }
});

test("PRECO configuravel: OPENAI_PRICES_JSON acrescenta/sobrescreve por modelo, item invalido e ignorado sem derrubar nada; preco zero nao vale", async () => {
  await withEnv({ OPENAI_PRICES_JSON: JSON.stringify({ "modelo-novo-x": { input: 1, cachedInput: 0.5, output: 4, source: "fatura de teste", checkedAt: "2026-10-19" }, "gpt-4o-mini": { input: 0.2, output: 0.8 }, ruim: { input: 0, output: 1 }, lixo: "x" }) }, () => {
    assert.equal(pricing.estimateUsd("modelo-novo-x", { input: 1_000_000, cached: 0, output: 0 }), 1);
    assert.equal(pricing.priceFor("modelo-novo-x").price.source, "fatura de teste");
    assert.equal(pricing.estimateUsd("gpt-4o-mini", { input: 1_000_000, cached: 0, output: 0 }), 0.2, "o operador sobrescreve o padrao");
    assert.equal(pricing.priceFor("ruim"), null, "preco zero e recusado");
    assert.equal(pricing.priceFor("lixo"), null);
  });
  await withEnv({ OPENAI_PRICES_JSON: "{isto nao e json" }, () => assert.equal(pricing.estimateUsd("gpt-4o-mini", { input: 1_000_000, cached: 0, output: 0 }), 0.15, "JSON quebrado: padrao intacto"));
  assert.equal(pricing.estimateUsd("modelo-novo-x", { input: 1000, cached: 0, output: 0 }), null, "sem a configuracao o modelo volta a ser desconhecido");
});

// ===================================================================== 2) MEDICAO: tentativas, tokens uma vez so, persistencia, agregacao
const fakeClient = (impl) => ({ chat: { completions: { create: async (params) => impl(params) } } });
const okResponse = (over = {}) => ({ id: "x", model: "gpt-4o-mini-2024-07-18", choices: [{ index: 0, message: { role: "assistant", content: "oi" }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 400 } }, ...over });
const apiError = (status, extra = {}) => Object.assign(new Error(extra.message ?? `HTTP ${status}`), { status, ...extra });

test("MEDICAO: cada chamada registra finalidade, modelo DEVOLVIDO, tokens (entrada/cache/saida), duracao, resultado, motivo e o atendimento; persiste em lote sem conteudo de conversa", async () => {
  oc.resetOpenAiHealthForTests();
  const clinic = await prisma.clinic.create({ data: { name: "Clinica Medicao", whatsappPhone: "5511900000771" } });
  const traceId = "trace-medicao-1";
  await oc.runWithAiContext({ clinicId: clinic.id, conversationId: "conv-1", traceId }, async () => {
    const client = fakeClient(async () => okResponse());
    await oc.trackedChat(client, { model: "gpt-4o-mini", messages: [{ role: "system", content: "SEGREDO-DE-CONVERSA numero 5511999990000" }] }, { purpose: "conversa_alice", reason: "answer" });
    await oc.trackedChat(client, { model: "gpt-4o-mini", messages: [{ role: "user", content: "x" }] }, { purpose: "conversa_alice", reason: "tool_result" });
  });
  const rep = await usage.traceReport(traceId);
  assert.equal(rep.attempts, 2);
  assert.deepEqual([rep.answer, rep.tool, rep.correction, rep.retry], [1, 1, 0, 0]);
  const row = rep.rows[0];
  assert.deepEqual([row.clinicId, row.conversationId, row.traceId, row.purpose], [clinic.id, "conv-1", traceId, "conversa_alice"]);
  assert.deepEqual([row.requestedModel, row.model], ["gpt-4o-mini", "gpt-4o-mini-2024-07-18"], "guarda o modelo que a API devolveu, nao so o pedido");
  assert.deepEqual([row.inputTokens, row.cachedTokens, row.outputTokens, row.outcome], [1000, 400, 50, "ok"]);
  assert.ok(row.durationMs >= 0);
  // nada de conteudo/credencial/dado pessoal nas colunas
  assert.ok(!JSON.stringify(rep.rows).includes("SEGREDO-DE-CONVERSA") && !JSON.stringify(rep.rows).includes("5511999990000"));
  const cols = Object.keys(row).sort().join(",");
  assert.equal(cols, "at,attempt,attemptReason,cachedTokens,clinicId,conversationId,durationMs,errorKind,id,inputTokens,model,outcome,outputTokens,purpose,requestedModel,traceId,usageState");
});

test("MEDICAO: nova tentativa por limite temporario nao duplica tokens (a que falhou tem 0); saldo esgotado e credencial invalida NUNCA sao repetidos; timeout e erro de modelo tambem nao", async () => {
  oc.resetOpenAiHealthForTests();
  await withEnv({ AI_APP_RETRIES: "1" }, async () => {
    // 429 de LIMITE (rate limit) com Retry-After curto: tenta de novo uma vez e tem sucesso
    let n = 0;
    const flaky = fakeClient(async () => { n++; if (n === 1) throw apiError(429, { code: "rate_limit_exceeded", type: "requests", message: "Rate limit reached for requests", headers: { "retry-after": "0.01" } }); return okResponse(); });
    await oc.runWithAiContext({ traceId: "trace-retry" }, () => oc.trackedChat(flaky, { model: "gpt-4o-mini", messages: [] }, { purpose: "conversa_alice", reason: "answer" }));
    assert.equal(n, 2);
    const rep = await usage.traceReport("trace-retry");
    assert.deepEqual(rep.rows.map((r) => [r.outcome, r.errorKind, r.attemptReason, r.attempt, r.inputTokens]), [["error", "rate_limit", "answer", 1, 0], ["ok", null, "retry:answer", 2, 1000]], "tokens contados uma vez so");
    assert.equal(rep.input, 1000);
    assert.equal(rep.retry, 1);

    // saldo esgotado: UMA chamada, nenhuma nova tentativa, e bloqueia as proximas
    let q = 0;
    const semSaldo = fakeClient(async () => { q++; throw apiError(429, { code: "insufficient_quota", type: "insufficient_quota", message: "You exceeded your current quota" }); });
    await assert.rejects(() => oc.trackedChat(semSaldo, { model: "gpt-4o-mini", messages: [] }, { purpose: "conversa_alice" }), (e) => e.aiKind === "quota");
    assert.equal(q, 1, "saldo esgotado nao e repetido");
    oc.resetOpenAiHealthForTests();
    // timeout e modelo incompativel: sem nova tentativa
    let t = 0;
    await assert.rejects(() => oc.trackedChat(fakeClient(async () => { t++; throw Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" }); }), { model: "m", messages: [] }, { purpose: "x" }), (e) => e.aiKind === "timeout");
    assert.equal(t, 1, "timeout nao e repetido (a chamada pode ter sido cobrada)");
    let m = 0;
    await assert.rejects(() => oc.trackedChat(fakeClient(async () => { m++; throw apiError(404, { code: "model_not_found", message: "The model does not exist" }); }), { model: "m", messages: [] }, { purpose: "x" }), (e) => e.aiKind === "model");
    assert.equal(m, 1);
    // indisponibilidade 503: repete uma vez
    let s = 0;
    await oc.trackedChat(fakeClient(async () => { s++; if (s === 1) throw apiError(503, { code: "server_is_overloaded", headers: { "retry-after": "0.01" } }); return okResponse(); }), { model: "m", messages: [] }, { purpose: "x" });
    assert.equal(s, 2);
  });
});

test("SALDO ESGOTADO / CREDENCIAL INVALIDA: chamadas pausadas por intervalo controlado (nenhuma automacao bate de novo), sinalizacao visivel UMA vez, uma chamada de teste depois do intervalo e recuperacao automatica", async () => {
  oc.resetOpenAiHealthForTests();
  const clinic = await prisma.clinic.create({ data: { name: "Clinica Saldo", whatsappPhone: "5511900000772" } });
  await withEnv({ AI_BLOCK_COOLDOWN_MS: "600000" }, async () => {
    let calls1 = 0; let mode = "sem_saldo";
    const client = fakeClient(async () => {
      calls1++;
      if (mode === "sem_saldo") throw apiError(429, { code: "insufficient_quota", type: "insufficient_quota", message: "You exceeded your current quota, please check your plan and billing details." });
      if (mode === "chave") throw apiError(401, { code: "invalid_api_key", message: "Incorrect API key provided" });
      return okResponse();
    });
    const go = () => oc.runWithAiContext({ clinicId: clinic.id }, () => oc.trackedChat(client, { model: "gpt-4o-mini", messages: [] }, { purpose: "juiz_recontato" }));
    await assert.rejects(go, (e) => e.aiKind === "quota");
    assert.equal(oc.openAiHealth().state, "sem_saldo");
    // varias automacoes tentam na sequencia: nenhuma chega a OpenAI
    for (let i = 0; i < 5; i++) await assert.rejects(go, (e) => oc.isOpenAiBlocked(e) && e.status === 429 && e.code === "insufficient_quota");
    assert.equal(calls1, 1, "uma unica chamada real; as demais foram barradas no intervalo");
    assert.equal(oc.openAiHealth().callsSkipped, 5);
    // sinalizacao visivel: Diario da clinica, uma vez (nao 6)
    let diario = 0;
    for (let i = 0; i < 30 && diario < 1; i++) { diario = await prisma.activityLog.count({ where: { clinicId: clinic.id, type: "openai_blocked" } }); if (!diario) await wait(100); }
    assert.equal(diario, 1);
    // depois do intervalo, UMA chamada de teste; ainda sem saldo -> continua bloqueado e nao avisa de novo
    oc.expireOpenAiBlockForTests(); // o intervalo venceu
    await assert.rejects(go, (e) => e.aiKind === "quota");
    assert.equal(calls1, 2);
    await assert.rejects(go, (e) => oc.isOpenAiBlocked(e));
    assert.equal(calls1, 2, "durante o novo intervalo nao chama");
    assert.equal(await prisma.activityLog.count({ where: { clinicId: clinic.id, type: "openai_blocked" } }), 1, "no maximo 1 aviso por hora por clinica");
    // creditos recarregados: o teste seguinte passa e tudo normaliza sozinho
    oc.expireOpenAiBlockForTests();
    mode = "ok";
    await go();
    assert.equal(oc.openAiHealth().state, "ok");
    await go();
    assert.equal(calls1, 4);
    // credencial invalida: mesmo tratamento, estado proprio
    oc.resetOpenAiHealthForTests();
    mode = "chave";
    await assert.rejects(go, (e) => e.aiKind === "auth");
    assert.equal(oc.openAiHealth().state, "credencial_invalida");
  });
  oc.resetOpenAiHealthForTests();
});

test("FALHA DA TELEMETRIA nunca interrompe o atendimento: banco recusando a gravacao nao derruba a chamada nem o flush", async () => {
  oc.resetOpenAiHealthForTests();
  const original = prisma.aiCall.createMany;
  prisma.aiCall.createMany = async () => { throw new Error("banco indisponivel (simulado)"); };
  try {
    const out = await oc.trackedChat(fakeClient(async () => okResponse()), { model: "gpt-4o-mini", messages: [] }, { purpose: "teste_telemetria" });
    assert.equal(out.choices[0].message.content, "oi");
    await usage.flushUsage(); // nao lanca
  } finally { prisma.aiCall.createMany = original; usage.resetUsageForTests(); }
});

test("RETENCAO: linhas antigas sao SOMADAS no agregado diario e apagadas (sem contar duas vezes); relatorio persistido soma agregado + recente; modelo sem preco = 'custo nao calculado'", async () => {
  const clinic = await prisma.clinic.create({ data: { name: "Clinica Retencao", whatsappPhone: "5511900000773" } });
  const velho = new Date(Date.now() - 20 * 24 * 3_600_000);
  const mk = (over) => ({ at: velho, clinicId: clinic.id, purpose: "conversa_alice", model: "gpt-4o-mini", inputTokens: 1000, cachedTokens: 0, outputTokens: 100, durationMs: 500, outcome: "ok", attempt: 1, ...over });
  await prisma.aiCall.createMany({ data: [mk({}), mk({}), mk({ outcome: "error", inputTokens: 0, outputTokens: 0, errorKind: "timeout" }), mk({ model: "modelo-sem-preco-z", inputTokens: 500 }), mk({ at: new Date(), model: "gpt-4o-mini", inputTokens: 200, outputTokens: 20 })] });
  const r1 = await usage.pruneAiUsage();
  assert.equal(r1.rolledUp, 4, "so as 4 linhas antigas");
  const r2 = await usage.pruneAiUsage();
  assert.equal(r2.rolledUp, 0, "segunda execucao nao soma de novo");
  assert.equal(await prisma.aiCall.count({ where: { clinicId: clinic.id } }), 1, "a linha recente fica");
  const dia = velho.toISOString().slice(0, 10);
  const mini = await prisma.aiUsageDaily.findUnique({ where: { day_clinicId_purpose_model: { day: dia, clinicId: clinic.id, purpose: "conversa_alice", model: "gpt-4o-mini" } } });
  assert.deepEqual([mini.calls, mini.okCalls, mini.errorCalls, mini.inputTokens, mini.outputTokens], [3, 2, 1, 2000, 200]);
  const rel = await usage.persistedReport({ days: 30, clinicId: clinic.id });
  const alice = rel.purposes.find((p) => p.purpose === "conversa_alice");
  assert.equal(alice.calls, 5);
  assert.equal(alice.input, 2000 + 500 + 200);
  const semPreco = alice.models.find((m) => m.model === "modelo-sem-preco-z");
  assert.equal(semPreco.estimatedUsd, null, "nunca zero");
  assert.match(alice.costNote, /custo nao calculado.*modelo-sem-preco-z/);
  assert.equal(alice.unpricedCalls, 1);
  const so = pricing.estimateUsd("gpt-4o-mini", { input: 2200, cached: 0, output: 220 });
  assert.equal(alice.estimatedUsd, Number(so.toFixed(6)), "o total estimado so soma o que tem preco (nao inclui o modelo desconhecido)");
  assert.equal(rel.billedUsd, null, "cobranca real nao e inventada");
  assert.match(rel.note, /ESTIMADO/);
});

// ===================================================================== 3) CONTEXTO PERTINENTE
const faq = (id, question, alternates = "") => ({ id, title: question, aux: alternates });
const FAQS = [
  faq("1", "Tem estacionamento?", "onde estaciono\ntem vaga para carro"), faq("2", "Quais formas de pagamento?", "aceita cartao\naceitam pix\nparcelamento"), faq("3", "Posso ir acompanhada?", "levar acompanhante"),
  faq("4", "Qual a idade minima?", "menor de idade"), faq("5", "Gestante pode fazer?", "gravida\namamentando"), faq("6", "Quanto tempo dura o atendimento?", "duracao da sessao"),
  faq("7", "Como cancelar ou remarcar?", "desmarcar horario"), faq("8", "Tem wifi na clinica?", "senha do wifi"), faq("9", "Qual o endereco?", "como chego\nonde fica"),
];
test("SELECAO: so entram os itens pertinentes (palavras da pessoa x titulo/alternativas); poucos itens entram todos; o resto fica no indice; nada some por silencio", () => {
  const q = sel.queryFromMessages(["oi, bom dia", "voces aceitam cartao de credito?"]);
  const r = sel.selectContent("faq", FAQS, q);
  assert.deepEqual(r.selected.map((x) => x.id), ["2"], "so a de pagamento");
  assert.equal(r.rest.length, 8);
  assert.ok(Object.values(r.why).every((w) => /palavras_em_comum/.test(w)));
  // menos de 5 itens: entram todos
  const poucos = sel.selectContent("faq", FAQS.slice(0, 4), q);
  assert.equal(poucos.selected.length, 4);
  // nada em comum: nenhum item (o indice + a ferramenta cobrem)
  assert.equal(sel.selectContent("faq", FAQS, sel.queryFromMessages(["quero saber sobre botox"])).selected.length, 0);
  // a mensagem mais NOVA pesa mais que a antiga
  const novo = sel.selectContent("faq", FAQS, sel.queryFromMessages(["onde estaciono", "aceita pix?"]));
  assert.equal(novo.selected[0].id, "2");
  // indice com os titulos dos nao selecionados e aviso de que a ausencia nao significa que nao existe
  const idx = sel.renderIndex([{ label: "FAQ", titles: r.rest.map((x) => x.title) }]);
  assert.match(idx, /consultar_conteudo_da_clinica/);
  assert.match(idx, /NAO significa que a clinica nao faz ou nao tem/);
  assert.match(idx, /Tem wifi na clinica\?/);
  // a ferramenta de consulta acha o que ficou de fora
  assert.equal(sel.searchContent(FAQS, "senha do wifi")[0].id, "8");
  assert.deepEqual(sel.searchContent(FAQS, "tatuagem"), []);
  // roteiros: a SITUACAO manda mesmo sem palavra em comum
  assert.deepEqual([...sel.forcedPlaybookTypes({ intent: "manage", firstContact: false, priceAsked: false })], ["remarcacao"]);
  assert.ok(sel.forcedPlaybookTypes({ intent: "schedule", firstContact: true, priceAsked: true }).has("primeiro_atendimento"));
  assert.ok(sel.forcedPlaybookTypes({ intent: "hesitate", firstContact: false, priceAsked: false }).has("objecoes"));
});


test("CONTEXTO: o prompt leva so o conteudo pertinente + indice dos demais + ferramenta de consulta; o inicio (estavel) e igual entre conversas; restricoes e pedido atual continuam; modo antigo manda tudo", async () => {
  calls.length = 0;
  const base = [["user", "Oi, queria saber do Hipro"], ["assistant", "Oi! O Hipro é para firmeza da pele. O que você gostaria de melhorar?"], ["user", "A flacidez no rosto"], ["assistant", "Entendi. Quer saber mais?"]];
  const a = await cenario("Contexto A", [...base, ["user", "Vocês aceitam cartão? Só consigo aos sábados de manhã"]]);
  mainScript = [{ content: "Aceitamos cartão de crédito, débito e pix, e parcelamos em até 6x. Qual sábado fica melhor pra você?" }];
  await generateReply(a.conv.id);
  const main = calls.find((c) => c.kind === "main");
  const sys = systemOf(main);
  assert.match(sys, /Aceitamos cartao de credito, debito e pix/, "o FAQ pertinente entrou");
  assert.doesNotMatch(sys, /LISBOA2026/, "o FAQ do wifi NAO entrou");
  assert.match(sys, /OUTROS ASSUNTOS CADASTRADOS/);
  assert.match(sys, /Tem wifi na clinica\?/, "mas esta no indice");
  assert.ok(main.body.tools.some((t) => t.function.name === "consultar_conteudo_da_clinica"), "a ferramenta de consulta existe quando algo ficou de fora");
  assert.match(sys, /sábados de manhã|sabados de manha/i, "o pedido atual e a restricao continuam no contexto");
  assert.match(sys, /ORDEM DE PRIORIDADE DAS REGRAS/, "hierarquia no inicio");
  // conteudo selecionado vem DEPOIS do marcador do contexto variavel
  assert.ok(sys.indexOf("=== CONTEXTO DESTA CONVERSA") < sys.indexOf("Aceitamos cartao de credito"), "conteudo variavel depois do marcador (inicio estavel para o cache)");
  // outra conversa, outro assunto: o INICIO do prompt e identico (mesma clinica), so o conteudo variavel muda
  calls.length = 0;
  const b = await cenario("Contexto B", [...base, ["user", "Tem estacionamento aí?"]]);
  mainScript = [{ content: "Temos estacionamento conveniado ao lado." }];
  await generateReply(b.conv.id);
  const sysB = systemOf(calls.find((c) => c.kind === "main"));
  const marcador = "=== CONTEXTO DESTA CONVERSA";
  assert.equal(sys.slice(0, sys.indexOf(marcador)), sysB.slice(0, sysB.indexOf(marcador)), "prefixo estavel identico entre conversas (favorece o cache)");
  assert.match(sysB, /estacionamento conveniado/);
  assert.doesNotMatch(sysB, /Aceitamos cartao/);
  // modo antigo: tudo, sem indice e sem a ferramenta
  calls.length = 0;
  await withEnv({ AI_CONTEXT_SELECT: "off" }, async () => {
    const c = await cenario("Contexto C", [...base, ["user", "Vocês aceitam cartão?"]]);
    mainScript = [{ content: "Aceitamos sim." }];
    await generateReply(c.conv.id);
  });
  const antigo = calls.find((c) => c.kind === "main");
  assert.match(systemOf(antigo), /LISBOA2026/);
  assert.doesNotMatch(systemOf(antigo), /OUTROS ASSUNTOS CADASTRADOS/);
  assert.ok(!antigo.body.tools.some((t) => t.function.name === "consultar_conteudo_da_clinica"));
});

test("CONSULTA SEGURA: o modelo busca o que ficou fora do contexto; achou -> devolve completo; nao achou -> avisa que isso NAO prova que a clinica nao faz (nunca 'nao existe')", async () => {
  calls.length = 0;
  const c = await cenario("Consulta", [["user", "Oi"], ["assistant", "Oi! Como posso ajudar?"], ["user", "Meu amigo pergunta qual é a senha do wifi da clínica quando eu for?"]]);
  mainScript = [
    { tool: { name: "consultar_conteudo_da_clinica", args: { busca: "senha do wifi", tipo: "faq" } } },
    { content: "A senha do wifi está na recepção: LISBOA2026 😊" },
  ];
  await generateReply(c.conv.id);
  const main = calls.filter((x) => x.kind === "main");
  assert.equal(main.length, 2);
  const toolMsg = main[1].body.messages.filter((m) => m.role === "tool").at(-1).content;
  assert.match(toolMsg, /"encontrado":true/);
  assert.match(toolMsg, /LISBOA2026/);
  // nada cadastrado
  calls.length = 0;
  const d = await cenario("Consulta Vazia", [["user", "Oi"], ["assistant", "Oi! Como posso ajudar?"], ["user", "Vocês fazem tatuagem?"]]);
  mainScript = [{ tool: { name: "consultar_conteudo_da_clinica", args: { busca: "tatuagem" } } }, { content: "Vou confirmar com a equipe e já te retorno." }];
  await generateReply(d.conv.id);
  const vazia = calls.filter((x) => x.kind === "main")[1].body.messages.filter((m) => m.role === "tool").at(-1).content;
  assert.match(vazia, /"encontrado":false/);
  assert.match(vazia, /NAO prova que a clinica nao faz/);
  assert.match(vazia, /transfer_to_human/);
});

// ===================================================================== 4) HARMONIA DAS REGRAS (explainLine) E REESCRITAS
test("REGRAS: a instrucao de explicar procedimento respeita a hierarquia (nao pergunta/oferece depois de agendar, recusar ou agradecer; nao troca o procedimento escolhido por avaliacao)", async () => {
  const proc = await prisma.procedure.create({ data: { clinicId: clinic.id, name: "Peeling Descritivo", durationMin: 30, description: "Renova a pele.\nPergunta para continuar a conversa: Qual a sua principal queixa?" } });
  calls.length = 0;
  const c = await cenario("Regras", [["user", "Oi, queria saber do Peeling"], ["assistant", "Oi!"], ["user", "O que é?"]]);
  mainScript = [{ content: "É um procedimento que renova a pele. Qual a sua principal queixa?" }];
  await generateReply(c.conv.id);
  const sys = systemOf(calls.find((x) => x.kind === "main"));
  assert.match(sys, /COMO EXPLICAR PROCEDIMENTOS/);
  assert.match(sys, /SO se a JOGADA AGORA e a SITUACAO da ficha permitirem/);
  assert.match(sys, /ela nao recusou, nao agradeceu\/encerrou, nao esta ja agendada/);
  assert.match(sys, /Se a JOGADA AGORA mandar acolher, agradecer, aguardar ou nao oferecer nada, obedeca a JOGADA/);
  assert.match(sys, /nunca troque o procedimento escolhido por avaliacao/);
  assert.match(sys, /Depois de agendar, nao ofereca novos horarios/);
  assert.doesNotMatch(sys, /nunca encerre so explicando/);
  await prisma.procedure.delete({ where: { id: proc.id } });
});

const REPETIDA = "Nosso endereço é Av. Índico, 294, sala 5, no centro da cidade.";
async function cenarioRepeticao(nome) {
  return cenario(nome, [
    ["user", "Oi, onde vocês ficam?"], ["assistant", `${REPETIDA} Atendemos de segunda a sábado. Posso ajudar em mais alguma coisa?`],
    ["user", "Entendi. Vocês parcelam o pagamento?"],
  ]);
}
const rascunhoRepetido = `${REPETIDA} Parcelamos em até 6 vezes no cartão de crédito, sem juros, e também aceitamos pix com desconto.`;

test("REESCRITA: repeticao e corrigida cortando a frase repetida (sem chamar o modelo); o modo antigo gasta uma chamada; toda chamada auxiliar e medida com o motivo", async () => {
  calls.length = 0;
  const c = await cenarioRepeticao("Repete Novo");
  mainScript = [{ content: rascunhoRepetido }];
  const trace = oc.newTraceId();
  const reply = await oc.runWithAiContext({ traceId: trace }, () => generateReply(c.conv.id));
  assert.equal(calls.filter((x) => x.kind === "rewrite").length, 0, "nenhuma chamada de reescrita");
  assert.doesNotMatch(reply, /Índico/);
  assert.match(reply, /Parcelamos em até 6 vezes/, "a informacao nova ficou");

  calls.length = 0;
  const d = await cenarioRepeticao("Repete Antigo");
  mainScript = [{ content: rascunhoRepetido }];
  rewriteText = "Parcelamos em até 6 vezes no cartão de crédito, sem juros. Quer saber das formas de pagamento no pix?";
  let traceId;
  await withEnv({ AI_REWRITE_MODE: "legacy" }, async () => { await oc.runWithAiContext({}, async () => { traceId = oc.aiContext().traceId; return generateReply(d.conv.id); }); });
  assert.equal(calls.filter((x) => x.kind === "rewrite").length, 1, "modo antigo: uma chamada de reescrita");
  // a chamada auxiliar foi MEDIDA (antes algumas reescritas nao eram), com finalidade e motivo
  await usage.flushUsage();
  const rows = await prisma.aiCall.findMany({ where: { conversationId: d.conv.id }, orderBy: { at: "asc" } });
  assert.deepEqual(rows.map((r) => [r.purpose, r.attemptReason, r.outcome]), [["conversa_alice", "answer", "ok"], ["reescrita_repeticao", "correction:repeticao", "ok"]]);
  assert.equal(new Set(rows.map((r) => r.traceId)).size, 1, "as duas chamadas pertencem ao MESMO atendimento");
  assert.ok(rows.every((r) => r.clinicId === clinic.id && r.model === "gpt-4o-mini-2024-07-18" && r.inputTokens > 0));
  void traceId; void trace;
});

test("REESCRITA CONSOLIDADA: o prompt junta todos os problemas numa unica chamada e cada correcao mantem sua instrucao", () => {
  const p = consolidatedRewritePrompt("Clinica X", { relevance: { areaLabel: "rosto", wrong: "Criolipólise", fits: ["Hipro"] }, repeated: ["Nosso endereço é Av. Índico, 294."] });
  assert.match(p, /corrigindo TODOS os problemas abaixo de uma vez/);
  assert.match(p, /1\) PROCEDIMENTO DE OUTRA REGIAO.*"Criolipólise".*\(rosto\).*indique apenas: Hipro/s);
  assert.match(p, /2\) REPETICAO.*FRASES JA DITAS.*- Nosso endereço é Av\. Índico, 294\./s);
  assert.match(p, /Nao invente nada/);
  const curta = consolidatedRewritePrompt("Clinica X", { shortFirst: { assistantName: "Alice" } });
  assert.match(curta, /NO MAXIMO 2 frases/);
  assert.match(curta, /Oi! Aqui e a Alice, da equipe Clinica X/);
});

// ===================================================================== 5) SEGUNDA LEITURA SELETIVA
test("SEGUNDA LEITURA: criterios explicitos e deterministicos; cada decisao tem motivo; 'always' volta ao antigo e 'off' desliga", () => {
  const h = (n) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `mensagem ${i}` }));
  const d = (over) => analysis.decideSecondReading({ history: h(6), trailing: ["ok vou ver"], catalog: [{ name: "Hipro", aliases: "" }, { name: "Botox", aliases: "toxina" }], ...over });
  assert.deepEqual([d({}).run, d({}).skip], [false, "sem_ambiguidade_resumo_deterministico_basta"]);
  assert.deepEqual([d({ history: h(3) }).run, d({ history: h(3) }).skip], [false, "conversa_curta"]);
  assert.deepEqual(d({ trailing: ["a", "b", "c"] }).reasons, ["varias_mensagens_novas"]);
  assert.ok(d({ trailing: ["Quanto custa? Dói? Quanto dura?"] }).reasons.includes("varias_perguntas"));
  assert.ok(d({ trailing: ["Queria o hipro e também o botox juntos"] }).reasons.includes("varios_procedimentos"));
  assert.ok(d({ trailing: ["x".repeat(200)] }).reasons.includes("mensagem_longa"));
  assert.ok(d({ trailing: ["como eu falei antes, esse aí mesmo"] }).reasons.includes("referencia_ao_que_foi_dito"));
  assert.ok(d({ trailing: ["quero marcar mas achei caro"] }).reasons.includes("intencoes_misturadas"));
  assert.ok(d({ history: h(16), trailing: ["pode ser na semana que vem então, melhor depois do almoço"] }).reasons.includes("conversa_longa_com_novidade"));
  assert.equal(d({ mode: "always" }).run, true);
  assert.deepEqual([d({ mode: "off", trailing: ["Quanto custa? Dói? Quanto dura?"] }).run, d({ mode: "off" }).skip], [false, "desligada_por_configuracao"]);
});

// ===================================================================== 6) MEMORIA SEM REPETICAO
test("MEMORIA: a memoria do lead recebe o perfil que o resumo do CRM ja extraiu (e a instrucao de nao repeti-lo); sem perfil nada e acrescentado", () => {
  assert.equal(crmProfileText({}), "");
  const t = crmProfileText({ crmSummaryAt: new Date("2026-10-19T12:00:00Z"), interestNote: "drenagem facial", objections: "preco,medo", refusedProcedures: "botox", preferredPeriod: "tarde", preferredDays: "sabados", urgency: "este_mes", noInterest: false });
  assert.match(t, /^PERFIL DO CRM \(ja extraido; nao repita nas notas; atualizado 2026-10-19\)/);
  for (const x of ["interesse: drenagem facial", "objecoes: preco,medo", "recusou: botox", "periodo preferido: tarde", "dias preferidos: sabados", "urgencia: este_mes"]) assert.ok(t.includes(x), x);
  assert.ok(!t.includes("sem interesse"));
  assert.match(crmProfileText({ noInterest: true }), /sem interesse/);
});

// ===================================================================== 7) FALHAS NO ATENDIMENTO
test("ATENDIMENTO com saldo esgotado: UMA chamada, a falha vai para o chamador (a conversa fica sinalizada para a equipe), nada de trocar de modelo, e as proximas nem chegam a OpenAI; recupera sozinho", async () => {
  oc.resetOpenAiHealthForTests();
  await withEnv({ AI_BLOCK_COOLDOWN_MS: "600000" }, async () => {
    calls.length = 0;
    const custom = await prisma.clinic.update({ where: { id: clinic.id }, data: { aiModel: "gpt-modelo-da-clinica" } });
    void custom;
    try {
      failure = { status: 429, code: "insufficient_quota", type: "insufficient_quota", message: "You exceeded your current quota", times: 99 };
      const c = await cenario("Sem Saldo", [["user", "Oi"], ["assistant", "Oi!"], ["user", "Quanto custa o Hipro?"]]);
      await assert.rejects(() => generateReply(c.conv.id), (e) => e.aiKind === "quota" || oc.isOpenAiBlocked(e));
      assert.equal(calls.filter((x) => x.kind === "main").length, 1, "nao trocou de modelo para repetir a mesma falha");
      const d = await cenario("Sem Saldo 2", [["user", "Oi"], ["assistant", "Oi!"], ["user", "Tem horario?"]]);
      await assert.rejects(() => generateReply(d.conv.id), (e) => oc.isOpenAiBlocked(e));
      assert.equal(calls.filter((x) => x.kind === "main").length, 1, "a segunda conversa nem chegou a OpenAI");
      assert.equal(oc.openAiHealth().state, "sem_saldo");
      // recarregou: depois do intervalo a chamada de teste passa e volta ao normal
      failure = null;
      oc.expireOpenAiBlockForTests(); // o intervalo venceu (recarregou os creditos)
      mainScript = [{ content: "O Hipro tem valor de avaliação; a equipe apresenta. Quer ver um horário?" }];
      const reply = await generateReply(d.conv.id);
      assert.match(reply, /Hipro/);
      assert.equal(oc.openAiHealth().state, "ok");
    } finally {
      failure = null;
      await prisma.clinic.update({ where: { id: clinic.id }, data: { aiModel: null } });
      oc.resetOpenAiHealthForTests();
    }
  });
});

test("MODELO PROPRIO DA CLINICA incompativel (404/parametro recusado): ai sim volta ao modelo padrao NA MESMA resposta, e a troca fica registrada como 'fallback_model'", async () => {
  oc.resetOpenAiHealthForTests();
  calls.length = 0;
  await prisma.clinic.update({ where: { id: clinic.id }, data: { aiModel: "gpt-modelo-inexistente" } });
  try {
    failure = { status: 404, code: "model_not_found", message: "The model `gpt-modelo-inexistente` does not exist", times: 1 };
    const c = await cenario("Modelo", [["user", "Oi"], ["assistant", "Oi!"], ["user", "Qual o endereço?"]]);
    mainScript = [{ content: "Av. Índico, 294, sala 5. Posso ajudar em mais alguma coisa?" }];
    const reply = await generateReply(c.conv.id);
    assert.match(reply, /Índico/);
    const main = calls.filter((x) => x.kind === "main");
    assert.deepEqual(main.map((x) => x.body.model), ["gpt-modelo-inexistente", "gpt-4o-mini"]);
    await usage.flushUsage();
    const rows = await prisma.aiCall.findMany({ where: { conversationId: c.conv.id, purpose: "conversa_alice" }, orderBy: { at: "asc" } });
    assert.deepEqual(rows.map((r) => [r.outcome, r.errorKind, r.attemptReason]), [["error", "model", "answer"], ["ok", null, "fallback_model"]]);
  } finally {
    failure = null;
    await prisma.clinic.update({ where: { id: clinic.id }, data: { aiModel: null } });
  }
});

test("CICLO DE CHAMADAS: ferramentas, correcoes e nova tentativa ficam distinguidas no registro do atendimento (limite de 6 mantido)", async () => {
  oc.resetOpenAiHealthForTests();
  calls.length = 0;
  const dia = amanha(13, 30);
  const novo = amanha(12, 30);
  const c = await cenario("Ciclo Vania", [["user", "Preciso trocar meu horário amanhã pra 12:30"]], { appt: { procedureId: hipro.id, when: dia.instant } });
  mainScript = [
    { content: "Remarquei seu horário para amanhã às 12:30!" }, // promete sem executar -> correcao
    { tool: { name: "manage_my_appointment", args: { action: "reschedule", new_date: novo.date, new_time: "12:30" } } }, // ferramenta
    { content: "Pronto! Remarquei o seu Hipro para as 12:30. 💗" },
  ];
  failure = { status: 503, code: "server_is_overloaded", message: "overloaded", times: 0 };
  await withEnv({ AI_APP_RETRIES: "1" }, async () => {
    failure.times = 1; // a PRIMEIRA chamada falha por indisponibilidade e e repetida uma vez
    await generateReply(c.conv.id);
  });
  failure = null;
  await usage.flushUsage();
  const rows = await prisma.aiCall.findMany({ where: { conversationId: c.conv.id }, orderBy: { at: "asc" } });
  assert.deepEqual(rows.map((r) => [r.purpose, r.attemptReason, r.outcome]).filter((r) => r[0] === "conversa_alice"), [
    ["conversa_alice", "answer", "error"], // indisponibilidade
    ["conversa_alice", "retry:answer", "ok"], // nova tentativa por falha tecnica
    ["conversa_alice", "correction:promessa", "ok"], // correcao: prometeu sem executar
    ["conversa_alice", "tool_result", "ok"], // continuacao depois da ferramenta
  ]);
  const rep = await usage.traceReport(rows[0].traceId);
  assert.deepEqual([rep.answer, rep.tool, rep.correction, rep.retry], [1, 1, 1, 1], "1 tentativa inicial (que falhou), 1 nova tentativa, 1 correcao, 1 continuacao apos ferramenta");
});

// ===================================================================== 8) ANTES x DEPOIS (mesmos cenarios; simulador, estimativa de tokens = caracteres/4)
// ATENCAO: aqui "antes" = MODOS DE COMPATIBILIDADE na arvore atual (nao o commit e405310, cujo texto de prompt difere em ~32 tokens). A comparacao FIEL, em checkouts separados, e feita por
// scripts/comparar-custo.mjs (ver docs/custo-openai.md). Este teste garante que os modos de compatibilidade mantem as MESMAS chamadas do codigo anterior, inclusive as excecoes da segunda leitura.
test("COMPATIBILIDADE x PADRAO: chamadas e contexto por cenario (compat = AI_CONTEXT_SELECT=off + AI_REWRITE_MODE=legacy + AI_SECOND_READING=always)", async () => {
  oc.resetOpenAiHealthForTests();
  const LEGADO = { AI_CONTEXT_SELECT: "off", AI_REWRITE_MODE: "legacy", AI_SECOND_READING: "always" };
  const NOVO = { AI_CONTEXT_SELECT: undefined, AI_REWRITE_MODE: undefined, AI_SECOND_READING: undefined };
  const base = [["user", "Oi, queria saber do Hipro"], ["assistant", "Oi! O Hipro é para firmeza da pele. O que você gostaria de melhorar?"], ["user", "A flacidez no rosto"], ["assistant", "Entendi. Quer saber mais?"]];
  const lembrete = ["assistant", "Olá! Confirmando seu horário amanhã às 14:30. Podemos contar com você?", "Lembrete de consulta"];
  const cenarios = [
    { nome: "pergunta simples", msgs: [...base, ["user", "Qual o endereço de vocês?"]], script: () => [{ content: "Av. Índico, 294, sala 5." }] },
    { nome: "duvida sobre procedimento", msgs: [...base, ["user", "O Hipro dói? Quanto tempo dura? Precisa de preparo?"]], script: () => [{ content: "O desconforto é pequeno, dura cerca de 40 minutos e não precisa de preparo especial." }] },
    { nome: "agendamento com ferramentas", msgs: [...base, ["user", "Quero agendar o Hipro amanhã"]], script: () => [{ tool: { name: "check_availability", args: { procedure_name: "Hipro", date: amanha(9).date } } }, { content: "Encontrei horários amanhã! Prefere manhã ou tarde?" }] },
    { nome: "confirmacao de presenca", msgs: [lembrete, ["user", "Confirmado"]], appt: true, script: () => [] },
    { nome: "remarcacao", msgs: [["user", "Preciso trocar meu horário amanhã pra mais cedo"]], appt: true, script: (modo) => [{ tool: { name: "manage_my_appointment", args: { action: "reschedule", new_date: amanha(10, 0).date, new_time: modo === "antes" ? "10:00" : "10:30" } } }, { content: "Pronto! Remarquei o seu Hipro para mais cedo. 💗" }] },
    { nome: "recusa", msgs: [...base, ["user", "Não, obrigada. Vou pensar com calma"]], script: () => [{ content: "Claro, sem pressa! Quando quiser é só me chamar. 💗" }] },
    { nome: "agradecimento", msgs: [...base, ["assistant", "Tenho horários amanhã. Quer que eu reserve?"], ["user", "Obrigada!"]], script: () => [{ content: "Por nada! 💗" }] },
    { nome: "atendimento humano", msgs: [...base, ["human", "Oi, aqui é a recepção, já te respondo!", "Recepção"], ["user", "Tudo bem, aguardo"]], humano: true, script: () => [] },
    { nome: "cortesia (ok) - excecao da 2a leitura", msgs: [...base, ["assistant", "Fechado, qualquer coisa me chame!"], ["user", "ok"]], script: () => [{ content: "Combinado! 💗" }] },
    { nome: "ja agendada pergunta - excecao da 2a leitura", msgs: [["assistant", "Seu horário está confirmado."], ["user", "Oi"], ["assistant", "Oi!"], ["user", "Vocês ficam em qual rua mesmo?"]], appt: true, script: () => [{ content: "Av. Índico, 294, sala 5. Te esperamos!" }] },
    { nome: "resposta repetida (corte)", msgs: [["user", "Oi, onde vocês ficam?"], ["assistant", `${REPETIDA} Atendemos de segunda a sábado. Posso ajudar em mais alguma coisa?`], ["user", "Entendi. Vocês parcelam o pagamento?"]], script: () => [{ content: rascunhoRepetido }] },
  ];
  const tabela = [];
  for (const sc of cenarios) {
    const linha = { cenario: sc.nome };
    for (const [modo, env] of [["antes", LEGADO], ["depois", NOVO]]) {
      await withEnv(env, async () => {
        calls.length = 0;
        const appt = sc.appt ? { procedureId: hipro.id, when: amanha(modo === "antes" ? 15 : 16, 30).instant } : null;
        const c = await cenario(`${sc.nome} ${modo}`, sc.msgs, { appt, humano: !!sc.humano });
        mainScript = sc.script(modo);
        rewriteText = "Parcelamos em até 6 vezes no cartão de crédito, sem juros. Quer saber das formas de pagamento no pix?";
        try { await generateReply(c.conv.id); } catch (e) { throw new Error(`cenario "${sc.nome}" (${modo}): ${e.message}`); }
        const principal = calls.find((x) => x.kind === "main");
        linha[modo] = { chamadas: calls.length, auxiliares: calls.filter((x) => x.kind !== "main").length, contextoChars: principal ? chars(principal.body.messages) : 0, contextoTokensEst: principal ? Math.ceil(chars(principal.body.messages) / 4) : 0 };
      });
    }
    tabela.push(linha);
  }
  console.log("\nANTES x DEPOIS (OpenAI simulada; tokens = caracteres/4, ESTIMATIVA)\n" + tabela.map((l) => `${l.cenario.padEnd(30)} chamadas ${String(l.antes.chamadas).padStart(2)} -> ${String(l.depois.chamadas).padStart(2)} | aux ${l.antes.auxiliares} -> ${l.depois.auxiliares} | contexto(tok est.) ${String(l.antes.contextoTokensEst).padStart(5)} -> ${String(l.depois.contextoTokensEst).padStart(5)}`).join("\n") + "\n");
  for (const l of tabela) {
    assert.ok(l.depois.chamadas <= l.antes.chamadas, `${l.cenario}: nunca mais chamadas que antes`);
    assert.ok(l.depois.contextoChars <= l.antes.contextoChars, `${l.cenario}: contexto nunca maior que antes`);
  }
  const por = Object.fromEntries(tabela.map((l) => [l.cenario, l]));
  assert.ok(por["pergunta simples"].depois.contextoChars < por["pergunta simples"].antes.contextoChars, "pergunta simples: contexto menor");
  assert.ok(por["pergunta simples"].depois.chamadas < por["pergunta simples"].antes.chamadas, "pergunta simples: sem a segunda leitura");
  assert.ok(por["resposta repetida (corte)"].depois.chamadas < por["resposta repetida (corte)"].antes.chamadas, "repeticao: sem a chamada de reescrita");
  assert.equal(por["duvida sobre procedimento"].depois.chamadas, por["duvida sobre procedimento"].antes.chamadas, "varias perguntas: a segunda leitura continua");
  assert.equal(por["agendamento com ferramentas"].depois.chamadas - por["agendamento com ferramentas"].depois.auxiliares, 2, "agendamento: as chamadas de ferramenta continuam");
  assert.equal(por["confirmacao de presenca"].depois.chamadas, 0);
  assert.equal(por["atendimento humano"].depois.chamadas, 0);
  // as excecoes da segunda leitura valem tambem no modo de compatibilidade: ele NAO forca a chamada que o codigo anterior dispensava
  assert.equal(por["cortesia (ok) - excecao da 2a leitura"].antes.auxiliares, 0);
  assert.equal(por["ja agendada pergunta - excecao da 2a leitura"].antes.auxiliares, 0);
  const grava = path.join(os.tmpdir(), "alice-custo-antes-depois.json");
  fs.writeFileSync(grava, JSON.stringify(tabela, null, 2));
});


// ===================================================================== AJUSTES DA REVISAO (consumo desconhecido, telemetria, credenciais)
const fresh = () => { oc.resetOpenAiHealthForTests(); usage.resetUsageForTests(); };

test("CONSUMO DESCONHECIDO: bloqueada = not_sent (zero de verdade); requisicao enviada sem uso (timeout, erro, resposta sem uso) = unknown; nada vira 'zero tokens'; o painel mostra o custo CONHECIDO e quantas tentativas ficaram sem consumo", async () => {
  fresh();
  const clinic = await prisma.clinic.create({ data: { name: "Clinica Desconhecido", whatsappPhone: "5511900000775" } });
  const trace = "trace-desconhecido";
  const run = (client, meta = {}) => oc.runWithAiContext({ clinicId: clinic.id, traceId: trace }, () => oc.trackedChat(client, { model: "gpt-4o-mini", messages: [] }, { purpose: "conversa_alice", ...meta }));
  await run(fakeClient(async () => okResponse())); // conhecido: 1000 entrada / 50 saida
  await assert.rejects(() => run(fakeClient(async () => { throw Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" }); })), (e) => e.aiKind === "timeout"); // enviada, sem uso
  await run(fakeClient(async () => okResponse({ usage: undefined }))); // resposta SEM uso
  await assert.rejects(() => run(fakeClient(async () => { throw apiError(500, { message: "erro interno" }); })), () => true); // erro HTTP: enviada, sem uso
  // saldo: a chamada que descobre o problema e UNKNOWN (saiu); as seguintes, bloqueadas, sao NOT_SENT
  const semSaldo = fakeClient(async () => { throw apiError(429, { code: "insufficient_quota", type: "insufficient_quota", message: "You exceeded your current quota" }); });
  await assert.rejects(() => run(semSaldo), (e) => e.aiKind === "quota");
  await assert.rejects(() => run(semSaldo), (e) => oc.isOpenAiBlocked(e));
  await assert.rejects(() => run(semSaldo), (e) => oc.isOpenAiBlocked(e));
  const rep = await usage.traceReport(trace);
  const por = (st) => rep.rows.filter((r) => r.usageState === st).length;
  assert.deepEqual([por("known"), por("unknown"), por("not_sent")], [1, 4, 2]);
  // linhas desconhecidas guardam 0 token no banco, mas o ESTADO diz que nao e zero de verdade
  assert.ok(rep.rows.filter((r) => r.usageState === "unknown").every((r) => r.inputTokens === 0 && r.outputTokens === 0));
  assert.ok(rep.rows.filter((r) => r.usageState === "not_sent").every((r) => r.outcome === "blocked" && r.errorKind === "quota"));
  assert.equal(rep.unknownUsageCalls, 4);
  assert.equal(rep.notSentCalls, 2);
  assert.equal(rep.complete, false, "o atendimento tem lacuna de consumo");
  // painel (memoria): custo conhecido + contagem das desconhecidas; total NAO e apresentado como completo
  const snap = usage.usageSnapshot();
  const alice = snap.purposes.find((p) => p.purpose === "conversa_alice");
  assert.equal(alice.unknownUsageCalls, 4);
  assert.equal(alice.notSentCalls, 2);
  assert.equal(alice.complete, false);
  assert.match(alice.costNote, /4 tentativa\(s\) enviada\(s\) com consumo DESCONHECIDO/);
  assert.equal(alice.input, 1000, "so o consumo informado entra nos tokens");
  assert.equal(alice.estimatedUsd, Number(pricing.estimateUsd("gpt-4o-mini", { input: 1000, cached: 400, output: 50 }).toFixed(6)), "custo = apenas o conhecido");
  assert.equal(snap.totalIsComplete, false);
  assert.equal(snap.unknownUsageCalls, 4);
  assert.match(snap.totalNote, /PARCIAL.*piso.*4 tentativa/);
  // persistido (apos agregar): as contagens sobrevivem
  await usage.flushUsage();
  await prisma.aiCall.updateMany({ where: { traceId: trace }, data: { at: new Date(Date.now() - 30 * 24 * 3_600_000) } });
  await usage.pruneAiUsage();
  const persistido = await usage.persistedReport({ days: 60, clinicId: clinic.id });
  const p2 = persistido.purposes.find((p) => p.purpose === "conversa_alice");
  assert.deepEqual([p2.unknownUsageCalls, p2.notSentCalls, p2.input], [4, 2, 1000]);
  assert.equal(persistido.totalIsComplete, false);
  // sem lacunas: o total e completo
  fresh();
  await oc.trackedChat(fakeClient(async () => okResponse()), { model: "gpt-4o-mini", messages: [] }, { purpose: "so_conhecido" });
  const limpo = usage.usageSnapshot();
  assert.equal(limpo.totalIsComplete, true);
  assert.match(limpo.totalNote, /Sem lacunas/);
});

test("BLOQUEIO POR CREDENCIAL: impressao digital da chave (nunca a chave); chaves independentes nao se bloqueiam; a mesma chave bloqueia todas as clinicas que a usam", async () => {
  fresh();
  const mk = (apiKey, impl) => ({ apiKey, chat: { completions: { create: async () => impl() } } });
  const A = mk("sk-chave-da-clinica-A-SEGREDO", async () => { throw apiError(429, { code: "insufficient_quota", type: "insufficient_quota", message: "quota" }); });
  let bChamadas = 0;
  const B = mk("sk-chave-da-clinica-B-SEGREDO", async () => { bChamadas++; return okResponse(); });
  const idA = oc.credentialIdOf(A), idB = oc.credentialIdOf(B);
  assert.notEqual(idA, idB);
  assert.match(idA, /^cred-[0-9a-f]{8}$/);
  assert.ok(!idA.includes("SEGREDO") && !idB.includes("sk-"), "o identificador nao contem a chave");
  await assert.rejects(() => oc.trackedChat(A, { model: "m", messages: [] }, { purpose: "x" }), (e) => e.aiKind === "quota");
  await assert.rejects(() => oc.trackedChat(A, { model: "m", messages: [] }, { purpose: "x" }), (e) => oc.isOpenAiBlocked(e) && e.credential === idA);
  // a credencial B segue normal
  await oc.trackedChat(B, { model: "m", messages: [] }, { purpose: "x" });
  await oc.trackedChat(B, { model: "m", messages: [] }, { purpose: "x" });
  assert.equal(bChamadas, 2);
  const saude = oc.openAiHealth();
  assert.deepEqual(saude.credentials.map((c) => [c.credential, c.state]), [[idA, "sem_saldo"]]);
  assert.ok(!JSON.stringify(saude).includes("SEGREDO") && !JSON.stringify(saude).includes("sk-"), "o estado nunca expoe o segredo");
  // duas clinicas com a MESMA chave do servidor: ambas ficam bloqueadas juntas (e a mensagem de erro nao traz segredo)
  const erro = await oc.trackedChat(A, { model: "m", messages: [] }, { purpose: "x" }).catch((e) => e);
  assert.ok(!String(erro.message).includes("SEGREDO"));
  fresh();
});

test("RECUPERACAO UNICA: depois do intervalo so UMA chamada real por credencial tenta (as outras seguem controladas ate ela terminar); falhou -> continua bloqueada; funcionou -> libera todas", async () => {
  fresh();
  let emVoo = 0, maxEmVoo = 0, chamadas = 0, modo = "sem_saldo";
  let liberar;
  const portao = new Promise((r) => { liberar = r; });
  const client = { apiKey: "sk-recuperacao", chat: { completions: { create: async () => {
    chamadas++; emVoo++; maxEmVoo = Math.max(maxEmVoo, emVoo);
    try {
      if (modo === "sem_saldo") throw apiError(429, { code: "insufficient_quota", type: "insufficient_quota", message: "quota" });
      await portao; // a chamada de recuperacao demora
      return okResponse();
    } finally { emVoo--; }
  } } } };
  const go = () => oc.trackedChat(client, { model: "m", messages: [] }, { purpose: "x" });
  await assert.rejects(go, (e) => e.aiKind === "quota");
  assert.equal(chamadas, 1);
  assert.equal(oc.openAiHealth().credentials[0].recoveryInProgress, false);
  // intervalo vencido; os creditos voltaram, mas a chamada de recuperacao demora: varias chegam ao mesmo tempo
  oc.expireOpenAiBlockForTests();
  modo = "ok";
  const primeira = go(); // vira a chamada de recuperacao e demora (fica presa no portao)
  await wait(30);
  const resultados = await Promise.allSettled([go(), go(), go()]); // as 3 que chegaram DEPOIS da primeira
  assert.ok(resultados.every((r) => r.status === "rejected" && oc.isOpenAiBlocked(r.reason)), "as demais ficam bloqueadas enquanto a recuperacao esta em andamento");
  assert.equal(chamadas, 2, "so a primeira chamada real foi a OpenAI");
  assert.equal(oc.openAiHealth().credentials[0].recoveryInProgress, true);
  liberar();
  await primeira;
  const maxDuranteBloqueio = maxEmVoo; // so durante o bloqueio/recuperacao (depois de liberada, chamadas normais podem ser simultaneas)
  assert.equal(oc.openAiHealth().state, "ok", "a recuperacao funcionou: tudo liberado");
  await Promise.all([go(), go()]);
  assert.equal(chamadas, 4);
  assert.equal(maxDuranteBloqueio, 1, "nunca duas chamadas ao mesmo tempo durante o bloqueio/recuperacao");
  // recuperacao que FALHA (ainda sem saldo): continua bloqueado, a vez e liberada so no proximo intervalo
  modo = "sem_saldo";
  await assert.rejects(go, (e) => e.aiKind === "quota");
  oc.expireOpenAiBlockForTests();
  await assert.rejects(go, (e) => e.aiKind === "quota"); // a de recuperacao
  await assert.rejects(go, (e) => oc.isOpenAiBlocked(e)); // sem novo intervalo: bloqueada de novo
  assert.equal(oc.openAiHealth().state, "sem_saldo");
  // recuperacao INCONCLUSIVA (timeout): libera a vez so no proximo intervalo, nao fica presa em 'em andamento'
  fresh();
  let t = 0;
  const lento = { apiKey: "sk-timeout", chat: { completions: { create: async () => { t++; if (t === 1) throw apiError(429, { code: "insufficient_quota", type: "insufficient_quota", message: "quota" }); throw Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" }); } } } };
  await assert.rejects(() => oc.trackedChat(lento, { model: "m", messages: [] }, { purpose: "x" }));
  oc.expireOpenAiBlockForTests();
  await assert.rejects(() => oc.trackedChat(lento, { model: "m", messages: [] }, { purpose: "x" }), (e) => e.aiKind === "timeout");
  assert.equal(oc.openAiHealth().credentials[0].recoveryInProgress, false);
  await assert.rejects(() => oc.trackedChat(lento, { model: "m", messages: [] }, { purpose: "x" }), (e) => oc.isOpenAiBlocked(e));
  fresh();
});

test("AVISO INTERNO: nao depende da OpenAI, nao gera recursao e nao se repete a cada tentativa; cada clinica afetada e avisada uma vez", async () => {
  fresh();
  const mkC = (nome, fone, notify) => prisma.clinic.create({ data: { name: nome, whatsappPhone: fone, plan: "prime", notifyPhone: notify, notifyEvents: "", uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: "tok-aviso-" + nome } });
  const c1 = await mkC("Aviso Um", "5511900000781", "5511911110001");
  const c2 = await mkC("Aviso Dois", "5511900000782", "5511911110002");
  const client = { apiKey: "sk-aviso", chat: { completions: { create: async () => { throw apiError(429, { code: "insufficient_quota", type: "insufficient_quota", message: "quota" }); } } } };
  const go = (clinicId) => oc.runWithAiContext({ clinicId }, () => oc.trackedChat(client, { model: "m", messages: [] }, { purpose: "x" }));
  calls.length = 0; uazapiPosts.length = 0;
  await assert.rejects(() => go(c1.id), (e) => e.aiKind === "quota");
  for (let i = 0; i < 6; i++) await assert.rejects(() => go(c1.id), (e) => oc.isOpenAiBlocked(e));
  for (let i = 0; i < 6; i++) await assert.rejects(() => go(c2.id), (e) => oc.isOpenAiBlocked(e));
  for (let i = 0; i < 40; i++) { if (uazapiPosts.length >= 2) break; await wait(100); }
  await wait(300); // margem para um eventual aviso repetido aparecer
  assert.equal(uazapiPosts.length, 2, "um aviso por clinica afetada, nao um por tentativa");
  assert.deepEqual(uazapiPosts.map((x) => x.number).sort(), ["5511911110001", "5511911110002"]);
  assert.ok(uazapiPosts.every((x) => /SEM SALDO/.test(x.text)));
  assert.equal(calls.length, 0, "o aviso (e todo o caminho do bloqueio) nao chamou a OpenAI nem pela revisao de envio");
  assert.equal(await prisma.activityLog.count({ where: { clinicId: c1.id, type: "openai_blocked" } }), 1);
  assert.equal(await prisma.activityLog.count({ where: { clinicId: c2.id, type: "openai_blocked" } }), 1);
  fresh();
});

test("TELEMETRIA: fila LIMITADA com perda visivel; lote que falha volta para a fila e, ao gravar, NAO duplica; conflito de id nao quebra; desligamento tem prazo", async () => {
  fresh();
  const original = prisma.aiCall.createMany;
  const rec = (i) => usage.recordCall({ purpose: "telemetria", model: "gpt-4o-mini", usage: { prompt_tokens: 10, completion_tokens: 1 }, clinicId: "clinica-t", traceId: "t-" + i });
  // banco recusando: a fila nunca passa do limite e o descarte e CONTADO
  prisma.aiCall.createMany = async () => { throw new Error("banco indisponivel (simulado)"); };
  try {
    for (let i = 0; i < usage.MAX_QUEUE + 300; i++) rec(i);
    await usage.flushUsage();
    const tel = usage.telemetryStatus();
    assert.ok(tel.queued <= usage.MAX_QUEUE, "fila limitada");
    assert.equal(tel.dropped, 300, "descartes contados");
    assert.ok(tel.failedBatches >= 1 && /banco indisponivel/.test(tel.lastError));
    assert.equal(tel.complete, false);
    assert.equal(usage.usageSnapshot().totalIsComplete, false, "perda de medicao aparece no total");
    assert.match(usage.usageSnapshot().totalNote, /perdido/);
  } finally { prisma.aiCall.createMany = original; }
  // o banco volta: o que estava na fila e gravado UMA vez (sem duplicar), e a fila esvazia
  await usage.flushUsage();
  const n1 = await prisma.aiCall.count({ where: { clinicId: "clinica-t" } });
  assert.equal(n1, usage.MAX_QUEUE, "grava exatamente o que estava na fila");
  assert.equal(usage.telemetryStatus().queued, 0);
  await usage.flushUsage();
  assert.equal(await prisma.aiCall.count({ where: { clinicId: "clinica-t" } }), n1, "regravar nao duplica");
  // lote que "entrou" mas a resposta foi erro (conflito de id): tratado como ja gravado
  fresh();
  const existente = await prisma.aiCall.findFirst({ where: { clinicId: "clinica-t" } });
  usage.recordCall({ id: existente.id, purpose: "telemetria", clinicId: "clinica-t", usage: { prompt_tokens: 1 } });
  usage.recordCall({ purpose: "telemetria", clinicId: "clinica-t", traceId: "novo", usage: { prompt_tokens: 1 } });
  await usage.flushUsage();
  assert.equal(await prisma.aiCall.count({ where: { clinicId: "clinica-t" } }), n1 + 1, "o repetido nao duplica e o novo entra");
  assert.equal(usage.telemetryStatus().queued, 0);
  // desligamento: banco travado -> nao espera alem do prazo e informa o que ficou
  fresh();
  prisma.aiCall.createMany = () => new Promise(() => undefined); // nunca responde
  process.env.AI_USAGE_WRITE_TIMEOUT_MS = "200";
  try {
    for (let i = 0; i < 5; i++) rec(i);
    const t0 = Date.now();
    const r = await usage.flushUsageWithin(300);
    assert.ok(Date.now() - t0 < 2000, "respeita o prazo");
    assert.equal(r.remaining, 5);
    assert.equal(usage.telemetryStatus().lostOnShutdown, 5, "a perda e registrada");
  } finally { prisma.aiCall.createMany = original; delete process.env.AI_USAGE_WRITE_TIMEOUT_MS; await wait(300); usage.resetUsageForTests(); }
  // desligamento normal: grava tudo antes do prazo
  for (let i = 0; i < 7; i++) rec(100 + i);
  const ok = await usage.flushUsageWithin(2000);
  assert.equal(ok.remaining, 0);
  fresh();
});

test("AGREGACAO: duas execucoes ao mesmo tempo somam UMA vez (transacao + contagem conferida); janela do relatorio usa o mesmo limite para agregado e recente (nada contado duas vezes)", async () => {
  fresh();
  const clinicId = "clinica-agregacao";
  const velho = new Date(Date.now() - 25 * 24 * 3_600_000);
  const mk = (over = {}) => ({ at: velho, clinicId, purpose: "agg", model: "gpt-4o-mini", inputTokens: 100, cachedTokens: 0, outputTokens: 10, durationMs: 5, outcome: "ok", usageState: "known", attempt: 1, ...over });
  await prisma.aiCall.createMany({ data: Array.from({ length: 50 }, () => mk()).concat([mk({ outcome: "error", usageState: "unknown", inputTokens: 0, outputTokens: 0 }), mk({ outcome: "blocked", usageState: "not_sent", inputTokens: 0, outputTokens: 0 })]) });
  const [a, b] = await Promise.all([usage.pruneAiUsage(), usage.pruneAiUsage()]);
  assert.equal(a.rolledUp + b.rolledUp, 52, "cada linha foi somada exatamente uma vez");
  const dia = velho.toISOString().slice(0, 10);
  const d = await prisma.aiUsageDaily.findUnique({ where: { day_clinicId_purpose_model: { day: dia, clinicId, purpose: "agg", model: "gpt-4o-mini" } } });
  assert.deepEqual([d.calls, d.okCalls, d.errorCalls, d.unknownCalls, d.notSentCalls, d.inputTokens, d.outputTokens], [52, 50, 1, 1, 1, 5000, 500]);
  assert.equal(await prisma.aiCall.count({ where: { clinicId } }), 0);
  assert.equal((await usage.pruneAiUsage()).rolledUp, 0, "rodar de novo nao soma");
  // janela: o relatorio de N dias comeca no inicio do dia UTC; um registro esta no agregado OU no recente, nunca nos dois nem em nenhum
  const now = new Date("2026-10-19T15:00:00Z");
  const from = usage.reportWindowStart(now, 3);
  assert.equal(from.toISOString(), "2026-10-17T00:00:00.000Z");
  await prisma.aiUsageDaily.create({ data: { day: "2026-10-16", clinicId: "clinica-janela", purpose: "j", model: "gpt-4o-mini", calls: 7, okCalls: 7, inputTokens: 700 } }); // fora da janela de 3 dias
  await prisma.aiUsageDaily.create({ data: { day: "2026-10-17", clinicId: "clinica-janela", purpose: "j", model: "gpt-4o-mini", calls: 2, okCalls: 2, inputTokens: 200 } }); // dentro (inicio do dia limite)
  await prisma.aiCall.create({ data: { at: new Date("2026-10-18T10:00:00Z"), clinicId: "clinica-janela", purpose: "j", model: "gpt-4o-mini", inputTokens: 30, outcome: "ok", usageState: "known" } }); // recente
  await prisma.aiCall.create({ data: { at: new Date("2026-10-16T23:59:00Z"), clinicId: "clinica-janela", purpose: "j", model: "gpt-4o-mini", inputTokens: 5, outcome: "ok", usageState: "known" } }); // fora
  const rel = await usage.persistedReport({ days: 3, clinicId: "clinica-janela", now });
  const j = rel.purposes.find((x) => x.purpose === "j");
  assert.deepEqual([j.calls, j.input], [3, 230]);
  fresh();
});
