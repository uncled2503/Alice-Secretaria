import assert from "node:assert/strict";
import test from "node:test";
import { buildGate, cellStarts } from "../dist/clinicaexperts/availability.js";
import { dayBoundIso, isoWithOffset } from "../dist/clinicaexperts/client.js";
import { inferExecutors, isInternalProcedure, isSpecializedProcedure } from "../dist/clinicaexperts/sync.js";

const TZ = "America/Sao_Paulo";
const day = { year: 2026, month: 10, day: 8 };
const at = (h, m) => Date.UTC(2026, 9, 8, h + 3, m); // hora local (UTC-3) -> epoch

test("cellStarts converte HH:MM do dia no fuso da clinica", () => {
  assert.deepEqual(cellStarts(TZ, day, ["08:30", "13:00"]), [at(8, 30), at(13, 0)]);
  assert.deepEqual(cellStarts(TZ, day, ["lixo"]), []);
});

test("portao exige TODAS as celulas de 15 min do procedimento livres", () => {
  // livre de 10:00 ate 11:00 (4 celulas)
  const free = new Set(cellStarts(TZ, day, ["10:00", "10:15", "10:30", "10:45"]));
  const gate = buildGate(free, new Set(["2026-10-08"]), TZ);
  assert.equal(gate(at(10, 0), 60), true);
  assert.equal(gate(at(10, 0), 90), false); // 90 min nao cabe
  assert.equal(gate(at(10, 30), 60), false); // passaria das 11:00
  assert.equal(gate(at(10, 30), 30), true);
  assert.equal(gate(at(9, 45), 15), false); // fora do livre
});

test("dia nao carregado (CE fora do ar) nao bloqueia", () => {
  const gate = buildGate(new Set(), new Set(["2026-10-08"]), TZ);
  assert.equal(gate(Date.UTC(2026, 9, 9, 13, 0), 60), true);
  assert.equal(gate(at(10, 0), 60), false); // dia carregado e sem celula livre
});

test("isoWithOffset: offset certo mesmo com segundos/milissegundos", () => {
  assert.equal(isoWithOffset(new Date("2026-10-08T12:34:56.789Z"), TZ), "2026-10-08T09:34:00-03:00");
});

test("dayBoundIso devolve limites de dia inteiro", () => {
  const d = new Date("2026-10-08T12:34:56.789Z");
  assert.equal(dayBoundIso(d, TZ, "start"), "2026-10-08T00:00:00-03:00");
  assert.equal(dayBoundIso(d, TZ, "end"), "2026-10-08T23:59:59-03:00");
});

test("itens internos do catalogo nao viram procedimento", () => {
  for (const n of ["Drenagem - Brinde", "Peeling de Diamante - Cortesia", "Drenagem LEAD", "Modeladora Local Abdomen", "Preencher Ficha de Evolução e Parametros", "Retoque de Botox"]) {
    assert.equal(isInternalProcedure(n), true, n);
  }
  for (const n of ["Botox facial", "Limpeza de Pele", "Avaliação", "Lavieen"]) assert.equal(isInternalProcedure(n), false, n);
});

test("inferExecutors usa o historico, filtra ruido e herda do grupo", () => {
  const procs = [
    { id: 1, name: "Botox facial" },
    { id: 2, name: "Lavieen Melasma" }, // sem historico proprio, mesmo grupo (especializado)
    { id: 3, name: "Massagem Relaxante" },
  ];
  const mk = (pro, id, n) => Array.from({ length: n }, () => ({ professionalUuid: pro, procedureIds: [id] }));
  const bookings = [...mk("aline", 1, 30), ...mk("sabrina", 1, 8), ...mk("estagiaria", 1, 1), ...mk("adri", 3, 20)];
  const active = new Set(["aline", "sabrina", "estagiaria", "adri"]);
  const r = inferExecutors(bookings, procs, active);
  assert.deepEqual(r.get(1).sort(), ["aline", "sabrina"]); // 1 execucao nao conta
  assert.deepEqual(r.get(3), ["adri"]);
  assert.deepEqual(r.get(2).sort(), ["aline", "sabrina"]); // herda do grupo especializado
  assert.equal(isSpecializedProcedure("Botox facial"), true);
  assert.equal(isSpecializedProcedure("Massagem Relaxante"), false);
});

test("profissional inativo nunca e vinculado", () => {
  const r = inferExecutors(
    Array.from({ length: 10 }, () => ({ professionalUuid: "ex-funcionaria", procedureIds: [1] })),
    [{ id: 1, name: "Botox facial" }],
    new Set(["outra"]),
  );
  assert.deepEqual(r.get(1), []);
});
