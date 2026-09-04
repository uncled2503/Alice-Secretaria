import { prisma } from "../db/client.js";
import type { Clinic } from "@prisma/client";
import { notifyStaff } from "./notify.js";

// ---------------------------------------------------------------------------
// Limite de atendimentos por mes, seguindo o plano. "Atendimento" = uma conversa
// que a Alice atendeu no mes (conta 1 por conversa/mes). Ao estourar o limite,
// a Alice para de PEGAR contatos novos - conversas ja em andamento continuam - e
// os novos vao direto pra equipe.
// ---------------------------------------------------------------------------

// 0 = ilimitado
const PLAN_CONVERSATION_LIMIT: Record<string, number> = {
  free: 0, // plano gratis: a Alice nem atende (barrada antes deste ponto)
  realce: 100,
  prime: 300,
  prestige: 0,
};

export function monthKey(d = new Date()): string {
  return d.toISOString().slice(0, 7); // "2026-09"
}

// 0 = ilimitado. Override tem prioridade (0 no override = liberar geral).
export function effectiveConversationLimit(clinic: Pick<Clinic, "plan" | "conversationLimitOverride">): number {
  if (clinic.conversationLimitOverride != null) return Math.max(0, Math.round(clinic.conversationLimitOverride));
  return PLAN_CONVERSATION_LIMIT[clinic.plan] ?? 0;
}

export interface UsageCheck {
  allowed: boolean; // a Alice pode atender este contato agora?
  used: number;
  limit: number; // 0 = ilimitado
}

type ClinicUsageFields = Pick<
  Clinic,
  "id" | "plan" | "conversationLimitOverride" | "usageMonth" | "usageCount" | "usageLimitNotified"
>;

// Chamado quando a Alice VAI responder. Conta 1 atendimento por conversa/mes.
// Se a conversa ja foi atendida este mes, nunca bloqueia e nao conta de novo.
export async function checkAtendimentoLimit(
  clinic: ClinicUsageFields,
  conversation: { id: string; aliceMonth: string },
): Promise<UsageCheck> {
  const month = monthKey();
  const limit = effectiveConversationLimit(clinic);

  // Vira o mes: zera o contador e o aviso.
  let used = clinic.usageCount;
  if (clinic.usageMonth !== month) {
    await prisma.clinic.update({
      where: { id: clinic.id },
      data: { usageMonth: month, usageCount: 0, usageLimitNotified: false },
    });
    used = 0;
    clinic.usageLimitNotified = false;
  }

  if (limit <= 0) return { allowed: true, used, limit: 0 };

  // Conversa ja contada este mes: segue normal.
  if (conversation.aliceMonth === month) return { allowed: true, used, limit };

  // Atendimento novo e o limite estourou: bloqueia.
  if (used >= limit) {
    if (!clinic.usageLimitNotified) {
      await prisma.clinic.update({ where: { id: clinic.id }, data: { usageLimitNotified: true } });
      void notifyStaff(
        clinic.id,
        "human_handoff",
        `Limite de atendimentos do plano atingido este mês (${used}/${limit}). A Alice parou de pegar contatos novos — eles estão indo direto pra equipe. Fale com a gente pra aumentar o limite.`,
      ).catch(() => {});
    }
    return { allowed: false, used, limit };
  }

  // Conta o atendimento novo.
  await prisma.$transaction([
    prisma.clinic.update({ where: { id: clinic.id }, data: { usageMonth: month, usageCount: { increment: 1 } } }),
    prisma.conversation.update({ where: { id: conversation.id }, data: { aliceMonth: month } }),
  ]);
  return { allowed: true, used: used + 1, limit };
}

export async function usageSnapshot(
  clinicId: string,
): Promise<{ month: string; used: number; limit: number; overrideSet: boolean }> {
  const c = await prisma.clinic.findUniqueOrThrow({
    where: { id: clinicId },
    select: { plan: true, conversationLimitOverride: true, usageMonth: true, usageCount: true },
  });
  const month = monthKey();
  return {
    month,
    used: c.usageMonth === month ? c.usageCount : 0,
    limit: effectiveConversationLimit(c),
    overrideSet: c.conversationLimitOverride != null,
  };
}
