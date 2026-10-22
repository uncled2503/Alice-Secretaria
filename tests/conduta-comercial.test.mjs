// CONDUTA COMERCIAL DA ALICE (pedido da Lisboa, 16-17/10/2026). Duas camadas:
//  1) funcoes PURAS (queixa lida por frase, elegibilidade pelo cadastro, modo de agendamento, recusa/vou pensar, servico nao oferecido, trava das ferramentas);
//  2) generateReply de ponta a ponta com banco temporario e o MODELO SIMULADO (roteirizado): confere o que foi enviado ao modelo, quais ferramentas de
//     agenda foram liberadas/barradas e o que sai ao final. LIMITE: o modelo e simulado - estes testes provam o que o CODIGO envia, bloqueia e entrega,
//     nao como o modelo real se comporta com esse contexto (isso so a validacao controlada em producao mostra).
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dbFile = path.join(os.tmpdir(), `alice-conduta-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY = "test-key";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const openaiCalls = []; // chamadas ao modelo da conversa (com ferramentas)
let script = [];
let reviewMode = "enviar";
let reviewFn = () => ({ decisao: "enviar", confianca: "alta", motivo: "ok" });
const posts = [];
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function completion({ content = null, tool = null }) {
  const message = { role: "assistant", content, ...(tool ? { tool_calls: [{ id: `call_${Math.random().toString(36).slice(2)}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : {}) };
  return { id: "chatcmpl-test", object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "gpt-4o-mini", choices: [{ index: 0, message, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
}
const plain = (obj) => ({ id: "c", object: "chat.completion", created: 1, model: "gpt-4o-mini", choices: [{ index: 0, message: { role: "assistant", content: typeof obj === "string" ? obj : JSON.stringify(obj) }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.includes("openai.com")) {
    const body = JSON.parse(init.body);
    if (!body.tools) {
      if (/REVISOR (DE ENVIO|das respostas)/.test(body.messages[0].content)) return jsonRes(200, plain(reviewFn(body)));
      return jsonRes(200, plain("{}"));
    }
    openaiCalls.push(body);
    const next = script.shift();
    if (!next) throw new Error("o roteiro do modelo acabou (chamada a mais do que o esperado)");
    return jsonRes(200, completion(typeof next === "function" ? next(body) : next));
  }
  if (u.hostname.endsWith("uazapi.com") && u.pathname === "/send/text") posts.push(JSON.parse(init.body).text);
  return jsonRes(200, { data: {}, id: "msg" });
};

const { prisma } = await import("../dist/db/client.js");
const { generateReply } = await import("../dist/ai/alice.js");
const concerns = await import("../dist/ai/concerns.js");
const conduct = await import("../dist/ai/conduct.js");
const { isJobSeeker, nonPatientKind } = await import("../dist/ai/jobSeeker.js");
const { deliverAliceReply } = await import("../dist/uazapi/client.js");
const { rememberReplyContext, forgetReplyContext, checkFinalReply } = await import("../dist/ai/replyGuard.js");
const { newSlotState } = await import("../dist/ai/slotGuard.js");
const { emptyRequest } = await import("../dist/ai/slotRequest.js");
const { resetBreakerForTests } = await import("../dist/ai/sendGate.js");
const { ajustarCondutaLisboa } = await import("../dist/maintenance/lisboaConduta.js");

test.after(async () => {
  await (await import("../dist/jobs/background.js")).drainBackground(); // tarefas em segundo plano terminam ANTES de o banco temporario ser apagado
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* arquivo temporario */ } }
});

// ---------------------------------------------------------------- catalogo (parecido com o da Lisboa)
const CATALOGO = [
  { name: "Enzimas", aliases: "Aplicação de enzimas, Enzimas para gordura localizada", goals: "Gordura localizada, Celulite, Papada", benefits: "Auxilia na redução de medidas", description: "Aplicação de enzimas em áreas com gordura localizada.", bookingMode: null },
  { name: "Clareamento Corporal", aliases: "Clareamento de pele corporal", goals: "Escurecimento corporal, Tom de pele irregular, Áreas com aspecto manchado", benefits: "Auxilia na uniformização do tom", description: "Protocolo estético voltado à melhora gradual de áreas corporais com escurecimento.", bookingMode: "direct" },
  { name: "Clareamento de Axilas, Virilhas e Áreas Íntimas", aliases: "Clareamento íntimo, Clareamento de axila, Clareamento de virilha", goals: "Escurecimento de axilas, Escurecimento de virilha", benefits: "", description: "Clareamento estético para regiões com escurecimento.", bookingMode: "direct" },
  { name: "Limpeza de Pele", aliases: "", goals: "Cravos, Oleosidade", benefits: "", description: "Limpeza profunda.", bookingMode: "direct" },
  { name: "Laser Etherea Melasma", aliases: "", goals: "Melasma, Manchas", benefits: "", description: "Protocolo para melasma. Exige avaliação prévia.", bookingMode: "evaluation" },
  { name: "LED Laser", aliases: "LEDterapia, Fototerapia", goals: "Rejuvenescimento, Viço", benefits: "", description: "Fotobiomodulação.", bookingMode: null },
];

async function mkClinic(name, extra = {}, catalogo = CATALOGO, avaliacao = true) {
  const clinic = await prisma.clinic.create({ data: { name, whatsappPhone: `55119${Math.floor(Math.random() * 1e8)}`, timezone: "America/Sao_Paulo", plan: "prime", workDays: "0,1,2,3,4,5,6", workStartHour: 7, workEndHour: 22, closedOnHolidays: false, silentHandoff: true, uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: `tok-${Math.random().toString(36).slice(2)}`, ...extra } });
  if (avaliacao) await prisma.procedure.create({ data: { clinicId: clinic.id, name: "Avaliação Estética", durationMin: 30 } });
  for (const p of catalogo) await prisma.procedure.create({ data: { clinicId: clinic.id, durationMin: 30, ...p } });
  return clinic;
}
const lisboa = await mkClinic("Lisboa Conduta Teste", { notOfferedServices: "luz pulsada, luz intensa pulsada, IPL" });
const estrita = await mkClinic("Clinica Estrita Teste", { strictBookingRules: true }, [
  { name: "Peeling Químico", aliases: "", goals: "Manchas, Textura", benefits: "", description: "Peeling.", bookingMode: null },
  { name: "Limpeza de Pele", aliases: "", goals: "Cravos", benefits: "", description: "Limpeza.", bookingMode: "direct" },
]);
const outra = await mkClinic("Outra Clinica Sem Regras", {}, [{ name: "Limpeza de Pele", aliases: "", goals: "Cravos", benefits: "", description: "Limpeza.", bookingMode: null }]);
const loja = await prisma.clinic.create({ data: { name: "Loja Laleblu Teste", businessType: "geral", whatsappPhone: "5511900009999", timezone: "America/Sao_Paulo", plan: "prime", workDays: "0,1,2,3,4,5,6", workStartHour: 7, workEndHour: 22, uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: "tok-loja" } });

const HOUR = 3_600_000;
let seq = 0;
async function cenario(clinic, nome, mensagens, { appt = null, adName = null } = {}) {
  seq++;
  const patient = await prisma.patient.create({ data: { clinicId: clinic.id, name: nome, phone: `551196666${String(1000 + seq)}`, adName } });
  const conv = await prisma.conversation.create({ data: { patientId: patient.id } });
  let t = Date.now() - mensagens.length * 60_000;
  for (const [role, content, authorName] of mensagens) {
    await prisma.message.create({ data: { conversationId: conv.id, role, content, authorName: authorName ?? null, createdAt: new Date((t += 60_000)), ...(role === "assistant" || role === "human" ? { deliveryStatus: "sent" } : {}) } });
  }
  let appointment = null;
  if (appt) {
    const proc = await prisma.procedure.findFirst({ where: { clinicId: clinic.id, name: appt.procedure } });
    appointment = await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: patient.id, procedureId: proc.id, scheduledAt: appt.when, source: "presencial" } });
  }
  return { patient, conv, appointment };
}
const systemsOf = (call) => call.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
const toolResults = (call) => call.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
const lastTool = (call) => toolResults(call).at(-1) ?? ""; // o resultado da ferramenta chamada NESTA rodada (o historico da rodada traz os anteriores)
const run = async (c, roteiro) => { openaiCalls.length = 0; script = roteiro; return generateReply(c.conv.id); };
const reload = (c) => prisma.conversation.findUnique({ where: { id: c.conv.id } });
// o trecho das opcoes aprovadas que a Alice recebeu ("... para esse objetivo: A, B. Indique SO entre estes")
const aprovadasDe = (sys) => /para esse objetivo: ([^.]*)\./.exec(sys)?.[1] ?? "";

