import type { ReminderRule } from "@prisma/client";
import { wallClockInZone } from "../scheduling/time.js";
import { classifyReminder } from "../maintenance/restoreReminders.js";

// ---------------------------------------------------------------------------
// POLITICA DAS CONFIRMACOES E LEMBRETES (tudo PURO, no fuso da CLINICA - nunca o do servidor).
//
// Tres perguntas que antes se misturavam:
//   1. O QUE a mensagem e?   confirmacao (pede a presenca) | cobranca (nova solicitacao a quem nao confirmou) | lembrete (so informa).
//   2. PARA QUAIS dias ela vale?  `weekdays` = dia da semana do ATENDIMENTO (data local), ex.: sabado. Vazio = todos.
//   3. QUAL regra manda quando duas valem?  A regra COM dia da semana SUBSTITUI a generica do mesmo proposito naquele dia: nunca as duas.
//
// "24 horas antes" NAO e "o dia anterior ate as 9h": uma confirmacao de calendario tem dia (dayOffset) e janela (sendHour..sendEndHour). Regra que pede confirmacao e
// nao tem janela de calendario e uma regra INVALIDA (`ruleProblems`): sai "N horas antes", em qualquer hora, e e exatamente o que a clinica nao quer.
// ---------------------------------------------------------------------------

export type ReminderPurpose = "confirmacao" | "cobranca" | "lembrete";
export const PURPOSES: readonly ReminderPurpose[] = ["confirmacao", "cobranca", "lembrete"];
export const WEEKDAY_NAMES = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"] as const;

type RuleLike = Pick<ReminderRule, "id" | "parentRuleId" | "message"> & Partial<Pick<ReminderRule, "weekdays" | "purpose" | "resendIfConfirmed" | "dayOffset" | "sendHour" | "sendMinute" | "sendEndHour" | "active">>;

// "6" / "3,5" -> {6} / {3,5}. null = todos os dias. Valor invalido (fora de 0-6, texto) => `valid:false` e a regra NAO vale em nenhum dia (falha para o lado seguro).
export function parseWeekdays(csv: string | null | undefined): { days: Set<number> | null; valid: boolean } {
  if (csv == null || csv.trim() === "") return { days: null, valid: true };
  const parts = csv.split(",").map((p) => p.trim()).filter(Boolean);
  const days = new Set<number>();
  for (const p of parts) {
    if (!/^[0-6]$/.test(p)) return { days: new Set(), valid: false };
    days.add(Number(p));
  }
  return { days, valid: days.size > 0 };
}

export function formatWeekdays(csv: string | null | undefined): string {
  const { days, valid } = parseWeekdays(csv);
  if (!valid) return "dias inválidos";
  if (!days) return "todos os dias";
  return [...days].sort((a, b) => a - b).map((d) => WEEKDAY_NAMES[d]).join(", ");
}

// Dia da semana (0 = domingo) da DATA LOCAL do instante no fuso da clinica. 23h30 de sexta em Sao Paulo ainda e sexta, mesmo sendo sabado em UTC.
export function weekdayInZone(instant: Date, timeZone: string): number {
  const w = wallClockInZone(instant, timeZone);
  return new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
}

export function ruleAppliesOnWeekday(rule: Pick<ReminderRule, "weekdays">, weekday: number): boolean {
  const { days, valid } = parseWeekdays(rule.weekdays);
  if (!valid) return false;
  return days === null || days.has(weekday);
}

// O proposito EXPLICITO da regra (null = regra legada, sem decisao registrada).
export function explicitPurpose(rule: Pick<ReminderRule, "purpose">): ReminderPurpose | null {
  return (PURPOSES as readonly string[]).includes(rule.purpose ?? "") ? (rule.purpose as ReminderPurpose) : null;
}

// O proposito efetivo: o explicito; senao deduz (regra-filha = cobranca; texto "amanha" = confirmacao; o resto = lembrete). A deducao so serve para AGRUPAR regras que se sobrepoem;
// ela NUNCA liga o "nao enviar a quem ja confirmou" (isso exige o proposito explicito).
export function effectivePurpose(rule: Pick<ReminderRule, "purpose" | "parentRuleId" | "message">): ReminderPurpose {
  const e = explicitPurpose(rule);
  if (e) return e;
  if (rule.parentRuleId) return "cobranca";
  return classifyReminder(rule.message) === "dia_seguinte" ? "confirmacao" : "lembrete";
}

// A regra e uma SOLICITACAO de confirmacao que nao deve ir a quem ja confirmou? (so com proposito explicito; a cobranca ja tinha essa regra desde sempre)
export function skipsConfirmedPatient(rule: Pick<ReminderRule, "purpose" | "parentRuleId" | "resendIfConfirmed">): boolean {
  if (rule.parentRuleId) return true;
  return explicitPurpose(rule) === "confirmacao" && !rule.resendIfConfirmed;
}

// Tipo (chave de duplicidade por dia no controle persistente). Regras legadas mantem o tipo de sempre (classificado pelo texto).
export function reminderKindOf(rule: Pick<ReminderRule, "id" | "parentRuleId" | "message"> & Partial<Pick<ReminderRule, "purpose" | "dayOffset">>): string {
  if (rule.parentRuleId) return "cobranca";
  const p = explicitPurpose({ purpose: rule.purpose ?? null });
  if (p === "confirmacao") return rule.dayOffset === 1 ? "dia_seguinte" : `confirmacao_d${rule.dayOffset ?? "h"}`;
  if (p === "lembrete" && rule.dayOffset === 0) return "do_dia";
  if (p === "lembrete") return `lembrete_d${rule.dayOffset ?? "h"}:${rule.id}`;
  return classifyReminder(rule.message) ?? `outro:${rule.id}`;
}

