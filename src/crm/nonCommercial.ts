// Contatos que NAO sao paciente em potencial (curriculo, fornecedor, parceria, cobranca de empresa). A Alice os passa para a equipe em silencio
// (ver ai/jobSeeker.ts + alice.ts) e o motivo da transferencia fica gravado na conversa. Se a equipe devolver a conversa para a Alice, ela NAO
// entra na cascata comercial de recontato. Mensagem MISTA (vaga + pedido de paciente) nao e excluida: tem uma parte clinica.

const NON_COMMERCIAL_REASON = /candidata a vaga|\(n[aã]o [eé] paciente\)/i;

export function isNonCommercialHandoff(reason: string | null | undefined): boolean {
  return !!reason && NON_COMMERCIAL_REASON.test(reason);
}
