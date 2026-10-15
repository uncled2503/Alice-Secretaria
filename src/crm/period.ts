import { wallClockInZone, zonedWallClockToUtc } from "../scheduling/time.js";

// Janela do painel "Meu dia" no FUSO DA CLINICA (o navegador de quem olha pode estar em outro fuso):
//   0 = hoje (da meia-noite ate o fim do dia), 1 = ontem (o dia inteiro), N >= 2 = os ultimos N dias contando hoje.
// Antes "Hoje" (0) caia em `Number("0") || 30` e mostrava os mesmos numeros de 30 dias, e "Ontem" era "as ultimas 24 h".
export function periodWindow(days: number, timeZone: string, now: Date = new Date()): { start: Date; end: Date } {
  const wc = wallClockInZone(now, timeZone);
  const dayStart = (offset: number) => zonedWallClockToUtc(timeZone, wc.year, wc.month, wc.day + offset, 0, 0);
  const todayStart = dayStart(0);
  const tomorrowStart = dayStart(1);
  if (days <= 0) return { start: todayStart, end: new Date(tomorrowStart.getTime() - 1) };
  if (days === 1) return { start: dayStart(-1), end: new Date(todayStart.getTime() - 1) };
  const n = Math.min(Math.floor(days), 400);
  return { start: dayStart(-(n - 1)), end: new Date(tomorrowStart.getTime() - 1) };
}
