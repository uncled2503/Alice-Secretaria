import { prisma } from "../db/client.js";
import { sendText } from "../uazapi/client.js";

export type NotifyEvent = "new_appointment" | "reschedule" | "cancel" | "human_handoff" | "confirmed" | "automation_failed";

// "automation_failed" e um alerta critico de saude do sistema (falha ao
// mandar mensagem automatica), nao um evento de negocio - manda sempre que
// tem notifyPhone configurado, sem exigir opt-in em notifyEvents. Nenhuma
// clinica teria como ter marcado essa opcao antes dela existir.
const ALWAYS_ON_EVENTS: NotifyEvent[] = ["automation_failed"];

// Avisa a equipe (notifyPhone da clinica) sobre um evento, pelo proprio
// WhatsApp da clinica - so manda se a clinica tiver um numero configurado E
// (esse tipo de evento estiver marcado em notifyEvents OU for always-on).
//
// O numero de avisos PODE ser o proprio numero conectado: o WhatsApp entrega
// a mensagem na conversa "Mensagem pra mim" e o eco (fromMe/wasSentByApi) e
// descartado no webhook (ver parseWebhookPayload), entao nao gera loop.
export async function notifyStaff(clinicId: string, event: NotifyEvent, message: string): Promise<void> {
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: { notifyPhone: true, notifyEvents: true },
  });
  if (!clinic?.notifyPhone) return;

  const events = clinic.notifyEvents.split(",").map((e) => e.trim());
  if (!events.includes(event) && !ALWAYS_ON_EVENTS.includes(event)) return;

  try {
    await sendText(clinicId, clinic.notifyPhone, message);
  } catch (err) {
    console.error(`Falha ao notificar equipe da clinica ${clinicId}:`, err);
  }
}
