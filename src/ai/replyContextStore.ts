import { prisma } from "../db/client.js";
import { deserializeReplyContext, persistedComplaintCount, type ReplyContext } from "./replyGuard.js";

// Le o contexto de geracao que acompanha uma resposta ainda nao entregue (Message.replyContext). Usado pela entrega quando o registro em memoria nao tem o contexto
// (servidor reiniciado, ou resposta retomada depois de 15 min). Os trechos da queixa sao relidos das mensagens da PROPRIA pessoa anteriores a esta resposta.
export async function loadPersistedReplyContext(messageId: string): Promise<ReplyContext | null> {
  const row = await prisma.message.findUnique({ where: { id: messageId }, select: { conversationId: true, createdAt: true, replyContext: true } });
  if (!row?.replyContext) return null;
  const n = persistedComplaintCount(row.replyContext);
  const texts = n > 0
    ? (await prisma.message.findMany({ where: { conversationId: row.conversationId, role: "user", createdAt: { lte: row.createdAt } }, orderBy: { createdAt: "desc" }, take: n, select: { content: true } })).map((m) => m.content).reverse()
    : [];
  return deserializeReplyContext(row.replyContext, row.conversationId, texts);
}

// Apaga o resumo das respostas que ja chegaram a um estado final (enviada, sem confirmacao, bloqueada, vetada, expirada, superada...). So fica o que ainda pode ser entregue.
export async function pruneReplyContexts(): Promise<number> {
  const r = await prisma.message.updateMany({
    where: { replyContext: { not: null }, OR: [{ deliveryStatus: null }, { deliveryStatus: { notIn: ["pending", "failed", "sending"] } }] },
    data: { replyContext: null },
  });
  return r.count;
}
