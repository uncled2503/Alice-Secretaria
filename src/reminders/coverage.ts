import type { ReminderRule } from "@prisma/client";
import { prisma } from "../db/client.js";
import { notifyStaff } from "../crm/notify.js";
import { logActivity } from "../crm/activity.js";
import { isoDateInZone, formatDayInZone } from "../scheduling/time.js";
import { fixedReminderTime, selectReminderCandidates, type HeldReminder } from "./cron.js";
import { effectivePurpose, ruleAppliesOnWeekday, weekdayInZone } from "./policy.js";
import { bookingKeyOf } from "./ledger.js";
import { extendedDeadline, normalWindowEnd, type ExtensionCtx } from "../dispatch/policy.js";
import { localDayBounds } from "./firstOfDay.js";

// ---------------------------------------------------------------------------
// COBERTURA DA CONFIRMACAO: quando a janela de uma regra de confirmacao FECHA, quem era elegivel e nao recebeu a solicitacao nao pode ficar sem ninguem saber. Com a janela
// curta (dia anterior ate as 9h) um WhatsApp fora do ar, o Clinica Experts sem responder ou uma rodada perdida passam a custar a janela inteira; o sistema nao "compensa"
// mandando lote atrasado (isso so existe na reposicao de quem foi agendado/remarcado DEPOIS da janela, e na recuperacao controlada, com autorizacao). Em vez disso:
//   - confere UMA vez por dia por regra (logo depois do fechamento) quem ficou sem a mensagem e por que;
//   - grava no Diario de atividades e avisa a equipe, com os motivos e a quantidade (sem nomes), para ela agir a tempo de reorganizar a agenda.
// ---------------------------------------------------------------------------

export const GAP_CHECK_GRACE_MS = 45 * 60_000; // so confere nas rodadas logo apos o fechamento da janela
const MARK = (ruleId: string, day: string) => `[cobertura:${ruleId}:${day}]`;

export type GapCause = "nao_saiu_na_janela" | "reposicao_pendente" | "reserva_nao_efetivada_no_ce" | "reposicao_aguardando_conversa_recente" | "reposicao_dispensada_ja_houve_conversa";

export interface GapLine { appointmentId: string; cause: GapCause; detail: string }
export interface GapReport {
  ruleId: string;
  targetDate: string;
  windowEnd: string;
  gaps: GapLine[];
  fine: number; // quantos ja estao cobertos (enviados/aceitos) ou nao precisam (ja confirmaram...)
}

// PURO: a janela fecha quando, para os atendimentos de `targetDate`?
export function windowEndFor(rule: Pick<ReminderRule, "dayOffset" | "sendEndHour">, targetDate: string, tz: string): Date | null {
  if (rule.dayOffset == null || rule.sendEndHour == null) return null;
  const [y, m, d] = targetDate.split("-").map(Number);
  return fixedReminderTime(new Date(Date.UTC(y, m - 1, d, 15)), rule.dayOffset, rule.sendEndHour, 0, tz); // 15h UTC: sempre o mesmo dia civil em fusos do Brasil
}

// PURO: o dia dos atendimentos (data local) a que a janela de HOJE se refere.
export function targetDateOfToday(rule: Pick<ReminderRule, "dayOffset">, now: Date, tz: string): string | null {
  if (rule.dayOffset == null) return null;
  const [y, m, d] = isoDateInZone(now, tz).split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + rule.dayOffset));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

// Calcula (somente leitura) quem ficou sem a solicitacao de `targetDate` e por que.
export async function computeConfirmationGaps(rule: ReminderRule, targetDate: string, now: Date, tz: string, clinicRules?: ReminderRule[]): Promise<GapReport | null> {
  const end = windowEndFor(rule, targetDate, tz);
  if (!end) return null;
  const sel = await selectReminderCandidates(rule, now, tz, { targetDate, skipWindow: true, clinicRules });
  const gaps: GapLine[] = [];
  const dispatches = sel.due.length
    ? await prisma.reminderDispatch.findMany({ where: { clinicId: rule.clinicId, ruleId: rule.id, bookingKey: { in: sel.due.map(bookingKeyOf) } }, select: { bookingKey: true, startsAt: true, state: true, detail: true } })
    : [];
  for (const a of sel.due) {
    const since = Math.max(a.createdAt.getTime(), a.scheduleChangedAt?.getTime() ?? 0);
    const row = dispatches.find((d) => d.bookingKey === bookingKeyOf(a) && d.startsAt.getTime() === a.scheduledAt.getTime());
    if (since >= end.getTime() && !row) gaps.push({ appointmentId: a.id, cause: "reposicao_pendente", detail: "agendado/remarcado depois da janela: sai como reposição (8h–20h, com 2h de folga)" });
    else gaps.push({ appointmentId: a.id, cause: "nao_saiu_na_janela", detail: row ? `controle de envio: ${row.state}${row.detail ? ` (${row.detail})` : ""}` : "sem nenhuma tentativa registrada na janela" });
  }
  const significant = new Set<string>(["reserva_nao_efetivada_no_ce", "reposicao_aguardando_conversa_recente", "reposicao_dispensada_ja_houve_conversa"]);
  for (const h of sel.held as HeldReminder[]) if (significant.has(h.code)) gaps.push({ appointmentId: h.appointmentId, cause: h.code as GapCause, detail: h.detail });
  const [ty, tm, td] = targetDate.split("-").map(Number);
  const { start, end: dayEnd } = localDayBounds(new Date(Date.UTC(ty, tm - 1, td, 15)), tz);
  const total = await prisma.appointment.count({ where: { clinicId: rule.clinicId, status: "confirmed", scheduledAt: { gte: start, lt: dayEnd } } });
  return { ruleId: rule.id, targetDate, windowEnd: end.toISOString(), gaps, fine: Math.max(0, total - new Set(gaps.map((g) => g.appointmentId)).size) };
}

