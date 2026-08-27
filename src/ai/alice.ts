import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { prisma } from "../db/client.js";
import { findAvailableSlots } from "../scheduling/slots.js";
import { getActiveRulesPrompt } from "./rules.js";
import { getFunnelStages } from "../crm/stages.js";
import { notifyStaff } from "../crm/notify.js";
import type { Procedure } from "@prisma/client";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// gpt-4o-mini por padrao: conversa de qualificacao/agendamento nao precisa do
// modelo mais caro. Troque via OPENAI_MODEL se a qualidade exigir.
const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "check_availability",
      description: "Consulta horarios livres para um procedimento da clinica.",
      parameters: {
        type: "object",
        properties: {
          procedure_name: { type: "string", description: "Nome do procedimento, deve bater com um dos cadastrados na clinica" },
        },
        required: ["procedure_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "book_appointment",
      description: "Confirma o agendamento de um horario especifico para o paciente. So chame depois que o paciente confirmar o horario escolhido.",
      parameters: {
        type: "object",
        properties: {
          procedure_name: { type: "string" },
          start_iso: { type: "string", description: "Data/hora ISO 8601 do horario escolhido, deve ser um dos horarios retornados por check_availability" },
        },
        required: ["procedure_name", "start_iso"],
      },
    },
  },
];

async function runTool(clinicId: string, patientId: string, name: string, input: any): Promise<string> {
  if (name === "check_availability") {
    const procedure = await prisma.procedure.findFirst({
      where: { clinicId, name: { contains: input.procedure_name } },
    });
    if (!procedure) return `Procedimento "${input.procedure_name}" nao encontrado na clinica.`;

    const slots = await findAvailableSlots(clinicId, procedure.durationMin);
    if (slots.length === 0) return "Nenhum horario livre nos proximos dias.";

    return slots
      .slice(0, 6)
      .map((s) => s.start.toISOString())
      .join(", ");
  }

  if (name === "book_appointment") {
    const procedure = await prisma.procedure.findFirst({
      where: { clinicId, name: { contains: input.procedure_name } },
    });
    if (!procedure) return `Procedimento "${input.procedure_name}" nao encontrado.`;

    const scheduledAt = new Date(input.start_iso);
    if (isNaN(scheduledAt.getTime())) return "Data/hora invalida.";

    await prisma.appointment.create({
      data: { clinicId, patientId, procedureId: procedure.id, scheduledAt },
    });
    await prisma.conversation.updateMany({
      where: { patientId },
      data: { status: "scheduled" },
    });
    // Usa o "kind" (nao um stageId fixo) pra funcionar mesmo se a clinica
    // renomeou a etapa padrao "Avaliacao agendada" pra outro nome.
    const stages = await getFunnelStages(clinicId);
    const scheduledStage = stages.find((s) => s.kind === "avaliacao_agendada");
    if (scheduledStage) {
      await prisma.patient.update({
        where: { id: patientId },
        data: { funnelStage: scheduledStage.stageId },
      });
    }

    const patient = await prisma.patient.findUnique({ where: { id: patientId } });
    await notifyStaff(
      clinicId,
      "new_appointment",
      `Novo agendamento (via Alice): ${patient?.name ?? patient?.phone ?? "paciente"} - ${procedure.name} em ${scheduledAt.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}.`
    );

    return `Agendado com sucesso para ${scheduledAt.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}.`;
  }

  return "Ferramenta desconhecida.";
}

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  dinheiro: "dinheiro",
  pix: "Pix",
  credito: "cartao de credito",
  debito: "cartao de debito",
};

// So passa pro prompt o que a clinica realmente cadastrou - nunca inventa
// indicacao, beneficio, prazo ou preco que nao veio do banco.
function describeProcedureForPrompt(p: Procedure): string {
  const lines = [`- ${p.name} (${p.durationMin}min)`];

  if (p.price != null) {
    let priceLine = `  Valor: R$ ${p.price.toFixed(2)}`;
    if (p.offerInstallments && p.maxInstallments) {
      priceLine += ` (ate ${p.maxInstallments}x de R$ ${(p.price / p.maxInstallments).toFixed(2)})`;
    }
    lines.push(priceLine);
  } else if (p.priceVariable) {
    lines.push("  Valor: depende de avaliacao presencial (nao informar valor fixo)");
  }

  const methods = p.paymentMethods
    ? p.paymentMethods
        .split(",")
        .filter(Boolean)
        .map((m) => PAYMENT_METHOD_LABELS[m] || m)
    : [];
  if (methods.length) lines.push(`  Formas de pagamento: ${methods.join(", ")}`);
  if (p.paymentLink) lines.push(`  Link de pagamento: ${p.paymentLink}`);

  if (p.description) lines.push(`  Descricao: ${p.description}`);
  if (p.aliases) lines.push(`  Tambem pode ser chamado de: ${p.aliases}`);
  if (p.goals) lines.push(`  Atende objetivos/queixas: ${p.goals.split("\n").filter(Boolean).join("; ")}`);
  if (p.benefits) lines.push(`  Beneficios que podem ser afirmados: ${p.benefits.split("\n").filter(Boolean).join("; ")}`);
  if (p.resultTimeline) lines.push(`  Prazo de resultado: ${p.resultTimeline}`);

  return lines.join("\n");
}

