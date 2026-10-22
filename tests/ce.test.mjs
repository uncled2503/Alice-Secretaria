import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { parseCeBirthDate, birthFieldOf, phoneKey } = await import("../dist/clinicaexperts/birthdays.js");
const { planProcedureLinks } = await import("../dist/clinicaexperts/procedureLink.js");
const { procKey, nameSimilarity } = await import("../dist/clinicaexperts/procKey.js");

test("aniversario do CE: formatos validos viram data (meia-noite UTC) e lixo e ignorado", () => {
  const NOW = new Date("2026-10-14T12:00:00Z");
  assert.equal(parseCeBirthDate("1990-05-17", NOW).toISOString(), "1990-05-17T00:00:00.000Z");
  assert.equal(parseCeBirthDate("1990-05-17T03:00:00.000000Z", NOW).toISOString(), "1990-05-17T00:00:00.000Z");
  assert.equal(parseCeBirthDate("17/05/1990", NOW).toISOString(), "1990-05-17T00:00:00.000Z");
  for (const lixo of ["0001-01-01", "1900-01-01", "2030-01-01", "31/02/1990", "1990-13-40", "abc", "", null, undefined, {}]) {
    assert.equal(parseCeBirthDate(lixo, NOW), null, String(lixo));
  }
});

test("acha o campo de nascimento do paciente do CE, qualquer que seja o nome", () => {
  assert.deepEqual(birthFieldOf({ uuid: "x", birth_date: "1990-05-17" }), { key: "birth_date", raw: "1990-05-17" });
  assert.equal(birthFieldOf({ birthday: "17/05/1990" }).key, "birthday");
  assert.equal(birthFieldOf({ data_de_nascimento: "1990-05-17" }).key, "data_de_nascimento"); // nome "solto"
  assert.deepEqual(birthFieldOf({ name: "Maria", phone: "1" }), { key: null, raw: null });
  assert.deepEqual(birthFieldOf(null), { key: null, raw: null });
});

test("telefone com e sem o 9o digito e com/sem DDI e a mesma pessoa", () => {
  assert.equal(phoneKey("5511994944707"), phoneKey("551194944707")); // celular antigo (8 digitos comecando por 9) = o mesmo numero com o 9
  assert.notEqual(phoneKey("5511949494707"), phoneKey("551149494707"), "fixo (4xxx) e celular com os mesmos 8 digitos finais NAO se fundem");
  assert.equal(phoneKey("+55 11 94949-4707"), phoneKey("11949494707"));
  assert.notEqual(phoneKey("5511949494707"), phoneKey("5511949494708"));
  assert.notEqual(phoneKey("5511949494707"), phoneKey("5521949494707")); // outro DDD
  assert.equal(phoneKey("123"), null);
});

test("procKey ignora acento e pontuacao mas NUNCA junta nomes diferentes (2 placas)", () => {
  assert.equal(procKey("Criolipólise - Abdômen"), procKey("criolipolise abdomen"));
  assert.notEqual(procKey("Criolipólise Abdômen (2 placas)"), procKey("Criolipólise Abdômen"));
  assert.ok(nameSimilarity("Drenagem", "Drenagem Linfática") >= 0.5);
  assert.equal(nameSimilarity("Peeling", "Botox"), 0);
});

test("vinculo de procedimentos: so nome igual vincula; o resto vai para revisao com sugestao", () => {
  const alice = [
    { id: "a1", name: "Avaliação", ceId: 1, internalOnly: false },
    { id: "a2", name: "Criolipólise Abdômen", ceId: null, internalOnly: false },
    { id: "a3", name: "Criolipólise Abdômen (2 placas)", ceId: null, internalOnly: false },
    { id: "a4", name: "Drenagem", ceId: null, internalOnly: false },
    { id: "a5", name: "Procedimento antigo", ceId: 99, internalOnly: false },
    { id: "a6", name: "Retoque", ceId: null, internalOnly: true },
  ];
  const ce = [
    { id: 1, name: "Avaliação", active: true },
    { id: 2, name: "Criolipolise - Abdomen", active: true },
    { id: 3, name: "Criolipolise Abdomen (2 placas)", active: true },
    { id: 4, name: "Drenagem Linfática", active: true },
    { id: 5, name: "Peeling Químico", active: true },
    { id: 6, name: "Inativo", active: false },
  ];
  const plan = planProcedureLinks(alice, ce);
  assert.deepEqual(plan.toLink.map((l) => [l.aliceName, l.ceId]), [["Criolipólise Abdômen", 2], ["Criolipólise Abdômen (2 placas)", 3]]);
  assert.equal(plan.alreadyLinked, 1);
  assert.deepEqual(plan.stale.map((s) => s.aliceName), ["Procedimento antigo"]);
  assert.equal(plan.unmatched.length, 1);
  assert.equal(plan.unmatched[0].aliceName, "Drenagem");
  assert.deepEqual(plan.unmatched[0].suggestions, ["Drenagem Linfática"]);
  assert.deepEqual(plan.ceOnly.sort(), ["Drenagem Linfática", "Peeling Químico"]);
  // dois procedimentos da Alice com o mesmo nome nao disputam o mesmo do CE
  const dup = planProcedureLinks(
    [{ id: "x", name: "Peeling", ceId: null, internalOnly: false }, { id: "y", name: "peeling", ceId: null, internalOnly: false }],
    [{ id: 7, name: "Peeling", active: true }],
  );
  assert.equal(dup.toLink.length, 1);
  assert.equal(dup.unmatched.length, 1);
});

test("a Alice so agenda se o procedimento e o profissional existem no CE (senao passa para a equipe)", () => {
  const src = fs.readFileSync(new URL("../src/ai/alice.ts", import.meta.url), "utf8");
  const i = src.indexOf("const readiness = await ceBookingReadiness(");
  assert.ok(i > 0);
  assert.ok(i < src.indexOf("const booking = await createBooking({"), "a conferencia vem antes de criar o agendamento");
  assert.match(src.slice(i, i + 900), /transfer_to_human/);
  const sync = fs.readFileSync(new URL("../src/clinicaexperts/sync.ts", import.meta.url), "utf8");
  assert.match(sync, /sem vínculo com o Clínica Experts: \$\{faltando\}/); // o alerta diz o que falta
});

test("aniversarios: job diario registrado, importacao tambem no enrich e na importacao de reservas, e botoes so admin", () => {
  const server = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.match(server, /startCeBirthdayJob\(\);/);
  const sync = fs.readFileSync(new URL("../src/clinicaexperts/sync.ts", import.meta.url), "utf8");
  assert.match(sync, /updateMany\(\{ where: \{ id: patient\.id, birthDate: null \}/);
  const pull = fs.readFileSync(new URL("../src/clinicaexperts/pull.ts", import.meta.url), "utf8");
  assert.match(pull, /birthDate: null \}, data: \{ birthDate: birth \}/);
  const routes = fs.readFileSync(new URL("../src/api/routes.ts", import.meta.url), "utf8");
  for (const rota of ["lisboa-aniversarios-ce", "lisboa-vincular-procedimentos"]) {
    const i = routes.indexOf(`"/clinics/${rota}"`);
    assert.ok(i > 0, rota);
    assert.match(routes.slice(i, i + 300), /requireAdmin/);
  }
  const b = fs.readFileSync(new URL("../src/clinicaexperts/birthdays.ts", import.meta.url), "utf8");
  assert.match(b, /birthDate: null \}, data:/); // nunca sobrescreve data ja preenchida
});
