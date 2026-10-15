import { prisma } from "../db/client.js";

// ---------------------------------------------------------------------------
// RESTAURA O HORARIO FIXO DOS LEMBRETES ("Antes da visita") da Lisboa. O modal do lembrete mostrava "horas antes" (24 / 3: so um valor
// de apoio) e, ao salvar com outro numero, a API apagava o horario fixo (dayOffset/sendHour) - o lembrete passava a sair "48h antes" em vez
// de na janela do dia. Aqui o horario volta ao que a clinica aprovou (confirmacao do dia seguinte 8h-11h, confirmacao do dia 7h-8h,
// pausa de 10 a 30 s entre pacientes). Classifica pelo TEXTO da mensagem; o que nao der pra classificar nao e tocado.
// ---------------------------------------------------------------------------

export type ReminderKind = "dia_seguinte" | "do_dia";

export const REMINDER_WINDOWS: Record<ReminderKind, { hoursBefore: number; dayOffset: number; sendHour: number; sendMinute: number; sendEndHour: number; pauseMinSec: number; pauseMaxSec: number; label: string }> = {
  dia_seguinte: { hoursBefore: 24, dayOffset: 1, sendHour: 8, sendMinute: 0, sendEndHour: 11, pauseMinSec: 10, pauseMaxSec: 30, label: "dia anterior, das 08:00 às 11:00" },
  do_dia: { hoursBefore: 3, dayOffset: 0, sendHour: 7, sendMinute: 0, sendEndHour: 8, pauseMinSec: 10, pauseMaxSec: 30, label: "no próprio dia, das 07:00 às 08:00" },
};

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

// "(amanhã)" na linha da data = confirmacao do dia seguinte; "hoje às {hora}" = confirmacao do dia. Os dois juntos ou nenhum = nao sei.
export function classifyReminder(message: string): ReminderKind | null {
  const f = fold(message);
  const amanha = /\bamanha\b/.test(f);
  const hoje = /\bhoje\b/.test(f);
  if (amanha === hoje) return null;
  return amanha ? "dia_seguinte" : "do_dia";
}

export interface ReminderRestoreItem {
  id: string;
  messageStart: string;
  createdAt: Date;
  currentHoursBefore: number;
  kind: ReminderKind | null;
  action: "restaurar" | "pausar_duplicado" | "nao_classificado";
  to: string | null; // texto do horario que volta
}

export interface ReminderRestorePlan {
  items: ReminderRestoreItem[];
  applied: number;
  paused: number;
  dryRun: boolean;
  error?: string;
}

// So as regras "maes" que PERDERAM o horario fixo (sem dayOffset). A reconfirmacao (regra filha, ja com horario) nao entra.
export async function restoreLisboaReminders(clinicId: string, opts: { dryRun: boolean }): Promise<ReminderRestorePlan> {
  const rules = await prisma.reminderRule.findMany({
    where: { clinicId, parentRuleId: null, dayOffset: null, active: true }, // pausado = decisao de alguem: nao mexe
    orderBy: { createdAt: "asc" },
  });
  const seen = new Set<ReminderKind>();
  const items: ReminderRestoreItem[] = rules.map((r) => {
    const kind = classifyReminder(r.message);
    const base = { id: r.id, messageStart: r.message.replace(/\s+/g, " ").slice(0, 90), createdAt: r.createdAt, currentHoursBefore: r.hoursBefore, kind };
    if (!kind) return { ...base, action: "nao_classificado" as const, to: null };
    if (seen.has(kind)) return { ...base, action: "pausar_duplicado" as const, to: null }; // o mais antigo fica; um segundo igual mandaria a mensagem 2x
    seen.add(kind);
    return { ...base, action: "restaurar" as const, to: REMINDER_WINDOWS[kind].label };
  });

  let applied = 0;
  let paused = 0;
  if (!opts.dryRun) {
    for (const it of items) {
      if (it.action === "restaurar" && it.kind) {
        const w = REMINDER_WINDOWS[it.kind];
        await prisma.reminderRule.update({
          where: { id: it.id },
          data: { hoursBefore: w.hoursBefore, dayOffset: w.dayOffset, sendHour: w.sendHour, sendMinute: w.sendMinute, sendEndHour: w.sendEndHour, pauseMinSec: w.pauseMinSec, pauseMaxSec: w.pauseMaxSec, scheduledChange: null },
        });
        applied++;
      } else if (it.action === "pausar_duplicado") {
        await prisma.reminderRule.update({ where: { id: it.id }, data: { active: false } });
        paused++;
      }
    }
  }
  return { items, applied, paused, dryRun: opts.dryRun };
}
