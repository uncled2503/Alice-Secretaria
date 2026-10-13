import { prisma } from "../db/client.js";

// ---------------------------------------------------------------------------
// SINAIS DE INTENCAO (fase 2 da Lisboa). Sem IA e sem custo: le a mensagem da pessoa e reconhece, por palavras, quando ela
//  - perguntou VALOR,
//  - perguntou PARCELAMENTO (intencao mais avancada),
//  - perguntou/pediu HORARIO ou quer reservar,
//  - usou uma expressao de ALTA INTENCAO ("quero fazer", "como pago?", "pode reservar?").
// Cada sinal grava a data no paciente e eleva a temperatura do lead; o job de lead quente parado (hotLeads.ts) usa isso
// pra avisar a equipe ANTES da cadencia de recontato. Parcelamento ganha a etiqueta "Perguntou parcelamento" no CRM.
// ---------------------------------------------------------------------------

export function normalizeIntentText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Mesma ideia do PRICE_ASK_RE da Alice ("quanto tempo dura" NAO conta).
const PRICE_RE =
  /quanto ((voces|vcs|voce|vc|a clinica) )?(custa|cobra|cobram|cobrar|fica|ficaria|sai|vai (custar|ficar|sair)|ta|esta|estao|pago|seria|seriam|vale|e|eh)\b|\b(valor|valores|preco|precos|orcamento|investimento)\b|a partir de quanto|(cobram|cobra|custa|custam) quanto/;

const INSTALLMENTS_RE = /parcel|\b\d{1,2} ?x\b|em quantas vezes|quantas vezes|cartao de credito|no credito|dividir (em|no)|entrada (de|e)/;

const SCHEDULE_RE =
  /tem (horario|vaga|encaixe)|tem algum horario|qual(is)? (horario|horarios|dia|dias)|quando (tem|da|posso|pode)|pode (reservar|marcar|agendar)|quero (marcar|agendar|reservar|ir)|gostaria de (marcar|agendar)|horario (livre|disponivel)|disponibilidade/;

const HIGH_INTENT_RE =
  /quero (fazer|comecar|fechar|agendar|marcar|reservar|esse|essa|o de)|vou querer|como (eu )?pago|como faco (pra|para) (pagar|reservar|agendar|marcar)|qual (a )?chave pix|pode reservar|pode fechar|\bfechado\b|bora (fazer|marcar)|quero garantir|garantir (a )?(vaga|promocao|oferta)/;

export interface IntentSignals {
  price: boolean;
  installments: boolean;
  schedule: boolean;
  highIntent: boolean;
}

export function detectIntentSignals(text: string | null | undefined): IntentSignals {
  const t = normalizeIntentText(text ?? "");
  if (!t) return { price: false, installments: false, schedule: false, highIntent: false };
  const installments = INSTALLMENTS_RE.test(t);
  return {
    price: PRICE_RE.test(t) || installments, // quem pergunta parcelamento esta, de fato, perguntando o valor
    installments,
    schedule: SCHEDULE_RE.test(t),
    highIntent: HIGH_INTENT_RE.test(t) || installments,
  };
}

export const INSTALLMENTS_TAG = "Perguntou parcelamento";

// Grava os sinais no paciente (so quando ha algum) e esquenta o lead. Nunca lanca: e secundario ao atendimento.
export async function recordIntentSignals(clinicId: string, patientId: string, text: string | null | undefined): Promise<IntentSignals> {
  const signals = detectIntentSignals(text);
  if (!signals.price && !signals.installments && !signals.schedule && !signals.highIntent) return signals;
  try {
    const now = new Date();
    const patient = await prisma.patient.findUnique({ where: { id: patientId }, select: { leadTemperature: true } });
    if (!patient) return signals;
    await prisma.patient.update({
      where: { id: patientId },
      data: {
        ...(signals.price ? { askedPriceAt: now } : {}),
        ...(signals.installments ? { askedInstallmentsAt: now } : {}),
        ...(signals.schedule ? { askedScheduleAt: now } : {}),
        // Pergunta de valor/horario/parcelamento ou expressao de compra = lead quente (nao rebaixa nem mexe se ja e quente).
        ...(patient.leadTemperature !== "quente" ? { leadTemperature: "quente" } : {}),
      },
    });
    if (signals.installments) {
      const tag = await prisma.tag.upsert({
        where: { clinicId_label: { clinicId, label: INSTALLMENTS_TAG } },
        update: {},
        create: { clinicId, label: INSTALLMENTS_TAG, color: "#dc2626" },
      });
      await prisma.patientTag.upsert({
        where: { patientId_tagId: { patientId, tagId: tag.id } },
        update: {},
        create: { patientId, tagId: tag.id },
      });
    }
  } catch (err) {
    console.error("[intencao] falhou ao registrar sinais:", err);
  }
  return signals;
}

// Texto curto do que o lead sinalizou, pro alerta da equipe.
export function describeSignals(p: { askedPriceAt: Date | null; askedInstallmentsAt: Date | null; askedScheduleAt: Date | null }): string {
  const parts: string[] = [];
  if (p.askedInstallmentsAt) parts.push("perguntou o parcelamento");
  else if (p.askedPriceAt) parts.push("perguntou o valor");
  if (p.askedScheduleAt) parts.push("pediu horário");
  return parts.join(" e ") || "mostrou interesse";
}
