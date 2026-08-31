import assert from "node:assert/strict";
import test from "node:test";
import { phoneToUf, leadsByState } from "../dist/crm/geo.js";

test("phoneToUf resolve DDD com e sem DDI", () => {
  assert.equal(phoneToUf("5511987654321"), "SP");
  assert.equal(phoneToUf("11987654321"), "SP");
  assert.equal(phoneToUf("(21) 98765-4321"), "RJ");
  assert.equal(phoneToUf("5547999998888"), "SC");
  assert.equal(phoneToUf("5571988887777"), "BA");
});

test("phoneToUf devolve null pra DDD inexistente ou telefone curto", () => {
  assert.equal(phoneToUf("5520987654321"), null); // DDD 20 nao existe
  assert.equal(phoneToUf("12345"), null);
  assert.equal(phoneToUf(""), null);
  assert.equal(phoneToUf(null), null);
});

test("leadsByState agrega e ordena do maior pro menor", () => {
  const r = leadsByState([
    "5511900000001", "5511900000002", "5511900000003", // 3 SP
    "5521900000001", "5521900000002",                   // 2 RJ
    "5531900000001",                                     // 1 MG
    "5520000000000",                                     // ignorado
  ]);
  assert.deepEqual(r, [
    { uf: "SP", count: 3 },
    { uf: "RJ", count: 2 },
    { uf: "MG", count: 1 },
  ]);
});
