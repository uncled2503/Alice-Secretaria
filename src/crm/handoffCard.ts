import { describeSignals } from "./intent.js";

const URGENCY_LABEL: Record<string, string> = { agora: "quer fazer agora", este_mes: "quer fazer este mês", depois: "quer fazer mais pra frente" };
const PERIOD_LABEL: Record<string, string> = { manha: "manhã", tarde: "tarde", noite: "noite" };
const OBJECTION_LABEL: Record<string, string> = { preco: "preço", medo: "medo", dor: "dor", tempo: "falta de tempo", indecisao: "indecisão" };

interface CardPatient {
  adName: string | null;
  adCampaignName: string | null;
  interestNote: string | null;
  contactReason: string | null;
  urgency: string | null;
  objections: string | null;
  refusedProcedures: string | null;
  preferredProfessional: string | null;
  preferredPeriod: string | null;
  preferredDays: string | null;
  leadTemperature: string | null;
  askedPriceAt: Date | null;
  askedInstallmentsAt: Date | null;
  askedScheduleAt: Date | null;
}

// Ficha curta do lead pra quem assume a conversa (vai no aviso da equipe e na linha de transferencia do chat). So o que
// ja se sabe; linha sem informacao nao aparece.
export function handoffCard(p: CardPatient): string {
  const lines: string[] = [];
  const origin = [p.adName, p.adCampaignName].filter(Boolean).join(" / ");
  if (origin) lines.push(`Origem: ${origin}`);
  if (p.interestNote) lines.push(`Procedimento de interesse: ${p.interestNote}`);
  if (p.contactReason) lines.push(`Objetivo: ${p.contactReason}`);
  if (p.urgency && URGENCY_LABEL[p.urgency]) lines.push(`Prazo: ${URGENCY_LABEL[p.urgency]}`);
  const objections = (p.objections ?? "").split(",").map((o) => OBJECTION_LABEL[o.trim()]).filter(Boolean);
  if (objections.length) lines.push(`Objeções: ${objections.join(", ")}`);
  if (p.refusedProcedures) lines.push(`Já recusou: ${p.refusedProcedures}`);
  const prefs = [
    p.preferredProfessional ? `profissional ${p.preferredProfessional}` : "",
    p.preferredPeriod && PERIOD_LABEL[p.preferredPeriod] ? `período ${PERIOD_LABEL[p.preferredPeriod]}` : "",
    p.preferredDays ? `dias ${p.preferredDays}` : "",
  ].filter(Boolean);
  if (prefs.length) lines.push(`Preferências: ${prefs.join(" · ")}`);
  if (p.askedPriceAt || p.askedInstallmentsAt || p.askedScheduleAt) lines.push(`Sinais: ${describeSignals(p)}`);
  if (p.leadTemperature) lines.push(`Temperatura: ${p.leadTemperature}`);
  return lines.join("\n");
}
