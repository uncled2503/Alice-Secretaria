import OpenAI from "openai";
import { prisma } from "../db/client.js";

// ---------------------------------------------------------------------------
// "Juiz" do recontato: antes de mandar o recontato automatico, uma IA le o
// desenrolar da conversa e decide se ele faz sentido. As regras fixas (tem
// consulta, disse "ok"...) pegam os casos obvios; a IA pega o resto - o paciente
// que ja resolveu por outro canal, recusou, reclamou, foi atendido pela equipe,
// ou a conversa que simplesmente acabou bem.
//
// Falha segura: se a IA nao responder, NAO recontata (melhor deixar de mandar
// do que mandar mensagem sem sentido e queimar o numero).
// ---------------------------------------------------------------------------

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_RECONTACT_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";

export interface JudgeInput {
  clinicName: string;
  messages: { role: string; content: string; authorName: string | null; createdAt: Date }[]; // mais antigas primeiro
  appointments: { status: string; scheduledAt: Date; procedure: string }[];
  now?: Date;
}

export interface JudgeVerdict {
  recontact: boolean;
  reason: string;
}

const SYSTEM = `Voce decide se a clinica deve mandar um RECONTATO automatico a um paciente que ficou em silencio.

Recontato e uma cutucada gentil para quem demonstrou interesse e sumiu no meio da conversa. Ele NAO deve sair quando seria sem sentido ou incomodo.

Responda recontact=true SOMENTE quando a conversa mostra um lead com interesse real que parou de responder sem desfecho, por exemplo: pediu informacao e nao voltou; recebeu a pergunta da clinica e nao respondeu; disse que ia pensar; ficou de ver horario; nao fechou/agendou.

Responda recontact=false quando:
- o paciente ja tem consulta/atendimento marcado, esta na clinica hoje ou acabou de ser atendido;
- a conversa terminou bem (agradeceu, confirmou presenca, "ok", "combinado");
- o paciente recusou, disse que nao tem interesse, que ja resolveu, que vai procurar outro lugar, ou pediu para parar de receber mensagens;
- foi o paciente quem falou por ultimo e a clinica ainda nao respondeu;
- a conversa e sobre pos-procedimento, dor, reclamacao ou assunto clinico/sensivel (isso e da equipe, nao de recontato comercial);
- e fornecedor, spam, engano, assunto pessoal ou nao e um paciente em potencial;
- a mensagem de recontato soaria repetitiva ou fora de contexto (ja houve recontato recente, ou a conversa tem poucos dias e o paciente respondeu ha pouco);
- nao ha informacao suficiente para saber que ele queria algo.
Na duvida, recontact=false.

Responda APENAS um JSON: {"recontact": true|false, "reason": "motivo em ate 15 palavras"}.`;

function formatConversation(input: JudgeInput): string {
  const now = input.now ?? new Date();
  const lines = input.messages.slice(-18).map((m) => {
    const who = m.role === "user" ? "PACIENTE" : m.role === "human" ? "EQUIPE" : m.authorName ? `AUTOMACAO (${m.authorName})` : "ALICE";
    const mins = Math.max(0, Math.round((now.getTime() - m.createdAt.getTime()) / 60_000));
    const ago = mins < 90 ? `${mins} min atras` : mins < 60 * 36 ? `${Math.round(mins / 60)} h atras` : `${Math.round(mins / 1440)} dias atras`;
    return `[${ago}] ${who}: ${m.content.replace(/\s+/g, " ").slice(0, 300)}`;
  });
  const appts = input.appointments.length
    ? input.appointments
        .map((a) => `- ${a.procedure}: ${a.status}, ${a.scheduledAt.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`)
        .join("\n")
    : "(nenhum agendamento)";
  return `Clinica: ${input.clinicName}\nAgendamentos do paciente:\n${appts}\n\nConversa (mais recente por ultimo):\n${lines.join("\n")}`;
}

export async function judgeRecontact(input: JudgeInput): Promise<JudgeVerdict | null> {
  if (process.env.RECONTACT_AI_GATE === "off") return { recontact: true, reason: "juiz desligado (RECONTACT_AI_GATE=off)" };
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const res = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: formatConversation(input) },
      ],
    });
    const raw = res.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(raw) as { recontact?: unknown; reason?: unknown };
    if (typeof parsed.recontact !== "boolean") return null;
    return { recontact: parsed.recontact, reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 200) : "" };
  } catch (err) {
    console.error("[recontato] juiz de IA falhou:", err);
    return null;
  }
}

// Junta o contexto no banco e julga. Reaproveita o veredito se a conversa nao
// mudou desde a ultima avaliacao (nao paga a IA de novo a cada 15 minutos).
export async function judgeConversation(conversationId: string, patientId: string, clinicName: string): Promise<JudgeVerdict | null> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { recontactVerdict: true, recontactReason: true, recontactJudgedFor: true },
  });
  const last = await prisma.message.findFirst({
    where: { conversationId, role: { in: ["user", "assistant", "human"] } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (!last) return null;
  if (conversation?.recontactVerdict && conversation.recontactJudgedFor && conversation.recontactJudgedFor.getTime() === last.createdAt.getTime()) {
    return { recontact: conversation.recontactVerdict === "yes", reason: conversation.recontactReason ?? "" };
  }

  const [messages, appointments] = await Promise.all([
    prisma.message.findMany({
      where: { conversationId, role: { in: ["user", "assistant", "human"] } },
      orderBy: { createdAt: "desc" },
      take: 18,
      select: { role: true, content: true, authorName: true, createdAt: true },
    }),
    prisma.appointment.findMany({
      where: { patientId },
      orderBy: { scheduledAt: "desc" },
      take: 5,
      select: { status: true, scheduledAt: true, procedure: { select: { name: true } } },
    }),
  ]);
  const verdict = await judgeRecontact({
    clinicName,
    messages: messages.reverse(),
    appointments: appointments.map((a) => ({ status: a.status, scheduledAt: a.scheduledAt, procedure: a.procedure.name })),
  });
  if (!verdict) return null; // falha: nao grava, tenta de novo no proximo ciclo (e nao envia)

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { recontactVerdict: verdict.recontact ? "yes" : "no", recontactReason: verdict.reason, recontactJudgedFor: last.createdAt },
  });
  return verdict;
}
