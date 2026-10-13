import test from "node:test";
import assert from "node:assert/strict";

const { announcesAction, claimsBooking, brokenPromise } = await import("../dist/ai/promises.js");

test("frases do print: anunciam acao que nao foi feita", () => {
  assert.equal(announcesAction("Vou agendar então a massagem modeladora e o tratamento de Heccus para amanhã às 17h. Um instante, só vou confirmar. ✨"), true);
  assert.equal(announcesAction("Vou verificar os horários para você e já volto!"), true);
  assert.equal(announcesAction("Vou agendar a massagem modeladora e o tratamento de Heccus pra você! Um instante."), true);
});

test("afirmar 'agendado' sem book_appointment ter dado certo e promessa quebrada", () => {
  assert.equal(claimsBooking("Sim, o horário às 17h está agendado."), true);
  assert.equal(brokenPromise("Sim, o horário às 17h está agendado.", false), true);
  assert.equal(brokenPromise("Pronto, ficou agendado para amanhã às 17h!", true), false);
});

test("resposta normal e encaminhar pra equipe nao sao promessa quebrada", () => {
  assert.equal(brokenPromise("Amanhã às 17h está livre. Posso agendar pra você?", false), false);
  assert.equal(brokenPromise("Vou pedir pra equipe confirmar isso com você, um instante.", false), false);
});
