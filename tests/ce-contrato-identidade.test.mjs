// CONTRATO do Clinica Experts, IDENTIDADE do paciente e COMPARADOR de reservas: funcoes puras (sem banco, sem rede).
// Revisao integrada 21/10/2026: estado desconhecido nunca vira "confirmado"; resposta 200 sem os campos essenciais nao e reserva; disponibilidade em texto OU em objetos;
// telefone igual != pessoa igual; reconciliacao so liga a reserva que combina em TUDO.
import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";

process.env.DATABASE_URL ??= `file:${path.join(os.tmpdir(), "alice-contrato-puro.db").replace(/\\/g, "/")}`;
const TZ = "America/Sao_Paulo";
const contract = await import("../dist/clinicaexperts/contract.js");
const identity = await import("../dist/clinicaexperts/identity.js");
const match = await import("../dist/clinicaexperts/match.js");

test("estados do CE: os documentados tem significado; o desconhecido NUNCA vira confirmado", () => {
  for (const s of ["scheduled", "confirmed", "waiting", "progress", "reserved", "rescheduled"]) assert.equal(contract.ceStatusInfo(s).meaning, "active", s);
  assert.equal(contract.ceStatusInfo("done").meaning, "completed");
  assert.equal(contract.ceStatusInfo("canceled").meaning, "cancelled");
  assert.equal(contract.ceStatusInfo("cancelled").meaning, "cancelled");
  assert.equal(contract.ceStatusInfo("noshow").meaning, "no_show");
  for (const s of ["banana", "", "  ", undefined, null, 7]) {
    const i = contract.ceStatusInfo(s);
    assert.equal(i.meaning, null, String(s));
    assert.equal(i.known, false);
  }
  assert.equal(contract.mapCeStatus("banana"), null);
  assert.equal(contract.mapCeStatus("scheduled"), "confirmed");
  assert.equal(contract.mapCeStatus(undefined), null);
});

test("horario sem fuso e lido no fuso da CLINICA; com fuso, direto", () => {
  assert.equal(contract.parseCeInstant("2026-10-09T15:00:00", TZ).toISOString(), "2026-10-09T18:00:00.000Z");
  assert.equal(contract.parseCeInstant("2026-10-09T15:00:00-03:00", TZ).toISOString(), "2026-10-09T18:00:00.000Z");
  assert.equal(contract.parseCeInstant("2026-10-09T18:00:00Z", TZ).toISOString(), "2026-10-09T18:00:00.000Z");
  assert.ok(Number.isNaN(contract.parseCeInstant("lixo", TZ).getTime()));
  // virada de dia: 23:30 locais de 09/10 e 02:30 UTC de 10/10 (o dia local NAO muda)
  assert.equal(contract.parseCeInstant("2026-10-09T23:30:00", TZ).toISOString(), "2026-10-10T02:30:00.000Z");
});

test("reserva: HTTP 200 com corpo estranho NAO e reserva; estado desconhecido e preservado em bruto", () => {
  const ok = contract.parseBookingResource(
    { data: { uuid: "r1", starts_at: "2026-10-17T08:30:00-03:00", ends_at: "2026-10-17T09:30:00-03:00", status: "scheduled", updated_at: "2026-10-16T10:00:00-03:00", patient: { uuid: "p1", name: "Ana", phone: "+55 11 99999-0000" }, professional: { uuid: "pro1" }, procedures: [{ id: 5, name: "Botox", duration: 30 }, { id: 6, name: "Peeling", duration: "x" }] } },
    TZ,
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.booking.procedures.length, 2);
  assert.equal(ok.booking.procedures[1].duration, null);
  assert.equal(ok.booking.hasOffset, true);
  assert.equal(ok.booking.endsAt.toISOString(), "2026-10-17T12:30:00.000Z");
  for (const lixo of [null, undefined, "x", 3, [], {}, { data: {} }, { data: { uuid: "r" } }, { uuid: "r", starts_at: "2026-10-17T08:30:00" }, { uuid: "r", starts_at: "lixo", status: "scheduled" }]) {
    assert.equal(contract.parseBookingResource(lixo, TZ).ok, false, JSON.stringify(lixo));
  }
  const odd = contract.parseBookingResource({ uuid: "r", starts_at: "2026-10-17T08:30:00", status: "pending_review" }, TZ);
  assert.equal(odd.ok, true);
  assert.equal(odd.booking.status.meaning, null);
  assert.equal(odd.booking.status.raw, "pending_review");
});

