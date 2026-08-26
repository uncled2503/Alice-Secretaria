import OpenAI from "openai";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { prisma } from "../db/client.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

export const RULE_CATEGORIES = [
  { id: "agendamento", label: "Agendamento" },
  { id: "pagamento", label: "Pagamento e sinal" },
  { id: "tom_de_voz", label: "Tom de voz" },
  { id: "chamar_equipe", label: "Chamar a equipe" },
  { id: "procedimentos", label: "Procedimentos" },
] as const;

const RULE_CATEGORY_IDS = RULE_CATEGORIES.map((c) => c.id);

const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "save_rule",
      description: "Salva uma regra de atendimento clara e acionavel, pronta pra guiar a assistente de WhatsApp.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", enum: RULE_CATEGORY_IDS as unknown as string[] },
          instruction: {
            type: "string",
            description: "Instrucao objetiva, na 2a ou 3a pessoa, dizendo exatamente o que a assistente deve fazer.",
          },
        },
        required: ["category", "instruction"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_clarification",
      description: "Usa quando falta uma informacao concreta (valor, prazo, nome) pra transformar o pedido numa regra util.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string" },
        },
        required: ["question"],
      },
    },
  },
];

const SYSTEM_PROMPT = `Voce ajuda a configurar a Alice, assistente de WhatsApp de uma clinica de estetica.
O admin da clinica descreve, em linguagem natural, uma mudanca de comportamento que quer para a Alice.
Sua tarefa: transformar isso numa regra objetiva (ferramenta save_rule), classificada numa destas categorias:
${RULE_CATEGORIES.map((c) => `- ${c.id}: ${c.label}`).join("\n")}

Se o pedido ja tem informacao suficiente pra virar uma regra clara, use save_rule direto.
Se faltar algo essencial e concreto (ex: valor do sinal, prazo, nome de procedimento especifico), use ask_clarification
com UMA pergunta objetiva. Nao pergunte por excesso de cautela — prefira save_rule sempre que der pra escrever uma
regra sensata mesmo com pequenas lacunas.`;

export interface DraftRuleResult {
  status: "active" | "draft" | "needs_clarification";
  category: string | null;
  instruction: string | null;
  clarifyingQuestion: string | null;
}

async function draftFromText(rawInput: string): Promise<DraftRuleResult> {
  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: rawInput },
    ],
    tools,
    tool_choice: "required",
  });

  const toolCall = response.choices[0].message.tool_calls?.[0];
  if (!toolCall || toolCall.type !== "function") {
    return { status: "needs_clarification", category: null, instruction: null, clarifyingQuestion: "Pode detalhar melhor o que você gostaria de mudar?" };
  }

  const input = JSON.parse(toolCall.function.arguments || "{}");

  if (toolCall.function.name === "ask_clarification") {
    return { status: "needs_clarification", category: null, instruction: null, clarifyingQuestion: input.question };
  }

  return { status: "draft", category: input.category, instruction: input.instruction, clarifyingQuestion: null };
}

// Cria um rascunho de regra a partir do texto livre do admin. Fica como
// "draft" (precisa aprovar) ou "needs_clarification" (a IA fez uma pergunta).
export async function createRuleDraft(clinicId: string, rawInput: string) {
  const result = await draftFromText(rawInput);

  return prisma.customRule.create({
    data: {
      clinicId,
      rawInput,
      category: result.category ?? "procedimentos",
      instruction: result.instruction,
      clarifyingQuestion: result.clarifyingQuestion,
      status: result.status,
    },
  });
}

export async function getActiveRulesPrompt(clinicId: string): Promise<string> {
  const rules = await prisma.customRule.findMany({
    where: { clinicId, status: "active" },
    orderBy: { createdAt: "asc" },
  });
  if (rules.length === 0) return "";

  const byCategory = new Map<string, string[]>();
  for (const rule of rules) {
    const list = byCategory.get(rule.category) ?? [];
    if (rule.instruction) list.push(rule.instruction);
    byCategory.set(rule.category, list);
  }

  const sections = RULE_CATEGORIES.filter((c) => byCategory.has(c.id))
    .map((c) => `${c.label}:\n${byCategory.get(c.id)!.map((i) => `- ${i}`).join("\n")}`)
    .join("\n\n");

  return `\n\nRegras especificas desta clinica (siga sempre, tem prioridade sobre o comportamento padrao):\n${sections}`;
}
