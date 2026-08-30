import OpenAI from "openai";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { z } from "zod";
import { prisma } from "../db/client.js";
import { reseedRulesForProfile } from "./rules.js";
import { logActivity } from "../crm/activity.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// Briefing e uma chamada rara (uma por cliente novo) e vale um modelo melhor.
const MODEL = process.env.OPENAI_BRIEFING_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4o";

// ---------------------------------------------------------------------------
// Questionario que o cliente responde. Fonte unica: o painel serve este texto
// no botao "copiar modelo" e docs/briefing-cliente.md e uma copia pra leitura.
// ---------------------------------------------------------------------------
export const BRIEFING_TEMPLATE = `BRIEFING DE CONFIGURACAO — ALICE (secretaria virtual da clinica)

Responda o que souber. Pode deixar em branco o que nao se aplica e escrever em
texto corrido nas secoes de lista. Quanto mais completo, melhor a Alice atende.

== 1. DADOS DA CLINICA ==
- Nome da clinica:
- WhatsApp de atendimento (com DDD):
- Cidade e estado:
- Fuso horario (se nao for de Brasilia):
- Horario de funcionamento (que horas abre / que horas fecha):
- Dias de atendimento (ex: segunda a sexta, sabado ate 13h):
- Numero para receber avisos de agendamento/cancelamento (se quiser):

== 2. ENDERECO(S) ==
Para cada unidade:
- Nome da unidade (ex: Matriz, Unidade Centro):
- Rua, numero, complemento:
- Bairro, cidade, estado, CEP:
- Como chegar / ponto de referencia / estacionamento:

== 3. COMO A ALICE SE APRESENTA ==
- A Alice fala como: ( ) parte da equipe da clinica ( ) secretaria da clinica ( ) secretaria de um profissional
- Se for de um profissional, qual o nome (ex: Dra. Camila Souza):
- Nome pelo qual a secretaria se apresenta (padrao: Alice):
- Area de atuacao da clinica em uma frase (ex: harmonizacao facial, corporal e intima):
- A clinica e: ( ) so estetica  ( ) so medica  ( ) as duas
- Estilo de atendimento: ( ) mais direto/comercial (oferece horario, conduz pra agenda)  ( ) mais consultivo (avaliacao primeiro, sem pressao, no ritmo do paciente)
- O paciente precisa saber qual procedimento quer, ou a clinica prefere que ele passe por avaliacao pra o profissional indicar? (SIM = pode exigir / NAO = sempre oferecer avaliacao)
- A Alice pode usar emojis? (sim/nao)
- Tem link de auto-agendamento (o paciente marca sozinho num site)? Qual?

== 4. TOM DE VOZ E REGRAS ==
- Como voces gostam de falar com o paciente (formal, proximo, leve...):
- A Alice PODE informar preco pelo WhatsApp, ou so na avaliacao?
- Voces exigem sinal/entrada pra confirmar o agendamento? Como funciona (valor, precisa mandar comprovante)?
- O que a Alice NUNCA deve fazer ou dizer:
- Quando a Alice deve chamar uma pessoa da equipe? (ex: pedido de desconto, negociacao, reclamacao, duvida clinica que so o profissional responde, risco medico, paciente pede pra falar com alguem, exames prontos com interesse cirurgico, problema de pagamento):
- Frase que a Alice usa antes de passar pra uma pessoa (ex: "So um instante que ja verifico isso pra voce"):
- Quem assume quando a Alice transfere (nome da pessoa):

== 5. PROCEDIMENTOS / SERVICOS ==
Para CADA procedimento:
- Nome:
- Duracao aproximada:
- Valor (ou "depende de avaliacao"):
- Formas de pagamento (dinheiro, pix, credito, debito):
- Parcela no cartao? Em ate quantas vezes?
- Link de pagamento (se tiver):
- Descricao curta (o que e, pra quem, cuidados que podem ser ditos):
- Queixas/objetivos que atende (ex: "rosto cansado", "flacidez"):
- Beneficios que a Alice pode afirmar:
- Outros nomes que o paciente usa (ex: "botox"):
- Quando o resultado costuma aparecer:

== 6. PRODUTOS VENDIDOS (se houver) ==
- Nome / valor / descricao:

== 7. PROFISSIONAIS ==
Para cada profissional:
- Nome:
- Mini biografia / especialidade:
- Instagram:
- Quais procedimentos realiza:
- Tem horario proprio diferente do da clinica? Qual?

== 8. PERGUNTAS FREQUENTES (operacionais) ==
Responda as que fizerem sentido:
- Tem estacionamento? Como funciona?
- Como e a primeira consulta / avaliacao?
- Aceita convenio/plano de saude?
- Politica de atraso e cancelamento:
- Precisa levar algo (exames, documentos)?
- Atende criancas / gestantes?
- Outras duvidas comuns dos pacientes de voces:

== 9. MENSAGENS ==
- Mensagem de boas-vindas que voces usam (se tiver):
- Mensagem de confirmacao de horario (se tiver):

== 10. AUTOMACOES (a Alice envia sozinha) ==
- Lembrete de consulta: quer? Quantas horas antes (ex: 24h)?
- Recontato de quem sumiu na conversa: quer? Depois de quanto tempo sem responder (ex: 2 dias)?
- Pos-procedimento (cuidados/acompanhamento): quer? Pra quais procedimentos e quantos dias depois?
- Renovacao (retomar contato meses depois pra refazer): quais procedimentos e de quanto em quanto tempo (ex: toxina a cada 6 meses)?
- Mensagem de aniversario: quer? Em que horario?

== 11. ROTEIROS ESPECIFICOS (opcional) ==
- Voces tem um passo a passo especifico pra algum atendimento (primeiro contato, objecao de preco, remarcacao)? Descreva.

== 12. OBSERVACOES LIVRES ==
- Qualquer coisa importante que nao coube acima:
`;

