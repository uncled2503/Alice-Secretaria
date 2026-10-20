// FIM DA RESERVA. A agenda e ocupada pela RESERVA inteira, nao pelo primeiro procedimento: uma reserva do Clinica Experts pode ter varios procedimentos e um horario final proprio
// (ends_at). Ordem de confianca: fim gravado pelo CE (endsAt) > soma das duracoes dos procedimentos da reserva > duracao do procedimento principal (registros antigos).
export interface ReservationLike {
  scheduledAt: Date;
  endsAt?: Date | null;
  procedure: { durationMin: number };
  procedures?: { durationMin: number | null }[];
}

export function reservationDurationMin(a: ReservationLike): number {
  if (a.endsAt && a.endsAt.getTime() > a.scheduledAt.getTime()) return Math.round((a.endsAt.getTime() - a.scheduledAt.getTime()) / 60_000);
  const sum = (a.procedures ?? []).reduce((acc, p) => acc + (p.durationMin && p.durationMin > 0 ? p.durationMin : 0), 0);
  return sum > 0 ? sum : a.procedure.durationMin;
}

export function reservationEndMs(a: ReservationLike): number {
  return a.scheduledAt.getTime() + reservationDurationMin(a) * 60_000;
}

// PURO: novo fim da reserva quando o INICIO muda (mantem a duracao gravada). null = sem fim gravado (cai na duracao dos procedimentos).
export function shiftedEnd(a: { scheduledAt: Date; endsAt?: Date | null }, newStart: Date): Date | null {
  return a.endsAt && a.endsAt.getTime() > a.scheduledAt.getTime() ? new Date(newStart.getTime() + (a.endsAt.getTime() - a.scheduledAt.getTime())) : null;
}

// select de Prisma com o que o calculo precisa
export const RESERVATION_SELECT = {
  scheduledAt: true,
  endsAt: true,
  ceBookingUuid: true,
  procedure: { select: { durationMin: true } },
  procedures: { select: { durationMin: true } },
} as const;
