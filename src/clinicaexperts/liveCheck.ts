import { prisma } from "../db/client.js";
import { ceRequest, getAccount, type CeErrorKind } from "./client.js";
import { logActivity } from "../crm/activity.js";
import { ceStatusInfo, hasExplicitOffset, parseCeInstant } from "./contract.js";
import { scheduleBriefingRefreshForAppointment } from "../ai/leadBriefing.js";

// ---------------------------------------------------------------------------
// CONFERE NO CLINICA EXPERTS ANTES DE MANDAR (pedido da Lisboa, 16/10/2026: "todos os clientes que cancelaram ou remarcaram continuam
// recebendo a confirmacao, mas nem estao mais na agenda"). A Alice guarda uma COPIA da agenda do CE e a atualiza a cada 10 min; quando a
// recepcao cancela, apaga ou troca o horario la, a copia fica velha (a reserva some da listagem ou volta com outro horario/uuid) e o
// lembrete saia pro horario antigo. Antes de mandar qualquer lembrete de um agendamento ligado ao CE, a reserva e consultada ao vivo:
//   - cancelada ou apagada = cancela aqui e nao manda; atendida / falta = marca assim aqui (cada estado com o seu significado) e nao manda;
//   - horario trocado = corrige aqui e nao manda o antigo;
//   - CONFERENCIA INCONCLUSIVA (timeout, CE fora do ar, token recusado, resposta sem status/horario, outra reserva) = ADIA: nao envia, nao
//     cancela, nao altera nada e nao consome o lembrete. Quem chama (reminders/cron.ts) tenta de novo nas proximas rodadas, so enquanto a
//     janela de envio ainda valer. Dado ausente NUNCA vira "esta tudo certo".
// ---------------------------------------------------------------------------

export type LocalEnd = "cancelled" | "completed" | "no_show";

// O que o CE devolveu (so status e horario em texto, para o log de decisao: "qual informacao a Alice recebeu"). Sem dados pessoais.
export interface CeSeen { status?: string; startsAt?: string }

export type LiveVerdict =
  | { kind: "ok"; seen?: CeSeen } // reserva ativa e o horario confere
  | { kind: "gone"; why: string; localStatus: LocalEnd; seen?: CeSeen } // nao deve receber o lembrete; o status daqui acompanha o do CE
  | { kind: "moved"; to: Date; endsAt?: Date | null; seen?: CeSeen } // horario trocado la (instante com fuso): corrige aqui e nao manda o antigo
  | { kind: "unknown"; reason: string; systemic: boolean } // inconclusivo: ADIAR. systemic = problema do CE/rede/token (vale pra todas as reservas da clinica)
  | { kind: "unlinked" }; // reserva so da Alice (sem vinculo com o CE) ou CE desconectado: segue como sempre

// "send" = pode enviar; "skip" = nao envia (a copia estava velha e ja foi corrigida); "defer" = nao envia AGORA e tenta de novo.
export type LiveAction = "send" | "skip" | "defer";

