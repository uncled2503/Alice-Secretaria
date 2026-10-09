import cron from "node-cron";
import crypto from "node:crypto";
import { prisma } from "../db/client.js";

// ---------------------------------------------------------------------------
// Uma cópia da Alice por vez roda cada tarefa agendada.
//
// A hospedagem pode deixar mais de uma cópia do servidor no ar ao mesmo tempo (troca de
// versão, "Implantar" clicado varias vezes). Sem isto, cada cópia rodava TODAS as automações
// (lembretes, recontatos...) e o paciente recebia a mensagem 2 ou 3 vezes.
//
// Cada tarefa tem uma "concessão" na tabela JobLock: quem a detém roda e renova a cada
// rodada; as outras cópias pulam. Se a detentora cair, outra assume quando a concessão vence.
// ---------------------------------------------------------------------------

export const INSTANCE_ID = crypto.randomUUID();
const DEFAULT_TTL_MS = 15 * 60_000;

export async function acquireJobLock(name: string, ttlMs = DEFAULT_TTL_MS, now = new Date(), me = INSTANCE_ID): Promise<boolean> {
  const until = new Date(now.getTime() + ttlMs);
  const taken = await prisma.jobLock.updateMany({
    where: { name, OR: [{ holder: me }, { expiresAt: { lt: now } }] },
    data: { holder: me, expiresAt: until },
  });
  if (taken.count === 1) return true;
  try {
    await prisma.jobLock.create({ data: { name, holder: me, expiresAt: until } });
    return true; // primeira vez que alguem pega esta tarefa
  } catch {
    return false; // outra copia detem a concessao (ou criou agora)
  }
}

export function scheduleLocked(name: string, expression: string, fn: () => unknown | Promise<unknown>, opts: { ttlMs?: number } = {}): void {
  cron.schedule(expression, async () => {
    try {
      if (!(await acquireJobLock(name, opts.ttlMs))) return;
      await fn();
    } catch (err) {
      console.error(`[tarefa ${name}] falhou:`, err);
    }
  });
}