// ================================================================ 1) FUNCOES PURAS

test("queixa lida por frase: negacao, correcao, duas demandas, tom de pele, terceiros e queixa antiga nao contaminam", () => {
  const now = new Date();
  const msgs = (...t) => t.map((text) => ({ text, createdAt: now }));
  const ob = (...t) => concerns.readObjective(msgs(...t), now);
  assert.deepEqual(ob("Queria tratar gordura localizada na barriga").concerns, ["gordura"]);
  assert.deepEqual(ob("Quero clarear a parte interna da coxa").concerns, ["pigmentacao"]);
  const neg = ob("Não quero gordura, quero só clarear a virilha");
  assert.deepEqual(neg.concerns, ["pigmentacao"]);
  assert.ok(neg.negated.includes("gordura"));
  assert.deepEqual(ob("Quero tirar gordura da barriga", "Na verdade quero clarear a virilha").concerns, ["pigmentacao"], "a correcao posterior vence");
  assert.deepEqual([...ob("Queria clarear a axila e também tirar a gordura da barriga").concerns].sort(), ["gordura", "pigmentacao"], "duas demandas ficam as duas");
  const tone = ob("Sou morena, tenho pele escura, quero tratar celulite");
  assert.deepEqual(tone.concerns, ["celulite"], "tom de pele nao e queixa");
  assert.equal(tone.toneMentioned, true);
  assert.deepEqual(ob("Sou morena e tenho a pele escura").concerns, [], "so descrever o tom nao e queixa");
  const amiga = ob("Minha amiga quer tirar gordura", "eu quero clarear a axila");
  assert.deepEqual(amiga.concerns, ["pigmentacao"], "queixa de outra pessoa nao e a dela");
  assert.ok(amiga.past.includes("gordura"));
  assert.deepEqual(ob("Já tratei celulite, agora quero clarear a axila").concerns, ["pigmentacao"]);
  const velha = concerns.readObjective([{ text: "Tenho celulite", createdAt: new Date(now.getTime() - 5 * 24 * HOUR) }, { text: "Bom dia", createdAt: now }], now);
  assert.deepEqual(velha.concerns, [], "objetivo de 5 dias atras nao vale");
  const regiao = ob("Quero fazer algo na barriga");
  assert.deepEqual(regiao.concerns, []);
  assert.equal(regiao.regionOnly, true, "so a regiao: precisa esclarecer");
});

test("elegibilidade vem do CADASTRO aprovado: regiao sozinha nunca recomenda, gordura nao e Enzimas por apelido, clareamento nao puxa gordura/celulite/flacidez", () => {
  const now = new Date();
  const el = (...t) => concerns.eligibleProcedures(concerns.readObjective(t.map((text) => ({ text, createdAt: now })), now), CATALOGO);
  const coxa = el("Quero clarear a parte interna da coxa").eligible;
  assert.ok(coxa.includes("Clareamento Corporal"), "o aprovado para clareamento de corpo");
  assert.ok(!coxa.includes("Enzimas") && !coxa.includes("Clareamento de Axilas, Virilhas e Áreas Íntimas"), "outra queixa e outra regiao ficam de fora");
  assert.deepEqual(el("Quero clarear a axila").eligible, ["Clareamento de Axilas, Virilhas e Áreas Íntimas"]);
  assert.deepEqual(el("Tenho celulite e gordura localizada na barriga").eligible, ["Enzimas"]);
  for (const t of ["Quero clarear a coxa", "Quero clarear a axila", "Tenho manchas no rosto"]) {
    const e = el(t).eligible;
    assert.ok(!e.includes("Enzimas"), `clareamento/manchas nunca sugere Enzimas (gordura/celulite): ${t}`);
  }
  assert.deepEqual(el("Quero fazer algo na barriga").eligible, [], "so a regiao: nada e indicado");
  assert.deepEqual(el("Tenho estrias").eligible, [], "queixa sem procedimento aprovado: nada e indicado");
  assert.ok(!el("Quero tirar gordura da barriga").eligible.includes("LED Laser"), "LED (viço) nao serve para gordura");
  // procedimento sem nenhuma queixa declarada fica de fora (nunca adivinhado)
  const e = concerns.eligibleProcedures(concerns.readObjective([{ text: "Quero clarear a coxa", createdAt: now }], now), [{ name: "Procedimento X", aliases: "", goals: "", benefits: "", description: "" }]);
  assert.deepEqual(e.eligible, []);
  assert.deepEqual(e.uninformed, ["Procedimento X"]);
});

test("modo de agendamento: campo explicito vence; texto aprovado so conta com exigencia explicita; sem nada = desconhecido (nao se presume direto)", () => {
  assert.deepEqual(conduct.bookingModeOf({ name: "X", bookingMode: "direct", description: "Exige avaliação prévia." }), { mode: "direct", source: "cadastro" });
  assert.deepEqual(conduct.bookingModeOf({ name: "X", bookingMode: "evaluation" }), { mode: "evaluation", source: "cadastro" });
  assert.deepEqual(conduct.bookingModeOf({ name: "X", description: "Protocolo que exige avaliação prévia." }), { mode: "evaluation", source: "texto_aprovado" });
  assert.deepEqual(conduct.bookingModeOf({ name: "X", description: "A evolução varia conforme o plano definido na avaliação." }), { mode: "unknown", source: "nenhuma" }, "frase solta sobre o plano nao e exigencia de avaliacao");
  assert.deepEqual(conduct.bookingModeOf({ name: "X", description: "Sessão de 30 minutos." }), { mode: "unknown", source: "nenhuma" });
});

test("recusa e 'vou pensar' sao lidos da propria conversa (persistem entre turnos e reiniciam so quando ela volta a falar de agenda)", () => {
  const oferta = { role: "assistant", content: "Quer que eu veja um horário pra você?" };
  assert.equal(conduct.declineStateOf([oferta, { role: "user", content: "vou pensar" }]), "thinking");
  assert.equal(conduct.declineStateOf([oferta, { role: "user", content: "não" }]), "offer_refused");
  assert.equal(conduct.declineStateOf([oferta, { role: "user", content: "só consigo aos sábados" }]), null, "recusar o horario propondo outro nao e recusa do atendimento");
  assert.equal(conduct.declineStateOf([oferta, { role: "user", content: "vou pensar" }, { role: "assistant", content: "Tudo bem! 💗" }, { role: "user", content: "quero agendar sim" }]), null, "voltou a falar de agenda");
  assert.equal(conduct.declineStateOf([{ role: "assistant", content: "Temos o Clareamento Corporal." }, { role: "user", content: "não" }]), null, "'nao' a algo que nao era uma oferta nao e recusa");
});

