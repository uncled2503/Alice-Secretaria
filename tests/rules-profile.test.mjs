import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RULES, rulesForProfile } from "../dist/ai/rules.js";

const BUCKETS = new Set(["common", "comercial", "consultivo", "evaluation_first", "medical_safety", "varejo"]);

test("toda regra recomendada tem balde valido", () => {
  for (const r of DEFAULT_RULES) {
    assert.ok(r.buckets.length > 0, `sem balde: ${r.instruction}`);
    for (const b of r.buckets) assert.ok(BUCKETS.has(b), `balde invalido "${b}"`);
  }
});

test("negocio generico (geral) = so o balde varejo, nenhum de clinica", () => {
  const set = rulesForProfile({ businessType: "geral", servicePosture: "comercial", clinicKind: "estetica", evaluationFirst: false });
  assert.ok(set.length > 0);
  assert.ok(set.every((r) => r.buckets.includes("varejo")));
  assert.ok(!set.some((r) => r.buckets.includes("common")));
  assert.ok(!set.some((r) => r.buckets.includes("medical_safety")));
});

test("perfil comercial estetica = common + comercial", () => {
  const set = rulesForProfile({ servicePosture: "comercial", clinicKind: "estetica", evaluationFirst: false });
  assert.ok(set.every((r) => r.buckets.includes("common") || r.buckets.includes("comercial")));
  assert.ok(set.some((r) => r.buckets.includes("comercial")));
  assert.ok(!set.some((r) => r.buckets.includes("consultivo")));
  assert.ok(!set.some((r) => r.buckets.includes("medical_safety")));
});

test("perfil consultivo medica com avaliacao primeiro puxa todos os baldes certos", () => {
  const set = rulesForProfile({ servicePosture: "consultivo", clinicKind: "medica", evaluationFirst: true });
  assert.ok(set.some((r) => r.buckets.includes("consultivo")));
  assert.ok(set.some((r) => r.buckets.includes("medical_safety")));
  assert.ok(set.some((r) => r.buckets.includes("evaluation_first")));
  assert.ok(!set.some((r) => r.buckets.includes("comercial")));
});

test("trocar comercial->consultivo troca o conjunto de regras", () => {
  const com = new Set(rulesForProfile({ servicePosture: "comercial", clinicKind: "estetica", evaluationFirst: false }).map((r) => r.instruction));
  const con = new Set(rulesForProfile({ servicePosture: "consultivo", clinicKind: "estetica", evaluationFirst: false }).map((r) => r.instruction));
  // pelo menos uma regra comercial sai e pelo menos uma consultiva entra
  assert.ok([...com].some((i) => !con.has(i)));
  assert.ok([...con].some((i) => !com.has(i)));
});