// ---------------------------------------------------------------------------
// Schema do plano estruturado que a IA extrai do briefing respondido.
// Tudo opcional: o applyBriefing preenche defaults e ignora o que faltar.
// ---------------------------------------------------------------------------
const PERSONA = ["team", "clinic_secretary", "professional_secretary"] as const;
const RULE_CATS = ["agendamento", "pagamento", "tom_de_voz", "chamar_equipe", "procedimentos"] as const;
const SCRIPT_TYPES = [
  "primeiro_atendimento", "agendamento", "procedimento", "preco", "objecoes",
  "remarcacao", "pos_procedimento", "transferir", "livre",
] as const;

const num = z.number().finite();
const str = z.string().trim();

export const BriefingPlanSchema = z.object({
  clinic: z
    .object({
      name: str.optional(),
      whatsappPhone: str.optional(),
      timezone: str.optional(),
      workStartHour: num.int().min(0).max(23).optional(),
      workEndHour: num.int().min(0).max(23).optional(),
      workDays: str.optional(), // "1,2,3,4,5" (0=dom..6=sab)
      assistantName: str.optional(),
      assistantPersona: z.enum(PERSONA).optional(),
      assistantPersonaName: str.optional(),
      activityArea: str.optional(),
      handoffPhrase: str.optional(),
      requireDepositProof: z.boolean().optional(),
      notifyPhone: str.optional(),
      notifyEvents: str.optional(), // csv de new_appointment,reschedule,cancel,confirmed,human_handoff
      servicePosture: z.enum(["comercial", "consultivo"]).optional(),
      clinicKind: z.enum(["estetica", "medica", "ambas"]).optional(),
      evaluationFirst: z.boolean().optional(),
      allowEmojis: z.boolean().optional(),
      schedulingLink: str.optional(),
    })
    .default({}),
  locations: z
    .array(
      z.object({
        name: str.default("Unidade principal"),
        street: str.optional(),
        number: str.optional(),
        complement: str.optional(),
        neighborhood: str.optional(),
        city: str.optional(),
        state: str.optional(),
        zipCode: str.optional(),
        arrivalInstructions: str.optional(),
      }),
    )
    .default([]),
  procedures: z
    .array(
      z.object({
        name: str,
        durationMin: num.int().positive().optional(),
        price: num.nonnegative().nullable().optional(),
        priceVariable: z.boolean().optional(),
        paymentMethods: str.optional(), // csv de dinheiro,pix,credito,debito
        offerInstallments: z.boolean().optional(),
        maxInstallments: num.int().min(2).max(24).optional(),
        paymentLink: str.optional(),
        description: str.optional(),
        goals: z.array(str).optional(),
        benefits: z.array(str).optional(),
        aliases: str.optional(), // csv
        resultTimeline: str.optional(),
      }),
    )
    .default([]),
  products: z
    .array(z.object({ name: str, price: num.nonnegative().nullable().optional(), description: str.optional() }))
    .default([]),
  professionals: z
    .array(
      z.object({
        name: str,
        bio: str.optional(),
        instagram: str.optional(),
        procedureNames: z.array(str).optional(),
        workDays: str.optional(),
        workStartHour: num.int().min(0).max(23).optional(),
        workEndHour: num.int().min(0).max(23).optional(),
      }),
    )
    .default([]),
  faqs: z
    .array(
      z.object({
        question: str,
        answer: str,
        alternates: z.array(str).optional(),
        exactAnswer: z.boolean().optional(),
      }),
    )
    .default([]),
  templates: z
    .array(
      z.object({
        name: str,
        body: str,
        mode: z.enum(["adapt", "exact"]).optional(),
        whenToUse: str.optional(),
      }),
    )
    .default([]),
  rules: z.array(z.object({ category: z.enum(RULE_CATS), instruction: str })).default([]),
  playbooks: z
    .array(
      z.object({
        name: str,
        scriptType: z.enum(SCRIPT_TYPES).optional(),
        triggerText: str.optional(),
        goal: str.optional(),
        steps: z.array(str).optional(),
      }),
    )
    .default([]),
  automations: z
    .object({
      reminders: z.array(z.object({ hoursBefore: num.int().positive(), message: str.optional() })).default([]),
      followups: z
        .array(z.object({ afterDays: num.int().positive(), message: str.optional(), repeatMode: z.enum(["every_silence", "once"]).optional() }))
        .default([]),
      postProcedure: z
        .array(
          z.object({
            name: str.default("Pos-procedimento"),
            intervalValue: num.int().positive().default(2),
            intervalUnit: z.enum(["hours", "days"]).default("days"),
            procedureNames: z.array(str).optional(),
            message: str.optional(),
          }),
        )
        .default([]),
      renewals: z
        .array(
          z.object({
            name: str.default("Renovacao"),
            intervalValue: num.int().positive().default(6),
            intervalUnit: z.enum(["months", "years"]).default("months"),
            procedureNames: z.array(str).optional(),
            message: str.optional(),
          }),
        )
        .default([]),
      birthday: z.object({ enabled: z.boolean().default(false), sendHour: num.int().min(0).max(23).optional(), message: str.optional() }).default({ enabled: false }),
    })
    .default({}),
  warnings: z.array(str).default([]),
});

