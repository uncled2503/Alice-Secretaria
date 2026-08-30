import { prisma } from "../db/client.js";
import { sendText } from "../uazapi/client.js";
import { getClinicTemplateInfo } from "../crm/template.js";
import { logActivity } from "../crm/activity.js";
import { formatInZone } from "./time.js";

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
    const entry = await prisma.waitlistEntry.findFirst({
      where: {
        clinicId,
        status: "waiting",
        AND: [
          { OR: [{ procedureId }, { procedureId: null }] },
          ...(professionalId ? [{ OR: [{ professionalId }, { professionalId: null }] }] : []),
        ],
      },
      orderBy: { createdAt: "asc" },
      include: { patient: true, procedure: true },
    });
    if (!entry || entry.patient.optedOut) return;

    const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId } });
    const info = await getClinicTemplateInfo(clinicId);
    const tz = clinic.timezone || "America/Sao_Paulo";
    const procedureName = entry.procedure?.name ?? "atendimento";
    const firstName = entry.patient.name?.trim().split(" ")[0] || "";

    const text =
      `Oi ${firstName}! Abriu uma vaga para ${procedureName} em ${formatInZone(freedAt, tz)} aqui na ${info.name}. ` +
      `Quer que eu reserve esse horario pra voce? Me responde por aqui que eu confirmo.`;

    await sendText(clinicId, entry.patient.phone, text.replace(/\s+/g, " ").trim());

    await prisma.waitlistEntry.update({
      where: { id: entry.id },
      data: { status: "notified", notifiedAt: new Date() },
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