// PURO: o que o CE disse sobre a reserva (GET /bookings/{uuid}; 404/410 = apagada). Formatos suportados: corpo { data: { uuid, status, starts_at } }
// (ou o objeto direto), status em texto ("scheduled", "canceled"...), starts_at ISO com ou sem fuso (sem fuso = horario de parede da clinica).
export function judgeLiveBooking(
  appt: { scheduledAt: Date; ceBookingUuid?: string | null },
  res: { ok: true; data: unknown } | { ok: false; status: number; kind?: CeErrorKind },
  tz: string,
  now = new Date(),
): LiveVerdict {
  if (!res.ok) {
    if (res.kind === "invalid_response") return { kind: "unknown", systemic: true, reason: "o Clínica Experts respondeu com um corpo ilegível ou vazio" };
    if (res.status === 404 || res.status === 410) return { kind: "gone", why: "a reserva foi apagada no Clínica Experts", localStatus: "cancelled" };
    if (res.status === 401 || res.status === 403) return { kind: "unknown", systemic: true, reason: "o Clínica Experts recusou o acesso (token inválido ou sem permissão)" };
    if (res.status === 0) return { kind: "unknown", systemic: true, reason: "sem resposta do Clínica Experts (rede ou tempo esgotado)" };
    if (res.status === 429 || res.status >= 500) return { kind: "unknown", systemic: true, reason: `o Clínica Experts não conseguiu responder (${res.status})` };
    return { kind: "unknown", systemic: false, reason: `resposta inesperada do Clínica Experts (${res.status})` };
  }
  const root = res.data as { data?: unknown } | null;
  const b = ((root && typeof root === "object" && !Array.isArray(root) && "data" in root ? root.data : root) ?? null) as { uuid?: unknown; status?: unknown; starts_at?: unknown } | null;
  if (!b || typeof b !== "object" || Array.isArray(b)) return { kind: "unknown", systemic: false, reason: "resposta do Clínica Experts sem os dados da reserva" };
  if (typeof b.uuid === "string" && appt.ceBookingUuid && b.uuid !== appt.ceBookingUuid) return { kind: "unknown", systemic: false, reason: "o Clínica Experts devolveu outra reserva" };

  // status: obrigatorio. Cada estado terminal tem o SEU significado (nao e tudo "cancelada").
  if (typeof b.status !== "string" || !b.status.trim()) return { kind: "unknown", systemic: false, reason: "resposta do Clínica Experts sem o status da reserva" };
  const info = ceStatusInfo(b.status);
  const st = info.meaning;
  const seen: CeSeen = { status: b.status.trim().slice(0, 30), startsAt: typeof b.starts_at === "string" ? b.starts_at.trim().slice(0, 40) : undefined };
  // estado que a Alice nao conhece NUNCA vira "reserva ativa": nao envia, nao cancela, nao altera (ADIA) e o texto bruto fica no motivo
  if (st == null) return { kind: "unknown", systemic: false, reason: `estado de reserva desconhecido no Clínica Experts ("${info.raw.slice(0, 30)}")` };
  if (st === "cancelled") return { kind: "gone", why: "a reserva foi cancelada no Clínica Experts", localStatus: "cancelled", seen };
  if (st === "no_show") return { kind: "gone", why: "a reserva foi marcada como falta no Clínica Experts", localStatus: "no_show", seen };
  if (st === "completed") return { kind: "gone", why: "a reserva já consta como atendida no Clínica Experts", localStatus: "completed", seen };

  // horario: obrigatorio. Sem ele nao da pra confirmar que o lembrete e do horario certo.
  if (typeof b.starts_at !== "string" || !b.starts_at.trim()) return { kind: "unknown", systemic: false, reason: "resposta do Clínica Experts sem o horário da reserva" };
  const raw = b.starts_at.trim();
  const at = parseCeInstant(raw, tz);
  if (Number.isNaN(at.getTime())) return { kind: "unknown", systemic: false, reason: "horário da reserva ilegível no Clínica Experts" };
  if (Math.abs(at.getTime() - appt.scheduledAt.getTime()) < 60_000) return { kind: "ok", seen };
  // Horario diferente: so e "trocou" quando o CE devolve o instante COM fuso (sem fuso a leitura poderia deslocar 3h e corromper o horario) e no futuro.
  if (hasExplicitOffset(raw) && at.getTime() > now.getTime()) {
    const endRaw = typeof (b as { ends_at?: unknown }).ends_at === "string" ? ((b as { ends_at: string }).ends_at).trim() : "";
    const end = endRaw ? parseCeInstant(endRaw, tz) : null;
    return { kind: "moved", to: at, endsAt: end && !Number.isNaN(end.getTime()) && end.getTime() > at.getTime() ? end : null, seen };
  }
  return { kind: "unknown", systemic: false, reason: "horário da reserva no Clínica Experts diverge do cadastrado e não dá pra confirmar qual vale" };
}

