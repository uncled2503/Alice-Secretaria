import test from "node:test";
import assert from "node:assert/strict";

const { splitSentences, repeatedSentences, removeSentences, askedAgain, findRepetitions, conversationMemory } = await import("../dist/ai/repetition.js");

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

test("mesmo assunto com outras palavras (valor) e cortado quando a pessoa perguntou de outra coisa", () => {
  const draft = "O investimento varia conforme cada caso e a equipe apresenta os valores. Atendemos de segunda a sexta, das 8h às 21h. Qual dia fica melhor?";
  const found = findRepetitions(draft, [R1], "Quais dias vocês atendem?");
  assert.deepEqual(found, ["O investimento varia conforme cada caso e a equipe apresenta os valores."]);
});

test("se a pessoa perguntou o valor de novo, falar do valor e legitimo", () => {
  const draft = "O investimento varia conforme cada caso e a equipe apresenta os valores.";
  assert.deepEqual(findRepetitions(draft, [R1], "Quanto custa mesmo?"), []);
});

test("preco novo (outra ideia) nao e cortado so porque ja falou de valor antes", () => {
  const draft = "Três sessões saem por R$ 400 no pix.";
  assert.deepEqual(findRepetitions(draft, [R1], "e se eu fizer mais?"), []);
});

test("mesma pergunta de fechamento com outras palavras e detectada", () => {
  const prior = ["Entendi. O que você gostaria de melhorar ou saber mais?"];
  const found = findRepetitions("Faz sentido. O que você gostaria de saber mais?", prior, "ok");
  assert.deepEqual(found, ["O que você gostaria de saber mais?"]);
});

test("pergunta de fechamento nova passa", () => {
  const prior = ["Entendi. O que você gostaria de melhorar ou saber mais?"];
  assert.deepEqual(findRepetitions("Faz sentido. Você já fez algum procedimento antes?", prior, "ok"), []);
});

test("memoria da conversa: o que ja foi dito, perguntado e respondido", () => {
  const memory = conversationMemory([R1], ["Qual o valor da hidrolipoclasia?", "Também"]);
  assert.match(memory, /valor\/investimento/);
  assert.match(memory, /O que você gostaria de melhorar ou saber mais\?/);
  assert.match(memory, /Qual o valor da hidrolipoclasia\?/);
  assert.equal(conversationMemory([], []), "");
});

test("quando a pessoa repete a pergunta, repetir a resposta e legitimo", () => {
  assert.equal(askedAgain("qual o valor da hidrolipoclasia?", ["Qual o valor da hidrolipoclasia", "tem horario sabado?"]), true);
  assert.equal(askedAgain("Qual dias vocês atende??", ["Qual o valor da hidrolipoclasia", "Também"]), false);
});
