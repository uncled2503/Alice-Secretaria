import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { RULE_CHANGES } = await import("../dist/maintenance/cleanLisboaRules.js");
const seed = fs.readFileSync(new URL("../src/maintenance/seedLisboa.ts", import.meta.url), "utf8");
const seedText = (t) => seed.includes(JSON.stringify(t).slice(1, -1));

test("aprovadas pela clinica: remove 552,581,547,553,537,538,539,467,524; reescreve 485,492,540,509", () => {
  const ap = RULE_CHANGES.filter((c) => c.approved && c.line);
  const by = (a) => ap.filter((c) => c.action === a).map((c) => c.line).sort((x, y) => x - y);
  assert.deepEqual(by("remove"), [467, 524, 537, 538, 539, 547, 552, 553, 581]);
  assert.deepEqual(by("rewrite"), [485, 492, 509, 540]);
});

test("470, 468 e 486 nao foram aprovadas: aguardam ok e nao sao aplicadas", () => {
  for (const n of [470, 468, 486]) assert.equal(RULE_CHANGES.find((c) => c.line === n).approved, false);
});

test("seed novo nasce sem as regras removidas e com os textos reescritos", () => {
  for (const c of RULE_CHANGES) {
    if (!c.approved || !c.line) continue;
    assert.equal(seedText(c.oldText), false, `linha ${c.line} ainda no seed`);
    if (c.action === "rewrite") assert.equal(seedText(c.newText), true, `linha ${c.line} reescrita fora do seed`);
  }
});

test("textos novos nao mandam 'nunca informe valores' nem prometem 'vou verificar com a equipe'", () => {
  for (const c of RULE_CHANGES) {
    if (!c.newText) continue;
    assert.doesNotMatch(c.newText, /nunca informe valores/i);
    assert.doesNotMatch(c.newText, /diga que vai verificar|preciso confirmar com nossa equipe/i);
  }
});
