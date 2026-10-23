import type { ReminderRule } from "@prisma/client";
import { prisma } from "../db/client.js";
import { fixedReminderTime } from "../reminders/cron.js";
import { zonedWallClockToUtc, isoDateInZone } from "../scheduling/time.js";

// ---------------------------------------------------------------------------
// POLITICA DE JANELA E AMPLIACAO AUTOMATICA (autorizada pela clinica, 21/10/2026). Quando a janela NORMAL de um envio termina e ainda ha envios ELEGIVEIS pendentes por causa OPERACIONAL
// (job que nao rodou/reinicio, WhatsApp fora, CE indisponivel, falha recuperavel do provedor, fila maior que a capacidade), a janela se AMPLIA - nunca por padrao, nunca para
// quem nao e elegivel (cancelou, confirmou, remarcou, opt-out...), e sempre:
//   - no DIA LOCAL da clinica (nada atravessa a meia-noite; teto duro 21h: nada de madrugada);
//   - ate o LIMITE FINAL configurado (extendUntil) e a EXTENSAO MAXIMA (maxExtendMin) depois do fim da janela normal;
//   - com a ANTECEDENCIA MINIMA em relacao ao atendimento (minLeadMin): confirmacao de um atendimento daqui a 1h perdeu o sentido;
//   - com o mesmo ritmo de sempre (teto por rodada e pausa entre pessoas): ampliar a janela NAO acelera o envio;
//   - sem cascata: depois do limite final o envio EXPIRA (registrado) e a equipe e avisada.
// Distinguimos: horario planejado original (inicio da janela), proxima tentativa (nextAttemptAt), prazo final (deadlineAt) e o motivo da ampliacao (extendedReason).
// Sem linha em DispatchPolicy vale o padrao abaixo (coerente com os limites que o codigo ja tinha: reposicao entre 8h e 20h, aniversario ate 20h).
// ---------------------------------------------------------------------------

export type DispatchKind = "confirmacao" | "cobranca" | "lembrete" | "aniversario";
export const DISPATCH_KINDS: readonly DispatchKind[] = ["confirmacao", "cobranca", "lembrete", "aniversario"];
export const HARD_LAST_HOUR = 21; // nada e enviado depois das 21h locais, em nenhuma ampliacao

export interface PolicyValues {
  extendEnabled: boolean;
  extendUntil: string; // "HH:MM" local
  maxExtendMin: number;
  minLeadMin: number;
  maxAttempts: number;
  retryGapMin: number;
  maxPerRun: number;
  // Reposicao (agendado/remarcado depois que a janela fechou) so entre lateStartHour e lateEndHour locais (limite noturno) e com minLeadMin de antecedencia ("muito proximo" = nao repoe).
  lateStartHour: number;
  lateEndHour: number;
  // Intervalo minimo entre DUAS etapas para a mesma reserva (qualquer regra): evita reposicao as 16h59 e cobranca as 17h.
  stepMinGapMin: number;
}

export const POLICY_DEFAULTS: Record<DispatchKind, PolicyValues> = {
  confirmacao: { extendEnabled: true, extendUntil: "18:00", maxExtendMin: 360, minLeadMin: 120, maxAttempts: 3, retryGapMin: 10, maxPerRun: 12, lateStartHour: 8, lateEndHour: 20, stepMinGapMin: 180 },
  cobranca: { extendEnabled: true, extendUntil: "19:00", maxExtendMin: 120, minLeadMin: 120, maxAttempts: 3, retryGapMin: 10, maxPerRun: 12, lateStartHour: 8, lateEndHour: 20, stepMinGapMin: 180 },
  lembrete: { extendEnabled: true, extendUntil: "20:00", maxExtendMin: 240, minLeadMin: 60, maxAttempts: 3, retryGapMin: 10, maxPerRun: 12, lateStartHour: 8, lateEndHour: 20, stepMinGapMin: 180 },
  aniversario: { extendEnabled: true, extendUntil: "21:00", maxExtendMin: 60, minLeadMin: 0, maxAttempts: 3, retryGapMin: 15, maxPerRun: 20, lateStartHour: 8, lateEndHour: 20, stepMinGapMin: 0 },
};

export function validHHMM(v: unknown): v is string {
  return typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}

// PURO: valores efetivos = padrao do tipo + o que a clinica editou, sempre dentro dos limites seguros.
export function effectivePolicy(kind: DispatchKind, row?: Partial<{ extendEnabled: boolean; extendUntil: string | null; maxExtendMin: number | null; minLeadMin: number | null; maxAttempts: number | null; retryGapMin: number | null; maxPerRun: number | null; lateStartHour: number | null; lateEndHour: number | null; stepMinGapMin: number | null }> | null): PolicyValues {
  const d = POLICY_DEFAULTS[kind];
  const until = row?.extendUntil && validHHMM(row.extendUntil) ? row.extendUntil : d.extendUntil;
  const clamp = (v: number | null | undefined, def: number, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : def);
  return {
    extendEnabled: row?.extendEnabled ?? d.extendEnabled,
    extendUntil: until,
    maxExtendMin: clamp(row?.maxExtendMin, d.maxExtendMin, 0, 720),
    minLeadMin: clamp(row?.minLeadMin, d.minLeadMin, 0, 1440),
    maxAttempts: clamp(row?.maxAttempts, d.maxAttempts, 1, 10),
    retryGapMin: clamp(row?.retryGapMin, d.retryGapMin, 5, 120),
    maxPerRun: clamp(row?.maxPerRun, d.maxPerRun, 1, 30),
    ...(() => {
      // limite noturno nunca passa do teto duro; inicio sempre antes do fim (senao vale o padrao)
      const ls = clamp(row?.lateStartHour, d.lateStartHour, 7, HARD_LAST_HOUR - 1), le = clamp(row?.lateEndHour, d.lateEndHour, 8, HARD_LAST_HOUR);
      return ls < le ? { lateStartHour: ls, lateEndHour: le } : { lateStartHour: d.lateStartHour, lateEndHour: d.lateEndHour };
    })(),
    stepMinGapMin: clamp(row?.stepMinGapMin, d.stepMinGapMin, 0, 720),
  };
}

