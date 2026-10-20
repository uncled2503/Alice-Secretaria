import OpenAI from "openai";
import { safeFetch } from "../ai/wellFormed.js";
import { tracked } from "../ai/openaiCall.js";
import { prisma } from "../db/client.js";
import { scheduleLocked } from "../jobs/lock.js";
import { classifyLead, REASON_CODES, type LeadStatus } from "./classification.js";
import { compactTranscript } from "../ai/conversationAnalysis.js";

// ---------------------------------------------------------------------------
// SUGESTAO AUTOMATICA DE CLASSIFICACAO (IA). Le a conversa e SUGERE qualificado / desqualificado com um motivo comercial OBJETIVO, a partir dos
// criterios que a clinica configurou (Clinic.qualificationCriteria). A sugestao fica pendente de revisao humana: so vira etiqueta e evento depois de
// confirmada (ou se a clinica ligou a aprovacao automatica, que fica registrada). Regras duras (no codigo, nao so no prompt):
//   - dado de saude, diagnostico ou condicao clinica NUNCA entra: o motivo gravado vem de uma lista fixa de motivos comerciais, nao do texto do modelo;
//   - silencio, demora pra responder ou nao ter comprado NAO desqualifica (so motivo declarado: sem interesse, fora do perfil, teste/spam, vaga de emprego);
//   - sem pelo menos 2 mensagens da pessoa nao ha o que avaliar.
// ---------------------------------------------------------------------------

export const DEFAULT_CRITERIA =
  "Qualificado: a pessoa demonstra interesse real no servico, pede valor/orcamento, pede ou aceita agendar, ou confirma que quer continuar o atendimento. " +
  "Desqualificado: a pessoa declara que nao tem interesse, o contato esta fora do perfil atendido pela empresa (ex.: candidata a vaga de emprego, fornecedor), ou e teste/spam. " +
  "Em qualificacao: ainda esta conhecendo, tirando duvidas ou sem sinal claro. Nunca desqualifique so porque a pessoa demorou a responder ou ainda nao comprou.";

export const REASON_TEXT: Record<string, string> = {
  interesse_real: "Demonstrou interesse real no serviço.",
  pediu_agendamento: "Pediu ou aceitou agendar.",
  pediu_orcamento: "Pediu valor ou orçamento.",
  quer_continuar: "Confirmou que quer continuar o atendimento.",
  sem_interesse: "Declarou que não tem interesse.",
  fora_do_perfil: "Contato fora do perfil comercial atendido.",
  teste_ou_spam: "Contato de teste ou spam.",
  vaga_emprego: "Contato sobre vaga de emprego, não é cliente.",
  outro: "Outro motivo comercial.",
};

const QUALIFIED_CODES = new Set(["interesse_real", "pediu_agendamento", "pediu_orcamento", "quer_continuar"]);
const DISQUALIFIED_CODES = new Set(["sem_interesse", "fora_do_perfil", "teste_ou_spam", "vaga_emprego"]);

export function suggestSystem(criteria: string): string {
  return `Voce classifica leads de WhatsApp de uma empresa para fins COMERCIAIS. Responda APENAS um JSON:
{"status":"qualificado | desqualificado | em_qualificacao | indefinido","codigo_motivo":"${REASON_CODES.join(" | ")}","confianca":"alta | media | baixa"}
CRITERIOS DA EMPRESA (siga-os): ${criteria}
REGRAS: use so o que a pessoa DISSE e fez na conversa (P = pessoa, A = atendimento automatico, E = equipe). NUNCA use dados de saude, diagnosticos, condicoes clinicas ou caracteristicas sensiveis da pessoa para decidir. NUNCA desqualifique porque a pessoa demorou a responder, nao respondeu ou ainda nao comprou. Se nao houver sinal claro, responda "indefinido". codigo_motivo deve ser um dos listados e descrever o MOTIVO COMERCIAL.`;
}

export interface Suggestion {
  status: LeadStatus;
  reasonCode: string;
  reason: string; // texto padrao do motivo (nunca texto livre do modelo)
  confidence: "alta" | "media" | "baixa";
}

