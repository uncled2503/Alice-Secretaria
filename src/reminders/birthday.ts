import cron from "node-cron";
import { prisma } from "../db/client.js";
import { sendText } from "../uazapi/client.js";
import { renderMessageTemplate, getClinicTemplateInfo } from "../crm/template.js";

// { hour, month (1-12), day } na timezone informada, no instante `at`.
function localParts(at: Date, timeZone: string): { hour: number; month: number; day: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  return { hour: Number(parts.hour), month: Number(parts.month), day: Number(parts.day) };
}

// Roda de hora em hora. Pra cada regra ativa, quando a hora local da clinica
// bate com rule.sendHour, manda parabens pra quem faz aniversario hoje e ainda
// nao recebeu essa regra neste ano (BirthdaySent trava por paciente/regra/ano).
export function startBirthdayJob(): void {
  cron.schedule("5 * * * *", async () => {
    const rules = await prisma.birthdayRule.findMany({
      where: { active: true },
      include: { clinic: { select: { timezone: true } } },
    });

    for (const rule of rules) {
      const tz = rule.clinic.timezone || "America/Sao_Paulo";
      const now = new Date();
      const { hour, month, day } = localParts(now, tz);
      if (hour !== rule.sendHour) continue;

      const year = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric" }).format(now));

      // birthDate guardado como UTC meia-noite; comparar dia/mes ignorando ano.
      const patients = await prisma.patient.findMany({
        where: {
          clinicId: rule.clinicId,
          birthDate: { not: null },
          birthdaySent: { none: { ruleId: rule.id, year } },
        },
      });

      const birthdayToday = patients.filter((p) => {
        const b = p.birthDate!;
        return b.getUTCMonth() + 1 === month && b.getUTCDate() === day;
      });
      if (birthdayToday.length === 0) continue;

      const clinicInfo = await getClinicTemplateInfo(rule.clinicId);

      for (const patient of birthdayToday) {
        const text = renderMessageTemplate(rule.message, {
          patientName: patient.name,
          patientPhone: patient.phone,
          clinicName: clinicInfo.name,
          locationName: clinicInfo.primaryLocation?.name,
          locationAddress: clinicInfo.primaryLocation?.fullAddress,
          birthDate: patient.birthDate,
        });

        try {
          await sendText(rule.clinicId, patient.phone, text);
          await prisma.birthdaySent.create({ data: { patientId: patient.id, ruleId: rule.id, year } });
        } catch (err) {
          console.error(`Falha ao enviar aniversario (regra ${rule.id}) para ${patient.phone}:`, err);
        }
      }
    }
  });
}
