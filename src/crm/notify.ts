import { prisma } from "../db/client.js";
import { sendText } from "../whatsapp/manager.js";

export type NotifyEvent = "new_appointment" | "reschedule" | "cancel" | "human_handoff";

// Avisa a equipe (notifyPhone da clinica) sobre um evento, pelo proprio
// WhatsApp da clinica - so manda se a clinica tiver um numero configurado E
// esse tipo de evento estiver marcado em notifyEvents.
export async function notifyStaff(clinicId: string, event: NotifyEvent, message: string): Promise<void> {
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: { notifyPhone: true, notifyEvents: true },
  });
  if (!clinic?.notifyPhone) return;

  const events = clinic.notifyEvents.split(",").map((e) => e.trim());
  if (!events.includes(event)) return;

  try {
    await sendText(clinicId, clinic.notifyPhone, message);
  } catch (err) {
    console.error(`Falha ao notificar equipe da clinica ${clinicId}:`, err);
  }
}
