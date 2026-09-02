import OpenAI from "openai";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import cron from "node-cron";
import { prisma } from "../db/client.js";
import { normalizeReply, replySimilarity } from "./alice.js";
import { logActivity } from "../crm/activity.js";

// ---------------------------------------------------------------------------
// APRENDIZADO DA ALICE
// Um robo le as conversas recentes e tira licoes: resposta que um humano deu
// depois de um handoff, erro que a Alice cometeu (loop / cliente frustrado),
// jeito de falar da equipe. Cada licao vira um LearningInsight "pending".
// NADA afeta a Alice ate um humano aprovar no painel - aprovar promove o
// insight pra ClinicFaq / CustomRule de verdade (ou aposenta a regra alvo).
// ---------------------------------------------------------------------------

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// Analise vale um modelo melhor (roda 1x/dia, poucas chamadas).
const MODEL = process.env.OPENAI_LEARNING_MODEL ?? process.env.OPENAI_BRIEFING_MODEL ?? "gpt-4o";

const RULE_CATS = ["agendamento", "pagamento", "tom_de_voz", "chamar_equipe", "procedimentos"] as const;
type Kind = "faq" | "rule" | "style";

interface RawInsight {
  kind: Kind;
  title: string;
  trigger: string;
  suggestion: string;
  category?: string;
  confidence?: number;
}

const MAX_CONVERSATIONS = 60; // teto por rodada/clinica
const MAX_MESSAGES = 40;

function fingerprintOf(trigger: string, suggestion: string): string {
  return normalizeReply(`${trigger} ${suggestion}`).split(" ").slice(0, 30).join(" ");
}

// ---- 1. Analise de UMA conversa -----------------------------------------

const analyzeTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "registrar_licoes",
    description: "Registra as licoes uteis tiradas desta conversa (pode ser vazio).",
    parameters: {
      type: "object",
      properties: {
        licoes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["faq", "rule", "style"] },
              title: { type: "string", description: "resumo curto (max 8 palavras)" },
              trigger: { type: "string", description: "a situacao/pergunta do cliente que dispara isto" },
              suggestion: { type: "string", description: "faq: a resposta pronta. rule: a regra objetiva na 3a pessoa. style: o padrao de tom/frase." },
              category: { type: "string", enum: RULE_CATS as unknown as string[], description: "so pra kind=rule/style" },
              confidence: { type: "number", description: "0 a 1" },
            },
            required: ["kind", "title", "trigger", "suggestion"],
          },
        },
      },
      required: ["licoes"],
    },
  },
};

const ANALYZE_SYSTEM = `Voce revisa UMA conversa de atendimento (cliente x Alice, a assistente virtual, x atendente humano) e extrai licoes REUTILIZAVEIS pra Alice ficar melhor.

Extraia licao quando:
- FAQ: um atendente humano respondeu algo que a Alice nao sabia e que serve pra proximos clientes. Generalize a resposta (sem nome de cliente, sem dado pessoal, sem numero de pedido especifico).
- RULE: a Alice errou (repetiu a mesma resposta, ignorou a pergunta, deu informacao que gerou reclamacao, demorou a transferir) - a licao e "o certo nessa situacao e X", como regra objetiva.
- STYLE: um jeito recorrente de falar do atendente (saudacao, forma de fechar, tom) que a Alice poderia imitar.

REGRAS:
- So licoes que valem pra MUITAS conversas. Nada especifico de um cliente.
- NUNCA inclua nome, telefone, email, endereco, numero de pedido ou valor especifico de uma pessoa.
- Se a conversa nao tem nada digno de virar licao, retorne licoes vazio.
- Maximo 3 licoes por conversa. Prefira 0 a inventar.
- category (pra rule/style): agendamento, pagamento, tom_de_voz, chamar_equipe ou procedimentos.`;

async function analyzeConversation(transcript: string): Promise<RawInsight[]> {
  try {
    const r = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: ANALYZE_SYSTEM },
        { role: "user", content: transcript.slice(0, 12_000) },
      ],
      tools: [analyzeTool],
      tool_choice: { type: "function", function: { name: "registrar_licoes" } },
      temperature: 0.2,
    });
    const call = r.choices[0]?.message?.tool_calls?.[0];
    if (!call || call.type !== "function") return [];
    const parsed = JSON.parse(call.function.arguments || "{}") as { licoes?: RawInsight[] };
    return Array.isArray(parsed.licoes) ? parsed.licoes : [];
  } catch (err) {
    console.error("[learning] analyzeConversation falhou:", err);
    return [];
  }
}

// ---- 2. Deteccao de contradicao com regras existentes -------------------

