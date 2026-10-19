import { prisma } from "../db/client.js";
import { getAccount } from "../clinicaexperts/client.js";
import { logActivity } from "../crm/activity.js";
import { REVISION } from "../version.js";
import { resolveHours, scheduleProblem, type ClinicHours } from "./slots.js";

// ---------------------------------------------------------------------------
// QUEM PODE ATENDER ESTE PROCEDIMENTO (16/10/2026, Lisboa: "horarios fora da jornada das profissionais" e "disponibilidade sem garantir
// compatibilidade com procedimento e profissional habilitada"). UM criterio unico, usado pela consulta de horarios, pela checagem de um horario
// especifico, pelo agendamento e pela remarcacao - o texto que a Alice mostra nunca e a unica barreira: a execucao tambem recusa.
//
// Regras:
//  - So profissional ATIVA E VINCULADA ao procedimento atende. Nao existe "sem vinculo = qualquer uma" numa clinica cuja agenda e o Clinica Experts
//    (a reserva precisa de profissional vinculada la). Clinica sem agenda de profissionais (nenhuma profissional ativa) segue com a agenda unica.
//  - Numa clinica com agenda no CE, profissional sem vinculo com o CE nao e oferecida (a reserva nao poderia ser espelhada).
//  - Cadastro conflitante (jornada com inicio >= fim, intervalo invertido, sem dias de atendimento) bloqueia SO aquela profissional: o resto do
//    atendimento segue. O motivo fica no log e no diario (1x por dia por profissional).
// ---------------------------------------------------------------------------

export interface EligibleProfessional { id: string; name: string; ceUuid: string | null; hours: ClinicHours }
export interface BlockedProfessional { id: string; name: string; reason: string }

export interface Eligibility {
  // "professionals": so as da lista atendem (lista vazia = ninguem pode, NAO cai na agenda da clinica).
  // "clinic": agenda unica da clinica (legado: clinica sem profissionais cadastradas).
  mode: "professionals" | "clinic";
  eligible: EligibleProfessional[];
  blocked: BlockedProfessional[];
  ceAgenda: boolean;
  why: "ok" | "none_linked" | "all_blocked" | "clinic_agenda";
}

interface ClinicRow {
  id: string;
  timezone: string | null;
  workStartHour: number;
  workStartMinute?: number;
  workEndHour: number;
  workEndMinute?: number;
  lunchStartHour?: number | null;
  lunchStartMinute?: number;
  lunchEndHour?: number | null;
  lunchEndMinute?: number;
  workDays: string;
  closedOnHolidays?: boolean;
  holidayOpen?: string;
}

// A agenda desta clinica e o Clinica Experts? (conta conectada E a Alice grava la: a reserva precisa de profissional vinculada)
export async function isCeAgenda(clinicId: string): Promise<boolean> {
  const account = await getAccount(clinicId);
  return !!account && account.syncOut;
}

const logged = new Map<string, number>(); // "profissional|problema" -> quando avisou
const LOG_EVERY_MS = 6 * 3_600_000;

function noteBlocked(clinicId: string, p: BlockedProfessional): void {
  const key = `${p.id}|${p.reason}`;
  const now = Date.now();
  if (now - (logged.get(key) ?? 0) < LOG_EVERY_MS) return;
  logged.set(key, now);
  if (logged.size > 500) for (const [k, at] of logged) if (now - at > LOG_EVERY_MS) logged.delete(k);
  console.warn(`[agenda] profissional bloqueada nas ofertas: clinica=${clinicId} profissional=${p.id} (${p.name}) motivo="${p.reason}" revisao=${REVISION.split(":")[0]}`);
  void logActivity({
    clinicId, type: "agenda_conflict", area: "agenda",
    title: "Cadastro de agenda conflitante",
    description: `${p.name}: ${p.reason}. Ela deixou de receber ofertas de horário da Alice até o cadastro ser corrigido; as demais profissionais seguem normalmente.`,
    actorName: null,
  }).catch(() => undefined);
}

export async function procedureEligibility(clinic: ClinicRow, procedureId: string): Promise<Eligibility> {
  const [pros, ceAgenda] = await Promise.all([
    prisma.professional.findMany({ where: { clinicId: clinic.id, active: true }, include: { procedures: { select: { id: true } } }, orderBy: { createdAt: "asc" } }),
    isCeAgenda(clinic.id),
  ]);
  const linked = pros.filter((p) => p.procedures.some((x) => x.id === procedureId));
  if (linked.length === 0) {
    if (pros.length === 0 || !ceAgenda) return { mode: "clinic", eligible: [], blocked: [], ceAgenda, why: "clinic_agenda" };
    return { mode: "professionals", eligible: [], blocked: [], ceAgenda, why: "none_linked" };
  }
  const eligible: EligibleProfessional[] = [];
  const blocked: BlockedProfessional[] = [];
  for (const p of linked) {
    const hours = resolveHours(clinic as Parameters<typeof resolveHours>[0], p);
    const problem = scheduleProblem(hours) ?? (ceAgenda && !p.ceUuid ? "não está vinculada ao Clínica Experts (a reserva não poderia ser criada lá)" : null);
    if (problem) {
      const b = { id: p.id, name: p.name, reason: problem };
      blocked.push(b);
      noteBlocked(clinic.id, b);
    } else {
      eligible.push({ id: p.id, name: p.name, ceUuid: p.ceUuid, hours });
    }
  }
  return { mode: "professionals", eligible, blocked, ceAgenda, why: eligible.length ? "ok" : "all_blocked" };
}

// Quem entra na busca: o que o chamador pediu (ids) cruzado com a elegibilidade. `blocked` = ninguem pode (NAO cair na agenda da clinica).
export function candidateIds(el: Eligibility, requested: string[]): { ids: string[]; blocked: boolean; reason?: "no_professional" | "professional_not_eligible" } {
  if (el.mode === "clinic") return { ids: requested, blocked: false };
  const ok = new Set(el.eligible.map((p) => p.id));
  if (requested.length === 0) {
    return el.eligible.length ? { ids: [...ok], blocked: false } : { ids: [], blocked: true, reason: "no_professional" };
  }
  const ids = requested.filter((id) => ok.has(id));
  return ids.length ? { ids, blocked: false } : { ids: [], blocked: true, reason: el.eligible.length ? "professional_not_eligible" : "no_professional" };
}