test("servico que a clinica nao oferece: luz pulsada e detectada, LEDterapia NAO e luz pulsada e nao ha substituicao automatica", () => {
  const termos = conduct.parseNotOffered("luz pulsada, luz intensa pulsada, IPL");
  assert.ok(conduct.notOfferedIn("Vocês fazem luz pulsada?", termos));
  assert.ok(conduct.notOfferedIn("Queria fazer IPL no rosto", termos));
  assert.equal(conduct.notOfferedIn("Vocês fazem LEDterapia?", termos), null, "LED e outra tecnologia, nao e o servico recusado");
  assert.equal(conduct.notOfferedIn("Quero depilação a laser", termos), null);
  const split = (t) => t.split(/(?<=[.!?])\s+/);
  const rem = (t, bad) => bad.reduce((a, s) => a.replace(s, ""), t).replace(/\s+/g, " ");
  assert.equal(conduct.stripNotOffered("Fazemos luz pulsada sim. Quer agendar?", termos, split, rem)?.includes("luz pulsada"), false);
  assert.equal(conduct.stripNotOffered("Não trabalhamos com luz pulsada.", termos, split, rem), null, "negar o servico nao e oferta: a frase fica");
});

test("trava das ferramentas de agenda (gateDecision): fechada, procedimento trocado, avaliacao no lugar, exige avaliacao", () => {
  const base = { schedulingOpen: true, schedulingReason: "", lockedProcedure: null, evaluationName: "Avaliação Estética", evaluationAllowed: true, blocked: null };
  assert.equal(conduct.gateDecision({ ...base, schedulingOpen: false, schedulingReason: "ela nao pediu horario" }, "check_availability", "Enzimas").allow, false);
  assert.equal(conduct.gateDecision(base, "check_availability", "Enzimas").allow, true);
  const travado = { ...base, lockedProcedure: "Clareamento Corporal", evaluationAllowed: false };
  assert.equal(conduct.gateDecision(travado, "book_appointment", "Clareamento Corporal").allow, true);
  const trocouPorAvaliacao = conduct.gateDecision(travado, "book_appointment", "Avaliação Estética");
  assert.equal(trocouPorAvaliacao.allow, false);
  assert.match(trocouPorAvaliacao.motivo, /nao se agenda avaliacao no lugar/);
  assert.equal(conduct.gateDecision(travado, "check_availability", "Enzimas").allow, false, "nao troca por outro procedimento");
  const exige = { ...base, blocked: { procedure: "Laser Etherea Melasma", motivo: "exige avaliacao previa (regra da clinica)", instrucao: "ofereca a avaliacao" } };
  assert.equal(conduct.gateDecision(exige, "book_appointment", "Laser Etherea Melasma").allow, false);
  assert.equal(conduct.gateDecision(exige, "book_appointment", "Avaliação Estética").allow, true, "a avaliacao em si continua permitida");
});

test("contatos nao comerciais: 'Ultima vaga' de anuncio nao e emprego; curriculo/fornecedor/parceria/cobranca sao; falsos positivos de paciente nao", () => {
  assert.equal(isJobSeeker("Tem vaga amanhã às 10h?", "Última vaga da semana - avaliação gratuita"), false);
  assert.equal(isJobSeeker("Tem vagas limitadas?", "Vagas limitadas para limpeza de pele"), false);
  assert.equal(isJobSeeker("Tenho interesse", "Estamos contratando esteticista - envie seu currículo"), true);
  assert.equal(isJobSeeker("Vocês têm vaga de esteticista?", ""), true);
  assert.equal(isJobSeeker("Segue meu currículo", ""), true);
  assert.equal(isJobSeeker("Tem vaga amanhã?", ""), false);
  assert.equal(nonPatientKind("Sou representante da empresa Dermo e gostaria de apresentar nossos produtos"), "fornecedor");
  assert.equal(nonPatientKind("Tenho uma proposta de parceria comercial para a clínica"), "parceria");
  assert.equal(nonPatientKind("Segunda via do boleto em aberto da empresa"), "cobranca");
  assert.equal(nonPatientKind("Tem parceria com convênio?"), null);
  assert.equal(nonPatientKind("Quanto custa a limpeza de pele?"), null);
});

// ================================================================ 2) generateReply (modelo simulado)

