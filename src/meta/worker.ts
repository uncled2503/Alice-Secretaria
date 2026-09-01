import cron from "node-cron";
import { prisma } from "../db/client.js";
import { sendCapiEvent, type CapiEvent } from "./capi.js";
import { backoffMs, META_MAX_ATTEMPTS, dueEventsFilter } from "./events.js";

// Processa a fila de eventos da Meta. A movimentacao do CRM nunca espera por
// isto - aqui e async, com retentativa e backoff. O mesmo event_id e reusado
// em todas as tentativas (a Meta deduplica).

const BATCH = 20;
let running = false;

// Resposta da Meta guardada de forma enxuta e sem PII.
function sanitizeResponse(r: { httpStatus: number; eventsReceived?: number; fbtraceId?: string; messages?: string[]; error?: string }): string {
  return JSON.stringify({
    httpStatus: r.httpStatus,
    eventsReceived: r.eventsReceived,
    fbtraceId: r.fbtraceId,
    messages: r.messages?.slice(0, 3),
    error: r.error?.slice(0, 300),
  });
}

async function processOne(eventRow: { id: string; clinicId: string; eventId: string; payload: string; attempts: number; testEventCode: string | null }): Promise<void> {
  const config = await prisma.metaConfig.findUnique({ where: { clinicId: eventRow.clinicId } });
  if (!config || !config.capiEnabled || !config.pixelId || !config.accessTokenEnc) {
    await prisma.metaEvent.update({
      where: { id: eventRow.id },
      data: { status: "dead", lastError: "Meta desativada ou sem credenciais quando o evento seria enviado" },
    });
    return;
  }

  let event: CapiEvent;
  try {
    event = JSON.parse(eventRow.payload) as CapiEvent;
  } catch {
    await prisma.metaEvent.update({ where: { id: eventRow.id }, data: { status: "dead", lastError: "payload corrompido" } });
    return;
  }

  const result = await sendCapiEvent(config, event, eventRow.testEventCode);
  const attempts = eventRow.attempts + 1;

  if (result.ok) {
    await prisma.metaEvent.update({
      where: { id: eventRow.id },
      data: { status: "processed", attempts, processedAt: new Date(), metaResponse: sanitizeResponse(result), lastError: null },
    });
    return;
  }

  const dead = result.permanent || attempts >= META_MAX_ATTEMPTS;
  await prisma.metaEvent.update({
    where: { id: eventRow.id },
    data: {
      status: dead ? "dead" : "error",
      attempts,
      nextAttemptAt: dead ? null : new Date(Date.now() + backoffMs(attempts)),
      lastError: (result.error ?? "erro desconhecido").slice(0, 500),
      metaResponse: sanitizeResponse(result),
    },
  });
}

export async function processMetaEventQueue(): Promise<{ processed: number }> {
  if (running) return { processed: 0 };
  running = true;
  let processed = 0;
  try {
    const due = await prisma.metaEvent.findMany({
      where: dueEventsFilter(),
      orderBy: { createdAt: "asc" },
      take: BATCH,
      select: { id: true, clinicId: true, eventId: true, payload: true, attempts: true, testEventCode: true },
    });
    for (const row of due) {
      // trava otimista: so pega se ainda estiver retryable
      const claimed = await prisma.metaEvent.updateMany({
        where: { id: row.id, status: { in: ["pending", "error"] } },
        data: { status: "processing" },
      });
      if (claimed.count === 0) continue;
      try {
        await processOne(row);
        processed++;
      } catch (err) {
        console.error(`[meta] erro processando evento ${row.id}:`, err);
        await prisma.metaEvent
          .update({ where: { id: row.id }, data: { status: "error", nextAttemptAt: new Date(Date.now() + backoffMs(row.attempts + 1)) } })
          .catch(() => {});
      }
    }
  } finally {
    running = false;
  }
  return { processed };
}

// Reprocessa um evento agora (botao "Reenviar" do diagnostico).
export async function retryMetaEvent(id: string): Promise<boolean> {
  const row = await prisma.metaEvent.findUnique({ where: { id } });
  if (!row || row.status === "processing") return false;
  await prisma.metaEvent.update({ where: { id }, data: { status: "pending", nextAttemptAt: new Date(), lastError: null } });
  await processMetaEventQueue();
  return true;
}

export function startMetaEventWorker(): void {
  cron.schedule("* * * * *", () => {
    processMetaEventQueue().catch((err) => console.error("[meta] worker falhou:", err));
  });
  // recupera eventos presos em "processing" de um restart no meio do envio
  setTimeout(() => {
    prisma.metaEvent
      .updateMany({ where: { status: "processing" }, data: { status: "pending", nextAttemptAt: new Date() } })
      .catch(() => {});
  }, 5_000);
}
