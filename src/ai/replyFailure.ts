import { prisma } from "../db/client.js";
import { logActivity } from "../crm/activity.js";
import { REVISION } from "../version.js";
import { deliveredOnly } from "./delivery.js";

// ---------------------------------------------------------------------------
// FALHA DE ATENDIMENTO RASTREAVEL. Quando uma mensagem da pessoa NAO recebe a resposta que deveria (erro ao gerar, evento que esgotou as tentativas,
// resposta que expirou antes de sair), o sistema nao simula sucesso: deixa uma PENDENCIA explicita e recuperavel pra equipe.
//   - a conversa vira "nao lida" com o motivo (a equipe responde; a Alice volta a atender na proxima mensagem da pessoa);
//   - uma linha no Diario de atividades (type reply_failed) com a etapa onde parou e os identificadores tecnicos;
//   - uma linha de log estruturada (clinica, conversa, mensagem, evento, versao). Nunca grava o texto da pessoa, telefone completo nem segredos.
// Quem chama nao precisa tratar erro: esta funcao nunca lanca.
// ---------------------------------------------------------------------------

export type ReplyStage = "recebimento" | "geracao" | "validacao" | "envio" | "retomada";

const STAGE_LABEL: Record<ReplyStage, string> = {
  recebimento: "ao processar a mensagem recebida",
  geracao: "ao gerar a resposta",
  validacao: "ao validar a resposta",
  envio: "ao enviar a resposta",
  retomada: "ao retomar uma resposta que ficou parada",
};

const ALERT_COOLDOWN_MS = 10 * 60_000; // no maximo 1 registro por conversa a cada 10 min (evita enxurrada se o erro for geral)

export interface ReplyFailure {
  clinicId: string;
  stage: ReplyStage;
  conversationId?: string | null;
  phone?: string | null; // so pra achar a conversa quando o id nao e conhecido
  messageId?: string | null;
  eventId?: string | null;
  error?: unknown;
  note?: string;
}

const short = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);
const errText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : e == null ? "" : String(e));

export async function recordReplyFailure(f: ReplyFailure): Promise<void> {
  try {
    let conversationId = f.conversationId ?? null;
    if (!conversationId && f.phone) {
      const digits = f.phone.replace(/\D/g, "");
      const patient = await prisma.patient
        .findFirst({ where: { clinicId: f.clinicId, phone: digits }, select: { conversations: { orderBy: { lastMessageAt: "desc" }, take: 1, select: { id: true } } } })
        .catch(() => null);
      conversationId = patient?.conversations[0]?.id ?? null;
    }
    const detail = short(errText(f.error), 160);
    console.error(
      `[atendimento] SEM RESPOSTA etapa=${f.stage} clinica=${f.clinicId} conversa=${conversationId ?? "?"} mensagem=${f.messageId ?? "?"} evento=${f.eventId ?? "?"} revisao=${REVISION.split(":")[0]}${detail ? ` erro="${detail}"` : ""}${f.note ? ` nota="${short(f.note, 120)}"` : ""}`,
    );
    if (!conversationId) return;

    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true, patientId: true, humanTakeover: true, handoffPending: true },
    });
    if (!conv) return;
    // Sob responsabilidade de uma pessoa (assumiu o atendimento): nao e falha da Alice; a equipe ja esta com a conversa.
    if (conv.humanTakeover) return;
    // So sinaliza quem de fato ficou sem resposta: se a ultima fala valida ja e da Alice (entregue ou em entrega) ou da equipe, nao ha pendencia.
    const last = await prisma.message.findFirst({
      where: { conversationId: conv.id, role: { in: ["user", "assistant", "human"] }, ...deliveredOnly },
      orderBy: { createdAt: "desc" },
      select: { role: true },
    });
    if (last && last.role !== "user") return;

    if (!conv.handoffPending) {
      await prisma.conversation.update({
        where: { id: conv.id },
        data: { handoffPending: true, handoffReason: short(`Alice não conseguiu responder (${STAGE_LABEL[f.stage]})`, 120) },
      });
    }
    const recent = await prisma.activityLog.count({
      where: { patientId: conv.patientId, type: "reply_failed", createdAt: { gte: new Date(Date.now() - ALERT_COOLDOWN_MS) } },
    });
    if (recent === 0) {
      await logActivity({
        clinicId: f.clinicId, patientId: conv.patientId, type: "reply_failed", area: "atendimento",
        title: "Resposta da Alice não saiu",
        description: short(`Etapa: ${STAGE_LABEL[f.stage]}. conversa ${conv.id}${f.messageId ? `, mensagem ${f.messageId}` : ""}${f.eventId ? `, evento ${f.eventId}` : ""}, versão ${REVISION.split(":")[0]}.${detail ? ` Erro: ${detail}.` : ""}${f.note ? ` ${f.note}` : ""} A conversa ficou como não lida para a equipe.`, 500),
        actorName: null,
      });
    }
  } catch (err) {
    console.error("[atendimento] nao consegui registrar a falha de atendimento:", err instanceof Error ? err.message : err);
  }
}
