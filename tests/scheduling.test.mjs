import assert from "node:assert/strict";
import test from "node:test";
import { wallClockInZone, zonedWallClockToUtc, isoDateInZone, upcomingWeekdayTable } from "../dist/scheduling/time.js";
import { clinicHoursOf, resolveHours, evaluateSlot, generateSlots } from "../dist/scheduling/slots.js";

const SP = "America/Sao_Paulo";
const hours = clinicHoursOf({ timezone: SP, workStartHour: 9, workEndHour: 18, workDays: "1,2,3,4,5" });

test("converte hora de parede da clinica para UTC e de volta", () => {
  const utc = zonedWallClockToUtc(SP, 2026, 9, 10, 10, 0);
  assert.equal(utc.toISOString(), "2026-09-10T13:00:00.000Z");

  const wc = wallClockInZone(utc, SP);
  assert.deepEqual(
    { year: wc.year, month: wc.month, day: wc.day, hour: wc.hour, minute: wc.minute },
    { year: 2026, month: 9, day: 10, hour: 10, minute: 0 },
  );
});

test("evaluateSlot recusa passado, dia fechado, fora do horario e conflito", () => {
  const now = new Date("2026-09-07T12:00:00Z"); // segunda 09:00 SP

  assert.deepEqual(
    evaluateSlot({ startUtc: zonedWallClockToUtc(SP, 2026, 9, 4, 10, 0), durationMin: 60, hours, busy: [], now }),
    { ok: false, reason: "past" },
  );

  assert.deepEqual(
    evaluateSlot({ startUtc: zonedWallClockToUtc(SP, 2026, 9, 13, 10, 0), durationMin: 60, hours, busy: [], now }),
    { ok: false, reason: "closed_day" }, // domingo
  );

  assert.deepEqual(
    evaluateSlot({ startUtc: zonedWallClockToUtc(SP, 2026, 9, 10, 8, 0), durationMin: 60, hours, busy: [], now }),
    { ok: false, reason: "outside_hours" }, // antes das 9h
  );

  assert.deepEqual(
    evaluateSlot({ startUtc: zonedWallClockToUtc(SP, 2026, 9, 10, 17, 30), durationMin: 60, hours, busy: [], now }),
    { ok: false, reason: "outside_hours" }, // terminaria 18:30
  );

  const busyStart = zonedWallClockToUtc(SP, 2026, 9, 10, 10, 0).getTime();
  const busy = [{ start: busyStart, end: busyStart + 60 * 60_000 }];

  assert.deepEqual(
    evaluateSlot({ startUtc: zonedWallClockToUtc(SP, 2026, 9, 10, 10, 30), durationMin: 60, hours, busy, now }),
    { ok: false, reason: "conflict" },
  );

  assert.deepEqual(
    evaluateSlot({ startUtc: zonedWallClockToUtc(SP, 2026, 9, 10, 11, 0), durationMin: 60, hours, busy, now }),
    { ok: true },
  );
});

test("resolveHours: profissional sobrescreve so o que preencheu", () => {
  const clinicSrc = { timezone: SP, workStartHour: 9, workEndHour: 18, workDays: "1,2,3,4,5" };

  const herda = resolveHours(clinicSrc, null);
  assert.equal(herda.workStartHour, 9);
  assert.equal(herda.workEndHour, 18);

  const proprio = resolveHours(clinicSrc, { workDays: "2,4", workStartHour: 13, workEndHour: null });
  assert.equal(proprio.workStartHour, 13);
  assert.equal(proprio.workEndHour, 18); // herdou
  assert.deepEqual([...proprio.workDays].sort(), [2, 4]);
});

test("evaluateSlot recusa horario dentro de um bloqueio de agenda", () => {
  const now = new Date("2026-09-07T12:00:00Z");
  const blockStart = zonedWallClockToUtc(SP, 2026, 9, 10, 12, 0).getTime();
  const blocks = [{ start: blockStart, end: blockStart + 2 * 60 * 60_000 }]; // 12h-14h bloqueado

  assert.deepEqual(
    evaluateSlot({ startUtc: zonedWallClockToUtc(SP, 2026, 9, 10, 13, 0), durationMin: 60, hours, busy: [], blocks, now }),
    { ok: false, reason: "blocked" },
  );
  assert.deepEqual(
    evaluateSlot({ startUtc: zonedWallClockToUtc(SP, 2026, 9, 10, 14, 0), durationMin: 60, hours, busy: [], blocks, now }),
    { ok: true },
  );
});

test("generateSlots respeita expediente, dias e conflitos", () => {
  const now = new Date("2026-09-07T11:00:00Z"); // segunda 08:00 SP
  const busyStart = zonedWallClockToUtc(SP, 2026, 9, 10, 10, 0).getTime();
  const busy = [{ start: busyStart, end: busyStart + 60 * 60_000 }];

  const slots = generateSlots({ hours, durationMin: 60, busy, now, daysAhead: 7, limit: 50 });

  assert.ok(slots.length > 0);
  for (const s of slots) {
    const wc = wallClockInZone(s.start, SP);
    assert.ok(wc.weekday >= 1 && wc.weekday <= 5, "nunca cai no fim de semana");
    assert.ok(wc.hour >= 9 && wc.hour < 18, "sempre dentro do expediente");
  }
  assert.ok(!slots.some((s) => s.start.getTime() === busyStart), "pula o horario ocupado");
  assert.ok(slots.some((s) => s.start.getTime() === busyStart + 60 * 60_000), "oferece o horario seguinte livre");
});

// O contexto que a Alice recebe PRECISA trazer o ano. Sem ele o modelo chuta o
// ano do proprio treinamento, monta uma data no passado e a agenda responde
// "esse horario ja passou" pra um dia que ainda nem chegou (bug real em prod).
test("contexto de data da Alice sempre traz o ano", () => {
  const hoje = new Date("2026-09-15T17:44:00Z"); // terca 14:44 SP
  assert.equal(isoDateInZone(hoje, SP), "2026-09-15");

  const tabela = upcomingWeekdayTable(SP, 3);
  for (const parte of tabela.split(", ")) {
    assert.match(parte, /= \d{4}-\d{2}-\d{2}$/, `"${parte}" precisa terminar com a data completa (com ano)`);
  }
  assert.match(tabela, /\(hoje\)/);
  assert.match(tabela, /\(amanha\)/);
});

test("tabela de dias da semana casa o nome do dia com a data certa", () => {
  const tabela = upcomingWeekdayTable(SP, 7);
  for (const parte of tabela.split(", ")) {
    const [nome, iso] = parte.split(" = ");
    const [y, m, d] = iso.split("-").map(Number);
    const wc = wallClockInZone(zonedWallClockToUtc(SP, y, m, d, 12, 0), SP);
    const esperado = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"][wc.weekday];
    assert.equal(nome.replace(/ \((hoje|amanha)\)$/, ""), esperado, `${iso} deveria ser ${esperado}`);
  }
});
