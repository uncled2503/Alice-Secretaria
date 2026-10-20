// VENDEDORA CONSULTIVA DE PONTA A PONTA (generateReply) com banco temporario e o MODELO SIMULADO (roteirizado). Confere o que o CODIGO envia ao modelo, o que bloqueia e o que
// entrega. LIMITE: o modelo e simulado - provam o contrato do codigo (decisao do turno, ferramentas liberadas/barradas, resposta final validada), nao o comportamento do modelo real.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.TZ = "UTC";
const dbFile = path.join(os.tmpdir(), `alice-vend-e2e-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY = "test-key";
process.env.AI_SEND_REVIEW = "off";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const openaiCalls = [];
let script = [];
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function completion({ content = null, tool = null }) {
  const message = { role: "assistant", content, ...(tool ? { tool_calls: [{ id: `call_${Math.random().toString(36).slice(2)}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : {}) };
  return { id: "chatcmpl-test", object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "gpt-4o-mini", choices: [{ index: 0, message, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
}
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.includes("openai.com")) {
    const body = JSON.parse(init.body);
    if (!body.tools) return jsonRes(200, { id: "c", object: "chat.completion", created: 1, model: "gpt-4o-mini", choices: [{ index: 0, message: { role: "assistant", content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    openaiCalls.push(body);
    const next = script.shift();
    if (!next) throw new Error("o roteiro do modelo acabou (chamada a mais do que o esperado)");
    return jsonRes(200, completion(typeof next === "function" ? next(body) : next));
  }
  return jsonRes(200, { data: {}, id: "msg" });
};

const { prisma } = await import("../dist/db/client.js");
const { generateReply } = await import("../dist/ai/alice.js");

// captura as linhas tecnicas [decisao] (uma por turno)
const decisoes = [];
const origLog = console.log;
console.log = (...args) => { const s = args.join(" "); if (s.startsWith("[decisao]")) decisoes.push(s); else origLog(...args); };

test.after(async () => {
  console.log = origLog;
  await (await import("../dist/jobs/background.js")).drainBackground();
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* temporario */ } }
});

const CATALOGO = [
  { name: "Hipro", aliases: "hipro", goals: "firmeza,flacidez", benefits: "melhora a firmeza da pele do rosto", description: "Tecnologia para flacidez e firmeza.", bookingMode: "direct" },
  { name: "Enzima GL Abdomen", aliases: "enzima abdomen", goals: "gordura,gordura localizada,barriga", benefits: "reduz gordura localizada no abdomen", description: "Reducao de gordura localizada.", bookingMode: "direct" },
];
const clinic = await prisma.clinic.create({ data: { name: "Clinica Vendedora", whatsappPhone: "5511900001111", timezone: "America/Sao_Paulo", plan: "prime", workDays: "0,1,2,3,4,5,6", workStartHour: 7, workEndHour: 22, closedOnHolidays: false, silentHandoff: true, strictBookingRules: true } });
await prisma.procedure.create({ data: { clinicId: clinic.id, name: "Avaliação Estética", durationMin: 30 } });
for (const p of CATALOGO) await prisma.procedure.create({ data: { clinicId: clinic.id, durationMin: 30, ...p } });

let seq = 0;
async function cenario(nome, mensagens) {
  seq++;
  const patient = await prisma.patient.create({ data: { clinicId: clinic.id, name: nome, phone: `551195555${String(1000 + seq)}` } });
  const conv = await prisma.conversation.create({ data: { patientId: patient.id } });
  let t = Date.now() - mensagens.length * 60_000;
  for (const [role, content] of mensagens) await prisma.message.create({ data: { conversationId: conv.id, role, content, createdAt: new Date((t += 60_000)), ...(role === "assistant" ? { deliveryStatus: "sent" } : {}) } });
  return { patient, conv };
}
const systemsOf = (call) => call.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
const toolResults = (call) => call.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
const run = async (c, roteiro) => { openaiCalls.length = 0; decisoes.length = 0; script = roteiro; return generateReply(c.conv.id); };

test("'nao' depois de 'ja fez antes?': a decisao registra experiencia nenhuma, a agenda continua fechada e o modelo recebe a ordem de avancar sem repetir a pergunta", async () => {
  const c = await cenario("Bia Primeira", [["user", "Oi, queria saber do Hipro"], ["assistant", "Oi, Bia! O Hipro é para firmeza do rosto. Você já fez algum procedimento parecido antes?"], ["user", "Não"]]);
  const reply = await run(c, [
    { tool: { name: "check_availability", args: { procedure_name: "Hipro" } } }, // erro tipico: foi direto para a agenda
    { content: "Tranquilo, Bia! Para quem faz pela primeira vez o Hipro é feito em uma sessão rápida e você pode me perguntar o que quiser. 💗" },
  ]);
  assert.equal(decisoes.length, 1);
  assert.match(decisoes[0], /resposta_curta=experience_none/);
  assert.match(decisoes[0], /ferramentas=-/);
  assert.match(systemsOf(openaiCalls[0]), /NUNCA fez/);
  assert.match(toolResults(openaiCalls[1]).join(" "), /nao e momento de oferecer horario/, "a ferramenta de agenda foi barrada: ela nao pediu horario");
  assert.doesNotMatch(reply, /\d{1,2}:\d{2}/);
  assert.equal(await prisma.appointment.count({ where: { patientId: c.patient.id } }), 0);
});

test("'vou pensar, mas quanto tempo dura?': a ordem manda responder a pergunta; a agenda continua fechada; a decisao registra a pergunta pendente", async () => {
  const c = await cenario("Lu Pensa", [["user", "Queria saber do Hipro"], ["assistant", "O Hipro trata flacidez. Quer ver um horário para a avaliação?"], ["user", "Vou pensar, mas quanto tempo dura?"]]);
  const reply = await run(c, [{ content: "Sem pressa, Lu! A sessão dura cerca de 30 minutos. Qualquer coisa é só me chamar 💗" }]);
  assert.match(decisoes[0], /etapa=pensando acao=responder_perguntas/);
  assert.match(decisoes[0], /perguntas=1/);
  const sys = systemsOf(openaiCalls[0]);
  assert.match(sys, /ELA PERGUNTOU/);
  assert.match(sys, /quanto tempo dura/);
  assert.match(reply, /30 minutos/);
});

test("'achei caro' depois de uma queixa: a objecao e respondida com prioridade (a conducao por queixa nao a engole); sem desconto inventado", async () => {
  const c = await cenario("Raquel Preco", [["user", "Quero tratar gordura na barriga"], ["assistant", "Temos a Enzima GL Abdomen, que reduz gordura localizada. O valor é apresentado pela equipe."], ["user", "Achei caro"]]);
  await run(c, [{ content: "Entendo, Raquel. A equipe apresenta as condições; posso te explicar como funciona a Enzima?" }]);
  const sys = systemsOf(openaiCalls[0]);
  assert.match(sys, /OBJECAO DE PRECO/);
  assert.match(sys, /NAO invente desconto/);
  assert.match(decisoes[0], /objecao=price/);
  assert.match(decisoes[0], /proibido=[^ ]*inventar_urgencia_ou_condicao/);
});

test("pedido de desconto: a ordem proibe prometer e manda a equipe; o modelo que promete desconto nao e obedecido pela agenda (nada e agendado)", async () => {
  const c = await cenario("Dani Desconto", [["user", "Quanto custa o Hipro?"], ["assistant", "O valor do Hipro é apresentado pela equipe."], ["user", "Se eu fechar hoje tem desconto?"]]);
  await run(c, [{ tool: { name: "transfer_to_human", args: { reason: "pediu desconto", summary: "Perguntou se ha desconto ao fechar hoje" } } }, { content: "" }]);
  const sys = systemsOf(openaiCalls[0]);
  assert.match(sys, /Ela pediu DESCONTO/);
  assert.match(decisoes[0], /proibido=[^ ]*prometer_desconto/);
  assert.equal((await prisma.conversation.findUnique({ where: { id: c.conv.id } })).humanTakeover, true);
});

test("falha de ferramenta sem falsa promessa: horario recusado pela agenda + modelo diz 'agendado' => a Alice barra a afirmacao e nada e agendado", async () => {
  const c = await cenario("Tati Falha", [["user", "Quero fazer o Hipro"], ["assistant", "Perfeito! Tenho amanhã às 03:00? Qual horário prefere?"], ["user", "Quero amanhã às 03:00, Tatiane Souza Lima"]]);
  const reply = await run(c, [
    { tool: { name: "book_appointment", args: { procedure_name: "Hipro", date: new Date(Date.now() + 36 * 3_600_000).toISOString().slice(0, 10), time: "03:00", patient_full_name: "Tatiane Souza Lima" } } },
    { content: "Pronto, Tatiane! Seu Hipro está agendado para amanhã às 03:00. 💗" }, // falsa confirmacao: a ferramenta recusou
    { content: "Esse horário não está disponível, Tatiane. Posso te passar outros horários do Hipro?" },
    { content: "Esse horário não está disponível, Tatiane. Posso te passar outros horários do Hipro?" },
  ]);
  assert.equal(await prisma.appointment.count({ where: { patientId: c.patient.id } }), 0, "nada foi agendado");
  assert.doesNotMatch(reply, /agendado|agendei|confirmad/i, `a falsa confirmacao nao pode sair: ${reply}`);
});

test("o numero de chamadas ao modelo nao aumenta com a leitura do turno: um turno comercial normal continua sendo UMA chamada principal", async () => {
  const c = await cenario("Eli Simples", [["user", "Oi"], ["assistant", "Oi! Como posso ajudar?"], ["user", "Quanto tempo dura o Hipro?"]]);
  await run(c, [{ content: "O Hipro dura cerca de 30 minutos. Quer saber mais alguma coisa? 💗" }]);
  assert.equal(openaiCalls.length, 1);
  assert.equal(decisoes.length, 1);
});
