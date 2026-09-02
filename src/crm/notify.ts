import { prisma } from "../db/client.js";
import { sendText } from "../uazapi/client.js";

export type NotifyEvent = "new_appointment" | "reschedule" | "cancel" | "human_handoff" | "confirmed";

// Avisa a equipe (notifyPhone da clinica) sobre um evento, pelo proprio
// WhatsApp da clinica - so manda se a clinica tiver um numero configurado E
// esse tipo de evento estiver marcado em notifyEvents.
export async function notifyStaff(clinicId: string, event: NotifyEvent, message: string): Promise<void> {
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: { notifyPhone: true, notifyEvents: true, whatsappPhone: true },
  });
  if (!clinic?.notifyPhone) return;

  const events = clinic.notifyEvents.split(",").map((e) => e.trim());
  if (!events.includes(event)) return;

  // O numero de avisos nao pode ser o proprio numero conectado: o WhatsApp nao
  // envia mensagem pra si mesmo. Nesse caso o aviso fica so no painel.
  const digits = (s: string) => s.replace(/\D/g, "");
  if (digits(clinic.notifyPhone) === digits(clinic.whatsappPhone || "")) {
    console.warn(`notifyStaff: numero de avisos da clinica ${clinicId} e o proprio numero conectado - avisando so no painel`);
    return;
  }

  try {
    await sendText(clinicId, clinic.notifyPhone, message);
  } catch (err) {
    console.error(`Falha ao notificar equipe da clinica ${clinicId}:`, err);
  }
}
