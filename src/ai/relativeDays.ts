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

// Corrige "sexta-feira, 20/10" quando 20/10 cai numa terca. A DATA e a que as ferramentas de agenda
// usaram, entao o dia da semana e que se ajusta ao calendario real (nunca o contrario).
const WD_DATE = new RegExp(`\\b((?:domingo|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado)(?:-feira)?)(\\s*,?\\s*\\(?\\s*(?:dia\\s+)?)(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?`, "gi");
const WD_NAMES = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

export function fixWeekdayDatePairs(text: string, now: Date, timeZone: string): string {
  const today = wallClockInZone(now, timeZone);
  return text.replace(WD_DATE, (whole: string, weekday: string, sep: string, d: string, m: string, y?: string) => {
    const day = Number(d), month = Number(m);
    if (month < 1 || month > 12 || day < 1 || day > 31) return whole;
    let year = y ? (y.length === 2 ? 2000 + Number(y) : Number(y)) : today.year;
    // Sem ano e a data ja ficou ha muito tempo pra tras (ex: dezembro, falando de janeiro) = ano que vem.
    if (!y && Date.UTC(year, month - 1, day) < Date.UTC(today.year, today.month - 1, today.day) - 180 * 86_400_000) year += 1;
    const real = new Date(Date.UTC(year, month - 1, day));
    if (real.getUTCMonth() !== month - 1) return whole; // 31/02 etc: nao mexe
    const idx = real.getUTCDay();
    if (weekdayIndex(weekday) === idx) return whole;
    const hadFeira = /-feira/i.test(weekday);
    let name = WD_NAMES[idx];
    if (idx >= 1 && idx <= 5 && hadFeira) name += "-feira";
    if (weekday[0] === weekday[0].toUpperCase()) name = name[0].toUpperCase() + name.slice(1);
    console.warn(`[datas] dia da semana corrigido: "${weekday}" ${d}/${m} -> "${name}"`);
    return `${name}${sep}${d}/${m}${y ? `/${y}` : ""}`;
  });
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

// "Amanhã, dia 20/10" escrito numa quarta 14/10: o rotulo relativo tem que bater com a DATA. A data vem das ferramentas de agenda
// (e a que vale); o rotulo e ajustado ao calendario real: hoje/amanhã/depois de amanhã se for exatamente esse dia, senao vira o
// dia da semana ("Terça-feira, dia 20/10"). Cobre "Amanhã, dia 20/10", "hoje (14/10)" e "20/10 (amanhã)".
const REL = "(hoje|amanh[ãa]|depois de amanh[ãa])";
const DM = "(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?";
const REL_BEFORE_DATE = new RegExp(`\\b${REL}(\\s*,?\\s*\\(?\\s*(?:dia\\s+)?)${DM}`, "gi");
const REL_AFTER_DATE = new RegExp(`${DM}(\\s*\\(\\s*)${REL}(\\s*\\))`, "gi");

function relWord(delta: number): string | null {
  return delta === 0 ? "hoje" : delta === 1 ? "amanhã" : delta === 2 ? "depois de amanhã" : null;
}
const foldRel = (w: string) => w.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const cap = (w: string, like: string) => (like[0] === like[0].toUpperCase() ? w[0].toUpperCase() + w.slice(1) : w);

export function fixRelativeDateLabels(text: string, now: Date, timeZone: string): string {
  const t = wallClockInZone(now, timeZone);
  const todayMs = Date.UTC(t.year, t.month - 1, t.day);
  const resolve = (d: string, m: string, y?: string): { delta: number; idx: number } | null => {
    const day = Number(d), month = Number(m);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    let year = y ? (y.length === 2 ? 2000 + Number(y) : Number(y)) : t.year;
    if (!y && Date.UTC(year, month - 1, day) < todayMs - 180 * 86_400_000) year += 1;
    const real = new Date(Date.UTC(year, month - 1, day));
    if (real.getUTCMonth() !== month - 1) return null;
    return { delta: Math.round((real.getTime() - todayMs) / 86_400_000), idx: real.getUTCDay() };
  };
  const weekdayName = (idx: number) => WD_NAMES[idx] + (idx >= 1 && idx <= 5 ? "-feira" : "");

  let out = text.replace(REL_BEFORE_DATE, (whole: string, rel: string, sep: string, d: string, m: string, y?: string) => {
    const r = resolve(d, m, y);
    if (!r) return whole;
    const expected = relWord(r.delta);
    if (expected && foldRel(rel) === foldRel(expected)) return whole;
    const label = cap(expected ?? weekdayName(r.idx), rel);
    console.warn(`[datas] rotulo relativo corrigido: "${rel}" ${d}/${m} -> "${label}"`);
    return `${label}${sep}${d}/${m}${y ? `/${y}` : ""}`;
  });

  out = out.replace(REL_AFTER_DATE, (whole: string, d: string, m: string, y: string | undefined, open: string, rel: string, close: string) => {
    const r = resolve(d, m, y);
    if (!r) return whole;
    const expected = relWord(r.delta);
    if (expected && foldRel(rel) === foldRel(expected)) return whole;
    console.warn(`[datas] rotulo relativo corrigido: ${d}/${m} "${rel}" -> "${expected ?? "(removido)"}"`);
    return expected ? `${d}/${m}${y ? `/${y}` : ""}${open}${expected}${close}` : `${d}/${m}${y ? `/${y}` : ""}`;
  });
  return out;
}