export type BriefingPlan = z.infer<typeof BriefingPlanSchema>;

const DEFAULT_MESSAGES = {
  reminder:
    "Oi {primeiro_nome}! Passando pra lembrar do seu horario de {procedimento} em {data_hora}. Consegue me confirmar sua presenca por aqui?",
  followup:
    "Oi {primeiro_nome}, tudo bem? Vi que nossa conversa ficou pela metade. Quer que eu te ajude a seguir daqui?",
  postProcedure:
    "Oi {primeiro_nome}! Como voce esta se sentindo depois do seu {procedimento}? Qualquer duvida sobre os cuidados, e so me chamar.",
  renewal:
    "Oi {primeiro_nome}! Ja faz um tempinho do seu {procedimento} e costuma ser uma boa hora de renovar. Quer que eu veja um horario pra avaliacao?",
  birthday: "Feliz aniversario, {primeiro_nome}! A equipe da {unidade} te deseja um dia otimo.",
};

const SYSTEM_PROMPT = `Voce configura a Alice, secretaria virtual de WhatsApp de uma clinica de estetica, a partir de um briefing respondido pelo dono da clinica.

Extraia TUDO que der do briefing e chame a ferramenta save_briefing com o plano estruturado.

Regras:
- workDays: string com os dias 0=domingo..6=sabado separados por virgula. "segunda a sexta" = "1,2,3,4,5". "segunda a sabado" = "1,2,3,4,5,6".
- workStartHour/workEndHour: hora inteira (ex: "das 9h as 19h" -> 9 e 19).
- assistantPersona: "team" (parte da equipe), "clinic_secretary" (secretaria da clinica) ou "professional_secretary" (secretaria de um profissional; preencha assistantPersonaName).
- servicePosture: "consultivo" se a clinica quer atendimento sem pressao, avaliacao primeiro, no ritmo do paciente (tipico de consultorio medico/cirurgico); "comercial" se quer atendimento proativo que conduz pra agenda. Na duvida, "comercial".
- clinicKind: "medica" ou "ambas" ativa travas de seguranca medica (nao diagnosticar etc). Use "estetica" so se for exclusivamente estetica nao invasiva.
- evaluationFirst: true se a clinica NAO quer que o paciente precise saber o procedimento antes da consulta.
- allowEmojis: false se a clinica pediu para nao usar emojis.
- schedulingLink: so preencha se houver um link real de auto-agendamento.
- procedures.price: numero em reais, ou null se "depende de avaliacao" (nesse caso priceVariable=true).
- paymentMethods: csv com os valores exatos dinheiro,pix,credito,debito.
- rules: transforme cada instrucao de tom de voz / politica de preco / "nunca fazer" / "quando chamar a equipe" em uma regra objetiva na categoria certa. Instrucoes claras e acionaveis, na 3a pessoa.
- automations: so inclua o que o cliente pediu. Se ele nao especificou a mensagem, deixe message vazio (o sistema usa um padrao). Para pos-procedimento/renovacao, mapeie procedureNames pelos nomes exatos dos procedimentos do briefing (vazio = todos).
- warnings: liste o que ficou ambiguo, incompleto ou que voce nao conseguiu mapear, pra pessoa revisar depois.
- Nao invente valor, prazo, beneficio ou politica que nao esteja no briefing.`;

