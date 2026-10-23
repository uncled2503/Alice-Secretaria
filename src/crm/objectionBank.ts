import { prisma } from "../db/client.js";
import { logActivity } from "./activity.js";
import type { ObjectionKind } from "../ai/turnReading.js";

// ---------------------------------------------------------------------------
// BANCO DE RESPOSTAS A OBJECOES (por empresa, aprovado e versionado). A Alice so usa resposta APROVADA, como base (adapta ao contexto da conversa sem acrescentar promessa, desconto,
// escassez ou garantia). Mudar uma resposta aprovada cria NOVA versao (a anterior fica "substituida": historico preservado). Nada e publicado sozinho: o que o aprendizado
// automatico sugerir entra como rascunho.
// Objecoes: preco | medo | dor | tempo | indecisao | parcelamento.
// ---------------------------------------------------------------------------
export const OBJECTION_CODES = ["preco", "medo", "dor", "tempo", "indecisao", "parcelamento"] as const;
export type ObjectionCode = (typeof OBJECTION_CODES)[number];
export const OBJECTION_LABEL: Record<ObjectionCode, string> = { preco: "Preço", medo: "Medo", dor: "Dor", tempo: "Tempo", indecisao: "Indecisão (vou pensar)", parcelamento: "Parcelamento" };

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
const PAIN_RE = /\b(doi|dói|vai doer|doer|dolorid|sente dor|sentir dor|machuca|incomoda muito|e dolorosa|anestesi)/;
const INDECISION_RE = /\b(vou pensar|preciso pensar|deixa eu pensar|vou ver e (te )?(falo|aviso)|to em duvida|estou em duvida|nao sei se|ainda nao decidi|depois (eu )?(vejo|falo))\b/;
const INSTALL_RE = /\b(parcel\w*|em quantas vezes|da pra dividir|dividir no cartao|nao consigo (pagar )?a vista|so consigo parcelado)\b/;

// PURO: o codigo do banco para o turno. Dor e parcelamento sao mais especificos que medo e preco (testados antes); "vou pensar" vem do fluxo (hesitate) ou da fala.
export function objectionCodeOf(text: string, detected: ObjectionKind | null, intent?: string | null): ObjectionCode | null {
  const t = fold(text);
  if (PAIN_RE.test(t)) return "dor";
  if (INSTALL_RE.test(t)) return "parcelamento";
  if (detected === "price") return "preco";
  if (detected === "fear") return "medo";
  if (detected === "time") return "tempo";
  if (intent === "hesitate" || INDECISION_RE.test(t)) return "indecisao";
  return null;
}

export async function approvedObjectionAnswer(clinicId: string, code: ObjectionCode): Promise<{ id: string; version: number; text: string } | null> {
  const r = await prisma.objectionAnswer.findFirst({ where: { clinicId, code, status: "aprovada" }, orderBy: { version: "desc" }, select: { id: true, version: true, text: true } }).catch(() => null);
  return r ?? null;
}

// PURO: a diretiva para o modelo (usar a resposta aprovada como base).
export function objectionDirective(code: ObjectionCode, text: string): string {
  return `OBJECAO (${OBJECTION_LABEL[code]}): a clinica tem uma resposta APROVADA para isso. Use-a como base, com naturalidade e adaptando ao que ela disse, SEM acrescentar desconto, brinde, escassez, garantia ou promessa de resultado: "${text.replace(/"/g, "'")}"`;
}

// Cria ou altera (nova versao) a resposta de um codigo. status: rascunho | aprovada. A versao aprovada anterior vira "substituida".
export async function saveObjectionAnswer(clinicId: string, code: string, text: string, approve: boolean, actor: string | null): Promise<{ ok: true; id: string; version: number } | { ok: false; error: string }> {
  if (!(OBJECTION_CODES as readonly string[]).includes(code)) return { ok: false, error: `código inválido (${OBJECTION_CODES.join(", ")})` };
  const clean = text.trim();
  if (clean.length < 10) return { ok: false, error: "texto muito curto" };
  const last = await prisma.objectionAnswer.findFirst({ where: { clinicId, code }, orderBy: { version: "desc" } });
  const version = (last?.version ?? 0) + 1;
  const row = await prisma.$transaction(async (tx) => {
    if (approve) await tx.objectionAnswer.updateMany({ where: { clinicId, code, status: "aprovada" }, data: { status: "substituida" } });
    return tx.objectionAnswer.create({ data: { clinicId, code, text: clean, version, status: approve ? "aprovada" : "rascunho", approvedBy: approve ? actor ?? "equipe" : null, createdBy: actor } });
  });
  await logActivity({ clinicId, type: "automation_updated", area: "automacoes", title: `Banco de objeções: ${OBJECTION_LABEL[code as ObjectionCode]} v${version}`, description: approve ? "Aprovada (a anterior ficou como histórico)." : "Rascunho (a Alice não usa até aprovar).", actorName: actor }).catch(() => undefined);
  return { ok: true, id: row.id, version };
}

export async function approveObjectionDraft(clinicId: string, id: string, actor: string | null): Promise<{ ok: boolean; error?: string }> {
  const row = await prisma.objectionAnswer.findFirst({ where: { id, clinicId } });
  if (!row) return { ok: false, error: "não encontrada" };
  if (row.status !== "rascunho") return { ok: false, error: `só rascunho pode ser aprovado (está ${row.status})` };
  await prisma.$transaction([
    prisma.objectionAnswer.updateMany({ where: { clinicId, code: row.code, status: "aprovada" }, data: { status: "substituida" } }),
    prisma.objectionAnswer.update({ where: { id }, data: { status: "aprovada", approvedBy: actor ?? "equipe" } }),
  ]);
  return { ok: true };
}
