import OpenAI from "openai";
import { safeFetch } from "../ai/wellFormed.js";
import { prisma } from "../db/client.js";
import { recordUsage } from "../ai/usageStats.js";
import { safeSlice } from "../ai/wellFormed.js";
import { parseCategory, vetoStands, type VetoCategory } from "./vetoReasons.js";
import { REVISION } from "../version.js";

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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, fetch: safeFetch, timeout: 60_000, maxRetries: 1 });
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
  category?: VetoCategory; // por que NAO recontatar (estruturado)
  ignoredVeto?: boolean; // o juiz disse "nao" so descrevendo o publico da automacao: o "nao" nao vale
}

// Falha TECNICA do juiz (nao e decisao de negocio). `permanent`: a requisicao foi RECUSADA (HTTP 400, ex.: invalid_json) - repetir a mesma requisicao nao adianta, entao a
// etapa espera bem mais antes de tentar de novo (e nunca vira veto nem etapa consumida).
export interface JudgeFailure { why: string; permanent: boolean; status?: number; code?: string }
export const JUDGE_REJECTED_RETRY_MS = 6 * 3_600_000;

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

O PUBLICO do recontato e exatamente quem NAO tem horario marcado, NAO respondeu a mensagem anterior, e um lead novo ou parou de responder depois de pedir agendamento. Esses fatos NAO sao motivo para recontact=false: sao o motivo do recontato. Use recontact=false so pelos motivos acima (consulta ja marcada, recusa, equipe conversando, retorno combinado, reclamacao/assunto sensivel, contato nao comercial, repeticao).

