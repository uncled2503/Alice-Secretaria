import { prisma } from "../db/client.js";
import { resolveHours } from "../scheduling/slots.js";
import { nationalHolidayOn } from "../scheduling/holidays.js";
import { zonedWallClockToUtc, isoDateInZone } from "../scheduling/time.js";
import { notifyStaff } from "./notify.js";
import { logActivity } from "./activity.js";
import { scheduleLocked } from "../jobs/lock.js";

// ---------------------------------------------------------------------------
// AGENDA FRACA (48-72h) e OPORTUNIDADE POR PROFISSIONAL/SERVICO (lote 4, 22/10/2026). Ocupacao = minutos reservados / minutos de jornada (jornada resolvida do profissional:
// dias, horario e almoco; feriado nacional fechado conforme a clinica). Fonte: a agenda da Alice (com Clinica Experts, a importada a cada 10 min). Bloqueios que existam SO no
// sistema externo e nao foram importados nao entram: o relatorio diz isso (nunca apresenta como capacidade certa).
// A SUGESTAO de campanha so lista os procedimentos que o profissional realiza e que CABEM nas janelas livres reais; nada e criado nem enviado sozinho.
// Alerta: so com limite configurado pela clinica (Clinic.weakAgendaPct; null = desligado), uma vez por data (registro no diario de atividades evita repeticao).
// ---------------------------------------------------------------------------
export interface FreeBlock { start: string; end: string; minutes: number }
export interface ProDay { professionalId: string; nome: string; data: string; jornadaMin: number; reservadoMin: number; ocupacaoPct: number | null; livres: FreeBlock[]; cabem: string[]; motivo?: string }

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// PURO: blocos livres de um dia (minutos locais) dados a jornada, o almoco e os intervalos ocupados.
export function freeBlocks(start: number, end: number, lunch: [number, number] | null, busy: [number, number][]): [number, number][] {
  const cuts = [...busy, ...(lunch ? [lunch] : [])].map(([a, b]) => [Math.max(start, a), Math.min(end, b)] as [number, number]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  let cur = start;
  for (const [a, b] of cuts) { if (a > cur) out.push([cur, a]); cur = Math.max(cur, b); }
  if (cur < end) out.push([cur, end]);
  return out;
}

export async function agendaOccupancy(clinicId: string, dates: string[]): Promise<{ fonte: string; dias: ProDay[] }> {
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId } });
  const tz = clinic.timezone || "America/Sao_Paulo";
  const pros = await prisma.professional.findMany({ where: { clinicId, active: true }, include: { procedures: { where: { internalOnly: false }, select: { name: true, durationMin: true } } } });
  const dias: ProDay[] = [];
  for (const date of dates) {
    const [y, m, d] = date.split("-").map(Number);
    const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const holiday = nationalHolidayOn(y, m, d);
    const dayStart = zonedWallClockToUtc(tz, y, m, d, 0, 0);
    const n = new Date(Date.UTC(y, m - 1, d + 1));
    const dayEnd = zonedWallClockToUtc(tz, n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), 0, 0);
    for (const p of pros) {
      const h = resolveHours(clinic, p);
      const base = { professionalId: p.id, nome: p.name, data: date };
      if (!h.workDays.has(wd)) continue; // nao trabalha neste dia: nao e "agenda fraca"
      if (holiday && h.closedOnHolidays && !h.holidayOpen?.has(holiday)) { dias.push({ ...base, jornadaMin: 0, reservadoMin: 0, ocupacaoPct: null, livres: [], cabem: [], motivo: `feriado (${holiday})` }); continue; }
      const lunch: [number, number] | null = h.lunchStartMinutes != null && h.lunchEndMinutes != null ? [h.lunchStartMinutes, h.lunchEndMinutes] : null;
      const jornada = h.workEndMinutes - h.workStartMinutes - (lunch ? Math.max(0, lunch[1] - lunch[0]) : 0);
      const appts = await prisma.appointment.findMany({ where: { clinicId, professionalId: p.id, status: "confirmed", scheduledAt: { lt: dayEnd, gt: new Date(dayStart.getTime() - 12 * 3_600_000) } }, select: { scheduledAt: true, endsAt: true, procedure: { select: { durationMin: true } } } });
      const toMin = (dt: Date) => { const iso = isoDateInZone(dt, tz); if (iso < date) return 0; if (iso > date) return 24 * 60; const s = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(dt).split(":").map(Number); return s[0] * 60 + s[1]; };
      const busy = appts.map((a) => [toMin(a.scheduledAt), toMin(a.endsAt ?? new Date(a.scheduledAt.getTime() + a.procedure.durationMin * 60_000))] as [number, number]).filter(([a, b]) => b > 0 && a < 24 * 60);
      const free = freeBlocks(h.workStartMinutes, h.workEndMinutes, lunch, busy);
      const freeMin = free.reduce((s, [a, b]) => s + (b - a), 0);
      const reservado = Math.max(0, jornada - freeMin);
      const biggest = free.reduce((mx, [a, b]) => Math.max(mx, b - a), 0);
      dias.push({
        ...base, jornadaMin: jornada, reservadoMin: reservado, ocupacaoPct: jornada > 0 ? Math.round((reservado / jornada) * 100) : null,
        livres: free.map(([a, b]) => ({ start: hhmm(a), end: hhmm(b), minutes: b - a })),
        cabem: p.procedures.filter((pr) => pr.durationMin <= biggest).map((pr) => pr.name).slice(0, 12),
      });
    }
  }
  return { fonte: "agenda da Alice (reservas importadas do sistema de agenda quando integrado). Bloqueios que existam só no sistema externo e não foram importados não entram na conta.", dias };
}