const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "save_briefing",
      description: "Salva o plano de configuracao extraido do briefing.",
      parameters: {
        type: "object",
        properties: {
          clinic: {
            type: "object",
            properties: {
              name: { type: "string" },
              whatsappPhone: { type: "string" },
              timezone: { type: "string" },
              workStartHour: { type: "integer" },
              workEndHour: { type: "integer" },
              workDays: { type: "string" },
              assistantName: { type: "string" },
              assistantPersona: { type: "string", enum: PERSONA as unknown as string[] },
              assistantPersonaName: { type: "string" },
              activityArea: { type: "string" },
              handoffPhrase: { type: "string" },
              requireDepositProof: { type: "boolean" },
              notifyPhone: { type: "string" },
              notifyEvents: { type: "string" },
              servicePosture: { type: "string", enum: ["comercial", "consultivo"] },
              clinicKind: { type: "string", enum: ["estetica", "medica", "ambas"] },
              evaluationFirst: { type: "boolean" },
              allowEmojis: { type: "boolean" },
              schedulingLink: { type: "string" },
            },
          },
          locations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                street: { type: "string" },
                number: { type: "string" },
                complement: { type: "string" },
                neighborhood: { type: "string" },
                city: { type: "string" },
                state: { type: "string" },
                zipCode: { type: "string" },
                arrivalInstructions: { type: "string" },
              },
              required: ["name"],
            },
          },
          procedures: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                durationMin: { type: "integer" },
                price: { type: ["number", "null"] },
                priceVariable: { type: "boolean" },
                paymentMethods: { type: "string" },
                offerInstallments: { type: "boolean" },
                maxInstallments: { type: "integer" },
                paymentLink: { type: "string" },
                description: { type: "string" },
                goals: { type: "array", items: { type: "string" } },
                benefits: { type: "array", items: { type: "string" } },
                aliases: { type: "string" },
                resultTimeline: { type: "string" },
              },
              required: ["name"],
            },
          },
          products: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" }, price: { type: ["number", "null"] }, description: { type: "string" } },
              required: ["name"],
            },
          },
          professionals: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                bio: { type: "string" },
                instagram: { type: "string" },
                procedureNames: { type: "array", items: { type: "string" } },
                workDays: { type: "string" },
                workStartHour: { type: "integer" },
                workEndHour: { type: "integer" },
              },
              required: ["name"],
            },
          },
          faqs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                question: { type: "string" },
                answer: { type: "string" },
                alternates: { type: "array", items: { type: "string" } },
                exactAnswer: { type: "boolean" },
              },
              required: ["question", "answer"],
            },
          },
          templates: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                body: { type: "string" },
                mode: { type: "string", enum: ["adapt", "exact"] },
                whenToUse: { type: "string" },
              },
              required: ["name", "body"],
            },
          },
          rules: {
            type: "array",
            items: {
              type: "object",
              properties: { category: { type: "string", enum: RULE_CATS as unknown as string[] }, instruction: { type: "string" } },
              required: ["category", "instruction"],
            },
          },
          playbooks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                scriptType: { type: "string", enum: SCRIPT_TYPES as unknown as string[] },
                triggerText: { type: "string" },
                goal: { type: "string" },
                steps: { type: "array", items: { type: "string" } },
              },
              required: ["name"],
            },
          },
          automations: {
            type: "object",
            properties: {
              reminders: {
                type: "array",
                items: { type: "object", properties: { hoursBefore: { type: "integer" }, message: { type: "string" } }, required: ["hoursBefore"] },
              },
              followups: {
                type: "array",
                items: {
                  type: "object",
                  properties: { afterDays: { type: "integer" }, message: { type: "string" }, repeatMode: { type: "string", enum: ["every_silence", "once"] } },
                  required: ["afterDays"],
                },
              },
              postProcedure: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    intervalValue: { type: "integer" },
                    intervalUnit: { type: "string", enum: ["hours", "days"] },
                    procedureNames: { type: "array", items: { type: "string" } },
                    message: { type: "string" },
                  },
                },
              },
              renewals: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    intervalValue: { type: "integer" },
                    intervalUnit: { type: "string", enum: ["months", "years"] },
                    procedureNames: { type: "array", items: { type: "string" } },
                    message: { type: "string" },
                  },
                },
              },
              birthday: {
                type: "object",
                properties: { enabled: { type: "boolean" }, sendHour: { type: "integer" }, message: { type: "string" } },
              },
            },
          },
          warnings: { type: "array", items: { type: "string" } },
        },
        required: [],
      },
    },
  },
];