export async function verifyBookingLive(appt: { clinicId: string; ceBookingUuid: string | null; scheduledAt: Date }, tz: string): Promise<LiveVerdict> {
  if (!appt.ceBookingUuid) return { kind: "unlinked" }; // nao veio do CE nem foi espelhado: nada pra conferir la
  try {
    if (!(await getAccount(appt.clinicId))) return { kind: "unlinked" }; // CE desconectado da clinica: o vinculo antigo nao tem mais o que conferir
    const res = await ceRequest<unknown>(appt.clinicId, `/bookings/${appt.ceBookingUuid}`);
    return judgeLiveBooking(appt, res.ok ? { ok: true, data: res.data } : { ok: false, status: res.status, kind: res.kind }, tz);
  } catch (err) {
    console.error("[lembrete] falha ao conferir a reserva no CE:", err instanceof Error ? err.message : err);
    return { kind: "unknown", systemic: true, reason: "falha ao consultar o Clínica Experts" }; // a conferencia nunca derruba o ciclo dos lembretes
  }
}

const GONE_ACTIVITY: Record<LocalEnd, { type: string; title: string }> = {
  cancelled: { type: "appointment_cancelled", title: "Agendamento cancelado no Clínica Experts" },
  completed: { type: "appointment_completed", title: "Atendimento concluído no Clínica Experts" },
  no_show: { type: "appointment_no_show", title: "Falta registrada no Clínica Experts" },
};

// Aplica o veredito na copia local e diz o que fazer com o lembrete. "unknown" NAO altera nada.
export async function applyLiveVerdict(
  appt: { id: string; clinicId: string; patientId: string; scheduledAt: Date; endsAt?: Date | null },
  verdict: LiveVerdict,
  label: string,
): Promise<LiveAction> {
  switch (verdict.kind) {
    case "gone": {
      await prisma.appointment.updateMany({
        where: { id: appt.id, status: "confirmed" },
        data: {
          status: verdict.localStatus,
          // origem do cancelamento: so "cancelada" no CE prova; reserva APAGADA pode ser remarcacao/troca (nao e desistencia)
          ...(verdict.localStatus === "cancelled" ? { cancelledAt: new Date(), cancelSource: /apagada/i.test(verdict.why) ? "ce_apagada" : "ce_cancelada", ceCancelState: "confirmed" } : {}),
          ceSyncedAt: new Date(),
        },
      });
      const a = GONE_ACTIVITY[verdict.localStatus];
      await logActivity({
        clinicId: appt.clinicId, patientId: appt.patientId, type: a.type, area: "agenda", title: a.title,
        description: `${label}: ${verdict.why}. A confirmação automática não foi enviada.`, actorName: null,
      }).catch(() => undefined);
      console.warn(`[lembrete] ${label}: ${verdict.why} - lembrete NAO enviado (agendamento agora: ${verdict.localStatus})`);
      scheduleBriefingRefreshForAppointment(appt.id);
      return "skip";
    }
    case "moved":
      // novo horario: corrige a copia, zera a confirmacao do horario antigo e libera os lembretes pra sairem no horario novo.
      // (O historico de envios do horario antigo fica no controle ReminderDispatch; so a reserva atual e liberada.)
      // (fim: o que o CE informou; sem ele, mantem a duracao da reserva)
      await prisma.appointment.update({
        where: { id: appt.id },
        data: {
          scheduledAt: verdict.to, patientConfirmed: false, confirmedAt: null, cePresenceState: null, cePresenceAt: null, ceSyncedAt: new Date(),
          endsAt: verdict.endsAt ?? new Date(verdict.to.getTime() + (appt.endsAt ? appt.endsAt.getTime() - appt.scheduledAt.getTime() : 0)),
        },
      });
      await prisma.reminderSent.deleteMany({ where: { appointmentId: appt.id } });
      console.warn(`[lembrete] ${label}: o horario mudou no Clínica Experts - corrigido; lembrete do horario antigo NAO enviado`);
      scheduleBriefingRefreshForAppointment(appt.id);
      return "skip";
    case "unknown":
      return "defer";
    default:
      return "send"; // ok / unlinked
  }
}

