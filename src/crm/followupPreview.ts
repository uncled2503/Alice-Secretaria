import { prisma } from "../db/client.js";
import { decideTiming, describeRule, MIN_GAP_BETWEEN_AUTOMATED_MS, MAX_OVERDUE_MS, validRecoveryHours, type RecoveryPolicy } from "./followupSchedule.js";
import { competingContact } from "./followupLedger.js";
import { isClosingMessage } from "./followupGuards.js";
import { isNonCommercialHandoff } from "./nonCommercial.js";
import { getFunnelStages } from "./stages.js";
import { loadCandidates, recheckBeforeSend } from "./followup.js";

// ---------------------------------------------------------------------------
// PREVIA DA PRIMEIRA RODADA DE RECONTATO (so leitura). "Se o servidor subisse agora, quem seria selecionado?" Mostra, por pessoa, a regra, o vencimento, quando a janela abre,
// o prazo e o motivo da decisao. NAO envia, NAO reserva, NAO grava registro de controle, NAO move o ponteiro da cascata e NAO consulta o juiz de IA (ele decide so na hora do
// envio: "enviaria" = passa em todas as regras de elegibilidade, ainda sujeita ao juiz e a revisao de envio). Dados pessoais minimos: id interno e "Primeiro S.".
// Espelha a ordem de decisao de followup.ts (processConversation/attemptSend); o teste de equivalencia compara os dois.
// ---------------------------------------------------------------------------

export interface PreviewRow {
  ref: string;
  nome: string;
  regra: { ordem: number; nome: string; quando: string };
  ultimaMensagemDaPessoa: string;
  vence: string;
  abreEm: string | null;
  prazo: string | null;
  decisao: "enviaria" | "aguardando" | "expira" | "excluida";
  motivo: string;
  controleExistente: string | null;
}

export interface FollowUpPreview {
  geradoEm: string;
  clinica: string;
  politicaDeRecuperacao: { valor: number | null; descricao: string; origem: string; decididaPelaClinica: boolean };
  conversasAvaliadas: number;
  resumo: { enviaria: number; aguardando: number; expira: number; excluidas: number };
  motivosDeExclusao: Record<string, number>;
  pessoas: PreviewRow[];
  aviso: string;
}

