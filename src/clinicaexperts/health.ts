import { prisma } from "../db/client.js";
import { connectionNotice } from "../uazapi/client.js";
import { previewReminders } from "../reminders/preview.js";
import { UNRESOLVED_AFTER_MS } from "./sync.js";

// ---------------------------------------------------------------------------
// SAUDE DA AGENDA / DO CLINICA EXPERTS (somente leitura, sem dados pessoais alem de ids). Responde: o CE e o WhatsApp estao ok? quando foi a ultima sincronizacao boa? ha reserva com
// resultado incerto ou erro? a confirmacao do paciente chegou ao CE? o que sai a seguir? Nao consulta o CE nem o provedor: so o que ja esta no banco.
// ---------------------------------------------------------------------------

export interface CeHealth {
  checkedAt: string;
  connected: boolean;
  syncOut: boolean;
  lastSyncAt: string | null; // ultima sincronizacao BEM-SUCEDIDA (importacao ou escrita)
  lastSyncAgeMin: number | null;
  lastError: string | null;
  whatsapp: { paused: boolean; since: string | null; reason: string | null };
  attempts: { open: number; unresolved: number; oldestOpenMin: number | null; items: { id: string; appointmentId: string; kind: string; state: string; ageMin: number; attempts: number; lastError: string | null }[] };
  reservations48h: { total: number; linked: number; notLinked: number; unknownState: number; cancelPending: number };
  presence48h: { patientConfirmed: number; syncedWithCe: number; pendingSync: number; skipped: number };
  dispatch24h: Record<string, number>;
  nextSends: { today: number; tomorrow: number; paused: number };
  status: "ok" | "atencao" | "problema" | "desligado";
  motivos: string[];
}

const KNOWN = /^(scheduled|confirmed|done|canceled|cancelled|noshow|rescheduled|waiting|progress|reserved)$/i;

