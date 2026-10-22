import { wallClockInZone, zonedWallClockToUtc } from "../scheduling/time.js";

// ---------------------------------------------------------------------------
// INTERVALOS POR CALENDARIO (renovacao: "4 meses", "1 ano", "2 meses"). Antes: mes = 30 dias e ano = 365 (um "1 ano" de preenchimento vencia 1 dia antes em ano bissexto e "4 meses" derivava).
// Regra EXPLICITA (no fuso da clinica, preservando o horario de parede):
//  - soma-se o numero de meses/anos ao dia civil; se o dia nao existe no mes de destino, vale o ULTIMO DIA daquele mes
//    (31/10 + 4 meses = 28/02 ou 29/02 em bissexto; 31/08 + 1 mes = 30/09);
//  - 29/02 + 1 ano = 28/02 do ano seguinte quando ele nao e bissexto (o "mesmo dia" de calendario mais proximo, nunca 01/03);
//  - limite de 2 anos (24 meses) como protecao contra dado corrompido.
// ---------------------------------------------------------------------------
export const MAX_INTERVAL_MONTHS = 24;
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m = 1..12

export function intervalMonths(value: number, unit: string): number | null {
  if (unit !== "months" && unit !== "years") return null;
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.min(Math.round(unit === "years" ? value * 12 : value), MAX_INTERVAL_MONTHS);
}

// PURO: `from` + N meses de calendario no fuso `tz`.
export function addCalendarMonths(from: Date, months: number, tz: string): Date {
  const w = wallClockInZone(from, tz);
  const total = w.year * 12 + (w.month - 1) + months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  const d = Math.min(w.day, daysIn(y, m));
  return zonedWallClockToUtc(tz, y, m, d, w.hour, w.minute);
}

// PURO: quando a renovacao VENCE para um atendimento (null = unidade invalida).
export function renewalDueAt(apptStart: Date, endsAt: Date | null | undefined, value: number, unit: string, tz: string): Date | null {
  const months = intervalMonths(value, unit);
  if (months === null) return null;
  return addCalendarMonths(endsAt ?? apptStart, months, tz);
}
