// Contatos que NAO sao paciente em potencial (curriculo, fornecedor, parceria, cobranca de empresa). A Alice os passa para a equipe em silencio
// (ver ai/jobSeeker.ts + alice.ts) e o motivo da transferencia fica gravado na conversa. Se a equipe devolver a conversa para a Alice, ela NAO
// entra na cascata comercial de recontato. Mensagem MISTA (vaga + pedido de paciente) nao e excluida: tem uma parte clinica.

import { isJobSeeker, nonPatientKind } from "../ai/jobSeeker.js";

const NON_COMMERCIAL_REASON = /candidata a vaga|\(n[aã]o [eé] paciente\)/i;

export function isNonCommercialHandoff(reason: string | null | undefined): boolean {
  return !!reason && NON_COMMERCIAL_REASON.test(reason);
}

// Interesse clinico/comercial explicito na MESMA mensagem: mensagem mista (vaga + pedido de paciente) nao e excluida (tem uma parte clinica).
const CLINICAL_RE = /\b(limpeza de pele|botox|preenchimento|depila\w*|laser|massagem|drenagem|peeling|harmoniza\w*|agendar|marcar (uma )?(consulta|avaliacao|horario)|quanto custa|valor|preco|tratamento|procedimento)\b/;
const foldText = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

// PURO: o CONTEXTO da conversa mostra que nao e paciente em potencial? Usa os detectores contextuais (nao qualquer "vaga"/"trabalho"): candidatura ("vaga de <funcao>",
// curriculo, processo seletivo), fornecedor, parceria, cobranca de empresa, ou o proprio INTERESSE gravado no CRM ser uma vaga de emprego (o resumo automatico pode ter
// anotado "Vaga de Avaliadora de Estetica" como se fosse procedimento). Devolve o codigo ou null.
export function nonCommercialByContext(input: { interestNote?: string | null; patientTexts: string[]; adText?: string | null }): string | null {
  const interest = input.interestNote?.trim();
  if (interest && (isJobSeeker(interest) || JOB_ADVERT_INTEREST.test(foldText(interest)))) return "interesse_registrado_e_vaga_de_emprego";
  for (const text of input.patientTexts) {
    if (CLINICAL_RE.test(foldText(text))) continue; // mensagem mista: tem uma parte clinica
    if (isJobSeeker(text, input.adText ?? "")) return "candidatura_a_vaga";
    const kind = nonPatientKind(text);
    if (kind) return kind;
  }
  return null;
}
const JOB_ADVERT_INTEREST = /^vagas? (de|para|pra) \w+|\bvaga (de|para|pra) (avaliador|consultor|esteticista|recepcionista)/;