test("meta da listagem: valores em TEXTO; sem meta utilizavel = null", () => {
  assert.deepEqual(contract.listMeta({ page: "1", last_page: "3", of: "2500", per_page: "1000" }), { page: 1, lastPage: 3, of: 2500, perPage: 1000 });
  assert.equal(contract.listMeta(undefined), null);
  assert.equal(contract.listMeta({ page: "1" }), null);
  assert.equal(contract.listMeta({ page: "x", last_page: "y" }), null);
});

test("/available-hours: texto OU objetos; forma desconhecida vira 'nao verificado', nunca 'dia sem horarios'", () => {
  const day = { year: 2026, month: 10, day: 17 };
  const t = contract.parseAvailableHours(["08:00", "08:15", "09:00:00"], TZ, day);
  assert.equal(t.unrecognized, 0);
  assert.equal(t.starts.length, 3);
  assert.equal(new Date(t.starts[0]).toISOString(), "2026-10-17T11:00:00.000Z");
  const o = contract.parseAvailableHours([{ starts_at: "2026-10-17T08:00:00-03:00" }, { time: "08:30" }, { available: false, time: "09:00" }], TZ, day);
  assert.equal(o.unrecognized, 0);
  assert.equal(o.starts.length, 2);
  assert.equal(o.shape, "objects");
  const u = contract.parseAvailableHours([{ foo: 1 }, "08:00", 42], TZ, day);
  assert.equal(u.unrecognized, 2);
  const e = contract.parseAvailableHours([], TZ, day);
  assert.deepEqual(e.starts, []);
  assert.equal(e.shape, "empty");
});

test("telefone: DDI/DDD/9o digito normalizados; mesmo final com DDD diferente NAO e o mesmo numero", () => {
  assert.deepEqual(identity.canonicalBrPhone("+55 (11) 94949-4707"), { ddd: "11", local: "949494707" });
  assert.deepEqual(identity.canonicalBrPhone("1189494707"), { ddd: "11", local: "989494707" }, "celular antigo, sem o 9");
  assert.deepEqual(identity.canonicalBrPhone("1149494707"), { ddd: "11", local: "49494707" }, "fixo nao ganha o 9");
  assert.equal(identity.samePhone("5511989494707", "1189494707"), true);
  assert.deepEqual(identity.canonicalBrPhone("11949494707"), { ddd: "11", local: "949494707" });
  assert.equal(identity.canonicalBrPhone("123"), null);
  assert.equal(identity.samePhone("5511949494707", "11949494707"), true);
  assert.equal(identity.samePhone("5511949494707", "5521949494707"), false, "DDD diferente");
  assert.equal(identity.samePhone("5511949494707", "5511949494708"), false);
  assert.equal(identity.samePhone(null, "5511949494707"), false);
  const forms = identity.phoneQueryForms("5511949494707");
  assert.ok(forms.includes("5511949494707") && forms.includes("11949494707") && forms.includes("551149494707"));
});

test("varios cadastros no mesmo telefone: so o nome COMPLETO desempata; senao e ambiguo (nunca o primeiro)", () => {
  const a = { uuid: "u1", name: "Maria Souza", phone: "5511949494707" };
  const b = { uuid: "u2", name: "Carlos Souza", phone: "5511949494707" };
  assert.equal(identity.pickCandidate([], "Maria Souza").status, "none");
  assert.equal(identity.pickCandidate([a], "Qualquer").status, "found");
  assert.equal(identity.pickCandidate([a], "Maria").status, "found", "apelido de uma palavra nao contradiz");
  assert.equal(identity.pickCandidate([a], "Carlos Souza").status, "none", "um so cadastro, mas de OUTRA pessoa (marido na linha da esposa): nao e ele");
  assert.equal(identity.pickCandidate([a, b], "Carlos Souza").candidate.uuid, "u2");
  assert.equal(identity.pickCandidate([a, b], "Carlos").status, "ambiguous", "so o primeiro nome nao desempata");
  assert.equal(identity.pickCandidate([a, b], null).status, "ambiguous");
  assert.equal(identity.pickCandidate([a, { ...b, name: "maria souza" }], "Maria Souza").status, "ambiguous", "dois com o mesmo nome");
});

