import test from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET ??= "y".repeat(40);

const { planProcedure } = await import("../dist/clinicaexperts/autoLink.js");

test("procedimento vendavel e ativo entra no cadastro normal", () => {
  assert.equal(planProcedure({ name: "Botox Full Face", active: true }), "normal");
  assert.equal(planProcedure({ name: "Avaliação", active: true }), "normal");
});

test("item interno (retoque, cortesia...) entra como interno: a reserva recebe confirmacao, a Alice nao vende", () => {
  assert.equal(planProcedure({ name: "Retoque de Preenchimento", active: true }), "internal");
  assert.equal(planProcedure({ name: "Cortesia", active: true }), "internal");
});

test("procedimento arquivado no CE mas com reserva entra como interno", () => {
  assert.equal(planProcedure({ name: "Peeling Antigo", active: false }), "internal");
});

test("etiqueta de origem (Lead, Instagram, Indicação) nao e procedimento: nao importa", () => {
  assert.equal(planProcedure({ name: "Lead Instagram", active: true }), "skip");
  assert.equal(planProcedure({ name: "Indicação", active: true }), "skip");
  assert.equal(planProcedure({ name: "Nada", active: true }), "skip");
});
