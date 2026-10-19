import { prisma } from "../db/client.js";
import { readSurveyReply, hasComplaint, type SurveyMessageCtx } from "./surveyReply.js";
import { recordSurveyAnswer, PENDING_WINDOW_DAYS, SURVEY_AUTHOR } from "./surveyFlow.js";

// ---------------------------------------------------------------------------
// A RESPOSTA DA PESQUISA, tratada pelo CODIGO antes do modelo (chamado no inicio de generateReply). Se a mensagem da pessoa e a nota (reading em
// surveyReply.ts), grava (atomico, idempotente pelo id da mensagem) e devolve o agradecimento - o link do Google so vai se estiver CONFIRMADO, e nota
// alta com reclamacao nao ganha link. Se NAO e nota, devolve null e a conversa segue normalmente (o modelo nao recebe numero solto para adivinhar).
// ---------------------------------------------------------------------------

export interface HandlerMessage {
  id: string;
  role: string;
  content: string;
  authorName?: string | null;
  createdAt: Date;
}

interface HandlerInput {
  clinicId: string;
  conversationId: string;
  patientId: string;
  history: HandlerMessage[]; // cronologico, terminando nas mensagens novas da pessoa
  now?: Date;
}

// REGISTRAR a nota (quando a conversa esta com a equipe). Tres coisas separadas: (1) RECONHECER e registrar uma resposta valida ligada a uma pesquisa pendente - aqui, pelas mesmas regras
// de leitura (numero solto so vale se a ultima fala foi a pesquisa; horario/quantidade/idade nunca; se a equipe falou depois da pesquisa, numero solto e ambiguo e NAO vira nota);
// (2) PERMISSAO para responder sozinha - nao tem: a conversa e da equipe; (3) PERMISSAO para link do Google/indicacao - nao tem. Nao grava nenhuma mensagem para a pessoa.
export async function recordSurveyNoteHumanOwned(p: HandlerInput): Promise<{ recorded: boolean; score?: number; complaint?: boolean }> {
  const r = await handleSurveyNote(p, true);
  return r ? { recorded: true, score: r.score, complaint: r.complaint } : { recorded: false };
}

export async function trySurveyReply(p: HandlerInput): Promise<string | null> {
  const r = await handleSurveyNote(p, false);
  return r ? r.reply : null;
}

async function handleSurveyNote(p: HandlerInput, humanOwned: boolean): Promise<{ reply: string; score: number; complaint: boolean } | null> {
  const now = p.now ?? new Date();
  // as mensagens novas da pessoa (sem resposta): depois da ultima fala que nao e dela
  let lastOutIdx = -1;
  p.history.forEach((m, i) => { if (m.role !== "user") lastOutIdx = i; });
  const trailing = p.history.slice(lastOutIdx + 1).filter((m) => m.role === "user");
  if (!trailing.length) return null;

  // a mesma mensagem ja foi gravada antes (retentativa depois de uma queda): devolve o MESMO agradecimento, sem gravar nem avisar de novo
  const already = await prisma.satisfactionSurvey.findFirst({ where: { clinicId: p.clinicId, patientId: p.patientId, answeredByMessageId: { in: trailing.map((m) => m.id) } } });
  // A nota desta mensagem foi registrada ENQUANTO a conversa estava com a equipe: a Alice NAO a agradece agora (depois da pausa o agradecimento, o link e o convite perderam a
  // pertinencia). Silencio: "" = tratado, nada a enviar (e o modelo nao recebe o numero solto para adivinhar).
  if (already && !humanOwned && already.linkState === "atendimento_humano") return { reply: "", score: already.score ?? 0, complaint: already.hasComplaint };
  const pending = already
    ? null
    : await prisma.satisfactionSurvey.findFirst({
        where: { clinicId: p.clinicId, patientId: p.patientId, answeredAt: null, askedAt: { gte: new Date(now.getTime() - PENDING_WINDOW_DAYS * 24 * 3_600_000) } },
        orderBy: { askedAt: "desc" },
      });
  if (!already && !pending) return null;

  const survey = already ?? pending!;
  // o fio: a pergunta da pesquisa e tudo o que veio depois
  let start = p.history.findIndex((m) => m.role === "assistant" && m.authorName === SURVEY_AUTHOR && Math.abs(m.createdAt.getTime() - survey.askedAt.getTime()) < 15 * 60_000);
  if (start < 0) start = p.history.findIndex((m) => m.createdAt.getTime() >= survey.askedAt.getTime() - 60_000);
  if (start < 0) start = 0;
  const thread: SurveyMessageCtx[] = p.history.slice(start).map((m) => ({ role: m.role, content: m.content, authorName: m.authorName }));

  for (const msg of trailing) {
    const idx = p.history.indexOf(msg) - start;
    if (idx < 0) continue;
    const reading = readSurveyReply(msg.content, thread.slice(0, idx + 1));
    if (reading.kind !== "score") continue;
    const others = trailing.filter((m) => m !== msg).map((m) => m.content).join(" ").trim();
    const comment = [reading.comment, others].filter(Boolean).join(" · ").slice(0, 500) || null;
    const result = await recordSurveyAnswer({
      clinicId: p.clinicId,
      patientId: p.patientId,
      score: reading.score,
      comment,
      complaint: reading.complaint || hasComplaint(others),
      messageId: msg.id,
      humanOwned,
      now,
    });
    if (!result.ok) return null; // ja respondida por outro caminho, ou nota invalida: segue o fluxo normal
    // conversa com a equipe: a nota fica registrada e NADA e escrito para a pessoa
    if (humanOwned) return { reply: result.reply, score: reading.score, complaint: result.complaint };
    // grava o agradecimento (a entrega o acompanha) - menos quando a retentativa ja encontra uma resposta gravada depois da mensagem da pessoa
    const hasReply = await prisma.message.findFirst({ where: { conversationId: p.conversationId, role: "assistant", createdAt: { gt: msg.createdAt } }, select: { id: true } });
    if (!hasReply) {
      await prisma.message.create({ data: { conversationId: p.conversationId, role: "assistant", content: result.reply, deliveryStatus: "pending" } });
      await prisma.conversation.update({ where: { id: p.conversationId }, data: { lastMessageAt: now } });
    }
    return { reply: result.reply, score: reading.score, complaint: result.complaint };
  }
  return null;
}