const CAUSE_LABEL: Record<GapCause, string> = {
  nao_saiu_na_janela: "elegível, mas a mensagem não saiu dentro da janela",
  reposicao_pendente: "agendado/remarcado depois da janela (sai como reposição)",
  reserva_nao_efetivada_no_ce: "reserva ainda não efetivada no Clínica Experts",
  reposicao_aguardando_conversa_recente: "reposição aguardando (a Alice conversou com a pessoa há pouco)",
  reposicao_dispensada_ja_houve_conversa: "reposição dispensada (a Alice já conversou com a pessoa)",
};

// Chamada pelo cron a cada rodada; so age logo depois do fechamento da janela, uma vez por dia e por regra.
export async function reportConfirmationGaps(rule: ReminderRule, now: Date, tz: string, clinicRules?: ReminderRule[]): Promise<GapReport | null> {
  if (rule.parentRuleId || effectivePurpose(rule) !== "confirmacao") return null;
  const targetDate = targetDateOfToday(rule, now, tz);
  if (!targetDate) return null;
  const [y, m, d] = targetDate.split("-").map(Number);
  if (!ruleAppliesOnWeekday(rule, weekdayInZone(new Date(Date.UTC(y, m - 1, d, 15)), tz))) return null;
  const end = windowEndFor(rule, targetDate, tz);
  if (!end || now.getTime() < end.getTime() || now.getTime() >= end.getTime() + GAP_CHECK_GRACE_MS) return null;

  const marker = MARK(rule.id, targetDate);
  const already = await prisma.activityLog.findFirst({ where: { clinicId: rule.clinicId, type: "reminder_gap", description: { contains: marker } }, select: { id: true } });
  if (already) return null;

  const report = await computeConfirmationGaps(rule, targetDate, now, tz, clinicRules);
  if (!report) return null;
  const hard = report.gaps.filter((g) => g.cause !== "reposicao_pendente");
  if (report.gaps.length === 0) return report;

  const byCause = new Map<GapCause, number>();
  for (const g of report.gaps) byCause.set(g.cause, (byCause.get(g.cause) ?? 0) + 1);
  const motivos = [...byCause].map(([c, n]) => `${n}× ${CAUSE_LABEL[c]}`).join("; ");
  const dia = formatDayInZone(new Date(Date.UTC(y, m - 1, d, 15)), tz);
  const text = `⚠️ Confirmação de ${dia}: ${report.gaps.length} agendamento(s) ainda sem a solicitação de confirmação depois do fim da janela (${motivos}). Nada foi enviado fora da janela para compensar; confira a prévia em Lembretes e decida se a equipe confirma por outro meio.`;
  await logActivity({ clinicId: rule.clinicId, type: "reminder_gap", area: "automacoes", title: "Confirmações sem a solicitação depois da janela", description: `${text.replace(/^⚠️ /, "")} ${marker}`, actorName: null });
  if (hard.length) await notifyStaff(rule.clinicId, "automation_failed", text).catch(() => undefined);
  return report;
}

// ALERTA DE CAPACIDADE: o que ainda esta pendente cabe nas rodadas que restam? (cron de 15 em 15 min, `perRun` envios por rodada.) Se nao cabe, a equipe e avisada UMA vez por regra e por dia
// (Diario + aviso), antes de o prazo acabar: ampliar a janela NAO acelera o envio, entao o aviso e o que permite agir a tempo (aumentar o teto, chamar a recuperacao, confirmar por outro meio).
export async function alertCapacityRisk(rule: ReminderRule, pending: number, perRun: number, ext: ExtensionCtx | null, windowEnd: Date | null, sampleStart: Date | null, now: Date, tz: string): Promise<void> {
  if (pending <= 0 || perRun <= 0) return;
  const normalEnd = windowEnd && windowEnd.getTime() > now.getTime() ? windowEnd : null;
  const wEnd0 = sampleStart ? normalWindowEnd(rule, sampleStart, tz) : null;
  const finalDeadline = ext?.allowed && wEnd0 && sampleStart ? extendedDeadline(ext.policy, { windowEnd: wEnd0, appointmentStart: sampleStart, timeZone: tz }) : null;
  const deadline = finalDeadline ?? normalEnd;
  if (!deadline || deadline.getTime() <= now.getTime()) return;
  const runsLeft = Math.max(1, Math.floor((deadline.getTime() - now.getTime()) / (15 * 60_000)));
  const capacity = runsLeft * perRun;
  if (pending <= capacity) return;
  const day = isoDateInZone(now, tz);
  const marker = `[capacidade:${rule.id}:${day}:${finalDeadline ? "final" : "normal"}]`;
  const already = await prisma.activityLog.findFirst({ where: { clinicId: rule.clinicId, type: "dispatch_capacity_risk", description: { contains: marker } }, select: { id: true } });
  if (already) return;
  const text = finalDeadline
    ? `⚠️ ${pending} mensagem(ns) elegível(is) ainda pendente(s) e só cabem ${capacity} até o prazo final (${deadline.toISOString()}). Abra a aba Disparos para recuperar/priorizar ou confirme por outro meio.`
    : `⚠️ ${pending} mensagem(ns) elegível(is) pendente(s): a janela normal comporta ${capacity}. O restante será ampliado só se houver causa operacional e a política permitir; confira a aba Disparos.`;
  await logActivity({ clinicId: rule.clinicId, type: "dispatch_capacity_risk", area: "automacoes", title: "Capacidade de envio em risco", description: `${text.replace(/^⚠️ /, "")} ${marker}`, actorName: null });
  await notifyStaff(rule.clinicId, "automation_failed", text).catch(() => undefined);
}
