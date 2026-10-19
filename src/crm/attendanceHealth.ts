import { prisma } from "../db/client.js";
import { REVISION } from "../version.js";
import { breakerOpen } from "../ai/sendGate.js";
import { STALE_PENDING_MS } from "../ai/delivery.js";
import { classifyConversationTail, UNANSWERED_AFTER_MS } from "./unanswered.js";

// ---------------------------------------------------------------------------
// SAUDE DO ATENDIMENTO (nao so "o servidor esta de pe" nem "o WhatsApp esta conectado"): olha o que aconteceu com as MENSAGENS DAS PESSOAS.
// Separa o que e problema do que nao e:
//   - falhas        mensagem sem resposta POR DEFEITO: a resposta da Alice nao saiu (bloqueada, expirada, numero sem WhatsApp...) ou o processamento falhou
//                   e a conversa ficou sinalizada ("Alice nao conseguiu responder");
//   - aguardando    mensagem sem resposta SEM defeito conhecido: pode ser silencio intencional (so "ok"/"obrigada"), resposta ainda em processamento ou
//                   recado que a Alice deixou pra equipe. So vira atencao depois de 15 min (o mesmo limite do aviso por WhatsApp);
//   - comEquipe     conversa sob responsabilidade de uma pessoa (atendimento assumido): nao e defeito da Alice.
// ---------------------------------------------------------------------------

export const WAITING_AFTER_MS = 5 * 60_000;
const LOOKBACK_MS = 12 * 3_600_000;
const DAY_MS = 24 * 3_600_000;
const FAILURE_FLAG_RE = /^Alice n[aã]o conseguiu responder/i;

export interface AttendanceHealth {
  revision: string;
  checkedAt: string;
  aliceActive: boolean;
  status: "ok" | "atencao" | "problema" | "pausada";
  falhas: { total: number; porMotivo: Record<string, number> };
  aguardando: { total: number; maisAntigaMin: number | null };
  comEquipe: number;
  entrega24h: Record<string, number>; // respostas da Alice que nao estao confirmadas como entregues, por estado
  respostasParadas: number; // "pending"/"sending" sem andamento
  eventos: { falhos: number; parados: number }; // webhook que esgotou as tentativas / esperando ha mais de 5 min
  ultimaRespostaEnviadaEm: string | null;
  revisaoDesligada: boolean; // disjuntor da revisao por IA aberto nesta clinica (as travas deterministicas seguem ligadas)
  motivos: string[];
}

