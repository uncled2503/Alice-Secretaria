import { prisma } from "../db/client.js";
import { logActivity } from "./activity.js";

// ---------------------------------------------------------------------------
// Descadastro (LGPD / boas praticas do WhatsApp): quando a pessoa pede pra parar de receber mensagens, o paciente
// fica com optedOut = true e NENHUMA automacao de marketing/acompanhamento (recontato, campanha, aniversario,
// renovacao, pos-procedimento, pesquisa, lista de espera, receita) manda mais nada. O lembrete do horario ja
// marcado continua (e aviso do servico contratado, nao propaganda) e a pessoa segue podendo conversar: a Alice
// responde normalmente quando ELA escreve.
// ---------------------------------------------------------------------------

export const OPTOUT_CONFIRMATION =
  "Tudo bem, não vamos mais te enviar mensagens automáticas. Se precisar de algo, é só chamar por aqui. 💙";

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// A mensagem INTEIRA e so o comando (ex.: "PARAR", "sair").
const COMMAND_RE = /^(parar|pare|sair|stop|descadastrar|descadastro|cancelar mensagens|cancelar envio|cancelar inscricao|nao quero receber|me remova|me tire da lista|remover meu numero)$/;

// Frases que pedem claramente pra nao receber mais contato. Nada que possa ser confundido com "cancelar a consulta".
const PHRASE_RE = new RegExp(
  [
    "nao quero (mais )?receber",
    "nao quero mais (contato|mensagem|mensagens|ser contatad[oa]|propaganda|promocao|promocoes)",
    "(pare|parem|para) de (me )?(enviar|mandar|chamar|incomodar|ligar)",
    "nao (me )?(envie|mande|chame|escreva) mais",
    "me (tire|retire|remova|exclua|tira|remove|exclui) d[ao]s? (sua |de |dessa |essa |nossa |lista|base|cadastro)",
    "(remova|remover|retire|retirar|exclua|excluir) (meu|o meu) (numero|contato|telefone|cadastro)",
    "sair d[ao] (sua |de |dessa |essa )?(lista|base)",
    "descadastr",
    "nao tenho interesse em receber",
  ].join("|"),
);

export function isOptOutRequest(text: string | null | undefined): boolean {
  const t = normalize(text ?? "");
  if (!t || t.length > 200) return false; // texto longo e conversa, nao um pedido de descadastro
  return COMMAND_RE.test(t) || PHRASE_RE.test(t);
}

export async function applyOptOut(clinicId: string, patientId: string): Promise<void> {
  const patient = await prisma.patient.findUnique({ where: { id: patientId }, select: { optedOut: true, name: true, phone: true } });
  if (!patient || patient.optedOut) return;
  await prisma.patient.update({ where: { id: patientId }, data: { optedOut: true, optedOutAt: new Date() } });
  await logActivity({
    clinicId,
    patientId,
    type: "patient_opted_out",
    area: "atendimento",
    title: "Pediu para não receber mais mensagens",
    description: `${patient.name ?? patient.phone}: as mensagens automáticas (recontato, campanhas, aniversário...) foram desligadas para este contato. A equipe pode reativar na ficha do contato.`,
    actorName: null,
  });
  const { notifyStaff } = await import("./notify.js");
  await notifyStaff(clinicId, "human_handoff", `${patient.name ?? patient.phone} pediu para não receber mais mensagens automáticas. Desligamos recontato e campanhas para este contato.`);
}
