import cron from "node-cron";
import { prisma } from "../db/client.js";
import { sendText } from "../whatsapp/manager.js";

// Roda a cada 15min; sem custo extra alem do que ja roda no mesmo processo.
export function startReminderJob(): void {
  cron.schedule("*/15 * * * *", async () => {
    const now = new Date();
    const in24h = new Date(now.getTime() + 24 * 60 * 60_000);

    const upcoming = await prisma.appointment.findMany({
      where: {
        status: "confirmed",
        reminderSentAt: null,
        scheduledAt: { gte: now, lte: in24h },
      },
      include: { patient: true, procedure: true },
    });

    for (const appt of upcoming) {
      const when = appt.scheduledAt.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
      const text = `Oi ${appt.patient.name ?? ""}! Passando para lembrar do seu ${appt.procedure.name} amanha, dia ${when}. Ate la!`;

      try {
        await sendText(appt.clinicId, appt.patient.phone, text);
        await prisma.appointment.update({
          where: { id: appt.id },
          data: { reminderSentAt: new Date() },
        });
      } catch (err) {
        console.error(`Falha ao enviar lembrete para ${appt.patient.phone}:`, err);
      }
    }
  });
}
