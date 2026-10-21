import { scheduleLocked } from "../jobs/lock.js";
import { prisma } from "../db/client.js";
import { sendText, isPermanentSendError, isAmbiguousSendError, isSendDeferred, connectionUsable, type SendOutcome } from "../uazapi/client.js";
import { renderMessageTemplate, getClinicTemplateInfo } from "../crm/template.js";
import { PAID_CLINIC_WHERE } from "../crm/plan.js";
import type { ReminderRule } from "@prisma/client";
import { recordAutomatedMessage } from "../crm/conversationLog.js";
import { isoDateInZone, zonedWallClockToUtc } from "../scheduling/time.js";
import { localDayBounds } from "./firstOfDay.js";
import { classifyReminder } from "../maintenance/restoreReminders.js";
import { verifyBookingLive, applyLiveVerdict, type LiveAction } from "../clinicaexperts/liveCheck.js";
import { acquireDispatch, finishDispatch, recordDeferral, precheckDispatch, bookingKeyOf, dispatchKind, sendDayOf, type DispatchKey } from "./ledger.js";
import { notifyStaff } from "../crm/notify.js";
import { RunRecorder } from "../crm/automationRuns.js";
import { logActivity } from "../crm/activity.js";
import { REVISION } from "../version.js";
import { stripProcedureLines, isPlaceholderProcedure } from "../clinicaexperts/placeholderProcedure.js";
import { effectivePurpose, explicitPurpose, overridingRule, parseWeekdays, perRunCap, ruleAppliesOnWeekday, skipsConfirmedPatient, weekdayInZone, BASE_SENDS_PER_RUN } from "./policy.js";
import { notYetEffectuated } from "./effectuation.js";
import { reportConfirmationGaps } from "./coverage.js";

// PURO: dois textos de confirmacao sao "o mesmo lembrete"? Igual sem negrito (*) nem espacos, ou do mesmo tipo (os dois "amanha" ou os dois "hoje").
// Uma regra copiada com o nome em negrito mandava a confirmacao do dia 2x (15/10, Renata): o texto nao era identico, so o negrito.
export function isSameReminderText(a: string, b: string): boolean {
  const norm = (t: string) => t.replace(/[*_~]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  if (norm(a) === norm(b)) return true;
  const ka = classifyReminder(a);
  return ka !== null && ka === classifyReminder(b);
}
export const DUPLICATE_REMINDER_WINDOW_MS = 20 * 3_600_000;

const EARLIEST_SEND_HOUR = 7; // nunca manda lembrete antes das 7h (hora local da clinica)
const SEND_TOLERANCE_MS = 40 * 60_000; // janela de disparo apos o horario previsto (cron roda a cada 15min)

// PURO: quando o lembrete deve sair. Normalmente "hoursBefore" antes da
// consulta; se isso cair antes das 7h locais (ex.: consulta as 8h com regra de
// 3h), sai as 7h em ponto em vez de acordar o paciente de madrugada.
export function reminderSendTime(scheduledAt: Date, hoursBefore: number, timeZone: string): Date {
  const ideal = new Date(scheduledAt.getTime() - hoursBefore * 3_600_000);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(ideal);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 12);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  if (h >= EARLIEST_SEND_HOUR) return ideal;
  return new Date(ideal.getTime() + ((EARLIEST_SEND_HOUR - h) * 60 - m) * 60_000);
}

// PURO: instante do lembrete de horario FIXO (ex.: 7h30 do dia anterior, 7h do
// proprio dia), no fuso da clinica. dayOffset: 1 = dia anterior, 0 = no dia.
export function fixedReminderTime(scheduledAt: Date, dayOffset: number, hour: number, minute: number, timeZone: string): Date {
  const key = isoDateInZone(scheduledAt, timeZone);
  const [y, m, d] = key.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d - dayOffset));
  return zonedWallClockToUtc(timeZone, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, minute);
}

// PURO: "agora" esta dentro da janela de envio da regra pra essa consulta?
// Vale a janela inteira (ex.: 12h-18h do dia anterior), nao so o comeco.
export function inReminderWindow(
  scheduledAt: Date,
  now: Date,
  w: { dayOffset: number; sendHour: number; sendMinute: number; sendEndHour: number },
  timeZone: string,
): boolean {
  const from = fixedReminderTime(scheduledAt, w.dayOffset, w.sendHour, w.sendMinute, timeZone).getTime();
  const to = fixedReminderTime(scheduledAt, w.dayOffset, w.sendEndHour, 0, timeZone).getTime();
  return now.getTime() >= from && now.getTime() < to;
}

// PURO: agendamento criado DEPOIS que a janela de confirmacao do dia dele ja tinha fechado (ex.: marcado as 15h pra
// amanha, e a confirmacao do dia seguinte sai das 8h as 11h de hoje). Sem isto ele nunca recebia confirmacao nenhuma. Sai
// assim que possivel, dentro de 8h-20h e com pelo menos 2h de folga antes do atendimento. So vale pra regras de "dia
// anterior" (dayOffset >= 1): a confirmacao do proprio dia nao precisa de reposicao.
export const LATE_CATCHUP_MIN_LEAD_MS = 2 * 3_600_000;
export function isLateCatchUp(
  appt: { scheduledAt: Date; createdAt: Date; scheduleChangedAt?: Date | null },
  w: { dayOffset: number; sendEndHour: number },
  now: Date,
  timeZone: string,
): boolean {
  if (w.dayOffset < 1) return false;
  const windowEnd = fixedReminderTime(appt.scheduledAt, w.dayOffset, w.sendEndHour, 0, timeZone).getTime();
  // O marco e o instante em que ESTE horario passou a existir: a criacao ou a ultima remarcacao (o que for mais recente). Remarcado depois da janela = reposicao, como um agendamento novo.
  const since = Math.max(appt.createdAt.getTime(), appt.scheduleChangedAt?.getTime() ?? 0);
  if (since < windowEnd) return false; // criado/remarcado a tempo: vale so a janela normal
  if (now.getTime() < windowEnd) return false;
  if (appt.scheduledAt.getTime() - now.getTime() < LATE_CATCHUP_MIN_LEAD_MS) return false;
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit" }).format(now));
  return hour >= 8 && hour < 20;
}

