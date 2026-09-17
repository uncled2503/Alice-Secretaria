import cron from "node-cron";
import { prisma } from "../db/client.js";
import { backfillMissingProfessionalIds } from "../maintenance/backfillProfessionals.js";

// Corrige TODA clinica (nao so quem tem um seed proprio): agendamento
// confirmado sem profissional atribuido bloqueia a agenda inteira (regra
// conservadora, ver loadBusyContext/createBooking em scheduling/slots.ts) -
// isso trava agendamento simultaneo (ver Procedure.allowConcurrentBooking e
// [[agenda-horarios-simultaneos]]) sempre que um procedimento antigo, sem
// profissional atribuido, sobra na agenda depois que alguem separa um
// profissional dedicado pra ele. Antes so rodava dentro do seed do Dr.
// Saulo; generalizado pra rodar em qualquer clinica automaticamente.
async function runForAllClinics(): Promise<void> {
  const clinics = await prisma.clinic.findMany({ select: { id: true, name: true } });
  for (const clinic of clinics) {
    const { updated } = await backfillMissingProfessionalIds(clinic.id);
    if (updated > 0) {
      console.warn(`[agenda] ${updated} agendamento(s) sem profissional corrigido(s) automaticamente em "${clinic.name}".`);
    }
  }
}

// De hora em hora, e uma vez logo apos o boot (pra corrigir rapido sem
// esperar ate a proxima hora cheia).
export function startProfessionalBackfillJob(): void {
  cron.schedule("20 * * * *", () => {
    runForAllClinics().catch((err) => console.error("[agenda] Falha no backfill de profissional:", err));
  });
  setTimeout(() => {
    runForAllClinics().catch((err) => console.error("[agenda] Falha no backfill de profissional:", err));
  }, 30_000);
}
