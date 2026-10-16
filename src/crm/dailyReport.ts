import { scheduleLocked } from "../jobs/lock.js";
import { prisma } from "../db/client.js";
import { PAID_CLINIC_WHERE } from "./plan.js";
import { notifyStaff } from "./notify.js";
import { wallClockInZone, zonedWallClockToUtc } from "../scheduling/time.js";
import { ALICE_BOOKING_SOURCES } from "./realStats.js";
import { aliceReport, marketingReport } from "./insights.js";
import { firstOfDayIds } from "../reminders/firstOfDay.js";

// ---------------------------------------------------------------------------
// RELATORIO DIARIO + AUDITORIA DAS AUTOMACOES (20h, no WhatsApp interno da clinica, evento "daily_report").
// Mostra o dia (contatos, agendamentos, cancelamentos), a agenda de amanha (quem ainda nao confirmou) e a AUDITORIA: dos
// agendamentos de amanha, a quantos a confirmacao foi realmente enviada e quem ficou de fora (e por que). Na segunda-feira
// inclui as campanhas com muitos contatos e poucos agendamentos.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 3_600_000;

function dayBounds(tz: string, offsetDays: number): { from: Date; to: Date } {
  const wc = wallClockInZone(new Date(Date.now() + offsetDays * DAY_MS), tz);
  const from = zonedWallClockToUtc(tz, wc.year, wc.month, wc.day, 0, 0);
  return { from, to: new Date(from.getTime() + DAY_MS) };
}

export interface AuditRow {
  patient: string;
  phone: string;
  startsAt: Date;
  confirmationSent: boolean;
  problems: string[];
}

// Agendamentos CONFIRMADOS de um dia, com: a confirmacao do dia anterior saiu? se nao, por que provavelmente.
export async function confirmationAudit(clinicId: string, from: Date, to: Date): Promise<AuditRow[]> {
  const [rules, appts] = await Promise.all([
    // regras de confirmacao do dia anterior (a "mae"; a cobranca de quem nao confirmou nao conta como confirmacao)
    prisma.reminderRule.findMany({ where: { clinicId, active: true, dayOffset: 1, parentRuleId: null }, select: { id: true } }),
    prisma.appointment.findMany({
      where: { clinicId, status: "confirmed", scheduledAt: { gte: from, lt: to } },
      orderBy: { scheduledAt: "asc" },
      include: { patient: true, reminders: { select: { ruleId: true } } },
    }),
  ]);
  const ruleIds = new Set(rules.map((r) => r.id));
  // Quem tem varios horarios no dia recebe UMA confirmacao (a do primeiro horario): os demais contam como cobertos.
  const clinicRow = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { timezone: true } });
  const firstIds = firstOfDayIds(appts, clinicRow?.timezone || "America/Sao_Paulo");
  return appts.map((a) => {
    const digits = a.patient.phone.replace(/\D/g, "");
    const problems: string[] = [];
    if (a.patient.optedOut) problems.push("pediu para não receber mensagens");
    if (!/^55\d{10,11}$/.test(digits)) problems.push("telefone fora do padrão");
    return {
      patient: a.patient.name ?? a.patient.phone,
      phone: a.patient.phone,
      startsAt: a.scheduledAt,
      confirmationSent: ruleIds.size === 0 || !firstIds.has(a.id) ? true : a.reminders.some((r) => ruleIds.has(r.ruleId)),
      problems,
    };
  });
}

// PURO: uma linha por regra de recontato ativa, dizendo QUANDO ela dispara (horario fixo do dia seguinte x silencio corrido). Foi
// assim que o "recontato das 8h" que nao saiu ficou invisivel: ninguem via qual regra estava de fato com horario fixo.
export function followUpRuleLines(
  rules: { order: number; name: string; afterMinutes: number; afterDays: number; nextDayHour: number | null }[],
): string[] {
  return rules.map((r) => {
    const when = r.nextDayHour != null
      ? `dia seguinte às ${r.nextDayHour}h`
      : `${r.afterMinutes > 0 ? (r.afterMinutes % 1440 === 0 ? `${r.afterMinutes / 1440} dia(s)` : r.afterMinutes % 60 === 0 ? `${r.afterMinutes / 60}h` : `${r.afterMinutes} min`) : `${r.afterDays} dia(s)`} de silêncio`;
    return `   - ${r.name} (${when})`;
  });
}

