import { prisma } from "../db/client.js";
import { scheduleLocked } from "../jobs/lock.js";
import { PAID_CLINIC_WHERE } from "./plan.js";
import { logActivity } from "./activity.js";
import { notifyStaff } from "./notify.js";
import { generateReply } from "../ai/alice.js";
import { deliverAliceReply } from "../uazapi/client.js";

// ---------------------------------------------------------------------------
// ALICE VOLTA SE A EQUIPE DEMORAR (pedido da Lisboa, 14/10/2026): a equipe assumiu a conversa (respondeu pelo painel ou pelo
// celular), a pessoa continuou escrevendo e ninguem respondeu em N minutos (Clinic.humanReturnMinutes, Lisboa = 15). A Alice
// volta a atender: devolve a conversa pra ela, avisa no chat e responde ja (sem pedir desculpa pela demora, pedido da Lisboa 14/10).
//
// Regras de seguranca:
//  - so vale se uma PESSOA da equipe ja agiu na conversa (Conversation.staffTouchedAt). Conversa que a propria Alice
//    transferiu e ninguem tocou continua esperando a equipe (nao volta sozinha);
//  - nunca devolve quando a transferencia foi por URGENCIA clinica ou REACAO apos procedimento (e ninguem "devolveu" depois);
//  - o relogio conta da primeira mensagem da pessoa que PEDE resposta: "ok"/"obrigada"/emoji nao contam;
//  - mensagem parada ha mais de 6h nao e respondida de repente (a equipe vê no chat).
// ---------------------------------------------------------------------------

export const RESUME_MAX_AGE_MS = 6 * 3_600_000;
export const RESUME_MARK = "A Alice voltou a atender";

const ACK_WORDS = new Set(
  "ok okay oks blz beleza certo combinado obrigado obrigada obrigadinha obg valeu vlw perfeito show otimo entendi entendido ta bom muito maravilha legal tmj amem de nada disponha imagina".split(" "),
);

