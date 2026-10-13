import { scheduleLocked } from "../jobs/lock.js";
import { prisma } from "../db/client.js";
import { PAID_CLINIC_WHERE } from "./plan.js";
import { getFunnelStages } from "./stages.js";
import { logActivity } from "./activity.js";
import { notifyStaff } from "./notify.js";
import { wallClockInZone, zonedWallClockToUtc } from "../scheduling/time.js";

// ---------------------------------------------------------------------------
// REATIVACAO MENSAL DE LEADS (pedido da Lisboa): no dia X de cada mes (Clinic.leadReactivationDay) o sistema cria sozinho a
// campanha "Leads do mes" com o texto da clinica (Clinic.leadReactivationMessage) para TODOS os leads que entraram neste mes
// e ainda nao agendaram nem compraram. O envio e o das Mensagens programadas: aos poucos, com pausa, so em dia/horario de
// atendimento, e da pra cancelar la antes de comecar (a campanha e criada de madrugada e sai as 10h).
//
// Quem entra: criado neste mes, sem agendamento (confirmado/concluido/falta), fora das etapas de venda ganha, nao
// removido do CRM, sem pedido pra parar (optedOut), sem "sem interesse", sem retorno combinado pra mais tarde e sem
// conversa nos ultimos 24h (nao interrompe quem esta falando agora). Se o texto usa {procedimento}, so quem tem
// interesse conhecido (a Alice anota no resumo do CRM) - sem isso o texto ficaria sem sentido.
// ---------------------------------------------------------------------------

export const MONTH_LEADS_MODE = "month_leads";
export const SEND_HOUR = 10; // hora local em que a campanha comeca a sair
const RECENT_CONVERSATION_MS = 24 * 3_600_000;

// Primeiro interesse conhecido ("botox, preenchimento" -> "botox").
export function firstInterest(note: string | null | undefined): string {
  return (note ?? "").split(",")[0]?.trim() ?? "";
}

export function monthStartUtc(timeZone: string, now = new Date()): Date {
  const wc = wallClockInZone(now, timeZone);
  return zonedWallClockToUtc(timeZone, wc.year, wc.month, 1, 0, 0);
}

export function campaignTitle(timeZone: string, now = new Date()): string {
  const wc = wallClockInZone(now, timeZone);
  return `Leads do mês — ${String(wc.month).padStart(2, "0")}/${wc.year}`;
}

// PURO: hoje e o dia da campanha (ou o dia seguinte, pra recuperar um dia em que o servidor ficou fora)?
export function isReactivationWindow(now: Date, day: number, timeZone: string): boolean {
  const d = wallClockInZone(now, timeZone).day;
  return d === day || d === day + 1;
}

// PURO: quando a campanha comeca - 10h de hoje (hora da clinica), ou agora se ja passou das 10h.
export function reactivationStart(now: Date, timeZone: string): Date {
  const wc = wallClockInZone(now, timeZone);
  const at = zonedWallClockToUtc(timeZone, wc.year, wc.month, wc.day, SEND_HOUR, 0);
  return at.getTime() > now.getTime() ? at : now;
}

export async function monthLeadRecipients(clinicId: string, needsInterest: boolean, now = new Date()): Promise<string[]> {
  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { timezone: true } });
  const tz = clinic?.timezone || "America/Sao_Paulo";
  const stages = await getFunnelStages(clinicId);
  const wonStageIds = stages.filter((s) => s.kind === "ganho").map((s) => s.stageId);

  const leads = await prisma.patient.findMany({
    where: {
      clinicId,
      createdAt: { gte: monthStartUtc(tz, now) },
      optedOut: false,
      noInterest: false,
      crmHidden: false,
      ...(wonStageIds.length ? { funnelStage: { notIn: wonStageIds } } : {}),
      // quem ja agendou (ou foi e faltou) nao e "lead que nao agendou"; cancelado conta como nao agendado
      appointments: { none: { status: { in: ["confirmed", "completed", "no_show"] } } },
      OR: [{ callbackAt: null }, { callbackAt: { lte: now } }],
    },
    select: { id: true, interestNote: true, conversations: { select: { lastMessageAt: true }, orderBy: { lastMessageAt: "desc" }, take: 1 } },
    take: 5000,
  });

  return leads
    .filter((p) => {
      const last = p.conversations[0]?.lastMessageAt;
      if (last && now.getTime() - last.getTime() < RECENT_CONVERSATION_MS) return false; // esta conversando agora
      if (needsInterest && !firstInterest(p.interestNote)) return false;
      return true;
    })
    .map((p) => p.id);
}

// Cria a campanha do mes (uma vez por mes e por clinica) nas clinicas que configuraram o dia e o texto.
export async function runLeadReactivationJob(now = new Date()): Promise<number> {
  const clinics = await prisma.clinic.findMany({
    where: { ...PAID_CLINIC_WHERE, active: true, aliceActive: true, leadReactivationDay: { not: null }, NOT: { leadReactivationMessage: null } },
    select: { id: true, name: true, timezone: true, leadReactivationDay: true, leadReactivationMessage: true },
  });
  let created = 0;
  for (const clinic of clinics) {
    const tz = clinic.timezone || "America/Sao_Paulo";
    const day = clinic.leadReactivationDay!;
    const message = clinic.leadReactivationMessage?.trim();
    if (!message || !isReactivationWindow(now, day, tz)) continue;

    const title = campaignTitle(tz, now);
    const already = await prisma.broadcastCampaign.findFirst({ where: { clinicId: clinic.id, targetMode: MONTH_LEADS_MODE, title }, select: { id: true } });
    if (already) continue;

    const needsInterest = /\{procedimento\}/i.test(message);
    const preview = (await monthLeadRecipients(clinic.id, needsInterest, now)).length;
    const startsAt = reactivationStart(now, tz);
    await prisma.broadcastCampaign.create({
      data: {
        clinicId: clinic.id,
        title,
        message,
        targetMode: MONTH_LEADS_MODE,
        scheduledFor: startsAt,
        // sem ninguem pra receber hoje: ja nasce concluida (nao fica "enviando" pra sempre)
        status: preview === 0 ? "completed" : "scheduled",
      },
    });
    await logActivity({
      clinicId: clinic.id,
      type: "broadcast_scheduled",
      area: "automacoes",
      title: "Campanha mensal de leads criada",
      description: `${title}: ${preview} lead(s) que entraram este mês e ainda não agendaram nem compraram.`,
      actorName: null,
    });
    if (preview > 0) {
      await notifyStaff(
        clinic.id,
        "daily_report",
        `📣 A campanha "${title}" vai sair hoje a partir das ${String(wallClockInZone(startsAt, tz).hour).padStart(2, "0")}h para ~${preview} lead(s) que entraram este mês e ainda não agendaram nem compraram. O envio é aos poucos, só no horário de atendimento. Para cancelar: Personalizar Alice → Mensagens programadas.`,
      );
    }
    created++;
  }
  return created;
}

export function startLeadReactivationJob(): void {
  scheduleLocked("reativacao-mensal-leads", "*/30 * * * *", () => runLeadReactivationJob().catch((err) => console.error("Erro na reativacao mensal de leads:", err)));
}
