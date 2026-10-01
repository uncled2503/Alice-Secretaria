import { prisma } from "../db/client.js";

// Registra uma mensagem automatica (lembrete, pos-procedimento, renovacao,
// aniversario...) na conversa do paciente, pra ela aparecer no Chat do painel
// igual qualquer outra - sem isso, a equipe via a resposta do paciente "do
// nada", sem a pergunta que a originou. Reaproveita a conversa ativa/
// qualificada/agendada mais recente; cria uma nova so se nao existir nenhuma.
export async function recordAutomatedMessage(patientId: string, text: string, authorName: string): Promise<void> {
  let conv = await prisma.conversation.findFirst({
    where: { patientId, status: { in: ["active", "qualified", "scheduled"] } },
    orderBy: { createdAt: "desc" },
  });
  if (!conv) conv = await prisma.conversation.create({ data: { patientId } });

  await prisma.message.create({
    data: { conversationId: conv.id, role: "assistant", content: text, authorName },
  });
  await prisma.conversation.update({
    where: { id: conv.id },
    data: { status: "active", lastMessageAt: new Date(), lastFollowUpOrder: 0 },
  });
}
