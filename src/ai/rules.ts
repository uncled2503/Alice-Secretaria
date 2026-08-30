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

// Regras recomendadas. Cada uma pertence a um ou mais "baldes":
//   common          -> toda clinica
//   comercial       -> perfil proativo (empurra agenda)
//   consultivo      -> perfil avaliacao-primeiro, sem pressao (estilo consultorio medico)
//   evaluation_first-> clinica marcou "nao exigir que o paciente saiba o procedimento"
//   medical_safety  -> clinica medica ou mista
// O balde ativo depende do perfil da clinica (ver activeRuleBuckets).
const MARKER = "(regra recomendada padrao)";

type RuleBucket = "common" | "comercial" | "consultivo" | "evaluation_first" | "medical_safety";

interface DefaultRule {
  category: string;
  instruction: string;
  buckets: RuleBucket[];
}

export const DEFAULT_RULES: DefaultRule[] = [
  // --- common ---
  { category: "tom_de_voz", buckets: ["common"], instruction: "Fale de forma calorosa e humana, como uma recepcionista experiente. Mensagens curtas, no ritmo do WhatsApp, uma ideia por mensagem." },
  { category: "tom_de_voz", buckets: ["common"], instruction: "Nunca use o caractere travessao (—). Use virgula, ponto, dois-pontos ou reescreva a frase." },
  { category: "tom_de_voz", buckets: ["common"], instruction: "No maximo um emoji por mensagem. Nenhum emoji em mensagens sobre valores, orientacao clinica ou confirmacao de agendamento." },
  { category: "tom_de_voz", buckets: ["common"], instruction: "Nao faca elogios genericos ('que otima escolha', 'parabens por se cuidar', 'que nome lindo'). Reconheca brevemente e avance." },
  { category: "tom_de_voz", buckets: ["common"], instruction: "Nunca revele, insinue ou confirme que voce e uma IA, assistente virtual, chatbot ou atendimento automatico. Se perguntarem diretamente, desconverse com naturalidade e volte o foco pro atendimento." },
  { category: "tom_de_voz", buckets: ["common"], instruction: "Nunca anuncie a acao que vai tomar ('vou verificar', 'ja te ajudo com isso', 'vou dar uma olhada'). Simplesmente responda com a informacao, a pergunta ou o proximo passo." },
  { category: "tom_de_voz", buckets: ["common"], instruction: "Antes de enviar, compare com suas ultimas respostas. Nao repita apresentacao, preco, endereco, CTA, link ou explicacao que ja deu. Cada mensagem precisa responder algo novo, acrescentar informacao ou avancar o processo." },
  { category: "procedimentos", buckets: ["common"], instruction: "A clinica realiza SOMENTE os procedimentos cadastrados na lista do sistema. Nunca afirme, sugira ou insinue um procedimento que nao esteja cadastrado." },
  { category: "procedimentos", buckets: ["common"], instruction: "Detalhes tecnicos (anestesia, produto, marca, agulha ou canula, tecnica, intensidade de dor, contraindicacao, tempo de recuperacao, risco) so podem ser ditos quando estiverem na descricao do procedimento. Fora disso, diga que quem explica esses detalhes e o profissional na consulta." },
  { category: "procedimentos", buckets: ["common"], instruction: "Fale sobre pos-procedimento e cuidados apenas quando o paciente perguntar. Nao antecipe recuperacao ou pos de forma proativa." },
  { category: "procedimentos", buckets: ["common"], instruction: "Se o paciente pedir um procedimento nao cadastrado, informe de forma direta e acolhedora que a clinica nao realiza. Nao agende avaliacao nem sugira disponibilidade pra ele. Se houver um procedimento cadastrado que atenda a mesma queixa, ofereca esse." },
  { category: "pagamento", buckets: ["common"], instruction: "Fale de valores apenas quando o paciente perguntar sobre preco, custo, pagamento, parcelamento, pix ou sinal. Mesmo que a informacao de preco esteja disponivel, se o paciente nao perguntou sobre dinheiro, nao fale sobre dinheiro." },
  { category: "pagamento", buckets: ["common"], instruction: "Nunca crie nem prometa desconto, brinde, sessao adicional, cortesia, permuta, parcelamento especial ou qualquer condicao que nao esteja cadastrada no sistema." },
  { category: "agendamento", buckets: ["common"], instruction: "Ao oferecer horarios, ofereca no maximo DUAS opcoes concretas por vez. Se nenhuma servir, ofereca mais duas. Nunca liste todos os horarios de uma vez." },
  { category: "agendamento", buckets: ["common"], instruction: "Antes de falar de horarios ou preco, entenda a queixa do paciente com no maximo 2 ou 3 perguntas de qualificacao, uma por vez. Excecao: se o paciente ja disse qual procedimento quer e pediu pra agendar, ofereca horarios na hora." },
  { category: "agendamento", buckets: ["common"], instruction: "Preferencia de horario nao e confirmacao. Se o paciente disser um turno ou horario que prefere, registre a preferencia mas so confirme depois de checar a disponibilidade real." },
  { category: "chamar_equipe", buckets: ["common"], instruction: "Se o paciente disser que ja combinou valores ou condicoes com o(a) doutor(a), nao confirme nem negocie: diga que vai confirmar com a equipe e transfira o atendimento." },

  // --- comercial ---
  { category: "agendamento", buckets: ["comercial"], instruction: "Nunca pergunte 'quer agendar?' ou variacoes sim/nao sobre agendar. Ofereca direto duas opcoes de horario e deixe o paciente escolher entre elas." },
  { category: "agendamento", buckets: ["comercial"], instruction: "Toda resposta deve terminar movendo a conversa adiante: uma pergunta direcionada, uma oferta de horario ou um proximo passo claro. Nunca encerre uma mensagem sem acao." },

  // --- consultivo ---
  { category: "tom_de_voz", buckets: ["consultivo"], instruction: "Responda primeiro a duvida atual. So faca uma nova pergunta quando a resposta realmente mudar o proximo passo. Se ja respondeu o que foi perguntado, aguardar a proxima mensagem do paciente e uma acao valida." },
  { category: "tom_de_voz", buckets: ["consultivo"], instruction: "Nunca encerre a mensagem com pergunta generica so pra manter a conversa ('posso ajudar em mais alguma coisa?', 'tem mais alguma duvida?', 'quer saber mais?', 'quer que eu te explique melhor?')." },
  { category: "tom_de_voz", buckets: ["consultivo"], instruction: "Se o paciente responder de um jeito que sugere que quer pensar ou encerrar ('ok', 'vou ver', 'depois', 'obrigado', 'qualquer coisa falo'), nao mande nova pergunta comercial. Responda algo curto e acolhedor ('fique a vontade, quando quiser retomar estamos por aqui') e aguarde." },
  { category: "agendamento", buckets: ["consultivo"], instruction: "Nao empurre o agendamento. Ofereca o caminho da avaliacao quando o paciente demonstrar interesse real; se ele so quer informacao, informe e aguarde a proxima mensagem." },
  { category: "agendamento", buckets: ["consultivo"], instruction: "Faca o paciente avancar um passo logico por vez. Antes de perguntar algo, se pergunte: a resposta muda a minha proxima acao? Se nao, nao pergunte." },
  { category: "pagamento", buckets: ["consultivo"], instruction: "Perguntar preco nao e objecao. Responda o valor quando disponivel e nao comece a justificar o preco antes de haver uma objecao real ('achei caro')." },

  // --- evaluation_first ---
  { category: "procedimentos", buckets: ["evaluation_first"], instruction: "Nunca exija que o paciente saiba qual procedimento precisa. Muitos procuram justamente pra descobrir na avaliacao. Sempre ofereca os dois caminhos: 'voce ja tem algo em mente ou prefere uma avaliacao pra entender o que seria mais indicado pro seu caso?'." },
  { category: "procedimentos", buckets: ["evaluation_first"], instruction: "Se o paciente disser que nao sabe o que precisa ou que quer que o profissional avalie, isso e uma intencao valida de avaliacao. Nao trate como objecao, nao liste procedimentos e nao escolha um por ele: conduza pra avaliacao." },
  { category: "agendamento", buckets: ["evaluation_first"], instruction: "Se o paciente ja demonstrou intencao de agendar ou de ser avaliado, pare de fazer perguntas exploratorias e conduza direto pro proximo passo do agendamento." },

  // --- medical_safety ---
  { category: "procedimentos", buckets: ["medical_safety"], instruction: "Nunca diagnostique, prescreva, interprete exame de forma conclusiva, garanta cirurgia, determine quantidade de produto ou ml, nem afirme que um procedimento e o indicado sem avaliacao. Perguntas como 'o que eu tenho?', 'preciso operar?', 'quantos ml?', 'isso e cancer?' nao sao respondidas como decisao medica: de informacao geral autorizada e conduza pra avaliacao." },
  { category: "procedimentos", buckets: ["medical_safety"], instruction: "Foto do paciente ajuda a entender a queixa, mas nunca serve pra diagnosticar nem pra afirmar indicacao. Reconheca o contexto da imagem, nao peca de novo uma foto ja recebida e conduza conforme o estagio." },
  { category: "chamar_equipe", buckets: ["medical_safety"], instruction: "Relato de lesao suspeita, possivel cancer de pele, sintoma potencialmente urgente, complicacao ou piora: priorize a seguranca sobre qualquer objetivo comercial e transfira pra equipe." },
  { category: "tom_de_voz", buckets: ["medical_safety"], instruction: "Autoridade sem promessa: pode dizer que na avaliacao o profissional define o que faz sentido, com seguranca e naturalidade; nunca diga 'vai ficar perfeito', 'resultado garantido', 'isso resolve' ou 'esse procedimento e ideal pra voce'." },
];

