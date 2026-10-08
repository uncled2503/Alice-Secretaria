import cron from "node-cron";
import { prisma } from "../db/client.js";
import { PAID_CLINIC_WHERE } from "./plan.js";
import { isWithinClinicHours } from "./openHours.js";
import { notifyStaff } from "./notify.js";

// Avisa a equipe quando um paciente mandou mensagem e ficou MAIS DE 15 MIN
// sem resposta (da Alice ou de uma pessoa) - ex.: Alice parada por limite do
// plano, conversa com atendimento humano que ninguem viu, falha de envio. So
// avisa dentro do expediente da clinica e uma vez por mensagem.
export const UNANSWERED_AFTER_MS = 15 * 60_000;
const LOOKBACK_MS = 12 * 3_600_000;
const MAX_LISTED = 5;

export async function runUnansweredCheck(now = new Date()): Promise<number> {
  const conversations = await prisma.conversation.findMany({
    where: {
      archived: false,
      lastMessageAt: { gte: new Date(now.getTime() - LOOKBACK_MS), lte: new Date(now.getTime() - UNANSWERED_AFTER_MS) },
      patient: { clinic: PAID_CLINIC_WHERE },
    },
    include: {
      patient: { select: { name: true, phone: true, clinicId: true, clinic: { select: { timezone: true, workDays: true, workStartHour: true, workEndHour: true, hoursByDay: true } } } },
      messages: { where: { role: { in: ["user", "assistant"] } }, orderBy: { createdAt: "desc" }, take: 1 },
    },
  });

  const byClinic = new Map<string, { clinic: (typeof conversations)[number]["patient"]["clinic"]; items: { id: string; label: string; text: string; at: Date; takeover: boolean }[] }>();
  for (const c of conversations) {
    const last = c.messages[0];
    if (!last || last.role !== "user") continue; // ultima fala foi da Alice/equipe: respondida
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
    });
    byClinic.set(clinicId, entry);
  }

  let alerted = 0;
  for (const [clinicId, entry] of byClinic) {
    if (!isWithinClinicHours(entry.clinic, now)) continue; // fora do expediente: espera abrir
    const sorted = entry.items.sort((a, b) => a.at.getTime() - b.at.getTime());
    const lines = sorted.slice(0, MAX_LISTED).map((i) => `• ${i.label}${i.takeover ? " (atendimento humano)" : ""}: "${i.text}"`);
    const extra = sorted.length > MAX_LISTED ? `\n…e mais ${sorted.length - MAX_LISTED}.` : "";
    await notifyStaff(clinicId, "human_handoff", `⏰ ${sorted.length} conversa(s) sem resposta há mais de 15 minutos:\n${lines.join("\n")}${extra}\nAbra o Chat para atender.`);
    await prisma.conversation.updateMany({ where: { id: { in: sorted.map((i) => i.id) } }, data: { unansweredAlertAt: now } });
    alerted += sorted.length;
  }
  return alerted;
}

export function startUnansweredJob(): void {
  cron.schedule("*/5 * * * *", () => {
    runUnansweredCheck().catch((err) => console.error("Erro no aviso de conversa sem resposta:", err));
  });
}
