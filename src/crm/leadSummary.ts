import OpenAI from "openai";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { scheduleLocked } from "../jobs/lock.js";
import { prisma } from "../db/client.js";
import { FREE_PLAN } from "./plan.js";
import { formatDayInZone, isoDateInZone, zonedWallClockToUtc } from "../scheduling/time.js";

// ---------------------------------------------------------------------------
// RESUMO DO LEAD NO CRM
//
// Um robo le a conversa e preenche, no card do lead: o que a pessoa queria,
// qual procedimento interessou e um resumo curto. A equipe abre o card e
// entende o caso sem reler o historico inteiro.
//
// Duas travas importantes:
//   1. So registra o que o PACIENTE falou. O que a Alice respondeu e ignorado
//      - senao o resumo vira eco do proprio script de vendas.
//   2. Campo sem informacao clara fica VAZIO. Nada de preencher por dedução.
//
// Custo: roda so quando a conversa esfria (ninguem fala ha alguns minutos) e
// so se entrou mensagem nova depois do ultimo resumo. Assim cada rodada de
// conversa gera ~1 chamada, em vez de uma por mensagem.
// ---------------------------------------------------------------------------

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60_000, maxRetries: 1 });
const MODEL = process.env.OPENAI_CRM_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";

const QUIET_MINUTES = 10; // conversa precisa estar parada ha esse tanto
const LOOKBACK_HOURS = 48; // ate onde procurar conversa com novidade
const MAX_PER_RUN = 40; // teto de conversas por clinica por rodada
const MAX_MESSAGES = 30; // ultimas mensagens lidas de cada conversa

const saveTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "salvar_resumo",
    description: "Salva o resumo do lead no CRM.",
    parameters: {
      type: "object",
      properties: {
        motivo_contato: {
          type: "string",
          description:
            'Uma frase curta com o que a pessoa REALMENTE quer resolver - a necessidade de fundo, nao a primeira frase que ela digitou. Ex: "Quer emagrecer, ja tentou varias dietas sem manter o resultado.", "Quer saber valores do botox." Vazio se nao ficou claro.',
        },
        procedimento_interesse: {
          type: "string",
          description:
            "O que ela quer tratar, separado por virgula. Use o nome do procedimento quando ela citar um; quando ela so falar do objetivo ou da queixa, registre isso mesmo (ex: emagrecimento, menopausa, flacidez, queda de cabelo). Vazio so se nao der pra saber o que ela quer tratar.",
        },
        resumo_conversa: {
          type: "string",
          description:
            "Resumo em TERCEIRA PESSOA e texto corrido, como quem conta o caso pra um colega. Nunca copie as frases da pessoa nem escreva em primeira pessoa. Inclua queixa, ha quanto tempo, o que ja tentou, duvidas, objecoes e se demonstrou interesse em agendar.",
        },
        urgencia: {
          type: "string",
          enum: ["agora", "este_mes", "depois", ""],
          description: "Quando a PESSOA disse que pretende fazer: 'agora' (quer comecar ja/essa semana), 'este_mes', 'depois' (mais pra frente, vai pensar, sem data). Vazio se ela nao falou nada sobre prazo.",
        },
        objecoes: {
          type: "string",
          description: "Objecoes que a pessoa levantou, separadas por virgula, usando SO estas palavras: preco, medo, dor, tempo, indecisao. Vazio se nenhuma.",
        },
        procedimentos_recusados: {
          type: "string",
          description: "Procedimentos que a pessoa disse CLARAMENTE que nao quer fazer (ex.: 'nao quero botox'), separados por virgula. Vazio se nenhum.",
        },
        profissional_preferida: { type: "string", description: "Profissional que a pessoa pediu/prefere atender com. Vazio se nao disse." },
        periodo_preferido: {
          type: "string",
          enum: ["manha", "tarde", "noite", ""],
          description: "Periodo do dia que a pessoa disse que prefere pra ser atendida. Vazio se nao disse.",
        },
        dias_preferidos: { type: "string", description: "Dias da semana que a pessoa disse que funcionam (texto curto, ex.: 'terca e quinta'). Vazio se nao disse." },
        sem_interesse: {
          type: "boolean",
          description: "true SOMENTE se a pessoa disse de forma clara que NAO tem (mais) interesse / nao quer mais. Duvida ou 'vou pensar' NAO e falta de interesse.",
        },
        retorno_data: {
          type: "string",
          description: "Data (AAAA-MM-DD) em que a PESSOA pediu pra ser chamada de novo (ex.: 'me chama depois do dia 20', 'mes que vem', 'sexta'). Resolva a data usando o dia de hoje informado no inicio da conversa. Vazio se ela nao pediu.",
        },
        retorno_motivo: { type: "string", description: "Em poucas palavras, o que ela pediu (ex.: 'depois do dia 20, vai receber o salario'). Vazio se nao ha retorno." },
      },
      required: [],
    },
  },
};

