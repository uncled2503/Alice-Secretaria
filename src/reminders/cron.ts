import { scheduleLocked } from "../jobs/lock.js";
import { prisma } from "../db/client.js";
import { sendText, isPermanentSendError } from "../uazapi/client.js";
import { renderMessageTemplate, getClinicTemplateInfo } from "../crm/template.js";
import { PAID_CLINIC_WHERE } from "../crm/plan.js";
import type { ReminderRule } from "@prisma/client";
import { recordAutomatedMessage } from "../crm/conversationLog.js";
import { isoDateInZone, zonedWallClockToUtc } from "../scheduling/time.js";
import { localDayBounds } from "./firstOfDay.js";
import { classifyReminder } from "../maintenance/restoreReminders.js";
import { verifyBookingLive, applyLiveVerdict } from "../clinicaexperts/liveCheck.js";
import { stripProcedureLines, isPlaceholderProcedure } from "../clinicaexperts/placeholderProcedure.js";

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
  appt: { scheduledAt: Date; createdAt: Date },
  w: { dayOffset: number; sendEndHour: number },
  now: Date,
  timeZone: string,
): boolean {
  if (w.dayOffset < 1) return false;
  const windowEnd = fixedReminderTime(appt.scheduledAt, w.dayOffset, w.sendEndHour, 0, timeZone).getTime();
  if (appt.createdAt.getTime() < windowEnd) return false; // criado a tempo: vale so a janela normal
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
const MAX_SENDS_PER_RUN = 12;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let reminderRunning = false;

// Quem deve receber esta regra AGORA (sem enviar nada): janela/horario, status,
// "ainda nao recebeu" e, nas regras de cobranca, "nao confirmou nem respondeu".
export async function selectDueAppointments(rule: ReminderRule, now: Date, tz: string) {
  const target = new Date(now.getTime() + rule.hoursBefore * 60 * 60_000);
  const candidates = await prisma.appointment.findMany({
    where: {
      clinicId: rule.clinicId,
      status: "confirmed",
      scheduledAt: { gt: now, lte: new Date(Math.max(target.getTime() + 8 * 3_600_000, now.getTime() + 54 * 3_600_000)) },
      // Regra de "nao confirmou": so quem recebeu a regra-mae e ainda nao confirmou.
      ...(rule.parentRuleId
        ? { patientConfirmed: false, AND: [{ reminders: { none: { ruleId: rule.id } } }, { reminders: { some: { ruleId: rule.parentRuleId } } }] }
        : { reminders: { none: { ruleId: rule.id } } }),
    },
    include: { patient: true, procedure: true, professional: true, reminders: { where: { ruleId: rule.parentRuleId ?? "-" }, select: { sentAt: true } } },
  });
  const lateIds = new Set<string>();
  let due = candidates.filter((appt) => {
    if (rule.dayOffset != null && rule.sendHour != null && rule.sendEndHour != null) {
      if (inReminderWindow(appt.scheduledAt, now, { dayOffset: rule.dayOffset, sendHour: rule.sendHour, sendMinute: rule.sendMinute, sendEndHour: rule.sendEndHour }, tz)) return true;
      // reposicao pra quem foi agendado depois da janela (regra-filha nao repoe: so cobra quem recebeu a mae)
      if (!rule.parentRuleId && isLateCatchUp(appt, { dayOffset: rule.dayOffset, sendEndHour: rule.sendEndHour }, now, tz)) {
        lateIds.add(appt.id);
        return true;
      }
      return false;
    }
    const sendAt =
      rule.dayOffset != null && rule.sendHour != null
        ? fixedReminderTime(appt.scheduledAt, rule.dayOffset, rule.sendHour, rule.sendMinute, tz)
        : reminderSendTime(appt.scheduledAt, rule.hoursBefore, tz);
    const late = now.getTime() - sendAt.getTime();
    // Dentro da janela estreita apos o horario previsto E ainda antes da consulta.
    return late >= 0 && late <= SEND_TOLERANCE_MS;
  });

  // Reposicao so pra quem NAO recebeu nada desde que foi agendado: se a propria Alice (conversa) ou o painel ja
  // confirmou o horario com a pessoa, outra "confirmacao" logo em seguida seria repeticao.
  if (lateIds.size) {
    const keep: typeof due = [];
    for (const appt of due) {
      if (!lateIds.has(appt.id)) { keep.push(appt); continue; }
      const sinceBooking = await prisma.message.count({ where: { role: "assistant", createdAt: { gte: appt.createdAt }, conversation: { patientId: appt.patientId } } });
      if (sinceBooking === 0) keep.push(appt);
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
    }
    due = first;
  }

  if (rule.parentRuleId) {
    // Quem respondeu algo depois da confirmacao nao e cobrado de novo.
    const silent: typeof due = [];
    for (const appt of due) {
      const sentAt = appt.reminders[0]?.sentAt;
      if (!sentAt) continue;
      if (now.getTime() - sentAt.getTime() < CHILD_MIN_GAP_MS) continue;
      const replies = await prisma.message.count({ where: { role: "user", createdAt: { gt: sentAt }, conversation: { patientId: appt.patientId } } });
      if (replies === 0) silent.push(appt);
    }
    due = silent;
  }


  return due;
}

// Roda a cada 15min. Cada regra ativa dispara uma vez por agendamento (marca
// em ReminderSent) - assim da pra ter mais de uma regra (ex: 24h antes e 2h
// antes) sem mandar a mesma coisa duas vezes nem perder uma por causa da outra.
export function startReminderJob(): void {
  scheduleLocked("lembretes", "*/15 * * * *", async () => {
    if (reminderRunning) return; // rodada anterior (com pausas) ainda em andamento
    reminderRunning = true;
    try {
    const loaded = await prisma.reminderRule.findMany({ where: { active: true, clinic: PAID_CLINIC_WHERE } });
    const rules: typeof loaded = [];
    for (const r of loaded) {
      const change = dueScheduledChange(r.scheduledChange, new Date());
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
      const now = new Date();
      const target = new Date(now.getTime() + rule.hoursBefore * 60 * 60_000);
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

      const due = await selectDueAppointments(rule, now, tz);

      if (due.length === 0) continue;
      due.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime()); // quem atende primeiro recebe primeiro
      if (rule.sendEndHour != null) due.splice(MAX_SENDS_PER_RUN); // o resto fica pra proxima rodada (15 min)

      if (!clinicInfoCache.has(rule.clinicId)) {
        clinicInfoCache.set(rule.clinicId, await getClinicTemplateInfo(rule.clinicId));
      }
      const clinicInfo = clinicInfoCache.get(rule.clinicId)!;

      for (const appt of due) {
        // Confere no Clinica Experts ANTES de mandar: cancelado/apagado/trocado la = a copia daqui estava velha (16/10: quem cancelou ou
        // remarcou continuava recebendo a confirmacao). Cancela/corrige aqui e nao manda.
        if (appt.ceBookingUuid) {
          const verdict = await verifyBookingLive(appt, tz);
          if (await applyLiveVerdict(appt, verdict, appt.patient.name ?? appt.patient.phone)) continue;
        }
        const noProcedure = isPlaceholderProcedure(appt.procedure);
        const text = renderMessageTemplate(noProcedure ? stripProcedureLines(rule.message) : rule.message, {
          patientName: appt.patient.name,
          patientPhone: appt.patient.phone,
          clinicName: clinicInfo.name,
          locationName: clinicInfo.primaryLocation?.name,
          locationAddress: clinicInfo.primaryLocation?.fullAddress,
          procedureName: noProcedure ? "seu atendimento" : appt.procedure.name,
          professionalName: appt.professional?.name,
          when: appt.scheduledAt,
        });

        // Duas regras IGUAIS (mesmo texto, mesmo horario) cadastradas por engano: se a irma
        // ja enviou este lembrete para este agendamento, esta nao envia de novo.
        // Alem de regras identicas, vale texto igual sem negrito e o mesmo TIPO de confirmacao ("hoje" / "amanha") nas ultimas 20h.
        const recentSiblings = await prisma.reminderSent.findMany({
          where: {
            appointmentId: appt.id,
            ruleId: { not: rule.id },
            sentAt: { gte: new Date(Date.now() - DUPLICATE_REMINDER_WINDOW_MS) },
            rule: { clinicId: rule.clinicId, parentRuleId: rule.parentRuleId },
          },
          select: { rule: { select: { message: true } } },
        });
        if (recentSiblings.some((x) => isSameReminderText(x.rule.message, rule.message))) continue;

        // RESERVA atomica antes de enviar (chave unica agendamento+regra): se outro
        // processo ja pegou, nao envia de novo.
        try {
          await prisma.reminderSent.create({ data: { appointmentId: appt.id, ruleId: rule.id } });
        } catch {
          continue;
        }
        try {
          const outcome = await sendText(appt.clinicId, appt.patient.phone, text);
          if (outcome === "sent") await recordAutomatedMessage(appt.patientId, text, "Lembrete de consulta");
        } catch (err) {
          console.error(`Falha ao enviar lembrete (regra ${rule.id}) para ${appt.patient.phone}:`, err);
          if (isPermanentSendError(err)) continue; // numero sem WhatsApp: mantem a reserva, nao insiste
          await prisma.reminderSent.deleteMany({ where: { appointmentId: appt.id, ruleId: rule.id } }); // devolve a reserva: tenta de novo
        }
        if (rule.sendEndHour != null) await sleep((rule.pauseMinSec + Math.random() * Math.max(0, rule.pauseMaxSec - rule.pauseMinSec)) * 1000);
      }
    }
    } finally {
      reminderRunning = false;
    }
  });
}
