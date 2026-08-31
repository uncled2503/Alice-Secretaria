import cron from "node-cron";
import { prisma } from "../db/client.js";
import { logActivity } from "../crm/activity.js";

export const PLAN_LABELS: Record<string, string> = {
  realce: "Realce",
  prime: "Prime",
  prestige: "Prestige",
};

// Marca as clinicas cujo plano venceu e registra no historico (o painel adm
// mostra o aviso). NAO bloqueia nada automaticamente - quem decide bloquear
// por inadimplencia e a administracao da Alice, no botao "Bloquear".
async function flagExpiredPlans(): Promise<void> {
  const now = new Date();
  const expired = await prisma.clinic.findMany({
    where: { planExpiresAt: { not: null, lt: now }, planExpiryNotified: false },
    select: { id: true, name: true, plan: true, planExpiresAt: true },
  });

  for (const c of expired) {
    const venceu = c.planExpiresAt?.toLocaleDateString("pt-BR") ?? "?";
    await logActivity({
      clinicId: c.id,
      type: "plan_expired",
      area: "clinica",
      title: `Plano ${PLAN_LABELS[c.plan] ?? c.plan} venceu`,
      description: `A vigência do plano terminou em ${venceu}. Renove ou ajuste o plano no painel administrativo.`,
    });
    await prisma.clinic.update({ where: { id: c.id }, data: { planExpiryNotified: true } });
  }

  if (expired.length) {
    console.warn(`[plano] ${expired.length} clinica(s) com plano vencido: ${expired.map((c) => c.name).join(", ")}`);
  }
}

// De hora em hora. Roda tambem uma vez logo apos o boot pra nao esperar ate a
// proxima hora cheia quando o servidor sobe com um plano ja vencido.
export function startPlanExpiryJob(): void {
  cron.schedule("10 * * * *", () => {
    flagExpiredPlans().catch((err) => console.error("[plano] Falha ao verificar vencimentos:", err));
  });
  setTimeout(() => {
    flagExpiredPlans().catch((err) => console.error("[plano] Falha ao verificar vencimentos:", err));
  }, 30_000);
}
