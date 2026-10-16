import { prisma } from "../db/client.js";
import { ceRequest } from "./client.js";
import { logActivity } from "../crm/activity.js";
import { mapCeStatus, parseCeInstant } from "./pull.js";
import { scheduleBriefingRefreshForAppointment } from "../ai/leadBriefing.js";

// ---------------------------------------------------------------------------
// CONFERE NO CLINICA EXPERTS ANTES DE MANDAR (pedido da Lisboa, 16/10/2026: "todos os clientes que cancelaram ou remarcaram continuam
// recebendo a confirmacao, mas nem estao mais na agenda"). A Alice guarda uma COPIA da agenda do CE e a atualiza a cada 10 min; quando a
// recepcao cancela, apaga ou troca o horario la, a copia fica velha (a reserva some da listagem ou volta com outro horario/uuid) e o
// lembrete saia pro horario antigo. Agora, antes de mandar qualquer lembrete de um agendamento ligado ao CE, a reserva e consultada ao
// vivo: cancelada ou apagada = cancela aqui e nao manda; horario trocado = corrige aqui e nao manda o antigo.
// ---------------------------------------------------------------------------

export type LiveVerdict = { kind: "ok" } | { kind: "gone"; why: string } | { kind: "moved"; to: Date } | { kind: "unknown" };

// PURO: o que o CE disse sobre a reserva (corpo de GET /bookings/{uuid}; 404 = apagada).
export function judgeLiveBooking(
  appt: { scheduledAt: Date },
  res: { ok: true; data: unknown } | { ok: false; status: number },
  tz: string,
): LiveVerdict {
  if (!res.ok) return res.status === 404 || res.status === 410 ? { kind: "gone", why: "a reserva foi apagada no Clínica Experts" } : { kind: "unknown" };
  const root = res.data as { data?: unknown } | null;
  const b = ((root && typeof root === "object" && "data" in root ? root.data : root) ?? null) as { status?: string; starts_at?: string } | null;
  if (!b || typeof b !== "object") return { kind: "unknown" };
  const st = typeof b.status === "string" ? mapCeStatus(b.status) : "confirmed"; // formato inesperado: nao conclui nada
  if (st === "cancelled") return { kind: "gone", why: "a reserva foi cancelada no Clínica Experts" };
  if (st === "no_show") return { kind: "gone", why: "a reserva foi marcada como falta no Clínica Experts" };
  if (st === "completed") return { kind: "gone", why: "a reserva já consta como atendida no Clínica Experts" };
  // So considera "trocou de horario" quando o CE devolve o instante COM fuso (Z ou +hh:mm): sem fuso a leitura poderia deslocar 3h e corromper o horario.
  if (typeof b.starts_at === "string" && /(Z|[+-]\d{2}:?\d{2})$/i.test(b.starts_at.trim())) {
    const at = parseCeInstant(b.starts_at, tz);
    if (!Number.isNaN(at.getTime()) && at.getTime() > Date.now() && Math.abs(at.getTime() - appt.scheduledAt.getTime()) >= 60_000) return { kind: "moved", to: at };
  }
  return { kind: "ok" };
}

export async function verifyBookingLive(appt: { clinicId: string; ceBookingUuid: string | null; scheduledAt: Date }, tz: string): Promise<LiveVerdict> {
  if (!appt.ceBookingUuid) return { kind: "ok" }; // nao veio do CE nem foi espelhado: nada pra conferir la
  try {
    const res = await ceRequest<unknown>(appt.clinicId, `/bookings/${appt.ceBookingUuid}`);
    return judgeLiveBooking(appt, res.ok ? { ok: true, data: res.data } : { ok: false, status: res.status }, tz);
  } catch (err) {
    console.error("[lembrete] falha ao conferir a reserva no CE (segue sem conferir):", err);
    return { kind: "unknown" }; // a conferencia nunca derruba o disparo dos lembretes
  }
}

// Aplica o veredito na copia local. Devolve true se o lembrete DEVE ser pulado (a copia estava velha).
export async function applyLiveVerdict(
  appt: { id: string; clinicId: string; patientId: string; scheduledAt: Date },
  verdict: LiveVerdict,
  label: string,
): Promise<boolean> {
  if (verdict.kind === "gone") {
    await prisma.appointment.updateMany({ where: { id: appt.id, status: "confirmed" }, data: { status: "cancelled" } });
    await logActivity({
      clinicId: appt.clinicId, patientId: appt.patientId, type: "appointment_cancelled", area: "agenda",
      title: "Agendamento cancelado no Clínica Experts",
      description: `${label}: ${verdict.why}. A confirmação automática não foi enviada.`, actorName: null,
    }).catch(() => undefined);
    console.warn(`[lembrete] ${label}: ${verdict.why} - lembrete NAO enviado e agendamento cancelado aqui`);
    scheduleBriefingRefreshForAppointment(appt.id);
    return true;
  }
  if (verdict.kind === "moved") {
    // novo horario: corrige a copia, zera a confirmacao do horario antigo e libera os lembretes pra sairem no horario novo
    await prisma.appointment.update({ where: { id: appt.id }, data: { scheduledAt: verdict.to, patientConfirmed: false, confirmedAt: null } });
    await prisma.reminderSent.deleteMany({ where: { appointmentId: appt.id } });
    console.warn(`[lembrete] ${label}: o horario mudou no Clínica Experts - corrigido; lembrete do horario antigo NAO enviado`);
    scheduleBriefingRefreshForAppointment(appt.id);
    return true;
  }
  return false;
}

// Reservas que a Alice tem como confirmadas, futuras e ligadas ao CE, dentro da janela que a importacao acabou de ler, mas que o CE
// NAO devolveu: foram apagadas/trocadas la. Cada uma e conferida ao vivo (GET /bookings/{uuid}) antes de ser cancelada aqui.
export async function reconcileMissingBookings(
  clinicId: string,
  returnedUuids: Set<string>,
  window: { from: Date; to: Date },
  tz: string,
): Promise<{ checked: number; cancelled: number; moved: number }> {
  const locals = await prisma.appointment.findMany({
    where: { clinicId, status: "confirmed", ceBookingUuid: { not: null }, scheduledAt: { gte: window.from, lt: window.to } },
    include: { patient: { select: { name: true, phone: true } } },
    take: 60,
  });
  const out = { checked: 0, cancelled: 0, moved: 0 };
  for (const a of locals) {
    if (!a.ceBookingUuid || returnedUuids.has(a.ceBookingUuid)) continue;
    out.checked++;
    const verdict = await verifyBookingLive(a, tz);
    if (verdict.kind === "gone" || verdict.kind === "moved") {
      await applyLiveVerdict(a, verdict, `${a.patient.name ?? a.patient.phone}`);
      if (verdict.kind === "gone") out.cancelled++;
      else out.moved++;
    }
  }
  return out;
}
