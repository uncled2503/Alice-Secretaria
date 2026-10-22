import { prisma } from "../db/client.js";
import { sendText } from "../uazapi/client.js";

export type NotifyEvent = "new_appointment" | "reschedule" | "cancel" | "human_handoff" | "confirmed" | "automation_failed" | "daily_report" | "daily_report_phones" | "hot_lead";

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
// Resultado REAL do aviso: so "sent" prova que o provedor aceitou a mensagem para a equipe. Quem afirma "a equipe foi avisada" precisa conferir isto.
export type NotifyResult = "sent" | "not_configured" | "event_disabled" | "not_sent" | "failed";

export async function notifyStaff(clinicId: string, event: NotifyEvent, message: string): Promise<NotifyResult> {
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: { notifyPhone: true, notifyEvents: true },
  });
  if (!clinic?.notifyPhone) return "not_configured";
  // Numero claramente invalido (so zeros, curto demais): nao tenta - antes gerava um erro a cada
  // 5 minutos ("is not on WhatsApp"). A clinica precisa corrigir o numero de avisos.
  const digits = clinic.notifyPhone.replace(/\D/g, "");
  if (digits.length < 10 || /^0+$/.test(digits)) return "not_configured";

  const events = clinic.notifyEvents.split(",").map((e) => e.trim());
  if (!events.includes(event) && !ALWAYS_ON_EVENTS.includes(event)) return "event_disabled";

  try {
    const outcome = await sendText(clinicId, clinic.notifyPhone, message, { kind: "interna" });
    return outcome === "sent" ? "sent" : "not_sent";
  } catch (err) {
    console.error(`Falha ao notificar equipe da clinica ${clinicId}:`, err);
    return "failed";
  }
}
