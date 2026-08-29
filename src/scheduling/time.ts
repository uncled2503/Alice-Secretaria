// Utilitarios de fuso horario sem depender de biblioteca externa.
//
// A ideia: Intl.DateTimeFormat sabe converter um instante (Date) para a hora
// de parede de qualquer fuso. A partir disso da pra descobrir o offset do fuso
// naquele instante e montar o caminho inverso (hora de parede -> instante UTC).
// O Brasil nao tem mais horario de verao desde 2019, mas a correcao de DST
// abaixo mantem o codigo correto pra qualquer fuso.

export interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  weekday: number; // 0=domingo .. 6=sabado
}

const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = FORMATTER_CACHE.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    FORMATTER_CACHE.set(timeZone, f);
  }
  return f;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

// Hora de parede de um instante no fuso dado.
export function wallClockInZone(instant: Date, timeZone: string): WallClock {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(instant)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: parts.hour === "24" ? 0 : Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAY_INDEX[parts.weekday] ?? 0,
  };
}

// Offset do fuso em minutos (quanto somar ao UTC pra chegar na hora local) no
// instante dado. Ex: America/Sao_Paulo -> -180.
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const wc = wallClockInZone(instant, timeZone);
  const asUtc = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, 0);
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

// Converte uma hora de parede (no fuso da clinica) para o instante UTC.
export function zonedWallClockToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): Date {
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset1 = zoneOffsetMinutes(new Date(naiveUtc), timeZone);
  let instant = new Date(naiveUtc - offset1 * 60_000);
  // Uma unica correcao cobre a virada de horario de verao.
  const offset2 = zoneOffsetMinutes(instant, timeZone);
  if (offset2 !== offset1) instant = new Date(naiveUtc - offset2 * 60_000);
  return instant;
}

const DOW_LABEL = [
  "domingo",
  "segunda-feira",
  "terça-feira",
  "quarta-feira",
  "quinta-feira",
  "sexta-feira",
  "sábado",
];

// "quinta-feira, 12/09 às 10:00" - no fuso da clinica.
export function formatInZone(instant: Date, timeZone: string): string {
  const wc = wallClockInZone(instant, timeZone);
  const dd = String(wc.day).padStart(2, "0");
  const mm = String(wc.month).padStart(2, "0");
  const hh = String(wc.hour).padStart(2, "0");
  const mi = String(wc.minute).padStart(2, "0");
  return `${DOW_LABEL[wc.weekday]}, ${dd}/${mm} às ${hh}:${mi}`;
}

// "12/09/2026 10:00"
export function formatDateTimeInZone(instant: Date, timeZone: string): string {
  const wc = wallClockInZone(instant, timeZone);
  const dd = String(wc.day).padStart(2, "0");
  const mm = String(wc.month).padStart(2, "0");
  const hh = String(wc.hour).padStart(2, "0");
  const mi = String(wc.minute).padStart(2, "0");
  return `${dd}/${mm}/${wc.year} ${hh}:${mi}`;
}