export interface ParseResult {
  ok: boolean;
  plan?: BriefingPlan;
  error?: string;
}

export async function parseBriefing(text: string): Promise<ParseResult> {
  const clean = text.trim();
  if (clean.length < 40) return { ok: false, error: "O briefing está muito curto. Cole o questionário respondido." };

  let raw: unknown;
  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: clean.slice(0, 24_000) },
      ],
      tools,
      tool_choice: { type: "function", function: { name: "save_briefing" } },
    });
    const call = response.choices[0].message.tool_calls?.[0];
    if (!call || call.type !== "function") return { ok: false, error: "A IA não conseguiu interpretar o briefing. Tente reescrever de forma mais estruturada." };
    raw = JSON.parse(call.function.arguments || "{}");
  } catch (err) {
    console.error("Falha ao interpretar briefing:", err);
    return { ok: false, error: "Erro ao chamar a IA para interpretar o briefing. Tente de novo em instantes." };
  }

  const parsed = BriefingPlanSchema.safeParse(raw);
  if (!parsed.success) {
    console.error("Plano de briefing invalido:", parsed.error.issues);
    return { ok: false, error: "A IA devolveu dados em formato inesperado. Revise o briefing e tente de novo." };
  }
  return { ok: true, plan: parsed.data };
}

export interface ApplyResult {
  created: Record<string, number>;
  skipped: Record<string, number>;
  clinicFields: string[];
  warnings: string[];
}