async function findContradictions(
  clinicId: string,
  insight: { trigger: string; suggestion: string },
): Promise<{ ruleId: string; ruleText: string }[]> {
  const rules = await prisma.customRule.findMany({
    where: { clinicId, status: "active", instruction: { not: null } },
    select: { id: true, instruction: true },
    take: 60,
  });
  if (!rules.length) return [];
  try {
    const r = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: "system",
          content:
            "Voce recebe UMA licao nova e uma lista de regras atuais da Alice (id + texto). Diga quais regras CONTRADIZEM a licao nova (a regra manda fazer o oposto do que a licao aprendeu). Retorne so os ids, separados por virgula. Se nenhuma contradiz, retorne 'nenhuma'. Seja conservador: so aponte contradicao real e direta.",
        },
        {
          role: "user",
          content: `LICAO NOVA:\n"${insight.trigger}" -> "${insight.suggestion}"\n\nREGRAS ATUAIS:\n${rules
            .map((x) => `${x.id}: ${x.instruction}`)
            .join("\n")}`,
        },
      ],
      temperature: 0,
    });
    const answer = r.choices[0]?.message?.content?.trim().toLowerCase() ?? "";
    if (!answer || answer.includes("nenhuma")) return [];
    const ids = new Set(answer.split(/[\s,]+/).filter(Boolean));
    return rules
      .filter((x) => ids.has(x.id.toLowerCase()))
      .map((x) => ({ ruleId: x.id, ruleText: x.instruction ?? "" }));
  } catch (err) {
    console.error("[learning] findContradictions falhou:", err);
    return [];
  }
}

// ---- 3. Grava / deduplica o insight ------------------------------------

async function upsertInsight(
  clinicId: string,
  raw: RawInsight,
  source: string,
  exampleConvId: string | null,
): Promise<"new" | "bumped" | "skipped"> {
  const trigger = (raw.trigger || "").trim().slice(0, 400);
  const suggestion = (raw.suggestion || "").trim().slice(0, 2000);
  if (!suggestion || (raw.confidence !== undefined && raw.confidence < 0.35)) return "skipped";
  const fingerprint = fingerprintOf(trigger, suggestion);

  const existing = await prisma.learningInsight.findMany({
    where: { clinicId, kind: { in: ["faq", "rule", "style"] } },
    select: { id: true, status: true, trigger: true, suggestion: true, evidenceCount: true, fingerprint: true },
    take: 300,
  });
  for (const e of existing) {
    const sim =
      e.fingerprint === fingerprint
        ? 1
        : Math.max(
            replySimilarity(`${trigger} ${suggestion}`, `${e.trigger} ${e.suggestion}`),
            replySimilarity(suggestion, e.suggestion),
          );
    if (sim >= 0.62) {
      // Ja rejeitado antes: respeita o "nao" e nao ressuscita.
      if (e.status === "rejected") return "skipped";
      if (e.status === "pending") {
        await prisma.learningInsight.update({
          where: { id: e.id },
          data: { evidenceCount: { increment: 1 }, lastSeenAt: new Date() },
        });
        return "bumped";
      }
      // status approved: ja virou regra/faq, nao precisa recriar
      return "skipped";
    }
  }

  const category = raw.kind === "rule" || raw.kind === "style"
    ? (RULE_CATS as readonly string[]).includes(raw.category ?? "") ? raw.category : raw.kind === "style" ? "tom_de_voz" : "procedimentos"
    : null;

  await prisma.learningInsight.create({
    data: {
      clinicId,
      kind: raw.kind,
      title: (raw.title || suggestion).trim().slice(0, 120),
      trigger,
      suggestion,
      category,
      source,
      exampleConvId,
      fingerprint,
    },
  });
  return "new";
}

// ---- 4. Roda o job pra uma clinica -----------------------------------

const FAILURE_MARKERS = /repetindo|sem avancar|automatico|ta complicado|nao entendi nada|voce e um rob/i;

