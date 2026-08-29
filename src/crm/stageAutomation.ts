import { prisma } from "../db/client.js";
import { getFunnelStages, type FunnelStageKind } from "./stages.js";
import { logActivity } from "./activity.js";

// Ordem de fallback quando a clinica nao tem uma etapa exatamente do "kind"
// pedido (ex: removeu a coluna "Pos-procedimento" -> cai em "Ganho").
const KIND_FALLBACK: Record<string, FunnelStageKind[]> = {
  avaliacao_agendada: ["avaliacao_agendada"],
  ganho: ["ganho"],
  pos_procedimento: ["pos_procedimento", "ganho"],
  perdido: ["perdido"],
};

interface MoveOpts {
  actorName?: string | null; // null/ausente = acao automatica
  note?: string; // motivo, aparece no historico
  allowFromTerminal?: boolean; // deixa mover mesmo saindo de ganho/perdido
}

async function applyMove(
  clinicId: string,
  patientId: string,
  targetStageId: string,
  targetLabel: string,
  fromLabel: string | undefined,
  opts: MoveOpts,
): Promise<void> {
  await prisma.patient.update({ where: { id: patientId }, data: { funnelStage: targetStageId } });
  await logActivity({
    clinicId,
    type: "stage_changed",
    area: "crm",
    title: "Paciente movido no funil",
    description: `${fromLabel ?? "—"} → ${targetLabel}${opts.note ? ` · ${opts.note}` : ""}`,
    actorName: opts.actorName ?? null,
  });
}

// Move o paciente para a etapa cujo "kind" foi pedido (ou o fallback). Nao
// pisa por cima de "ganho"/"perdido" definidos a mao, a menos que allowFromTerminal.
// Nunca lanca - automacao de CRM nao pode derrubar o atendimento.
export async function movePatientToKind(
  clinicId: string,
  patientId: string,
  kind: keyof typeof KIND_FALLBACK,
  opts: MoveOpts = {},
): Promise<void> {
  try {
    const stages = await getFunnelStages(clinicId);
    const patient = await prisma.patient.findUnique({ where: { id: patientId } });
    if (!patient) return;

    const current = stages.find((s) => s.stageId === patient.funnelStage);
    const currentKind = current?.kind;

    if (
      !opts.allowFromTerminal &&
      (currentKind === "ganho" || currentKind === "perdido") &&
      currentKind !== kind
    ) {
      // Reagendar tira o paciente de "perdido"; fora isso, respeita o terminal.
      const reopening = kind === "avaliacao_agendada" && currentKind === "perdido";
      if (!reopening) return;
    }

    let target;
    for (const k of KIND_FALLBACK[kind]) {
      target = stages.find((s) => s.kind === k);
      if (target) break;
    }
    if (!target || target.stageId === patient.funnelStage) return;

    await applyMove(clinicId, patientId, target.stageId, target.label, current?.label, opts);
  } catch (err) {
    console.error("Falha ao mover paciente de etapa (kind):", err);
  }
}

// Quando um agendamento e cancelado e o paciente nao tem outro horario futuro,
// joga ele pra etapa "recuperacao" (slug padrao) ou, na falta dela, a primeira
// etapa aberta - nunca pra "perdido" automaticamente (cancelou nao e perdeu).
export async function movePatientToRecovery(
  clinicId: string,
  patientId: string,
  opts: MoveOpts = {},
): Promise<void> {
  try {
    const stages = await getFunnelStages(clinicId);
    const patient = await prisma.patient.findUnique({ where: { id: patientId } });
    if (!patient) return;

    const current = stages.find((s) => s.stageId === patient.funnelStage);
    if (current?.kind === "ganho" || current?.kind === "perdido") return;

    const target =
      stages.find((s) => s.stageId === "recuperacao") ??
      stages.find((s) => s.kind === "aberta");
    if (!target || target.stageId === patient.funnelStage) return;

    await applyMove(clinicId, patientId, target.stageId, target.label, current?.label, opts);
  } catch (err) {
    console.error("Falha ao mover paciente para recuperacao:", err);
  }
}

export interface StageMoveResult {
  ok: boolean;
  error?: string;
  label?: string;
  changed?: boolean;
}

// Move para uma etapa especifica pelo stageId. Usado pelo PATCH manual do
// painel e pela ferramenta da Alice. `restrictToKinds` limita quais etapas o
// chamador pode escolher (a Alice so mexe nas etapas "abertas").
export async function movePatientToStage(
  clinicId: string,
  patientId: string,
  stageId: string,
  opts: MoveOpts & { restrictToKinds?: FunnelStageKind[] } = {},
): Promise<StageMoveResult> {
  const stages = await getFunnelStages(clinicId);
  const target = stages.find((s) => s.stageId === stageId);
  if (!target) {
    return { ok: false, error: `etapa "${stageId}" nao existe` };
  }
  if (opts.restrictToKinds && !opts.restrictToKinds.includes(target.kind as FunnelStageKind)) {
    return { ok: false, error: `essa etapa nao pode ser definida aqui` };
  }

  const patient = await prisma.patient.findUnique({ where: { id: patientId } });
  if (!patient) return { ok: false, error: "paciente nao encontrado" };

  if (patient.funnelStage === stageId) return { ok: true, label: target.label, changed: false };

  const current = stages.find((s) => s.stageId === patient.funnelStage);
  await applyMove(clinicId, patientId, target.stageId, target.label, current?.label, opts);
  return { ok: true, label: target.label, changed: true };
}