export async function attendanceHealth(clinicId: string, now = new Date()): Promise<AttendanceHealth> {
  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { aliceActive: true } });
  const conversations = await prisma.conversation.findMany({
    where: { archived: false, patient: { clinicId }, lastMessageAt: { gte: new Date(now.getTime() - LOOKBACK_MS) } },
    select: {
      id: true, humanTakeover: true, handoffReason: true,
      messages: { where: { role: { in: ["user", "assistant", "human"] } }, orderBy: { createdAt: "desc" }, take: 6, select: { role: true, createdAt: true, deliveryStatus: true } },
    },
    take: 400,
  });

  const falhas = { total: 0, porMotivo: {} as Record<string, number> };
  let aguardando = 0;
  let oldestWaitingMs = 0;
  let comEquipe = 0;
  for (const c of conversations) {
    const tail = classifyConversationTail(c.messages);
    if (!tail.unanswered || !tail.lastUserAt) continue;
    const waited = now.getTime() - tail.lastUserAt.getTime();
    if (waited < WAITING_AFTER_MS) continue; // ainda dentro do tempo normal de resposta
    if (c.humanTakeover) { comEquipe++; continue; }
    const flagged = FAILURE_FLAG_RE.test(c.handoffReason ?? "");
    if (tail.cause || flagged) {
      falhas.total++;
      const motivo = tail.cause ?? "falha no processamento (conversa sinalizada para a equipe)";
      falhas.porMotivo[motivo] = (falhas.porMotivo[motivo] ?? 0) + 1;
    } else {
      aguardando++;
      oldestWaitingMs = Math.max(oldestWaitingMs, waited);
    }
  }

  const since24 = new Date(now.getTime() - DAY_MS);
  const grouped = await prisma.message.groupBy({
    by: ["deliveryStatus"],
    where: { role: "assistant", authorName: null, createdAt: { gte: since24 }, deliveryStatus: { in: ["failed", "failed_permanent", "blocked", "vetoed", "expired", "unconfirmed"] }, conversation: { patient: { clinicId } } },
    _count: { _all: true },
  });
  const entrega24h: Record<string, number> = {};
  for (const g of grouped) if (g.deliveryStatus) entrega24h[g.deliveryStatus] = g._count._all;

  const [respostasParadas, eventosFalhos, eventosParados, lastSent] = await Promise.all([
    prisma.message.count({ where: { role: "assistant", authorName: null, deliveryStatus: { in: ["pending", "sending"] }, createdAt: { gte: since24, lt: new Date(now.getTime() - STALE_PENDING_MS) }, conversation: { patient: { clinicId } } } }),
    prisma.uazapiWebhookEvent.count({ where: { clinicId, status: "failed", attempts: { gte: 3 }, createdAt: { gte: since24 } } }),
    prisma.uazapiWebhookEvent.count({ where: { clinicId, status: { in: ["pending", "processing"] }, createdAt: { lt: new Date(now.getTime() - 5 * 60_000) } } }),
    prisma.message.findFirst({ where: { role: "assistant", authorName: null, deliveryStatus: "sent", conversation: { patient: { clinicId } } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
  ]);

  const revisaoDesligada = breakerOpen(clinicId, now.getTime());
  const aliceActive = clinic?.aliceActive !== false;
  const motivos: string[] = [];
  if (!aliceActive) motivos.push("A Alice está pausada: as mensagens ficam para a equipe responder.");
  for (const [motivo, n] of Object.entries(falhas.porMotivo)) motivos.push(`${n} conversa(s) sem resposta: ${motivo}.`);
  if (eventosFalhos) motivos.push(`${eventosFalhos} mensagem(ns) recebida(s) não puderam ser processadas após 3 tentativas.`);
  if (eventosParados) motivos.push(`${eventosParados} mensagem(ns) recebida(s) esperando processamento há mais de 5 minutos.`);
  if (respostasParadas) motivos.push(`${respostasParadas} resposta(s) da Alice parada(s) sem desfecho.`);
  if (aguardando && oldestWaitingMs >= UNANSWERED_AFTER_MS) motivos.push(`${aguardando} conversa(s) aguardando resposta há mais de 15 minutos (pode ser silêncio intencional, como um "obrigada").`);
  if (revisaoDesligada) motivos.push("A revisão por IA está desligada nesta clínica por alguns minutos (as travas de segurança continuam ativas).");

  const problema = falhas.total > 0 || eventosFalhos > 0 || eventosParados > 0 || respostasParadas > 0;
  const atencao = revisaoDesligada || (aguardando > 0 && oldestWaitingMs >= UNANSWERED_AFTER_MS);
  return {
    revision: REVISION.split(":")[0],
    checkedAt: now.toISOString(),
    aliceActive,
    status: !aliceActive ? "pausada" : problema ? "problema" : atencao ? "atencao" : "ok",
    falhas,
    aguardando: { total: aguardando, maisAntigaMin: aguardando ? Math.round(oldestWaitingMs / 60_000) : null },
    comEquipe,
    entrega24h,
    respostasParadas,
    eventos: { falhos: eventosFalhos, parados: eventosParados },
    ultimaRespostaEnviadaEm: lastSent?.createdAt.toISOString() ?? null,
    revisaoDesligada,
    motivos,
  };
}
