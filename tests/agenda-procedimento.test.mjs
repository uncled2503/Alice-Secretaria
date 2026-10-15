// A Alice agenda o PROCEDIMENTO que a pessoa pediu (nao so avaliacao), agenda o horario que ela ja escolheu, e para de oferecer horario a quem ja
// esta agendada (relatos da Lisboa, 15/10/2026).
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

const { identifyWanted, findChosenSlot, slotsOfferedIn, staffConfirmedBooking, offersSlots, wantedDirective, chosenSlotDirective } = await import("../dist/ai/bookingIntent.js");
const { analyzeFlow } = await import("../dist/ai/salesFlow.js");
const { isSameReminderText } = await import("../dist/reminders/cron.js");
const { isJobSeeker } = await import("../dist/ai/jobSeeker.js");

const CATALOGO = [
  "Avaliação", "Limpeza de Pele", "Drenagem linfática", "Drenagem linfática facial", "Drenagem Modeladora",
  "Peeling Químico", "Peeling de Diamante", "Lavieen", "Lavieen Olheiras", "Lavieen Full Face", "Carbox Olheira", "Preenchimento de Olheiras",
  "Botox facial", "Criolipólise Abdômen",
].map((name) => ({ name }));

test("procedimento nomeado por inteiro = esse (nunca avaliacao)", () => {
  assert.deepEqual(identifyWanted(CATALOGO, ["Oi, quero fazer uma limpeza de pele"]), { kind: "specific", procedure: "Limpeza de Pele" });
  assert.deepEqual(identifyWanted(CATALOGO, ["Gostaria de saber sobre o Peeling Químico, tenho manchas"]), { kind: "specific", procedure: "Peeling Químico" });
  assert.deepEqual(identifyWanted(CATALOGO, ["quero marcar lavieen"]), { kind: "specific", procedure: "Lavieen" }, "o mais especifico que foi dito por inteiro");
  assert.deepEqual(identifyWanted(CATALOGO, ["quero botox facial"]), { kind: "specific", procedure: "Botox facial" });
});

test("familia de procedimentos (so 'drenagem', 'peeling', 'olheiras'): pergunta qual, em vez de empurrar avaliacao", () => {
  const dren = identifyWanted(CATALOGO, ["queria uma drenagem"]);
  assert.equal(dren.kind, "options");
  assert.ok(dren.options.includes("Drenagem linfática"));
  const peel = identifyWanted(CATALOGO, ["queria um peeling"]);
  assert.equal(peel.kind, "options");
  const olh = identifyWanted(CATALOGO, ["tenho olheiras"]);
  assert.equal(olh.kind, "options");
  assert.deepEqual(new Set(olh.options), new Set(["Lavieen Olheiras", "Carbox Olheira", "Preenchimento de Olheiras"]));
});

test("quem nao sabe o que quer, ou pede oferta de anuncio fora do catalogo, nao e 'procedimento': avaliacao", () => {
  assert.deepEqual(identifyWanted(CATALOGO, ["oi, vi o anuncio do Protocolo do Olhar"]), { kind: "none" });
  assert.deepEqual(identifyWanted(CATALOGO, ["Bom dia, queria agendar um horario"]), { kind: "none" });
  assert.deepEqual(identifyWanted(CATALOGO, []), { kind: "none" });
  assert.deepEqual(identifyWanted([{ name: "Avaliação" }], ["quero uma avaliação"]), { kind: "none" }, "avaliacao nao conta como procedimento");
});

const LISTA = "Tenho estes horários:\n\n• sábado, 17/10 às 08:30 com Fabíola\n• sábado, 17/10 às 10:30 com Fabíola\n• sábado, 17/10 às 14:30 com Fabíola\n\nQual deles fica melhor pra você?";

test("le os horarios de uma lista (linha a linha) e de uma frase com data unica", () => {
  assert.deepEqual(slotsOfferedIn(LISTA).map((s) => `${s.dd}/${s.mm} ${s.time}`), ["17/10 08:30", "17/10 10:30", "17/10 14:30"]);
  assert.deepEqual(slotsOfferedIn("No dia 23/10 tenho 13:00 e 15:00. Qual prefere?").map((s) => s.time), ["13:00", "15:00"]);
  assert.deepEqual(slotsOfferedIn("Oi, tudo bem?"), []);
});