const norm = (s: string) => s.trim().toLowerCase();

// Aplica o plano na clinica. Aditivo e idempotente: cria o que ainda nao existe
// (casa por nome), atualiza so os campos escalares que o plano trouxe, e nunca
// apaga nada. Seguro re-rodar.
export async function applyBriefing(clinicId: string, plan: BriefingPlan, actorName: string | null): Promise<ApplyResult> {
  const created: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);

  // 1. Campos da clinica
  const c = plan.clinic;
  const clinicData: Record<string, unknown> = {};
  const setIf = (key: string, val: unknown) => {
    if (val !== undefined && val !== "" && val !== null) clinicData[key] = val;
  };
  setIf("name", c.name);
  setIf("whatsappPhone", c.whatsappPhone?.replace(/\D/g, ""));
  setIf("timezone", c.timezone);
  setIf("workStartHour", c.workStartHour);
  setIf("workEndHour", c.workEndHour);
  setIf("workDays", c.workDays);
  setIf("assistantName", c.assistantName);
  setIf("assistantPersona", c.assistantPersona);
  setIf("assistantPersonaName", c.assistantPersonaName);
  setIf("activityArea", c.activityArea);
  setIf("handoffPhrase", c.handoffPhrase);
  if (c.requireDepositProof !== undefined) clinicData.requireDepositProof = c.requireDepositProof;
  setIf("notifyPhone", c.notifyPhone?.replace(/\D/g, ""));
  setIf("notifyEvents", c.notifyEvents);
  setIf("servicePosture", c.servicePosture);
  setIf("clinicKind", c.clinicKind);
  if (c.evaluationFirst !== undefined) clinicData.evaluationFirst = c.evaluationFirst;
  if (c.allowEmojis !== undefined) clinicData.allowEmojis = c.allowEmojis;
  setIf("schedulingLink", c.schedulingLink);
  const clinicFields = Object.keys(clinicData);
  if (clinicFields.length) await prisma.clinic.update({ where: { id: clinicId }, data: clinicData });

  // 2. Enderecos
  const existingLocs = await prisma.clinicLocation.findMany({ where: { clinicId } });
  const locNames = new Set(existingLocs.map((l) => norm(l.name)));
  for (const [i, loc] of plan.locations.entries()) {
    if (locNames.has(norm(loc.name))) { bump(skipped, "enderecos"); continue; }
    await prisma.clinicLocation.create({
      data: {
        clinicId, name: loc.name, order: existingLocs.length + i,
        street: loc.street || null, number: loc.number || null, complement: loc.complement || null,
        neighborhood: loc.neighborhood || null, city: loc.city || null, state: loc.state || null,
        zipCode: loc.zipCode || null, arrivalInstructions: loc.arrivalInstructions || null,
      },
    });
    bump(created, "enderecos");
  }

  // 3. Procedimentos
  const existingProcs = await prisma.procedure.findMany({ where: { clinicId } });
  const procByName = new Map(existingProcs.map((p) => [norm(p.name), p.id]));
  for (const p of plan.procedures) {
    if (procByName.has(norm(p.name))) { bump(skipped, "procedimentos"); continue; }
    const proc = await prisma.procedure.create({
      data: {
        clinicId, name: p.name,
        durationMin: p.durationMin ?? 60,
        price: p.priceVariable ? null : p.price ?? null,
        priceVariable: p.priceVariable ?? false,
        offerInstallments: p.offerInstallments ?? false,
        maxInstallments: p.maxInstallments ?? null,
        paymentMethods: p.paymentMethods ?? "",
        paymentLink: p.paymentLink || null,
        description: p.description || null,
        goals: p.goals?.length ? p.goals.join("\n") : null,
        benefits: p.benefits?.length ? p.benefits.join("\n") : null,
        aliases: p.aliases || null,
        resultTimeline: p.resultTimeline || null,
      },
    });
    procByName.set(norm(p.name), proc.id);
    bump(created, "procedimentos");
  }

  // 4. Produtos
  const existingProducts = await prisma.product.findMany({ where: { clinicId } });
  const productNames = new Set(existingProducts.map((p) => norm(p.name)));
  for (const p of plan.products) {
    if (productNames.has(norm(p.name))) { bump(skipped, "produtos"); continue; }
    await prisma.product.create({ data: { clinicId, name: p.name, price: p.price ?? null, description: p.description || null } });
    bump(created, "produtos");
  }

  // 5. Profissionais
  const existingPros = await prisma.professional.findMany({ where: { clinicId } });
  const proNames = new Set(existingPros.map((p) => norm(p.name)));
  for (const pro of plan.professionals) {
    if (proNames.has(norm(pro.name))) { bump(skipped, "profissionais"); continue; }
    const procIds = (pro.procedureNames ?? [])
      .map((n) => procByName.get(norm(n)))
      .filter((id): id is string => !!id);
    await prisma.professional.create({
      data: {
        clinicId, name: pro.name, bio: pro.bio || null, instagram: pro.instagram || null,
        workDays: pro.workDays || null, workStartHour: pro.workStartHour ?? null, workEndHour: pro.workEndHour ?? null,
        ...(procIds.length ? { procedures: { connect: procIds.map((id) => ({ id })) } } : {}),
      },
    });
    bump(created, "profissionais");
  }

  // 6. FAQ
  const existingFaqs = await prisma.clinicFaq.findMany({ where: { clinicId } });
  const faqQ = new Set(existingFaqs.map((f) => norm(f.question)));
  for (const f of plan.faqs) {
    if (faqQ.has(norm(f.question))) { bump(skipped, "faq"); continue; }
    await prisma.clinicFaq.create({
      data: {
        clinicId, question: f.question, answer: f.answer,
        alternates: f.alternates?.length ? f.alternates.join("\n") : "",
        exactAnswer: f.exactAnswer ?? false,
      },
    });
    bump(created, "faq");
  }

  // 7. Mensagens prontas
  const existingTpls = await prisma.messageTemplate.findMany({ where: { clinicId } });
  const tplNames = new Set(existingTpls.map((t) => norm(t.name)));
  for (const t of plan.templates) {
    if (tplNames.has(norm(t.name))) { bump(skipped, "mensagens_prontas"); continue; }
    await prisma.messageTemplate.create({
      data: { clinicId, name: t.name, body: t.body, mode: t.mode ?? "adapt", whenToUse: t.whenToUse || null },
    });
    bump(created, "mensagens_prontas");
  }

  // 8. Regras — recomendadas do perfil atual + as do briefing
  const { added: seeded } = await reseedRulesForProfile(clinicId);
  if (seeded) created.regras_recomendadas = seeded;
  const existingRules = await prisma.customRule.findMany({ where: { clinicId }, select: { instruction: true } });
  const ruleSet = new Set(existingRules.map((r) => norm(r.instruction ?? "")));
  for (const r of plan.rules) {
    if (!r.instruction || ruleSet.has(norm(r.instruction))) { bump(skipped, "regras"); continue; }
    await prisma.customRule.create({
      data: { clinicId, category: r.category, rawInput: "(via briefing)", instruction: r.instruction, status: "active" },
    });
    ruleSet.add(norm(r.instruction));
    bump(created, "regras");
  }

  // 9. Roteiros
  const existingPbs = await prisma.playbook.findMany({ where: { clinicId } });
  const pbNames = new Set(existingPbs.map((p) => norm(p.name)));
  for (const pb of plan.playbooks) {
    if (pbNames.has(norm(pb.name))) { bump(skipped, "roteiros"); continue; }
    await prisma.playbook.create({
      data: {
        clinicId, name: pb.name, scriptType: pb.scriptType ?? "livre",
        triggerText: pb.triggerText || null, goal: pb.goal || null,
        steps: pb.steps?.length ? pb.steps.join("\n") : "",
      },
    });
    bump(created, "roteiros");
  }

  // 10. Automacoes
  const a = plan.automations;
  const existingReminders = await prisma.reminderRule.findMany({ where: { clinicId } });
  for (const r of a.reminders) {
    if (existingReminders.some((x) => x.hoursBefore === r.hoursBefore)) { bump(skipped, "lembretes"); continue; }
    await prisma.reminderRule.create({ data: { clinicId, hoursBefore: r.hoursBefore, message: r.message || DEFAULT_MESSAGES.reminder } });
    bump(created, "lembretes");
  }

  const existingFups = await prisma.followUpRule.findMany({ where: { clinicId }, orderBy: { order: "asc" } });
  let nextOrder = (existingFups.at(-1)?.order ?? 0) + 1;
  for (const f of a.followups) {
    await prisma.followUpRule.create({
      data: {
        clinicId, order: nextOrder++, name: `Recontato ${f.afterDays}d`,
        afterDays: f.afterDays, afterMinutes: 0,
        message: f.message || DEFAULT_MESSAGES.followup,
        repeatMode: f.repeatMode ?? "every_silence",
      },
    });
    bump(created, "recontatos");
  }

  const existingPP = await prisma.postProcedureRule.findMany({ where: { clinicId } });
  const ppNames = new Set(existingPP.map((x) => norm(x.name)));
  for (const pp of a.postProcedure) {
    if (ppNames.has(norm(pp.name))) { bump(skipped, "pos_procedimento"); continue; }
    const ids = (pp.procedureNames ?? []).map((n) => procByName.get(norm(n))).filter((x): x is string => !!x);
    await prisma.postProcedureRule.create({
      data: {
        clinicId, name: pp.name, message: pp.message || DEFAULT_MESSAGES.postProcedure,
        intervalValue: pp.intervalValue, intervalUnit: pp.intervalUnit, procedureIds: ids.join(","),
      },
    });
    bump(created, "pos_procedimento");
  }

  const existingRn = await prisma.renewalRule.findMany({ where: { clinicId } });
  const rnNames = new Set(existingRn.map((x) => norm(x.name)));
  for (const rn of a.renewals) {
    if (rnNames.has(norm(rn.name))) { bump(skipped, "renovacoes"); continue; }
    const ids = (rn.procedureNames ?? []).map((n) => procByName.get(norm(n))).filter((x): x is string => !!x);
    await prisma.renewalRule.create({
      data: {
        clinicId, name: rn.name, message: rn.message || DEFAULT_MESSAGES.renewal,
        intervalValue: rn.intervalValue, intervalUnit: rn.intervalUnit, procedureIds: ids.join(","),
      },
    });
    bump(created, "renovacoes");
  }

  if (a.birthday.enabled) {
    const existingBd = await prisma.birthdayRule.count({ where: { clinicId } });
    if (existingBd === 0) {
      await prisma.birthdayRule.create({
        data: { clinicId, name: "Aniversario do paciente", message: a.birthday.message || DEFAULT_MESSAGES.birthday, sendHour: a.birthday.sendHour ?? 9 },
      });
      bump(created, "aniversario");
    } else {
      bump(skipped, "aniversario");
    }
  }

  await logActivity({
    clinicId, type: "briefing_applied", area: "clinica",
    title: "Configuração aplicada via briefing",
    description: Object.entries(created).map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(", ") || "sem novidades",
    actorName,
  });

  return { created, skipped, clinicFields, warnings: plan.warnings };
}
