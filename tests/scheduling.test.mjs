import assert from "node:assert/strict";
import test from "node:test";
import { wallClockInZone, zonedWallClockToUtc, isoDateInZone, upcomingWeekdayTable } from "../dist/scheduling/time.js";
import { clinicHoursOf, resolveHours, evaluateSlot, generateSlots } from "../dist/scheduling/slots.js";
import { nationalHolidays, nationalHolidayOn, upcomingNationalHolidays } from "../dist/scheduling/holidays.js";

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
  assert.equal(herda.workStartMinutes, 9 * 60);
  assert.equal(herda.workEndMinutes, 18 * 60);

  const proprio = resolveHours(clinicSrc, { workDays: "2,4", workStartHour: 13, workEndHour: null });
  assert.equal(proprio.workStartMinutes, 13 * 60);
  assert.equal(proprio.workEndMinutes, 18 * 60); // herdou
  assert.deepEqual([...proprio.workDays].sort(), [2, 4]);
});

test("clinicHoursOf e resolveHours combinam hora+minuto (ex.: 8h30-11h45 de intervalo)", () => {
  const clinicSrc = {
    timezone: SP, workStartHour: 8, workStartMinute: 30, workEndHour: 18, workDays: "1,2,3,4,5",
    lunchStartHour: 11, lunchStartMinute: 45, lunchEndHour: 14, lunchEndMinute: 0,
  };
  const base = clinicHoursOf(clinicSrc);
  assert.equal(base.workStartMinutes, 8 * 60 + 30);
  assert.equal(base.lunchStartMinutes, 11 * 60 + 45);
  assert.equal(base.lunchEndMinutes, 14 * 60);

  // profissional so sobrescreve a hora, sem minuto -> minuto fica 0 (nao herda o da clinica)
  const proprio = resolveHours(clinicSrc, { workDays: null, workStartHour: 9, workEndHour: null });
  assert.equal(proprio.workStartMinutes, 9 * 60);
  assert.equal(proprio.lunchStartMinutes, 11 * 60 + 45); // esse campo nao foi sobrescrito, herdou inteiro
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

// Caso real: Dr. Saulo Silva atende 08:30-11:45 e 14:00-18:00. Antes dos
// campos de minuto, o sistema so conhecia hora cheia e oferecia 08:00 (fora
// do expediente), 12:00/13:00 (dentro do intervalo) e nunca 17:xx.
test("generateSlots com expediente em meia-hora (08:30-11:45 e 14:00-18:00)", () => {
  const now = new Date("2026-09-07T11:00:00Z"); // segunda 08:00 SP
  const meiaHora = clinicHoursOf({
    timezone: SP, workDays: "1,2,3,4,5",
    workStartHour: 8, workStartMinute: 30, workEndHour: 18, workEndMinute: 0,
    lunchStartHour: 11, lunchStartMinute: 45, lunchEndHour: 14, lunchEndMinute: 0,
  });

  const slots = generateSlots({ hours: meiaHora, durationMin: 30, busy: [], now, daysAhead: 1, limit: 50 });
  const horarios = slots.map((s) => wallClockInZone(s.start, SP)).map((wc) => `${wc.hour}:${String(wc.minute).padStart(2, "0")}`);

  assert.ok(horarios.includes("8:30"), "primeiro horario e 08:30, nao 08:00");
  assert.ok(!horarios.includes("8:00"), "nunca oferece antes do expediente comecar");
  assert.ok(!horarios.includes("12:00") && !horarios.includes("13:00"), "nunca oferece dentro do intervalo");
  assert.ok(horarios.includes("17:30"), "oferece 17:30 (ultimo horario de 30min antes de fechar as 18h)");
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

// --- Feriados nacionais ---

test("feriados nacionais batem com o calendario civil (Sexta-feira Santa e movel)", () => {
  const knownGoodFriday = { 2024: "03-29", 2025: "04-18", 2026: "04-03", 2027: "03-26" };
  for (const [year, expected] of Object.entries(knownGoodFriday)) {
    const gf = nationalHolidays(Number(year)).find((h) => h.name === "Sexta-feira Santa");
    const got = `${String(gf.month).padStart(2, "0")}-${String(gf.day).padStart(2, "0")}`;
    assert.equal(got, expected, `Sexta-feira Santa de ${year}`);
  }
  assert.equal(nationalHolidayOn(2026, 9, 7), "Independência do Brasil");
  assert.equal(nationalHolidayOn(2026, 9, 8), null, "dia comum nao e feriado");
  // Carnaval e Corpus Christi sao ponto facultativo, nao entram na lista automatica.
  assert.ok(!nationalHolidays(2026).some((h) => h.name.includes("Carnaval")));
});

test("upcomingNationalHolidays lista em ordem a partir da data dada", () => {
  const proximos = upcomingNationalHolidays(2026, 9, 15, 3);
  assert.deepEqual(
    proximos.map((h) => h.date),
    ["2026-10-12", "2026-11-02", "2026-11-15"],
  );
});

// --- evaluateSlot respeita o toggle de feriado ---

test("evaluateSlot recusa feriado nacional so quando closedOnHolidays esta ligado", () => {
  const now = new Date("2026-09-01T12:00:00Z");
  const independencia = zonedWallClockToUtc(SP, 2026, 9, 7, 10, 0); // segunda-feira, feriado

  const semFeriado = clinicHoursOf({ timezone: SP, workStartHour: 9, workEndHour: 18, workDays: "1,2,3,4,5", closedOnHolidays: false });
  assert.deepEqual(evaluateSlot({ startUtc: independencia, durationMin: 60, hours: semFeriado, busy: [], now }), { ok: true });

  const comFeriado = clinicHoursOf({ timezone: SP, workStartHour: 9, workEndHour: 18, workDays: "1,2,3,4,5", closedOnHolidays: true });
  assert.deepEqual(evaluateSlot({ startUtc: independencia, durationMin: 60, hours: comFeriado, busy: [], now }), { ok: false, reason: "holiday" });

  // Dia comum da mesma semana continua livre com o toggle ligado.
  const diaComum = zonedWallClockToUtc(SP, 2026, 9, 8, 10, 0);
  assert.deepEqual(evaluateSlot({ startUtc: diaComum, durationMin: 60, hours: comFeriado, busy: [], now }), { ok: true });
});

test("resolveHours propaga closedOnHolidays da clinica pro profissional (nao e algo que se sobrescreve por pessoa)", () => {
  const clinica = { timezone: SP, workStartHour: 9, workEndHour: 18, workDays: "1,2,3,4,5", closedOnHolidays: true };
  const comProfissional = resolveHours(clinica, { workDays: "1,2,3,4,5,6", workStartHour: null, workEndHour: null });
  assert.equal(comProfissional.closedOnHolidays, true);
});

test("feriado em que a clinica marcou 'abre' aceita horario; os demais continuam fechados", () => {
  const now = new Date("2026-09-01T12:00:00Z");
  const independencia = zonedWallClockToUtc(SP, 2026, 9, 7, 10, 0);
  const base = { timezone: SP, workStartHour: 9, workEndHour: 18, workDays: "1,2,3,4,5", closedOnHolidays: true };
  const abre = clinicHoursOf({ ...base, holidayOpen: "Independência do Brasil,Natal" });
  assert.deepEqual(evaluateSlot({ startUtc: independencia, durationMin: 60, hours: abre, busy: [], now }), { ok: true });
  const outro = clinicHoursOf({ ...base, holidayOpen: "Natal" });
  assert.deepEqual(evaluateSlot({ startUtc: independencia, durationMin: 60, hours: outro, busy: [], now }), { ok: false, reason: "holiday" });
  const vazio = clinicHoursOf({ ...base, holidayOpen: "" });
  assert.deepEqual(evaluateSlot({ startUtc: independencia, durationMin: 60, hours: vazio, busy: [], now }), { ok: false, reason: "holiday" });
});
