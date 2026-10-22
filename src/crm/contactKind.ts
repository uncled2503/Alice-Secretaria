import { prisma } from "../db/client.js";
import { logActivity } from "./activity.js";
import type { OutboundKind } from "../ai/sendGate.js";

// ---------------------------------------------------------------------------
// CLASSIFICACAO PERSISTENTE DE CONTATO (checklist 22/10): paciente | nao_paciente (parceria, curriculo, fornecedor, influenciador, cobranca, administrativo).
// Gravada em Patient.contactKind e COMPARTILHADA entre o atendimento (alice.ts) e as automacoes (sendText bloqueia os tipos comerciais; selecoes ja excluem). Principios:
//  - detectada por CONTEXTO/frase forte (ai/jobSeeker.ts), nunca por uma palavra isolada; guarda o trecho que motivou (evidencia) para revisao;
//  - fonte "alice" e REVERSIVEL: se a pessoa depois traz pedido clinico claro (mudanca de contexto comprovada), volta a ser paciente; fonte "equipe" so a equipe muda;
//  - a equipe revisa/corrige no cadastro do contato (PATCH /patients/:id) e isso fica no Diario;
//  - classificar NAO apaga historico e NAO bloqueia lembrete/confirmacao/pos de quem tem agendamento (isso e atendimento, nao prospeccao).
// ---------------------------------------------------------------------------
export const NON_PATIENT_DETAILS = ["parceria", "curriculo", "fornecedor", "influenciador", "cobranca", "administrativo"] as const;
export type NonPatientDetail = (typeof NON_PATIENT_DETAILS)[number];
export const DETAIL_LABEL: Record<NonPatientDetail, string> = {
  parceria: "Parceria", curriculo: "Currículo / vaga", fornecedor: "Fornecedor", influenciador: "Influenciador", cobranca: "Cobrança / financeiro", administrativo: "Assunto administrativo",
};

// Tipos de envio AUTOMATICO que NAO podem ir a um nao-paciente (prospeccao/relacionamento). Lembrete/confirmacao/pos/preparo/agendamento ficam de fora: dependem de agendamento real.
export const NON_PATIENT_BLOCKED_KINDS: readonly OutboundKind[] = ["recontato", "retomada", "indicacao", "pesquisa", "aniversario", "renovacao", "campanha"];

export const isNonPatientKind = (k: string | null | undefined): boolean => k === "nao_paciente";

export function validDetail(d: unknown): d is NonPatientDetail {
  return typeof d === "string" && (NON_PATIENT_DETAILS as readonly string[]).includes(d);
}

// Marca como nao-paciente (Alice detectou). Nao sobrescreve decisao da EQUIPE (nem "paciente" definido por ela, nem outra classificacao dela).
export async function classifyByAlice(patientId: string, detail: NonPatientDetail, evidence: string, now = new Date()): Promise<boolean> {
  const p = await prisma.patient.findUnique({ where: { id: patientId }, select: { clinicId: true, contactKind: true, contactKindSource: true } });
  if (!p) return false;
  if (p.contactKindSource === "equipe") return false; // decisao humana prevalece
  if (p.contactKind === "nao_paciente") return false; // ja classificado
  await prisma.patient.update({ where: { id: patientId }, data: { contactKind: "nao_paciente", contactKindDetail: detail, contactKindSource: "alice", contactKindAt: now, contactKindEvidence: evidence.replace(/\s+/g, " ").slice(0, 300) } });
  await logActivity({ clinicId: p.clinicId, patientId, type: "contact_classified", area: "atendimento", title: `Contato classificado como não-paciente (${DETAIL_LABEL[detail]})`, description: `Detectado pela Alice pelo contexto da conversa. A equipe pode corrigir no cadastro do contato. Trecho: "${evidence.replace(/\s+/g, " ").slice(0, 160)}"`, actorName: null });
  return true;
}

// Decisao da EQUIPE (cadastro do contato): vale ate a equipe mudar de novo.
export async function setByStaff(patientId: string, kind: "paciente" | "nao_paciente", detail: string | null, staffName: string | null, now = new Date()): Promise<void> {
  const p = await prisma.patient.findUnique({ where: { id: patientId }, select: { clinicId: true } });
  if (!p) return;
  const nonPatient = kind === "nao_paciente";
  await prisma.patient.update({ where: { id: patientId }, data: { contactKind: kind, contactKindDetail: nonPatient ? (validDetail(detail) ? detail : "administrativo") : null, contactKindSource: "equipe", contactKindAt: now, ...(nonPatient ? {} : { contactKindEvidence: null }) } });
  await logActivity({ clinicId: p.clinicId, patientId, type: "contact_classified", area: "atendimento", title: nonPatient ? "Contato marcado como não-paciente pela equipe" : "Contato marcado como paciente pela equipe", description: nonPatient ? `Tipo: ${validDetail(detail) ? DETAIL_LABEL[detail] : "assunto administrativo"}. As automações comerciais deixam de ser enviadas.` : "As automações voltam a valer para este contato.", actorName: staffName });
}

// Mudanca de contexto COMPROVADA: classificacao feita pela Alice volta a "paciente" quando a pessoa traz agora um pedido clinico claro (a decisao da equipe nunca e desfeita aqui).
export async function revertByClinicalContext(patientId: string, clinicalAsk: boolean, now = new Date()): Promise<boolean> {
  if (!clinicalAsk) return false;
  const p = await prisma.patient.findUnique({ where: { id: patientId }, select: { clinicId: true, contactKind: true, contactKindSource: true } });
  if (!p || p.contactKind !== "nao_paciente" || p.contactKindSource !== "alice") return false;
  await prisma.patient.update({ where: { id: patientId }, data: { contactKind: "paciente", contactKindDetail: null, contactKindAt: now } });
  await logActivity({ clinicId: p.clinicId, patientId, type: "contact_classified", area: "atendimento", title: "Contato voltou a ser tratado como paciente", description: "A pessoa trouxe um pedido clínico/de agendamento depois da classificação automática: mudança de contexto.", actorName: null });
  return true;
}

// Gate dos envios automaticos: true = NAO enviar (contato classificado como nao-paciente e o tipo e comercial/relacionamento).
export async function blocksAutomatedSend(clinicId: string, phone: string, kind: OutboundKind | undefined): Promise<boolean> {
  if (!kind || !NON_PATIENT_BLOCKED_KINDS.includes(kind)) return false;
  const p = await prisma.patient.findFirst({ where: { clinicId, phone }, select: { contactKind: true } });
  return isNonPatientKind(p?.contactKind);
}