export async function loadPolicy(clinicId: string, kind: DispatchKind): Promise<PolicyValues> {
  const row = await prisma.dispatchPolicy.findUnique({ where: { clinicId_kind: { clinicId, kind } } }).catch(() => null);
  return effectivePolicy(kind, row);
}

export async function loadAllPolicies(clinicId: string): Promise<Record<DispatchKind, PolicyValues & { custom: boolean }>> {
  const rows = await prisma.dispatchPolicy.findMany({ where: { clinicId } });
  const out = {} as Record<DispatchKind, PolicyValues & { custom: boolean }>;
  for (const k of DISPATCH_KINDS) { const r = rows.find((x) => x.kind === k); out[k] = { ...effectivePolicy(k, r), custom: !!r }; }
  return out;
}

// PURO: limite final da ampliacao de UMA janela. null = nao ha ampliacao (desligada, sem espaco ou sem antecedencia).
export function extendedDeadline(p: PolicyValues, a: { windowEnd: Date; appointmentStart?: Date | null; timeZone: string }): Date | null {
  if (!p.extendEnabled || p.maxExtendMin <= 0) return null;
  const [y, m, d] = isoDateInZone(a.windowEnd, a.timeZone).split("-").map(Number);
  const [hh, mm] = p.extendUntil.split(":").map(Number);
  const untilToday = zonedWallClockToUtc(a.timeZone, y, m, d, hh, mm);
  const hardEnd = zonedWallClockToUtc(a.timeZone, y, m, d, HARD_LAST_HOUR, 0);
  const candidates = [a.windowEnd.getTime() + p.maxExtendMin * 60_000, untilToday.getTime(), hardEnd.getTime()];
  if (a.appointmentStart) candidates.push(a.appointmentStart.getTime() - p.minLeadMin * 60_000);
  const end = Math.min(...candidates);
  return end > a.windowEnd.getTime() ? new Date(end) : null;
}

// Fim da janela NORMAL de uma regra de calendario para um atendimento (dayOffset + sendEndHour); null para regra "N horas antes".
export function normalWindowEnd(rule: Pick<ReminderRule, "dayOffset" | "sendHour" | "sendEndHour">, scheduledAt: Date, tz: string): Date | null {
  if (rule.dayOffset == null || rule.sendHour == null || rule.sendEndHour == null) return null;
  return fixedReminderTime(scheduledAt, rule.dayOffset, rule.sendEndHour, 0, tz);
}

export interface ExtensionCtx {
  allowed: boolean; // existe causa OPERACIONAL comprovada na janela (ou a politica esta ligada e o item tem falha recuperavel)
  cause: string | null; // codigo curto: job_nao_rodou_na_janela | falhas_ou_capacidade | whatsapp_fora | item_com_falha_recuperavel
  policy: PolicyValues;
  kind: DispatchKind;
}

// Saude operacional da janela de UMA regra: houve causa para uma ampliacao? Sem causa (a janela rodou normalmente e tudo o que era elegivel saiu ou foi retido por motivo legitimo),
// NAO se amplia: ampliar sem motivo seria "lote atrasado" para quem a clinica nunca quis atingir fora da janela.
export async function windowOperationalCause(clinicId: string, windowStart: Date, windowEnd: Date, now: Date): Promise<string | null> {
  if (now.getTime() < windowEnd.getTime()) return null;
  const expected = Math.max(1, Math.floor((windowEnd.getTime() - windowStart.getTime()) / (15 * 60_000)));
  const runs = await prisma.automationRun.findMany({ where: { job: "lembretes", clinicId, startedAt: { gte: windowStart, lt: windowEnd } }, select: { reasons: true, outcome: true } });
  if (runs.length < Math.ceil(expected / 2)) return "job_nao_rodou_na_janela";
  const trouble = runs.some((r) => r.outcome === "erro" || /adiado|falha|limite_de_envios|whatsapp_desconectado/.test(r.reasons ?? ""));
  if (trouble) return "falhas_ou_capacidade";
  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { uazapiDownSince: true } });
  if (clinic?.uazapiDownSince && clinic.uazapiDownSince.getTime() <= windowEnd.getTime()) return "whatsapp_fora";
  return null;
}

export async function resolveExtension(rule: Pick<ReminderRule, "clinicId" | "dayOffset" | "sendHour" | "sendMinute" | "sendEndHour" | "parentRuleId" | "purpose" | "message" | "id">, kind: DispatchKind, tz: string, sampleAppointmentStart: Date, now: Date): Promise<ExtensionCtx> {
  const policy = await loadPolicy(rule.clinicId, kind);
  const end = normalWindowEnd(rule, sampleAppointmentStart, tz);
  if (!policy.extendEnabled || !end || now.getTime() < end.getTime()) return { allowed: false, cause: null, policy, kind };
  const start = fixedReminderTime(sampleAppointmentStart, rule.dayOffset!, rule.sendHour!, rule.sendMinute, tz);
  const cause = await windowOperationalCause(rule.clinicId, start, end, now);
  return { allowed: !!cause, cause, policy, kind };
}