const SYSTEM_PROMPT = `Voce le a conversa entre a atendente de uma clinica e um paciente pelo WhatsApp e registra no CRM o que o PACIENTE queria.

Regras:
- Use SOMENTE o que o paciente falou. Ignore completamente as falas da atendente - o resumo nao pode virar eco do script de vendas dela.
- NUNCA invente, deduza ou complete informacao. Se um campo nao esta claro na conversa, deixe ele vazio ("").
- motivo_contato: uma unica frase curta com a necessidade de fundo. Nao se prenda a primeira mensagem ("quero informacoes") - olhe a conversa inteira pra achar o que ela realmente quer resolver.
- procedimento_interesse: o procedimento citado; se ela so falou do objetivo/queixa (emagrecer, menopausa, flacidez), registre isso.
- resumo_conversa: terceira pessoa, texto corrido, sem listas e sem quebra de linha. Nunca copie as frases dela nem escreva em primeira pessoa.
- Se a conversa nao tem conteudo util (so "oi", so audio sem transcricao, so emoji), devolva todos os campos vazios.

EXEMPLOS DE RESUMO BOM:
"Procura emagrecimento ha cerca de 3 anos. Ja tentou low carb, jejum e academia, mas perde poucos quilos e recupera depois. Relata estar na menopausa e acredita que isso atrapalha o resultado. Perguntou o valor da consulta, achou caro no momento e disse que vai pensar e retornar na semana seguinte."
"Quer tratar manchas no rosto que apareceram depois da gravidez. Nunca fez procedimento estetico antes e perguntou se precisa de avaliacao antes de comecar. Demonstrou interesse em agendar."

EXEMPLO DE RESUMO RUIM (nunca faca assim - e copia das falas, em primeira pessoa):
"Vi o video de voces no instagram. Meu peso, ja tentei de tudo. Ta caro pra mim agora."

PERFIL COMERCIAL (preencha SO com o que a PESSOA disse; na duvida, deixe vazio): urgencia (quando pretende fazer), objecoes (preco, medo, dor, tempo, indecisao), procedimentos que ela recusou, profissional/periodo/dias que prefere, sem_interesse (so se ela disse claramente que nao quer mais) e retorno_data (quando ela pediu pra ser chamada de novo; use o dia de hoje que vem no inicio da conversa pra resolver 'depois do dia 20', 'mes que vem', 'sexta').

Chame sempre a ferramenta salvar_resumo.`;

interface Summary {
  contactReason: string;
  interestNote: string;
  conversationSummary: string;
  // Perfil comercial (so o que a pessoa disse)
  urgency: string;
  objections: string;
  refusedProcedures: string;
  preferredProfessional: string;
  preferredPeriod: string;
  preferredDays: string;
  noInterest: boolean;
  callbackDate: string; // AAAA-MM-DD ou ""
  callbackNote: string;
}