function ceBooking(over = {}) {
  const r = contract.parseBookingResource(
    { uuid: "r1", starts_at: "2026-10-17T08:30:00-03:00", ends_at: "2026-10-17T09:00:00-03:00", status: "scheduled", patient: { uuid: "p1", name: "Ana Lima", phone: "11999990000" }, professional: { uuid: "pro1" }, procedures: [{ id: 5 }], ...over },
    TZ,
  );
  assert.equal(r.ok, true);
  return r.booking;
}
const local = (over = {}) => ({
  id: "a1", status: "confirmed", ceBookingUuid: null, scheduledAt: new Date("2026-10-17T11:30:00Z"), endsAt: null, durationMin: 30,
  professionalCeUuid: "pro1", procedureCeIds: [5], personCeUuid: "p1", personName: "Ana Lima", personPhone: "5511999990000", ...over,
});

test("comparador estrito: so liga quando pessoa, profissional, procedimentos, inicio e fim conferem", () => {
  assert.equal(match.matchReservation(local(), ceBooking()).match, true);
  const no = (l, c, opts) => {
    const v = match.matchReservation(l, c, opts);
    assert.equal(v.match, false);
    return v.reasons.join("|");
  };
  assert.match(no(local({ professionalCeUuid: "pro2" }), ceBooking()), /profissional diferente/);
  assert.match(no(local({ procedureCeIds: [9] }), ceBooking()), /procedimentos diferentes/);
  assert.match(no(local({ durationMin: 60 }), ceBooking()), /fim diferente/);
  assert.match(no(local({ scheduledAt: new Date("2026-10-17T11:45:00Z") }), ceBooking()), /inicio diferente/);
  assert.match(no(local({ personCeUuid: "p2" }), ceBooking()), /paciente diferente/);
  assert.match(no(local(), ceBooking({ status: "canceled" })), /cancelada no CE/);
  assert.match(no(local({ status: "cancelled" }), ceBooking()), /cancelado aqui/);
  assert.match(no(local({ professionalCeUuid: null }), ceBooking()), /profissional nao comparavel/);
  // sem uuid do paciente: telefone + nome compativel; telefone igual com NOME diferente nao serve (casal)
  assert.equal(match.matchReservation(local({ personCeUuid: null }), ceBooking()).match, true);
  assert.match(no(local({ personCeUuid: null, personName: "Carlos Lima" }), ceBooking()), /paciente nao confere/);
  // reserva do CE sem procedimento escolhido: so liga se o PROFISSIONAL igual desempata
  const semProc = ceBooking({ procedures: [] });
  assert.equal(match.matchReservation(local(), semProc, { allowMissingProcedures: true }).match, true);
  assert.match(no(local({ professionalCeUuid: "pro2" }), semProc, { allowMissingProcedures: true }), /profissional diferente/);
  assert.match(no(local(), semProc), /procedimentos nao comparaveis/);
});

test("dois agendamentos locais combinam com a mesma reserva = ambiguo (nada e ligado); um so = ele", () => {
  const b = ceBooking();
  assert.equal(match.pickUniqueMatch([local({ id: "a1" }), local({ id: "a2" })], b).status, "ambiguous");
  assert.equal(match.pickUniqueMatch([local({ id: "a1" }), local({ id: "a2", professionalCeUuid: "pro2" })], b).item.id, "a1");
  assert.equal(match.pickUniqueMatch([local({ professionalCeUuid: "pro2" })], b).status, "none");
});

test("nomes: apelido de uma palavra e compativel; primeiro nome diferente nao", () => {
  assert.equal(match.namesCompatible("Mari", "Mariana Costa"), true);
  assert.equal(match.namesCompatible("Carlos Souza", "Maria Souza"), false);
  assert.equal(match.namesCompatible(null, "Maria"), true);
});
