import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("ate 3 horarios espalhados pelo dia e filtro por turno", async () => {
  const { pickSpread, filterByPeriod, periodOfHour } = await import("../dist/scheduling/slots.js");
  const mk = (h) => ({ start: new Date(Date.UTC(2026, 9, 20, h + 3, 0, 0)), h }); // h = hora em Sao Paulo (UTC-3)
  const todos = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19].map(mk);
  const tres = pickSpread(todos, 3);
  assert.equal(tres.length, 3);
  assert.equal(tres[0].h, 8);
  assert.equal(tres[2].h, 19);
  assert.equal(pickSpread(todos.slice(0, 2), 3).length, 2);
  assert.equal(periodOfHour(11), "manha");
  assert.equal(periodOfHour(12), "tarde");
  assert.equal(periodOfHour(18), "noite");
  const tarde = filterByPeriod(todos, "America/Sao_Paulo", "tarde");
  assert.deepEqual(tarde.map((x) => x.h), [12, 13, 14, 15, 16, 17]);
  assert.equal(filterByPeriod(todos, "America/Sao_Paulo", null).length, todos.length);
});

test("\"Sim\" a uma oferta de avaliacao e pedido de agendamento (caso Selma): nao explica de novo nem pergunta se ja fez antes", async () => {
  const { analyzeFlow, acceptsSchedulingOffer } = await import("../dist/ai/salesFlow.js");
  const oferta = "Entendi! Você gostaria que eu verificasse um horário para sua avaliação gratuita?";
  assert.equal(acceptsSchedulingOffer("Sim", oferta), true);
  assert.equal(acceptsSchedulingOffer("pode sim!", oferta), true);
  assert.equal(acceptsSchedulingOffer("Sim", "Você tem alguma dúvida específica sobre o procedimento?"), false);
  assert.equal(acceptsSchedulingOffer("não, depois eu vejo", oferta), false);
  const hist = [
    { role: "user", content: "Gostaria de verificar sobre peeling químico para rosto com melasma e acneico" },
    { role: "assistant", content: oferta },
    { role: "user", content: "Sim" },
  ];
  const f = analyzeFlow({ history: hist, trailing: ["Sim"], priceAsked: false, hasBooking: false });
  assert.equal(f.intent, "schedule");
  assert.match(f.nextMove, /ACEITOU/);
  assert.match(f.nextMove, /NO MAXIMO 3 horarios/);
  const g = analyzeFlow({ history: [{ role: "assistant", content: "Posso buscar alguns horários para a avaliação?" }, { role: "user", content: "Amanhã estarei de folga" }], trailing: ["Amanhã estarei de folga"], priceAsked: false, hasBooking: false });
  assert.equal(g.intent, "schedule");
  const h = analyzeFlow({ history: [{ role: "assistant", content: "Oi! O que você gostaria de melhorar?" }, { role: "user", content: "amanhã eu vejo" }], trailing: ["amanhã eu vejo"], priceAsked: false, hasBooking: false });
  assert.notEqual(h.intent, "schedule");
});

test("procedimento especifico: agenda ESSE procedimento, avaliacao so pra quem pediu ou nao sabe", async () => {
  const { analyzeFlow } = await import("../dist/ai/salesFlow.js");
  const msg = "assim que eu poder farei essa limpeza com certeza, quero agendar";
  const f = analyzeFlow({ history: [{ role: "user", content: msg }], trailing: [msg], priceAsked: false, hasBooking: false });
  assert.equal(f.intent, "schedule");
  assert.match(f.nextMove, /agende ESSE procedimento/);
  assert.match(f.nextMove, /nao a avaliacao/);
  assert.match(f.nextMove, /NUNCA escreva 'conseguimos agendar'/);
});

test("paciente que ja foi atendida nao recebe oferta de avaliacao (caso Neide)", async () => {
  const { analyzeFlow } = await import("../dist/ai/salesFlow.js");
  const msg = "Olá boa tarde, graças a Deus estou ótima e sem roxinho kk";
  const f = analyzeFlow({ history: [{ role: "assistant", content: "Oi, Neide! Passando para saber como você está após o Botox facial." }, { role: "user", content: msg }], trailing: [msg], priceAsked: false, hasBooking: false, pastVisits: true });
  assert.equal(f.intent, "returning");
  assert.match(f.nextMove, /NAO ofereca avaliacao gratuita/);
  const { isPositiveFeedback, feedbackThanks } = await import("../dist/ai/courtesy.js");
  assert.equal(isPositiveFeedback("Olá boa tarde, graças a Deus estou ótima e sem roxinho kk ❤️"), true);
  assert.equal(isPositiveFeedback("Amei o resultado!"), true);
  assert.equal(isPositiveFeedback("estou com dor e inchaço"), false);
  assert.equal(isPositiveFeedback("estou bem, mas queria saber o valor do retorno?"), false);
  assert.equal(isPositiveFeedback("estou ótima mas tem uma região vermelha"), false);
  assert.equal(feedbackThanks("Neide Alves"), "Que bom saber, Neide! 💗 Qualquer dúvida é só chamar.");
});

