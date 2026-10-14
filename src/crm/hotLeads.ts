import { scheduleLocked } from "../jobs/lock.js";
import { prisma } from "../db/client.js";
import { PAID_CLINIC_WHERE } from "./plan.js";
import { isWithinClinicHours } from "./openHours.js";
import { notifyStaff } from "./notify.js";
import { sendText } from "../uazapi/client.js";
import { recordAutomatedMessage } from "./conversationLog.js";
import { describeSignals } from "./intent.js";

// ---------------------------------------------------------------------------
// 1) LEAD QUENTE PARADO: a pessoa perguntou valor/parcelamento/horario (sinais em intent.ts) e, depois da resposta, ficou
//    sem escrever. A equipe e avisada ANTES do 1o recontato automatico (que so sai depois de 4h), pra chamar no calor.
// 2) RETORNO COMBINADO: a pessoa pediu pra ser chamada numa data ("depois do dia 20", "mes que vem"); na data a Alice
//    retoma a conversa (ou, se a conversa esta com a equipe, a equipe e avisada).
// ---------------------------------------------------------------------------

export const HOT_STALL_MS = 90 * 60_000; // sem resposta ha pelo menos isto
export const HOT_WINDOW_MS = 24 * 3_600_000; // sinal recente (mais velho que isto ja e recontato normal)
const MAX_ALERTS_PER_RUN = 10;

// PURO: o lead quente esta "parado" e ainda nao foi avisado desse sinal?
export function isHotStalled(
  p: { askedPriceAt: Date | null; askedInstallmentsAt: Date | null; askedScheduleAt: Date | null; hotAlertedAt: Date | null },
  lastUserAt: Date | null,
  now: Date,
): boolean {
  const signals = [p.askedPriceAt, p.askedInstallmentsAt, p.askedScheduleAt].filter((d): d is Date => !!d);
  if (!signals.length || !lastUserAt) return false;
  const latest = Math.max(...signals.map((d) => d.getTime()));
  if (now.getTime() - latest > HOT_WINDOW_MS) return false;
  if (p.hotAlertedAt && p.hotAlertedAt.getTime() >= latest) return false; // ja avisou deste sinal
  const silent = now.getTime() - lastUserAt.getTime();
  return silent >= HOT_STALL_MS && silent <= HOT_WINDOW_MS + HOT_STALL_MS;
}

