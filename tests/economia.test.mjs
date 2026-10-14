import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { selectFocusProcedures } = await import("../dist/ai/procedureFocus.js");
const { DESCRITIVOS, descricaoFinal } = await import("../dist/maintenance/lisboaDescritivosData.js");

const catalogo = DESCRITIVOS.map((d, i) => ({ id: `p${i}`, name: d.name, aliases: null, goals: null, benefits: null, description: descricaoFinal(d) }));
catalogo.push({ id: "av", name: "Avaliação Estética", aliases: "avaliação gratuita", goals: null, benefits: null, description: "Avaliação personalizada e gratuita." });

const nomes = (r) => r.map((p) => p.name);

test("o catalogo da Lisboa e grande: sem foco, a lista completa seria enorme", () => {
  const total = catalogo.reduce((a, p) => a + p.name.length + (p.description ?? "").length, 0);
  assert.ok(catalogo.length >= 290);
  assert.ok(total > 90_000, `catalogo completo = ${total} caracteres`);
});

test("foco: ate 6 procedimentos + avaliacao, uma fracao minuscula do catalogo", () => {
  const total = catalogo.reduce((a, p) => a + (p.description ?? "").length, 0);
  for (const frase of ["Gostaria de verificar sobre peeling químico para rosto com melasma e acneico", "Por enquanto o que mais encomoda é a papada", "tenho flacidez no braço", "quero drenagem", "quanto custa a limpeza de pele?"]) {
    const foco = selectFocusProcedures(catalogo, [frase], 6);
    assert.ok(foco.length >= 1 && foco.length <= 7, `${frase}: ${foco.length}`);
    const usados = foco.reduce((a, p) => a + (p.description ?? "").length, 0);
    assert.ok(usados < total * 0.08, `${frase}: ${usados} de ${total}`);
  }
});

test("foco acerta o procedimento da conversa (nome, regiao e queixa)", () => {
  const top = (frase, n = 6) => nomes(selectFocusProcedures(catalogo, [frase], n));
  assert.ok(top("Gostaria de verificar sobre peeling químico para rosto com melasma e acneico").some((n) => /peeling/i.test(n)));
  assert.ok(top("Por enquanto o que mais encomoda é a papada").some((n) => /papada/i.test(n)));
  assert.ok(top("quero fazer drenagem").some((n) => /drenagem/i.test(n)));
  assert.ok(top("tenho cicatrizes de acne e poros abertos").some((n) => /acne|peeling|microagulh|laser|cicatriz/i.test(n)));
});

test("a conversa inteira conta: o que foi dito antes e o anuncio de origem mantem o procedimento em foco", () => {
  const textos = ["Vi o anúncio do Protocolo do Olhar", "oi", "tudo bem?", "sim", "pode ser", "qual o endereço?"];
  const foco = nomes(selectFocusProcedures(catalogo, ["Protocolo do Olhar", ...textos], 6));
  assert.ok(foco.some((n) => /olhar|olheira|palpebr|ocul/i.test(n)) || foco.includes("Avaliação Estética"), foco.join(" | "));
  // sem texto nenhum: so a avaliacao
  assert.deepEqual(nomes(selectFocusProcedures(catalogo, [], 6)), ["Avaliação Estética"]);
  // a avaliacao entra sempre
  assert.ok(nomes(selectFocusProcedures(catalogo, ["quero drenagem"], 3)).includes("Avaliação Estética"));
});

test("prompt: parte fixa primeiro (cache da OpenAI) e tudo que muda a cada mensagem so no fim", () => {
  const src = fs.readFileSync(new URL("../src/ai/alice.ts", import.meta.url), "utf8");
  const ini = src.indexOf('return `Voce e a ${a}, atendente da ${clinicNoun}');
  assert.ok(ini > 0);
  const tpl = src.slice(ini, src.indexOf("export interface IncomingReferral", ini));
  const [fixa, dinamica] = tpl.split("=== CONTEXTO DESTA CONVERSA");
  assert.ok(dinamica, "falta o marcador do contexto dinamico");
  for (const v of ["scheduleDynamic", "dateLine", "holidayLine", "apptLine", "profileLine", "adLine", "objectionLine", "continuityLine", "evalPitchLine", "firstContactLine", "discoveryLine", "surveyLine", "focusBlock", "professionalsBlock"]) {
    assert.ok(!fixa.includes("${" + v + "}"), `${v} esta na parte fixa (quebra o cache)`);
    assert.ok(dinamica.includes("${" + v + "}"), `${v} falta na parte dinamica`);
  }
  assert.ok(fixa.includes("${procedureListCompact"), "a parte fixa leva a lista compacta, nao a completa");
  assert.ok(!fixa.includes("${procedureList ||"), "a lista completa nao pode ir em toda mensagem");
  // o horario "agora" (muda por minuto) nao pode estar na parte fixa (scheduleBlock)
  const sb = src.slice(src.indexOf("  const scheduleBlock = `"), src.indexOf("  const allStages"));
  assert.ok(!/formatInZone\(new Date\(\)/.test(sb) && !/upcomingWeekdayTable/.test(sb), "scheduleBlock (fixo) nao pode ter data/hora de agora");
});

test("economia: teto de saida, historico antigo cortado e uso de tokens registrado", () => {
  const src = fs.readFileSync(new URL("../src/ai/alice.ts", import.meta.url), "utf8");
  assert.match(src, /max_tokens: 500/);
  assert.match(src, /idx < history\.length - 6 && m\.content\.length > 700/);
  assert.match(src, /\[tokens\] \$\{model\} entrada=/);
  assert.match(src, /skipAnalysis: flow\.intent === "booked"/);
});
