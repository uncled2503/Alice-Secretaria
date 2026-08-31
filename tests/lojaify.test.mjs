import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// lojaify() vive no app.js (código de navegador). Aqui a gente extrai a lista
// de regras direto do fonte e valida as trocas de vocabulário clínica -> loja.
const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const m = src.match(/const LOJA_RE = (\[[\s\S]*?\n\]);/);
assert.ok(m, "não achei o array LOJA_RE no app.js");
const LOJA_RE = eval(m[1]);
const lojaify = (s) => {
  let out = s;
  for (const [re, rep] of LOJA_RE) out = out.replace(re, rep);
  return out;
};

test("troca os nomes principais", () => {
  assert.equal(lojaify("Nome da clínica"), "Nome da loja");
  assert.equal(lojaify("aniversário do paciente"), "aniversário do cliente");
  assert.equal(lojaify("Buscar por paciente, procedimento ou profissional"), "Buscar por cliente, produto ou atendente");
  assert.equal(lojaify("Pós-procedimento"), "Pós-venda");
  assert.equal(lojaify("Taxa de no-show"), "Taxa de falta");
  assert.equal(lojaify("Cada clínica tem"), "Cada loja tem");
  assert.equal(lojaify("Clínicas"), "Lojas");
});

test("não estraga palavras parecidas", () => {
  // "clínico" (adjetivo em outro contexto) não deve virar "lojo"
  assert.equal(lojaify("atendimento clínico"), "atendimento clínico");
  // frase sem termos não muda
  assert.equal(lojaify("Conecte o WhatsApp pelo QR Code"), "Conecte o WhatsApp pelo QR Code");
});

test("dúvida clínica é caso especial (não vira 'dúvida loja')", () => {
  assert.equal(lojaify("em caso de dúvida clínica, transfere"), "em caso de dúvida técnica, transfere");
});
