import test from "node:test";
import assert from "node:assert/strict";

const { DESCRITIVOS, PENDENTES_VALIDACAO, descricaoFinal } = await import("../dist/maintenance/lisboaDescritivosData.js");
const { normName } = await import("../dist/maintenance/applyLisboaServicos.js");

test("o documento inteiro foi carregado (292 descritivos) e nenhum esta vazio", () => {
  assert.equal(DESCRITIVOS.length, 292);
  for (const d of DESCRITIVOS) {
    assert.ok(d.text.length > 30, d.name);
    assert.ok(d.question.endsWith("?"), d.name);
  }
});

test("nomes unicos (sem acento/pontuacao): nenhum descritivo disputa o mesmo procedimento", () => {
  const seen = new Map();
  for (const d of DESCRITIVOS) {
    const k = normName(d.name);
    assert.ok(!seen.has(k), `duplicado: ${d.name} / ${seen.get(k)}`);
    seen.set(k, d.name);
  }
});

test("itens que o documento manda validar com a equipe NAO sao carregados", () => {
  const names = new Set(DESCRITIVOS.map((d) => normName(d.name)));
  for (const p of PENDENTES_VALIDACAO) assert.ok(!names.has(normName(p)), p);
  assert.ok(PENDENTES_VALIDACAO.length >= 9);
});

test("nenhum texto promete resultado nem tem concordancia quebrada", () => {
  for (const d of DESCRITIVOS) {
    const t = d.text.toLowerCase();
    for (const bad of ["vai eliminar", "garantido", "sem risco", "resultado certo", "à abdômen", "à braços", "à costas", "na braços", "região de do ", "região de dos ", "aplicado na coxas", "aplicado na pernas"]) {
      assert.ok(!t.includes(bad), `${d.name}: "${bad}"`);
    }
  }
});

test("medicamentos de prescricao so mandam encaminhar (nao explicam uso)", () => {
  for (const nome of ["Tirzepatida 2,5 mg / 5 mg", "Retatrutida"]) {
    const d = DESCRITIVOS.find((x) => x.name === nome);
    assert.ok(d, nome);
    assert.match(d.text, /encaminhar/);
    assert.match(d.question, /equipe/);
  }
});

test("descricao final = texto + pergunta de continuacao", () => {
  const d = DESCRITIVOS.find((x) => x.name === "Preenchimento Labial");
  const f = descricaoFinal(d);
  assert.ok(f.startsWith("Procedimento injetável para melhorar hidratação"));
  assert.ok(f.includes("\nPergunta para continuar a conversa: Você busca mais definição"));
});
