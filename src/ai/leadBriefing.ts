import OpenAI from "openai";
import { prisma } from "../db/client.js";
import { scheduleLocked } from "../jobs/lock.js";
import { PAID_CLINIC_WHERE } from "../crm/plan.js";
import { formatDateTimeInZone } from "../scheduling/time.js";
import { automationKindOf } from "./situation.js";
import { aiExtraEnabled } from "./aiSwitch.js";
import { displayProcedureName } from "../clinicaexperts/placeholderProcedure.js";

// ---------------------------------------------------------------------------
// BRIEFING DO LEAD, SEMPRE ATUAL (pedido do dono, 16/10/2026: "a Alice sempre recebe um briefing de cada cliente... quero que seja atualizado sempre
// que achar necessario, pra ela sempre ter as informacoes mais recentes e nao cometer erros").
//
// Duas camadas:
//  1) FATOS AO VIVO (patientFacts): montados do banco a cada uso (agenda, historico de atendimentos, cancelamentos, mensagens automaticas das
//     ultimas 24h, o que a equipe falou, ultimas mensagens, opt-out/sem interesse/retorno combinado). Nunca fica velho.
//  2) MEMORIA DO LEAD (Patient.briefingNotes): notas curtas escritas por IA com o que vale lembrar da conversa (o que quer, restricoes de dia/hora,
//     o que a equipe combinou, "ja foi avaliada", "vai pensar ate sexta", contexto pessoal). Atualizada quando algo relevante acontece (mensagem
//     nova, fala da equipe, agendamento criado/cancelado/remarcado) e por um job de seguranca. Quem manda mensagem (Alice e a revisao de envio)
//     le as duas camadas.
// ---------------------------------------------------------------------------

