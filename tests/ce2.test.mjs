import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { extractProcedureIds, skipReasonText } = await import("../dist/clinicaexperts/pull.js");

test("procedimento da reserva: aceita lista, id solto, objeto, servico, item e pacote; ignora lixo", () => {
  assert.deepEqual(extractProcedureIds({ procedures: [{ id: 5 }, { id: "7" }] }), [5, 7]);
  assert.deepEqual(extractProcedureIds({ procedures: [] }), []);
  assert.deepEqual(extractProcedureIds({ procedure: { id: 3 } }), [3]);
  assert.deepEqual(extractProcedureIds({ procedure: 12 }), [12]);
  assert.deepEqual(extractProcedureIds({ services: [{ procedure: { id: 9 } }] }), [9]);
  assert.deepEqual(extractProcedureIds({ items: [{ procedure_id: 4, quantity: 1 }] }), [4]);
  assert.deepEqual(extractProcedureIds({ packages: [{ procedures: [{ id: 11 }, { id: 11 }] }] }), [11]);
  assert.deepEqual(extractProcedureIds({ sessions: [{ id: 21 }] }), [21]);
  assert.deepEqual(extractProcedureIds({ procedures: [{ id: 5 }], services: [{ id: 99 }] }), [5]); // o primeiro campo com dado vale
  for (const lixo of [null, undefined, "x", 3, [], {}, { procedures: "abc" }, { items: [{ foo: 1 }] }]) {
    assert.deepEqual(extractProcedureIds(lixo), [], String(JSON.stringify(lixo)));
  }
});

test("a importacao tenta outros campos e o detalhe da reserva antes de desistir (e guarda o diagnostico)", () => {
  const src = fs.readFileSync(new URL("../src/clinicaexperts/pull.ts", import.meta.url), "utf8");
  const i = src.indexOf("Reservas novas e futuras SEM procedimento na lista");
  const j = src.indexOf("Reservas novas e futuras cujo procedimento ainda nao existe");
  assert.ok(i > 0 && j > i, "o enriquecimento vem antes de procurar procedimentos faltantes");
  const bloco = src.slice(i, j);
  assert.match(bloco, /extractProcedureIds\((b|w\.raw)\)/); // (a reserva agora e um objeto validado `b` + o registro bruto `w.raw`; a extracao de outros campos continua igual)
  assert.match(bloco, /\/bookings\/\$\{b\.uuid\}/);
  assert.match(bloco, /detailCalls < 20/); // teto por rodada
  assert.match(bloco, /3_600_000/); // 1x por hora por reserva
  assert.match(bloco, /lastBookingDiagnostics\.set/);
  // dados pessoais nunca vao para o diagnostico
  assert.match(src, /PERSONAL_KEY = \/name\|nome\|phone/);
});

test("diagnostico de reservas: so admin e sem nome/telefone no retorno", () => {
  const routes = fs.readFileSync(new URL("../src/api/routes.ts", import.meta.url), "utf8");
  const i = routes.indexOf('"/clinics/lisboa-diagnostico-reservas-ce"');
  assert.ok(i > 0);
  const corpo = routes.slice(i, i + 1400);
  assert.match(corpo, /requireAdmin/);
  const retorno = /res\.json\(\{[\s\S]*?samples:[^\n]*\n/.exec(corpo)?.[0] ?? "";
  assert.ok(retorno.length > 20 && /samples/.test(retorno));
  assert.doesNotMatch(retorno, /patient|phone|name/i); // o que volta para a tela nao tem nome nem telefone
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="btn-lisboa-diag-ce"/);
});

test("o aviso diz 'reserva sem procedimento' quando a lista vem vazia", () => {
  assert.match(skipReasonText({ reason: "procedimento_sem_vinculo", procedureNames: [] }), /reserva sem procedimento no Clínica Experts/);
});
