import { scheduleLocked } from "../jobs/lock.js";
import { prisma } from "../db/client.js";
import { PAID_CLINIC_WHERE } from "./plan.js";
import { isWithinClinicHours } from "./openHours.js";
import { notifyStaff } from "./notify.js";
import { sendText, isSendDeferred, deferralInfo, isAmbiguousSendError, type SendReport } from "../uazapi/client.js";
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

// RETORNO COMBINADO com CONTROLE PERSISTENTE (22/10/2026). Antes: callbackAt/callbackNote eram APAGADOS antes de qualquer envio; queda, reinicio ou falha perdiam a promessa feita a pessoa.
// Agora a promessa so e limpa DEPOIS de um desfecho FINAL gravado em CallbackDispatch (unico por pessoa+data prometida):
//   pending -> running (reserva atomica) -> sent (aceito pelo provedor) | forwarded (equipe avisada com evidencia; NAO e mensagem enviada) | unconfirmed (pode ter saido: nunca reenvia)
//   | deferred/failed (tenta de novo, promessa preservada).
// Equipe avisada so conta como "forwarded" quando o aviso foi ACEITO pelo provedor (notifyStaff === "sent"); senao a promessa continua pendente e visivel.
export const CALLBACK_MAX_ATTEMPTS = 4;
export const CALLBACK_RETRY_GAP_MS = 15 * 60_000;
export const CALLBACK_STALE_MS = 30 * 60_000;
const CALLBACK_FINAL = ["sent", "forwarded", "unconfirmed", "closed"];

export interface CallbackResult { sent: number; forwarded: number; deferred: number; uncertain: number; failed: number }

export async function runCallbackCheck(now = new Date(), only: { clinicId?: string } = {}): Promise<number> {
  const r = await runCallbackCycle(now, only);
  return r.sent + r.forwarded;
}