const MODEL = process.env.OPENAI_CRM_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";
let client: OpenAI | null = null;
const openai = () => (client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30_000, maxRetries: 1 }));

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function ago(from: Date, now: Date): string {
  const min = Math.max(0, Math.round((now.getTime() - from.getTime()) / 60_000));
  if (min < 2) return "agora ha pouco";
  if (min < 90) return `ha ${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `ha ${h}h` : `ha ${Math.round(h / 24)} dias`;
}

export interface PatientFacts {
  patientId: string;
  text: string; // a ficha em texto
  optedOut: boolean;
  noInterest: boolean;
  lastHumanMinutesAgo: number | null; // ha quanto tempo uma PESSOA da equipe falou nesta conversa
  upcomingCount: number;
}

// FATOS AO VIVO de uma pessoa. `clinicId + phone` (envio) ou `patientId` (Alice/job).
export async function patientFacts(ref: { clinicId: string; phone: string } | { patientId: string }, now = new Date()): Promise<PatientFacts | null> {
  const patient =
    "patientId" in ref
      ? await prisma.patient.findUnique({ where: { id: ref.patientId } })
      : await prisma.patient.findUnique({ where: { clinicId_phone: { clinicId: ref.clinicId, phone: ref.phone.replace(/\D/g, "") } } });
  if (!patient) return null;
  const clinic = await prisma.clinic.findUnique({ where: { id: patient.clinicId }, select: { timezone: true, name: true } });
  const tz = clinic?.timezone || "America/Sao_Paulo";

  const [upcoming, past, cancelled, conversation] = await Promise.all([
    prisma.appointment.findMany({
      where: { patientId: patient.id, status: "confirmed", scheduledAt: { gte: now } },
      orderBy: { scheduledAt: "asc" }, take: 5,
      include: { procedure: { select: { name: true } }, professional: { select: { name: true } } },
    }),
    prisma.appointment.findMany({
      where: { patientId: patient.id, scheduledAt: { lt: now }, status: { in: ["completed", "confirmed", "no_show"] } },
      orderBy: { scheduledAt: "desc" }, take: 4,
      include: { procedure: { select: { name: true } } },
    }),
    prisma.appointment.findMany({
      where: { patientId: patient.id, status: "cancelled", scheduledAt: { gte: new Date(now.getTime() - 14 * 86_400_000) } },
      orderBy: { scheduledAt: "desc" }, take: 3,
      include: { procedure: { select: { name: true } } },
    }),
    prisma.conversation.findFirst({ where: { patientId: patient.id }, orderBy: { lastMessageAt: "desc" }, select: { id: true, humanTakeover: true, handoffPending: true } }),
  ]);
  const messages = conversation
    ? (await prisma.message.findMany({
        where: { conversationId: conversation.id, role: { in: ["user", "assistant", "human"] } },
        orderBy: { createdAt: "desc" }, take: 14,
        select: { role: true, content: true, authorName: true, createdAt: true },
      })).reverse()
    : [];

  const lines: string[] = [];
  const first = patient.name?.trim() || "(sem nome)";
  lines.push(`PESSOA: ${first}; etapa do funil: ${patient.funnelStage}; ${patient.adName ? `veio do anuncio "${clip(patient.adName, 50)}"; ` : ""}cadastro ${ago(patient.createdAt, now)}`);
  const flags: string[] = [];
  if (patient.optedOut) flags.push("PEDIU PARA NAO RECEBER MENSAGENS");
  if (patient.noInterest) flags.push("DISSE QUE NAO TEM INTERESSE");
  if (patient.callbackAt && patient.callbackAt > now) flags.push(`pediu retorno combinado para ${formatDateTimeInZone(patient.callbackAt, tz)}`);
  if (conversation?.humanTakeover) flags.push("conversa esta com a EQUIPE (atendimento humano)");
  if (flags.length) lines.push(`ALERTAS: ${flags.join("; ")}`);
  lines.push(
    upcoming.length
      ? `AGENDA (proximos horarios): ${upcoming.map((a) => `${displayProcedureName(a.procedure.name)}${a.professional ? ` com ${a.professional.name}` : ""} em ${formatDateTimeInZone(a.scheduledAt, tz)}${a.patientConfirmed ? " (confirmou)" : ""}`).join(" | ")}`
      : "AGENDA: nenhum horario futuro",
  );
  if (past.length) lines.push(`ATENDIMENTOS ANTERIORES: ${past.map((a) => `${displayProcedureName(a.procedure.name)} em ${formatDateTimeInZone(a.scheduledAt, tz).slice(0, 10)} (${a.status === "completed" ? "concluido" : a.status === "no_show" ? "faltou" : "marcado"})`).join(" | ")}`);
  if (cancelled.length) lines.push(`CANCELADOS NOS ULTIMOS 14 DIAS: ${cancelled.map((a) => `${displayProcedureName(a.procedure.name)} de ${formatDateTimeInZone(a.scheduledAt, tz)}`).join(" | ")}`);

  const autos = messages.filter((m) => automationKindOf(m) && now.getTime() - m.createdAt.getTime() <= 24 * 3_600_000);
  if (autos.length) lines.push(`MENSAGENS AUTOMATICAS QUE ELA JA RECEBEU NAS ULTIMAS 24H: ${autos.map((m) => `${automationKindOf(m)} ${ago(m.createdAt, now)}: "${clip(oneLine(m.content), 70)}"`).join(" | ")}`);

  const lastHuman = [...messages].reverse().find((m) => m.role === "human");
  const lastHumanMinutesAgo = lastHuman ? Math.round((now.getTime() - lastHuman.createdAt.getTime()) / 60_000) : null;
  if (lastHuman) lines.push(`EQUIPE (pessoa de verdade) falou pela ultima vez ${ago(lastHuman.createdAt, now)}: "${clip(oneLine(lastHuman.content), 100)}"`);

  if (messages.length) {
    lines.push(
      "ULTIMAS MENSAGENS (a de baixo e a mais recente):\n" +
        messages.map((m) => `  ${m.role === "user" ? "PESSOA" : m.role === "human" ? "EQUIPE" : automationKindOf(m) ? "AUTOMATICA" : "ALICE"} (${ago(m.createdAt, now)}): ${clip(oneLine(m.content), 140)}`).join("\n"),
    );
  }
  if (patient.briefingNotes?.trim()) lines.push(`MEMORIA DO LEAD (notas atualizadas ${patient.briefingNotesAt ? ago(patient.briefingNotesAt, now) : ""}):\n${patient.briefingNotes.trim()}`);

  return {
    patientId: patient.id,
    text: lines.join("\n"),
    optedOut: patient.optedOut,
    noInterest: patient.noInterest,
    lastHumanMinutesAgo,
    upcomingCount: upcoming.length,
  };
}

// ---------------- memoria do lead (notas escritas pela IA) ----------------

export const NOTES_SYSTEM = `Voce mantem a MEMORIA de um lead/paciente de uma clinica de estetica: notas curtas com o que vale lembrar para NUNCA errar numa proxima mensagem. Receba as notas atuais, a ficha ao vivo (agenda, atendimentos, cancelamentos) e as ultimas mensagens (PESSOA, ALICE, EQUIPE, AUTOMATICA). Responda SO JSON: {"notas": ["...", "..."]}.
Regras:
- No maximo 10 notas, cada uma com ate 150 caracteres, em portugues, frases diretas. Datas no formato dd/mm.
- Guarde so FATOS que a pessoa disse ou que a equipe/agenda confirmou. Nunca invente nem deduza.
- Vale guardar: o que ela quer; restricoes e preferencias de dia/hora/profissional; objecoes; o que a EQUIPE combinou ou prometeu; estado ("ja foi avaliada em 14/10", "cancelou a sessao de 16/10", "vai pensar ate sexta", "so consegue aos sabados"); pedidos ("nao quer promocao"); contexto pessoal util (aniversario, vem por indicacao, amiga interessada).
- Registre tambem o que NAO fazer quando for claro ("nao oferecer avaliacao: ja foi avaliada", "nao mandar pesquisa: reclamou").
- Remova notas que ficaram velhas (horario que ja passou, cancelamento resolvido). Atualize em vez de duplicar.
- Nao repita o que ja esta na ficha ao vivo (agenda e lista de atendimentos); foque no que a ficha NAO mostra.
- Sem nada relevante: {"notas": []}.`;

// PURO: valida o JSON do modelo e devolve o texto das notas ("- ...\n- ...") ou null.
export function parseNotes(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
  } catch {
    return null;
  }
  const list = (data as { notas?: unknown } | null)?.notas;
  if (!Array.isArray(list)) return null;
  const notes = list.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => clip(oneLine(x), 150)).slice(0, 10);
  return notes.map((n) => `- ${n}`).join("\n");
}

const refreshing = new Set<string>();

export type NotesCall = (system: string, user: string) => Promise<string | null>;
const defaultCall: NotesCall = async (system, user) => {
  const res = await openai().chat.completions.create({
    model: MODEL, temperature: 0.1, max_tokens: 500, response_format: { type: "json_object" },
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  });
  return res.choices[0]?.message?.content ?? null;
};

// Atualiza a memoria do lead. `force` = aconteceu algo relevante (agendamento mudou, equipe falou): atualiza mesmo sem mensagem nova.
// Devolve as notas novas, ou null se nao precisou/nao deu (nunca lanca).
export async function refreshBriefingNotes(patientId: string, opts: { force?: boolean; call?: NotesCall } = {}): Promise<string | null> {
  if (refreshing.has(patientId)) return null;
  refreshing.add(patientId);
  try {
    const patient = await prisma.patient.findUnique({ where: { id: patientId }, select: { id: true, briefingNotes: true, briefingNotesAt: true } });
    if (!patient) return null;
    const conversation = await prisma.conversation.findFirst({ where: { patientId }, orderBy: { lastMessageAt: "desc" }, select: { id: true } });
    if (!conversation) return null;
    const msgs = (await prisma.message.findMany({
      where: { conversationId: conversation.id, role: { in: ["user", "assistant", "human"] } },
      orderBy: { createdAt: "desc" }, take: 40,
      select: { role: true, content: true, authorName: true, createdAt: true },
    })).reverse();
    if (msgs.length < 2 && !opts.force) return null;
    const newest = msgs.at(-1)?.createdAt;
    if (!opts.force && patient.briefingNotesAt && newest && newest <= patient.briefingNotesAt) return null; // nada novo desde a ultima atualizacao

    const facts = await patientFacts({ patientId });
    const transcript = msgs
      .map((m) => `${m.role === "user" ? "PESSOA" : m.role === "human" ? "EQUIPE" : automationKindOf(m) ? "AUTOMATICA" : "ALICE"}: ${clip(oneLine(m.content), 260)}`)
      .join("\n");
    const user = `NOTAS ATUAIS:\n${patient.briefingNotes?.trim() || "(nenhuma)"}\n\nFICHA AO VIVO:\n${facts?.text ?? ""}\n\nCONVERSA (a ultima e a mais recente):\n${transcript}`;
    const raw = await (opts.call ?? defaultCall)(NOTES_SYSTEM, user);
    const notes = parseNotes(raw);
    if (notes === null) return null;
    await prisma.patient.update({ where: { id: patientId }, data: { briefingNotes: notes || null, briefingNotesAt: new Date() } });
    return notes;
  } catch (err) {
    console.error("[briefing] falha ao atualizar a memoria do lead:", err instanceof Error ? err.message : err);
    return null;
  } finally {
    refreshing.delete(patientId);
  }
}

// Agenda a atualizacao (agrupa varios eventos seguidos numa so chamada). Nunca lanca; nao segura o processo.
const timers = new Map<string, NodeJS.Timeout>();
export function scheduleBriefingRefresh(patientId: string, opts: { delayMs?: number; force?: boolean } = {}): void {
  if (!aiExtraEnabled("AI_BRIEFING")) return;
  const prev = timers.get(patientId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    timers.delete(patientId);
    void refreshBriefingNotes(patientId, { force: opts.force ?? true });
  }, opts.delayMs ?? 90_000);
  t.unref?.();
  timers.set(patientId, t);
}

// Quando o evento e do agendamento (criar/cancelar/remarcar/importar), a pessoa e achada pelo agendamento.
export function scheduleBriefingRefreshForAppointment(appointmentId: string): void {
  if (!aiExtraEnabled("AI_BRIEFING")) return;
  void prisma.appointment
    .findUnique({ where: { id: appointmentId }, select: { patientId: true } })
    .then((a) => { if (a) scheduleBriefingRefresh(a.patientId, { force: true, delayMs: 20_000 }); })
    .catch(() => undefined);
}

// Seguranca: de tempos em tempos atualiza quem teve conversa nova e ainda nao tem memoria em dia (restart do servidor perde os agendamentos em memoria).
export async function runBriefingJob(): Promise<number> {
  if (!aiExtraEnabled("AI_BRIEFING")) return 0;
  const since = new Date(Date.now() - 3 * 86_400_000);
  const quiet = new Date(Date.now() - 5 * 60_000);
  const convs = await prisma.conversation.findMany({
    where: { lastMessageAt: { gte: since, lte: quiet }, patient: { clinic: PAID_CLINIC_WHERE } },
    orderBy: { lastMessageAt: "desc" },
    take: 60,
    select: { patientId: true, lastMessageAt: true, patient: { select: { briefingNotesAt: true } } },
  });
  const stale = convs.filter((c) => !c.patient.briefingNotesAt || c.patient.briefingNotesAt < c.lastMessageAt).slice(0, 15);
  let n = 0;
  for (const c of stale) {
    if ((await refreshBriefingNotes(c.patientId)) !== null) n++;
  }
  return n;
}

export function startBriefingJob(): void {
  scheduleLocked("memoria-do-lead", "*/20 * * * *", () => runBriefingJob().catch((err) => console.error("[briefing] job:", err)));
}
