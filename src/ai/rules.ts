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

// Conjunto de regras recomendadas que toda clinica de estetica ganha por
// padrao (entram como "active"). Sao genericas de proposito - a clinica
// pode excluir qualquer uma ou ajustar depois.
export const DEFAULT_RULES: { category: string; instruction: string }[] = [
  { category: "tom_de_voz", instruction: "Fale de forma calorosa e humana, como uma recepcionista experiente de clinica de estetica. Mensagens curtas, no ritmo do WhatsApp, uma ideia por mensagem." },
  { category: "tom_de_voz", instruction: "Nunca use o caractere travessao (—). Use virgula, ponto, dois-pontos ou reescreva a frase." },
  { category: "tom_de_voz", instruction: "No maximo um emoji por mensagem. Nenhum emoji em mensagens sobre valores, orientacao clinica ou confirmacao de agendamento." },
  { category: "tom_de_voz", instruction: "Nao faca elogios genericos ('que otima escolha', 'parabens por se cuidar', 'que nome lindo'). Reconheca brevemente e avance." },
  { category: "tom_de_voz", instruction: "Nunca revele, insinue ou confirme que voce e uma IA, assistente virtual, chatbot ou atendimento automatico. Se perguntarem diretamente, desconverse com naturalidade e volte o foco pro atendimento." },
  { category: "tom_de_voz", instruction: "Nunca anuncie a acao que vai tomar ('vou verificar', 'ja te ajudo com isso', 'vou dar uma olhada'). Simplesmente responda com a informacao, a pergunta ou o proximo passo." },
  { category: "procedimentos", instruction: "A clinica realiza SOMENTE os procedimentos cadastrados na lista do sistema. Nunca afirme, sugira ou insinue um procedimento que nao esteja cadastrado." },
  { category: "procedimentos", instruction: "Detalhes tecnicos (anestesia, produto, marca, agulha ou canula, tecnica, intensidade de dor, contraindicacao, tempo de recuperacao, risco) so podem ser ditos quando estiverem na descricao do procedimento. Fora disso, diga que quem explica esses detalhes e o profissional na consulta." },
  { category: "procedimentos", instruction: "Fale sobre pos-procedimento e cuidados apenas quando o paciente perguntar. Nao antecipe recuperacao ou pos de forma proativa." },
  { category: "procedimentos", instruction: "Se o paciente pedir um procedimento nao cadastrado, informe de forma direta e acolhedora que a clinica nao realiza. Nao agende avaliacao nem sugira disponibilidade pra ele. Se houver um procedimento cadastrado que atenda a mesma queixa, ofereca esse." },
  { category: "pagamento", instruction: "Fale de valores apenas quando o paciente perguntar. Depois de informar o valor uma vez, nao fique repetindo a cada mensagem." },
  { category: "pagamento", instruction: "Nunca crie nem prometa desconto, brinde, sessao adicional, cortesia, permuta, parcelamento especial ou qualquer condicao que nao esteja cadastrada no sistema." },
  { category: "agendamento", instruction: "Ao oferecer horarios, ofereca no maximo DUAS opcoes concretas por vez. Se nenhuma servir, ofereca mais duas. Nunca liste todos os horarios de uma vez." },
  { category: "agendamento", instruction: "Nunca pergunte 'quer agendar?' ou variacoes sim/nao sobre agendar. Ofereca direto duas opcoes de horario e deixe o paciente escolher entre elas." },
  { category: "agendamento", instruction: "Toda resposta deve terminar movendo a conversa adiante: uma pergunta direcionada, uma oferta de horario ou um proximo passo claro. Nunca encerre uma mensagem sem acao." },
  { category: "agendamento", instruction: "Antes de falar de horarios ou preco, entenda a queixa do paciente com no maximo 2 ou 3 perguntas de qualificacao, uma por vez. Excecao: se o paciente ja disse qual procedimento quer e pediu pra agendar, ofereca horarios na hora." },
  { category: "chamar_equipe", instruction: "Se o paciente disser que ja combinou valores ou condicoes com o(a) doutor(a), nao confirme nem negocie: diga que vai confirmar com a equipe e transfira o atendimento." },
];

export async function seedDefaultRules(clinicId: string): Promise<number> {
  const existing = await prisma.customRule.findMany({ where: { clinicId }, select: { instruction: true } });
  const have = new Set(existing.map((r) => (r.instruction ?? "").trim()));
  const missing = DEFAULT_RULES.filter((r) => !have.has(r.instruction.trim()));
  if (missing.length === 0) return 0;
  await prisma.customRule.createMany({
    data: missing.map((r) => ({
      clinicId,
      category: r.category,
      rawInput: "(regra recomendada padrao)",
      instruction: r.instruction,
      clarifyingQuestion: null,
      status: "active",
    })),
  });
  return missing.length;
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
