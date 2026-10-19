import { isWithinClinicHours, type OpenHoursClinic } from "./openHours.js";
import { nationalHolidayOn, parseHolidayOpen } from "../scheduling/holidays.js";
import { wallClockInZone, zonedWallClockToUtc } from "../scheduling/time.js";

// ---------------------------------------------------------------------------
// QUANDO UM RECONTATO VENCE, QUANDO ELE PODE SAIR E ATE QUANDO AINDA VALE (tudo PURO, no fuso da CLINICA - nunca o do servidor).
//
// Tres conceitos que antes se misturavam e tornavam o "dia seguinte as 8h" e o "a partir das 12h" impossiveis de explicar:
//   VENCIMENTO (dueAt)   - quando a regra "pede" o envio: N minutos de silencio, ou o dia civil seguinte as N horas (nextDayHour).
//   ABERTURA (opensAt)   - o primeiro instante >= vencimento em que a clinica pode mandar: dentro do expediente (dias/horarios, feriado) E dentro
//                          da janela de envio da regra (sendWindowStart/End). A jornada das profissionais NAO entra: e agenda, nao horario comercial.
//   PRAZO (deadline)     - ate quando ainda faz sentido enviar depois de aberto (politica de recuperacao). Passou do prazo = o recontato EXPIRA
//                          (nao sai atrasado nem acumulado depois de uma queda do servidor): a cascata segue para a proxima etapa.
// ---------------------------------------------------------------------------

export interface RuleTiming {
  afterMinutes: number;
  afterDays: number;
  nextDayHour: number | null;
  sendWindowStart: number | null;
  sendWindowEnd: number | null;
}

export interface SendCalendar extends OpenHoursClinic {
  closedOnHolidays?: boolean;
  holidayOpen?: string | null;
}

// PADRAO ANTIGO DO CODIGO (commit d52e649, 07/10/2026, trava contra disparo em massa depois que reconectar o WhatsApp mandou recontato para todo mundo): nunca recontata
// atrasado alem de 3 dias. Vale para TODAS as clinicas e NAO e uma autorizacao comercial: e so a rede de seguranca.
export const MAX_OVERDUE_MS = 3 * 24 * 3_600_000; // teto absoluto desde o vencimento (conversa fria deixa de ser recontato)
// Politica de recuperacao POR CLINICA (Clinic.followupRecoveryHours): null = padrao antigo (so a trava de 3 dias); 0 = nao recupera; 1-72 = ate N horas depois que a janela abriu.
export interface RecoveryPolicy {
  recoveryHours: number | null;
}
export const LEGACY_RECOVERY: RecoveryPolicy = { recoveryHours: null };
export const MAX_RECOVERY_HOURS = 72;
export const NO_RECOVERY_GRACE_MS = 20 * 60_000; // "nao recupera": tolerancia TECNICA de uma rodada (o job roda a cada 15 min) - nao e prazo comercial
export function validRecoveryHours(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_RECOVERY_HOURS;
}
export const MIN_GAP_BETWEEN_AUTOMATED_MS = 6 * 3_600_000; // duas mensagens automaticas para a mesma pessoa nunca saem coladas
const HORIZON_HOURS = 24 * 10;

export function ruleThresholdMin(rule: Pick<RuleTiming, "afterMinutes" | "afterDays">): number {
  return rule.afterMinutes > 0 ? rule.afterMinutes : rule.afterDays * 1440;
}

// Janela [start, end): aceita janela que vira a meia-noite (ex: 20 -> 6). null = qualquer horario.
export function withinWindow(hour: number, start: number | null, end: number | null): boolean {
  if (start == null || end == null) return true;
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

// O instante em que vence um recontato "no dia seguinte as N horas" (fuso da clinica), contado do dia civil da ultima mensagem.
export function nextDayAt(lastMessageAt: Date, timeZone: string, hour: number): Date {
  const wc = wallClockInZone(lastMessageAt, timeZone);
  const next = new Date(Date.UTC(wc.year, wc.month - 1, wc.day + 1, 12, 0, 0)); // so pra normalizar fim de mes/ano
  return zonedWallClockToUtc(timeZone, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), hour, 0);
}

export function ruleDueAt(rule: RuleTiming, lastPatientAt: Date, timeZone: string): Date {
  if (rule.nextDayHour != null) return nextDayAt(lastPatientAt, timeZone, rule.nextDayHour);
  return new Date(lastPatientAt.getTime() + ruleThresholdMin(rule) * 60_000);
}

export type ClosedReason = "fora_do_expediente" | "feriado" | "fora_da_janela";

// A clinica pode mandar esta regra neste instante? (expediente + feriado + janela da regra)
export function openAt(rule: Pick<RuleTiming, "sendWindowStart" | "sendWindowEnd">, cal: SendCalendar, at: Date): { open: true } | { open: false; reason: ClosedReason } {
  const tz = cal.timezone || "America/Sao_Paulo";
  if (!isWithinClinicHours(cal, at)) return { open: false, reason: "fora_do_expediente" };
  if (cal.closedOnHolidays) {
    const wc = wallClockInZone(at, tz);
    const holiday = nationalHolidayOn(wc.year, wc.month, wc.day);
    if (holiday && !parseHolidayOpen(cal.holidayOpen).has(holiday)) return { open: false, reason: "feriado" };
  }
  if (!withinWindow(wallClockInZone(at, tz).hour, rule.sendWindowStart, rule.sendWindowEnd)) return { open: false, reason: "fora_da_janela" };
  return { open: true };
}