test("promessas: 'Vou fazer isso agora' e 'Conseguimos agendar' (antes do book) sao promessa quebrada", async () => {
  const { announcesAction, claimsBooking, brokenPromise } = await import("../dist/ai/promises.js");
  assert.equal(announcesAction("Posso te oferecer alguns horários hoje e amanhã! Vou fazer isso agora."), true);
  assert.equal(announcesAction("Já vou verificar para você"), true);
  assert.equal(claimsBooking("Conseguimos agendar a avaliação para amanhã. Tenho estas opções:"), true);
  assert.equal(brokenPromise("Conseguimos agendar a avaliação para amanhã. Tenho estas opções:", false), true);
  assert.equal(brokenPromise("Tenho estes horários: terça às 14:30 ou 18:30. Qual prefere?", false), false);
  assert.equal(brokenPromise("Conseguimos agendar!", true), false);
});

test("relevancia: papada e queixo sao a mesma regiao; a resposta fala 'a papada' (caso Liana)", async () => {
  const { findRelevanceMismatch, fittingProcedures, safeReplyForMismatch, procedureFitsComplaint, areasIn } = await import("../dist/ai/relevance.js");
  const catalogo = [{ name: "Enzima de Papada" }, { name: "Preenchimento Labial" }, { name: "Bioestimulador Facial" }, { name: "Criolipólise Abdômen" }];
  assert.equal(procedureFitsComplaint(areasIn("Enzima de Papada"), areasIn("queixo")), true);
  assert.equal(procedureFitsComplaint(areasIn("Preenchimento Labial"), areasIn("papada")), false);
  assert.deepEqual(fittingProcedures(["Por enquanto o que mais encomoda é a papada", "meu caso é mais flacidez"], catalogo), ["Enzima de Papada"]);
  const m = findRelevanceMismatch({ complaintTexts: ["Por enquanto o que mais encomoda é a papada"], reply: "Posso indicar o Preenchimento Labial para você.", procedures: catalogo });
  assert.ok(m);
  assert.equal(m.complaintLabel, "a papada");
  assert.match(safeReplyForMismatch(m, false), /Para a papada/);
  assert.equal(findRelevanceMismatch({ complaintTexts: ["flacidez na papada"], reply: "Bioestimulador Facial ajuda.", procedures: catalogo }), null);
});

test("no maximo 3 horarios por vez no texto da Alice", async () => {
  const { capSlotLines } = await import("../dist/ai/slotText.js");
  const texto = "Tenho estas opções:\n\n• Terça-feira, 20/10 às 14:30\n• Terça-feira, 20/10 às 18:30\n• Quinta-feira, 22/10 às 12:00\n• Quinta-feira, 22/10 às 13:00\n• Quinta-feira, 22/10 às 14:00\n\nQual fica melhor pra você?";
  const r = capSlotLines(texto, 3);
  assert.equal((r.match(/•/g) ?? []).length, 3);
  assert.match(r, /Qual fica melhor pra você\?/);
  assert.doesNotMatch(r, /13:00|14:00/);
  const tres = "• 08:00\n• 09:00\n• 10:30";
  assert.equal(capSlotLines(tres, 3), tres);
  assert.equal(capSlotLines("Fico feliz em ajudar! Posso agendar às 10h.", 3), "Fico feliz em ajudar! Posso agendar às 10h.");
});

test("entrega da Alice: timeout nao reenvia (6 mensagens iguais p/ a Elaine) e resposta repetida em 3 min e descartada", async () => {
  const { isAmbiguousSendError } = await import("../dist/uazapi/client.js");
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  assert.equal(isAmbiguousSendError(timeout), true);
  assert.equal(isAmbiguousSendError(new Error("socket hang up")), true);
  assert.equal(isAmbiguousSendError(new Error("UAZAPI 401: invalid token")), false);
  assert.equal(isAmbiguousSendError(new Error("not on whatsapp")), false);
  const src = fs.readFileSync(new URL("../src/uazapi/client.ts", import.meta.url), "utf8");
  const i = src.indexOf("export async function deliverAliceReply");
  const corpo = src.slice(i, i + 2500);
  assert.match(corpo, /alreadySent/);
  assert.match(corpo, /isAmbiguousSendError\(err\)/);
});

test("avaliacao em cima de avaliacao: check_availability e book_appointment recusam quando ja existe uma marcada", () => {
  const src = fs.readFileSync(new URL("../src/ai/alice.ts", import.meta.url), "utf8");
  assert.ok((src.match(/futureEvaluation\(patientId\)/g) ?? []).length >= 2);
  assert.match(src, /esta pessoa JA tem uma avaliacao marcada/);
});
