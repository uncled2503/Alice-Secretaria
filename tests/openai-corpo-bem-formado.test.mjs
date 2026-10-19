// OpenAI "HTTP 400 Invalid body: failed to parse JSON value / invalid_json" (producao, 19/10/2026, juiz de recontato). Causa reproduzida aqui: cortar um texto com slice no meio de um emoji
// deixa um substituto UTF-16 SOZINHO; JSON.stringify o escreve como "\ud83d" e a OpenAI recusa o corpo. Duas defesas: safeSlice (nao parte o par) e safeFetch (ultimo instante).
import assert from "node:assert/strict";
import test from "node:test";
import OpenAI from "openai";

const { safeSlice, wellFormed, hasLoneSurrogateEscape, sanitizeJsonBody, safeFetch } = await import("../dist/ai/wellFormed.js");

const HEART = "\u{1F497}"; // 💗 = 💗
const LONE_HI = "\ud83d";

test("reproducao do defeito: slice no meio do emoji gera substituto sozinho e o corpo serializado fica com escape solto", () => {
  const texto = "a".repeat(9) + HEART + " fim";
  const cortado = texto.slice(0, 10); // corta ENTRE as duas metades do emoji
  assert.equal(cortado.charCodeAt(9), 0xd83d);
  const corpo = JSON.stringify({ messages: [{ role: "user", content: cortado }] });
  assert.equal(hasLoneSurrogateEscape(corpo), true, "e esse corpo que a OpenAI recusa");
});

test("safeSlice nunca deixa a metade de um emoji; texto normal e emoji inteiro continuam iguais", () => {
  const texto = "a".repeat(9) + HEART + " fim";
  assert.equal(safeSlice(texto, 10), "a".repeat(9), "recua uma unidade em vez de partir o par");
  assert.equal(safeSlice(texto, 11), "a".repeat(9) + HEART, "o par inteiro cabe");
  assert.equal(safeSlice("abc", 10), "abc");
  assert.equal(safeSlice("", 5), "");
  for (let n = 0; n <= texto.length; n++) assert.equal(hasLoneSurrogateEscape(JSON.stringify({ t: safeSlice(texto, n) })), false, `corte em ${n}`);
});

test("wellFormed troca substituto solto por U+FFFD e preserva pares validos; escape legitimo de barra nao e confundido", () => {
  assert.equal(wellFormed("oi " + LONE_HI + " tudo"), "oi � tudo");
  assert.equal(wellFormed("oi " + HEART), "oi " + HEART);
  assert.equal(hasLoneSurrogateEscape(JSON.stringify({ t: "texto com a sequencia \\ud83d escrita por extenso" })), false, "barra escapada seguida de ud83d e TEXTO, nao um substituto");
  assert.equal(hasLoneSurrogateEscape(JSON.stringify({ t: HEART })), false, "par valido");
  const sujo = JSON.stringify({ t: "x" + LONE_HI + "y" });
  assert.equal(hasLoneSurrogateEscape(sujo), true);
  const limpo = sanitizeJsonBody(sujo);
  assert.equal(hasLoneSurrogateEscape(limpo), false);
  assert.equal(JSON.parse(limpo).t, "x�y");
});

test("safeFetch, usado como fetch do cliente da OpenAI, corrige o corpo no ultimo instante (qualquer cliente, qualquer texto)", async () => {
  const vistos = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    vistos.push(init.body);
    return new Response(JSON.stringify({ id: "c", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "{}" }, finish_reason: "stop" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const client = new OpenAI({ apiKey: "k", fetch: safeFetch, maxRetries: 0 });
    await client.chat.completions.create({ model: "m", messages: [{ role: "user", content: "oi " + LONE_HI + " tudo bem " + HEART }] });
    assert.equal(vistos.length, 1);
    assert.equal(hasLoneSurrogateEscape(vistos[0]), false, "o que sai para a OpenAI nao tem substituto solto");
    const enviado = JSON.parse(vistos[0]).messages[0].content;
    assert.equal(enviado, "oi � tudo bem " + HEART, "so o solto foi trocado; o emoji valido continua");
    // corpo sem problema passa intacto (mesma string)
    const limpo = JSON.stringify({ a: 1 });
    await safeFetch("https://x.test/", { method: "POST", body: limpo });
    assert.equal(vistos.at(-1), limpo);
  } finally { globalThis.fetch = real; }
});

test("todo cliente de IA do servidor usa safeFetch e os cortes de texto enviados a IA usam safeSlice (nenhum slice cru em prompt)", async () => {
  const fs = await import("node:fs");
  const src = (f) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  for (const f of ["ai/alice.ts", "ai/briefing.ts", "ai/leadBriefing.ts", "ai/learning.ts", "ai/sendGate.ts", "ai/siteAssistant.ts", "ai/teach.ts", "crm/leadSummary.ts", "crm/recontactJudge.ts", "ads/suggest.ts"]) {
    assert.ok(/new OpenAI\(\{[^}]*fetch: safeFetch/.test(src(f)), `${f} usa safeFetch`);
  }
  // o juiz de recontato (onde o erro apareceu) corta o historico com safeSlice
  const judge = src("crm/recontactJudge.ts");
  assert.ok(judge.includes("safeSlice("), "recontactJudge usa safeSlice");
});