export async function runHotLeadCheck(now = new Date()): Promise<number> {
  const clinics = await prisma.clinic.findMany({
    where: { ...PAID_CLINIC_WHERE, active: true, aliceActive: true, notifyPhone: { not: null } },
    select: { id: true, timezone: true, workDays: true, workStartHour: true, workEndHour: true, hoursByDay: true },
  });
  let alerted = 0;
  for (const clinic of clinics) {
    if (!isWithinClinicHours(clinic, now)) continue; // fora do expediente: espera abrir
    const since = new Date(now.getTime() - HOT_WINDOW_MS);
    const candidates = await prisma.patient.findMany({
      where: {
        clinicId: clinic.id,
        optedOut: false,
        noInterest: false,
        OR: [{ askedPriceAt: { gte: since } }, { askedInstallmentsAt: { gte: since } }, { askedScheduleAt: { gte: since } }],
        appointments: { none: { status: "confirmed", scheduledAt: { gte: now } } }, // quem ja tem horario nao e lead parado
      },
      select: {
        id: true, name: true, phone: true, interestNote: true, adName: true, adCampaignName: true,
        askedPriceAt: true, askedInstallmentsAt: true, askedScheduleAt: true, hotAlertedAt: true,
      },
      take: 60,
    });
    let sent = 0;
    for (const p of candidates) {
      if (sent >= MAX_ALERTS_PER_RUN) break;
      const lastUser = await prisma.message.findFirst({
        where: { role: "user", conversation: { patientId: p.id } },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      if (!isHotStalled(p, lastUser?.createdAt ?? null, now)) continue;
      const hours = Math.max(1, Math.round((now.getTime() - lastUser!.createdAt.getTime()) / 3_600_000 * 2) / 2);
      const origin = [p.adName, p.adCampaignName].filter(Boolean).join(" / ");
      await notifyStaff(
        clinic.id,
        "hot_lead",
        `🔥 Lead quente sem avanço: ${p.name ?? p.phone} (${p.phone}) ${describeSignals(p)} e parou de responder há ~${hours}h.${p.interestNote ? `\nInteresse: ${p.interestNote}.` : ""}${origin ? `\nOrigem: ${origin}.` : ""}\nVale chamar agora, antes do recontato automático.`,
      );
      await prisma.patient.update({ where: { id: p.id }, data: { hotAlertedAt: now } });
      sent++;
      alerted++;
    }
  }
  return alerted;
}

// ---- Retorno combinado ---------------------------------------------------

export const CALLBACK_MESSAGE =
  "Oi, {primeiro_nome}! 💗 Você tinha me pedido para retomarmos nossa conversa por esta data. Ficou alguma dúvida ou posso ver um horário para você? ✨";

export function renderCallbackMessage(name: string | null): string {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  // Sem nome: tira o "{primeiro_nome}" e a virgula, em vez de deixar campo sem preencher.
  return first ? CALLBACK_MESSAGE.replace("{primeiro_nome}", first) : CALLBACK_MESSAGE.replace(", {primeiro_nome}!", "!");
}

export async function runCallbackCheck(now = new Date()): Promise<number> {
  const clinics = await prisma.clinic.findMany({
    where: { ...PAID_CLINIC_WHERE, active: true, aliceActive: true },
    select: { id: true, timezone: true, workDays: true, workStartHour: true, workEndHour: true, hoursByDay: true },
  });
  let handled = 0;
  for (const clinic of clinics) {
    if (!isWithinClinicHours(clinic, now)) continue;
    const due = await prisma.patient.findMany({
      where: {
        clinicId: clinic.id,
        callbackAt: { lte: now },
        optedOut: false,
        noInterest: false,
        appointments: { none: { status: "confirmed", scheduledAt: { gte: now } } },
      },
      select: { id: true, name: true, phone: true, callbackNote: true, conversations: { select: { humanTakeover: true }, orderBy: { lastMessageAt: "desc" }, take: 1 } },
      take: 10,
    });
    for (const p of due) {
      // limpa primeiro: se o envio falhar nao fica tentando a cada 15 min (a equipe e avisada)
      await prisma.patient.update({ where: { id: p.id }, data: { callbackAt: null, callbackNote: null } });
      const withTeam = p.conversations[0]?.humanTakeover === true;
      try {
        if (withTeam) {
          await notifyStaff(clinic.id, "human_handoff", `⏰ Retorno combinado: ${p.name ?? p.phone} pediu para ser chamada nesta data${p.callbackNote ? ` (${p.callbackNote})` : ""}. A conversa está com a equipe.`);
        } else {
          const text = renderCallbackMessage(p.name);
          const outcome = await sendText(clinic.id, p.phone, text);
          if (outcome === "sent") await recordAutomatedMessage(p.id, text, "Retorno combinado");
        }
        handled++;
      } catch (err) {
        console.error(`[retorno combinado] falha com ${p.phone}:`, err instanceof Error ? err.message : err);
        await notifyStaff(clinic.id, "automation_failed", `⚠️ Não consegui retomar a conversa combinada com ${p.name ?? p.phone} (${p.phone}). Chame manualmente.`);
      }
    }
  }
  return handled;
}

export function startHotLeadJobs(): void {
  scheduleLocked("lead-quente-parado", "*/15 * * * *", () => runHotLeadCheck().catch((err) => console.error("Erro no alerta de lead quente:", err)));
  scheduleLocked("retorno-combinado", "*/15 * * * *", () => runCallbackCheck().catch((err) => console.error("Erro no retorno combinado:", err)));
}