// Cobranca ("nao confirmou") so depois de um intervalo minimo desde a mensagem-mae: sem isto quem recebeu a confirmacao
// de reposicao as 15h30 ja recebia a cobranca das 17h, 1h30 depois.
export const CHILD_MIN_GAP_MS = 3 * 3_600_000;

// Mudanca de janela/pausa AGENDADA numa regra (ex.: "a partir de amanha"):
// guardada em ReminderRule.scheduledChange e aplicada sozinha quando a data chega.
export interface ScheduledChange {
  from: string; // ISO
  sendHour?: number;
  sendMinute?: number;
  sendEndHour?: number;
  pauseMinSec?: number;
  pauseMaxSec?: number;
}

// PURO: devolve a mudanca se ja esta na hora de aplicar; null se nao (ou JSON invalido).
export function dueScheduledChange(raw: string | null | undefined, now: Date): ScheduledChange | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as ScheduledChange;
    const from = new Date(c.from).getTime();
    return Number.isFinite(from) && now.getTime() >= from ? c : null;
  } catch {
    return null;
  }
}

// Janela de envio: os lembretes de uma regra com sendEndHour saem espalhados
// entre o inicio e o fim da janela, com pausa aleatoria entre um paciente e
// outro e um teto por rodada (protege o numero de bloqueio por rajada).
const MAX_SENDS_PER_RUN = BASE_SENDS_PER_RUN;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let reminderRunning = false;

// PURO: a janela planejada de uma regra para um agendamento (o envio e a PREVIA do painel usam esta mesma conta).
//  - "janela": regra com inicio e fim (dayOffset/sendHour/sendEndHour): vale [from, to);
//  - "ponto": horario fixo ou "N horas antes" (adiado para 7h se cair de madrugada): vale de `from` ate `from` + tolerancia (inclusive).
export function ruleWindow(
  rule: Pick<ReminderRule, "dayOffset" | "sendHour" | "sendMinute" | "sendEndHour" | "hoursBefore">,
  scheduledAt: Date,
  tz: string,
): { from: Date; to: Date; kind: "janela" | "ponto" } {
  if (rule.dayOffset != null && rule.sendHour != null && rule.sendEndHour != null) {
    return { from: fixedReminderTime(scheduledAt, rule.dayOffset, rule.sendHour, rule.sendMinute, tz), to: fixedReminderTime(scheduledAt, rule.dayOffset, rule.sendEndHour, 0, tz), kind: "janela" };
  }
  const sendAt = rule.dayOffset != null && rule.sendHour != null ? fixedReminderTime(scheduledAt, rule.dayOffset, rule.sendHour, rule.sendMinute, tz) : reminderSendTime(scheduledAt, rule.hoursBefore, tz);
  return { from: sendAt, to: new Date(sendAt.getTime() + SEND_TOLERANCE_MS), kind: "ponto" };
}

// PURO: a regra esta dentro da janela de envio para este agendamento AGORA? "window" = janela normal; "late" = reposicao de quem foi agendado
// depois que a janela do dia fechou; null = nao vale agora. Mesma conta da selecao, repetida imediatamente antes de cada envio (um adiamento nunca
// vira lembrete vencido ou fora de hora).
export function sendWindowOf(
  rule: Pick<ReminderRule, "dayOffset" | "sendHour" | "sendMinute" | "sendEndHour" | "hoursBefore" | "parentRuleId"> & Partial<Pick<ReminderRule, "purpose">>,
  appt: { scheduledAt: Date; createdAt: Date; scheduleChangedAt?: Date | null },
  now: Date,
  tz: string,
): "window" | "late" | null {
  if (appt.scheduledAt.getTime() <= now.getTime()) return null;
  if (rule.dayOffset != null && rule.sendHour != null && rule.sendEndHour != null) {
    if (inReminderWindow(appt.scheduledAt, now, { dayOffset: rule.dayOffset, sendHour: rule.sendHour, sendMinute: rule.sendMinute, sendEndHour: rule.sendEndHour }, tz)) return "window";
    // reposicao pra quem foi agendado depois da janela (regra-filha nao repoe: so cobra quem recebeu a mae)
    // lembrete explicito (so informa) nao tem reposicao: quem foi agendado depois da janela recebe a CONFIRMACAO como reposicao, nao tambem o lembrete
    if (!rule.parentRuleId && rule.purpose !== "lembrete" && isLateCatchUp(appt, { dayOffset: rule.dayOffset, sendEndHour: rule.sendEndHour }, now, tz)) return "late";
    return null;
  }
  const sendAt =
    rule.dayOffset != null && rule.sendHour != null
      ? fixedReminderTime(appt.scheduledAt, rule.dayOffset, rule.sendHour, rule.sendMinute, tz)
      : reminderSendTime(appt.scheduledAt, rule.hoursBefore, tz);
  const late = now.getTime() - sendAt.getTime();
  // Dentro da janela estreita apos o horario previsto E ainda antes da consulta.
  return late >= 0 && late <= SEND_TOLERANCE_MS ? "window" : null;
}

