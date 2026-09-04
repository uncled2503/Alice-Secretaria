import assert from "node:assert/strict";
import test from "node:test";

const { FREE_PLAN, isFreePlan, freePlanBlocksPath } = await import("../dist/crm/plan.js");

test("isFreePlan so reconhece o plano gratis", () => {
  assert.equal(FREE_PLAN, "free");
  assert.equal(isFreePlan("free"), true);
  assert.equal(isFreePlan("prime"), false);
  assert.equal(isFreePlan("prestige"), false);
  assert.equal(isFreePlan(null), false);
  assert.equal(isFreePlan(undefined), false);
});

test("freePlanBlocksPath bloqueia atendimento, agenda e automacoes", () => {
  // Chat: qualquer metodo
  assert.equal(freePlanBlocksPath("GET", "/conversations"), true);
  assert.equal(freePlanBlocksPath("GET", "/conversations/abc/messages"), true);
  assert.equal(freePlanBlocksPath("POST", "/conversations/abc/send"), true);
  // Escrita em area de plano pago
  assert.equal(freePlanBlocksPath("POST", "/procedures"), true);
  assert.equal(freePlanBlocksPath("DELETE", "/procedures/p1"), true);
  assert.equal(freePlanBlocksPath("POST", "/appointments"), true);
  assert.equal(freePlanBlocksPath("PUT", "/reminder-rules/r1"), true);
  assert.equal(freePlanBlocksPath("POST", "/followup-rules"), true);
  assert.equal(freePlanBlocksPath("POST", "/broadcasts"), true);
  assert.equal(freePlanBlocksPath("PATCH", "/rules/x"), true);
  assert.equal(freePlanBlocksPath("POST", "/briefing/apply"), true);
  assert.equal(freePlanBlocksPath("POST", "/api-keys"), true);
});

test("freePlanBlocksPath NAO bloqueia CRM, Meta e leitura", () => {
  // CRM / funil / contatos - o coracao do plano gratis
  assert.equal(freePlanBlocksPath("PUT", "/patients/abc/stage"), false);
  assert.equal(freePlanBlocksPath("GET", "/crm/board"), false);
  assert.equal(freePlanBlocksPath("POST", "/patients"), false);
  assert.equal(freePlanBlocksPath("POST", "/funnel-stages"), false);
  assert.equal(freePlanBlocksPath("POST", "/tags"), false);
  // Meta
  assert.equal(freePlanBlocksPath("PUT", "/meta/config"), false);
  assert.equal(freePlanBlocksPath("POST", "/meta/test-event"), false);
  // Canais (conexao do WhatsApp - pipe de captacao)
  assert.equal(freePlanBlocksPath("POST", "/uazapi/connect"), false);
  // Leitura das areas pagas fica liberada (devolve lista vazia)
  assert.equal(freePlanBlocksPath("GET", "/procedures"), false);
  assert.equal(freePlanBlocksPath("GET", "/reminder-rules"), false);
  assert.equal(freePlanBlocksPath("GET", "/broadcasts"), false);
});

test("freePlanBlocksPath nao confunde prefixo parecido", () => {
  // "/rules-foo" nao e "/rules"
  assert.equal(freePlanBlocksPath("POST", "/rules-export"), false);
  assert.equal(freePlanBlocksPath("POST", "/rules"), true);
  assert.equal(freePlanBlocksPath("POST", "/rules/123"), true);
});
