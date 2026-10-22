// CONTINUIDADE COMERCIAL DE PONTA A PONTA (generateReply) com banco temporario e o MODELO SIMULADO (roteirizado). Confere o que o CODIGO envia ao modelo, o que corrige/bloqueia na saida e os
// EFEITOS NO BANCO (pendencia criada, nada agendado, uma unica resposta). LIMITE: o modelo e simulado - isto prova o contrato do codigo; o comportamento do modelo REAL nao e avaliado aqui
// (precisa de validacao controlada, sem contatos reais e com autorizacao para chamadas pagas). Nenhuma mensagem real, nenhuma chamada paga.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.TZ = "UTC";
const dbFile = path.join(os.tmpdir(), `alice-cont-e2e-${process.pid}-${Date.now()}.db`);
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
  return { id: "chatcmpl-test", object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "gpt-4o-mini", choices: [{ index: 0, message, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
}
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.includes("openai.com")) {
    const body = JSON.parse(init.body);
    if (!body.tools) return jsonRes(200, { id: "c", object: "chat.completion", created: 1, model: "gpt-4o-mini", choices: [{ index: 0, message: { role: "assistant", content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
    openaiCalls.push(body);
    const next = script.shift();
    if (!next) throw new Error("o roteiro do modelo acabou (chamada a mais do que o esperado)");
    return jsonRes(200, completion(typeof next === "function" ? next(body) : next));
  }
  return jsonRes(200, { data: {}, id: "msg" });
};

const { prisma } = await import("../dist/db/client.js");
const { generateReply } = await import("../dist/ai/alice.js");
const guard = await import("../dist/ai/replyGuard.js");
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
  { name: "Botox", aliases: "botox,toxina botulinica", goals: "rugas,linhas de expressao", benefits: "suaviza linhas de expressao", description: "Toxina botulinica.", bookingMode: "evaluation", durationMin: 30 },
  { name: "Despigmentação de Sobrancelhas", aliases: "remocao de micropigmentacao,despigmentacao", goals: "remover micropigmentacao", benefits: "", description: "Remocao de pigmento.", bookingMode: "evaluation", durationMin: 30, price: 199.99 },
  { name: "Remoção de Tatuagem", aliases: "remocao de tatuagem,tatuagem", goals: "tatuagem", benefits: "", description: "Remocao a laser.", bookingMode: "evaluation", durationMin: 30 },
  { name: "Lavieen Full Face", aliases: "lavieen", goals: "manchas,poros,textura", benefits: "melhora textura", description: "Laser para rejuvenescimento. A sessao dura cerca de 40 minutos.", bookingMode: "direct", durationMin: 45 },
  { name: "Carboxiterapia", aliases: "carboxi,carboxiterapia", goals: "estrias,flacidez,celulite,olheira,costas", benefits: "melhora circulacao", description: "Aplicacao de CO2. A sessao dura 15 minutos.", bookingMode: "direct", durationMin: 15 },
  { name: "Limpeza de Pele", aliases: "limpeza", goals: "acne,poros", benefits: "limpeza profunda", description: "Limpeza de pele profunda. Produtos hipoalergenicos.", bookingMode: "direct", durationMin: 60 },
];
const clinic = await prisma.clinic.create({ data: { name: "Clinica Continuidade", whatsappPhone: "5511900002222", timezone: "America/Sao_Paulo", plan: "prime", workDays: "0,1,2,3,4,5,6", workStartHour: 7, workEndHour: 22, closedOnHolidays: false, silentHandoff: false, notOfferedServices: "Endolaser, Endo laser" } });
await prisma.procedure.create({ data: { clinicId: clinic.id, name: "Avaliação Estética", durationMin: 30, bookingMode: "direct" } });
for (const p of CATALOGO) await prisma.procedure.create({ data: { clinicId: clinic.id, ...p } });

let seq = 0;
async function cenario(nome, mensagens, { briefing = null, humano = false } = {}) {
  seq++;
  const patient = await prisma.patient.create({ data: { clinicId: clinic.id, name: nome, phone: `551194444${String(1000 + seq)}`, ...(briefing ? { briefingNotes: briefing } : {}) } });
  const conv = await prisma.conversation.create({ data: { patientId: patient.id, humanTakeover: humano } });
  let t = Date.now() - mensagens.length * 60_000;
  for (const [role, content] of mensagens) await prisma.message.create({ data: { conversationId: conv.id, role, content, createdAt: new Date((t += 60_000)), ...(role === "assistant" ? { deliveryStatus: "sent" } : {}) } });
  return { patient, conv };
}
const systemsOf = (call) => call.messages.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
const run = async (c, roteiro) => { openaiCalls.length = 0; decisoes.length = 0; script = roteiro; return generateReply(c.conv.id); };
// O texto que SAI e o que a entrega valida com o contexto PERSISTIDO junto da mensagem pendente (inclusive o que a revisao por IA reescrever): reproduz esse passo.
async function textoEntregue(c, original) {
  const msg = await prisma.message.findFirst({ where: { conversationId: c.conv.id, role: "assistant", deliveryStatus: "pending" }, orderBy: { createdAt: "desc" } });
  const ctx = guard.deserializeReplyContext(msg?.replyContext ?? null, c.conv.id, []);
  assert.ok(ctx, "o contexto da geracao acompanha a mensagem");
  const catalog = await prisma.procedure.findMany({ where: { clinicId: clinic.id }, select: { name: true, aliases: true } });
  return guard.chooseFinalReply({ ctx, original, catalog }).text;
}
const FOTOS = "📷 3 foto(s) de resultado enviada(s): Botox";
const efeitos = async (c) => ({
  agendamentos: await prisma.appointment.count({ where: { patientId: c.patient.id } }),
  respostas: await prisma.message.count({ where: { conversationId: c.conv.id, role: "assistant", deliveryStatus: "pending" } }),
  conv: await prisma.conversation.findUnique({ where: { id: c.conv.id } }),
});

test("A. ANARA: 'gostei dos resultados' + modelo que so diz 'estou a disposicao': a saida convida para a AVALIACAO com pergunta, sem horarios e sem agendar", async () => {
  const c = await cenario("Anara", [["user", "Quero saber de botox"], ["assistant", "O Botox suaviza linhas de expressão. Quer ver alguns resultados?"], ["assistant", FOTOS], ["user", "Sim, gostei dos resultados apresentados."]]);
  const reply = await run(c, [{ content: "Que bom que você gostou! Estou à disposição para qualquer dúvida sobre o Botox." }]);
  assert.match(decisoes[0], /etapa=solucao/);
  const sys = systemsOf(openaiCalls[0]);
  assert.match(sys, /CONTINUIDADE: ela demonstrou interesse/);
  assert.match(sys, /ELA GOSTOU do que voce mostrou/);
  assert.doesNotMatch(reply, /à disposição|a disposicao/i);
  assert.match(reply, /avalia/i);
  assert.match(reply, /\?\s*\S*\s*$/u, "termina em pergunta simples");
  assert.doesNotMatch(reply, /\d{1,2}:\d{2}/, "nenhum horario listado");
  const ef = await efeitos(c);
  assert.equal(ef.agendamentos, 0);
  assert.equal(ef.respostas, 1);
});

test("B. WILMA: preco do cadastro + convite para a avaliacao; valor que so aparece no print e barrado", async () => {
  const c = await cenario("Wilma", [["user", "Oi, vi o anúncio de remoção de micropigmentação"], ["assistant", "Oi! Sobre o que gostaria de saber?"], ["user", "Qual o valor da despigmentação de sobrancelhas?"]]);
  const reply = await run(c, [{ content: "A despigmentação de sobrancelhas custa R$ 199,99 por sessão. Qualquer dúvida, estou à disposição." }]);
  const sys = systemsOf(openaiCalls[0]);
  assert.match(sys, /ELA PERGUNTOU O VALOR: responda o valor PRIMEIRO/);
  assert.match(reply, /199,99/);
  assert.doesNotMatch(reply, /à disposição/i);
  assert.match(reply, /avalia/i);
  // valor do print (nao esta no cadastro): a saida o barra
  const c2 = await cenario("Wilma Print", [["user", "Vi no anúncio que a remoção de micropigmentação sai por R$ 149,90"], ["assistant", "Oi! Posso te ajudar."], ["user", "Qual o valor da despigmentação de sobrancelhas?"]]);
  const reply2 = await run(c2, [{ content: "A despigmentação sai por R$ 149,90 por sessão, como no anúncio." }, { content: "{}" }]);
  assert.doesNotMatch(await textoEntregue(c2, reply2), /149,90/, "o valor do print nao e tabela (a entrega barra)");
  assert.match(await textoEntregue(c, reply), /199,99/, "o valor do cadastro passa");
});

test("C. KELLY: o modelo agenda 'o horario para a remocao' sem dizer que e a avaliacao: uma correcao deixa explicito; nada e agendado; sem validar 'poucas sessoes'", async () => {
  const c = await cenario("Kelly", [["user", "Quero remover uma tatuagem"], ["assistant", "Temos remoção de tatuagem a laser. Quer ver resultados?"], ["assistant", "📷 4 foto(s) de resultado enviada(s): Remoção de Tatuagem"], ["user", "Eu acredito que a minha não demore muitas sessões para resolver."]]);
  const reply = await run(c, [
    { content: "Vamos agendar um horário para a remoção da sua tatuagem e, assim, poderemos avaliar. Qual período fica melhor?" },
    { content: "Cada caso é diferente: o número de sessões quem define é a profissional, quando examina a sua tatuagem. Vamos agendar a sua avaliação? Qual período fica melhor pra você?" },
  ]);
  assert.equal(openaiCalls.length, 2, "exatamente UMA correcao (so quando ha violacao)");
  assert.match(systemsOf(openaiCalls[0]), /NAO valide nem contradiga/);
  assert.match(openaiCalls[1].messages.at(-1).content, /EXIGE avaliacao previa/);
  assert.match(reply, /avalia[cç][aã]o/i);
  assert.doesNotMatch(reply, /poucas sess|r[aá]pid/i);
  assert.equal((await efeitos(c)).agendamentos, 0);
});

test("D/E. NATHALIA: Lavieen em discussao + memoria antiga de Carboxiterapia: a ficha traz o FATO de duracao do Lavieen, o Lavieen vai nos detalhes (fixado) e a restricao das 18h30 chega ao modelo", async () => {
  const c = await cenario("Nathalia", [
    ["user", "Oi, queria saber do Lavieen"], ["assistant", "O Lavieen melhora a textura da pele. Qual região você quer tratar?"],
    ["user", "Costas. Só consigo depois das 18h30, saio do trabalho nesse horário"], ["assistant", "Entendi! O que você gostaria de melhorar nas costas?"],
    ["user", "E qual seria o procedimento? Demora quanto tempo?"],
  ], { briefing: "Interesse anterior: Carboxiterapia para as costas." });
  const reply = await run(c, [{ content: "O procedimento é o Lavieen Full Face e a sessão dura cerca de 40 minutos. Quer que eu veja um horário depois das 18h30?" }]);
  const sys = systemsOf(openaiCalls[0]);
  assert.match(sys, /FATO DE DURACAO.*SESSAO de "Lavieen Full Face": 40 minutos/s);
  assert.match(sys, /RESPONDA TODAS/);
  assert.match(sys, /PROCEDIMENTO ESCOLHIDO: "Lavieen Full Face"/);
  assert.match(sys, /DETALHES DOS PROCEDIMENTOS EM FOCO[\s\S]*Lavieen Full Face/);
  assert.match(sys, /so depois das 18:30/);
  assert.match(sys, /podem estar velhas/, "a memoria antiga e marcada como menos confiavel que a fala atual");
  assert.match(reply, /Lavieen/);
  assert.doesNotMatch(reply, /Carboxiterapia/);
  assert.match(decisoes[0], /proibido=.*trocar_o_procedimento_escolhido/);
});

test("H/J. PAULA: Endolaser nao e realizado: a saida tira a oferta e a promessa de valor; o outro interesse (olheiras) segue; ninguem e transferido por isso", async () => {
  const c = await cenario("Paula", [["user", "Oi"], ["assistant", "Oi! Em que posso ajudar?"], ["user", "Queria saber sobre endolaser no abdômen e também tenho olheiras"]]);
  const reply = await run(c, [{ content: "O Endolaser é uma excelente opção para o abdômen! Vou confirmar e te enviar os valores. Para as olheiras, a profissional avalia o seu caso na avaliação. Quer que eu veja um horário?" }]);
  const sys = systemsOf(openaiCalls[0]);
  assert.match(sys, /NAO realiza/);
  assert.match(sys, /OUTROS interesses dela/);
  assert.doesNotMatch(reply, /endolaser/i, "nada de oferecer o servico");
  assert.doesNotMatch(reply, /enviar os valores|confirmar e te enviar/i, "nada de prometer valor de servico que nao existe");
  assert.match(reply, /olheira/i);
  const ef = await efeitos(c);
  assert.equal(ef.conv.humanTakeover, false);
  assert.equal(ef.agendamentos, 0);
});

test("I. servico que NAO esta no cadastro nem na lista de nao realizados: o prompt manda confirmar com a equipe (sem afirmar que faz nem que nao faz)", async () => {
  const c = await cenario("Ultra", [["user", "Oi"], ["assistant", "Oi! Em que posso ajudar?"], ["user", "Vocês fazem ultraformer?"]]);
  await run(c, [{ content: "Vou confirmar com a equipe se esse tratamento está disponível e já te retorno." }]);
  const sys = systemsOf(openaiCalls[0]);
  assert.match(sys, /NAO LOCALIZADO\/INCERTO/);
  assert.match(sys, /NAO afirme que a clinica faz.*NAO afirme que nao faz/s);
  const ef = await efeitos(c);
  assert.equal(ef.conv.humanTakeover, true, "a promessa de retorno virou pendencia REAL para a equipe");
  assert.match(ef.conv.handoffReason ?? "", /equipe|confirmar/i);
});

test("K/L. TAISE: afirmacao inventada sobre o produto sai e vira pergunta de esclarecimento; sem 'vou verificar' vazio (pendencia real quando a equipe e prometida)", async () => {
  const c = await cenario("Taise", [["user", "Qual marca vocês usam na limpeza de pele?"], ["assistant", "Utilizamos Cosmobeauty."], ["user", "Porque ele também tem refrescancia eu não uso produtos com refrescancia."]]);
  const reply = await run(c, [{ content: "O produto utilizado na Limpeza de Pele tem refrescância, mas podemos personalizar o atendimento. Qualquer dúvida, estou à disposição." }]);
  const sys = systemsOf(openaiCalls[0]);
  assert.match(sys, /AMBIGUO/);
  assert.doesNotMatch(reply, /tem refresc/i, "a fala dela nao vira fato sobre o produto");
  assert.match(reply, /sensação de frescor\/gelado.*perfume\/cheiro/s);
  assert.doesNotMatch(reply, /garant|sem problema algum/i);
  // promessa de acompanhamento sem ferramenta: pendencia real
  const c2 = await cenario("Taise Dois", [["user", "Qual marca vocês usam na limpeza de pele?"], ["assistant", "Utilizamos Cosmobeauty."], ["user", "Esse produto tem perfume? Não uso nada com perfume."]]);
  await run(c2, [{ content: "Vou verificar com a equipe e te retorno com essa informação." }]);
  const ef = await efeitos(c2);
  assert.equal(ef.conv.humanTakeover, true);
  assert.equal(ef.conv.handoffPending, true);
});

test("M/N/O. recusa/pedido de tempo, ja agendada e atendimento humano ativo: nenhum convite e nenhuma resposta indevida", async () => {
  const pensa = await cenario("Pensa", [["user", "Quero saber de botox"], ["assistant", "Quer que eu veja um horário para a sua avaliação?"], ["user", "Gostei, mas vou pensar com calma"]]);
  const r1 = await run(pensa, [{ content: "Claro, sem pressa! Fico por aqui se precisar. 💗" }]);
  assert.doesNotMatch(r1, /quer que eu veja um hor[aá]rio/i);
  assert.match(decisoes[0], /etapa=pensando/);

  const agendada = await cenario("Agendada", [["user", "Quero botox"], ["assistant", "Agendado para quinta!"], ["user", "Gostei dos resultados que você mandou"]]);
  await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: agendada.patient.id, procedureId: (await prisma.procedure.findFirst({ where: { clinicId: clinic.id, name: "Avaliação Estética" } })).id, scheduledAt: new Date(Date.now() + 2 * 86_400_000), source: "whatsapp" } });
  const r2 = await run(agendada, [{ content: "Que bom que gostou! Te esperamos. 💗" }]);
  assert.doesNotMatch(r2, /quer que eu veja um hor[aá]rio|nova avalia/i);
  assert.match(decisoes[0], /etapa=agendado/);

  const humano = await cenario("Humano", [["user", "Gostei dos resultados"]], { humano: true });
  const r3 = await run(humano, []);
  assert.equal(r3, "");
  assert.equal(openaiCalls.length, 0, "atendimento humano ativo: a Alice nao gera resposta");
});

test("V. mensagens consecutivas: UMA resposta, com o contexto COMPLETO das mensagens novas (regiao + restricao + pergunta)", async () => {
  const c = await cenario("Consecutivas", [["user", "Oi, queria saber do Lavieen"], ["assistant", "O Lavieen melhora a textura. Qual região?"], ["user", "É nas costas"], ["user", "Só consigo depois das 18h30"], ["user", "Quanto tempo demora?"]]);
  const reply = await run(c, [{ content: "A sessão do Lavieen dura cerca de 40 minutos e posso ver um horário depois das 18h30. Quer que eu veja?" }]);
  const sys = systemsOf(openaiCalls[0]);
  assert.match(sys, /so depois das 18:30/);
  assert.match(sys, /FATO DE DURACAO/);
  assert.match(sys, /Quanto tempo demora/);
  assert.equal(openaiCalls.length, 1);
  assert.equal((await efeitos(c)).respostas, 1, "uma unica resposta pendente (nada concorrente)");
  assert.match(reply, /40 minutos/);
});