// Reposicao so depois de um respiro: se a Alice conversou com a pessoa ha menos que isto (o proprio agendamento costuma ser feito em conversa), a confirmacao espera.
export const LATE_QUIET_MS = 3 * 3_600_000;

export interface HeldReminder { appointmentId: string; code: string; detail: string }

// Quem deve receber esta regra AGORA (sem enviar nada): janela/horario, status, "ainda nao recebeu", dia da semana do atendimento, regra especifica que substitui a generica,
// "ja confirmou", reserva efetivada no CE e, nas regras de cobranca, "nao confirmou nem respondeu". Devolve tambem os RETIDOS com o motivo (nada some em silencio).
// `targetDate` (AAAA-MM-DD local) + `skipWindow`: o mesmo criterio para um DIA ESCOLHIDO, como se a janela estivesse aberta (usado so pelas PREVIAS e pela recuperacao controlada).
export async function selectReminderCandidates(
  rule: ReminderRule,
  now: Date,
  tz: string,
  opts: { targetDate?: string; skipWindow?: boolean; clinicRules?: ReminderRule[] } = {},
) {
  const held: HeldReminder[] = [];
  let upper: Date;
  let lower = now;
  const fixed = rule.dayOffset != null && rule.sendHour != null;
  if (opts.targetDate) {
    const [y, m, d] = opts.targetDate.split("-").map(Number);
    const start = zonedWallClockToUtc(tz, y, m, d, 0, 0);
    const n = new Date(Date.UTC(y, m - 1, d + 1));
    upper = zonedWallClockToUtc(tz, n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), 0, 0);
    if (start.getTime() > lower.getTime()) lower = new Date(start.getTime() - 1);
  } else if (fixed) {
    // o dia CIVIL do atendimento (hoje + dayOffset), no fuso da clinica - nao "N horas a partir de agora"
    const [y, m, d] = isoDateInZone(now, tz).split("-").map(Number);
    const n = new Date(Date.UTC(y, m - 1, d + rule.dayOffset! + 1));
    upper = zonedWallClockToUtc(tz, n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), 0, 0);
  } else {
    const target = new Date(now.getTime() + rule.hoursBefore * 60 * 60_000);
    upper = new Date(Math.max(target.getTime() + 8 * 3_600_000, now.getTime() + 54 * 3_600_000));
  }
  const clinicRules = opts.clinicRules ?? (await prisma.reminderRule.findMany({ where: { clinicId: rule.clinicId, active: true } }));
  const candidates = await prisma.appointment.findMany({
    where: {
      clinicId: rule.clinicId,
      status: "confirmed",
      scheduledAt: { gt: lower, lt: upper },
      // Regra de "nao confirmou": so quem recebeu a regra-mae e ainda nao confirmou.
      ...(rule.parentRuleId
        ? { patientConfirmed: false, AND: [{ reminders: { none: { ruleId: rule.id } } }, { reminders: { some: { ruleId: rule.parentRuleId } } }] }
        : { reminders: { none: { ruleId: rule.id } } }),
    },
    include: { patient: true, attendee: true, procedure: true, professional: true, reminders: { where: { ruleId: rule.parentRuleId ?? "-" }, select: { sentAt: true } } },
  });

  // (a) ESCOPO: dia da semana do atendimento, regra especifica que a substitui, e a janela de envio
  const lateIds = new Set<string>();
  let due = candidates.filter((appt) => {
    const wd = weekdayInZone(appt.scheduledAt, tz);
    if (!ruleAppliesOnWeekday(rule, wd)) return false; // fora do escopo desta regra: nao e retencao, e outro dia
    const specific = overridingRule(rule, wd, clinicRules);
    if (specific) { held.push({ appointmentId: appt.id, code: "substituida_por_regra_do_dia", detail: `neste dia da semana vale a regra específica (${specific.id}), não esta` }); return false; }
    if (opts.skipWindow) return true;
    const w = sendWindowOf(rule, appt, now, tz);
    if (w === "late") lateIds.add(appt.id);
    return w !== null;
  });

  // (b) quem ja confirmou nao recebe nova SOLICITACAO de confirmacao (politica explicita: resendIfConfirmed)
  if (!rule.parentRuleId && skipsConfirmedPatient(rule)) {
    due = due.filter((appt) => {
      if (!appt.patientConfirmed) return true;
      held.push({ appointmentId: appt.id, code: "ja_confirmou", detail: "a pessoa já confirmou a presença: não recebe nova solicitação de confirmação" });
      return false;
    });
  }

  // (c) reserva ainda nao efetivada no CE nao e apresentada como agendamento confirmado
  if (due.length) {
    const pending = await notYetEffectuated(due);
    if (pending.size) {
      due = due.filter((appt) => {
        const why = pending.get(appt.id);
        if (!why) return true;
        held.push({ appointmentId: appt.id, code: "reserva_nao_efetivada_no_ce", detail: `${why}: a confirmação não é enviada como se o horário estivesse firmado` });
        return false;
      });
    }
  }

  // (d) Reposicao (agendado/remarcado depois que a janela do dia fechou) so pra quem NAO recebeu nada desde que o horario existe: se a propria Alice (conversa) ou o painel ja
  // falou sobre o horario com a pessoa, outra "confirmacao" logo em seguida seria repeticao. Regra legada: dispensa de vez (como sempre foi, agora REGISTRADO). Regra com
  // proposito explicito: espera um respiro (LATE_QUIET_MS) e depois pede, porque a conversa de agendamento nao e a confirmacao de presenca.
  if (lateIds.size) {
    const keep: typeof due = [];
    const explicit = explicitPurpose(rule) !== null;
    for (const appt of due) {
      if (!lateIds.has(appt.id)) { keep.push(appt); continue; }
      const since = new Date(Math.max(appt.createdAt.getTime(), appt.scheduleChangedAt?.getTime() ?? 0));
      const last = await prisma.message.findFirst({ where: { role: "assistant", createdAt: { gte: since }, conversation: { patientId: appt.patientId } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
      if (!last) { keep.push(appt); continue; }
      if (explicit && now.getTime() - last.createdAt.getTime() >= LATE_QUIET_MS) { keep.push(appt); continue; }
      held.push({
        appointmentId: appt.id,
        code: explicit ? "reposicao_aguardando_conversa_recente" : "reposicao_dispensada_ja_houve_conversa",
        detail: explicit ? "agendado/remarcado depois da janela e a Alice conversou com a pessoa há pouco: a confirmação espera um respiro" : "agendado/remarcado depois da janela, mas a Alice já conversou com a pessoa desde então: a reposição foi dispensada",
      });
    }
    due = keep;
  }

  // UMA mensagem por pessoa por dia: se ela tem outro horario no MESMO dia que vem antes (ou que ja recebeu esta regra),
  // este fica coberto pela confirmacao do primeiro horario e nao recebe outra.
  if (!rule.parentRuleId && due.length) {
    const first: typeof due = [];
    for (const appt of due) {
      const { start, end } = localDayBounds(appt.scheduledAt, tz);
      const covered = await prisma.appointment.findFirst({
        where: {
          clinicId: rule.clinicId,
          patientId: appt.patientId,
          attendeeId: appt.attendeeId, // a MESMA pessoa: o marido que divide o telefone da esposa e outra pessoa (recebe a propria confirmacao)
          id: { not: appt.id },
          scheduledAt: { gte: start, lt: end },
          OR: [
            { reminders: { some: { ruleId: rule.id } } },
            { status: "confirmed", OR: [{ scheduledAt: { lt: appt.scheduledAt } }, { scheduledAt: appt.scheduledAt, id: { lt: appt.id } }] },
          ],
        },
        select: { id: true },
      });
      if (!covered) first.push(appt);
      else held.push({ appointmentId: appt.id, code: "coberta_por_outro_horario_do_dia", detail: "a pessoa tem outro horário no mesmo dia: a mensagem do primeiro horário cobre este" });
    }
    due = first;
  }

  if (rule.parentRuleId) {
    // Quem respondeu algo depois da confirmacao nao e cobrado de novo.
    const silent: typeof due = [];
    for (const appt of due) {
      const sentAt = appt.reminders[0]?.sentAt;
      if (!sentAt) continue;
      if (now.getTime() - sentAt.getTime() < CHILD_MIN_GAP_MS) { held.push({ appointmentId: appt.id, code: "cobranca_aguardando_intervalo", detail: `a cobrança só sai ${CHILD_MIN_GAP_MS / 3_600_000}h depois da mensagem-mãe` }); continue; }
      const replies = await prisma.message.count({ where: { role: "user", createdAt: { gt: sentAt }, conversation: { patientId: appt.patientId } } });
      if (replies === 0) silent.push(appt);
      else held.push({ appointmentId: appt.id, code: "respondeu_depois_da_confirmacao", detail: "a pessoa respondeu depois da mensagem-mãe: não é cobrada" });
    }
    due = silent;
  }

  return { due, held, late: lateIds };
}

export async function selectDueAppointments(rule: ReminderRule, now: Date, tz: string) {
  return (await selectReminderCandidates(rule, now, tz)).due;
}

// Roda a cada 15min. Cada regra ativa dispara uma vez por agendamento (marca
// em ReminderSent + controle persistente ReminderDispatch) - assim da pra ter
// mais de uma regra (ex: 24h antes e 2h antes) sem mandar a mesma coisa duas
// vezes nem perder uma por causa da outra.
//
// Por agendamento, nesta ordem: (0) confere que ele continua confirmado e no mesmo horario; (1) a janela de envio ainda vale agora;
// (2) o controle persistente nao mostra que isto ja foi enviado / esta em andamento / foi tentado ha pouco; (3) agendamento ligado ao
// Clinica Experts e conferido ao vivo (cancelado/apagado/trocado/atendido = nao envia; INCONCLUSIVO = adia, sem consumir o lembrete);
// (4) reserva ATOMICA do envio; (5) envio, com o resultado registrado do jeito que aconteceu (sent / blocked / vetoed / duplicate /
// sem confirmacao / falha). Um erro em UMA reserva nunca interrompe as demais nem as outras clinicas.
const DEFER_ALERT_EVERY_MS = 3 * 3_600_000;
const deferAlertedAt = new Map<string, number>(); // clinica -> quando a equipe foi avisada do adiamento
const CE_DOWN_AFTER = 3;
const MAX_CHECKS_PER_RUN = 40; // quantas reservas uma regra examina por rodada (o teto de ENVIOS e MAX_SENDS_PER_RUN)

// Resumo da rodada por clinica (AutomationRun "lembretes"): prova que o job rodou e o que decidiu, sem dado pessoal. Preenchido pelo proprio registro das decisoes.
let cycleRecorders: Map<string, RunRecorder> | null = null;
function recordCycle(decision: string, f: Record<string, string | number | boolean | null | undefined>): void {
  if (!cycleRecorders || typeof f.clinica !== "string") return;
  let r = cycleRecorders.get(f.clinica);
  if (!r) cycleRecorders.set(f.clinica, (r = new RunRecorder("lembretes", f.clinica)));
  r.candidates++;
  const motivo = String(f.motivo ?? f.resultado ?? "-").slice(0, 60);
  if (decision === "enviar") {
    const res = String(f.resultado ?? "");
    if (res === "sent") { r.eligible++; r.add("enviado", "lembrete"); }
    else if (res === "vetoed") r.add("vetado", "revisao_de_envio_barrou");
    else if (res === "falhou" || res === "falha_definitiva") r.add("falha", res);
    else if (res === "sem_confirmacao") r.add("incerto", "envio_nao_confirmado");
    else if (res === "adiado") r.add("adiado", "whatsapp_desconectado_ou_revisao");
    else r.add("ignorado", res || "outro");
  } else if (decision === "adiar") r.add("adiado", motivo.split(":")[0]);
  else if (decision === "desistir") r.add("falha", "tentativas_esgotadas");
  else r.add("ignorado", motivo);
}

function logDecision(decision: string, f: Record<string, string | number | boolean | null | undefined>): void {
  recordCycle(decision, f);
  const parts = Object.entries(f).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${k}=${String(v)}`);
  console.log(`[lembrete] decisao=${decision} ${parts.join(" ")} revisao=${REVISION.split(":")[0]}`);
}

interface DeferStats { deferred: number; exhausted: number; reasons: Set<string> }

async function alertDeferrals(stats: Map<string, DeferStats>): Promise<void> {
  for (const [clinicId, s] of stats) {
    if (s.deferred === 0 && s.exhausted === 0) continue;
    if (Date.now() - (deferAlertedAt.get(clinicId) ?? 0) < DEFER_ALERT_EVERY_MS && s.exhausted === 0) continue;
    deferAlertedAt.set(clinicId, Date.now());
    const reason = [...s.reasons].slice(0, 2).join("; ");
    const text = s.exhausted
      ? `⚠️ ${s.exhausted} lembrete(s) de agendamento NÃO foram enviados porque o Clínica Experts não respondeu a tempo (${reason}). Confirme esses horários com os pacientes.`
      : `⚠️ Não consegui conferir ${s.deferred} agendamento(s) no Clínica Experts (${reason}). Os lembretes ficaram para a próxima rodada e só saem se a janela de envio ainda valer; nenhum agendamento foi cancelado ou alterado.`;
    await notifyStaff(clinicId, "automation_failed", text).catch(() => undefined);
    await logActivity({ clinicId, type: "reminder_deferred", area: "automacoes", title: "Lembretes adiados: Clínica Experts não respondeu", description: `${text.replace(/^⚠️ /, "")}`, actorName: null }).catch(() => undefined);
  }
}

// Tudo o que acontece com UM agendamento depois de selecionado: confere o estado fresco, a janela, o controle persistente, o Clinica Experts ao vivo, reserva atomica, envio e o
// desfecho gravado como aconteceu. E a UNICA via de envio de lembretes e confirmacoes: o ciclo automatico e a execucao controlada (prévia autorizada) passam por aqui, entao as
// travas, a idempotencia e o tratamento de resultado incerto sao as mesmas. Devolve true quando houve tentativa de envio (reserva adquirida).
export interface DeliverEnv {
  clock: () => Date;
  tz: string;
  clinicInfo: Awaited<ReturnType<typeof getClinicTemplateInfo>>;
  stat: DeferStats;
  ceDown: Map<string, string>;
  ceFailures: Map<string, number>;
}
export type DueAppointment = Awaited<ReturnType<typeof selectReminderCandidates>>["due"][number];

export async function deliverReminder(env: DeliverEnv, rule: ReminderRule, appt: DueAppointment, opts: { ignoreWindow?: boolean; pause?: boolean; origin?: string } = {}): Promise<boolean> {
  const { clock, tz, clinicInfo, stat, ceDown, ceFailures } = env;
  let attempted = false;
  const stamp = clock();
  const base = {
    clinica: rule.clinicId, agendamento: appt.id, reserva: appt.ceBookingUuid ?? undefined, regra: rule.id,
    procedimento: appt.procedureId, profissional: appt.professionalId ?? undefined,
    horario: appt.scheduledAt.toISOString(), fuso: tz,
  };
  const key: DispatchKey = {
    clinicId: rule.clinicId, bookingKey: bookingKeyOf(appt), appointmentId: appt.id, patientId: appt.patientId,
    ruleId: rule.id, kind: dispatchKind(rule), startsAt: appt.scheduledAt, sendDay: sendDayOf(stamp, tz),
  };
  try {
    // (0) O agendamento mudou desde a selecao (a importacao do CE roda a cada 10 min e pausas entre envios levam minutos)?
    const fresh = await prisma.appointment.findUnique({ where: { id: appt.id }, select: { status: true, scheduledAt: true, patientConfirmed: true } });
    if (!fresh || fresh.status !== "confirmed" || fresh.scheduledAt.getTime() !== appt.scheduledAt.getTime()) {
      logDecision("pular", { ...base, motivo: "o agendamento mudou depois da selecao (cancelado/atendido/outro horario)" });
      return false;
    }
    // Solicitacao de confirmacao: quem confirmou durante a rodada (ou entre a selecao e agora) nao recebe outro pedido. Vale a confirmacao DE AGORA.
    if (!rule.parentRuleId && skipsConfirmedPatient(rule) && fresh.patientConfirmed) {
      logDecision("pular", { ...base, tipo: key.kind, motivo: "o paciente ja confirmou: nao recebe nova solicitacao de confirmacao" });
      return false;
    }
    // COBRANCA ("ainda nao recebemos sua confirmacao"): a pessoa confirmou (ou respondeu) durante a rodada = nao cobra. Vale a confirmacao DE AGORA, nao a da selecao.
    if (rule.parentRuleId) {
      const parentSentAt = appt.reminders[0]?.sentAt;
      if (fresh.patientConfirmed) { logDecision("pular", { ...base, tipo: key.kind, motivo: "o paciente confirmou antes da cobranca" }); return false; }
      if (parentSentAt && (await prisma.message.count({ where: { role: "user", createdAt: { gt: parentSentAt }, conversation: { patientId: appt.patientId } } })) > 0) {
        logDecision("pular", { ...base, tipo: key.kind, motivo: "o paciente respondeu antes da cobranca" });
        return false;
      }
    }
    // (1) A janela de envio desta regra ainda vale AGORA? (nada de lembrete vencido ou fora de hora pra compensar falha anterior)
    if (!opts.ignoreWindow && !sendWindowOf(rule, appt, stamp, tz)) {
      logDecision("pular", { ...base, motivo: "fora da janela de envio" });
      return false;
    }
    // (2) Controle persistente: ja enviado / em andamento / tentado ha pouco / mesmo tipo ja enviado hoje?
    const pre = await precheckDispatch(key, stamp);
    if (pre) {
      logDecision("pular", { ...base, tipo: key.kind, motivo: pre });
      return false;
    }

    // (3) Reserva do Clinica Experts: confere ao vivo. Inconclusivo = ADIA (nao envia, nao cancela, nao consome).
    let ceResult: string | undefined;
    if (appt.ceBookingUuid) {
      const label = appt.attendee?.name ?? appt.patient.name ?? "paciente";
      const down = ceDown.get(rule.clinicId);
      const verdict = down ? null : await verifyBookingLive(appt, tz);
      const action: LiveAction = verdict ? await applyLiveVerdict(appt, verdict, label) : "defer";
      const seen = verdict && "seen" in verdict && verdict.seen ? { ce_status: verdict.seen.status, ce_inicio: verdict.seen.startsAt } : {};
      if (action === "skip") {
        logDecision("pular", { ...base, ...seen, ce: verdict?.kind, motivo: verdict?.kind === "gone" ? verdict.why : "horario corrigido a partir do Clinica Experts" });
        return false;
      }
      if (action === "defer") {
        const reason = down ?? (verdict?.kind === "unknown" ? verdict.reason : "conferencia inconclusiva");
        if (verdict?.kind === "unknown" && verdict.systemic) {
          const n = (ceFailures.get(rule.clinicId) ?? 0) + 1;
          ceFailures.set(rule.clinicId, n);
          if (n >= CE_DOWN_AFTER) ceDown.set(rule.clinicId, verdict.reason);
        }
        const d = await recordDeferral(key, reason, stamp);
        if (d.counted) { stat.deferred++; stat.reasons.add(reason); }
        if (d.exhausted) {
          stat.exhausted++;
          logDecision("desistir", { ...base, tentativa: d.attempt, ce: "inconclusivo", motivo: reason });
        } else {
          logDecision("adiar", { ...base, tentativa: d.attempt, ce: "inconclusivo", motivo: reason });
        }
        return false;
      }
      ceFailures.set(rule.clinicId, 0); // o CE respondeu: a sequencia de falhas recomeca
      ceResult = `${verdict?.kind ?? "ok"} status=${seen.ce_status ?? "?"} inicio=${seen.ce_inicio ?? "?"}`;
    }

    const noProcedure = isPlaceholderProcedure(appt.procedure);
    const text = renderMessageTemplate(noProcedure ? stripProcedureLines(rule.message) : rule.message, {
      patientName: appt.attendee?.name ?? appt.patient.name, // quem sera ATENDIDO (acompanhante), nao so o contato do telefone
      patientPhone: appt.patient.phone,
      clinicName: clinicInfo.name,
      locationName: clinicInfo.primaryLocation?.name,
      locationAddress: clinicInfo.primaryLocation?.fullAddress,
      procedureName: noProcedure ? "seu atendimento" : appt.procedure.name,
      professionalName: appt.professional?.name,
      when: appt.scheduledAt,
      timeZone: tz,
    });

    // Duas regras IGUAIS (mesmo texto, mesmo horario) cadastradas por engano: se a irma
    // ja enviou este lembrete para este agendamento, esta nao envia de novo.
    // Alem de regras identicas, vale texto igual sem negrito e o mesmo TIPO de confirmacao ("hoje" / "amanha") nas ultimas 20h.
    const recentSiblings = await prisma.reminderSent.findMany({
      where: {
        appointmentId: appt.id,
        ruleId: { not: rule.id },
        sentAt: { gte: new Date(stamp.getTime() - DUPLICATE_REMINDER_WINDOW_MS) },
        rule: { clinicId: rule.clinicId, parentRuleId: rule.parentRuleId },
      },
      select: { rule: { select: { message: true } } },
    });
    if (recentSiblings.some((x) => isSameReminderText(x.rule.message, rule.message))) {
      logDecision("pular", { ...base, tipo: key.kind, motivo: "regra equivalente ja enviou este lembrete" });
      return false;
    }

    // Menor intervalo possivel entre as conferencias e o envio: le o estado de novo logo antes de reservar (a importacao do CE pode ter
    // mudado o agendamento enquanto a consulta ao CE e a montagem do texto aconteciam). O que ainda pode mudar nos segundos entre aqui e a
    // entrega no WhatsApp (revisao por IA incluida) e uma limitacao inevitavel: o CE e externo e nao ha como "travar" a reserva la.
    const again = await prisma.appointment.findUnique({ where: { id: appt.id }, select: { status: true, scheduledAt: true, patientConfirmed: true } });
    if (!again || again.status !== "confirmed" || again.scheduledAt.getTime() !== appt.scheduledAt.getTime() || (skipsConfirmedPatient(rule) && again.patientConfirmed)) {
      logDecision("pular", { ...base, ce: ceResult, motivo: "o agendamento mudou durante a conferencia" });
      return false;
    }
    // (4) RESERVA atomica antes de enviar (indice unico no banco, vale entre processos e reinicios): se outra rodada/regra ja pegou, nao envia.
    const acq = await acquireDispatch(key, stamp);
    if (!acq.ok) {
      logDecision("pular", { ...base, tipo: key.kind, motivo: `controle de envio: ${acq.why}${acq.state ? ` (${acq.state})` : ""}` });
      return false;
    }
    try {
      await prisma.reminderSent.create({ data: { appointmentId: appt.id, ruleId: rule.id } });
    } catch {
      await finishDispatch(acq.id, "duplicate", "ja existia o registro de lembrete enviado para esta reserva e regra");
      logDecision("pular", { ...base, tipo: key.kind, tentativa: acq.attempt, motivo: "registro de lembrete ja existia" });
      return false;
    }

    // (5) ENVIO. O resultado e gravado como aconteceu - nao como "enviado" por padrao.
    attempted = true;
    let outcome: SendOutcome | null = null;
    try {
      outcome = await sendText(appt.clinicId, appt.patient.phone, text, { kind: "lembrete" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isSendDeferred(err)) {
        // a conexao caiu entre a conferencia e o envio: nada saiu e nao e falha desta pessoa. Libera a reserva e adia.
        await finishDispatch(acq.id, "deferred", msg);
        await prisma.reminderSent.deleteMany({ where: { appointmentId: appt.id, ruleId: rule.id } });
        logDecision("enviar", { ...base, tipo: key.kind, tentativa: acq.attempt, ce: ceResult, resultado: "adiado" });
      } else if (isPermanentSendError(err)) {
        await finishDispatch(acq.id, "failed_permanent", msg); // numero sem WhatsApp: mantem a reserva, nao insiste
        logDecision("enviar", { ...base, tipo: key.kind, tentativa: acq.attempt, ce: ceResult, resultado: "falha_definitiva" });
      } else if (isAmbiguousSendError(err)) {
        await finishDispatch(acq.id, "unconfirmed", msg); // pode ter saido: NAO libera a reserva (reenviar duplicava a confirmacao)
        logDecision("enviar", { ...base, tipo: key.kind, tentativa: acq.attempt, ce: ceResult, resultado: "sem_confirmacao" });
      } else {
        await finishDispatch(acq.id, "failed", msg); // nada saiu: libera a reserva e tenta de novo na proxima rodada (com teto e intervalo)
        await prisma.reminderSent.deleteMany({ where: { appointmentId: appt.id, ruleId: rule.id } });
        logDecision("enviar", { ...base, tipo: key.kind, tentativa: acq.attempt, ce: ceResult, resultado: "falhou" });
      }
      console.error(`Falha ao enviar lembrete (regra ${rule.id}) para ${appt.patient.phone.slice(-4)}:`, msg);
    }
    if (outcome) {
      if (outcome === "sent") {
        await finishDispatch(acq.id, "sent", opts.origin);
        await recordAutomatedMessage(appt.patientId, text, "Lembrete de consulta");
      } else {
        // blocked (plano), vetoed (revisao) e duplicate (mesmo texto ja saiu) NAO sao envio: ficam registrados assim.
        await finishDispatch(acq.id, outcome, `sendText=${outcome}`);
      }
      logDecision("enviar", { ...base, tipo: key.kind, tentativa: acq.attempt, ce: ceResult, resultado: outcome });
    }
    if (rule.sendEndHour != null && opts.pause !== false) await sleep((rule.pauseMinSec + Math.random() * Math.max(0, rule.pauseMaxSec - rule.pauseMinSec)) * 1000);
  } catch (err) {
    console.error(`[lembrete] erro ao tratar a reserva ${appt.id} (regra ${rule.id}); as demais seguem:`, err instanceof Error ? err.message : err);
  }
  return attempted;
}

// Uma rodada de lembretes (exportada para teste; o cron so chama isto a cada 15 min). `now` permite controlar o relogio nos testes.
export async function runReminderCycle(opts: { now?: Date } = {}): Promise<void> {
    if (reminderRunning) return; // rodada anterior (com pausas) ainda em andamento
    reminderRunning = true;
    const stats = new Map<string, DeferStats>();
    // O CE so e dado como fora do ar na rodada depois de 3 falhas SEGUIDAS (CE_DOWN_AFTER) de sistema (rede/token/5xx): uma reserva com problema isolado
    // nao trava as outras; um CE realmente fora do ar nao e martelado reserva por reserva (cada tentativa espera ate o timeout).
    const ceDown = new Map<string, string>(); // clinica -> motivo
    const ceFailures = new Map<string, number>(); // clinica -> falhas de sistema seguidas
    const clock = () => opts.now ?? new Date();
    cycleRecorders = new Map();
    try {
    const loaded = await prisma.reminderRule.findMany({ where: { active: true, clinic: PAID_CLINIC_WHERE } });
    const rules: typeof loaded = [];
    for (const r of loaded) {
      const change = dueScheduledChange(r.scheduledChange, clock());
      if (!change) { rules.push(r); continue; }
      const data = {
        ...(change.sendHour !== undefined ? { sendHour: change.sendHour } : {}),
        ...(change.sendMinute !== undefined ? { sendMinute: change.sendMinute } : {}),
        ...(change.sendEndHour !== undefined ? { sendEndHour: change.sendEndHour } : {}),
        ...(change.pauseMinSec !== undefined ? { pauseMinSec: change.pauseMinSec } : {}),
        ...(change.pauseMaxSec !== undefined ? { pauseMaxSec: change.pauseMaxSec } : {}),
        scheduledChange: null,
      };
      rules.push(await prisma.reminderRule.update({ where: { id: r.id }, data }));
    }
    const clinicInfoCache = new Map<string, Awaited<ReturnType<typeof getClinicTemplateInfo>>>();

    for (const rule of rules) {
      try {
      const now = clock();
      // Janela estreita (um pouco maior que o intervalo do cron, pra nao
      // perder por atraso) em vez de "do agora ate o alvo": sem isso, um
      // agendamento marcado em cima da hora (ex: pra daqui a 2h) cai dentro
      // da janela de TODAS as regras com hoursBefore maior (24h, 12h...) na
      // primeira checagem, e a Alice manda "amanha" pra uma consulta que e
      // hoje mesmo. Com a janela estreita, cada regra so dispara perto do
      // horario que ela realmente promete.
      // O horario previsto pode ser adiado pra 7h (ver reminderSendTime), entao
      // a busca olha de "agora" ate o alvo e o filtro fino fica no codigo.
      const clinicRow = await prisma.clinic.findUnique({ where: { id: rule.clinicId }, select: { timezone: true } });
      const tz = clinicRow?.timezone || "America/Sao_Paulo";

      const clinicRules = rules.filter((r) => r.clinicId === rule.clinicId);
      const selection = await selectReminderCandidates(rule, now, tz, { clinicRules });
      const due = selection.due;
      // Nada some em silencio: o que foi retido (com o motivo) entra no resumo da rodada e no log.
      for (const h of selection.held.slice(0, 100)) logDecision("reter", { clinica: rule.clinicId, regra: rule.id, agendamento: h.appointmentId, motivo: h.code });
      // Depois que a janela de uma regra de confirmacao fecha, confere (uma vez por dia) quem ficou SEM a mensagem e avisa a equipe com o motivo.
      if (rule.sendEndHour != null) await reportConfirmationGaps(rule, now, tz, clinicRules).catch((err) => console.error("[lembrete] conferencia da cobertura falhou:", err instanceof Error ? err.message : err));

      if (due.length === 0) continue;
      // WhatsApp desta clinica comprovadamente fora: nao reserva, nao confere no CE e NAO gasta tentativa (o teto de tentativas desistiria do lembrete em 45 min por um problema da
      // clinica inteira). A janela de envio de cada lembrete segue valendo: quando a conexao volta, so sai o que ainda esta dentro da janela, uma vez, sem lote atrasado.
      const conn = await connectionUsable(rule.clinicId).catch(() => ({ usable: true as const, since: null, reason: null }));
      if (!conn.usable) {
        logDecision("adiar", { clinica: rule.clinicId, regra: rule.id, motivo: "whatsapp_desconectado: nenhum lembrete desta clinica e tentado ate reconectar", pendentes: due.length });
        continue;
      }
      due.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime()); // quem atende primeiro recebe primeiro

      if (!clinicInfoCache.has(rule.clinicId)) {
        clinicInfoCache.set(rule.clinicId, await getClinicTemplateInfo(rule.clinicId));
      }
      const clinicInfo = clinicInfoCache.get(rule.clinicId)!;
      const stat = stats.get(rule.clinicId) ?? { deferred: 0, exhausted: 0, reasons: new Set<string>() };
      stats.set(rule.clinicId, stat);

      let sends = 0;
      let checked = 0;
      // Teto da rodada: o padrao (12) so sobe, ate 30, quando a janela e curta e a fila nao caberia nas rodadas que restam (confirmacao do dia seguinte ate as 9h).
      const windowEndsAt = rule.dayOffset != null && rule.sendHour != null && rule.sendEndHour != null ? ruleWindow(rule, due[0].scheduledAt, tz).to : null; // (so conta se a janela ainda esta aberta: reposicao nao aumenta o teto)
      const sendCap = perRunCap(due.length, windowEndsAt && windowEndsAt.getTime() > now.getTime() ? windowEndsAt : null, now);
      const checkCap = Math.max(MAX_CHECKS_PER_RUN, sendCap * 3);
      for (const appt of due) {
        // Teto de ENVIOS por rodada (protege o numero de bloqueio por rajada); o que foi pulado ou adiado nao conta, entao nao trava os demais.
        if (rule.sendEndHour != null && (sends >= sendCap || checked >= checkCap)) break;
        checked++;
        const attempted = await deliverReminder({ clock, tz, clinicInfo, stat, ceDown, ceFailures }, rule, appt);
        if (attempted) sends++;
      }
      } catch (err) {
        console.error(`[lembrete] erro na regra ${rule.id}; as demais regras seguem:`, err instanceof Error ? err.message : err);
      }
    }
    await alertDeferrals(stats);
    } finally {
      const recs = cycleRecorders;
      cycleRecorders = null;
      if (recs) for (const r of recs.values()) await r.save("ok", undefined, clock());
      reminderRunning = false;
    }
}

export function startReminderJob(): void {
  scheduleLocked("lembretes", "*/15 * * * *", () => runReminderCycle());
}