test("Rosana: escolheu 08:30, deu o nome completo -> o horario escolhido e agendado (nao oferece de novo)", () => {
  const history = [
    { role: "assistant", content: LISTA },
    { role: "user", content: "08:30" },
    { role: "assistant", content: "Me confirma seu nome completo para concluirmos seu agendamento" },
    { role: "user", content: "Rosana Rodrigues da Silva" },
  ];
  const chosen = findChosenSlot(history, ["Rosana Rodrigues da Silva"], "2026-10-15", ["Avaliação", "Limpeza de Pele"]);
  assert.deepEqual([chosen.date, chosen.time], ["2026-10-17", "08:30"]);
  const flow = analyzeFlow({ history, trailing: ["Rosana Rodrigues da Silva"], priceAsked: false, hasBooking: false, chosen, chosenFullName: "Rosana Rodrigues da Silva", wanted: { kind: "none" }, evaluationName: "Avaliação" });
  assert.equal(flow.intent, "schedule", "so o nome ja e pedido de agendamento: o horario foi escolhido");
  assert.match(flow.nextMove, /HORARIO JA ESCOLHIDO PELA PESSOA: 17\/10 as 08:30/);
  assert.match(flow.nextMove, /book_appointment AGORA com date="2026-10-17" e time="08:30"/);
  assert.match(flow.nextMove, /patient_full_name="Rosana Rodrigues da Silva"/);
  assert.match(flow.nextMove, /NAO diga "seu nome ja esta registrado"/);
});

test("escolha ambigua ou sem lista nao inventa horario", () => {
  const hist = [{ role: "assistant", content: LISTA }, { role: "user", content: "pode ser" }];
  assert.equal(findChosenSlot(hist, ["pode ser"], "2026-10-15"), null);
  assert.equal(findChosenSlot([{ role: "assistant", content: "Oi!" }, { role: "user", content: "08:30" }], ["08:30"], "2026-10-15"), null);
  assert.equal(findChosenSlot([{ role: "assistant", content: LISTA }, { role: "user", content: "09:15" }], ["09:15"], "2026-10-15"), null, "hora que nao estava na lista");
  const dia = "Sexta, 16/10 às 09:00\nSábado, 17/10 às 09:00\nQual?";
  assert.equal(findChosenSlot([{ role: "assistant", content: dia }, { role: "user", content: "09:00" }], ["09:00"], "2026-10-15"), null, "mesma hora em dois dias: pergunta qual");
  assert.equal(findChosenSlot([{ role: "assistant", content: dia }, { role: "user", content: "sabado 09:00" }], ["sabado 09:00"], "2026-10-15"), null, "sem data numerica nao adivinha");
});

test("a jogada manda agendar o procedimento pedido, sem avaliacao; sem procedimento, avaliacao", () => {
  const base = { history: [{ role: "user", content: "quero uma limpeza de pele" }], trailing: ["quero uma limpeza de pele"], priceAsked: false, hasBooking: false, evaluationName: "Avaliação" };
  const especifico = analyzeFlow({ ...base, wanted: { kind: "specific", procedure: "Limpeza de Pele" } });
  assert.equal(especifico.intent, "schedule");
  assert.match(especifico.nextMove, /PROCEDIMENTO IDENTIFICADO: a pessoa quer "Limpeza de Pele"/);
  assert.match(especifico.nextMove, /NAO ofereca nem mencione avaliacao/);
  const opcoes = analyzeFlow({ ...base, wanted: { kind: "options", options: ["Drenagem linfática", "Drenagem Modeladora"] } });
  assert.match(opcoes.nextMove, /"Drenagem linfática", "Drenagem Modeladora"/);
  assert.match(opcoes.nextMove, /pergunte UMA vez/);
  const nenhum = analyzeFlow({ ...base, history: [{ role: "user", content: "quero agendar" }], trailing: ["quero agendar"], wanted: { kind: "none" } });
  assert.match(nenhum.nextMove, /ai sim agende a avaliacao gratuita/);
  assert.match(wantedDirective({ kind: "none" }, null), /ai sim agende a avaliacao gratuita/);
  assert.match(chosenSlotDirective({ date: "2026-10-17", time: "08:30", label: "17/10 as 08:30", procedure: "Lavieen" }, null), /procedure_name="Lavieen"/);
});