test("'gordura localizada' e QUEIXA, nao escolha de Enzimas: o modelo recebe a ordem de nao escolher, nao liberar horario, e a ferramenta de agenda e BARRADA", async () => {
  const c = await cenario(lisboa, "Joana Gordura", [["user", "Oi! Queria tratar gordura localizada na barriga"]]);
  const reply = await run(c, [
    { tool: { name: "check_availability", args: { procedure_name: "Enzimas" } } }, // o modelo tenta ir direto pra agenda
    { content: "Que bom que você me contou, Joana! Temos opções para gordura localizada. Qual região mais te incomoda? 💗" },
  ]);
  const sys = systemsOf(openaiCalls[0]);
  assert.match(sys, /Ela contou uma QUEIXA, NAO escolheu procedimento/);
  assert.doesNotMatch(sys, /PROCEDIMENTO ESCOLHIDO/, "queixa nao e procedimento escolhido");
  assert.match(aprovadasDe(sys), /Enzimas/, "Enzimas e aprovado no cadastro para gordura");
  const resultado = toolResults(openaiCalls[1]).join(" ");
  assert.match(resultado, /nao e momento de oferecer horario/, "ferramenta barrada: ela nao pediu horario");
  assert.ok(!/horarios\":\[\"/.test(resultado));
  assert.match(reply, /Qual região/);
  assert.equal(await prisma.appointment.count({ where: { patientId: c.patient.id } }), 0);
  assert.equal(await prisma.appointment.count({ where: { clinicId: lisboa.id, procedure: { name: { contains: "Avalia" } } } }), 0, "nenhuma avaliacao criada");
});

test("clareamento (coxa): so o aprovado para clareamento e indicado; Enzimas/gordura/celulite/flacidez nunca entram; resposta que sugere gordura e corrigida", async () => {
  const c = await cenario(lisboa, "Marina Clareamento", [["user", "Quero clarear a parte interna da coxa"]]);
  const reply = await run(c, [
    { content: "Temos o Clareamento Corporal pra isso! Também temos Enzimas para gordura localizada, quer conhecer?" }, // sugere gordura sem ela falar
    { content: "Temos o Clareamento Corporal pra isso! Qual região mais te incomoda?" },
  ]);
  const sys = systemsOf(openaiCalls[0]);
  assert.match(aprovadasDe(sys), /Clareamento Corporal/);
  assert.doesNotMatch(aprovadasDe(sys), /Enzimas/);
  assert.match(sys, /NAO sugira procedimentos para queixas que ela NAO citou/);
  assert.doesNotMatch(reply, /Enzimas|gordura/i, `a sugestao de gordura nao pode sair: ${reply}`);
  assert.match(reply, /Clareamento Corporal/, "so a frase errada saiu; a parte certa da resposta ficou");
  assert.doesNotMatch(reply, /avalia|\d{1,2}:\d{2}/i);
});

test("correcao ('na verdade quero clarear a virilha'): vale a ultima, a queixa anterior sai do cadastro indicado", async () => {
  const c = await cenario(lisboa, "Paula Corrige", [
    ["user", "Quero tirar gordura da barriga"],
    ["assistant", "Temos as Enzimas! Qual região mais incomoda?"],
    ["user", "Na verdade quero clarear a virilha"],
  ]);
  await run(c, [{ content: "Entendi! Para clarear a virilha temos o clareamento de áreas íntimas. 💗" }]);
  const sys = systemsOf(openaiCalls[0]);
  assert.match(aprovadasDe(sys), /Clareamento de Axilas/);
  assert.doesNotMatch(aprovadasDe(sys), /Enzimas/);
});

test("queixa SEM procedimento aprovado no cadastro (estrias): nao adivinha, orienta o modelo a encaminhar e a equipe recebe a conversa", async () => {
  const c = await cenario(lisboa, "Bia Estrias", [["user", "Tenho muitas estrias na barriga, o que vocês fazem?"]]);
  const reply = await run(c, [
    { tool: { name: "transfer_to_human", args: { reason: "Estrias: sem procedimento aprovado", summary: "Quer tratar estrias na barriga; sem indicação aprovada no cadastro." } } },
    { content: "Vou confirmar com a equipe quais opções temos pra estrias e já te retorno! 💗" },
  ]);
  const sys = systemsOf(openaiCalls[0]);
  assert.match(sys, /Nenhum procedimento do cadastro traz indicacao aprovada/);
  assert.doesNotMatch(sys, /PROCEDIMENTO ESCOLHIDO/);
  const conv = await reload(c);
  assert.equal(conv.humanTakeover || conv.handoffPending, true, "o encaminhamento usou o mecanismo real");
  assert.ok(typeof reply === "string");
});

test("so a REGIAO ('algo na barriga'): pergunta curta sobre o que tratar; lista de horarios do modelo e removida", async () => {
  const c = await cenario(lisboa, "Rita Regiao", [["user", "Quero fazer algo na barriga"]]);
  const reply = await run(c, [
    { content: "Perfeito! Tenho amanhã às 10:00 ou às 11:00, qual prefere?" },
    { content: "Claro! O que você gostaria de tratar na barriga: gordura, estrias, manchas, flacidez? 💗" },
  ]);
  const sys = systemsOf(openaiCalls[0]);
  assert.match(sys, /ELA CITOU SO A REGIAO/);
  assert.doesNotMatch(reply, /\d{1,2}:\d{2}/, `horario nao pode sair: ${reply}`);
  assert.match(reply, /gostaria de tratar/);
});

test("procedimento ESCOLHIDO que agenda direto: segue com ele, a avaliacao no lugar e BARRADA e nao e oferecida", async () => {
  const c = await cenario(lisboa, "Carla Direta", [["user", "Quero agendar Clareamento Corporal"]]);
  const reply = await run(c, [
    { tool: { name: "check_availability", args: { procedure_name: "Avaliação Estética" } } }, // erro tipico: troca por avaliacao
    { tool: { name: "check_availability", args: { procedure_name: "Clareamento Corporal" } } },
    { content: "Claro, Carla! O Clareamento Corporal agenda direto. Prefere manhã ou tarde? 💗" },
  ]);
  const sys = systemsOf(openaiCalls[0]);
  assert.match(sys, /PROCEDIMENTO ESCOLHIDO: "Clareamento Corporal" \(agenda direto\)/);
  assert.match(sys, /NAO ofereca nem mencione avaliacao/);
  assert.match(toolResults(openaiCalls[1]).join(" "), /nao se agenda avaliacao no lugar/);
  assert.doesNotMatch(lastTool(openaiCalls[2]), /nao se agenda avaliacao|nao e momento de oferecer horario|nao se troca/, "o procedimento escolhido passa pela trava");
  assert.doesNotMatch(reply, /avalia/i);
});

test("procedimento que EXIGE avaliacao (cadastro): o modelo explica a regra; agendar o procedimento direto e barrado, a avaliacao continua permitida", async () => {
  const c = await cenario(lisboa, "Dora Exige", [["user", "Quero agendar o Laser Etherea Melasma"]]);
  await run(c, [
    { tool: { name: "book_appointment", args: { procedure_name: "Laser Etherea Melasma", date: "2099-01-05", time: "10:00" } } },
    { content: "Pra esse laser a profissional faz uma avaliação antes. Quer que eu veja um horário pra avaliação? 💗" },
  ]);
  const sys = systemsOf(openaiCalls[0]);
  assert.match(sys, /exige avaliacao previa/);
  assert.match(toolResults(openaiCalls[1]).join(" "), /exige avaliacao previa/);
  assert.equal(await prisma.appointment.count({ where: { patientId: c.patient.id } }), 0);
});

test("clinica em MODO ESTRITO + procedimento sem regra cadastrada: a Alice nao presume direto nem cria avaliacao substituta; a equipe recebe, sem chamar o modelo", async () => {
  const c = await cenario(estrita, "Eva Estrita", [["user", "Quero agendar Peeling Químico"]]);
  openaiCalls.length = 0; script = [];
  const reply = await generateReply(c.conv.id);
  assert.equal(reply, "");
  assert.equal(openaiCalls.length, 0, "a decisao e do codigo, nao do modelo");
  const conv = await reload(c);
  assert.equal(conv.humanTakeover, true);
  assert.match(conv.handoffReason ?? "", /sem regra de agendamento/i);
  assert.equal(await prisma.appointment.count({ where: { patientId: c.patient.id } }), 0, "nenhuma reserva nem avaliacao criada");
});

test("clinica SEM modo estrito: procedimento sem regra mantem o comportamento anterior (agenda o procedimento escolhido) e nada muda para outras clinicas", async () => {
  const c = await cenario(outra, "Fabi Outra", [["user", "Quero agendar Limpeza de Pele"]]);
  await run(c, [{ content: "Claro, Fabi! Prefere manhã ou tarde?" }]);
  const sys = systemsOf(openaiCalls[0]);
  assert.match(sys, /PROCEDIMENTO ESCOLHIDO: "Limpeza de Pele"/);
  assert.doesNotMatch(sys, /SERVICO QUE A CLINICA NAO OFERECE/, "a lista de nao oferecidos e so da Lisboa");
});

test("'vou pensar': acolhe, nao oferece avaliacao nem horario, ferramenta de agenda barrada, decisao registrada (sem opt-out permanente)", async () => {
  const c = await cenario(lisboa, "Lia Pensa", [
    ["user", "Quero tratar celulite"],
    ["assistant", "Temos as Enzimas! Quer que eu veja um horário pra você?"],
    ["user", "Vou pensar"],
  ]);
  const reply = await run(c, [
    { tool: { name: "check_availability", args: { procedure_name: "Enzimas" } } },
    { content: "Claro, Lia! Fico à disposição quando quiser. 💗" },
  ]);
  const sys = systemsOf(openaiCalls[0]);
  assert.match(sys, /ELA DISSE QUE VAI PENSAR/);
  assert.match(toolResults(openaiCalls[1]).join(" "), /nao e momento de oferecer horario/);
  assert.doesNotMatch(reply, /avalia|\d{1,2}:\d{2}/i);
  assert.ok(await prisma.activityLog.findFirst({ where: { patientId: c.patient.id, type: "lead_decision" } }), "decisao registrada");
  const p = await prisma.patient.findUnique({ where: { id: c.patient.id } });
  assert.equal(p.noInterest, false, "vou pensar nao e desinteresse definitivo");
  // ela volta a falar de agenda: o assunto reabre (sem opt-out)
  await prisma.message.create({ data: { conversationId: c.conv.id, role: "assistant", content: reply, deliveryStatus: "sent" } });
  await prisma.message.create({ data: { conversationId: c.conv.id, role: "user", content: "Quero agendar sim, pode ver horário?" } });
  await run(c, [{ content: "Claro! Prefere manhã ou tarde?" }]);
  assert.doesNotMatch(systemsOf(openaiCalls[0]), /ELA DISSE QUE VAI PENSAR/);
});

test("recusa a oferta ('Nao'): uma frase curta, sem insistir em avaliacao/horario; segue valendo no turno seguinte ate ela pedir agenda", async () => {
  const c = await cenario(lisboa, "Mel Recusa", [
    ["user", "Tenho manchas no rosto"],
    ["assistant", "Temos o Laser Etherea Melasma. Quer que eu veja um horário de avaliação?"],
    ["user", "Não"],
  ]);
  const reply = await run(c, [
    { content: "Tudo bem! Posso agendar uma avaliação gratuita pra você quando quiser? 💗" }, // ainda oferece avaliacao
    { content: "Tudo bem, Mel! Qualquer coisa é só me chamar. 💗" },
  ]);
  assert.match(systemsOf(openaiCalls[0]), /ELA RECUSOU A OFERTA/);
  assert.doesNotMatch(reply, /avalia/i);
});

test("recusa de HORARIO com contraproposta ('so consigo aos sabados') nao e recusa do atendimento: o agendamento segue", async () => {
  const c = await cenario(lisboa, "Gabi Sabado", [
    ["user", "Quero agendar Clareamento Corporal"],
    ["assistant", "Tenho amanhã às 10:00 ou às 15:00. Qual prefere?"],
    ["user", "Só consigo aos sábados"],
  ]);
  await run(c, [
    { tool: { name: "check_availability", args: { procedure_name: "Clareamento Corporal" } } },
    { content: "Combinado, Gabi! Só aos sábados. Qual sábado fica melhor pra você? 💗" },
  ]);
  const sys = systemsOf(openaiCalls[0]);
  assert.doesNotMatch(sys, /ELA RECUSOU A OFERTA|ELA DISSE QUE VAI PENSAR/);
  assert.doesNotMatch(toolResults(openaiCalls[1]).join(" "), /nao e momento de oferecer horario/, "ainda e conversa de agenda");
});

test("'pode ser' a uma oferta de horarios aceita (abre a agenda); 'Ok.' solto depois de uma fala sem pergunta nao gera resposta nem chama o modelo", async () => {
  const a = await cenario(lisboa, "Nina Aceita", [
    ["user", "Quero agendar Limpeza de Pele"],
    ["assistant", "Claro! Quer que eu veja os horários mais próximos?"],
    ["user", "Pode ser"],
  ]);
  await run(a, [
    { tool: { name: "check_availability", args: { procedure_name: "Limpeza de Pele" } } },
    { content: "Perfeito! Prefere manhã ou tarde? 💗" },
  ]);
  assert.doesNotMatch(toolResults(openaiCalls[1]).join(" "), /nao e momento de oferecer horario/);
  const b = await cenario(lisboa, "Ola Ok", [
    ["user", "Obrigada pelas informações"],
    ["assistant", "Combinado! Qualquer coisa é só me chamar. 💗"],
    ["user", "Ok."],
  ]);
  const reply = await run(b, []);
  assert.equal(reply, "");
  assert.equal(openaiCalls.length, 0);
});

test("nome recebido para CONCLUIR agendamento em andamento e continuacao: nao reinicia a venda nem oferece avaliacao", async () => {
  const c = await cenario(lisboa, "Carol", [
    ["user", "Quero agendar Limpeza de Pele"],
    ["assistant", "Tenho amanhã às 10:00 ou às 11:00. Qual prefere?"],
    ["user", "10:00"],
    ["assistant", "Perfeito! Pra finalizar, qual é o seu nome completo?"],
    ["user", "Carolina Souza Lima"],
  ]);
  const reply = await run(c, [{ content: "Obrigada, Carolina! Já estou finalizando o seu horário. 💗" }]);
  const sys = systemsOf(openaiCalls[0]);
  assert.match(sys, /ELA ACABOU DE INFORMAR O NOME QUE VOCE PEDIU/);
  assert.match(sys, /NAO reinicie a venda, NAO ofereca avaliacao/);
  assert.doesNotMatch(sys, /PROCEDIMENTO ESCOLHIDO: "Avaliação/);
  assert.doesNotMatch(reply, /avalia/i);
});

test("depois da reserva concluida: agradecimento so encerra; nova reserva do MESMO procedimento no mesmo dia nao e criada; outro procedimento continua possivel", async () => {
  // "amanha" no calendario de Sao Paulo (nao no UTC: depois das 21h em SP o UTC ja virou o dia e "amanha" cairia em depois de amanha)
  const hojeSp = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const amanha = new Date(`${hojeSp}T13:00:00.000Z`); // 10:00 em Sao Paulo (sem horario de verao desde 2019)
  amanha.setUTCDate(amanha.getUTCDate() + 1);
  const c = await cenario(lisboa, "Tati Agendada", [
    ["user", "Quero agendar Clareamento Corporal"],
    ["assistant", "Pronto, Tati! Seu Clareamento Corporal está agendado. Te esperamos! 💗"],
    ["user", "Obrigada!"],
  ], { appt: { procedure: "Clareamento Corporal", when: amanha } });
  openaiCalls.length = 0; script = [];
  const fecha = await generateReply(c.conv.id);
  assert.equal(openaiCalls.length, 0, "agradecimento depois de agendar: sem modelo");
  assert.ok(!/avalia|hor[aá]rio\?/i.test(fecha), fecha);
  // tenta agendar de novo o mesmo procedimento no mesmo dia
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(amanha);
  await prisma.message.create({ data: { conversationId: c.conv.id, role: "assistant", content: fecha || "Por nada! 💗", deliveryStatus: "sent" } });
  await prisma.message.create({ data: { conversationId: c.conv.id, role: "user", content: "Quero agendar Clareamento Corporal amanhã às 14h" } });
  await run(c, [
    { tool: { name: "book_appointment", args: { procedure_name: "Clareamento Corporal", date: iso, time: "14:00", patient_full_name: "Tati Agendada Silva" } } },
    { content: "Você já tem o Clareamento Corporal amanhã às 10:00. Quer remarcar? 💗" },
  ]);
  assert.match(toolResults(openaiCalls[1]).join(" "), /JA tem Clareamento Corporal agendado nesse dia/);
  assert.equal(await prisma.appointment.count({ where: { patientId: c.patient.id, status: "confirmed" } }), 1, "sem reserva duplicada");
  // outro procedimento: a trava do procedimento escolhido muda para o novo e nao bloqueia
  await prisma.message.create({ data: { conversationId: c.conv.id, role: "assistant", content: "Você já tem o Clareamento Corporal amanhã às 10:00. Quer remarcar? 💗", deliveryStatus: "sent" } });
  await prisma.message.create({ data: { conversationId: c.conv.id, role: "user", content: "Quero agendar Limpeza de Pele também" } });
  await run(c, [
    { tool: { name: "check_availability", args: { procedure_name: "Limpeza de Pele" } } },
    { content: "Claro! A Limpeza de Pele agenda direto. Prefere manhã ou tarde? 💗" },
  ]);
  assert.doesNotMatch(lastTool(openaiCalls[1]), /nao se troca|nao e momento de oferecer horario|nao se agenda avaliacao/);
});

test("servico que a clinica NAO oferece (luz pulsada): honestidade, sem oferta, sem avaliacao substituta, sem troca automatica por LEDterapia; so na Lisboa", async () => {
  const c = await cenario(lisboa, "Vera Luz", [["user", "Vocês fazem luz pulsada?"]]);
  const reply = await run(c, [{ content: "Sim, fazemos luz pulsada! É ótima para manchas. Quer agendar uma avaliação?" }]);
  assert.match(systemsOf(openaiCalls[0]), /SERVICO QUE A CLINICA NAO OFERECE: ela citou "luz pulsada"/);
  assert.doesNotMatch(reply, /fazemos luz pulsada|luz pulsada!/i, `nao pode afirmar que faz: ${reply}`);
  assert.doesNotMatch(reply, /LED/i, "nao substitui automaticamente por LEDterapia");
  // negar o servico e valido e fica
  const d = await cenario(lisboa, "Vera Luz2", [["user", "Tem luz pulsada aí?"]]);
  const ok = await run(d, [{ content: "Não trabalhamos com luz pulsada por aqui. Me conta o que você gostaria de tratar? 💗" }]);
  assert.match(ok, /Não trabalhamos com luz pulsada/);
  // outra clinica (sem a lista): nada disso e imposto
  const o = await cenario(outra, "Vera Luz3", [["user", "Vocês fazem luz pulsada?"]]);
  await run(o, [{ content: "Me conta o que você gostaria de tratar? 💗" }]);
  assert.doesNotMatch(systemsOf(openaiCalls[0]), /SERVICO QUE A CLINICA NAO OFERECE/);
});

test("modo loja (Laleblu): nenhuma regra de clinica (queixa, avaliacao, agenda) entra na conversa", async () => {
  const c = await cenario(loja, "Cliente Loja", [["user", "Vocês têm essa bolsa em outras cores? Quero clarear..."]]);
  const reply = await run(c, [{ content: "Temos sim! Qual cor você prefere? 😊" }]);
  const sys = systemsOf(openaiCalls[0]);
  assert.doesNotMatch(sys, /OBJETIVO ATUAL DELA|PROCEDIMENTO ESCOLHIDO|ELA CITOU SO A REGIAO|SERVICO QUE A CLINICA NAO OFERECE/);
  assert.equal(reply, "Temos sim! Qual cor você prefere? 😊");
});

test("currículo / fornecedor / parceria / cobranca vao para a equipe em silencio; mensagem MISTA registra a parte de paciente; 'Ultima vaga' de anuncio e atendida como paciente", async () => {
  openaiCalls.length = 0;
  const cv = await cenario(lisboa, "Candidata", [["user", "Olá, envio meu currículo para a vaga de esteticista"]]);
  assert.equal(await run(cv, []), "");
  assert.equal((await reload(cv)).humanTakeover, true);
  assert.equal(openaiCalls.length, 0);

  const forn = await cenario(lisboa, "Representante", [["user", "Sou representante da empresa Dermo e gostaria de apresentar nossos produtos"]]);
  assert.equal(await run(forn, []), "");
  assert.match((await reload(forn)).handoffReason ?? "", /Fornecedor/);

  const mista = await cenario(lisboa, "Mista", [["user", "Segue meu currículo. Aliás, queria agendar uma limpeza de pele"]]);
  assert.equal(await run(mista, []), "");
  const cm = await reload(mista);
  assert.match(cm.handoffReason ?? "", /pedido de paciente/, "a parte clinica nao some: aparece no motivo para a equipe");
  const nota = await prisma.message.findFirst({ where: { conversationId: mista.conv.id, role: "human", content: { contains: "pedido de paciente" } } }) ?? await prisma.activityLog.findFirst({ where: { patientId: mista.patient.id, description: { contains: "pedido de paciente" } } });
  assert.ok(nota, "o resumo para a equipe cita o pedido de paciente");

  // anuncio de promocao ("Ultima vaga") NAO e vaga de emprego: a pessoa e atendida normalmente
  const promo = await cenario(lisboa, "Lead Promo", [["user", "Tem vaga amanhã às 10h?"]], { adName: "Última vaga da semana - avaliação gratuita" });
  const r = await run(promo, [{ content: "Claro! Prefere manhã ou tarde? 💗" }]);
  assert.ok(openaiCalls.length >= 1, "o modelo foi chamado: nao foi tratada como candidata a emprego");
  assert.notEqual(r, "");

  // quem mandou curriculo e agora pede horario de paciente nao fica presa no assunto da vaga
  const depois = await cenario(lisboa, "Depois CV", [
    ["user", "Segue meu currículo"],
    ["assistant", "Recebi! A equipe vai analisar. 💗"],
    ["user", "Quero agendar uma Limpeza de Pele"],
  ]);
  const r2 = await run(depois, [{ content: "Claro! Prefere manhã ou tarde? 💗" }]);
  assert.notEqual(r2, "");
  assert.ok(openaiCalls.length >= 1);
});

// ================================================================ 3) validacao final (revisao por IA nao desfaz as travas)

const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const mkCtx = (conversationId, over = {}) => ({
  conversationId, tz: "America/Sao_Paulo", now: new Date(), todayIso, situationKind: "default",
  forbidEvaluationOffer: false, forbidSlotOffer: false, request: emptyRequest(), trusted: false, agenda: true,
  actions: { booked: false, cancelled: false, rescheduled: false, transferred: false },
  evidence: { cancelledRecently: false, rescheduledRecently: false },
  slots: { state: newSlotState(), toolUsed: false, strict: { times: new Set(), dates: new Set() }, loose: { times: new Set(), dates: new Set() }, toolDates: [] },
  upcoming: [], complaintTexts: ["Quero clarear a coxa"], silentHandoff: false, ...over,
});
async function entrega(original, ctxOver, rewrite) {
  seq++;
  posts.length = 0;
  resetBreakerForTests();
  reviewFn = () => ({ decisao: "reescrever", confianca: "alta", motivo: "melhor", texto: rewrite });
  const patient = await prisma.patient.create({ data: { clinicId: lisboa.id, name: `Entrega ${seq}`, phone: `5511944${String(40000 + seq)}` } });
  const conv = await prisma.conversation.create({ data: { patientId: patient.id } });
  await prisma.message.create({ data: { conversationId: conv.id, role: "user", content: "Quero clarear a coxa", createdAt: new Date(Date.now() - 60_000) } });
  await prisma.message.create({ data: { conversationId: conv.id, role: "assistant", content: original, deliveryStatus: "pending" } });
  rememberReplyContext(mkCtx(conv.id, ctxOver), original);
  await deliverAliceReply(lisboa.id, patient.phone, conv.id, original);
  forgetReplyContext(conv.id, original);
  return posts.slice();
}

test("a revisao por IA NAO reintroduz avaliacao a quem recusou / escolheu procedimento direto: a reescrita e descartada e sai a original", async () => {
  process.env.AI_SEND_REVIEW = "on";
  const original = "Tudo bem, Mel! Qualquer coisa é só me chamar. 💗";
  const sent = await entrega(original, { forbidEvaluationOffer: true, forbidSlotOffer: true }, "Tudo bem, Mel! Posso agendar uma avaliação gratuita pra você? 💗");
  assert.deepEqual(sent, [original]);
});

test("a revisao por IA NAO sugere procedimento sem relacao com a queixa nem servico que a clinica nao oferece: a original sai", async () => {
  process.env.AI_SEND_REVIEW = "on";
  const original = "Para clarear a coxa temos o Clareamento Corporal. Qual região mais incomoda? 💗";
  const objective = { concerns: ["pigmentacao"], regions: ["coxas"] };
  const irrelevante = await entrega(original, { objective, allowedProcedures: ["Clareamento Corporal"] }, "Para a coxa temos Enzimas, ótimas para gordura localizada. Qual região mais incomoda? 💗");
  assert.deepEqual(irrelevante, [original]);
  const naoOferece = await entrega(original, { notOffered: ["luz pulsada"] }, "Fazemos luz pulsada para clarear a coxa. Qual região mais incomoda? 💗");
  assert.deepEqual(naoOferece, [original]);
});

test("checkFinalReply (validacao final): relevancia por queixa, servico nao oferecido, oferta de avaliacao e horarios nao pedidos sao apontados; texto correto passa", () => {
  const catalogo = CATALOGO.map((p) => ({ name: p.name, aliases: p.aliases, goals: p.goals, benefits: p.benefits, description: p.description }));
  const ctx = mkCtx("conv-x", { objective: { concerns: ["pigmentacao"], regions: ["coxas"] }, allowedProcedures: [], notOffered: ["luz pulsada"], forbidEvaluationOffer: true, forbidSlotOffer: true });
  const codes = (t) => checkFinalReply(t, ctx, { strict: false, catalog: catalogo }).map((p) => p.code);
  assert.ok(codes("Temos Enzimas para a coxa.").includes("relevance"));
  assert.ok(codes("Fazemos luz pulsada sim!").includes("not_offered"));
  assert.ok(!codes("Não trabalhamos com luz pulsada por aqui.").includes("not_offered"));
  assert.ok(codes("Posso agendar uma avaliação gratuita pra você?").includes("eval_offer"));
  assert.ok(codes("Tenho amanhã às 10:00 ou às 11:00, qual prefere?").some((c) => c === "slot_offer_forbidden" || c === "slot_unproven"));
  assert.deepEqual(codes("Para clarear a coxa temos o Clareamento Corporal. Qual região mais incomoda?"), []);
});

// ================================================================ 4) ajuste de cadastro da Lisboa (previa, idempotencia, restricao a uma clinica)

test("ajuste de conduta da Lisboa: a previa nao grava nada; aplicar e idempotente; limpa so o APELIDO 'luz pulsada'; nao liga o modo estrito sozinho; outra clinica fica intacta", async () => {
  const k = await mkClinic("Lisboa Ajuste Teste", {}, [
    { name: "Fototerapia Facial", aliases: "LEDterapia, luz pulsada", goals: "Viço", benefits: "", description: "Luz pulsada intensa para o rosto.", bookingMode: null },
    { name: "Enzimas", aliases: "Aplicação de enzimas", goals: "Gordura localizada", benefits: "", description: "", bookingMode: null },
  ]);
  await prisma.customRule.create({ data: { clinicId: k.id, category: "comercial", instruction: "Nunca pergunte 'quer agendar?'. Toda resposta deve terminar movendo adiante.", rawInput: "teste", status: "active" } });
  const intacta = await prisma.procedure.findFirst({ where: { clinicId: outra.id } });

  const previa = await ajustarCondutaLisboa(k.id, { dryRun: true });
  assert.equal(previa.dryRun, true);
  assert.deepEqual(previa.naoOferecidos.proposto.slice(0, 2), ["luz pulsada", "luz intensa pulsada"]);
  assert.ok(previa.ocorrencias.some((o) => o.acao === "apelido_removido"));
  assert.ok(previa.ocorrencias.some((o) => o.acao === "revisar_texto" && /Fototerapia/.test(o.trecho)), "o texto da descricao e so relatado, nao reescrito");
  assert.ok(previa.regrasEmConflito.length >= 1, "regra antiga que empurra horario e apontada");
  assert.equal(previa.modoAgendamento.semRegra, 2, "pendencia de informacao: nenhum procedimento tem regra de agenda");
  assert.equal((await prisma.clinic.findUnique({ where: { id: k.id } })).notOfferedServices, null, "previa nao grava");
  assert.match((await prisma.procedure.findFirst({ where: { clinicId: k.id, name: "Fototerapia Facial" } })).aliases, /luz pulsada/);

  const r1 = await ajustarCondutaLisboa(k.id, { dryRun: false, marcar: { direct: ["Enzimas"], evaluation: ["Nome Que Nao Existe"] } });
  assert.equal(r1.aplicado.naoOferecidos, true);
  assert.equal(r1.aplicado.apelidosLimpos, 1);
  assert.equal(r1.aplicado.marcados, 1);
  assert.equal(r1.aplicado.modoEstrito, false, "modo estrito e decisao da clinica: nao liga sozinho");
  assert.equal(r1.marcar.ignorados.length, 1, "nome inexistente e relatado, nao adivinhado");
  const foto = await prisma.procedure.findFirst({ where: { clinicId: k.id, name: "Fototerapia Facial" } });
  assert.equal(foto.aliases, "LEDterapia", "so o apelido do servico recusado saiu; o resto do cadastro fica");
  assert.equal(foto.description, "Luz pulsada intensa para o rosto.", "texto livre nao e reescrito");
  assert.equal((await prisma.procedure.findFirst({ where: { clinicId: k.id, name: "Enzimas" } })).bookingMode, "direct");

  const r2 = await ajustarCondutaLisboa(k.id, { dryRun: false, marcar: { direct: ["Enzimas"] } });
  assert.equal(r1.aplicado.ofertasSemCadastro, true, "Protocolo do Olhar entra como oferta sem cadastro (nao como servico recusado)");
  assert.equal((await prisma.clinic.findUnique({ where: { id: k.id } })).unmappedOffers, "Protocolo do Olhar");
  assert.deepEqual(r2.aplicado, { naoOferecidos: false, ofertasSemCadastro: false, apelidosLimpos: 0, marcados: 1, modoEstrito: false, regrasPadraoTrocadas: 0 }, "idempotente: nada novo alem da mesma marcacao");
  assert.equal((await prisma.clinic.findUnique({ where: { id: k.id } })).notOfferedServices, "luz pulsada, luz intensa pulsada, IPL, Endolaser, Endo laser");

  const estritoLigado = await ajustarCondutaLisboa(k.id, { dryRun: false, ativarModoEstrito: true });
  assert.equal(estritoLigado.aplicado.modoEstrito, true);

  const depois = await prisma.procedure.findFirst({ where: { clinicId: outra.id } });
  assert.deepEqual(depois, intacta, "outra clinica nao foi tocada");
  assert.equal((await prisma.clinic.findUnique({ where: { id: outra.id } })).notOfferedServices, null);
});

// ================================================================ 5) conversa de varios turnos, equipe, paciente cadastrada, log tecnico, rota

const confirmaEnvio = (c) => prisma.message.updateMany({ where: { conversationId: c.conv.id, role: "assistant", deliveryStatus: "pending" }, data: { deliveryStatus: "sent" } });
const fala = async (c, texto) => { await prisma.message.create({ data: { conversationId: c.conv.id, role: "user", content: texto } }); };

test("CONVERSA DE VARIOS TURNOS: queixa -> regiao -> pedido de horario -> 'vou pensar' -> volta e escolhe outro procedimento (cada turno com o contexto, as ferramentas e a resposta certos)", async () => {
  const c = await cenario(lisboa, "Helena Jornada", []);
  // turno 1: so a queixa
  await fala(c, "Oi! Queria tratar gordura localizada");
  let r = await run(c, [
    { tool: { name: "check_availability", args: { procedure_name: "Enzimas" } } },
    { content: "Oi, Helena! Que bom que você me contou. Qual região mais te incomoda? 💗" },
  ]);
  await confirmaEnvio(c);
  assert.match(systemsOf(openaiCalls[0]), /Ela contou uma QUEIXA, NAO escolheu procedimento/);
  assert.match(lastTool(openaiCalls[1]), /nao e momento de oferecer horario/, "t1: agenda fechada");
  assert.match(r, /Qual região/);
  // turno 2: a regiao (a queixa do turno 1 continua valendo)
  await fala(c, "Na barriga");
  r = await run(c, [{ content: "Entendi! Para gordura localizada temos as Enzimas. Quer saber mais ou ver um horário? 💗" }]);
  await confirmaEnvio(c);
  const sys2 = systemsOf(openaiCalls[0]);
  assert.match(sys2, /ha UMA opcao aprovada e ela ja disse a regiao/);
  assert.match(aprovadasDe(sys2), /Enzimas/);
  assert.doesNotMatch(sys2, /PROCEDIMENTO ESCOLHIDO/);
  // turno 3: pede horario -> a agenda abre
  await fala(c, "Quero sim, pode ver horário pra mim?");
  r = await run(c, [
    { tool: { name: "check_availability", args: { procedure_name: "Enzimas" } } },
    { content: "Claro! Prefere manhã ou tarde? 💗" },
  ]);
  await confirmaEnvio(c);
  assert.doesNotMatch(lastTool(openaiCalls[1]), /nao e momento de oferecer horario/, "t3: agenda aberta");
  // turno 4: vou pensar -> fecha, sem avaliacao
  await fala(c, "Vou pensar");
  r = await run(c, [
    { tool: { name: "check_availability", args: { procedure_name: "Enzimas" } } },
    { content: "Tudo bem, Helena! Fico à disposição. 💗" },
  ]);
  await confirmaEnvio(c);
  assert.match(lastTool(openaiCalls[1]), /nao e momento de oferecer horario/, "t4: agenda fechada de novo");
  assert.doesNotMatch(r, /avalia/i);
  // turno 5: volta e escolhe outro procedimento -> trava no procedimento novo
  await fala(c, "Oi, quero agendar a Limpeza de Pele");
  r = await run(c, [
    { tool: { name: "check_availability", args: { procedure_name: "Enzimas" } } }, // erro: procedimento antigo
    { tool: { name: "check_availability", args: { procedure_name: "Limpeza de Pele" } } },
    { content: "Claro! Prefere manhã ou tarde? 💗" },
  ]);
  assert.match(toolResults(openaiCalls[1]).at(-1), /nao se troca por outro procedimento/, "t5: nao usa o procedimento antigo");
  assert.doesNotMatch(lastTool(openaiCalls[2]), /nao se troca|nao e momento/, "t5: o escolhido passa");
});

test("retomada depois da equipe: a proposta da equipe aceita ('pode ser') mantem a agenda aberta para validar o horario antes de reservar", async () => {
  const c = await cenario(lisboa, "Ines Equipe", [
    ["user", "Quero agendar Limpeza de Pele"],
    ["human", "Oi, Ines! Consigo te encaixar sábado às 10:00 na Limpeza de Pele. Pode ser?", "Recepção"],
    ["user", "Pode ser"],
  ]);
  await run(c, [
    { tool: { name: "check_specific_time", args: { procedure_name: "Limpeza de Pele", date: "2099-01-03", time: "10:00" } } },
    { content: "Obrigada, Ines! Estou conferindo o horário. Qual o seu nome completo? 💗" },
  ]);
  assert.doesNotMatch(lastTool(openaiCalls[1]), /nao e momento de oferecer horario/, "a agenda esta aberta: a validacao do horario acontece pela ferramenta");
  assert.equal(await prisma.appointment.count({ where: { patientId: c.patient.id } }), 0, "nada foi reservado sem validar");
});

test("paciente JA cadastrada que escreve sobre vaga: vai para a equipe com o aviso de que ja e paciente (nao e descartada como candidata comum)", async () => {
  const antes = new Date(Date.now() - 10 * 24 * HOUR);
  const c = await cenario(lisboa, "Paciente Antiga", [["user", "Vocês têm vaga de esteticista? Quero mandar meu currículo"]], { appt: { procedure: "Limpeza de Pele", when: antes } });
  await prisma.appointment.updateMany({ where: { patientId: c.patient.id }, data: { status: "completed" } });
  assert.equal(await run(c, []), "");
  const nota = await prisma.message.findFirst({ where: { conversationId: c.conv.id, content: { contains: "paciente cadastrada" } } }) ?? await prisma.activityLog.findFirst({ where: { patientId: c.patient.id, description: { contains: "paciente cadastrada" } } });
  assert.ok(nota, "a equipe e avisada de que e paciente cadastrada");
});

test("registro tecnico da decisao: motivo, queixa, escolha e agenda ficam no log, SEM o texto da mensagem da pessoa", async () => {
  const linhas = [];
  const original = console.log;
  console.log = (...a) => { linhas.push(a.join(" ")); };
  try {
    const c = await cenario(lisboa, "Sigilo Teste", [["user", "Tenho celulite e vergonha disso, meu CPF é 123.456.789-09"]]);
    await run(c, [{ content: "Entendi, Sigilo! Qual região mais incomoda? 💗" }]);
  } finally { console.log = original; }
  const linha = linhas.find((l) => l.startsWith("[conduta]"));
  assert.ok(linha, "a decisao foi registrada");
  assert.match(linha, /queixa=celulite/);
  assert.match(linha, /agenda=fechada/);
  assert.match(linha, /revisao=2026-10-(19|20|21)/); // a revisao muda a cada lote: o que importa e que a linha leve a revisao
  assert.doesNotMatch(linha, /CPF|123\.456|vergonha/, "nada do conteudo da mensagem no log");
});

test("rota e botao: o ajuste de conduta e so para admin e so para a clinica da Lisboa (previa por padrao)", () => {
  const routes = fs.readFileSync(new URL("../src/api/routes.ts", import.meta.url), "utf8");
  const bloco = /"\/clinics\/lisboa-conduta"[\s\S]{0,1800}/.exec(routes)?.[0] ?? "";
  assert.ok(bloco, "a rota existe");
  assert.match(bloco, /requireAdmin\(req, res\)/);
  assert.match(bloco, /name: "Lisboa Beauty Center"/);
  assert.match(bloco, /dryRun: b\.dryRun !== false/, "previa e o padrao");
  assert.match(bloco, /ativarModoEstrito: b\.ativarModoEstrito === true/, "modo estrito so liga se pedido");
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="btn-lisboa-conduta"/);
  assert.match(html, /id="pr2-booking-mode"/);
});
