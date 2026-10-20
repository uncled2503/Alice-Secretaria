import type { CeBookingParsed } from "./contract.js";
import { foldName, namesCompatible, samePhone } from "./identity.js";
export { foldName, namesCompatible };

// ---------------------------------------------------------------------------
// "ESTA RESERVA DO CE E ESTE AGENDAMENTO DA ALICE?" Funcao PURA, usada para (a) ligar uma reserva importada a um agendamento local que ainda nao tinha o vinculo e (b) reconciliar
// uma criacao com resultado INCERTO (rede caiu / tempo esgotado). So liga quando TUDO que da pra comparar confere: pessoa, profissional, procedimentos, inicio e fim. Dois
// agendamentos no mesmo horario com profissionais ou procedimentos diferentes sao reservas DIFERENTES (nunca a mesma) e nunca podem ser fundidos.
// ---------------------------------------------------------------------------

export interface LocalReservation {
  id: string;
  status: string;
  ceBookingUuid: string | null;
  scheduledAt: Date;
  endsAt: Date | null;
  durationMin: number; // duracao da reserva (soma dos procedimentos / procedimento principal) quando endsAt e desconhecido
  professionalCeUuid: string | null;
  procedureCeIds: number[]; // ids do CE dos procedimentos locais da reserva (vazio = desconhecido)
  personCeUuid: string | null; // uuid do ATENDIDO (paciente ou acompanhante)
  personName: string | null;
  personPhone: string | null; // telefone de contato
}

export interface MatchOptions {
  toleranceMs?: number;
  allowMissingProcedures?: boolean; // reserva do CE sem procedimento escolhido ainda (recepcao): nao impede a ligacao
  allowUnknownProfessional?: boolean; // profissional sem vinculo de um dos lados: "desconhecido" nao e "diferente" (so a importacao; a reconciliacao de uma criacao exige os dois)
}

export type MatchVerdict = { match: true } | { match: false; reasons: string[] };

export function matchReservation(local: LocalReservation, ce: CeBookingParsed, opts: MatchOptions = {}): MatchVerdict {
  const tol = opts.toleranceMs ?? 60_000;
  const reasons: string[] = [];
  if (local.ceBookingUuid && local.ceBookingUuid !== ce.uuid) reasons.push("o agendamento ja esta ligado a outra reserva");
  if (local.ceBookingUuid === ce.uuid) return { match: true };
  if (local.status === "cancelled") reasons.push("agendamento cancelado aqui");
  if (ce.status.meaning === "cancelled") reasons.push("reserva cancelada no CE");
  if (Math.abs(ce.startsAt.getTime() - local.scheduledAt.getTime()) > tol) reasons.push("inicio diferente");
  if (ce.endsAt) {
    const localEnd = local.endsAt ?? new Date(local.scheduledAt.getTime() + local.durationMin * 60_000);
    if (Math.abs(ce.endsAt.getTime() - localEnd.getTime()) > tol) reasons.push("fim diferente");
  }
  if (local.professionalCeUuid && ce.professionalUuid) {
    if (local.professionalCeUuid !== ce.professionalUuid) reasons.push("profissional diferente");
  } else if (!opts.allowUnknownProfessional) reasons.push("profissional nao comparavel");
  const ceProcs = ce.procedures.map((p) => p.id);
  if (ceProcs.length && local.procedureCeIds.length) {
    const a = [...new Set(ceProcs)].sort((x, y) => x - y).join(",");
    const b = [...new Set(local.procedureCeIds)].sort((x, y) => x - y).join(",");
    if (a !== b) reasons.push("procedimentos diferentes");
  } else if (!opts.allowMissingProcedures) reasons.push("procedimentos nao comparaveis");
  // sem procedimento comparavel (a recepcao ainda nao escolheu / a Alice ainda nao vinculou): so desempata o PROFISSIONAL, e ele precisa ser conhecido e igual dos dois lados
  else if (!(local.professionalCeUuid && ce.professionalUuid && local.professionalCeUuid === ce.professionalUuid)) reasons.push("sem procedimento comparavel e sem profissional igual para desempatar");
  // pessoa: uuid do CE quando os dois lados tem; senao telefone + nome compativel
  if (local.personCeUuid && ce.patient?.uuid) {
    if (local.personCeUuid !== ce.patient.uuid) reasons.push("paciente diferente");
  } else if (!samePhone(ce.patient?.phone, local.personPhone) || !namesCompatible(ce.patient?.name, local.personName)) reasons.push("paciente nao confere");
  return reasons.length ? { match: false, reasons } : { match: true };
}

// Entre varios agendamentos locais, o UNICO que combina. Mais de um (ou nenhum) = nada e ligado (a equipe confere): nunca escolhe o primeiro.
export function pickUniqueMatch<T extends LocalReservation>(locals: T[], ce: CeBookingParsed, opts: MatchOptions = {}): { status: "one"; item: T } | { status: "none" } | { status: "ambiguous"; count: number } {
  const hits = locals.filter((l) => matchReservation(l, ce, opts).match);
  if (hits.length === 1) return { status: "one", item: hits[0] };
  return hits.length === 0 ? { status: "none" } : { status: "ambiguous", count: hits.length };
}