// Reservas que a Alice tem como confirmadas, futuras e ligadas ao CE, dentro da janela que a importacao acabou de ler, mas que o CE
// NAO devolveu: foram apagadas/trocadas la. Cada uma e conferida ao vivo (GET /bookings/{uuid}) antes de ser cancelada aqui. Falha tecnica
// (inconclusivo) NUNCA cancela: a reserva fica como esta.
export async function reconcileMissingBookings(
  clinicId: string,
  returnedUuids: Set<string>,
  window: { from: Date; to: Date },
  tz: string,
): Promise<{ checked: number; cancelled: number; moved: number; inconclusive: number }> {
  const locals = await prisma.appointment.findMany({
    where: { clinicId, status: "confirmed", ceBookingUuid: { not: null }, scheduledAt: { gte: window.from, lt: window.to } },
    include: { patient: { select: { name: true, phone: true } } },
    take: 60,
  });
  const out = { checked: 0, cancelled: 0, moved: 0, inconclusive: 0 };
  for (const a of locals) {
    if (!a.ceBookingUuid || returnedUuids.has(a.ceBookingUuid)) continue;
    out.checked++;
    const verdict = await verifyBookingLive(a, tz);
    if (verdict.kind === "unknown") {
      out.inconclusive++;
      if (verdict.systemic) break; // CE fora do ar / token recusado: nao adianta insistir nas demais agora
      continue;
    }
    if (verdict.kind === "gone" || verdict.kind === "moved") {
      await applyLiveVerdict(a, verdict, `${a.patient.name ?? a.patient.phone}`);
      if (verdict.kind === "gone") out.cancelled++;
      else out.moved++;
    }
  }
  return out;
}

// ESTADOS FINAIS REGISTRADOS TARDE: a recepcao lanca "concluido"/"falta"/"cancelada" dias depois do atendimento, fora da janela de importacao (hoje -2 dias). Recuperacao LIMITADA
// e auditavel: so agendamentos ligados ao CE que seguem como "confirmados" ha ate `days` dias, no maximo `max` por rodada e cada um conferido no maximo a cada 6 h. Nao varre historico:
// quem nunca esteve aqui nao e criado. Cada mudanca fica no Diario de atividades.
export async function recoverLateStatuses(
  clinicId: string,
  tz: string,
  opts: { days?: number; max?: number; now?: Date; recheckMs?: number } = {},
): Promise<{ checked: number; updated: number; inconclusive: number }> {
  const now = opts.now ?? new Date();
  const days = opts.days ?? 7;
  const out = { checked: 0, updated: 0, inconclusive: 0 };
  const pastWindowEnd = new Date(now.getTime() - 2 * 24 * 3_600_000); // a importacao normal ja cuida dos ultimos dias
  const stale = new Date(now.getTime() - (opts.recheckMs ?? 6 * 3_600_000));
  const rows = await prisma.appointment.findMany({
    where: {
      clinicId, status: "confirmed", ceBookingUuid: { not: null },
      scheduledAt: { gte: new Date(now.getTime() - days * 24 * 3_600_000), lt: pastWindowEnd },
      OR: [{ ceSyncedAt: null }, { ceSyncedAt: { lt: stale } }],
    },
    include: { patient: { select: { name: true, phone: true } }, attendee: { select: { name: true } } },
    orderBy: { scheduledAt: "desc" },
    take: opts.max ?? 25,
  });
  for (const a of rows) {
    out.checked++;
    const verdict = await verifyBookingLive(a, tz);
    if (verdict.kind === "unknown") {
      out.inconclusive++;
      if (verdict.systemic) break;
      continue;
    }
    if (verdict.kind === "gone") {
      const who = a.attendee?.name ?? a.patient.name ?? a.patient.phone;
      const done = await prisma.appointment.updateMany({
        where: { id: a.id, status: "confirmed" },
        data: { status: verdict.localStatus, ceSyncedAt: now, ...(verdict.localStatus === "cancelled" ? { cancelledAt: now, cancelSource: "ce_cancelada", ceCancelState: "confirmed" } : {}) },
      });
      if (done.count) {
        out.updated++;
        const t = GONE_ACTIVITY[verdict.localStatus];
        await logActivity({ clinicId, patientId: a.patientId, type: t.type, area: "agenda", title: `${t.title} (registrado depois)`, description: `${who}: ${verdict.why}; o estado final só foi registrado no Clínica Experts depois da janela normal de importação.`, actorName: null }).catch(() => undefined);
        scheduleBriefingRefreshForAppointment(a.id);
      }
      continue;
    }
    await prisma.appointment.update({ where: { id: a.id }, data: { ceSyncedAt: now } }); // conferido: segue como esta
  }
  return out;
}
