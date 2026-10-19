import { scheduleLocked } from "../jobs/lock.js";
import { prisma } from "../db/client.js";
import { PAID_CLINIC_WHERE } from "./plan.js";
import { isWithinClinicHours } from "./openHours.js";
import { notifyStaff } from "./notify.js";
import { ANSWERED_STATUSES } from "../ai/delivery.js";

// Avisa a equipe quando um paciente mandou mensagem e ficou MAIS DE 15 MIN
// sem resposta (da Alice ou de uma pessoa) - ex.: Alice parada por limite do
// plano, conversa com atendimento humano que ninguem viu, falha de envio. So
// avisa dentro do expediente da clinica e uma vez por mensagem.
export const UNANSWERED_AFTER_MS = 15 * 60_000;
const LOOKBACK_MS = 12 * 3_600_000;
const MAX_LISTED = 5;

export interface TailMessage { role: string; createdAt: Date; deliveryStatus: string | null }

// Por que a resposta da Alice nao conta como resposta (ela existe no chat, mas nao chegou na pessoa).
const NOT_DELIVERED_CAUSE: Record<string, string> = {
  failed: "a resposta da Alice ainda não saiu (tentando de novo)",
  pending: "a resposta da Alice ainda não saiu",
  failed_permanent: "a resposta da Alice não saiu (número sem WhatsApp?)",
  blocked: "a resposta da Alice não saiu (envio automático bloqueado pelo plano)",
  vetoed: "a resposta da Alice foi barrada pela revisão",
  expired: "a resposta da Alice expirou sem sair",
};

// PURO: olha o FIM da conversa (mensagens da mais nova para a mais antiga) e diz se a pessoa esta sem resposta.
// Uma fala da Alice so conta como resposta se foi aceita pelo envio (sent) ou pode ter chegado (sending/unconfirmed/legado); resposta
// bloqueada, barrada, expirada ou que falhou NAO e resposta. A equipe (role "human") conta como resposta.
export function classifyConversationTail(newestFirst: TailMessage[]): { unanswered: boolean; lastUserAt: Date | null; cause: string | null } {
  let cause: string | null = null;
  for (const m of newestFirst) {
    if (m.role === "user") return { unanswered: true, lastUserAt: m.createdAt, cause };
    if (m.role === "human") return { unanswered: false, lastUserAt: null, cause: null };
    if (m.role !== "assistant") continue;
    const st = m.deliveryStatus;
    if (st === null || (ANSWERED_STATUSES as readonly string[]).includes(st)) return { unanswered: false, lastUserAt: null, cause: null };
    cause ??= NOT_DELIVERED_CAUSE[st] ?? "a resposta da Alice não chegou";
  }
  return { unanswered: false, lastUserAt: null, cause: null };
}

export async function runUnansweredCheck(now = new Date()): Promise<number> {
  const conversations = await prisma.conversation.findMany({
    where: {
      archived: false,
      lastMessageAt: { gte: new Date(now.getTime() - LOOKBACK_MS), lte: new Date(now.getTime() - UNANSWERED_AFTER_MS) },
      patient: { clinic: PAID_CLINIC_WHERE },
    },
    include: {
      patient: { select: { name: true, phone: true, clinicId: true, clinic: { select: { timezone: true, workDays: true, workStartHour: true, workEndHour: true, hoursByDay: true } } } },
      messages: { where: { role: { in: ["user", "assistant", "human"] } }, orderBy: { createdAt: "desc" }, take: 6, select: { role: true, content: true, createdAt: true, deliveryStatus: true } },
    },
  });

  const byClinic = new Map<string, { clinic: (typeof conversations)[number]["patient"]["clinic"]; items: { id: string; label: string; text: string; at: Date; takeover: boolean; cause: string | null }[] }>();
  for (const c of conversations) {
    const tail = classifyConversationTail(c.messages);
    if (!tail.unanswered || !tail.lastUserAt) continue; // ultima fala valida foi da Alice/equipe: respondida
    const last = c.messages.find((m) => m.role === "user" && m.createdAt.getTime() === tail.lastUserAt!.getTime())!;
    if (now.getTime() - last.createdAt.getTime() < UNANSWERED_AFTER_MS) continue;
    if (c.unansweredAlertAt && c.unansweredAlertAt.getTime() >= last.createdAt.getTime()) continue; // ja avisou desta mensagem
    const clinicId = c.patient.clinicId;
    const entry = byClinic.get(clinicId) ?? { clinic: c.patient.clinic, items: [] };
    entry.items.push({
      id: c.id,
      label: c.patient.name?.trim() || c.patient.phone,
      text: (last.content || "").replace(/\s+/g, " ").slice(0, 80),
      at: last.createdAt,
      takeover: c.humanTakeover,
      cause: tail.cause,
    });
    byClinic.set(clinicId, entry);
  }

  let alerted = 0;
  for (const [clinicId, entry] of byClinic) {
    if (!isWithinClinicHours(entry.clinic, now)) continue; // fora do expediente: espera abrir
    const sorted = entry.items.sort((a, b) => a.at.getTime() - b.at.getTime());
    const lines = sorted.slice(0, MAX_LISTED).map((i) => `• ${i.label}${i.takeover ? " (atendimento humano)" : ""}: "${i.text}"${i.cause ? ` — ${i.cause}` : ""}`);
    const extra = sorted.length > MAX_LISTED ? `\n…e mais ${sorted.length - MAX_LISTED}.` : "";
    await notifyStaff(clinicId, "human_handoff", `⏰ ${sorted.length} conversa(s) sem resposta há mais de 15 minutos:\n${lines.join("\n")}${extra}\nAbra o Chat para atender.`);
    await prisma.conversation.updateMany({ where: { id: { in: sorted.map((i) => i.id) } }, data: { unansweredAlertAt: now } });
    alerted += sorted.length;
  }
  return alerted;
}

export function startUnansweredJob(): void {
  scheduleLocked("aviso-sem-resposta", "*/5 * * * *", () => {
    runUnansweredCheck().catch((err) => console.error("Erro no aviso de conversa sem resposta:", err));
  });
}
