import OpenAI from "openai";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { prisma } from "../db/client.js";
import { RULE_CATEGORIES } from "./rules.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

const RULE_CATEGORY_IDS = RULE_CATEGORIES.map((c) => c.id);
const SCRIPT_TYPES = ["primeiro_atendimento", "agendamento", "procedimento", "preco", "objecoes", "remarcacao", "pos_procedimento", "transferir", "livre"];

// Os 4 destinos possiveis pro que o admin digita, na "caixa unica" de ensinar
// a Alice. A IA decide qual bate melhor com o pedido - o admin nao escolhe.
export type TeachTargetType = "rule" | "playbook" | "template" | "faq";

const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "save_rule",
      description:
        "Um comportamento ou restricao que vale SEMPRE, em qualquer conversa: tom de voz, o que pode/nao pode dizer, quando chamar a equipe, politica geral. Ex.: 'nunca use girias', 'sempre confirme o CPF antes de agendar', 'nao fale que e uma IA'.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", enum: RULE_CATEGORY_IDS as unknown as string[] },
          instruction: { type: "string", description: "Instrucao objetiva, na 2a ou 3a pessoa, dizendo exatamente o que a Alice deve fazer." },
        },
        required: ["category", "instruction"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_playbook",
      description:
        "Um ROTEIRO: uma sequencia de passos que a Alice deve seguir numa situacao especifica e recorrente. Use quando o pedido descreve uma ORDEM DE ACOES ('primeiro faca X, depois Y, depois Z') pra uma situacao (ex.: pedido de preco, agendamento, objecao, pos-procedimento).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Nome curto do roteiro, ex: 'Pedido de desconto'." },
          scriptType: { type: "string", enum: SCRIPT_TYPES, description: "Categoria da situacao. Use 'livre' se nenhuma encaixar." },
          triggerText: { type: "string", description: "Quando esse roteiro deve ser usado (o gatilho)." },
          goal: { type: "string", description: "O que a Alice precisa alcancar seguindo esse roteiro." },
          steps: { type: "array", items: { type: "string" }, description: "Os passos, em ordem, um por item." },
        },
        required: ["name", "scriptType", "steps"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_template",
      description:
        "Uma MENSAGEM PRONTA: um texto especifico que a Alice deve mandar quase literalmente num momento certo. Use quando o admin ja der (ou quase der) o TEXTO pronto da mensagem, nao so uma regra de comportamento.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Nome curto pra identificar a mensagem, ex: 'Aviso de atraso'." },
          body: { type: "string", description: "O texto da mensagem, pronto pra usar. Pode usar {primeiro_nome}, {procedimento}, {data_hora} etc. quando fizer sentido." },
          whenToUse: { type: "string", description: "Em que momento da conversa usar essa mensagem." },
          mode: { type: "string", enum: ["exact", "adapt"], description: "'exact' = a Alice manda esse texto quase literalmente; 'adapt' = a Alice usa como referencia de tom e adapta." },
        },
        required: ["name", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_faq",
      description:
        "Uma FAQ: uma pergunta que os clientes fazem, com uma resposta direta e factual. Use quando o pedido e no formato 'se perguntarem X, responda Y' e a resposta e uma informacao fixa (nao uma sequencia de passos nem um texto de mensagem inteiro).",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "A pergunta, como o cliente faria." },
          answer: { type: "string", description: "A resposta oficial, direta." },
          alternates: { type: "string", description: "Outras formas de fazer a mesma pergunta, uma por linha. Opcional." },
        },
        required: ["question", "answer"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_clarification",
      description: "Use quando falta uma informacao concreta e essencial (valor, prazo, nome, texto) pra decidir o destino ou escrever o conteudo.",
      parameters: {
        type: "object",
        properties: { question: { type: "string" } },
        required: ["question"],
      },
    },
  },
];

const SYSTEM_PROMPT = `Voce ajuda a configurar a Alice, assistente de atendimento no WhatsApp de um negocio (clinica, loja ou servico).
O admin descreve, em linguagem natural, algo que quer ensinar pra Alice. Sua tarefa e decidir o DESTINO certo pra isso e montar o conteudo, chamando UMA destas ferramentas:

- save_rule: comportamento/restricao que vale SEMPRE, em qualquer conversa (tom de voz, o que pode/nao pode dizer, quando chamar a equipe).
- save_playbook (roteiro): uma SEQUENCIA DE PASSOS pra uma situacao especifica e recorrente. Pistas: o pedido descreve uma ordem de acoes ("primeiro... depois... por fim...").
- save_template (mensagem pronta): um TEXTO ESPECIFICO que a Alice deve mandar quase literalmente num momento certo. Pistas: o admin ja escreveu (ou quase escreveu) o texto da mensagem.
- save_faq: uma PERGUNTA E RESPOSTA direta e factual. Pistas: formato "se perguntarem X, diga Y", resposta curta e factual, sem sequencia de passos.
- ask_clarification: só quando faltar algo concreto e essencial (valor, prazo, nome, texto) - nao pergunte por excesso de cautela.

Categorias de regra disponiveis: ${RULE_CATEGORIES.map((c) => `${c.id} (${c.label})`).join(", ")}.
Tipos de roteiro disponiveis: ${SCRIPT_TYPES.join(", ")}.

Prefira SEMPRE decidir e chamar uma ferramenta de salvar. So use ask_clarification quando really faltar informacao essencial.`;