async function buildSystemPrompt(clinicId: string): Promise<string> {
  const clinic = await prisma.clinic.findUniqueOrThrow({
    where: { id: clinicId },
    include: { procedures: true },
  });

  const procedureList = clinic.procedures.map((p) => describeProcedureForPrompt(p)).join("\n\n");

  return `Voce e a Alice, secretaria virtual da clinica de estetica "${clinic.name}".
Atenda pelo WhatsApp de forma humanizada, calorosa e objetiva, como uma recepcionista experiente.

Seu trabalho:
1. Entender o interesse do paciente e qualificar (procedimento desejado, se e novo paciente).
2. Usar a ferramenta check_availability para consultar horarios reais antes de sugerir qualquer data.
3. Confirmar o horario escolhido com o paciente e so entao usar book_appointment.
4. Nunca invente horarios ou informacoes que nao vieram das ferramentas.

Procedimentos oferecidos pela clinica:
${procedureList || "(nenhum procedimento cadastrado ainda)"}

Use so os dados de valor, beneficio, indicacao e prazo que estao cadastrados acima em cada procedimento. Se o paciente perguntar algo que nao esta ali (preco de um item sem valor, prazo de um item sem prazo cadastrado, etc.), diga que precisa confirmar na avaliacao/com a equipe - nunca invente numero, garantia ou prazo.

Responda sempre em portugues do Brasil, em mensagens curtas como quem digita no WhatsApp.${await getActiveRulesPrompt(clinicId)}`;
}

export async function handleIncomingMessage(params: {
  clinicId: string;
  patientPhone: string;
  patientName?: string;
  text: string;
}): Promise<string> {
  const { clinicId, patientPhone, patientName, text } = params;

  const patient = await prisma.patient.upsert({
    where: { clinicId_phone: { clinicId, phone: patientPhone } },
    update: { name: patientName },
    create: { clinicId, phone: patientPhone, name: patientName },
  });

  let conversation = await prisma.conversation.findFirst({
    where: { patientId: patient.id, status: { in: ["active", "qualified"] } },
    orderBy: { createdAt: "desc" },
  });
  if (!conversation) {
    conversation = await prisma.conversation.create({ data: { patientId: patient.id } });
  }

  await prisma.message.create({
    data: { conversationId: conversation.id, role: "user", content: text },
  });
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: new Date(), lastFollowUpOrder: 0 }, // paciente respondeu, reinicia a cascata de recontato
  });

  if (conversation.humanTakeover) {
    // Atendente assumiu esta conversa pelo painel; Alice so registra, nao responde.
    return "";
  }

  const history = await prisma.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "asc" },
    take: 30,
  });

  const system = await buildSystemPrompt(clinicId);

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: system },
    ...history.map((m): ChatCompletionMessageParam => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.content,
    })),
  ];

  let finalText = "";
  for (let turn = 0; turn < 4; turn++) {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages,
      tools,
    });

    const choice = response.choices[0].message;
    finalText = choice.content ?? "";

    if (!choice.tool_calls || choice.tool_calls.length === 0) break;

    messages.push(choice);

    for (const toolCall of choice.tool_calls) {
      if (toolCall.type !== "function") continue;
      const input = JSON.parse(toolCall.function.arguments || "{}");
      const result = await runTool(clinicId, patient.id, toolCall.function.name, input);
      messages.push({ role: "tool", tool_call_id: toolCall.id, content: result });
    }
  }

  await prisma.message.create({
    data: { conversationId: conversation.id, role: "assistant", content: finalText },
  });
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: new Date() },
  });

  return finalText;
}