function normalized(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

// PURO: mensagem so de cortesia ("ok", "obrigada!", "👍") - nao pede resposta.
export function isCourtesyOnly(text: string): boolean {
  const tokens = normalized(text).split(" ").filter(Boolean);
  if (!tokens.length) return !/^\[(imagem|vídeo|áudio|arquivo)/i.test(text.trim()); // so emoji/pontuacao; anexo NAO e cortesia
  return tokens.length <= 5 && tokens.every((t) => ACK_WORDS.has(t));
}

// PURO: a conversa esta esperando a equipe ha tempo suficiente? `incoming` = mensagens da pessoa sem resposta (em ordem).
// Devolve o instante da primeira mensagem que pede resposta, ou null se nao ha nada pra responder.
export function firstUnansweredAt(incoming: { content: string; createdAt: Date }[]): Date | null {
  const real = incoming.find((m) => !isCourtesyOnly(m.content));
  return real ? real.createdAt : null;
}

export function shouldResume(waitingSince: Date | null, minutes: number, now: Date): boolean {
  if (!waitingSince || minutes <= 0) return false;
  const waited = now.getTime() - waitingSince.getTime();
  return waited >= minutes * 60_000 && waited <= RESUME_MAX_AGE_MS;
}

const SAFETY_PREFIXES = ["Atendimento transferido pela Alice. Motivo: URGENCIA", "Atendimento transferido pela Alice. Motivo: REAÇÃO"];

// A conversa foi transferida por urgencia/reacao e ninguem a devolveu pra Alice depois?
async function blockedBySafetyHandoff(conversationId: string): Promise<boolean> {
  const safety = await prisma.message.findFirst({
    where: { conversationId, role: "system", OR: SAFETY_PREFIXES.map((p) => ({ content: { startsWith: p } })) },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (!safety) return false;
  const back = await prisma.message.findFirst({
    where: { conversationId, role: "system", createdAt: { gt: safety.createdAt }, OR: [{ content: "Atendimento transferido para a Alice" }, { content: { startsWith: RESUME_MARK } }] },
    select: { id: true },
  });
  return !back;
}

async function resumeConversation(clinic: { id: string; name: string; humanReturnMinutes: number }, conv: { id: string; staffTouchedAt: Date; patient: { id: string; name: string | null; phone: string } }): Promise<boolean> {
  // Reserva atomica: so segue quem de fato tirou a conversa do atendimento humano (outra rodada/copia nao repete).
  const taken = await prisma.conversation.updateMany({
    where: { id: conv.id, humanTakeover: true, staffTouchedAt: conv.staffTouchedAt },
    data: { humanTakeover: false, handoffPending: false, staffTouchedAt: null },
  });
  if (taken.count !== 1) return false;

  const who = conv.patient.name ?? conv.patient.phone;
  await prisma.message.create({
    data: { conversationId: conv.id, role: "system", content: `${RESUME_MARK}: a equipe não respondeu em ${clinic.humanReturnMinutes} min.`, authorName: null },
  });
  await logActivity({
    clinicId: clinic.id,
    patientId: conv.patient.id,
    type: "human_resume",
    area: "atendimento",
    title: "Alice voltou a atender (a equipe demorou)",
    description: `${who} esperou mais de ${clinic.humanReturnMinutes} min por uma resposta da equipe; a conversa voltou para a Alice.`,
    actorName: null,
  });
  await notifyStaff(clinic.id, "human_handoff", `⏱️ ${who} ficou ${clinic.humanReturnMinutes} min sem resposta da equipe. A Alice voltou a atender essa conversa.`).catch(() => undefined);

  const reply = await generateReply(conv.id, { resumedAfterStaffDelay: true });
  if (reply) await deliverAliceReply(clinic.id, conv.patient.phone, conv.id, reply);
  return true;
}

export async function resumeStalledConversations(now = new Date()): Promise<number> {
  const clinics = await prisma.clinic.findMany({
    where: { ...PAID_CLINIC_WHERE, active: true, aliceActive: true, humanReturnMinutes: { gt: 0 } },
    select: { id: true, name: true, humanReturnMinutes: true },
  });
  let resumed = 0;
  for (const clinic of clinics) {
    const conversations = await prisma.conversation.findMany({
      where: {
        humanTakeover: true,
        staffTouchedAt: { not: null },
        lastMessageAt: { gte: new Date(now.getTime() - RESUME_MAX_AGE_MS - 60_000) },
        patient: { clinicId: clinic.id, optedOut: false },
      },
      select: { id: true, staffTouchedAt: true, patient: { select: { id: true, name: true, phone: true } } },
      take: 200,
    });
    for (const c of conversations) {
      try {
        const since = c.staffTouchedAt!;
        const after = await prisma.message.findMany({
          where: { conversationId: c.id, createdAt: { gt: since }, role: { in: ["user", "assistant", "human"] } },
          orderBy: { createdAt: "asc" },
          select: { role: true, content: true, createdAt: true },
        });
        // mensagens da pessoa sem resposta = as que vieram depois da ultima fala da equipe/Alice
        let lastTurnIdx = -1;
        after.forEach((m, i) => { if (m.role !== "user") lastTurnIdx = i; });
        const waiting = after.slice(lastTurnIdx + 1);
        if (!shouldResume(firstUnansweredAt(waiting), clinic.humanReturnMinutes, now)) continue;
        if (await blockedBySafetyHandoff(c.id)) continue;
        if (await resumeConversation(clinic, { id: c.id, staffTouchedAt: since, patient: c.patient })) resumed++;
      } catch (err) {
        console.error(`[equipe-demorou] falha na conversa ${c.id}:`, err);
      }
    }
  }
  return resumed;
}

let running = false;

export function startHumanReturnJob(): void {
  scheduleLocked(
    "alice-volta-equipe-demora",
    "* * * * *",
    async () => {
      if (running) return;
      running = true;
      try {
        const n = await resumeStalledConversations();
        if (n) console.log(`[equipe-demorou] ${n} conversa(s) devolvida(s) para a Alice`);
      } finally {
        running = false;
      }
    },
    { ttlMs: 10 * 60_000 },
  );
}