export interface TeachDraftResult {
  status: "draft" | "needs_clarification";
  targetType: TeachTargetType | null;
  payload: Record<string, unknown> | null;
  clarifyingQuestion: string | null;
}

async function draftFromText(rawInput: string): Promise<TeachDraftResult> {
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
    return { status: "needs_clarification", targetType: null, payload: null, clarifyingQuestion: "Pode detalhar melhor o que você gostaria de ensinar?" };
  }

  const input = JSON.parse(toolCall.function.arguments || "{}");

  if (toolCall.function.name === "ask_clarification") {
    return { status: "needs_clarification", targetType: null, payload: null, clarifyingQuestion: input.question };
  }

  const targetType = ({ save_rule: "rule", save_playbook: "playbook", save_template: "template", save_faq: "faq" } as const)[
    toolCall.function.name as "save_rule" | "save_playbook" | "save_template" | "save_faq"
  ];
  if (!targetType) {
    return { status: "needs_clarification", targetType: null, payload: null, clarifyingQuestion: "Pode detalhar melhor o que você gostaria de ensinar?" };
  }

  return { status: "draft", targetType, payload: input, clarifyingQuestion: null };
}

// Cria a sugestao pendente a partir do texto livre do admin. Fica como
// "draft" (precisa aprovar) ou "needs_clarification" (a IA fez uma pergunta).
export async function createTeachingSuggestion(clinicId: string, rawInput: string) {
  const result = await draftFromText(rawInput);
  return prisma.teachingSuggestion.create({
    data: {
      clinicId,
      rawInput,
      targetType: result.targetType ?? "rule",
      status: result.status,
      clarifyingQuestion: result.clarifyingQuestion,
      payloadJson: result.payload ? JSON.stringify(result.payload) : null,
    },
  });
}

// Aplica a sugestao aprovada: cria o registro de verdade (regra/roteiro/
// mensagem/FAQ) ja ativo, a partir do payload que a IA montou.
export async function approveTeachingSuggestion(id: string) {
  const suggestion = await prisma.teachingSuggestion.findUniqueOrThrow({ where: { id } });
  if (suggestion.status !== "draft") {
    throw new Error("so da pra aprovar sugestoes em rascunho");
  }
  const payload = JSON.parse(suggestion.payloadJson || "{}");

  switch (suggestion.targetType) {
    case "rule": {
      await prisma.customRule.create({
        data: {
          clinicId: suggestion.clinicId,
          rawInput: suggestion.rawInput,
          category: payload.category || "procedimentos",
          instruction: payload.instruction || null,
          status: "active",
        },
      });
      break;
    }
    case "playbook": {
      const steps: string[] = Array.isArray(payload.steps) ? payload.steps : [];
      await prisma.playbook.create({
        data: {
          clinicId: suggestion.clinicId,
          name: payload.name || "Roteiro sem nome",
          scriptType: payload.scriptType || "livre",
          triggerText: payload.triggerText || null,
          goal: payload.goal || null,
          steps: steps.join("\n"),
          active: true,
        },
      });
      break;
    }
    case "template": {
      await prisma.messageTemplate.create({
        data: {
          clinicId: suggestion.clinicId,
          name: payload.name || "Mensagem sem nome",
          body: payload.body || "",
          mode: payload.mode === "exact" ? "exact" : "adapt",
          whenToUse: payload.whenToUse || null,
          active: true,
        },
      });
      break;
    }
    case "faq": {
      await prisma.clinicFaq.create({
        data: {
          clinicId: suggestion.clinicId,
          question: payload.question || "",
          answer: payload.answer || "",
          alternates: payload.alternates || "",
          exactAnswer: false,
          active: true,
        },
      });
      break;
    }
    default:
      throw new Error(`targetType desconhecido: ${suggestion.targetType}`);
  }

  return prisma.teachingSuggestion.update({ where: { id }, data: { status: "approved" } });
}
