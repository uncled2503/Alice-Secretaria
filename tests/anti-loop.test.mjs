import assert from "node:assert/strict";
import test from "node:test";
import { normalizeReply, replySimilarity } from "../dist/ai/alice.js";

test("normalizeReply tira link, pontuacao e emoji", () => {
  assert.equal(
    normalizeReply("Sim! Taxa R$ 29,90 🍼 https://wa.me/551199 até as 14h."),
    "sim taxa r 29 90 ate as 14h",
  );
});

test("respostas quase iguais batem o limiar de repeticao", () => {
  const a =
    "Sim, conseguimos entregar hoje na Maternidade Sao Luiz Star! A taxa de motoboy e de R$ 29,90 para pedidos feitos ate as 14h. Posso te direcionar ao WhatsApp?";
  const b =
    "Sim, conseguimos entregar hoje na Maternidade Sao Luiz Star! A taxa de motoboy e R$ 29,90 para pedidos feitos ate as 14h. Posso te encaminhar para o WhatsApp?";
  assert.ok(replySimilarity(a, b) >= 0.82, `similaridade ${replySimilarity(a, b)}`);
});

test("respostas de assuntos diferentes NAO batem o limiar", () => {
  const a = "Nossos tamanhos vao do Prematuro ao 2. Na duvida entre dois, escolha o maior.";
  const b = "O frete gratis vale para a cidade de Sao Paulo a partir de R$ 399.";
  assert.ok(replySimilarity(a, b) < 0.82, `similaridade ${replySimilarity(a, b)}`);
});

test("resposta curta identica tem similaridade alta, mas o guard so age acima de 25 chars normalizados", () => {
  assert.ok(replySimilarity("Claro, posso ajudar!", "Claro, posso ajudar!") >= 0.82);
  assert.ok(normalizeReply("Claro, posso ajudar!").length <= 25);
});