test("conversa de informacao com procedimento claro fecha perguntando o horario DESSE procedimento (nao avaliacao)", () => {
  const f = analyzeFlow({
    history: [{ role: "user", content: "Sao manchas no rosto, me incomoda" }, { role: "assistant", content: "Entendi!" }],
    trailing: ["Sao manchas no rosto, me incomoda"],
    priceAsked: false,
    hasBooking: false,
    wanted: { kind: "specific", procedure: "Peeling Químico" },
  });
  if (f.intent === "info") assert.match(f.nextMove, /ela quer "Peeling Químico".*NAO fale de avaliacao/);
});

test("Adriana: a EQUIPE disse que marcou -> ja esta agendada (nao volta a receber horarios)", () => {
  const hist = [
    { role: "human", content: "Isso mesmo Dri, o agendamento foi concluído para sábado ás 11h00 ☺️" },
    { role: "user", content: "Ok" },
    { role: "user", content: "Muito obrigada" },
  ];
  assert.equal(staffConfirmedBooking(hist), true);
  assert.equal(staffConfirmedBooking([{ role: "assistant", content: "O agendamento foi concluído" }]), false, "so a equipe conta");
  assert.equal(staffConfirmedBooking([{ role: "human", content: "Bom dia! Pode me encaminhar por aqui" }]), false);
  const f = analyzeFlow({ history: hist, trailing: ["Muito obrigada"], priceAsked: false, hasBooking: true });
  assert.equal(f.intent, "booked");
});

test("lista de horarios com pergunta e 'oferta'; agradecimento nao", () => {
  assert.equal(offersSlots("Para a Drenagem Linfática, tenho os seguintes horários para amanhã:\n🕒 sexta-feira, 16/10 às 08:00\nQual deles você prefere?"), true);
  assert.equal(offersSlots("O agendamento está confirmado para sábado às 11h, com a Sirlene."), false);
  assert.equal(offersSlots("Por nada! 💗"), false);
});

test("candidata a vaga: o curriculo vem como anexo e o 'obrigada' depois - a conversa toda conta", () => {
  assert.equal(isJobSeeker("Meu nome é Beatriz, e eu gostaria de saber se, a vaga que estão divulgando, ainda está disponível? Se teria algum contato para eu encaminhar meu currículo."), true);
  assert.equal(isJobSeeker("Maravilha, obrigada"), false, "sozinha nao basta: por isso o codigo olha as ultimas mensagens");
  assert.equal(isJobSeeker("tem vaga amanhã de manhã?"), false, "vaga na agenda nao e emprego");
  const src = fs.readFileSync(new URL("../src/ai/alice.ts", import.meta.url), "utf8");
  assert.match(src, /userRecent\.some\(\(m\) => isJobSeeker\(m\.content, adText\)\)/);
});

test("confirmacao duplicada: a mesma mensagem com o nome em negrito (ou a mesma regra do dia) nao sai 2x", () => {
  const plain = "Bom dia, {primeiro_nome}! Tudo bem? ☀️\nEstamos muito felizes em te receber hoje às {hora} 🥰";
  const bold = "Bom dia, *{primeiro_nome}*! Tudo bem? ☀️\nEstamos muito felizes em te receber hoje às {hora} 🥰";
  assert.equal(isSameReminderText(plain, bold), true);
  assert.equal(isSameReminderText(plain, "Olá, {primeiro_nome}! Passando para confirmar:\n📅 Data: {data} (amanhã)"), false, "confirmacao do dia seguinte e outra coisa");
  assert.equal(isSameReminderText("Olá! (amanhã) 1", "Oi! (amanhã) 2"), true, "mesmo tipo (amanha) em 20h = repeticao");
});

test("a pagina de ajuda do prompt nao empurra mais avaliacao pra quem ja disse o procedimento", () => {
  const src = fs.readFileSync(new URL("../src/ai/alice.ts", import.meta.url), "utf8");
  assert.match(src, /nunca a avaliacao: a avaliacao gratuita e so para quem a pediu ou ainda nao sabe o que precisa/);
  assert.match(src, /Se ela JA escolheu dia e horario, use ESSE MESMO dia e horario/);
});
