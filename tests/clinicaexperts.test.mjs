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

import { mapCeStatus, normalizeCePhone } from "../dist/clinicaexperts/pull.js";
import { reminderSendTime } from "../dist/reminders/cron.js";

test("status e telefone do Clinica Experts viram os da Alice", () => {
  assert.equal(mapCeStatus("scheduled"), "confirmed");
  assert.equal(mapCeStatus("canceled"), "cancelled");
  assert.equal(mapCeStatus("noshow"), "no_show");
  assert.equal(mapCeStatus("completed"), "completed");
  assert.equal(normalizeCePhone("+55 11 94949-4707"), "5511949494707");
  assert.equal(normalizeCePhone("11949494707"), "5511949494707");
  assert.equal(normalizeCePhone("123"), null);
});

test("lembrete nunca sai antes das 7h locais", () => {
  const consulta8h = new Date(Date.UTC(2026, 9, 8, 11, 0)); // 08:00 em Sao Paulo
  // 3h antes seria 05:00 -> adia pra 07:00
  assert.equal(reminderSendTime(consulta8h, 3, TZ).getTime(), Date.UTC(2026, 9, 8, 10, 0));
  // 24h antes = 08:00 do dia anterior, sem ajuste
  assert.equal(reminderSendTime(consulta8h, 24, TZ).getTime(), consulta8h.getTime() - 24 * 3_600_000);
});

import { fixedReminderTime } from "../dist/reminders/cron.js";
import { isWithinClinicHours } from "../dist/crm/openHours.js";
import { isEvaluationName } from "../dist/clinicaexperts/pull.js";

test("confirmacao em horario fixo: 7h30 do dia anterior e 7h do proprio dia", () => {
  const consulta = new Date(Date.UTC(2026, 9, 8, 13, 0)); // 08/10 10:00 em Sao Paulo
  assert.equal(fixedReminderTime(consulta, 1, 7, 30, TZ).getTime(), Date.UTC(2026, 9, 7, 10, 30)); // 07/10 07:30
  assert.equal(fixedReminderTime(consulta, 0, 7, 0, TZ).getTime(), Date.UTC(2026, 9, 8, 10, 0)); // 08/10 07:00
  // virada de mes: consulta dia 1 -> dia anterior e o ultimo do mes anterior
  const dia1 = new Date(Date.UTC(2026, 10, 1, 13, 0));
  assert.equal(fixedReminderTime(dia1, 1, 7, 30, TZ).getTime(), Date.UTC(2026, 9, 31, 10, 30));
});

test("recontato so dentro do expediente (dias, horas e sabado ate 15h)", () => {
  const clinic = { timezone: TZ, workDays: "1,2,3,4,5,6", workStartHour: 8, workEndHour: 21, hoursByDay: '{"6":[8,15]}' };
  const at = (d, h) => new Date(Date.UTC(2026, 9, d, h + 3, 0)); // outubro/2026, hora local
  assert.equal(isWithinClinicHours(clinic, at(7, 10)), true); // quarta 10h
  assert.equal(isWithinClinicHours(clinic, at(7, 21)), false); // quarta 21h (fechou)
  assert.equal(isWithinClinicHours(clinic, at(7, 7)), false); // quarta 7h (antes de abrir)
  assert.equal(isWithinClinicHours(clinic, at(10, 14)), true); // sabado 14h
  assert.equal(isWithinClinicHours(clinic, at(10, 16)), false); // sabado 16h (fecha 15h)
  assert.equal(isWithinClinicHours(clinic, at(11, 10)), false); // domingo
});

test("avaliacao e reconhecida pelo nome", () => {
  assert.equal(isEvaluationName("Avaliação Estética Gratuita"), true);
  assert.equal(isEvaluationName("Avaliacao"), true);
  assert.equal(isEvaluationName("Drenagem Linfática"), false);
});

import { inReminderWindow } from "../dist/reminders/cron.js";

test("janela de confirmacao: dia seguinte 12h-18h e do dia 7h-10h", () => {
  const consulta = new Date(Date.UTC(2026, 9, 9, 17, 0)); // 09/10 14:00 em Sao Paulo
  const amanha = { dayOffset: 1, sendHour: 12, sendMinute: 0, sendEndHour: 18 };
  const hoje = { dayOffset: 0, sendHour: 7, sendMinute: 0, sendEndHour: 10 };
  const local = (d, h, m = 0) => new Date(Date.UTC(2026, 9, d, h + 3, m));
  // dia seguinte: so na tarde do dia 08
  assert.equal(inReminderWindow(consulta, local(8, 11, 59), amanha, TZ), false);
  assert.equal(inReminderWindow(consulta, local(8, 12), amanha, TZ), true);
  assert.equal(inReminderWindow(consulta, local(8, 17, 59), amanha, TZ), true);
  assert.equal(inReminderWindow(consulta, local(8, 18), amanha, TZ), false);
  // do dia: manha do dia 09, mesmo pra consulta das 14h
  assert.equal(inReminderWindow(consulta, local(9, 6, 59), hoje, TZ), false);
  assert.equal(inReminderWindow(consulta, local(9, 7), hoje, TZ), true);
  assert.equal(inReminderWindow(consulta, local(9, 9, 59), hoje, TZ), true);
  assert.equal(inReminderWindow(consulta, local(9, 10), hoje, TZ), false);
});

import { dueScheduledChange } from "../dist/reminders/cron.js";

test("mudanca agendada so entra na data marcada (amanha 00:00 de Sao Paulo)", () => {
  const raw = JSON.stringify({ from: "2026-10-09T03:00:00.000Z", sendHour: 8, sendEndHour: 11, pauseMinSec: 10, pauseMaxSec: 30 });
  assert.equal(dueScheduledChange(raw, new Date("2026-10-09T02:59:59.000Z")), null); // 23:59 de hoje: ainda nao
  assert.equal(dueScheduledChange(raw, new Date("2026-10-09T03:00:00.000Z"))?.sendEndHour, 11); // 00:00 de amanha: entra
  assert.equal(dueScheduledChange(null, new Date()), null);
  assert.equal(dueScheduledChange("lixo", new Date()), null);
});
