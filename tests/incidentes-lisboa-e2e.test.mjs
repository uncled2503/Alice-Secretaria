// INCIDENTES DA LISBOA (19-20/10/2026) DE PONTA A PONTA: generateReply + entrega (deliverAliceReply) com banco temporario e o MODELO SIMULADO (roteirizado).
// LIMITE: o modelo e simulado - estes testes provam o que o CODIGO envia ao modelo, libera, barra e entrega (reserva real x conclusao falada, fatos do cadastro, fotos, convite,
// pergunta informativa, expediente), nao como o modelo real redige. Dados FICTICIOS; nenhuma chamada paga e nenhuma mensagem real.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.TZ = "UTC";
const dbFile = path.join(os.tmpdir(), `alice-inc-e2e-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY = "test-key";
process.env.AI_SEND_REVIEW = "off";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

const openaiCalls = [];
let script = [];
const posts = []; // textos enviados pelo WhatsApp
let mediaPosts = 0;
let mediaMode = "ok"; // ok | falha
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
  if (u.hostname.endsWith("uazapi.com")) {
    if (u.pathname === "/send/text") { posts.push(JSON.parse(init.body).text); return jsonRes(200, { id: "msg" }); }
    if (u.pathname === "/send/media") {
      if (mediaMode === "falha") return jsonRes(500, { error: "fora do ar" });
      mediaPosts++;
      return jsonRes(200, { id: "media" });
    }
  }
  return jsonRes(200, { data: {}, id: "msg", instance: { status: "connected" }, status: { connected: true } });
};

const { prisma } = await import("../dist/db/client.js");
const { generateReply } = await import("../dist/ai/alice.js");
const { deliverAliceReply } = await import("../dist/uazapi/client.js");

const decisoes = [];
const origLog = console.log;
console.log = (...args) => { const s = args.join(" "); if (s.startsWith("[decisao]")) decisoes.push(s); else origLog(...args); };

test.after(async () => {
  console.log = origLog;
  await (await import("../dist/jobs/background.js")).drainBackground();
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* temporario */ } }
});

const TZ = "America/Sao_Paulo";
const HOUR = 3_600_000;
const clinic = await prisma.clinic.create({ data: { name: "Lisboa Incidentes", whatsappPhone: "5511900002222", timezone: TZ, plan: "prime", active: true, aliceActive: true, uazapiBaseUrl: "https://teste.uazapi.com", uazapiToken: "tok-inc", workDays: "0,1,2,3,4,5,6", workStartHour: 7, workEndHour: 22, closedOnHolidays: false, silentHandoff: false } });
const sabrina = await prisma.professional.create({ data: { clinicId: clinic.id, name: "Sabrina Alves", title: "Dra.", qualification: "Biomédica" } });
const adriana = await prisma.professional.create({ data: { clinicId: clinic.id, name: "Adriana Souza", title: "Dra." } });
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const mk = (data) => prisma.procedure.create({ data: { clinicId: clinic.id, durationMin: 30, ...data } });
await mk({ name: "Avaliação Estética" });
const hipro = await mk({ name: "Hipro", bookingMode: "direct", goals: "firmeza,flacidez", benefits: "melhora a firmeza da pele", description: "Tecnologia para firmeza." });
await mk({ name: "Criolipólise", durationMin: 90, bookingMode: "direct", goals: "gordura localizada", description: "Redução de gordura localizada por resfriamento." });
const peeling = await mk({ name: "Peeling Químico", bookingMode: "evaluation", goals: "cicatriz de acne\nmanchas", benefits: "uniformiza a textura da pele", description: "Peeling para textura e cicatrizes de acne." });
await prisma.procedurePhoto.createMany({ data: [{ procedureId: peeling.id, dataUrl: PNG, order: 1, caption: "Antes e depois" }, { procedureId: peeling.id, dataUrl: PNG, order: 2 }] });
const toxina = await mk({ name: "Toxina Botulínica", bookingMode: "direct", includedQuantity: "50 UI", goals: "rugas de expressão", description: "Aplicação de toxina botulínica." });
await prisma.professional.update({ where: { id: sabrina.id }, data: { procedures: { connect: [{ id: toxina.id }, { id: hipro.id }] } } });
await prisma.clinicFaq.create({ data: { clinicId: clinic.id, question: "Qual o horário de atendimento?", answer: "Atendemos de segunda a sábado, das 7h às 22h.", alternates: "dias e horários" } });

let seq = 0;
async function conversa(nome, mensagens) {
  seq++;
  const patient = await prisma.patient.create({ data: { clinicId: clinic.id, name: nome, phone: `551194444${String(1000 + seq)}` } });
  const conv = await prisma.conversation.create({ data: { patientId: patient.id } });
  let t = Date.now() - mensagens.length * 5 * 60_000;
  for (const [role, content, authorName] of mensagens) await prisma.message.create({ data: { conversationId: conv.id, role, content, authorName: authorName ?? null, createdAt: new Date((t += 5 * 60_000)), ...(role !== "user" ? { deliveryStatus: "sent" } : {}) } });
  return { patient, conv };
}
function amanha(h, m = 0) {
  const d = new Date(Date.now() + 24 * HOUR);
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const [y, mo, da] = iso.split("-").map(Number);
  return { date: iso, instant: new Date(Date.UTC(y, mo - 1, da, h + 3, m)) };
}
const systemsOf = (call) => call.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
const toolResults = (call) => call.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
// roda a geracao E a entrega (a validacao final e a escolha do texto acontecem na entrega)
async function turno(c, roteiro) {
  openaiCalls.length = 0; decisoes.length = 0; posts.length = 0; mediaPosts = 0; script = roteiro;
  const reply = await generateReply(c.conv.id);
  if (reply) await deliverAliceReply(clinic.id, c.patient.phone, c.conv.id, reply);
  return { reply, enviado: posts.slice() };
}
const apptCount = (c) => prisma.appointment.count({ where: { patientId: c.patient.id } });

// ===================================================================== MARIANA: aceite apos atendimento humano
const mariana = () => conversa("Mariana Souza", [
  ["user", "Queria marcar o Hipro amanhã por volta das 11:00 ou 12:00"],
  ["human", "Mariana, amanhã às 12h fica bom para o Hipro? Já te encaixo.", "Aline"],
  ["user", "pode ser sim"],
]);

test("MARIANA: 'pode ser sim' a proposta da equipe + modelo que 'confirma' sem reserva => refeito; se insistir, a afirmacao NAO sai e nada e agendado; a equipe e sinalizada", async () => {
  const c = await mariana();
  const claim = "Perfeito, Mariana! Fica confirmado o Hipro amanhã às 12:00. Te esperamos!";
  const r = await turno(c, [{ content: claim }, { content: claim }]);
  assert.equal(openaiCalls.length, 2, "a afirmacao sem reserva foi devolvida ao modelo uma vez");
  assert.match(systemsOf(openaiCalls[1]), /NAO existe reserva criada por book_appointment/);
  assert.match(systemsOf(openaiCalls[0]), /A EQUIPE \(pessoa de verdade\) estava combinando o horario/, "continua de onde a equipe parou");
  assert.equal(await apptCount(c), 0);
  assert.equal(r.enviado.length, 1);
  assert.doesNotMatch(r.enviado[0], /confirmad|agendad|marcad|te esperamos/i);
  assert.ok(r.enviado[0].length > 20, "saida util, o atendimento nao some em silencio");
});

test("MARIANA: com a ferramenta, a reserva e criada na data de HOJE+1 no fuso da clinica e so entao a Alice confirma", async () => {
  const c = await mariana();
  const dia = amanha(12);
  const r = await turno(c, [
    { content: "Perfeito, Mariana! Fica confirmado amanhã às 12:00." }, // tenta confirmar sem reserva
    { tool: { name: "check_specific_time", args: { procedure_name: "Hipro", date: dia.date, time: "12:00" } } },
    { tool: { name: "book_appointment", args: { procedure_name: "Hipro", date: dia.date, time: "12:00", patient_full_name: "Mariana Souza" } } },
    { content: "Pronto, Mariana! Agendei o Hipro para amanhã às 12:00." },
  ]);
  const appts = await prisma.appointment.findMany({ where: { patientId: c.patient.id } });
  assert.equal(appts.length, 1);
  assert.equal(appts[0].scheduledAt.getTime(), dia.instant.getTime() + 0, "12:00 do dia seguinte, no fuso da clinica");
  assert.equal(r.enviado.length, 1);
  assert.match(r.enviado[0], /Agendei o Hipro/);
});

// ===================================================================== VERUSKA: cliente e marido
test("VERUSKA: dois pacientes - a Alice recebe a regra de pessoas separadas; 'os dois agendados' sem duas reservas nao sai; a equipe recebe a pendencia; nada e agendado", async () => {
  const c = await conversa("Veruska Lima", [["user", "Tem horário às 18h30 ou 19h? Queria para mim e meu marido"], ["assistant", "Tenho quinta-feira, 29/10 às 18:30 e 19:00 com a Adriana. Qual você prefere?"], ["user", "Pode ser às 18:30 para os dois"]]);
  const claim = "Perfeito! Terça-feira, 29/10 às 18:30 com a Adriana para vocês dois. Está tudo confirmado!";
  const r = await turno(c, [{ content: claim }, { content: claim }]);
  assert.match(systemsOf(openaiCalls[0]), /AGENDAMENTO PARA MAIS DE UMA PESSOA/);
  assert.match(systemsOf(openaiCalls[0]), /NUNCA escreva 'os dois\/voces estao agendados/);
  assert.equal(await apptCount(c), 0);
  assert.equal(r.enviado.length, 1);
  assert.doesNotMatch(r.enviado[0], /confirmad|agendad|terça/i);
  assert.match(r.enviado[0], /nome completo e um telefone de contato de cada uma/);
  const conv = await prisma.conversation.findUnique({ where: { id: c.conv.id } });
  assert.equal(conv.humanTakeover, true, "pendencia visivel para a equipe (transferencia registrada)");
  const p = await prisma.patient.findUnique({ where: { id: c.patient.id } });
  assert.equal(p.name, "Veruska Lima", "a identidade da cliente nao foi alterada");
});

// ===================================================================== ROBELIA: formacao
test("ROBELIA: o cadastro leva a formacao da Sabrina (biomedica) e a regra de nao deduzir pelo 'Dra.'; resposta que a chama de medica nao sai", async () => {
  const c = await conversa("Robelia Santos", [["user", "Quero a toxina. Quem faz? É médica?"]]);
  const r = await turno(c, [{ content: "Geralmente nossas médicas fazem a aplicação. Posso agendar com a médica Dra. Sabrina Alves? Ela tem horário amanhã." }]);
  const sys = systemsOf(openaiCalls[0]);
  assert.match(sys, /Sabrina Alves \[formacao: Biomédica\]/);
  assert.match(sys, /FORMACAO PROFISSIONAL so existe se constar em \[formacao/);
  assert.equal(r.enviado.length, 1);
  assert.doesNotMatch(r.enviado[0], /m[eé]dica/i);
  const ok = await turno(await conversa("Robelia Dois", [["user", "A Sabrina é médica?"]]), [{ content: "A Sabrina é biomédica e faz a aplicação da toxina com todo cuidado." }]);
  assert.match(ok.enviado[0], /biomédica/);
});

// ===================================================================== ROBELIA / ORZY: quantidade da oferta
test("ORZY/ROBELIA: a oferta de 50 UI vai no cadastro; faixa inventada ('20 a 50 UI') nao sai; a quantidade da oferta e dita como esta", async () => {
  const c = await conversa("Orzy Pereira", [["user", "Quantas UI tem a oferta da toxina?"]]);
  const r = await turno(c, [{ content: "A quantidade varia, geralmente de 20 a 50 UI, conforme a avaliação." }]);
  const sys = systemsOf(openaiCalls[0]);
  assert.match(sys, /Quantidade INCLUIDA na oferta: 50 UI/);
  assert.match(sys, /NAO e recomendacao individual/);
  assert.doesNotMatch(r.enviado[0], /20 a 50/);
  const certo = await turno(await conversa("Orzy Dois", [["user", "Quantas UI tem a oferta?"]]), [{ content: "A oferta inclui 50 UI. A indicação individual de aplicação a profissional define na avaliação." }]);
  assert.match(certo.enviado[0], /50 UI/);
});

// ===================================================================== ORZY: expediente x vagas
test("ORZY: 'dias e horarios de atendimento' = expediente (nao abre a agenda); a ferramenta de vagas e barrada e a resposta segue o expediente", async () => {
  const c = await conversa("Orzy Horarios", [["user", "Quanto é a toxina?"], ["assistant", "A oferta inclui 50 UI. Quer que eu veja um horário?"], ["user", "Quais os dias e horários de atendimento?"]]);
  const r = await turno(c, [
    { tool: { name: "check_availability", args: { procedure_name: "Toxina Botulínica" } } },
    { content: "Atendemos de segunda a sábado, das 7h às 22h." },
  ]);
  assert.match(decisoes[0], /ferramentas=-/);
  assert.match(systemsOf(openaiCalls[0]), /EXPEDIENTE da clinica/);
  assert.match(toolResults(openaiCalls[1]).join(" "), /nao e momento de oferecer horario/);
  assert.match(r.enviado[0], /segunda a sábado/);
  assert.doesNotMatch(r.enviado[0], /\d{1,2}:\d{2}.*\d{1,2}:\d{2}/, "nao despeja vagas");
});

// ===================================================================== ELIANA: pergunta informativa
test("ELIANA: 'em quantas sessoes?' no meio da conversa de agenda e INFORMATIVA: agenda barrada; 'vou verificar e te aviso' sem acao e refeito e a equipe recebe a duvida", async () => {
  const c = await conversa("Eliana Costa", [["user", "Quero fazer criolipólise, tem horário?"], ["assistant", "A criolipólise leva cerca de 90 minutos de reserva. Quer que eu veja os horários?"], ["user", "Em quantas sessões é feito?"]]);
  const r = await turno(c, [
    { tool: { name: "check_availability", args: { procedure_name: "Criolipólise" } } },
    { content: "Vou verificar e já te aviso!" },
    { tool: { name: "transfer_to_human", args: { reason: "Pergunta sobre numero de sessoes sem cadastro", summary: "Eliana perguntou em quantas sessoes a criolipolise e feita; nao consta no cadastro." } } },
    { content: "Esse detalhe eu deixei com a equipe, que te responde em seguida." },
  ]);
  assert.match(systemsOf(openaiCalls[0]), /pergunta INFORMATIVA/);
  assert.match(toolResults(openaiCalls[1]).join(" "), /nao e momento de oferecer horario/);
  assert.match(systemsOf(openaiCalls[2]), /NAO executou a acao/, "a promessa sem acao foi devolvida ao modelo");
  const conv = await prisma.conversation.findUnique({ where: { id: c.conv.id } });
  assert.equal(conv.humanTakeover, true);
  assert.equal(await apptCount(c), 0);
  assert.doesNotMatch(r.enviado.join(" "), /vou verificar e j[aá] te aviso/i);
});

// ===================================================================== LIVIA: peeling + cicatriz de acne ; fotos
test("LIVIA: necessidade ja dita ('cicatriz de acne'): fotos aprovadas do PROPRIO procedimento, sem repetir a explicacao, sem 'estou a disposicao' e com convite concreto para a avaliacao", async () => {
  const c = await conversa("Livia Prado", [["user", "Oi, queria saber do peeling"], ["assistant", "O Peeling Químico renova a pele. O que você gostaria de tratar?"], ["user", "cicatriz de acne"]]);
  const r = await turno(c, [
    { tool: { name: "send_procedure_photos", args: { procedure_name: "Peeling Químico" } } },
    { content: "Que bom, Livia! O peeling ajuda na textura e em cicatrizes de acne. Se precisar de algo, estou à disposição!" },
  ]);
  assert.match(systemsOf(openaiCalls[0]), /FOTOS APROVADAS: "Peeling Químico"/);
  assert.equal(mediaPosts, 2, "as 2 fotos aprovadas foram enviadas");
  assert.match(toolResults(openaiCalls[1]).join(" "), /"enviado":true/);
  assert.doesNotMatch(r.enviado[0], /estou à disposição/i);
  assert.match(r.enviado[0], /Quer que eu veja um horário para sua avaliação\?$/);
  // mesmo pedido de novo: nao reenvia as mesmas fotos
  await prisma.message.create({ data: { conversationId: c.conv.id, role: "assistant", content: r.enviado[0], deliveryStatus: "sent" } });
  await prisma.message.create({ data: { conversationId: c.conv.id, role: "user", content: "pode me mandar as fotos de novo?" } });
  const again = await turno(c, [
    { tool: { name: "send_procedure_photos", args: { procedure_name: "Peeling Químico" } } },
    { content: "Já te enviei as fotos acima, Livia. Quer que eu tire alguma dúvida?" },
  ]);
  assert.equal(mediaPosts, 0, "nenhuma foto reenviada");
  assert.match(toolResults(openaiCalls[1]).join(" "), /ja_enviadas_nesta_conversa/);
  assert.ok(again.enviado.length >= 0);
});

test("FOTOS com falha: a ferramenta devolve enviado:false e 'te enviei as fotos' NAO sai; a conversa segue sem prometer imagem", async () => {
  mediaMode = "falha";
  try {
    const c = await conversa("Livia Falha", [["user", "Queria ver resultados do peeling"]]);
    const r = await turno(c, [
      { tool: { name: "send_procedure_photos", args: { procedure_name: "Peeling Químico" } } },
      { content: "Te enviei algumas fotos de resultado do peeling! Quer saber mais?" },
    ]);
    assert.match(toolResults(openaiCalls[1]).join(" "), /"enviado":false/);
    assert.equal(mediaPosts, 0);
    assert.doesNotMatch(r.enviado[0], /enviei/i);
  } finally { mediaMode = "ok"; }
});

test("FOTOS ausentes: procedimento sem fotos nao paralisa (a ferramenta avisa e a conversa segue)", async () => {
  const c = await conversa("Livia Sem Foto", [["user", "Tem foto de resultado da toxina?"]]);
  const r = await turno(c, [
    { tool: { name: "send_procedure_photos", args: { procedure_name: "Toxina Botulínica" } } },
    { content: "Ainda não tenho fotos desse procedimento para te enviar, mas posso te explicar como funciona. O que você gostaria de saber?" },
  ]);
  assert.match(toolResults(openaiCalls[1]).join(" "), /nenhuma foto cadastrada/);
  assert.equal(r.enviado.length, 1);
});

// ===================================================================== PAULA: preco e indicacao ; agradecimento
test("PAULA: valores que o cadastro nao sustenta ('R$ 250,00') nao saem; agradecimento depois do convite NAO provoca nova insistencia", async () => {
  const c = await conversa("Paula Mendes", [["user", "Tenho bolsas sob os olhos, o que vocês indicam?"]]);
  const r = await turno(c, [{ content: "Indicamos a Carboxiterapia por R$ 250,00 e o Skinbooster por R$ 890,00. Estou à disposição!" }]);
  assert.equal(r.enviado.length, 1);
  assert.doesNotMatch(r.enviado[0], /R\$/);
  const depois = await conversa("Paula Obrigada", [["user", "Tenho bolsas sob os olhos"], ["assistant", "Nesse caso a profissional avalia qual o melhor caminho. Quer que eu veja um horário para sua avaliação?"], ["user", "OK, obrigada"]]);
  const t = await turno(depois, []);
  assert.equal(openaiCalls.length, 0, "agradecimento: nem chama o modelo");
  assert.doesNotMatch(t.reply, /avalia|hor[aá]rio/i);
});

// ===================================================================== saudacao repetida
test("REPETICAO: 'Oi' de novo no meio da conversa e removido da resposta", async () => {
  const c = await conversa("Maria Oi", [["user", "Queria saber do Hipro"], ["assistant", "O Hipro trata flacidez e melhora a firmeza."], ["user", "Quanto tempo dura o efeito?"]]);
  const r = await turno(c, [{ content: "Oi, Maria! O efeito costuma ser percebido nas semanas seguintes, variando de pessoa para pessoa." }]);
  assert.doesNotMatch(r.reply, /^Oi/);
  assert.match(r.reply, /^O efeito/);
});

// ===================================================================== duas mensagens em sequencia = um turno
test("MENSAGENS AGRUPADAS: duas mensagens seguidas com perguntas diferentes sao lidas juntas; todas as perguntas ficam pendentes e a resposta e uma so", async () => {
  const c = await conversa("Eliana Dupla", [["user", "Quero saber da criolipólise"], ["assistant", "A criolipólise reduz gordura localizada. Quer saber mais?"], ["user", "Em quantas sessões é feito?"], ["user", "E inclui radiofrequência?"]]);
  const r = await turno(c, [{ content: "Sobre o número de sessões e o que a oferta inclui, vou confirmar com a equipe para te passar certinho." }, { tool: { name: "transfer_to_human", args: { reason: "sessoes e radiofrequencia nao cadastrados", summary: "Duvidas: numero de sessoes e se inclui radiofrequencia" } } }, { content: "Deixei suas duas dúvidas com a equipe." }]);
  const sys = systemsOf(openaiCalls[0]);
  assert.match(sys, /ELA PERGUNTOU VARIAS COISAS/);
  assert.match(sys, /Em quantas sessões é feito/);
  assert.match(sys, /inclui radiofrequência/);
  assert.equal(openaiCalls.length >= 1, true);
  assert.equal(r.enviado.length <= 1, true, "uma resposta so");
});

// ===================================================================== revisor ligado mas indisponivel: a afirmacao falsa continua barrada
test("REVISOR INDISPONIVEL: com a revisao por IA ligada e fora do ar a resposta sai sem ela, mas as travas deterministicas seguem barrando a afirmacao falsa", async () => {
  process.env.AI_SEND_REVIEW = "on";
  try {
    const c = await mariana();
    const claim = "Perfeito, Mariana! Fica confirmado o Hipro amanhã às 12:00. Te esperamos!";
    const r = await turno(c, [{ content: claim }, { content: claim }]);
    assert.equal(await apptCount(c), 0);
    assert.equal(r.enviado.length, 1);
    assert.doesNotMatch(r.enviado[0], /confirmad|agendad|te esperamos/i);
  } finally { process.env.AI_SEND_REVIEW = "off"; }
});

// ===================================================================== retomada depois da equipe
test("RETOMADA: Alice voltando depois que a equipe demorou NAO confirma a proposta da equipe sem reserva (mesma regra: so com a ferramenta)", async () => {
  const c = await mariana();
  openaiCalls.length = 0; posts.length = 0;
  const claim = "Combinado, Mariana! Seu horário ficou para amanhã às 12:00.";
  script = [{ content: claim }, { content: claim }];
  const reply = await generateReply(c.conv.id, { resumedAfterStaffDelay: true });
  if (reply) await deliverAliceReply(clinic.id, c.patient.phone, c.conv.id, reply);
  assert.equal(await apptCount(c), 0);
  assert.ok(posts.every((t) => !/ficou para|confirmad|agendad/i.test(t)));
  assert.match(systemsOf(openaiCalls[0]), /RETOMADA DO ATENDIMENTO/);
});