export async function runLearningJob(clinicId: string): Promise<{ analyzed: number; created: number; bumped: number }> {
  const since = new Date(Date.now() - 4 * 24 * 60 * 60_000);
  const conversations = await prisma.conversation.findMany({
    where: {
      patient: { clinicId },
      lastMessageAt: { gte: since },
      humanTakeover: true,
    },
    orderBy: { lastMessageAt: "desc" },
    take: MAX_CONVERSATIONS,
    include: {
      patient: { select: { name: true } },
      messages: { orderBy: { createdAt: "asc" }, take: 200 },
    },
  });

  let analyzed = 0;
  let created = 0;
  let bumped = 0;

  for (const c of conversations) {
    const msgs = c.messages.filter((m) => m.role !== "system" || FAILURE_MARKERS.test(m.content));
    const hasHuman = c.messages.some((m) => m.role === "human");
    const hasFailure = c.messages.some((m) => m.role === "system" && FAILURE_MARKERS.test(m.content)) ||
      /repetindo|sem avancar/i.test(c.handoffReason ?? "");
    if (!hasHuman && !hasFailure) continue;

    const transcript = msgs
      .slice(-MAX_MESSAGES)
      .map((m) => {
        const who = m.role === "user" ? "CLIENTE" : m.role === "human" ? "ATENDENTE" : m.role === "assistant" ? "ALICE" : "SISTEMA";
        return `${who}: ${m.content}`;
      })
      .join("\n");
    if (transcript.length < 60) continue;

    analyzed++;
    const raws = await analyzeConversation(transcript);
    for (const raw of raws.slice(0, 3)) {
      const source = raw.kind === "faq" ? "handoff" : raw.kind === "style" ? "style" : "failure";
      const outcome = await upsertInsight(clinicId, raw, source, c.id);
      if (outcome === "new") created++;
      else if (outcome === "bumped") bumped++;

      // Contradicao: so pra licoes de regra/faq novas e com alguma forca.
      if (outcome === "new" && (raw.kind === "rule" || raw.kind === "faq")) {
        const conflicts = await findContradictions(clinicId, raw);
        for (const conf of conflicts) {
          const fp = fingerprintOf("retire", conf.ruleId);
          const dup = await prisma.learningInsight.findFirst({
            where: { clinicId, kind: "retire", targetId: conf.ruleId, status: "pending" },
          });
          if (dup) continue;
          await prisma.learningInsight.create({
            data: {
              clinicId,
              kind: "retire",
              title: `Revisar regra que conflita com um aprendizado`,
              trigger: conf.ruleText.slice(0, 400),
              suggestion: `Esta regra parece conflitar com o aprendizado "${raw.title}". Se o aprendizado estiver certo, remova ou ajuste a regra.`,
              targetType: "rule",
              targetId: conf.ruleId,
              source: "contradiction",
              exampleConvId: c.id,
              fingerprint: fp,
            },
          });
          created++;
        }
      }
    }
  }

  await prisma.clinic.update({ where: { id: clinicId }, data: { learningRunAt: new Date() } });
  return { analyzed, created, bumped };
}

// ---- 5. Aprovar / rejeitar (promove pra regra/faq) --------------------

export async function approveInsight(id: string, editedSuggestion: string | undefined, actorName: string | null): Promise<void> {
  const ins = await prisma.learningInsight.findUniqueOrThrow({ where: { id } });
  if (ins.status !== "pending") return;
  const suggestion = (editedSuggestion ?? ins.suggestion).trim();
  let appliedRefId: string | null = null;

  if (ins.kind === "faq") {
    const faq = await prisma.clinicFaq.create({
      data: {
        clinicId: ins.clinicId,
        question: (ins.trigger || ins.title).slice(0, 300),
        answer: suggestion,
        alternates: "",
        exactAnswer: false,
        active: true,
      },
    });
    appliedRefId = faq.id;
  } else if (ins.kind === "rule" || ins.kind === "style") {
    const category = (RULE_CATS as readonly string[]).includes(ins.category ?? "")
      ? ins.category!
      : ins.kind === "style"
        ? "tom_de_voz"
        : "procedimentos";
    const rule = await prisma.customRule.create({
      data: { clinicId: ins.clinicId, category, rawInput: "(aprendizado da Alice)", instruction: suggestion, status: "active" },
    });
    appliedRefId = rule.id;
  } else if (ins.kind === "retire" && ins.targetType === "rule" && ins.targetId) {
    await prisma.customRule.updateMany({ where: { id: ins.targetId, clinicId: ins.clinicId }, data: { status: "draft" } });
  } else if (ins.kind === "retire" && ins.targetType === "faq" && ins.targetId) {
    await prisma.clinicFaq.updateMany({ where: { id: ins.targetId, clinicId: ins.clinicId }, data: { active: false } });
  }

  await prisma.learningInsight.update({
    where: { id },
    data: { status: "approved", reviewedAt: new Date(), reviewedBy: actorName, appliedRefId, suggestion },
  });
  await logActivity({
    clinicId: ins.clinicId,
    type: "clinic_updated",
    area: "clinica",
    title: "Aprendizado da Alice aprovado",
    description: `${ins.kind === "retire" ? "Aposentou conhecimento" : "Virou " + (ins.kind === "faq" ? "FAQ" : "regra")}: ${ins.title}`,
    actorName,
  });
}

export async function rejectInsight(id: string, actorName: string | null): Promise<void> {
  await prisma.learningInsight.updateMany({
    where: { id, status: "pending" },
    data: { status: "rejected", reviewedAt: new Date(), reviewedBy: actorName },
  });
}

// ---- 6. Cron diario -------------------------------------------------

export function startLearningJob(): void {
  // 04:10 todo dia. Roda clinica por clinica com pausa, sem travar o processo.
  cron.schedule("10 4 * * *", async () => {
    try {
      const clinics = await prisma.clinic.findMany({ where: { active: true }, select: { id: true, name: true } });
      for (const c of clinics) {
        try {
          const r = await runLearningJob(c.id);
          if (r.created || r.bumped) console.log(`[learning] ${c.name}: ${r.created} novo(s), ${r.bumped} reforcado(s) de ${r.analyzed} conversas`);
        } catch (err) {
          console.error(`[learning] clinica ${c.id} falhou:`, err);
        }
        await new Promise((res) => setTimeout(res, 2000));
      }
    } catch (err) {
      console.error("[learning] job diario falhou:", err);
    }
  });
}
