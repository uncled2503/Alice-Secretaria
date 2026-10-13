import test from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET ??= "y".repeat(40);

const { combinePreProcedureTexts, tidyGreeting, ruleCoversProcedure } = await import("../dist/reminders/preProcedure.js");

const BOTOX = "Obrigada pela confirmação, Ana! 💗\nAntes do seu Botox, caso tenha ocorrido alguma mudança no seu estado de saúde, nos avise.";
const PREENCH = "Obrigada pela confirmação, Ana! 💕\nAntes do seu preenchimento, caso tenha iniciado algum medicamento, nos avise.";

test("um procedimento: a mensagem vai inteira, comecando com o agradecimento", () => {
  assert.equal(combinePreProcedureTexts([BOTOX]), BOTOX);
});

test("dois procedimentos no mesmo dia: so a primeira agradece, a segunda segue direto nas orientacoes", () => {
  const out = combinePreProcedureTexts([BOTOX, PREENCH]);
  assert.equal((out.match(/Obrigada pela confirmação/g) ?? []).length, 1);
  assert.ok(out.startsWith("Obrigada pela confirmação, Ana! 💗"));
  assert.ok(out.includes("Antes do seu preenchimento"));
  assert.ok(out.includes("\n\n"));
});

test("sem nome cadastrado nao fica 'confirmação, !'", () => {
  assert.equal(tidyGreeting("Obrigada pela confirmação, ! 💗"), "Obrigada pela confirmação! 💗");
  assert.equal(tidyGreeting("Obrigada pela confirmação, Ana! 💗"), "Obrigada pela confirmação, Ana! 💗");
});

test("filtro de procedimento: vazio vale pra todos, senao so pros ids", () => {
  assert.equal(ruleCoversProcedure("", "p1"), true);
  assert.equal(ruleCoversProcedure("p1,p2", "p2"), true);
  assert.equal(ruleCoversProcedure("p1,p2", "p3"), false);
});
