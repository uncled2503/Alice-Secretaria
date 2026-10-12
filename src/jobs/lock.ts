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

export function scheduleLocked(name: string, expression: string, fn: () => unknown | Promise<unknown>, opts: { ttlMs?: number; timezone?: string } = {}): void {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  cron.schedule(
    expression,
    async () => {
      let renew: NodeJS.Timeout | undefined;
      try {
        if (!(await acquireJobLock(name, ttl))) return;
        // Renova a concessao enquanto a tarefa roda: uma rodada mais longa que o TTL (ex.: envios com pausa) deixava outra
        // copia do servidor pegar a mesma tarefa no meio.
        renew = setInterval(() => void acquireJobLock(name, ttl).catch(() => undefined), Math.max(30_000, Math.floor(ttl / 3)));
        await fn();
      } catch (err) {
        console.error(`[tarefa ${name}] falhou:`, err);
      } finally {
        if (renew) clearInterval(renew);
      }
    },
    opts.timezone ? { timezone: opts.timezone } : undefined,
  );
}