export async function buildDailyReport(clinicId: string, tz: string): Promise<string | null> {
  const today = dayBounds(tz, 0);
  const tomorrow = dayBounds(tz, 1);

  const [newContacts, createdToday, cancelledToday, noShowToday, audit, hot, tomorrowAppts, failures] = await Promise.all([
    prisma.patient.count({ where: { clinicId, createdAt: { gte: today.from, lt: today.to } } }),
    prisma.appointment.findMany({ where: { clinicId, createdAt: { gte: today.from, lt: today.to } }, select: { source: true } }),
    prisma.activityLog.count({ where: { clinicId, type: "appointment_cancelled", createdAt: { gte: today.from, lt: today.to } } }),
    prisma.appointment.count({ where: { clinicId, status: "no_show", scheduledAt: { gte: today.from, lt: today.to } } }),
    confirmationAudit(clinicId, tomorrow.from, tomorrow.to),
    prisma.patient.count({
      where: {
        clinicId, optedOut: false, noInterest: false,
        OR: [{ askedPriceAt: { gte: new Date(Date.now() - DAY_MS) } }, { askedInstallmentsAt: { gte: new Date(Date.now() - DAY_MS) } }, { askedScheduleAt: { gte: new Date(Date.now() - DAY_MS) } }],
        appointments: { none: { status: "confirmed", scheduledAt: { gte: new Date() } } },
      },
    }),
    // todos os de amanha (o filtro "quem ainda nao confirmou" e feito depois, so no PRIMEIRO horario de cada pessoa)
    prisma.appointment.findMany({
      where: { clinicId, status: "confirmed", scheduledAt: { gte: tomorrow.from, lt: tomorrow.to } },
      include: { patient: { select: { name: true, phone: true } } },
      orderBy: { scheduledAt: "asc" },
    }),
    prisma.message.count({
      where: { role: "assistant", deliveryStatus: { in: ["failed", "failed_permanent"] }, createdAt: { gte: today.from, lt: today.to }, conversation: { patient: { clinicId } } },
    }),
  ]);

  const byAlice = createdToday.filter((a) => (ALICE_BOOKING_SOURCES as readonly string[]).includes(a.source ?? "")).length;
  const missing = audit.filter((a) => !a.confirmationSent);
  // "Sem resposta de confirmacao": so o primeiro horario do dia de cada pessoa (a confirmacao e uma so por dia).
  const firstTomorrow = firstOfDayIds(tomorrowAppts, tz);
  const unconfirmed = tomorrowAppts.filter((a) => firstTomorrow.has(a.id) && !a.patientConfirmed);
  const lines: string[] = [
    "📊 *Resumo do dia*",
    `• Contatos novos: ${newContacts}`,
    `• Agendamentos criados hoje: ${createdToday.length} (${byAlice} pela Alice)`,
    `• Cancelamentos: ${cancelledToday} · Faltas: ${noShowToday}`,
    `• Leads quentes sem agendamento: ${hot}`,
    "",
    `📅 *Amanhã*: ${audit.length} agendamento(s)`,
    `• Confirmação enviada: ${audit.length - missing.length} de ${audit.length}`,
  ];
  if (missing.length) {
    lines.push(`• ⚠️ SEM confirmação enviada (${missing.length}):`);
    for (const m of missing.slice(0, 8)) lines.push(`   - ${m.patient}${m.problems.length ? ` (${m.problems.join(", ")})` : ""}`);
    if (missing.length > 8) lines.push(`   …e mais ${missing.length - 8}.`);
    lines.push("   Confirme com essas pacientes manualmente.");
  }
  if (unconfirmed.length) {
    lines.push(`• Ainda sem resposta de confirmação: ${unconfirmed.length}`);
    for (const u of unconfirmed.slice(0, 6)) lines.push(`   - ${u.patient.name ?? u.patient.phone}`);
    if (unconfirmed.length > 6) lines.push(`   …e mais ${unconfirmed.length - 6}.`);
  }
  // Recontatos: o que esta ligado, quando dispara e quantos sairam hoje (pedido da Lisboa 15/10: o recontato das 8h precisa aparecer na auditoria).
  const [followRules, followSent] = await Promise.all([
    prisma.followUpRule.findMany({ where: { clinicId, active: true }, orderBy: { order: "asc" }, select: { order: true, name: true, afterMinutes: true, afterDays: true, nextDayHour: true } }),
    prisma.message.findMany({ where: { role: "assistant", authorName: "Recontato automático", createdAt: { gte: today.from, lt: today.to }, conversation: { patient: { clinicId } } }, select: { id: true } }),
  ]);
  // Conversas paradas com a equipe: a Alice NAO recontata conversa em atendimento humano (transferida em silencio e ninguem respondeu). Era
  // um jeito de "o recontato nao saiu" sem ninguem ver: agora aparece aqui, com nome.
  const waitingStaff = await prisma.conversation.findMany({
    where: {
      patient: { clinicId, optedOut: false },
      humanTakeover: true,
      handoffPending: true,
      status: { in: ["active", "qualified", "scheduled"] },
      lastMessageAt: { lt: new Date(Date.now() - 12 * 3_600_000), gt: new Date(Date.now() - 7 * DAY_MS) },
    },
    select: { patient: { select: { name: true, phone: true } }, handoffReason: true },
    orderBy: { lastMessageAt: "desc" },
    take: 30,
  });
  if (waitingStaff.length) {
    lines.push("", `⏳ *Esperando a equipe há mais de 12h*: ${waitingStaff.length} conversa(s) (a Alice não recontata estas)`);
    for (const w of waitingStaff.slice(0, 5)) lines.push(`   - ${w.patient.name ?? w.patient.phone}${w.handoffReason ? ` (${w.handoffReason.slice(0, 40)})` : ""}`);
    if (waitingStaff.length > 5) lines.push(`   …e mais ${waitingStaff.length - 5}.`);
  }
  if (followRules.length) lines.push("", `🔁 *Recontatos*: ${followSent.length} enviado(s) hoje`, ...followUpRuleLines(followRules));
  if (failures) lines.push("", `⚠️ ${failures} resposta(s) da Alice não foram entregues hoje (o sistema tenta de novo).`);

  // Segunda-feira: qualidade da semana + campanhas com baixa conversao
  if (wallClockInZone(new Date(), tz).weekday === 1) {
    const weekStart = new Date(Date.now() - 7 * DAY_MS);
    const [alice, mkt] = await Promise.all([aliceReport(clinicId, weekStart, new Date()), marketingReport(clinicId, new Date(Date.now() - 14 * DAY_MS), new Date())]);
    lines.push("", "🗓️ *Semana*", `• Agendados pela Alice: ${alice.bookings.total} (${alice.bookings.confirmedByPatient} confirmaram, ${alice.bookings.completed} compareceram)`, `• Transferências para a equipe: ${alice.handoffs.total}`);
    for (const r of alice.handoffs.byReason.slice(0, 3)) lines.push(`   - ${r.reason}: ${r.count}`);
    const low = mkt.campaigns.filter((c) => c.lowConversion);
    if (low.length) {
      lines.push("", "📉 *Campanhas com muitos contatos e poucos agendamentos (14 dias):*");
      for (const c of low.slice(0, 4)) lines.push(`• ${c.origin}: ${c.leads} contatos, ${c.scheduled} agendados (${c.scheduledRate}%)`);
      lines.push("Vale revisar oferta e abordagem.");
    }
  }
  return lines.join("\n");
}

export async function runDailyReport(): Promise<number> {
  const clinics = await prisma.clinic.findMany({
    where: { ...PAID_CLINIC_WHERE, active: true, notifyPhone: { not: null } },
    select: { id: true, timezone: true, notifyEvents: true },
  });
  let sent = 0;
  for (const c of clinics) {
    if (!c.notifyEvents.split(",").map((e) => e.trim()).includes("daily_report")) continue;
    try {
      const text = await buildDailyReport(c.id, c.timezone || "America/Sao_Paulo");
      if (text) {
        await notifyStaff(c.id, "daily_report", text);
        sent++;
      }
    } catch (err) {
      console.error(`[relatorio diario] clinica ${c.id} falhou:`, err);
    }
  }
  return sent;
}

export function startDailyReportJob(): void {
  scheduleLocked("relatorio-diario", "0 20 * * *", () => runDailyReport().catch((err) => console.error("Erro no relatorio diario:", err)), { timezone: "America/Sao_Paulo" });
}