export async function runCallbackCycle(now = new Date(), only: { clinicId?: string } = {}): Promise<CallbackResult> {
  const out: CallbackResult = { sent: 0, forwarded: 0, deferred: 0, uncertain: 0, failed: 0 };
  const cutoff = new Date(now.getTime() - CALLBACK_STALE_MS);
  // execucao abandonada: SEM attemptedAt nada saiu (volta a pendente); COM attemptedAt o resultado e incerto (a promessa fica registrada como incerta, sem reenvio)
  await prisma.callbackDispatch.updateMany({ where: { state: "running", attemptedAt: null, updatedAt: { lt: cutoff } }, data: { state: "deferred", detail: "execucao abandonada antes de chamar o provedor: retomada", updatedAt: now } });
  await prisma.callbackDispatch.updateMany({ where: { state: "running", attemptedAt: { not: null }, updatedAt: { lt: cutoff } }, data: { state: "unconfirmed", detail: "o processo parou durante o envio: pode ter saido; NAO reenviado. Confira com a pessoa.", updatedAt: now } });

  const clinics = await prisma.clinic.findMany({
    where: { ...PAID_CLINIC_WHERE, active: true, aliceActive: true, ...(only.clinicId ? { id: only.clinicId } : {}) },
    select: { id: true, timezone: true, workDays: true, workStartHour: true, workEndHour: true, hoursByDay: true },
  });
  for (const clinic of clinics) {
    if (!isWithinClinicHours(clinic, now)) continue;
    const due = await prisma.patient.findMany({
      where: {
        clinicId: clinic.id,
        callbackAt: { lte: now },
        optedOut: false,
        noInterest: false,
        contactKind: "paciente",
        appointments: { none: { status: "confirmed", scheduledAt: { gte: now } } },
      },
      select: { id: true, name: true, phone: true, callbackAt: true, callbackNote: true, conversations: { select: { humanTakeover: true }, orderBy: { lastMessageAt: "desc" }, take: 1 } },
      orderBy: { callbackAt: "asc" },
      take: 10,
    });
    for (const p of due) {
      const dueAt = p.callbackAt!;
      // ---- controle persistente ANTES de qualquer efeito (a promessa continua no cadastro ate o desfecho final)
      let row = await prisma.callbackDispatch.findUnique({ where: { patientId_dueAt: { patientId: p.id, dueAt } } });
      if (!row) {
        try { row = await prisma.callbackDispatch.create({ data: { clinicId: clinic.id, patientId: p.id, dueAt, note: p.callbackNote, state: "pending", updatedAt: now } }); }
        catch (e) { if ((e as { code?: string })?.code === "P2002") continue; throw e; }
      }
      if (CALLBACK_FINAL.includes(row.state)) {
        // desfecho final ja registrado: a promessa nao deve continuar no cadastro (limpeza idempotente, so desta data)
        await prisma.patient.updateMany({ where: { id: p.id, callbackAt: dueAt }, data: { callbackAt: null, callbackNote: null } });
        continue;
      }
      if (row.state === "running") continue; // outro processo esta tratando
      if (row.attempts >= CALLBACK_MAX_ATTEMPTS) {
        await prisma.callbackDispatch.updateMany({ where: { id: row.id, state: row.state }, data: { state: "failed", detail: `tentativas esgotadas (${row.attempts}); a promessa continua no cadastro: chame manualmente`, updatedAt: now } });
        continue;
      }
      if (row.nextAttemptAt && row.nextAttemptAt.getTime() > now.getTime()) continue;
      const claimed = await prisma.callbackDispatch.updateMany({ where: { id: row.id, state: row.state, updatedAt: row.updatedAt }, data: { state: "running", attempts: { increment: 1 }, attemptedAt: null, updatedAt: now } });
      if (claimed.count !== 1) continue;
      const rowId = row.id;
      const finish = async (data: Record<string, unknown>, clear: boolean) => {
        await prisma.callbackDispatch.updateMany({ where: { id: rowId, state: "running" }, data: { ...data, updatedAt: new Date() } });
        if (clear) await prisma.patient.updateMany({ where: { id: p.id, callbackAt: dueAt }, data: { callbackAt: null, callbackNote: null } });
      };
      const retryAt = new Date(now.getTime() + CALLBACK_RETRY_GAP_MS);
      const withTeam = p.conversations[0]?.humanTakeover === true;
      try {
        if (withTeam) {
          const n = await notifyStaff(clinic.id, "human_handoff", `⏰ Retorno combinado: ${p.name ?? p.phone} pediu para ser chamada nesta data${p.callbackNote ? ` (${p.callbackNote})` : ""}. A conversa está com a equipe.`);
          if (n === "sent") { await finish({ state: "forwarded", detail: "equipe avisada (a conversa esta com a equipe); NAO e mensagem enviada" }, true); out.forwarded++; }
          else { await finish({ state: "deferred", detail: `a equipe NAO foi avisada (${n}); a promessa continua pendente`, nextAttemptAt: retryAt }, false); out.deferred++; }
          continue;
        }
        const text = renderCallbackMessage(p.name);
        let report: SendReport | null = null;
        const outcome = await sendText(clinic.id, p.phone, text, {
          kind: "recontato",
          beforeProvider: async () => { await prisma.callbackDispatch.update({ where: { id: rowId }, data: { attemptedAt: new Date(), messageText: text } }); },
          report: (x) => { report = x; },
        });
        const rep = report as SendReport | null;
        if (outcome === "sent") {
          await finish({ state: "sent", detail: "aceito pelo provedor", destination: rep?.destination ?? null, providerId: rep?.providerId ?? null }, true);
          await recordAutomatedMessage(p.id, text, "Retorno combinado").catch((err) => console.error("[retorno combinado] aceito, mas o registro no chat falhou (NAO reenvia):", err instanceof Error ? err.message : err));
          out.sent++;
        } else {
          // Nada saiu (revisao por IA, plano, duplicada): a equipe e avisada; so vira "forwarded" se o AVISO foi aceito. A promessa nunca some em silencio.
          const why = outcome === "vetoed" ? "a revisão por IA barrou a mensagem (veja o Diário de atividades)" : outcome === "blocked" ? "envio automático bloqueado (plano)" : "mensagem idêntica já enviada";
          const n = await notifyStaff(clinic.id, "automation_failed", `⚠️ O retorno combinado com ${p.name ?? p.phone} (${p.phone}) NÃO foi enviado: ${why}. Chame manualmente.`);
          if (n === "sent") { await finish({ state: "forwarded", detail: `nao enviado (${why}); equipe avisada` }, true); out.forwarded++; }
          else { await finish({ state: "deferred", detail: `nao enviado (${why}) e a equipe NAO foi avisada (${n}); a promessa continua pendente`, nextAttemptAt: retryAt }, false); out.deferred++; }
        }
      } catch (err) {
        const started = await prisma.callbackDispatch.findUnique({ where: { id: rowId }, select: { attemptedAt: true } });
        if (isSendDeferred(err)) {
          // nada saiu e nao e falha desta pessoa (WhatsApp desconectado / revisao fora do ar): a promessa fica intacta; sem aviso repetido
          await finish({ state: "deferred", detail: deferralInfo(err).reason, nextAttemptAt: null, ...(started?.attemptedAt ? {} : { attempts: { decrement: 1 } }) }, false);
          out.deferred++;
          console.warn(`[retorno combinado] adiado para ...${p.phone.slice(-4)} (${err instanceof Error ? err.message : "indisponivel"})`);
        } else if (isAmbiguousSendError(err)) {
          await finish({ state: "unconfirmed", detail: "tempo esgotado no provedor: pode ter chegado; NAO reenviado. Confira com a pessoa." }, true);
          out.uncertain++;
          await notifyStaff(clinic.id, "automation_failed", `⚠️ Retorno combinado com ${p.name ?? p.phone} (${p.phone}): não sei se a mensagem saiu (tempo esgotado). Confira na conversa antes de chamar.`).catch(() => undefined);
        } else {
          console.error(`[retorno combinado] falha com ${p.phone}:`, err instanceof Error ? err.message : err);
          await finish({ state: "failed", detail: `falha do provedor: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`, nextAttemptAt: retryAt }, false); // promessa preservada para nova tentativa
          out.failed++;
        }
      }
    }
  }
  return out;
}

export function startHotLeadJobs(): void {
  scheduleLocked("lead-quente-parado", "*/15 * * * *", () => runHotLeadCheck().catch((err) => console.error("Erro no alerta de lead quente:", err)));
  scheduleLocked("retorno-combinado", "*/15 * * * *", () => runCallbackCheck().catch((err) => console.error("Erro no retorno combinado:", err)));
}