export async function ceHealth(clinicId: string, now = new Date()): Promise<CeHealth> {
  const acc = await prisma.clinicaExpertsAccount.findUnique({ where: { clinicId }, select: { syncOut: true, lastSyncAt: true, lastError: true } });
  const whatsapp = await connectionNotice(clinicId);
  const base: CeHealth = {
    checkedAt: now.toISOString(), connected: !!acc, syncOut: !!acc?.syncOut, lastSyncAt: acc?.lastSyncAt?.toISOString() ?? null,
    lastSyncAgeMin: acc?.lastSyncAt ? Math.round((now.getTime() - acc.lastSyncAt.getTime()) / 60_000) : null, lastError: acc?.lastError ?? null,
    whatsapp: { paused: whatsapp.paused, since: whatsapp.since, reason: whatsapp.reason },
    attempts: { open: 0, unresolved: 0, oldestOpenMin: null, items: [] },
    reservations48h: { total: 0, linked: 0, notLinked: 0, unknownState: 0, cancelPending: 0 },
    presence48h: { patientConfirmed: 0, syncedWithCe: 0, pendingSync: 0, skipped: 0 },
    dispatch24h: {}, nextSends: { today: 0, tomorrow: 0, paused: 0 }, status: acc ? "ok" : "desligado", motivos: [],
  };

  const attempts = await prisma.ceBookingAttempt.findMany({ where: { clinicId, state: { in: ["pending", "uncertain", "unresolved"] } }, orderBy: { createdAt: "asc" }, take: 50 });
  base.attempts.open = attempts.filter((a) => a.state !== "unresolved").length;
  base.attempts.unresolved = attempts.filter((a) => a.state === "unresolved").length;
  const openOnes = attempts.filter((a) => a.state !== "unresolved");
  base.attempts.oldestOpenMin = openOnes.length ? Math.round((now.getTime() - openOnes[0].createdAt.getTime()) / 60_000) : null;
  base.attempts.items = attempts.slice(0, 10).map((a) => ({ id: a.id, appointmentId: a.appointmentId, kind: a.kind, state: a.state, ageMin: Math.round((now.getTime() - a.createdAt.getTime()) / 60_000), attempts: a.attempts, lastError: a.lastError }));

  const horizon = new Date(now.getTime() + 48 * 3_600_000);
  const appts = await prisma.appointment.findMany({
    where: { clinicId, status: "confirmed", scheduledAt: { gte: now, lt: horizon } },
    select: { ceBookingUuid: true, ceStatus: true, patientConfirmed: true, cePresenceState: true, ceCancelState: true },
  });
  base.reservations48h.total = appts.length;
  for (const a of appts) {
    if (a.ceBookingUuid) base.reservations48h.linked++; else base.reservations48h.notLinked++;
    if (a.ceStatus && !KNOWN.test(a.ceStatus)) base.reservations48h.unknownState++;
    if (a.patientConfirmed) {
      base.presence48h.patientConfirmed++;
      if (a.cePresenceState === "synced") base.presence48h.syncedWithCe++;
      else if (a.cePresenceState === "pending") base.presence48h.pendingSync++;
      else if (a.cePresenceState === "skipped") base.presence48h.skipped++;
    }
  }
  base.reservations48h.cancelPending = await prisma.appointment.count({ where: { clinicId, ceCancelState: "pending" } });

  const rows = await prisma.reminderDispatch.groupBy({ by: ["state"], where: { clinicId, updatedAt: { gte: new Date(now.getTime() - 24 * 3_600_000) } }, _count: { _all: true } });
  for (const r of rows) base.dispatch24h[r.state] = r._count._all;

  try {
    const [t, tm] = await Promise.all([previewReminders(clinicId, { day: "today", now }), previewReminders(clinicId, { day: "tomorrow", now })]);
    base.nextSends = {
      today: (t.summary.vai_enviar ?? 0) + (t.summary.aguarda_janela ?? 0), tomorrow: (tm.summary.vai_enviar ?? 0) + (tm.summary.aguarda_janela ?? 0),
      paused: (t.summary.aguarda_conexao ?? 0) + (tm.summary.aguarda_conexao ?? 0),
    };
  } catch { /* a previa nunca derruba a saude */ }

  // diagnostico
  const m = base.motivos;
  let level: CeHealth["status"] = acc ? "ok" : "desligado";
  const bump = (to: "atencao" | "problema") => { if (level === "ok" || (level === "atencao" && to === "problema")) level = to; };
  if (acc) {
    if (base.lastSyncAgeMin == null) { bump("atencao"); m.push("ainda não houve sincronização bem-sucedida com o Clínica Experts"); }
    else if (base.lastSyncAgeMin > 60) { bump("problema"); m.push(`a última sincronização boa foi há ${base.lastSyncAgeMin} min`); }
    else if (base.lastSyncAgeMin > 25) { bump("atencao"); m.push(`a última sincronização boa foi há ${base.lastSyncAgeMin} min`); }
    if (base.lastError) { bump("atencao"); m.push(`último erro do Clínica Experts: ${base.lastError.slice(0, 140)}`); }
    if (base.attempts.unresolved) { bump("problema"); m.push(`${base.attempts.unresolved} reserva(s) sem confirmação do Clínica Experts há mais de ${Math.round(UNRESOLVED_AFTER_MS / 3_600_000)} h: a equipe precisa conferir`); }
    if (base.attempts.open) { bump("atencao"); m.push(`${base.attempts.open} escrita(s) no Clínica Experts com resultado incerto (sendo reconciliadas; nada é recriado)`); }
    if (base.reservations48h.notLinked) { bump("atencao"); m.push(`${base.reservations48h.notLinked} agendamento(s) das próximas 48 h ainda sem reserva ligada no Clínica Experts`); }
    if (base.reservations48h.unknownState) { bump("atencao"); m.push(`${base.reservations48h.unknownState} reserva(s) com estado desconhecido no Clínica Experts (não tratadas como confirmadas)`); }
    if (base.reservations48h.cancelPending) { bump("atencao"); m.push(`${base.reservations48h.cancelPending} cancelamento(s) feitos aqui que o Clínica Experts ainda não confirmou`); }
    if (base.presence48h.pendingSync) { bump("atencao"); m.push(`${base.presence48h.pendingSync} confirmação(ões) de presença do paciente ainda não chegaram ao Clínica Experts`); }
  }
  if (whatsapp.paused) { bump("problema"); m.push(`WhatsApp fora do ar desde ${whatsapp.since ?? "?"}: nenhum lembrete é enviado até reconectar`); }
  if (base.dispatch24h.unconfirmed) { bump("atencao"); m.push(`${base.dispatch24h.unconfirmed} lembrete(s) das últimas 24 h sem confirmação de envio (podem ter saído; não são reenviados)`); }
  if (base.dispatch24h.failed || base.dispatch24h.failed_permanent || base.dispatch24h.exhausted) { bump("atencao"); m.push("há lembrete(s) das últimas 24 h que falharam"); }
  base.status = level;
  return base;
}
