// Expediente da clinica pra AUTOMACOES (recontato etc.): nunca mandar mensagem
// automatica fora do horario em que a clinica atende. Usa os dias de
// atendimento (workDays), o horario geral e, se houver, o horario especifico
// de cada dia da semana (hoursByDay, ex.: sabado ate as 15h).

export interface OpenHoursClinic {
  timezone: string | null;
  workDays: string;
  workStartHour: number;
  workEndHour: number;
  hoursByDay: string | null;
}

function localParts(at: Date, timeZone: string): { weekday: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hourCycle: "h23", hour: "2-digit" }).formatToParts(at);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 12);
  return { weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd), hour };
}

export function isWithinClinicHours(clinic: OpenHoursClinic, at: Date = new Date()): boolean {
  const { weekday, hour } = localParts(at, clinic.timezone || "America/Sao_Paulo");
  const days = clinic.workDays.split(",").map((d) => Number(d.trim())).filter((n) => Number.isFinite(n));
  if (days.length && !days.includes(weekday)) return false;
  let start = clinic.workStartHour;
  let end = clinic.workEndHour;
  if (clinic.hoursByDay) {
    try {
      const o = (JSON.parse(clinic.hoursByDay) as Record<string, [number, number]>)[String(weekday)];
      if (Array.isArray(o) && o.length === 2) [start, end] = o;
    } catch {
      /* JSON invalido: usa o horario geral */
    }
  }
  return hour >= start && hour < end;
}
