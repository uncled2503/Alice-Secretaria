import type { ReminderRule } from "@prisma/client";
import { prisma } from "../db/client.js";
import { PAID_CLINIC_WHERE } from "../crm/plan.js";
import { renderMessageTemplate, getClinicTemplateInfo } from "../crm/template.js";
import { connectionNotice } from "../uazapi/client.js";
import { isPlaceholderProcedure, stripProcedureLines } from "../clinicaexperts/placeholderProcedure.js";
import { isoDateInZone } from "../scheduling/time.js";
import { CHILD_MIN_GAP_MS, isLateCatchUp, ruleWindow } from "./cron.js";
import { firstOfDayIds, localDayBounds } from "./firstOfDay.js";
import { bookingKeyOf, dispatchKind } from "./ledger.js";
import { formatWeekdays, overridingRule, ruleAppliesOnWeekday, skipsConfirmedPatient, weekdayInZone } from "./policy.js";
import { notYetEffectuated } from "./effectuation.js";

// ---------------------------------------------------------------------------
// PREVIA DOS LEMBRETES (somente leitura). Mostra, por reserva e por regra, o que sera enviado, quando e por que (ou por que NAO). Usa as MESMAS funcoes do envio (ruleWindow,
// isLateCatchUp, firstOfDayIds, dispatchKind, controle persistente), entao a tela, a previa e o job nao podem divergir. NAO consulta o Clinica Experts, NAO envia nada e NAO grava nada.
// ---------------------------------------------------------------------------

export type PreviewStatus =
  | "enviado" // aceito pelo provedor (nao e "entregue": o provedor nao confirma entrega)
  | "enviado_sem_confirmacao" // pode ter saido; nunca reenviado
  | "em_envio"
  | "bloqueado" // bloqueado/vetado/duplicado: nao saiu
  | "falhou" // falha (definitiva ou esgotou tentativas) ou adiado
  | "vai_enviar" // dentro da janela e elegivel: sai na proxima rodada (a cada 15 min)
  | "aguarda_janela" // a janela ainda nao abriu
  | "aguarda_regra_mae" // cobranca: depende de a regra-mae ser enviada e da pessoa nao confirmar
  | "aguarda_conexao" // o WhatsApp da clinica esta fora do ar: sai se a janela ainda valer quando voltar
  | "janela_encerrada" // a janela fechou sem envio: NAO sera enviado depois (nada de lote atrasado)
  | "nao_se_aplica";

export interface PreviewMessage {
  ruleId: string;
  rule: string; // descricao curta da regra
  purpose: string; // dia_seguinte | do_dia | cobranca | outro
  status: PreviewStatus;
  reason: string;
  from: string | null; // ISO: inicio da janela planejada
  to: string | null;
  text?: string; // como o texto sairia (so para o que ainda vai sair)
}

export interface PreviewRow {
  appointmentId: string;
  startsAt: string;
  person: string;
  contactPhoneTail: string;
  procedure: string;
  ceLinked: boolean;
  patientConfirmed: boolean;
  cePresence: string | null;
  messages: PreviewMessage[];
}

export interface PreviewOverlap {
  appointmentId: string;
  a: string;
  b: string;
  kind: "mesma_janela" | "proximas";
  gapMin: number;
  control: string; // o que impede (ou nao) as duas de sairem
}

export interface ReminderPreview {
  generatedAt: string;
  day: "today" | "tomorrow";
  date: string;
  timezone: string;
  whatsapp: { paused: boolean; since: string | null; reason: string | null };
  blocked?: string;
  rules: { id: string; label: string; purpose: string; window: string; child: boolean }[];
  rows: PreviewRow[];
  overlaps: PreviewOverlap[];
  summary: Record<string, number>;
}

const hh = (d: Date, tz: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
const dd = (d: Date, tz: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: tz, day: "2-digit", month: "2-digit" }).format(d);

