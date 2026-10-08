import { wallClockInZone } from "../scheduling/time.js";

// ---------------------------------------------------------------------------
// Correcao DETERMINISTICA de "hoje"/"amanha" na resposta da Alice.
// O modelo erra ("quinta-feira (amanha)" numa quinta) mesmo com a data no prompt.
// Aqui, depois que ele escreveu, conferimos cada par "dia da semana + rotulo
// relativo" contra o calendario real: se o dia da semana e hoje vira "hoje", se
// e amanha vira "amanha", se e outro dia o rotulo errado e removido.
// ---------------------------------------------------------------------------

const WD = "(domingo|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado)(?:-feira)?";
const DATE = "(?:,?\\s*\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?)?";

function weekdayIndex(word: string): number {
  const w = word.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"].findIndex((d) => w.startsWith(d));
}

export function fixRelativeDayLabels(text: string, now: Date, timeZone: string): string {
  const today = wallClockInZone(now, timeZone).weekday;
  const tomorrow = (today + 1) % 7;
  const labelFor = (idx: number): "hoje" | "amanhã" | null => (idx === today ? "hoje" : idx === tomorrow ? "amanhã" : null);

  // "quinta-feira (amanhã)", "quinta-feira, 08/10 (hoje)"
  const afterWeekday = new RegExp(`(${WD}${DATE})\\s*\\(\\s*(?:hoje|amanh[ãa])\\s*\\)`, "gi");
  let out = text.replace(afterWeekday, (_m, whole: string, weekday: string) => {
    const label = labelFor(weekdayIndex(weekday));
    return label ? `${whole} (${label})` : whole;
  });

  // "amanhã (quinta-feira)", "hoje, sexta-feira"
  const beforeWeekday = new RegExp(`\\b(?:hoje|amanh[ãa])(\\s*\\(\\s*|,\\s+)(${WD})(\\s*\\))?`, "gi");
  out = out.replace(beforeWeekday, (_m, sep: string, whole: string, weekday: string, close: string | undefined) => {
    const label = labelFor(weekdayIndex(weekday));
    return label ? `${label}${sep}${whole}${close ?? ""}` : whole;
  });
  return out;
}
