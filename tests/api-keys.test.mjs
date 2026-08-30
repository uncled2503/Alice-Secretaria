import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { generateApiKey, API_SCOPE_IDS } from "../dist/api/external/keys.js";

test("generateApiKey gera segredo prefixado, lookup e hash coerentes", () => {
  const a = generateApiKey();
  const b = generateApiKey();

  assert.ok(a.secret.startsWith("alk_"));
  assert.notEqual(a.secret, b.secret);
  assert.equal(a.lookup, a.secret.slice(0, 14));
  assert.equal(a.hash, createHash("sha256").update(a.secret).digest("hex"));
  assert.equal(a.hash.length, 64);
});

test("lista de escopos e estavel e sem duplicatas", () => {
  assert.ok(API_SCOPE_IDS.includes("identity.read"));
  assert.ok(API_SCOPE_IDS.includes("agenda.write"));
  assert.equal(new Set(API_SCOPE_IDS).size, API_SCOPE_IDS.length);
});