// PURO: valida o JSON do modelo e aplica as regras duras (motivo tem que combinar com o status).
export function parseSuggestion(text: string | null | undefined): Suggestion | null {
  if (!text) return null;
  let d: any;
  try {
    d = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
  } catch {
    return null;
  }
  if (!d || typeof d !== "object") return null;
  const status = d.status;
  const code = typeof d.codigo_motivo === "string" ? d.codigo_motivo.trim() : "";
  const confidence = d.confianca === "alta" || d.confianca === "baixa" ? d.confianca : "media";
  if (status === "qualificado" && QUALIFIED_CODES.has(code)) return { status, reasonCode: code, reason: REASON_TEXT[code], confidence };
  if (status === "desqualificado" && DISQUALIFIED_CODES.has(code)) return { status, reasonCode: code, reason: REASON_TEXT[code], confidence };
  return null; // em_qualificacao / indefinido / motivo que nao combina: nao sugere nada
}

export type SuggestCall = (system: string, user: string) => Promise<string | null>;

let openai: OpenAI | null = null;
async function defaultCall(model: string, system: string, user: string): Promise<string | null> {
  openai ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY, fetch: safeFetch, timeout: 30_000, maxRetries: 0 });
  const r = await tracked(openai, "sugestao_anuncio").chat.completions.create({ model, temperature: 0, max_tokens: 120, response_format: { type: "json_object" }, messages: [{ role: "system", content: system }, { role: "user", content: user }] });
  return r.choices[0]?.message?.content ?? null;
}

export interface SuggestOutcome {
  ok: boolean;
  skipped?: string;
  suggestion?: Suggestion;
  pending?: boolean;
  applied?: boolean;
}

export async function suggestForLead(clinicId: string, patientId: string, call?: SuggestCall): Promise<SuggestOutcome> {
  try {
    const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { qualificationCriteria: true, aiModel: true } });
    if (!clinic) return { ok: false, skipped: "clinica nao encontrada" };
    const msgs = await prisma.message.findMany({
      where: { role: { in: ["user", "assistant", "human"] }, conversation: { patientId } },
      orderBy: { createdAt: "desc" },
      take: 40,
      select: { role: true, content: true },
    });
    const history = msgs.reverse();
    const userCount = history.filter((m) => m.role === "user").length;
    if (userCount < 2) return { ok: true, skipped: "poucas mensagens da pessoa para avaliar" };

    const criteria = clinic.qualificationCriteria?.trim() || DEFAULT_CRITERIA;
    const model = clinic.aiModel?.trim() || process.env.OPENAI_MODEL || "gpt-4o-mini";
    const text = await (call ?? ((s, u) => defaultCall(model, s, u)))(suggestSystem(criteria), `CONVERSA:\n${compactTranscript(history, 40)}`);
    const s = parseSuggestion(text);
    if (!s) return { ok: true, skipped: "sem sinal comercial claro" };
    const r = await classifyLead({ clinicId, patientId, status: s.status, reason: s.reason, reasonCode: s.reasonCode, source: "ia", actorName: null, confirmed: false });
    return { ok: true, suggestion: s, pending: r.pending, applied: r.changed };
  } catch (err) {
    console.error("[sugestao] falha:", err instanceof Error ? err.message : err);
    return { ok: false, skipped: "erro ao consultar a IA" };
  }
}

// Robo: a cada 30 min, nas clinicas que ligaram a sugestao, avalia leads com conversa recente que ainda nao tem classificacao final.
export async function runSuggestionJob(limitPerClinic = 10): Promise<number> {
  const clinics = await prisma.clinic.findMany({ where: { qualificationAi: true }, select: { id: true } });
  let n = 0;
  for (const c of clinics) {
    const leads = await prisma.patient.findMany({
      where: {
        clinicId: c.id,
        optedOut: false,
        OR: [{ leadClass: null }, { leadClass: "em_qualificacao" }],
        conversations: { some: { lastMessageAt: { gte: new Date(Date.now() - 3 * 86_400_000) } } },
        leadClassifications: { none: { confirmed: false, decidedAt: null } }, // sem sugestao pendente
      },
      orderBy: { createdAt: "desc" },
      take: limitPerClinic,
      select: { id: true, leadClassifications: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } } },
    });
    for (const l of leads) {
      // ja avaliado (sugestao decidida ha menos de 12 h): nao gasta IA de novo
      const last = l.leadClassifications[0]?.createdAt;
      if (last && Date.now() - last.getTime() < 12 * 3_600_000) continue;
      const r = await suggestForLead(c.id, l.id);
      if (r.suggestion) n++;
    }
  }
  return n;
}

export function startSuggestionJob(): void {
  scheduleLocked("sugestao-qualificacao", "*/30 * * * *", async () => {
    await runSuggestionJob();
  });
}
