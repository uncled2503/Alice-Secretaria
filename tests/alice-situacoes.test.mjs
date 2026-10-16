// A ALICE DE PONTA A PONTA (generateReply) com banco de verdade (SQLite temporario) e a OpenAI simulada por um fetch falso (respostas roteirizadas).
// Reproduz os casos dos prints da Lisboa de 16/10/2026: nao oferecer avaliacao a quem ja tem horario, "vou cancelar" sem cancelar,
// remarcar de verdade, horario que nao bate vai pra equipe, agradecimento a mensagem automatica so agradece.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dbFile = path.join(os.tmpdir(), `alice-situacoes-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY = "test-key";
const root = fileURLToPath(new URL("..", import.meta.url));
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: root, env: process.env, stdio: "pipe" });

// fetch falso ANTES de carregar a Alice (o cliente da OpenAI pega o fetch na criacao)
const openaiCalls = []; // corpo de cada chamada com ferramentas
const auxCalls = []; // chamadas SEM ferramentas (segunda leitura da conversa)
let script = []; // respostas do "modelo", na ordem
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.includes("openai.com")) {
    const body = JSON.parse(init.body);
    if (!body.tools) { auxCalls.push(body); return jsonRes(200, completion({ content: "{}" })); } // segunda leitura ou reescrita: sem ferramentas
    openaiCalls.push(body);
    const next = script.shift();
    if (!next) throw new Error("o roteiro do modelo acabou (chamada a mais do que o esperado)");
    return jsonRes(200, completion(typeof next === "function" ? next(body) : next));
  }
  return jsonRes(200, { data: {} }); // UAZAPI / outros: aceita
};
function completion({ content = null, tool = null }) {
  const message = { role: "assistant", content, ...(tool ? { tool_calls: [{ id: `call_${Math.random().toString(36).slice(2)}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : {}) };
  return { id: "chatcmpl-test", object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "gpt-4o-mini", choices: [{ index: 0, message, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
}

const { prisma } = await import("../dist/db/client.js");
const { generateReply } = await import("../dist/ai/alice.js");

test.after(async () => {
  await prisma.$disconnect();
  for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* arquivo temporario */ } }
});

const TZ = "America/Sao_Paulo";
const clinic = await prisma.clinic.create({
  data: { name: "Clinica Situacoes", whatsappPhone: "5511900000003", timezone: TZ, plan: "prime", workDays: "0,1,2,3,4,5,6", workStartHour: 7, workEndHour: 22, closedOnHolidays: false, silentHandoff: true },
});
const hipro = await prisma.procedure.create({ data: { clinicId: clinic.id, name: "Hipro", durationMin: 30 } });
const avaliacao = await prisma.procedure.create({ data: { clinicId: clinic.id, name: "Avaliação Estética", durationMin: 30 } });

const HOUR = 3_600_000;
// amanha as HH:MM no fuso da clinica (America/Sao_Paulo = UTC-3, sem horario de verao)
function amanha(h, m = 0) {
  const d = new Date(Date.now() + 24 * HOUR);
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const [y, mo, da] = iso.split("-").map(Number);
  return { date: iso, instant: new Date(Date.UTC(y, mo - 1, da, h + 3, m)) };
}

let seq = 0;
async function cenario(nome, mensagens, { appt = null } = {}) {
  seq++;
  const patient = await prisma.patient.create({ data: { clinicId: clinic.id, name: nome, phone: `551197777${String(1000 + seq)}` } });
  const conv = await prisma.conversation.create({ data: { patientId: patient.id } });
  let t = Date.now() - mensagens.length * 60_000;
  for (const [role, content, authorName] of mensagens) {
    await prisma.message.create({ data: { conversationId: conv.id, role, content, authorName: authorName ?? null, createdAt: new Date((t += 60_000)) } });
  }
  const appointment = appt ? await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: patient.id, procedureId: appt.procedureId, scheduledAt: appt.when, source: "presencial" } }) : null;
  return { patient, conv, appointment };
}
const reload = (c) => prisma.conversation.findUnique({ where: { id: c.conv.id } });

test("Maria: diz um horario que nao bate com a agenda da Alice -> equipe em silencio, sem oferecer nada e sem chamar o modelo", async () => {
  openaiCalls.length = 0;
  script = [];
  const c = await cenario("Maria da Conceição", [["user", "Meu horário é às 13:15 hs"]], { appt: { procedureId: avaliacao.id, when: amanha(8).instant } });
  const reply = await generateReply(c.conv.id);
  assert.equal(reply, "");
  const conv = await reload(c);
  assert.equal(conv.humanTakeover, true);
  assert.match(conv.handoffReason ?? "", /horario/i);
  assert.equal(openaiCalls.length, 0);
});

test("Aline: 'Obrigada' a pesquisa/pos automatica so agradece (nada de horarios de avaliacao)", async () => {
  openaiCalls.length = 0;
  script = [];
  const c = await cenario("Aline Teste", [
    ["assistant", "Oi, 💗 Como foi sua experiência aqui na Lisboa? De 0 a 10, que nota você daria para o seu atendimento conosco?", "Pesquisa de satisfação"],
    ["assistant", "Oi, Aline! Passando para saber como sua pele está hoje após Limpeza de Pele.", "Pós-procedimento automático"],
    ["user", "Obrigada"],
  ]);
  const reply = await generateReply(c.conv.id);
  assert.match(reply, /Por nada, Aline/);
  assert.ok(!/avalia|hor[aá]rio/i.test(reply), reply);
  assert.equal(openaiCalls.length, 0);
});

test("Bruna: avisou que nao vai -> o modelo disse 'vou cancelar' sem cancelar: a Alice obriga a executar, cancela de verdade e corta a oferta de avaliacao", async () => {
  openaiCalls.length = 0;
  const c = await cenario("Bruna Carolina", [
    ["assistant", "Bom dia, Bruna! Estamos muito felizes em te receber hoje.", "Lembrete de consulta"],
    ["user", "Bom dia eu avisei ontem que não vou conseguir ir"],
  ], { appt: { procedureId: hipro.id, when: new Date(Date.now() + 5 * HOUR) } });
  script = [
    { content: "Entendi, Bruna. Vou cancelar seu horário para hoje." }, // so promete
    { tool: { name: "manage_my_appointment", args: { action: "cancel" } } },
    { content: "Pronto, Bruna, cancelei seu horário. Posso agendar uma avaliação gratuita pra você? Quando quiser remarcar é só me avisar! 💗" }, // oferece avaliacao a quem acabou de cancelar
    { content: "Pronto, Bruna, cancelei seu horário. Quando quiser remarcar é só me avisar! 💗" }, // refaz sem a oferta
  ];
  const reply = await generateReply(c.conv.id);
  assert.equal(openaiCalls.length, 4, "promessa -> ferramenta -> resposta com oferta -> refaz sem a oferta");
  assert.equal((await prisma.appointment.findUnique({ where: { id: c.appointment.id } })).status, "cancelled");
  assert.match(reply, /cancelei/);
  assert.ok(!/avalia/i.test(reply), `oferta de avaliacao tem que ser cortada: ${reply}`);
  // o modelo recebeu a ordem da situacao e a ficha
  const systems = openaiCalls[0].messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  assert.match(systems, /FICHA DESTA PESSOA/);
  assert.match(systems, /ELA QUER CANCELAR/);
  assert.match(systems, /ORDEM DE PRIORIDADE DAS REGRAS/);
  assert.match(systems, /AGENDA DELA[^\n]*Hipro/);
  // e o aviso de "voce prometeu e nao fez" foi o que fez o modelo chamar a ferramenta
  const segunda = openaiCalls[1].messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  assert.match(segunda, /NAO executou a acao/);
});

test("Vania: 'trocar meu horario na terca pra 12:30' remarca o horario que ja tem (Hipro), nao oferece avaliacao; dizer 'remarquei' sem a ferramenta e barrado", async () => {
  openaiCalls.length = 0;
  const dia = amanha(13, 30);
  const novo = amanha(12, 30);
  const c = await cenario("Vânia Rios", [
    ["user", "Na terça feira eu vejo direitinho. Por falar nisso, preciso trocar meu horário na terça pra 12:30"],
  ], { appt: { procedureId: hipro.id, when: dia.instant } });
  await prisma.reminderSent.deleteMany({});
  script = [
    { content: "Remarquei seu horário para amanhã às 12:30!" }, // afirma sem ter feito
    { tool: { name: "manage_my_appointment", args: { action: "reschedule", new_date: novo.date, new_time: "12:30" } } },
    { content: "Pronto, Vânia! Remarquei o seu Hipro para as 12:30. 💗" },
  ];
  const reply = await generateReply(c.conv.id);
  assert.equal(openaiCalls.length, 3);
  const appt = await prisma.appointment.findUnique({ where: { id: c.appointment.id } });
  assert.equal(appt.scheduledAt.getTime(), novo.instant.getTime(), "o horario mudou de verdade");
  assert.equal(appt.status, "confirmed");
  assert.equal(appt.procedureId, hipro.id, "continua o mesmo procedimento (nunca avaliacao)");
  assert.match(reply, /Remarquei/);
  const systems = openaiCalls[0].messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  assert.match(systems, /ELA QUER MUDAR O HORARIO QUE JA TEM/);
  assert.match(systems, /Hipro/);
  assert.match(systems, /12:30/);
});

test("remarcar para horario que nao esta livre: nada muda e a Alice recebe as alternativas do MESMO procedimento", async () => {
  openaiCalls.length = 0;
  const dia = amanha(15, 0);
  const ocupado = amanha(11, 0);
  const other = await prisma.patient.create({ data: { clinicId: clinic.id, name: "Outra Pessoa", phone: "5511977770001" } });
  await prisma.appointment.create({ data: { clinicId: clinic.id, patientId: other.id, procedureId: hipro.id, scheduledAt: ocupado.instant, source: "presencial" } });
  const c = await cenario("Paula Remarca", [["user", "Preciso remarcar meu horário de amanhã pra 11:00"]], { appt: { procedureId: hipro.id, when: dia.instant } });
  script = [
    { tool: { name: "manage_my_appointment", args: { action: "reschedule", new_date: ocupado.date, new_time: "11:00" } } },
    { content: "Esse horário não está disponível pra Hipro. Posso te oferecer outro horário?" },
  ];
  await generateReply(c.conv.id);
  const appt = await prisma.appointment.findUnique({ where: { id: c.appointment.id } });
  assert.equal(appt.scheduledAt.getTime(), dia.instant.getTime(), "o horario antigo continua valendo");
  const toolMsg = openaiCalls[1].messages.filter((m) => m.role === "tool").at(-1).content;
  assert.match(toolMsg, /"ok":false/);
  assert.match(toolMsg, /Hipro/);
  assert.match(toolMsg, /NAO remarcou/);
});

test("cancelar sem horario nenhum na agenda da Alice: vai pra equipe em silencio (nao inventa)", async () => {
  openaiCalls.length = 0;
  script = [];
  const c = await cenario("Sem Agenda", [["user", "Preciso cancelar meu horário de amanhã"]]);
  assert.equal(await generateReply(c.conv.id), "");
  assert.equal((await reload(c)).humanTakeover, true);
  assert.equal(openaiCalls.length, 0);
});

test("a equipe estava combinando o horario e a Alice volta: recebe a proposta da equipe e o pedido da cliente (nao os 'mais proximos')", async () => {
  openaiCalls.length = 0;
  const c = await cenario("Andreia Silva", [
    ["user", "somente aos sábados eu consigo"],
    ["human", "Amanhã às 12h30", "Fabiola"],
    ["user", "pode ser..."],
  ]);
  script = [{ content: "Combinado, Andreia! Já confirmo com a equipe." }];
  // a equipe tinha assumido: simula a volta da Alice depois da demora
  await prisma.conversation.update({ where: { id: c.conv.id }, data: { humanTakeover: false } });
  await generateReply(c.conv.id, { resumedAfterStaffDelay: true });
  const systems = openaiCalls[0].messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  assert.match(systems, /CONTINUE DE ONDE A EQUIPE PAROU/);
  assert.match(systems, /PROPOSTA DA EQUIPE/);
  assert.match(systems, /12:30/);
  assert.match(systems, /SO consegue sábado/);
});

// monta a resposta do modelo com os horarios que a ferramenta de agenda acabou de devolver (como o modelo de verdade faz)
const listaDoResultado = (body) => {
  const tool = body.messages.filter((m) => m.role === "tool").at(-1);
  const r = JSON.parse(tool.content);
  const lista = (r.horarios_mais_proximos ?? r.horarios ?? []).slice(0, 3);
  return { content: `Tenho estes horários:\n\n${lista.map((h) => `• ${h.quando}`).join("\n")}\n\nQual deles fica melhor pra você?` };
};
const diaDaSemana = (iso) => new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, weekday: "long" }).format(new Date(`${iso}T15:00:00Z`));
const isoMais = (dias) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + dias * 24 * HOUR));

test("ela so pode num dia (ex.: 'somente aos <dia>') e o modelo ofereceu OUTRO dia -> a Alice manda refazer, e a oferta final respeita o pedido", async () => {
  openaiCalls.length = 0;
  const alvo = isoMais(2); // depois de amanha
  const outro = isoMais(1); // amanha: dia que ela NAO pode
  const c = await cenario("Isabela Dia", [["user", `Quero uma avaliação, mas somente ${diaDaSemana(alvo)} eu consigo`]]);
  script = [
    { tool: { name: "check_availability", args: { procedure_name: "Avaliação Estética", date: outro } } },
    listaDoResultado, // oferece amanha (dia errado)
    { tool: { name: "check_availability", args: { procedure_name: "Avaliação Estética", date: alvo } } },
    listaDoResultado, // oferece o dia certo
  ];
  const reply = await generateReply(c.conv.id);
  assert.equal(openaiCalls.length, 4, "oferta errada -> refaz -> consulta o dia certo -> oferta certa");
  const aviso = openaiCalls[2].messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  assert.match(aviso, /ATENCAO: os horarios que voce ofereceu NAO respeitam o pedido dela/);
  const [, mm, dd] = alvo.split("-");
  assert.match(reply, new RegExp(`${dd}/${mm}`), `a oferta final tem que ser do dia pedido: ${reply}`);
  const [, mo2, da2] = outro.split("-");
  assert.ok(!new RegExp(`${da2}/${mo2}`).test(reply), "nao pode sobrar horario do dia errado");
});

test("ela pediu um dia e o modelo nem consultou esse dia -> manda consultar ESSE dia primeiro", async () => {
  openaiCalls.length = 0;
  const alvo = isoMais(3);
  const outro = isoMais(1);
  const c = await cenario("Pedro Pediu", [["user", `Quero marcar uma avaliação na ${diaDaSemana(alvo)} às 14:00`]]);
  script = [
    { tool: { name: "check_availability", args: { procedure_name: "Avaliação Estética", date: outro } } },
    listaDoResultado,
    { tool: { name: "check_availability", args: { procedure_name: "Avaliação Estética", date: alvo } } },
    listaDoResultado,
  ];
  const reply = await generateReply(c.conv.id);
  assert.equal(openaiCalls.length, 4);
  assert.match(openaiCalls[2].messages.filter((m) => m.role === "system").map((m) => m.content).join("\n"), /nao consultou esse dia/);
  const [, mm, dd] = alvo.split("-");
  assert.match(reply, new RegExp(`${dd}/${mm}`));
});

// ===== Clarinda (16/10): a Alice listava horarios de avaliacao do nada =====
const respostaComHorarios = "Para agendar a avaliação, temos alguns horários disponíveis:\n\n- hoje, sexta-feira, 16/10 às 15:00 com a Fabíola\n- hoje, sexta-feira, 16/10 às 16:00 com a Fabíola\n\nQual desses funciona melhor pra você? 😊";

test("Clarinda: 'Ok.' depois de a Alice se despedir -> silencio, sem chamar o modelo (mesmo ela tendo pedido horario antes na conversa)", async () => {
  openaiCalls.length = 0;
  script = [];
  const c = await cenario("Clarinda Aparecida", [
    ["user", "pode ser 13h00?"],
    ["human", "1 30h vc tem .", "Fabiola"],
    ["human", "Voce ja conhece o nossos protocolos e tratamentos. ☺", "Fabiola"],
    ["user", "Vou tentar."],
    ["assistant", "Ótimo ouvir que você vai tentar! 😊 Se precisar de mais informações para ajudar sua amiga, estou à disposição. Qualquer coisa que precisar, é só avisar! 💖"],
    ["user", "Ok."],
  ]);
  const reply = await generateReply(c.conv.id);
  assert.equal(reply, "");
  assert.equal(openaiCalls.length, 0);
  const saved = await prisma.message.count({ where: { conversationId: c.conv.id, role: "assistant" } });
  assert.equal(saved, 1, "nao gravou nenhuma resposta nova");
});

test("Clarinda: 'Nao.' a uma pergunta da equipe, Alice retomando -> se o modelo oferece horarios, a Alice manda refazer sem horario nem avaliacao", async () => {
  openaiCalls.length = 0;
  const c = await cenario("Clarinda Nao", [
    ["user", "pode ser 13h00?"],
    ["assistant", "Oi, Clarinda! Gostaríamos de saber como foi sua experiência durante a avaliação conosco.", "Pós Avaliação - 1 dia"],
    ["user", "Muito bem atendida."],
    ["human", "Posso te auxiliar em algo por aqui? 🥰", "Fabiola"],
    ["user", "Não."],
  ]);
  script = [
    { content: respostaComHorarios },
    { content: "Tudo bem, Clarinda! Se precisar de algo é só me chamar. 💗" },
  ];
  const reply = await generateReply(c.conv.id, { resumedAfterStaffDelay: true });
  assert.equal(openaiCalls.length, 2);
  const aviso = openaiCalls[1].messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  assert.match(aviso, /a pessoa NAO pediu horario nem agendamento/);
  assert.ok(!/\d{1,2}:\d{2}|avalia|horários/i.test(reply), reply);
  const systems = openaiCalls[0].messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  assert.match(systems, /ELA NAO PEDIU HORARIO NEM AGENDAMENTO/);
});

test("Clarinda: se o modelo INSISTE em oferecer horarios/avaliacao, o codigo tira a oferta (nunca chega no WhatsApp)", async () => {
  openaiCalls.length = 0;
  const c = await cenario("Clarinda Insiste", [
    ["assistant", "Oi, Clarinda! Gostaríamos de saber como foi sua experiência.", "Pesquisa de satisfação"],
    ["user", "Muito bem atendida."],
    ["human", "Posso te auxiliar em algo por aqui? 🥰", "Fabiola"],
    ["user", "Pra minha amiga."],
  ]);
  script = [{ content: respostaComHorarios }, { content: respostaComHorarios }];
  const reply = await generateReply(c.conv.id, { resumedAfterStaffDelay: true });
  assert.equal(openaiCalls.length, 2);
  assert.ok(!/\d{1,2}:\d{2}|avalia|horários|Qual desses/i.test(reply), `a oferta tem que ser cortada: ${reply}`);
  assert.ok(reply.trim().length >= 12, "nunca fica sem resposta nenhuma");
  const salva = await prisma.message.findFirst({ where: { conversationId: c.conv.id, role: "assistant" }, orderBy: { createdAt: "desc" } });
  assert.equal(salva.content, reply);
});

test("quem JA E paciente e escreve algo fora de agenda recebe resposta simples (sem oferta de avaliacao)", async () => {
  openaiCalls.length = 0;
  const c = await cenario("Paciente Antiga", [
    ["assistant", "Oi! Passando para saber como sua pele está hoje após Limpeza de Pele.", "Pós-procedimento automático"],
    ["user", "Está ótima, queria saber o endereço de vocês"],
  ]);
  script = [{ content: "Que bom saber! 💗 Estamos na Av. Índico, 294, Jardim do Mar. Quer que eu agende uma avaliação gratuita para o próximo cuidado?" }, { content: "Que bom saber! 💗 Estamos na Av. Índico, 294, Jardim do Mar." }];
  const reply = await generateReply(c.conv.id);
  assert.ok(!/avalia/i.test(reply), reply);
  assert.match(reply, /Índico/);
});

test("quem PEDE horario continua recebendo os horarios (a trava nao atrapalha a venda)", async () => {
  openaiCalls.length = 0;
  const alvo = isoMais(1);
  const c = await cenario("Lead Quer Marcar", [["user", "Quero marcar uma avaliação amanhã"]]);
  script = [
    { tool: { name: "check_availability", args: { procedure_name: "Avaliação Estética", date: alvo } } },
    listaDoResultado,
  ];
  const reply = await generateReply(c.conv.id);
  assert.equal(openaiCalls.length, 2, "sem aviso extra");
  const [, mm, dd] = alvo.split("-");
  assert.match(reply, new RegExp(`${dd}/${mm}`));
  assert.match(reply, /\d{1,2}:\d{2}/);
});

test("a memoria do lead (notas atualizadas) vai na ficha que a Alice le antes de responder", async () => {
  openaiCalls.length = 0;
  const c = await cenario("Memoria Teste", [["user", "Oi, tudo bem? Queria saber do Hipro"]]);
  await prisma.patient.update({ where: { id: c.patient.id }, data: { briefingNotes: "- So consegue aos sabados\n- Ja foi avaliada em 14/10", briefingNotesAt: new Date() } });
  script = [{ content: "Oi! O Hipro é um procedimento de ultrassom focalizado. O que você gostaria de melhorar?" }];
  await generateReply(c.conv.id);
  const systems = openaiCalls[0].messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  assert.match(systems, /MEMORIA DO LEAD/);
  assert.match(systems, /So consegue aos sabados/);
  assert.match(systems, /Ja foi avaliada em 14\/10/);
});

// ===== economia de tokens (16/10): sem mudar o que a Alice responde =====
test("economia: a segunda leitura da conversa (uma chamada a mais) so roda quando o caminho NAO esta decidido pelo codigo", async () => {
  // lead em conversa comum, com 4+ mensagens: a leitura roda
  auxCalls.length = 0; openaiCalls.length = 0;
  const lead = await cenario("Lead Comum", [
    ["user", "Oi, queria saber de botox"], ["assistant", "Oi! Claro. O que você gostaria de melhorar?"],
    ["user", "As linhas da testa"], ["assistant", "Entendi. Você já fez botox antes?"], ["user", "Nunca fiz, tenho receio"],
  ]);
  script = [{ content: "Entendo o receio! O botox é aplicado com cuidado. Quer saber como funciona?" }];
  await generateReply(lead.conv.id);
  assert.equal(auxCalls.length, 1, "conversa comum: a segunda leitura roda");
  // retomando depois da equipe, sem pedido de horario (plano ja decidido pelo codigo): nao gasta a leitura
  auxCalls.length = 0; openaiCalls.length = 0;
  const retomada = await cenario("Retomada Sem Pedido", [
    ["user", "Muito bem atendida"], ["human", "Posso te auxiliar em algo? 🥰", "Fabiola"], ["user", "Não, obrigada"],
    ["human", "Qualquer coisa estamos aqui", "Fabiola"], ["user", "Pra minha amiga, depois eu falo"],
  ]);
  script = [{ content: "Tudo bem! Se sua amiga quiser saber mais, é só chamar. 💗" }];
  await generateReply(retomada.conv.id, { resumedAfterStaffDelay: true });
  assert.equal(auxCalls.length, 0, "situacao decidida pelo codigo: sem segunda leitura");
  // cancelar (situacao decidida) tambem nao gasta
  auxCalls.length = 0; openaiCalls.length = 0;
  const cancela = await cenario("Cancela Sem Leitura", [
    ["assistant", "Lembrete do seu horário", "Lembrete de consulta"], ["user", "Oi"], ["assistant", "Oi!"], ["user", "Preciso cancelar meu horário"],
  ], { appt: { procedureId: hipro.id, when: new Date(Date.now() + 6 * HOUR) } });
  script = [{ tool: { name: "manage_my_appointment", args: { action: "cancel" } } }, { content: "Pronto, cancelei seu horário. Quando quiser remarcar é só avisar! 💗" }];
  await generateReply(cancela.conv.id);
  assert.equal(auxCalls.length, 0);
});

test("economia: a hierarquia de regras fica no INICIO do prompt (parte reaproveitada do cache da OpenAI), nao na ultima mensagem", async () => {
  openaiCalls.length = 0;
  const c = await cenario("Cache Teste", [["user", "Oi, queria saber do Hipro"]]);
  script = [{ content: "Oi! O Hipro é um procedimento. O que você gostaria de melhorar?" }];
  await generateReply(c.conv.id);
  const msgs = openaiCalls[0].messages.filter((m) => m.role === "system");
  assert.match(msgs[0].content, /ORDEM DE PRIORIDADE DAS REGRAS/, "no inicio (parte fixa)");
  const ultima = msgs.at(-1).content;
  assert.doesNotMatch(ultima, /ORDEM DE PRIORIDADE DAS REGRAS/, "nao repete na parte que muda a cada mensagem");
  assert.match(ultima, /FICHA DESTA PESSOA/);
});

test("economia: mensagens bem antigas e longas da conversa vao cortadas; as recentes ficam inteiras", async () => {
  openaiCalls.length = 0;
  const longa = "Texto longo da clínica. ".repeat(40); // ~960 caracteres
  const msgs = [];
  for (let i = 0; i < 14; i++) msgs.push([i % 2 === 0 ? "assistant" : "user", i === 0 ? longa : i === 12 ? longa + " fim" : "Mensagem curta " + i, null]);
  msgs.push(["user", "E agora, qual o endereço?"]);
  const c = await cenario("Historico Longo", msgs);
  script = [{ content: "Estamos na Av. Índico, 294." }];
  await generateReply(c.conv.id);
  const hist = openaiCalls[0].messages.filter((m) => m.role === "assistant" || m.role === "user");
  assert.ok(hist[0].content.length <= 321, "a mais antiga foi cortada: " + hist[0].content.length);
  const recente = hist.find((m) => typeof m.content === "string" && m.content.endsWith("fim"));
  assert.ok(recente && recente.content.length > 700, "a recente fica inteira (so corta alem de 700)");
});