// Descricao da regra no vocabulario do painel.
export function describeRule(r: Pick<ReminderRule, "dayOffset" | "sendHour" | "sendMinute" | "sendEndHour" | "hoursBefore" | "parentRuleId"> & Partial<Pick<ReminderRule, "weekdays">>): string {
  const m = String(r.sendMinute ?? 0).padStart(2, "0");
  const days = r.weekdays ? ` — só atendimentos de ${formatWeekdays(r.weekdays)}` : "";
  if (r.dayOffset != null && r.sendHour != null) {
    const day = r.dayOffset === 1 ? "dia anterior" : r.dayOffset === 0 ? "no dia" : `${r.dayOffset} dias antes`;
    const win = r.sendEndHour != null ? `${r.sendHour}:${m}–${r.sendEndHour}:00` : `${r.sendHour}:${m}`;
    return `${day} ${win}${r.parentRuleId ? " (cobrança de quem não confirmou)" : ""}${days}`;
  }
  return `${r.hoursBefore}h antes${r.parentRuleId ? " (cobrança de quem não confirmou)" : ""}${days}`;
}

const HANDLED_OK = new Set(["sent"]);

// opts.appointmentId: "por que esta pessoa nao recebeu (ou nao vai receber)?" - avalia UMA reserva, de qualquer dia, com a mesma conta.
export async function previewReminders(clinicId: string, opts: { day?: "today" | "tomorrow"; now?: Date; appointmentId?: string } = {}): Promise<ReminderPreview> {
  const now = opts.now ?? new Date();
  const day = opts.day ?? "today";
  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { timezone: true } });
  const tz = clinic?.timezone || "America/Sao_Paulo";
  let probe = new Date(now.getTime() + (day === "tomorrow" ? 24 * 3_600_000 : 0));
  if (opts.appointmentId) {
    const one = await prisma.appointment.findFirst({ where: { id: opts.appointmentId, clinicId }, select: { scheduledAt: true } });
    if (one) probe = one.scheduledAt;
  }
  const { start, end } = localDayBounds(probe, tz);
  const date = isoDateInZone(probe, tz);
  const conn = await connectionNotice(clinicId);
  const base: ReminderPreview = {
    generatedAt: now.toISOString(), day, date, timezone: tz, whatsapp: { paused: conn.paused, since: conn.since, reason: conn.reason },
    rules: [], rows: [], overlaps: [], summary: {},
  };
  const paid = await prisma.clinic.count({ where: { id: clinicId, ...PAID_CLINIC_WHERE } });
  if (!paid) return { ...base, blocked: "plano gratuito: a Alice não envia lembretes" };

  const rules = await prisma.reminderRule.findMany({ where: { clinicId, active: true }, orderBy: [{ createdAt: "asc" }] });
  base.rules = rules.map((r) => ({ id: r.id, label: describeRule(r), purpose: dispatchKind(r), window: describeRule(r), child: !!r.parentRuleId }));
  const appts = await prisma.appointment.findMany({
    where: { clinicId, status: "confirmed", scheduledAt: { gte: start, lt: end } },
    orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
    include: { patient: true, attendee: true, procedure: true, professional: true, reminders: { select: { ruleId: true, sentAt: true } } },
    take: 300,
  });
  if (!appts.length || !rules.length) return base;

  const keys = appts.map(bookingKeyOf);
  const ledger = await prisma.reminderDispatch.findMany({ where: { clinicId, bookingKey: { in: keys } } });
  const firstIds = firstOfDayIds(appts, tz);
  const notEffectuated = await notYetEffectuated(appts);
  const info = await getClinicTemplateInfo(clinicId);
  const ruleById = new Map(rules.map((r) => [r.id, r]));

  const rows: PreviewRow[] = [];
  for (const a of appts) {
    if (opts.appointmentId && a.id !== opts.appointmentId) continue; // (a cobertura do dia usa todas as reservas da pessoa; so a pedida e exibida)
    const bookingKey = bookingKeyOf(a);
    const person = a.attendee?.name ?? a.patient.name ?? "(sem nome)";
    const myLedger = ledger.filter((l) => l.bookingKey === bookingKey && l.startsAt.getTime() === a.scheduledAt.getTime());
    const messages: PreviewMessage[] = [];
    for (const rule of rules) {
      const weekday = weekdayInZone(a.scheduledAt, tz);
      if (!ruleAppliesOnWeekday(rule, weekday)) continue; // regra de outro dia da semana: nao e desta reserva
      const win = ruleWindow(rule, a.scheduledAt, tz);
      const purpose = dispatchKind(rule);
      const out = (status: PreviewStatus, reason: string, withText = false): PreviewMessage => {
        const noProc = isPlaceholderProcedure(a.procedure);
        const text = withText
          ? renderMessageTemplate(noProc ? stripProcedureLines(rule.message) : rule.message, {
              patientName: a.attendee?.name ?? a.patient.name, patientPhone: a.patient.phone, clinicName: info.name, locationName: info.primaryLocation?.name,
              locationAddress: info.primaryLocation?.fullAddress, procedureName: noProc ? "seu atendimento" : a.procedure.name, professionalName: a.professional?.name, when: a.scheduledAt, timeZone: tz,
            })
          : undefined;
        return { ruleId: rule.id, rule: describeRule(rule), purpose, status, reason, from: win.from.toISOString(), to: win.to.toISOString(), ...(text ? { text } : {}) };
      };
      const own = myLedger.find((l) => l.ruleId === rule.id);
      if (own) {
        if (HANDLED_OK.has(own.state)) { messages.push(out("enviado", "aceito pelo provedor de WhatsApp (entrega não é confirmada pelo provedor)")); continue; }
        if (own.state === "unconfirmed") { messages.push(out("enviado_sem_confirmacao", "o envio não teve confirmação: pode ter saído e NÃO será reenviado")); continue; }
        if (own.state === "reserved") { messages.push(out("em_envio", "reservado para envio nesta rodada")); continue; }
        if (own.state === "blocked" || own.state === "vetoed" || own.state === "duplicate") { messages.push(out("bloqueado", `não saiu (${own.state}${own.detail ? `: ${own.detail}` : ""})`)); continue; }
        if (own.state === "failed_permanent" || own.state === "exhausted") { messages.push(out("falhou", `não saiu (${own.state}${own.detail ? `: ${own.detail}` : ""})`)); continue; }
        // deferred / failed: ainda pode tentar enquanto a janela valer (cai na avaliacao abaixo)
      } else if (a.reminders.some((r) => r.ruleId === rule.id)) { messages.push(out("enviado", "registro antigo de envio (anterior ao controle persistente)")); continue; }

      if (a.scheduledAt.getTime() <= now.getTime()) { messages.push(out("nao_se_aplica", "o atendimento já começou: nada é enviado depois do horário")); continue; }
      const specific = overridingRule(rule, weekday, rules);
      if (specific) { messages.push(out("nao_se_aplica", `neste dia da semana (${formatWeekdays(String(weekday))}) vale a regra específica "${describeRule(specific as ReminderRule)}", não esta: nunca as duas`)); continue; }
      if (!rule.parentRuleId && skipsConfirmedPatient(rule) && a.patientConfirmed) { messages.push(out("nao_se_aplica", "a pessoa já confirmou a presença: não recebe nova solicitação de confirmação")); continue; }
      if (notEffectuated.has(a.id)) { messages.push(out("bloqueado", `${notEffectuated.get(a.id)}: não é enviada como se o horário estivesse firmado`)); continue; }
      const sibling = myLedger.find((l) => l.ruleId !== rule.id && l.kind === purpose && ["reserved", "sent", "unconfirmed", "duplicate", "blocked", "vetoed"].includes(l.state));
      if (sibling) { messages.push(out("bloqueado", `outra regra do mesmo tipo (${purpose}) já tratou esta reserva (${sibling.state}): o controle de duplicidade impede o segundo envio`)); continue; }

      if (rule.parentRuleId) {
        const parentSent = a.reminders.find((r) => r.ruleId === rule.parentRuleId);
        if (a.patientConfirmed) { messages.push(out("nao_se_aplica", "o paciente já confirmou: cobrança não é enviada")); continue; }
        if (!parentSent) {
          const parent = ruleById.get(rule.parentRuleId);
          const parentOpen = parent ? ruleWindow(parent, a.scheduledAt, tz).to.getTime() > now.getTime() : false;
          messages.push(out(parentOpen ? "aguarda_regra_mae" : "nao_se_aplica", parentOpen ? "só será enviada se a regra-mãe for enviada e a pessoa não confirmar nem responder" : "a regra-mãe não foi enviada para esta reserva: não há o que cobrar"));
          continue;
        }
        if (now.getTime() - parentSent.sentAt.getTime() < CHILD_MIN_GAP_MS) { messages.push(out("aguarda_regra_mae", `a cobrança só sai pelo menos ${CHILD_MIN_GAP_MS / 3_600_000}h depois da mensagem-mãe e se a pessoa não responder`)); continue; }
        const replied = await prisma.message.count({ where: { role: "user", createdAt: { gt: parentSent.sentAt }, conversation: { patientId: a.patientId } } });
        if (replied > 0) { messages.push(out("nao_se_aplica", "a pessoa respondeu depois da mensagem-mãe: não é cobrada")); continue; }
      } else if (!firstIds.has(a.id)) {
        messages.push(out("nao_se_aplica", "coberto pela mensagem do primeiro horário do dia desta mesma pessoa (uma confirmação por pessoa por dia)"));
        continue;
      }

      const t = now.getTime();
      if (t < win.from.getTime()) { messages.push(out("aguarda_janela", `janela de envio ${hh(win.from, tz)}–${hh(win.to, tz)} de ${dd(win.from, tz)}`, true)); continue; }
      const inside = win.kind === "janela" ? t < win.to.getTime() : t <= win.to.getTime();
      if (inside) {
        messages.push(conn.paused ? out("aguarda_conexao", "o WhatsApp da clínica está fora do ar: sai se a janela ainda valer quando voltar", true) : out("vai_enviar", `dentro da janela ${hh(win.from, tz)}–${hh(win.to, tz)}; sai na próxima rodada (a cada 15 min)`, true));
        continue;
      }
      if (win.kind === "janela" && rule.dayOffset != null && rule.sendEndHour != null && !rule.parentRuleId && rule.purpose !== "lembrete" && isLateCatchUp(a, { dayOffset: rule.dayOffset, sendEndHour: rule.sendEndHour }, now, tz)) {
        messages.push(conn.paused ? out("aguarda_conexao", "reposição (agendado depois que a janela fechou): sai quando o WhatsApp voltar, entre 8h e 20h", true) : out("vai_enviar", "reposição: agendado depois que a janela do dia fechou; sai entre 8h e 20h, com 2h de folga antes do atendimento", true));
        continue;
      }
      messages.push(out("janela_encerrada", `a janela ${hh(win.from, tz)}–${hh(win.to, tz)} já fechou sem envio: não será enviado depois (sem lote atrasado)`));
    }
    rows.push({
      appointmentId: a.id, startsAt: a.scheduledAt.toISOString(), person, contactPhoneTail: a.patient.phone.slice(-4), procedure: a.procedure.name, ceLinked: !!a.ceBookingUuid,
      patientConfirmed: a.patientConfirmed, cePresence: a.cePresenceState, messages,
    });
  }

  // sobreposicao: duas mensagens que SAEM (ou sairiam) para a mesma reserva em janelas que se cruzam / com menos de 3 h entre si
  const overlaps: PreviewOverlap[] = [];
  const live = new Set<PreviewStatus>(["enviado", "enviado_sem_confirmacao", "em_envio", "vai_enviar", "aguarda_janela", "aguarda_regra_mae", "aguarda_conexao"]);
  for (const row of rows) {
    const list = row.messages.filter((m) => live.has(m.status) && m.from && m.to).sort((x, y) => Date.parse(x.from!) - Date.parse(y.from!));
    for (let i = 0; i + 1 < list.length; i++) {
      const x = list[i], y = list[i + 1];
      const gap = (Date.parse(y.from!) - Date.parse(x.to!)) / 60_000;
      const crossed = Date.parse(y.from!) < Date.parse(x.to!);
      if (!crossed && gap >= 180) continue;
      const sameKind = x.purpose === y.purpose;
      overlaps.push({
        appointmentId: row.appointmentId, a: x.rule, b: y.rule, kind: crossed ? "mesma_janela" : "proximas", gapMin: Math.round(crossed ? 0 : gap),
        control: sameKind ? `mesmo tipo (${x.purpose}): o controle de duplicidade deixa sair só UMA por dia; a segunda é bloqueada` : "tipos diferentes: as DUAS podem sair (nenhum controle as impede)",
      });
    }
  }

  const summary: Record<string, number> = {};
  for (const r of rows) for (const m of r.messages) summary[m.status] = (summary[m.status] ?? 0) + 1;
  return { ...base, rows, overlaps, summary };
}