const URGENCY = new Set(["agora", "este_mes", "depois"]);
const PERIODS = new Set(["manha", "tarde", "noite"]);
const OBJECTIONS = new Set(["preco", "medo", "dor", "tempo", "indecisao"]);

// Normaliza o que o modelo devolveu: so valores conhecidos entram.
export function cleanObjections(raw: string): string {
  // sem acento ("preço" -> "preco"): o modelo as vezes devolve com acento mesmo pedindo sem
  const norm = (x: string) => x.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").trim();
  return [...new Set(raw.split(/[,;]/).map(norm).filter((x) => OBJECTIONS.has(x)))].join(",");
}

// "AAAA-MM-DD" -> instante (10h no fuso da clinica), ou null se invalida/no passado.
export function callbackInstant(date: string, timeZone: string, now = new Date()): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const at = zonedWallClockToUtc(timeZone, y, mo, d, 10, 0);
  if (Number.isNaN(at.getTime())) return null;
  if (at.getTime() <= now.getTime()) return null; // data que ja passou: nao ha o que agendar
  if (at.getTime() > now.getTime() + 400 * 24 * 3_600_000) return null; // mais de ~13 meses: provavelmente erro
  return at;
}

const clean = (v: unknown) => (typeof v === "string" ? v.trim() : "");

