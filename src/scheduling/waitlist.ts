import { prisma } from "../db/client.js";
import { sendText } from "../uazapi/client.js";
import { getClinicTemplateInfo } from "../crm/template.js";
import { usableFirstName } from "../crm/greeting.js";
import { logActivity } from "../crm/activity.js";
import { formatInZone } from "./time.js";
import { rankWaitlist } from "./waitlistMatch.js";

// Quando um horario e liberado (cancelamento), avisa o primeiro paciente da
// lista de espera compativel: mesmo procedimento (ou sem procedimento definido)
// e mesmo profissional (ou sem profissional definido). Nao remarca sozinho - o
// paciente responde e a Alice agenda pelo fluxo normal.
export async function offerFreedSlotToWaitlist(params: {
  clinicId: string;
  procedureId: string;
  professionalId: string | null;
  freedAt: Date;
}): Promise<void> {
  const { clinicId, procedureId, professionalId, freedAt } = params;

  try {
    const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId } });
    const tz = clinic.timezone || "America/Sao_Paulo";
    const now = new Date();
    // entradas vencidas saem da fila (registrado), nunca recebem oferta
    await prisma.waitlistEntry.updateMany({ where: { clinicId, status: "waiting", validUntil: { lt: now } }, data: { status: "cancelled" } });
    const waiting = await prisma.waitlistEntry.findMany({ where: { clinicId, status: "waiting" }, include: { patient: true, procedure: true }, orderBy: { createdAt: "asc" }, take: 200 });
    // COMPATIBILIDADE REAL: procedimento, profissional, dia, turno, antecedencia minima e validade (waitlistMatch.ts); prioridade manda, depois a mais antiga.
    const ranked = rankWaitlist(waiting, { procedureId, professionalId, start: freedAt }, now, tz).filter((e) => !(waiting.find((w) => w.id === e.id)?.patient.optedOut) && waiting.find((w) => w.id === e.id)?.patient.contactKind === "paciente");
    const entry = ranked.length ? waiting.find((w) => w.id === ranked[0].id) : null;
    if (!entry) return;
    const info = await getClinicTemplateInfo(clinicId);
    const procedureName = entry.procedure?.name ?? "atendimento";
    const firstName = usableFirstName(entry.patient.name);

    const text =
      `Oi ${firstName}! Abriu uma vaga para ${procedureName} em ${formatInZone(freedAt, tz)} aqui na ${info.name}. ` +
      `Quer que eu reserve esse horario pra voce? Me responde por aqui que eu confirmo.`;

    const outcome = await sendText(clinicId, entry.patient.phone, text.replace(/\s+/g, " ").trim(), { kind: "lista_espera" });
    if (outcome !== "sent") return; // nada saiu: o paciente continua esperando a proxima vaga

    await prisma.waitlistEntry.update({
      where: { id: entry.id },
      data: { status: "notified", notifiedAt: new Date(), offeredSlotAt: freedAt },
    });

    // Registra a oferta como mensagem na conversa ativa (se houver), pra Alice
    // ter contexto quando o paciente responder.
    const conversation = await prisma.conversation.findFirst({
      where: { patientId: entry.patientId, status: { in: ["active", "qualified", "scheduled"] } },
      orderBy: { createdAt: "desc" },
    });
    if (conversation) {
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          role: "assistant",
          content: text.replace(/\s+/g, " ").trim(),
          authorName: "Lista de espera",
        },
      });
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { status: "active", lastMessageAt: new Date() },
      });
    }

    await logActivity({
      clinicId,
      patientId: entry.patientId,
      type: "waitlist_offer",
      area: "agenda",
      title: "Vaga oferecida da lista de espera",
      description: `${entry.patient.name ?? entry.patient.phone} — ${procedureName} em ${formatInZone(freedAt, tz)}.`,
      actorName: null,
    });
  } catch (err) {
    console.error("Falha ao oferecer vaga da lista de espera:", err);
  }
}
