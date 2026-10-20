import test from "node:test";
import assert from "node:assert/strict";

const { analyzeFlow, wantsSchedule, declinesOptions, complainsAboutBot } = await import("../dist/ai/salesFlow.js");

// Conversa do print (Cibele, anuncio de criolipolise, 13/10/2026)
const U = (content) => ({ role: "user", content });
const A = (content) => ({ role: "assistant", content });
const LONGA = "estou em processo de emagrecimento ha um ano e meio, tomo mounjaro, ja emagreci 33 kg, hoje tenho 95 kg e 1,73m, mas ainda tenho muita gordura abdominal e muita flacidez no bracos";

test("'Prefiro uma avaliacao' e pedido de agendamento (o filtro antigo nao reconhecia)", () => {
  for (const t of ["Prefiro uma avaliação", "Gostaria de uma avaliação pro abdômen e braços", "Preferia agendar avaliação", "Amanhã dia 14 as 15 horas", "quero marcar"]) {
    assert.equal(wantsSchedule(t), true, t);
  }
  assert.equal(wantsSchedule("Escrevi acima!"), false);
});

test("primeira mensagem curta: descobre a queixa com UMA pergunta, sem valor", () => {
  const f = analyzeFlow({ history: [U("Quero informações sobre")], trailing: ["Quero informações sobre"], priceAsked: false, hasBooking: false });
  assert.equal(f.intent, "info");
  assert.equal(f.statedGoal, false);
  assert.match(f.nextMove, /UMA pergunta especifica/);
  assert.match(f.nextMove, /NAO perguntou valor/);
});

test("ela ja contou a queixa: nao pergunta de novo, propoe a avaliacao", () => {
  const history = [U("Quero informações"), A("Oi! Aqui é a Alice. O que você gostaria de melhorar?"), U(LONGA)];
  const f = analyzeFlow({ history, trailing: [LONGA], priceAsked: false, hasBooking: false });
  assert.equal(f.statedGoal, true);
  assert.match(f.nextMove, /NAO pergunte de novo/);
  assert.match(f.nextMove, /horario pra sua avaliacao/);
  assert.match(f.nextMove, /NAO perguntou valor/);
});

test("pediu avaliacao: vai direto ao agendamento e continua assim nas respostas seguintes", () => {
  const h1 = [U("Quero informações"), A("Oi!"), U(LONGA), A("Tenho opções. Prefere avaliação?"), U("Prefiro uma avaliação")];
  const f1 = analyzeFlow({ history: h1, trailing: ["Prefiro uma avaliação"], priceAsked: false, hasBooking: false });
  assert.equal(f1.intent, "schedule");
  assert.match(f1.nextMove, /check_availability/);
  assert.match(f1.nextMove, /NUNCA cite outro paciente/);
  // "Gordura localizada e flacidez" (resposta a uma pergunta) segue sendo agendamento
  const h2 = [...h1, A("O que você gostaria de melhorar?"), U("Gordura localizada e flacidez")];
  const f2 = analyzeFlow({ history: h2, trailing: ["Gordura localizada e flacidez"], priceAsked: false, hasBooking: false });
  assert.equal(f2.intent, "schedule");
});

test("recusou os horarios: nao encerra, pergunta dia/periodo e oferece outros", () => {
  const h = [U(LONGA), A("Qual dia?"), U("Amanhã dia 14 as 15 horas"), A("Terça 20/10 às 8h, 8h30 ou 9h30. Qual desses fica melhor pra você?"), U("Nenhum deles,obrigada")];
  const f = analyzeFlow({ history: h, trailing: ["Nenhum deles,obrigada"], priceAsked: false, hasBooking: false });
  assert.equal(f.intent, "decline");
  assert.match(f.nextMove, /Nao encerre ainda/); // continua no agendamento: nao se despede (o comportamento, nao a frase exata)
  assert.match(f.nextMove, /Pare assim que ela disser que nao quer mais/);
  assert.match(f.nextMove, /periodo/);
});

test("recusou mas ja propos outro horario: segue o agendamento", () => {
  const h = [U("quero avaliação"), A("Terça às 8h ou 9h?"), U("Não posso terça, pode ser amanhã às 15h30?")];
  const f = analyzeFlow({ history: h, trailing: ["Não posso terça, pode ser amanhã às 15h30?"], priceAsked: false, hasBooking: false });
  assert.equal(f.intent, "schedule");
});

test("perguntou valor: responde primeiro e conduz", () => {
  const f = analyzeFlow({ history: [U("quanto custa a criolipólise?")], trailing: ["quanto custa a criolipólise?"], priceAsked: true, hasBooking: false });
  assert.equal(f.intent, "price");
  assert.match(f.nextMove, /VALOR/);
});

test("ja tem agendamento: nao empurra agendamento de novo", () => {
  const f = analyzeFlow({ history: [U("quero marcar"), A("Marcado!"), U("obrigada")], trailing: ["obrigada"], priceAsked: false, hasBooking: true });
  assert.notEqual(f.intent, "schedule");
});

test("detecta recusa e reclamacao do atendimento automatico", () => {
  assert.equal(declinesOptions("Nenhum deles,obrigada"), true);
  assert.equal(declinesOptions("pode ser quinta"), false);
  for (const t of ["Desculpa falar mas a IA de vcs é péssima", "Repetitiva", "E não auxiliar em nada".replace("auxiliar", "auxilia"), "o robô não ajuda em nada"]) {
    assert.equal(complainsAboutBot(t), true, t);
  }
  assert.equal(complainsAboutBot("Vc é humano ou IA?"), false);
  assert.equal(complainsAboutBot("Quero agendar uma avaliação"), false);
});