Responda APENAS um JSON: {"recontact": true|false, "categoria": "opt_out|sem_interesse|atendimento_humano|retorno_combinado|reclamacao|assunto_sensivel|nao_comercial|ja_tem_horario|ja_atendida|repeticao|momento_inadequado|outro", "reason": "motivo em ate 15 palavras"}.`;

function formatConversation(input: JudgeInput): string {
  const now = input.now ?? new Date();
  const lines = input.messages.slice(-18).map((m) => {
    const who = m.role === "user" ? "PACIENTE" : m.role === "human" ? "EQUIPE" : m.authorName ? `AUTOMACAO (${m.authorName})` : "ALICE";
    const mins = Math.max(0, Math.round((now.getTime() - m.createdAt.getTime()) / 60_000));
    const ago = mins < 90 ? `${mins} min atras` : mins < 60 * 36 ? `${Math.round(mins / 60)} h atras` : `${Math.round(mins / 1440)} dias atras`;
    return `[${ago}] ${who}: ${safeSlice(m.content.replace(/\s+/g, " "), 300)}`; // (sem partir um emoji no meio: substituto solto faz a OpenAI recusar o corpo)
  });
  const appts = input.appointments.length
    ? input.appointments
        .map((a) => `- ${a.procedure}: ${a.status}, ${a.scheduledAt.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`)
        .join("\n")
    : "(nenhum agendamento)";
  return `Clinica: ${input.clinicName}\nAgendamentos do paciente:\n${appts}\n\nConversa (mais recente por ultimo):\n${lines.join("\n")}`;
}

// Interpreta a resposta do modelo. Veto cujo UNICO motivo e descrever o publico da automacao (sem horario / sem resposta / lead novo / pediu agendamento) nao vale.
export function toVerdict(parsed: { recontact?: unknown; reason?: unknown; categoria?: unknown }): JudgeVerdict | null {
  if (typeof parsed.recontact !== "boolean") return null;
  const reason = typeof parsed.reason === "string" ? safeSlice(parsed.reason, 200) : "";
  const category = parseCategory(parsed.categoria) ?? undefined;
  if (!parsed.recontact) {
    const v = vetoStands(category ?? null, reason);
    if (!v.stands) return { recontact: true, reason: `veto ignorado (${v.why}): ${reason}`, ignoredVeto: true, category };
  }
  return { recontact: parsed.recontact, reason, category };
}

// Uma consulta ao juiz. Separa: veredito (ok) x falha tecnica (temporaria: IA fora do ar/tempo esgotado/resposta ilegivel; permanente: requisicao recusada, HTTP 400).
// NUNCA registra o corpo da requisicao (tem conversa de paciente): so status, codigo, id da requisicao da OpenAI e tamanho.
async function askJudge(system: string, user: string, tag: { clinicId?: string; conversationId?: string; job: string }): Promise<{ ok: true; verdict: JudgeVerdict } | { ok: false; failure: JudgeFailure }> {
  try {
    const res = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    recordUsage("juiz_recontato", res.usage);
    let parsed: { recontact?: unknown; reason?: unknown; categoria?: unknown };
    try {
      parsed = JSON.parse(res.choices[0]?.message?.content ?? "");
    } catch {
      return { ok: false, failure: { why: "resposta da IA ilegivel", permanent: false } };
    }
    const verdict = toVerdict(parsed);
    return verdict ? { ok: true, verdict } : { ok: false, failure: { why: "resposta da IA sem o campo recontact", permanent: false } };
  } catch (err) {
    const e = err as { status?: number; code?: string | null; requestID?: string | null; message?: string } | null;
    const status = typeof e?.status === "number" ? e.status : undefined;
    const permanent = status === 400; // requisicao recusada: repetir o mesmo corpo nao adianta
    console.error(`[${tag.job}] juiz de IA ${permanent ? "RECUSOU a requisicao" : "falhou"} clinica=${tag.clinicId ?? "-"} conversa=${tag.conversationId ?? "-"} status=${status ?? "-"} code=${e?.code ?? "-"} request_id=${e?.requestID ?? "-"} bytes=${user.length + system.length} revisao=${REVISION.split(":")[0]} (o conteudo da conversa nao e registrado)`);
    return { ok: false, failure: { why: permanent ? `requisicao recusada pela IA (HTTP 400${e?.code ? ` ${e.code}` : ""})` : "a IA nao respondeu", permanent, status, code: e?.code ?? undefined } };
  }
}

export async function judgeRecontact(input: JudgeInput, tag: { clinicId?: string; conversationId?: string } = {}): Promise<JudgeVerdict | null> {
  const r = await judgeRecontactDetailed(input, tag);
  return r.ok ? r.verdict : null;
}

export async function judgeRecontactDetailed(input: JudgeInput, tag: { clinicId?: string; conversationId?: string } = {}): Promise<{ ok: true; verdict: JudgeVerdict } | { ok: false; failure: JudgeFailure }> {
  if (process.env.RECONTACT_AI_GATE === "off") return { ok: true, verdict: { recontact: true, reason: "juiz desligado (RECONTACT_AI_GATE=off)" } };
  if (!process.env.OPENAI_API_KEY) return { ok: false, failure: { why: "sem chave da OpenAI", permanent: false } };
  return askJudge(SYSTEM, formatConversation(input), { ...tag, job: "recontato" });
}

// O veredito em cache so vale enquanto o CONTEXTO nao muda (mensagem nova, agendamento, atendimento da equipe, retorno combinado, etapa da cascata) E por
// pouco tempo: o juiz tambem leva em conta o tempo ("respondeu ha pouco", "recontato recente"), entao um "nao" de 4 horas atras nao pode valer para sempre
// (era um dos jeitos de a cascata inteira ficar parada: o primeiro "nao" ficava gravado enquanto a conversa nao tivesse mensagem nova).
export const JUDGE_TTL_MS = 4 * 3_600_000;

export type JudgeResult =
  | { kind: "verdict"; verdict: JudgeVerdict; source: "cache" | "ia" }
  | { kind: "unavailable"; why: string; permanent?: boolean; retryAfterMs?: number }; // falha TECNICA (IA fora do ar, sem chave, resposta ilegivel): nao e decisao de negocio

// Junta o contexto no banco e julga. Reaproveita o veredito so se o contexto (impressao digital + etapa) e o prazo ainda valem.
export async function judgeConversation(
  conversationId: string,
  patientId: string,
  clinicName: string,
  opts: { fingerprint: string; ruleOrder: number; now?: Date; clinicId?: string },
): Promise<JudgeResult> {
  const now = opts.now ?? new Date();
  const stamp = `${opts.fingerprint}#${opts.ruleOrder}`;
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { recontactVerdict: true, recontactReason: true, recontactFingerprint: true, recontactJudgedAt: true },
  });
  if (
    conversation?.recontactVerdict &&
    conversation.recontactFingerprint === stamp &&
    conversation.recontactJudgedAt &&
    now.getTime() - conversation.recontactJudgedAt.getTime() < JUDGE_TTL_MS
  ) {
    return { kind: "verdict", verdict: { recontact: conversation.recontactVerdict === "yes", reason: conversation.recontactReason ?? "" }, source: "cache" };
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
  const lastAt = messages[0]?.createdAt ?? now; // (a lista vem da mais nova para a mais antiga)
  const asked = await judgeRecontactDetailed({
    clinicName,
    messages: messages.reverse(),
    appointments: appointments.map((a) => ({ status: a.status, scheduledAt: a.scheduledAt, procedure: a.procedure.name })),
    now,
  }, { clinicId: opts.clinicId, conversationId });
  // falha TECNICA: nao grava veredito, nao vira veto e nao envia; requisicao recusada espera bem mais (repetir o mesmo corpo nao adianta)
  if (!asked.ok) return { kind: "unavailable", why: asked.failure.why, permanent: asked.failure.permanent, ...(asked.failure.permanent ? { retryAfterMs: JUDGE_REJECTED_RETRY_MS } : {}) };
  const verdict = asked.verdict;

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { recontactVerdict: verdict.recontact ? "yes" : "no", recontactReason: verdict.reason, recontactJudgedFor: lastAt, recontactFingerprint: stamp, recontactJudgedAt: now },
  });
  return { kind: "verdict", verdict, source: "ia" };
}

