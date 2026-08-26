import { prisma } from "../db/client";

export type FunnelStageKind = "aberta" | "avaliacao_agendada" | "ganho" | "pos_procedimento" | "perdido";

export interface FunnelStageDef {
  id: string;
  label: string;
  color: string;
  kind: FunnelStageKind;
}

// Template usado so pra popular uma clinica nova na primeira vez - depois
// disso, cada clinica tem suas proprias linhas na tabela FunnelStage e pode
// editar/adicionar/remover etapas livremente pelo painel.
export const DEFAULT_FUNNEL_STAGES: FunnelStageDef[] = [
  { id: "novo_lead", label: "Novo lead", color: "#0ea5e9", kind: "aberta" },
  { id: "qualificando", label: "Qualificando", color: "#6366f1", kind: "aberta" },
  { id: "interesse_confirmado", label: "Interesse confirmado", color: "#8b5cf6", kind: "aberta" },
  { id: "avaliacao_agendada", label: "Avaliação agendada", color: "#f59e0b", kind: "avaliacao_agendada" },
  { id: "compareceu", label: "Compareceu", color: "#06b6d4", kind: "aberta" },
  { id: "proposta_enviada", label: "Proposta enviada", color: "#f97316", kind: "aberta" },
  { id: "fechou_procedimento", label: "Fechou procedimento", color: "#10b981", kind: "ganho" },
  { id: "pos_procedimento", label: "Pós-procedimento", color: "#14b8a6", kind: "pos_procedimento" },
  { id: "recuperacao", label: "Recuperação", color: "#f43f5e", kind: "aberta" },
  { id: "perdido", label: "Perdido", color: "#64748b", kind: "perdido" },
];

// Busca as etapas de uma clinica; se ainda nao tiver nenhuma (clinica nova),
// cria as 10 padrao automaticamente. Idempotente.
export async function getFunnelStages(clinicId: string) {
  let stages = await prisma.funnelStage.findMany({ where: { clinicId }, orderBy: { order: "asc" } });

  if (stages.length === 0) {
    await prisma.funnelStage.createMany({
      data: DEFAULT_FUNNEL_STAGES.map((s, i) => ({
        clinicId,
        stageId: s.id,
        label: s.label,
        color: s.color,
        kind: s.kind,
        order: i,
      })),
    });
    stages = await prisma.funnelStage.findMany({ where: { clinicId }, orderBy: { order: "asc" } });
  }

  return stages;
}

function slugify(label: string): string {
  return label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // remove acentos (diacriticos combinantes pos-normalizacao)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "etapa";
}

// Gera um stageId unico pra clinica a partir do label (usado ao criar etapa nova).
export async function generateStageId(clinicId: string, label: string): Promise<string> {
  const base = slugify(label);
  let candidate = base;
  let suffix = 1;
  while (await prisma.funnelStage.findUnique({ where: { clinicId_stageId: { clinicId, stageId: candidate } } })) {
    suffix += 1;
    candidate = `${base}_${suffix}`;
  }
  return candidate;
}