// Se a regra e GENERICA (sem dia da semana) e existe outra regra ATIVA com dia da semana que cobre `weekday` e tem o mesmo proposito (e o mesmo papel mae/filha), a generica
// NAO vale neste dia: devolve a regra especifica. Duas especificas para o mesmo dia e proposito nao se substituem (e um cadastro conflitante: ver `findPolicyConflicts`).
export function overridingRule(rule: RuleLike, weekday: number, allRules: RuleLike[]): RuleLike | null {
  if (parseWeekdays(rule.weekdays).days !== null || !parseWeekdays(rule.weekdays).valid) return null; // so a generica e substituida
  const purpose = effectivePurpose(rule as ReminderRule);
  const child = !!rule.parentRuleId;
  // "mesmo lugar": dispara no mesmo dia-offset (a sexta de sabado como lembrete substitui a confirmacao generica de sexta), ou e do mesmo proposito de PEDIDO (a confirmacao de quarta
  // substitui a confirmacao generica do dia anterior). Lembrete so e substituido por outro lembrete do MESMO dia-offset (o lembrete de sabado nao some porque ha um de sexta).
  const sameSlot = (o: RuleLike) => (rule.dayOffset != null && o.dayOffset != null && rule.dayOffset === o.dayOffset) || (purpose !== "lembrete" && effectivePurpose(o as ReminderRule) === purpose);
  return (
    allRules.find(
      (o) => o.id !== rule.id && o.active !== false && parseWeekdays(o.weekdays).days !== null && ruleAppliesOnWeekday(o as ReminderRule, weekday) && !!o.parentRuleId === child && sameSlot(o),
    ) ?? null
  );
}

export interface RuleProblem { code: string; detail: string }

// Cadastro que nao produz o que a clinica pediu. Nunca corrige sozinho: expoe.
export function ruleProblems(rule: RuleLike, deadlineHour?: number | null): RuleProblem[] {
  const out: RuleProblem[] = [];
  const parsed = parseWeekdays(rule.weekdays);
  if (!parsed.valid) out.push({ code: "dias_invalidos", detail: `dias da semana inválidos (${rule.weekdays}): a regra não vale em nenhum dia` });
  const purpose = effectivePurpose(rule as ReminderRule);
  const fixed = rule.dayOffset != null && rule.sendHour != null;
  const windowed = fixed && rule.sendEndHour != null;
  if (purpose !== "lembrete" && !windowed) out.push({ code: "sem_janela_de_calendario", detail: "pede confirmação mas não tem dia e janela de calendário: sairia 'N horas antes', não 'no dia anterior até uma hora'" });
  if (windowed && rule.sendEndHour! * 60 <= rule.sendHour! * 60 + (rule.sendMinute ?? 0)) out.push({ code: "janela_invertida", detail: `a janela ${rule.sendHour}:${String(rule.sendMinute ?? 0).padStart(2, "0")}–${rule.sendEndHour}:00 termina antes de começar` });
  if (windowed && deadlineHour != null && purpose === "confirmacao" && rule.sendEndHour! > deadlineHour) out.push({ code: "passa_do_prazo", detail: `a janela termina às ${rule.sendEndHour}h, depois do prazo de ${deadlineHour}h` });
  return out;
}

// Regras ATIVAS que se pisam: duas especificas para o mesmo dia e proposito, ou duas genericas do mesmo proposito e papel com a mesma janela (envio em dobro).
export function findPolicyConflicts(rules: RuleLike[]): { a: string; b: string; detail: string }[] {
  const active = rules.filter((r) => r.active !== false);
  const out: { a: string; b: string; detail: string }[] = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const x = active[i], y = active[j];
      if (effectivePurpose(x as ReminderRule) !== effectivePurpose(y as ReminderRule) || !!x.parentRuleId !== !!y.parentRuleId) continue;
      if ((x.dayOffset ?? null) !== (y.dayOffset ?? null)) continue;
      const dx = parseWeekdays(x.weekdays), dy = parseWeekdays(y.weekdays);
      if (!dx.valid || !dy.valid) continue;
      const shared = dx.days === null || dy.days === null ? dx.days === dy.days : [...dx.days].some((d) => dy.days!.has(d));
      if (!shared) continue;
      out.push({ a: x.id, b: y.id, detail: `duas regras ativas do mesmo propósito (${effectivePurpose(x as ReminderRule)}) valem nos mesmos dias (${formatWeekdays(x.weekdays)} / ${formatWeekdays(y.weekdays)}): uma delas seria bloqueada pelo controle de duplicidade` });
    }
  }
  return out;
}

// PURO: quantos envios uma rodada pode fazer. Padrao 12 (protege o numero de bloqueio por rajada). Janela CURTA com muita gente: sobe o teto so o necessario para a fila caber nas
// rodadas que ainda restam (cron de 15 em 15 min), com limite de 30 por rodada. Nunca para rodar mais de uma janela por vez nem fora da janela.
export const BASE_SENDS_PER_RUN = 12;
export const MAX_SENDS_PER_RUN_CEILING = 30;
export function perRunCap(pending: number, windowEnd: Date | null, now: Date): number {
  if (!windowEnd || pending <= BASE_SENDS_PER_RUN) return BASE_SENDS_PER_RUN;
  const runsLeft = Math.max(1, Math.ceil((windowEnd.getTime() - now.getTime()) / (15 * 60_000)));
  return Math.min(MAX_SENDS_PER_RUN_CEILING, Math.max(BASE_SENDS_PER_RUN, Math.ceil(pending / runsLeft)));
}
