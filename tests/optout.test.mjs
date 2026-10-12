import test from "node:test";
import assert from "node:assert/strict";
import { isOptOutRequest } from "../dist/crm/optout.js";

test("comandos curtos de descadastro", () => {
  for (const t of ["PARAR", "Pare", "sair", "STOP", "descadastrar", "Cancelar mensagens", "parar!!"]) {
    assert.equal(isOptOutRequest(t), true, t);
  }
});

test("frases que pedem pra nao receber mais contato", () => {
  for (const t of [
    "Não quero mais receber mensagens de vocês",
    "por favor parem de me mandar mensagem",
    "pare de me enviar essas promoções",
    "me tire da lista",
    "me remova da sua lista por favor",
    "remova meu número",
    "não me envie mais nada",
    "quero me descadastrar",
  ]) {
    assert.equal(isOptOutRequest(t), true, t);
  }
});

test("conversa normal e pedido de cancelar consulta NAO descadastram", () => {
  for (const t of [
    "quero cancelar minha consulta",
    "preciso remarcar, não posso ir amanhã",
    "pode parar de falar do botox e me falar do preenchimento?",
    "oi, tudo bem?",
    "não quero perder a vaga",
    "Vou sair do trabalho às 18h, posso ir depois?",
    "",
  ]) {
    assert.equal(isOptOutRequest(t), false, t);
  }
  assert.equal(isOptOutRequest(null), false);
  assert.equal(isOptOutRequest("x".repeat(400) + " pare de me enviar"), false); // texto longo = conversa
});
