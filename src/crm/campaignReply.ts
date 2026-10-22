import { prisma } from "../db/client.js";
import { logActivity } from "./activity.js";
import { notifyStaff } from "./notify.js";

// ---------------------------------------------------------------------------
// CAMPANHA COM ATENDIMENTO HUMANO APOS A RESPOSTA (checklist 22/10). Configuracao POR CAMPANHA (BroadcastCampaign.humanAfterReply). Quando a pessoa responde:
//  - a resposta e LIGADA a campanha com EVIDENCIA: o envio da campanha para ELA (BroadcastRecipient.status=sent, sentAt) dentro da janela da campanha (humanReplyWindowHours);
//  - se ha mais de uma campanha enviada para a pessoa dentro das janelas e a atribuicao e ambigua, NAO se inventa atribuicao: vai para a equipe com a lista das campanhas, sem citar condicao de nenhuma;
//  - a conversa passa para a EQUIPE (humanTakeover + pendencia) ANTES de a Alice gerar qualquer resposta (o hook roda na fila do webhook, antes de generateReply, e a entrega da Alice
//    ja confere humanTakeover de novo: nao ha corrida entre webhook, Alice e equipe);
//  - o motivo comeca por "Resposta a campanha": o retorno automatico por inatividade (humanReturn) NAO devolve essa conversa para a Alice;
//  - a equipe e avisada com o titulo da campanha e o trecho da resposta. Nunca ha valor/condicao inventados: a Alice nem responde.
// ---------------------------------------------------------------------------
const REASON_PREFIX = "Resposta a campanha";
export const isCampaignHumanHandoff = (reason: string | null | undefined): boolean => !!reason && reason.startsWith(REASON_PREFIX);

export interface CampaignReplyResult { took: boolean; ambiguous: boolean; campaigns: string[] }

export async function applyCampaignHumanReply(clinicId: string, patientId: string, conversationId: string, text: string, now = new Date()): Promise<CampaignReplyResult> {
  const none: CampaignReplyResult = { took: false, ambiguous: false, campaigns: [] };
  const recent = await prisma.broadcastRecipient.findMany({
    where: { patientId, status: "sent", sentAt: { gte: new Date(now.getTime() - 30 * 24 * 3_600_000), lte: now }, campaign: { clinicId } },
    include: { campaign: { select: { id: true, title: true, humanAfterReply: true, humanReplyWindowHours: true } } },
    orderBy: { sentAt: "desc" },
  });
  // so conta o envio cuja janela ainda esta aberta
  const inWindow = recent.filter((r) => r.sentAt && now.getTime() - r.sentAt.getTime() <= r.campaign.humanReplyWindowHours * 3_600_000);
  if (!inWindow.some((r) => r.campaign.humanAfterReply)) return none;
  const distinct = new Map(inWindow.map((r) => [r.campaign.id, r.campaign]));
  const ambiguous = distinct.size > 1;
  const titles = [...distinct.values()].map((c) => c.title);
  const humanRecipients = inWindow.filter((r) => r.campaign.humanAfterReply);
  const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { humanTakeover: true } });
  if (!conv || conv.humanTakeover) return none; // a equipe ja esta com a conversa
  const reason = ambiguous
    ? `${REASON_PREFIX} (atribuição ambígua: ${titles.slice(0, 3).join(" / ")}) - atendimento humano`
    : `${REASON_PREFIX} "${titles[0]}" (atendimento humano configurado)`;
  await prisma.conversation.update({ where: { id: conversationId }, data: { humanTakeover: true, handoffPending: true, handoffReason: reason.slice(0, 160) } });
  for (const r of humanRecipients) if (!r.repliedAt) await prisma.broadcastRecipient.update({ where: { id: r.id }, data: { repliedAt: now } }).catch(() => undefined);
  const excerpt = text.replace(/\s+/g, " ").slice(0, 200);
  await prisma.message.create({
    data: { conversationId, role: "system", content: `Atendimento passado para a equipe: ${reason}.${ambiguous ? " Mais de uma campanha foi enviada a esta pessoa recentemente: confira qual condição vale antes de responder." : " A Alice NÃO responde: a condição/valor desta campanha é com a equipe."}\nMensagem: "${excerpt}"`, authorName: null },
  });
  await notifyStaff(clinicId, "human_handoff", `📣 Resposta a campanha: ${titles.slice(0, 3).join(" / ")}${ambiguous ? " (mais de uma campanha: atribuição ambígua)" : ""}\n"${excerpt}"\nA Alice não vai responder: assuma a conversa.`).catch(() => undefined);
  await logActivity({ clinicId, patientId, type: "human_takeover", area: "atendimento", title: "Resposta a campanha com atendimento humano", description: reason, actorName: null });
  return { took: true, ambiguous, campaigns: titles };
}
