import cron from "node-cron";
import { prisma } from "../db/client.js";
import { sendText } from "../uazapi/client.js";
import { renderMessageTemplate, getClinicTemplateInfo } from "../crm/template.js";
import { PAID_CLINIC_WHERE } from "../crm/plan.js";
import { recordAutomatedMessage } from "../crm/conversationLog.js";
import { isoDateInZone, zonedWallClockToUtc } from "../scheduling/time.js";

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

// Roda a cada 15min. Cada regra ativa dispara uma vez por agendamento (marca
// em ReminderSent) - assim da pra ter mais de uma regra (ex: 24h antes e 2h
// antes) sem mandar a mesma coisa duas vezes nem perder uma por causa da outra.
export function startReminderJob(): void {
  cron.schedule("*/15 * * * *", async () => {
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

      const candidates = await prisma.appointment.findMany({
        where: {
          clinicId: rule.clinicId,
          status: "confirmed",
          scheduledAt: { gt: now, lte: new Date(Math.max(target.getTime() + 8 * 3_600_000, now.getTime() + 54 * 3_600_000)) },
          reminders: { none: { ruleId: rule.id } },
        },
        include: { patient: true, procedure: true, professional: true },
      });
      const due = candidates.filter((appt) => {
        if (rule.dayOffset != null && rule.sendHour != null && rule.sendEndHour != null) {
          return inReminderWindow(appt.scheduledAt, now, { dayOffset: rule.dayOffset, sendHour: rule.sendHour, sendMinute: rule.sendMinute, sendEndHour: rule.sendEndHour }, tz);
        }
        const sendAt =
          rule.dayOffset != null && rule.sendHour != null
            ? fixedReminderTime(appt.scheduledAt, rule.dayOffset, rule.sendHour, rule.sendMinute, tz)
            : reminderSendTime(appt.scheduledAt, rule.hoursBefore, tz);
        const late = now.getTime() - sendAt.getTime();
        // Dentro da janela estreita apos o horario previsto E ainda antes da consulta.
        return late >= 0 && late <= SEND_TOLERANCE_MS;
      });

      if (due.length === 0) continue;
      due.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime()); // quem atende primeiro recebe primeiro
      if (rule.sendEndHour != null) due.splice(MAX_SENDS_PER_RUN); // o resto fica pra proxima rodada (15 min)

      if (!clinicInfoCache.has(rule.clinicId)) {
        clinicInfoCache.set(rule.clinicId, await getClinicTemplateInfo(rule.clinicId));
      }
      const clinicInfo = clinicInfoCache.get(rule.clinicId)!;

      for (const appt of due) {
        const text = renderMessageTemplate(rule.message, {
          patientName: appt.patient.name,
          patientPhone: appt.patient.phone,
          clinicName: clinicInfo.name,
          locationName: clinicInfo.primaryLocation?.name,
          locationAddress: clinicInfo.primaryLocation?.fullAddress,
          procedureName: appt.procedure.name,
          professionalName: appt.professional?.name,
          when: appt.scheduledAt,
        });

        try {
          await sendText(appt.clinicId, appt.patient.phone, text);
          await prisma.reminderSent.create({ data: { appointmentId: appt.id, ruleId: rule.id } });
          await recordAutomatedMessage(appt.patientId, text, "Lembrete de consulta");
        } catch (err) {
          console.error(`Falha ao enviar lembrete (regra ${rule.id}) para ${appt.patient.phone}:`, err);
        }
        if (rule.sendEndHour != null) await sleep((rule.pauseMinSec + Math.random() * Math.max(0, rule.pauseMaxSec - rule.pauseMinSec)) * 1000);
      }
    }
    } finally {
      reminderRunning = false;
    }
  });
}
