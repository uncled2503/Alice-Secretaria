import { prisma } from "../db/client.js";
import { getAccount } from "./client.js";
import { listCeProcedures, type CeProcedure } from "./autoLink.js";
import { nameSimilarity, procKey } from "./procKey.js";

// ---------------------------------------------------------------------------
// PROCEDIMENTOS CERTOS NA AGENDA DO CLINICA EXPERTS (pedido da Lisboa, 14/10/2026). Para a Alice criar a reserva la, o procedimento da Alice
// precisa estar VINCULADO (Procedure.ceId) a um procedimento do CE, e o profissional tambem (Professional.ceUuid). Sem o vinculo a reserva
// nao era espelhada (so um alerta) e o horario ficava livre no CE. Aqui:
//  - planProcedureLinks / auditProcedureLinks: vincula SO o que tem o mesmo nome (sem acento/pontuacao) e mostra o resto pra revisao
//    (nunca "chuta": "Criolipolise (2 placas)" e "Criolipolise" sao procedimentos diferentes);
//  - ceBookingReadiness: antes de a Alice agendar, confere (e tenta vincular) o procedimento e o profissional; se nao der, ela NAO agenda
//    sozinha: passa pra equipe lancar, em vez de criar um agendamento que nao existe no CE.
// ---------------------------------------------------------------------------

export interface AliceProc {
  id: string;
  name: string;
  ceId: number | null;
  internalOnly: boolean;
}

export interface LinkPlan {
  toLink: { aliceId: string; aliceName: string; ceId: number; ceName: string }[]; // nome igual: vincula sozinho
  alreadyLinked: number;
  stale: { aliceName: string; ceId: number }[]; // ceId que nao existe (mais) no CE ou esta inativo
  ambiguous: { aliceName: string; candidates: string[] }[]; // mais de um procedimento do CE com o mesmo nome
  unmatched: { aliceName: string; suggestions: string[] }[]; // sem igual no CE (sugestoes so para a pessoa revisar)
  ceOnly: string[]; // procedimentos ativos do CE que a Alice nao tem
}

export function planProcedureLinks(alice: AliceProc[], ce: Pick<CeProcedure, "id" | "name" | "active">[]): LinkPlan {
  const plan: LinkPlan = { toLink: [], alreadyLinked: 0, stale: [], ambiguous: [], unmatched: [], ceOnly: [] };
  const ceById = new Map(ce.map((c) => [c.id, c]));
  const usedCeIds = new Set(alice.filter((a) => a.ceId != null).map((a) => a.ceId as number));
  const claimed = new Set<number>();

  for (const a of alice) {
    if (a.internalOnly && a.ceId == null) continue; // item interno que a Alice nao vende
    if (a.ceId != null) {
      const c = ceById.get(a.ceId);
      if (c && c.active) plan.alreadyLinked++;
      else plan.stale.push({ aliceName: a.name, ceId: a.ceId });
      continue;
    }
    const key = procKey(a.name);
    const same = ce.filter((c) => c.active && procKey(c.name) === key && !usedCeIds.has(c.id) && !claimed.has(c.id));
    if (same.length === 1) {
      claimed.add(same[0].id);
      plan.toLink.push({ aliceId: a.id, aliceName: a.name, ceId: same[0].id, ceName: same[0].name });
    } else if (same.length > 1) {
      plan.ambiguous.push({ aliceName: a.name, candidates: same.map((c) => c.name) });
    } else {
      const suggestions = ce
        .filter((c) => c.active)
        .map((c) => ({ name: c.name, s: nameSimilarity(a.name, c.name) }))
        .filter((x) => x.s >= 0.5)
        .sort((x, y) => y.s - x.s)
        .slice(0, 3)
        .map((x) => x.name);
      plan.unmatched.push({ aliceName: a.name, suggestions });
    }
  }
  const linkedCe = new Set([...usedCeIds, ...claimed]);
  plan.ceOnly = ce.filter((c) => c.active && !linkedCe.has(c.id)).map((c) => c.name);
  return plan;
}

export interface LinkAudit extends LinkPlan {
  dryRun: boolean;
  applied: number;
  error?: string;
}

export async function auditProcedureLinks(clinicId: string, opts: { dryRun: boolean }): Promise<LinkAudit> {
  const empty: LinkAudit = { dryRun: opts.dryRun, applied: 0, toLink: [], alreadyLinked: 0, stale: [], ambiguous: [], unmatched: [], ceOnly: [] };
  if (!(await getAccount(clinicId))) return { ...empty, error: "Clinica Experts nao conectado." };
  const ce = await listCeProcedures(clinicId);
  if (!ce) return { ...empty, error: "Nao consegui ler os procedimentos do Clinica Experts (veja o erro na tela)." };
  const alice = await prisma.procedure.findMany({ where: { clinicId }, select: { id: true, name: true, ceId: true, internalOnly: true } });
  const plan = planProcedureLinks(alice, ce);
  let applied = 0;
  if (!opts.dryRun) {
    for (const l of plan.toLink) {
      const r = await prisma.procedure.updateMany({ where: { id: l.aliceId, ceId: null }, data: { ceId: l.ceId } });
      applied += r.count;
    }
  }
  return { ...plan, dryRun: opts.dryRun, applied };
}

export type Readiness = { ok: true } | { ok: false; reason: string };

// Antes da Alice agendar: o procedimento e o profissional tem vinculo com o CE? Tenta vincular o procedimento por nome igual. So vale quando o
// CE esta conectado com a opcao de espelhar agendamentos ligada.
export async function ceBookingReadiness(clinicId: string, procedureId: string, professionalId: string | null): Promise<Readiness> {
  const account = await getAccount(clinicId);
  if (!account || !account.syncOut) return { ok: true };
  const proc = await prisma.procedure.findFirst({ where: { id: procedureId, clinicId }, select: { id: true, name: true, ceId: true } });
  if (!proc) return { ok: true }; // quem chamou ja trata procedimento inexistente
  if (proc.ceId == null) {
    const ce = await listCeProcedures(clinicId);
    const hit = ce?.filter((c) => c.active && procKey(c.name) === procKey(proc.name)) ?? [];
    const taken = hit.length === 1 ? await prisma.procedure.count({ where: { clinicId, ceId: hit[0].id } }) : 1;
    if (hit.length === 1 && taken === 0) {
      await prisma.procedure.update({ where: { id: proc.id }, data: { ceId: hit[0].id } });
    } else {
      return { ok: false, reason: `o procedimento "${proc.name}" ainda nao esta vinculado a um procedimento do Clinica Experts` };
    }
  }
  if (!professionalId) return { ok: false, reason: "nenhum profissional definido para este horario (o Clinica Experts exige um profissional)" };
  const pro = await prisma.professional.findFirst({ where: { id: professionalId, clinicId }, select: { name: true, ceUuid: true } });
  if (!pro?.ceUuid) return { ok: false, reason: `o profissional ${pro?.name ?? ""} ainda nao esta vinculado ao Clinica Experts`.replace("  ", " ") };
  return { ok: true };
}