// O primeiro instante >= `from` em que a regra pode sair (o expediente e a janela mudam sempre na virada da hora local). null = nada nos proximos 10 dias.
export function firstOpenAtOrAfter(rule: Pick<RuleTiming, "sendWindowStart" | "sendWindowEnd">, cal: SendCalendar, from: Date): Date | null {
  if (openAt(rule, cal, from).open) return from;
  const tz = cal.timezone || "America/Sao_Paulo";
  const wc = wallClockInZone(from, tz);
  let probe = zonedWallClockToUtc(tz, wc.year, wc.month, wc.day, wc.hour, 0);
  for (let i = 0; i < HORIZON_HOURS; i++) {
    probe = new Date(probe.getTime() + 3_600_000);
    if (probe.getTime() > from.getTime() && openAt(rule, cal, probe).open) return probe;
  }
  return null;
}

export type Timing =
  | { action: "wait"; code: "nao_venceu" | ClosedReason; dueAt: Date; opensAt: Date | null }
  | { action: "send"; dueAt: Date; openedAt: Date; lateMs: number }
  | { action: "expire"; code: "janela_perdida" | "conversa_fria" | "sem_janela"; dueAt: Date; deadline: Date | null };

// PURO: o que fazer com esta regra AGORA. Politica de recuperacao (documentada em docs/recontatos-e-retomadas.md):
//  - ainda nao venceu -> espera;
//  - venceu: acha a primeira abertura (expediente + janela). Regra "dia seguinte as N h": o prazo e o fim do dia civil em que a janela abriu (depois
//    disso "o dia seguinte" ja nao existe); regra por silencio: 24h depois da abertura. Teto absoluto de 3 dias desde o vencimento.
//  - passou do prazo -> EXPIRA (a etapa e descartada e a cascata segue; nunca sai atrasada nem junto da proxima);
//  - dentro do prazo e aberto -> envia; dentro do prazo e fechado -> espera a proxima abertura (se ela ainda cabe no prazo).
export function decideTiming(rule: RuleTiming, lastPatientAt: Date, now: Date, cal: SendCalendar, policy: RecoveryPolicy = LEGACY_RECOVERY): Timing {
  const tz = cal.timezone || "America/Sao_Paulo";
  const dueAt = ruleDueAt(rule, lastPatientAt, tz);
  if (now.getTime() < dueAt.getTime()) return { action: "wait", code: "nao_venceu", dueAt, opensAt: null }; // (a abertura so e calculada quando vence: evita varrer 10 dias por conversa)
  if (now.getTime() - dueAt.getTime() > MAX_OVERDUE_MS) return { action: "expire", code: "conversa_fria", dueAt, deadline: new Date(dueAt.getTime() + MAX_OVERDUE_MS) };

  const firstOpen = firstOpenAtOrAfter(rule, cal, dueAt);
  if (!firstOpen) return { action: "expire", code: "sem_janela", dueAt, deadline: null };
  // prazo: sem politica da clinica vale o padrao antigo (3 dias desde o vencimento, ja conferido acima); com politica, N horas depois que a janela abriu (0 = so a rodada em que abriu)
  const policyHours = validRecoveryHours(policy.recoveryHours) ? policy.recoveryHours : null;
  const deadline = policyHours == null ? new Date(dueAt.getTime() + MAX_OVERDUE_MS) : new Date(firstOpen.getTime() + (policyHours === 0 ? NO_RECOVERY_GRACE_MS : policyHours * 3_600_000));
  if (now.getTime() >= deadline.getTime()) return { action: "expire", code: policyHours == null ? "conversa_fria" : "janela_perdida", dueAt, deadline };

  const state = openAt(rule, cal, now);
  if (state.open) return { action: "send", dueAt, openedAt: firstOpen, lateMs: Math.max(0, now.getTime() - firstOpen.getTime()) };
  const next = firstOpenAtOrAfter(rule, cal, now);
  if (!next || next.getTime() >= deadline.getTime()) return { action: "expire", code: policyHours == null ? "conversa_fria" : "janela_perdida", dueAt, deadline };
  return { action: "wait", code: state.reason, dueAt, opensAt: next };
}

// Texto curto para o diario/relatorio: "dia seguinte as 8h, janela 8h-12h" / "4h de silencio".
export function describeRule(rule: RuleTiming): string {
  const when = rule.nextDayHour != null
    ? `dia seguinte às ${rule.nextDayHour}h`
    : (() => {
        const m = ruleThresholdMin(rule);
        return `${m % 1440 === 0 ? `${m / 1440} dia(s)` : m % 60 === 0 ? `${m / 60}h` : `${m} min`} de silêncio`;
      })();
  const win = rule.sendWindowStart != null && rule.sendWindowEnd != null ? `, só entre ${rule.sendWindowStart}h e ${rule.sendWindowEnd}h` : "";
  return `${when}${win}`;
}