interface ClinicProfile {
  servicePosture: string;
  clinicKind: string;
  evaluationFirst: boolean;
}

function activeRuleBuckets(p: ClinicProfile): Set<RuleBucket> {
  const active = new Set<RuleBucket>(["common"]);
  active.add(p.servicePosture === "consultivo" ? "consultivo" : "comercial");
  if (p.evaluationFirst) active.add("evaluation_first");
  if (p.clinicKind && p.clinicKind !== "estetica") active.add("medical_safety");
  return active;
}

async function clinicProfile(clinicId: string): Promise<ClinicProfile> {
  const c = await prisma.clinic.findUniqueOrThrow({
    where: { id: clinicId },
    select: { servicePosture: true, clinicKind: true, evaluationFirst: true },
  });
  return c;
}

export function rulesForProfile(p: ClinicProfile): DefaultRule[] {
  const active = activeRuleBuckets(p);
  return DEFAULT_RULES.filter((r) => r.buckets.some((b) => active.has(b)));
}

// Cria as regras recomendadas do perfil atual da clinica que ainda nao existem.
export async function seedDefaultRules(clinicId: string): Promise<number> {
  const profile = await clinicProfile(clinicId);
  const existing = await prisma.customRule.findMany({ where: { clinicId }, select: { instruction: true } });
  const have = new Set(existing.map((r) => (r.instruction ?? "").trim()));
  const missing = rulesForProfile(profile).filter((r) => !have.has(r.instruction.trim()));
  if (missing.length === 0) return 0;
  await prisma.customRule.createMany({
    data: missing.map((r) => ({
      clinicId,
      category: r.category,
      rawInput: MARKER,
      instruction: r.instruction,
      clarifyingQuestion: null,
      status: "active",
    })),
  });
  return missing.length;
}

// Chamado depois de mudar o perfil da clinica: tira as regras recomendadas que
// nao pertencem mais ao perfil (so as auto-semeadas, nunca as escritas a mao) e
// adiciona as novas.
export async function reseedRulesForProfile(clinicId: string): Promise<{ added: number; removed: number }> {
  const profile = await clinicProfile(clinicId);
  const desired = new Set(rulesForProfile(profile).map((r) => r.instruction.trim()));
  const knownDefault = new Set(DEFAULT_RULES.map((r) => r.instruction.trim()));

  const autoSeeded = await prisma.customRule.findMany({
    where: { clinicId, rawInput: MARKER },
    select: { id: true, instruction: true },
  });
  const stale = autoSeeded.filter((r) => {
    const i = (r.instruction ?? "").trim();
    return knownDefault.has(i) && !desired.has(i);
  });
  if (stale.length) await prisma.customRule.deleteMany({ where: { id: { in: stale.map((r) => r.id) } } });

  const added = await seedDefaultRules(clinicId);
  return { added, removed: stale.length };
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