// Le uma conversa e devolve o resumo. null = nao deu pra resumir.
async function summarizeConversation(conversationId: string, todayLabel: string): Promise<Summary | null> {
  const messages = await prisma.message.findMany({
    where: { conversationId, role: { in: ["user", "assistant", "human"] } },
    orderBy: { createdAt: "desc" },
    take: MAX_MESSAGES,
    select: { role: true, content: true },
  });
  if (messages.length === 0) return null;

  // Sem nenhuma fala do paciente nao ha o que resumir (so a clinica falou).
  if (!messages.some((m) => m.role === "user")) return null;

  const transcript = messages
    .reverse()
    .map((m) => `${m.role === "user" ? "Paciente" : "Atendente"}: ${m.content}`)
    .join("\n")
    .slice(0, 12_000);

  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Hoje e ${todayLabel}.

${transcript}` },
    ],
    tools: [saveTool],
    tool_choice: { type: "function", function: { name: "salvar_resumo" } },
  });

  const call = response.choices[0]?.message?.tool_calls?.[0];
  if (!call || call.type !== "function") return null;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(call.function.arguments || "{}");
  } catch {
    return null;
  }

  return {
    contactReason: clean(raw.motivo_contato),
    interestNote: clean(raw.procedimento_interesse),
    conversationSummary: clean(raw.resumo_conversa),
    urgency: URGENCY.has(clean(raw.urgencia)) ? clean(raw.urgencia) : "",
    objections: cleanObjections(clean(raw.objecoes)),
    refusedProcedures: clean(raw.procedimentos_recusados).slice(0, 200),
    preferredProfessional: clean(raw.profissional_preferida).slice(0, 80),
    preferredPeriod: PERIODS.has(clean(raw.periodo_preferido)) ? clean(raw.periodo_preferido) : "",
    preferredDays: clean(raw.dias_preferidos).slice(0, 80),
    noInterest: raw.sem_interesse === true,
    callbackDate: clean(raw.retorno_data),
    callbackNote: clean(raw.retorno_motivo).slice(0, 160),
  };
}

export interface LeadSummaryRunResult {
  analyzed: number;
  updated: number;
}

export async function runLeadSummaryJob(clinicId: string): Promise<LeadSummaryRunResult> {
  const quietBefore = new Date(Date.now() - QUIET_MINUTES * 60_000);
  const since = new Date(Date.now() - LOOKBACK_HOURS * 3_600_000);

  const clinicRow = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { timezone: true } });
  const tz = clinicRow?.timezone || "America/Sao_Paulo";
  const conversations = await prisma.conversation.findMany({
    where: { patient: { clinicId }, lastMessageAt: { gte: since, lte: quietBefore } },
    orderBy: { lastMessageAt: "desc" },
    take: MAX_PER_RUN * 3,
    select: {
      id: true,
      lastMessageAt: true,
      patient: { select: { id: true, crmSummaryAt: true } },
    },
  });

  // So o que mudou desde o ultimo resumo daquele lead.
  const due = conversations
    .filter((c) => !c.patient.crmSummaryAt || c.lastMessageAt > c.patient.crmSummaryAt)
    .slice(0, MAX_PER_RUN);

  let updated = 0;
  for (const conversation of due) {
    try {
      const summary = await summarizeConversation(conversation.id, `${formatDayInZone(new Date(), tz)} (${isoDateInZone(new Date(), tz)})`);
      // Marca como processado mesmo quando nao deu resumo, pra nao tentar de
      // novo a cada rodada a mesma conversa vazia.
      const data: Record<string, unknown> = { crmSummaryAt: new Date() };
      if (summary) {
        // Campo que voltou vazio nao apaga o que ja estava la: uma conversa
        // nova e curta nao deve zerar o que se sabia do lead.
        if (summary.contactReason) data.contactReason = summary.contactReason;
        if (summary.interestNote) data.interestNote = summary.interestNote;
        if (summary.conversationSummary) data.conversationSummary = summary.conversationSummary;
        if (summary.contactReason || summary.interestNote || summary.conversationSummary) updated += 1;

        // Perfil comercial: tambem so preenche (nunca apaga o que ja se sabia).
        if (summary.urgency) data.urgency = summary.urgency;
        if (summary.objections) data.objections = summary.objections;
        if (summary.refusedProcedures) data.refusedProcedures = summary.refusedProcedures;
        if (summary.preferredProfessional) data.preferredProfessional = summary.preferredProfessional;
        if (summary.preferredPeriod) data.preferredPeriod = summary.preferredPeriod;
        if (summary.preferredDays) data.preferredDays = summary.preferredDays;
        if (summary.noInterest) {
          data.noInterest = true;
          data.noInterestAt = new Date();
        }
        const callbackAt = summary.callbackDate ? callbackInstant(summary.callbackDate, tz) : null;
        // O dia e horario que a Alice combinou na conversa (schedule_recontact) valem mais que o resumo do robo (que so sabe o dia).
        const alreadyAgreed = callbackAt ? await prisma.patient.findFirst({ where: { id: conversation.patient.id, callbackAt: { gt: new Date() } }, select: { id: true } }) : null;
        if (callbackAt && !alreadyAgreed) {
          data.callbackAt = callbackAt;
          data.callbackNote = summary.callbackNote || null;
        }
      }
      await prisma.patient.update({ where: { id: conversation.patient.id }, data });
    } catch (err) {
      console.error(`[crm-resumo] conversa ${conversation.id} falhou:`, err);
    }
  }

  return { analyzed: due.length, updated };
}

export function startLeadSummaryJob(): void {
  // A cada 15min. As conversas so entram depois de esfriar, entao na pratica
  // cada atendimento gera uma chamada quando termina.
  scheduleLocked("resumo-crm", "*/15 * * * *", async () => {
    try {
      const clinics = await prisma.clinic.findMany({
        where: { active: true, plan: { not: FREE_PLAN } },
        select: { id: true, name: true },
      });
      for (const c of clinics) {
        try {
          const r = await runLeadSummaryJob(c.id);
          if (r.updated) console.log(`[crm-resumo] ${c.name}: ${r.updated} card(s) atualizado(s) de ${r.analyzed} conversa(s)`);
        } catch (err) {
          console.error(`[crm-resumo] clinica ${c.id} falhou:`, err);
        }
      }
    } catch (err) {
      console.error("[crm-resumo] job falhou:", err);
    }
  });
}