// Datas locais daqui a 2 e 3 dias (48-72h).
export function weakWindowDates(now: Date, tz: string): string[] {
  const [y, m, d] = isoDateInZone(now, tz).split("-").map(Number);
  return [2, 3].map((k) => new Date(Date.UTC(y, m - 1, d + k)).toISOString().slice(0, 10));
}

export async function runWeakAgendaAlert(now = new Date()): Promise<number> {
  let sent = 0;
  const clinics = await prisma.clinic.findMany({ where: { weakAgendaPct: { not: null } }, select: { id: true, timezone: true, weakAgendaPct: true } });
  for (const c of clinics) {
    try {
      const dates = weakWindowDates(now, c.timezone || "America/Sao_Paulo");
      const occ = await agendaOccupancy(c.id, dates);
      for (const date of dates) {
        const fracos = occ.dias.filter((x) => x.data === date && x.ocupacaoPct != null && x.ocupacaoPct < c.weakAgendaPct!);
        if (!fracos.length) continue;
        const marker = `agenda-fraca:${date}`;
        const already = await prisma.activityLog.findFirst({ where: { clinicId: c.id, type: "weak_agenda_alert", description: { startsWith: marker } }, select: { id: true } });
        if (already) continue; // uma vez por data
        const text = `📉 Agenda de ${date.split("-").reverse().join("/")} abaixo de ${c.weakAgendaPct}%: ${fracos.map((f) => `${f.nome} ${f.ocupacaoPct}% (livre: ${f.livres.slice(0, 3).map((l) => `${l.start}-${l.end}`).join(", ")})`).join("; ")}. Sugestão (não enviada): ofertar o que cabe nesses horários.`;
        const r = await notifyStaff(c.id, "weak_agenda", text).catch(() => "failed" as const);
        await logActivity({ clinicId: c.id, type: "weak_agenda_alert", area: "agenda", title: "Agenda fraca (48–72h)", description: `${marker} | aviso: ${r} | ${text}`.slice(0, 900), actorName: null });
        if (r === "sent") sent++;
      }
    } catch (err) {
      console.error(`[agenda-fraca] clinica ${c.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return sent;
}

export function startWeakAgendaJob(): void {
  scheduleLocked("agenda-fraca", "0 13 * * *", () => runWeakAgendaAlert().then(() => undefined)); // 10h em Sao Paulo
}