// ---------------------------------------------------------------------------
// JUIZ DAS RETOMADAS (avaliacao cancelada / avaliacao sem fechamento). Mesma politica do recontato: falha TECNICA da IA nao e decisao de negocio
// (devolve "unavailable" e quem chamou adia), e o veredito nao fica em cache (cada tentativa le a conversa de agora).
// ---------------------------------------------------------------------------
const RESUME_SYSTEM = `Voce decide se a clinica deve mandar uma mensagem de RETOMADA a uma pessoa que cancelou a avaliacao (ou que fez a avaliacao e ainda nao fechou).

A retomada e um convite gentil e sem compromisso para voltar a conversar. Ela NAO deve sair quando seria sem sentido ou incomodo.

Responda recontact=true quando nada na conversa nem nos agendamentos indica que a pessoa nao quer ou nao pode ser contatada.

Responda recontact=false quando:
- a pessoa recusou, disse que nao tem interesse, que ja resolveu por outro canal, que vai procurar outro lugar, ou pediu para parar de receber mensagens;
- ha reclamacao, assunto clinico/sensivel em aberto, ou a pessoa esta doente/internada/passando por um momento dificil;
- a equipe esta conversando com ela agora ou combinou um retorno em outra data;
- ja remarcou ou ja tem atendimento/horario (inclusive por outro caminho);
- e fornecedor, spam, engano ou nao e uma paciente em potencial;
- nao ha informacao suficiente para saber o que aconteceu.
Na duvida, recontact=false.

Nao ter horario marcado, nao ter respondido a ultima mensagem ou ter sumido depois de pedir agendamento e o PUBLICO desta retomada: nao e motivo para recontact=false.

Responda APENAS um JSON: {"recontact": true|false, "categoria": "opt_out|sem_interesse|atendimento_humano|retorno_combinado|reclamacao|assunto_sensivel|nao_comercial|ja_tem_horario|ja_atendida|repeticao|momento_inadequado|outro", "reason": "motivo em ate 15 palavras"}.`;

export async function judgeResumeContact(flow: string, input: { patientId: string; clinicName: string; now?: Date; clinicId?: string }): Promise<JudgeResult> {
  const now = input.now ?? new Date();
  if (process.env.RECONTACT_AI_GATE === "off") return { kind: "verdict", verdict: { recontact: true, reason: "juiz desligado (RECONTACT_AI_GATE=off)" }, source: "ia" };
  if (!process.env.OPENAI_API_KEY) return { kind: "unavailable", why: "sem chave da OpenAI" };
  const [messages, appointments] = await Promise.all([
    prisma.message.findMany({
      where: { conversation: { patientId: input.patientId }, role: { in: ["user", "assistant", "human"] } },
      orderBy: { createdAt: "desc" },
      take: 18,
      select: { role: true, content: true, authorName: true, createdAt: true },
    }),
    prisma.appointment.findMany({ where: { patientId: input.patientId }, orderBy: { scheduledAt: "desc" }, take: 6, select: { status: true, scheduledAt: true, procedure: { select: { name: true } } } }),
  ]);
  const asked = await askJudge(
    RESUME_SYSTEM,
    `Fluxo: ${flow === "avaliacao_cancelada" ? "avaliacao cancelada" : "avaliacao realizada sem fechamento"}\n${formatConversation({ clinicName: input.clinicName, messages: messages.reverse(), appointments: appointments.map((a) => ({ status: a.status, scheduledAt: a.scheduledAt, procedure: a.procedure.name })), now })}`,
    { clinicId: input.clinicId, conversationId: undefined, job: "retomada" },
  );
  if (!asked.ok) return { kind: "unavailable", why: asked.failure.why, permanent: asked.failure.permanent, ...(asked.failure.permanent ? { retryAfterMs: JUDGE_REJECTED_RETRY_MS } : {}) };
  return { kind: "verdict", verdict: asked.verdict, source: "ia" };
}
