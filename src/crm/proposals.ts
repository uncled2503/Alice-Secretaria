import { prisma } from "../db/client.js";
import { logActivity } from "./activity.js";
import { validLossReason } from "./lossReasons.js";

// ---------------------------------------------------------------------------
// PROPOSTA ABERTA (checklist mestre, Fase 3): o que foi apresentado a UMA pessoa (itens, valor, validade, estado). Alimenta "propostas abertas / dinheiro parado" e o recontato de avaliacao que cita a
// proposta REAL. Regras: valor so quando informado (null = nao informado, nunca estimado); validade so quando informada (sem validade = sem urgencia: nada de "ultimos dias"); vencida vira
// "expirada" e sai do dinheiro parado; ha no maximo UMA proposta aberta com o mesmo titulo por pessoa.
// ---------------------------------------------------------------------------
export interface ProposalItem { name: string; procedureId?: string | null; qty: number; unitValue: number | null }
export const PROPOSAL_STATUS = ["aberta", "aceita", "recusada", "expirada", "cancelada"] as const;

function parseItems(raw: unknown): ProposalItem[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ProposalItem[] = [];
  for (const it of raw) {
    const o = it as Record<string, unknown>;
    const name = typeof o?.name === "string" ? o.name.trim() : "";
    const qty = Number(o?.qty ?? 1);
    const uv = o?.unitValue == null || o.unitValue === "" ? null : Number(o.unitValue);
    if (!name || !Number.isFinite(qty) || qty <= 0 || (uv !== null && (!Number.isFinite(uv) || uv < 0))) return null;
    out.push({ name: name.slice(0, 120), procedureId: typeof o.procedureId === "string" ? o.procedureId : null, qty: Math.round(qty), unitValue: uv });
  }
  return out;
}

// PURO: total SOMENTE se todos os itens tem valor; senao null (valor nao informado, nunca estimado).
export function totalOf(items: ProposalItem[]): number | null {
  if (!items.length || items.some((i) => i.unitValue === null)) return null;
  return Math.round(items.reduce((s, i) => s + i.qty * (i.unitValue as number), 0) * 100) / 100;
}

export async function createProposal(clinicId: string, input: { patientId: string; title: string; items: unknown; validUntil?: string | null; objectionCode?: string | null; note?: string | null }, actorName: string | null): Promise<{ ok: boolean; message: string; id?: string }> {
  const title = (input.title ?? "").trim().slice(0, 120);
  if (!title) return { ok: false, message: "Informe o título da proposta." };
  const items = parseItems(input.items);
  if (!items || !items.length) return { ok: false, message: "Informe os itens (nome, quantidade e, se houver, valor unitário)." };
  const patient = await prisma.patient.findFirst({ where: { id: input.patientId, clinicId }, select: { id: true } });
  if (!patient) return { ok: false, message: "Contato não encontrado nesta clínica." };
  let validUntil: Date | null = null;
  if (input.validUntil) { validUntil = new Date(input.validUntil); if (Number.isNaN(validUntil.getTime())) return { ok: false, message: "Validade inválida (use data ISO)." }; }
  if (input.objectionCode && !validLossReason(input.objectionCode)) return { ok: false, message: "Motivo/objeção inválido." };
  const dup = await prisma.proposal.findFirst({ where: { clinicId, patientId: patient.id, title, status: "aberta" }, select: { id: true } });
  if (dup) return { ok: false, message: "Já existe uma proposta ABERTA com este título para esta pessoa.", id: dup.id };
  const row = await prisma.proposal.create({ data: { clinicId, patientId: patient.id, title, itemsJson: JSON.stringify(items), totalValue: totalOf(items), validUntil, objectionCode: input.objectionCode ?? null, note: input.note?.slice(0, 300) ?? null, createdBy: actorName } });
  await logActivity({ clinicId, patientId: patient.id, type: "proposal", area: "atendimento", title: `Proposta aberta: ${title}`, description: row.totalValue != null ? `Valor R$ ${row.totalValue.toFixed(2)}` : "Valor não informado", actorName });
  return { ok: true, message: "Proposta registrada.", id: row.id };
}

// Transicao atomica: so uma proposta ABERTA muda; devolve a contagem real.
export async function closeProposal(clinicId: string, id: string, status: "aceita" | "recusada" | "cancelada", objectionCode: string | null, actorName: string | null): Promise<{ ok: boolean; message: string }> {
  if (objectionCode && !validLossReason(objectionCode)) return { ok: false, message: "Motivo inválido." };
  const r = await prisma.proposal.updateMany({ where: { id, clinicId, status: "aberta" }, data: { status, closedAt: new Date(), ...(objectionCode ? { objectionCode } : {}) } });
  if (r.count !== 1) return { ok: false, message: "A proposta não está mais aberta (ou não existe nesta clínica)." };
  const p = await prisma.proposal.findUnique({ where: { id }, select: { patientId: true, title: true } });
  await logActivity({ clinicId, patientId: p?.patientId ?? null, type: "proposal", area: "atendimento", title: `Proposta ${status}: ${p?.title ?? ""}`, actorName });
  return { ok: true, message: `Proposta ${status}.` };
}

// Vencidas viram "expirada" (o dia termina na validade informada, no fuso da clinica: a validade ja e um instante).
export async function expireProposals(clinicId: string, now = new Date()): Promise<number> {
  const r = await prisma.proposal.updateMany({ where: { clinicId, status: "aberta", validUntil: { lt: now } }, data: { status: "expirada", closedAt: now } });
  return r.count;
}

export interface OpenProposalsReport {
  abertasVigentes: number; semValidade: number; vencendoEm7Dias: number; expiradasNoPeriodo: number;
  valorEmAberto: number; propostasSemValor: number; // soma SO das que tem valor informado; as demais ficam contadas a parte (nunca estimadas)
  maisAntigas: { id: string; patientId: string; title: string; valor: number | null; diasAbertas: number }[];
}
export async function openProposalsReport(clinicId: string, now = new Date()): Promise<OpenProposalsReport> {
  await expireProposals(clinicId, now);
  const open = await prisma.proposal.findMany({ where: { clinicId, status: "aberta" }, orderBy: { openedAt: "asc" } });
  const in7 = new Date(now.getTime() + 7 * 86_400_000);
  const expired = await prisma.proposal.count({ where: { clinicId, status: "expirada", closedAt: { gte: new Date(now.getTime() - 30 * 86_400_000) } } });
  return {
    abertasVigentes: open.length,
    semValidade: open.filter((p) => !p.validUntil).length,
    vencendoEm7Dias: open.filter((p) => p.validUntil && p.validUntil <= in7).length,
    expiradasNoPeriodo: expired,
    valorEmAberto: Math.round(open.reduce((s, p) => s + (p.totalValue ?? 0), 0) * 100) / 100,
    propostasSemValor: open.filter((p) => p.totalValue == null).length,
    maisAntigas: open.slice(0, 10).map((p) => ({ id: p.id, patientId: p.patientId, title: p.title, valor: p.totalValue, diasAbertas: Math.floor((now.getTime() - p.openedAt.getTime()) / 86_400_000) })),
  };
}