const maskName = (n: string | null) => {
  const parts = (n ?? "").trim().split(/\s+/).filter(Boolean);
  return parts.length === 0 ? "(sem nome)" : parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0]}.`;
};
const HUMAN_RECENT_MS = 2 * 3_600_000;
const CONSUMED = ["sent", "unconfirmed", "blocked", "duplicate", "failed_permanent", "expired", "skipped"];
const MAX_ROWS = 200;

export function describePolicy(hours: number | null): { descricao: string; origem: string; decididaPelaClinica: boolean } {
  if (hours == null) {
    return {
      descricao: `Padrão antigo do sistema: um recontato vencido ainda pode sair até ${MAX_OVERDUE_MS / 86_400_000} dias depois do vencimento, desde que a janela de envio esteja aberta. É a única trava, vale para todas as clínicas e NÃO é uma autorização comercial.`,
      origem: "código (trava contra disparo em massa, 07/10/2026) - a clínica ainda não decidiu",
      decididaPelaClinica: false,
    };
  }
  return {
    descricao: hours === 0 ? "Sem recuperação: o recontato só sai na rodada em que a janela abre (tolerância técnica de uma rodada); depois disso a etapa expira." : `Recupera até ${hours} hora(s) depois que a janela de envio abriu; depois disso a etapa expira.`,
    origem: "definido pela clínica (Clinic.followupRecoveryHours)",
    decididaPelaClinica: true,
  };
}

export async function previewFollowUpRound(clinicId: string, now = new Date()): Promise<FollowUpPreview> {
  const clinic = await prisma.clinic.findUniqueOrThrow({
    where: { id: clinicId },
    select: { name: true, timezone: true, workDays: true, workStartHour: true, workEndHour: true, hoursByDay: true, closedOnHolidays: true, holidayOpen: true, followupRecoveryHours: true, importStatus: true },
  });
  const policy: RecoveryPolicy = { recoveryHours: validRecoveryHours(clinic.followupRecoveryHours) ? clinic.followupRecoveryHours : null };
  const cal = { ...clinic, timezone: clinic.timezone || "America/Sao_Paulo" };
  const rules = await prisma.followUpRule.findMany({ where: { clinicId, active: true }, orderBy: { order: "asc" } });
  const stages = await getFunnelStages(clinicId);
  const recoveryEligible = new Set(stages.filter((s) => s.kind === "aberta").map((s) => s.stageId));
  const conversations = await loadCandidates(now, clinicId);

  const reasons: Record<string, number> = {};
  const skip = (code: string) => { reasons[code] = (reasons[code] ?? 0) + 1; };
  const rows: PreviewRow[] = [];

  for (const conv of conversations) {
    const last = conv.messages[0];
    if (!last) { skip("sem_mensagem_da_pessoa"); continue; }
    if (clinic.importStatus === "running") { skip("importando_historico"); continue; }
    if (isNonCommercialHandoff(conv.handoffReason)) { skip("contato_nao_comercial"); continue; }
    if (conv.patient.funnelStage !== "novo_lead" && !recoveryEligible.has(conv.patient.funnelStage)) { skip("etapa_do_funil_fora_do_recontato"); continue; }
    if (rules.length === 0) { skip("sem_regras_ativas"); continue; }
    const pending = rules.filter((x) => x.order > conv.lastFollowUpOrder);
    if (pending.length === 0) { skip("cascata_esgotada"); continue; }
    const active = await prisma.appointment.findFirst({
      where: { patientId: conv.patientId, OR: [{ status: "confirmed", scheduledAt: { gte: new Date(now.getTime() - 24 * 3_600_000) } }, { status: "completed", scheduledAt: { gte: new Date(now.getTime() - 7 * 24 * 3_600_000) } }] },
      select: { id: true },
    });
    if (active) { skip("ja_tem_horario"); continue; }
    if (isClosingMessage(last.content)) { skip("encerrou_o_assunto"); continue; }

    for (const rule of pending) {
      if (rule.repeatMode === "once" && (await prisma.followUpSent.findUnique({ where: { conversationId_ruleId: { conversationId: conv.id, ruleId: rule.id } } }))) continue;
      const timing = decideTiming(rule, last.createdAt, now, cal, policy);
      const base = { ref: conv.patientId, nome: maskName(conv.patient.name), regra: { ordem: rule.order, nome: rule.name, quando: describeRule(rule) }, ultimaMensagemDaPessoa: last.createdAt.toISOString(), vence: timing.dueAt.toISOString() };
      const ledger = await prisma.followUpDispatch.findUnique({ where: { patientId_flow_step_cycleKey: { patientId: conv.patientId, flow: "recontato", step: rule.order, cycleKey: String(last.createdAt.getTime()) } }, select: { state: true } });
      const controleExistente = ledger?.state ?? null;
      if (timing.action === "wait") {
        rows.push({ ...base, abreEm: timing.opensAt?.toISOString() ?? null, prazo: null, decisao: "aguardando", motivo: timing.code, controleExistente });
        break;
      }
      if (timing.action === "expire") {
        // expirou: a cascata segue para a proxima etapa (mesma ordem de decisao da rodada real)
        rows.push({ ...base, abreEm: null, prazo: timing.deadline?.toISOString() ?? null, decisao: "expira", motivo: timing.code, controleExistente });
        continue;
      }
      // venceu e pode sair: as mesmas conferencias de envio da rodada real, sem escrever nada
      const row = (decisao: PreviewRow["decisao"], motivo: string): PreviewRow => ({ ...base, abreEm: timing.openedAt.toISOString(), prazo: null, decisao, motivo, controleExistente });
      const lastAny = await prisma.message.findFirst({ where: { conversationId: conv.id, role: { in: ["user", "assistant", "human"] } }, orderBy: { createdAt: "desc" }, select: { role: true } });
      if (lastAny?.role === "user") { rows.push(row("excluida", "pessoa_falou_por_ultimo")); break; }
      const humanRecently = await prisma.message.findFirst({ where: { conversationId: conv.id, role: "human", createdAt: { gte: new Date(now.getTime() - HUMAN_RECENT_MS), lte: now } }, select: { id: true } });
      if (humanRecently || (conv.staffTouchedAt && now.getTime() - conv.staffTouchedAt.getTime() < HUMAN_RECENT_MS && conv.staffTouchedAt.getTime() <= now.getTime())) { rows.push(row("excluida", "equipe_atendendo_recentemente")); break; }
      const interest = conv.patient.interestNote?.split(",")[0]?.trim() || null;
      if (!interest && /[{\[]procedimento[}\]]/i.test(rule.message)) { rows.push(row("excluida", "texto_usa_procedimento_e_interesse_desconhecido")); break; }
      const compete = await competingContact({ patientId: conv.patientId, flow: "recontato", now, minGapMs: MIN_GAP_BETWEEN_AUTOMATED_MS });
      if (compete) { rows.push(row("excluida", `concorrencia:${compete.code}`)); break; }
      const recheck = await recheckBeforeSend(conv.id, conv.patientId, last.createdAt, now);
      if (recheck) { rows.push(row("excluida", `revalidacao:${recheck.code}`)); break; }
      if (controleExistente && CONSUMED.includes(controleExistente)) { rows.push(row("excluida", `ja_tratada:${controleExistente}`)); break; }
      rows.push(row("enviaria", "passa_nas_regras_de_elegibilidade (ainda sujeita ao juiz de IA e a revisao de envio)"));
      break;
    }
  }

  const count = (d: PreviewRow["decisao"]) => rows.filter((r) => r.decisao === d).length;
  const order = { enviaria: 0, aguardando: 1, expira: 2, excluida: 3 } as const;
  return {
    geradoEm: now.toISOString(),
    clinica: clinic.name,
    politicaDeRecuperacao: { valor: policy.recoveryHours, ...describePolicy(policy.recoveryHours) },
    conversasAvaliadas: conversations.length,
    resumo: { enviaria: count("enviaria"), aguardando: count("aguardando"), expira: count("expira"), excluidas: count("excluida") },
    motivosDeExclusao: reasons,
    pessoas: rows.sort((a, b) => order[a.decisao] - order[b.decisao]).slice(0, MAX_ROWS),
    aviso: "Prévia: nada foi enviado, nenhuma etapa foi reservada, nenhum registro de controle foi gravado, o ponteiro da cascata não foi movido e o juiz de IA não foi consultado.",
  };
}
