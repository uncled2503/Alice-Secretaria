// Feriados nacionais do Brasil. So os federais/estatutarios (data certa +
// Sexta-feira Santa, que e ligada a Pascoa por lei). Carnaval e Corpus
// Christi ficam de fora de proposito: sao "ponto facultativo", nao feriado
// por lei, e a pratica de fechar ou nao nesses dias varia muito de clinica
// pra clinica - quem quiser fechar nesses dias usa um bloqueio manual em vez
// do toggle automatico (ver "Bloqueios de agenda" no painel).

export interface Holiday {
  month: number; // 1-12
  day: number;
  name: string;
}

const FIXED_HOLIDAYS: Holiday[] = [
  { month: 1, day: 1, name: "Confraternização Universal" },
  { month: 4, day: 21, name: "Tiradentes" },
  { month: 5, day: 1, name: "Dia do Trabalho" },
  { month: 9, day: 7, name: "Independência do Brasil" },
  { month: 10, day: 12, name: "Nossa Senhora Aparecida" },
  { month: 11, day: 2, name: "Finados" },
  { month: 11, day: 15, name: "Proclamação da República" },
  { month: 11, day: 20, name: "Consciência Negra" }, // feriado nacional desde a Lei 14.759/2023
  { month: 12, day: 25, name: "Natal" },
];

// Domingo de Pascoa pelo algoritmo anonimo gregoriano (Meeus/Jones/Butcher).
function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

function addDays(year: number, month: number, day: number, delta: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + delta);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

const cache = new Map<number, Holiday[]>();

// Feriados nacionais de um ano, incluindo o movel (Sexta-feira Santa).
export function nationalHolidays(year: number): Holiday[] {
  const cached = cache.get(year);
  if (cached) return cached;

  const easter = easterSunday(year);
  const goodFriday = addDays(year, easter.month, easter.day, -2);
  const list = [...FIXED_HOLIDAYS, { month: goodFriday.month, day: goodFriday.day, name: "Sexta-feira Santa" }].sort(
    (a, b) => a.month - b.month || a.day - b.day,
  );
  cache.set(year, list);
  return list;
}

// Nome do feriado nacional numa data (AAAA-MM-DD como numeros soltos, ja no
// fuso da clinica), ou null se nao for feriado.
export function nationalHolidayOn(year: number, month: number, day: number): string | null {
  return nationalHolidays(year).find((h) => h.month === month && h.day === day)?.name ?? null;
}

// Proximos N feriados nacionais a partir de uma data (inclusive), pro painel
// mostrar "o que o toggle vai bloquear" em vez de pedir confianca cega.
export function upcomingNationalHolidays(fromYear: number, fromMonth: number, fromDay: number, count: number): { date: string; name: string }[] {
  const out: { date: string; name: string }[] = [];
  for (let year = fromYear; out.length < count && year <= fromYear + 2; year++) {
    for (const h of nationalHolidays(year)) {
      if (year === fromYear && (h.month < fromMonth || (h.month === fromMonth && h.day < fromDay))) continue;
      out.push({ date: `${year}-${String(h.month).padStart(2, "0")}-${String(h.day).padStart(2, "0")}`, name: h.name });
      if (out.length >= count) break;
    }
  }
  return out;
}
