import test from "node:test";
import assert from "node:assert/strict";

const { splitSentences, repeatedSentences, removeSentences, askedAgain } = await import("../dist/ai/repetition.js");

const R1 = "O valor da Hidrolipoclasia depende do protocolo de cada pessoa, e nossa equipe apresenta o investimento. Essa técnica auxilia na redução de medidas localizadas e é ótima para contorno corporal. O que você gostaria de melhorar ou saber mais?";

test("quebra em frases", () => {
  assert.deepEqual(splitSentences("Oi! Tudo bem? Estamos na Av. Índico, 294.\nQuer agendar?"), ["Oi!", "Tudo bem?", "Estamos na Av.", "Índico, 294.", "Quer agendar?"]);
});

test("detecta a re-resposta do print: valor repetido e mesma pergunta de fechamento", () => {
  const draft = "O valor da hidrolipoclasia depende do protocolo de cada pessoa, e nossa equipe apresenta o investimento. Atendemos de segunda a sexta, das 8h às 21h, e aos sábados, das 8h às 15h. O que você gostaria de melhorar ou saber mais?";
  const repeated = repeatedSentences(draft, [R1]);
  assert.equal(repeated.length, 2);
  assert.ok(repeated[0].startsWith("O valor da hidrolipoclasia"));
  assert.ok(repeated[1].startsWith("O que você gostaria"));
  // sem as repetidas sobra so a informacao nova
  assert.equal(removeSentences(draft, repeated), "Atendemos de segunda a sexta, das 8h às 21h, e aos sábados, das 8h às 15h.");
});

test("resposta nova de verdade nao e marcada", () => {
  const draft = "Atendemos de segunda a sexta, das 8h às 21h, e aos sábados, das 8h às 15h. Qual dia fica melhor para você?";
  assert.deepEqual(repeatedSentences(draft, [R1]), []);
});

test("frase curta repetida (Claro!, Perfeito!) nao conta", () => {
  assert.deepEqual(repeatedSentences("Claro! Perfeito!", ["Claro! Perfeito!"]), []);
});

test("quando a pessoa repete a pergunta, repetir a resposta e legitimo", () => {
  assert.equal(askedAgain("qual o valor da hidrolipoclasia?", ["Qual o valor da hidrolipoclasia", "tem horario sabado?"]), true);
  assert.equal(askedAgain("Qual dias vocês atende??", ["Qual o valor da hidrolipoclasia", "Também"]), false);
});
