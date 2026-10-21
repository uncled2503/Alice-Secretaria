import { prisma } from "../db/client.js";
import { logActivity } from "../crm/activity.js";
import { wallClockInZone } from "../scheduling/time.js";
import { postDueAt, validLateUntilHour, POST_DEFAULT_LAST_HOUR, POST_FIRST_HOUR } from "../reminders/postProcedure.js";
import { reservationEndMs } from "../scheduling/reservation.js";

// ---------------------------------------------------------------------------
// POS-PROCEDIMENTO DO LAVIEEN DEPOIS DO FECHAMENTO (Lisboa, 21/10/2026): "quem fez Lavieen depois das 19h30 recebeu o pos so na manha seguinte; queremos que saia mesmo depois do fechamento".
//
// DIAGNOSTICO (somente leitura): para cada atendimento recente do procedimento, a linha do tempo REAL - inicio, fim, vencimento do pos, quando o atendimento foi dado como CONCLUIDO
// aqui (Appointment.completedAt, gravado a partir de 24/10) e quando o pos foi aceito pelo provedor - e a causa que esses tempos COMPROVAM (ou "nao comprovada").
// CONFIGURACAO: liga PostProcedureRule.lateSendUntilHour SO nas regras que acompanham o Lavieen (nunca na regra que vale para todos os procedimentos sem escolha explicita). Nao muda
// texto (o pos usa so o texto aprovado e cadastrado), nao toca recontatos/campanhas/lembretes/pesquisa/aniversario e nao reabre nem reenvia nada antigo.
// ---------------------------------------------------------------------------

export const LATE_UNTIL_DEFAULT = 23;

export interface LinhaPos {
  agendamento: string;
  inicio: string; // dd/mm hh:mm (fuso da clinica)
  fim: string;
  venceEm: string;
  status: string;
  concluidoEm: string | null;
  posEstado: string | null;
  posAceitoEm: string | null;
  causa: { texto: string; comprovada: boolean };
}
export interface DiagnosticoPos {
  clinicaId: string;
  fuso: string;
  regras: { id: string; nome: string; intervalo: string; somenteConcluidos: boolean; procedimentos: string; ativa: boolean; depoisDoFechamentoAte: number | null; temTexto: boolean }[];
  linhas: LinhaPos[];
  resumo: Record<string, number>;
  oQueIniciaOPrazo: string;
  limites: string[];
}

const stamp = (d: Date, tz: string) => { const w = wallClockInZone(d, tz); return `${String(w.day).padStart(2, "0")}/${String(w.month).padStart(2, "0")} ${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`; };

async function lavieenProcedures(clinicId: string, pattern: RegExp) {
  const procs = await prisma.procedure.findMany({ where: { clinicId }, select: { id: true, name: true } });
  return procs.filter((p) => pattern.test(p.name));
}

export async function diagnosticarPosFluxo(clinicId: string, opts: { agora?: Date; dias?: number; padrao?: RegExp } = {}): Promise<DiagnosticoPos> {
  const agora = opts.agora ?? new Date();
  const pattern = opts.padrao ?? /lavieen/i;
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { timezone: true } });
  const tz = clinic.timezone || "America/Sao_Paulo";
  const procs = await lavieenProcedures(clinicId, pattern);
  const ids = new Set(procs.map((p) => p.id));
  const rules = await prisma.postProcedureRule.findMany({ where: { clinicId }, orderBy: { createdAt: "asc" } });
  const relevant = rules.filter((r) => { const f = r.procedureIds.split(",").filter(Boolean); return f.length === 0 || f.some((x) => ids.has(x)); });
  const from = new Date(agora.getTime() - (opts.dias ?? 7) * 86_400_000);
  const appts = ids.size
    ? await prisma.appointment.findMany({
        where: { clinicId, procedureId: { in: [...ids] }, scheduledAt: { gte: from, lte: agora }, status: { notIn: ["cancelled"] } },
        include: { procedure: { select: { durationMin: true } }, postProcedureSent: true },
        orderBy: { scheduledAt: "asc" },
        take: 300,
      })
    : [];
  const resumo: Record<string, number> = {};
  const linhas: LinhaPos[] = [];
  for (const a of appts) {
    const rule = relevant.find((r) => { const f = r.procedureIds.split(",").filter(Boolean); return f.length === 0 || f.includes(a.procedureId); });
    if (!rule) { resumo["sem_regra_de_pos"] = (resumo["sem_regra_de_pos"] ?? 0) + 1; continue; }
    const due = postDueAt(rule, a);
    const sent = a.postProcedureSent.find((s) => s.ruleId === rule.id);
    const sentAt = sent?.state === "sent" ? sent.finalAt : null;
    const dueHour = wallClockInZone(due, tz).hour;
    let causa: LinhaPos["causa"] = { texto: "sem causa comprovada pelos tempos registrados", comprovada: false };
    if (sent && sent.state !== "sent") causa = { texto: `etapa do pos em estado "${sent.state}"${sent.note ? ` (${sent.note})` : ""}`, comprovada: true };
    else if (!sent && rule.onlyIfCompleted && a.status !== "completed") causa = { texto: `o atendimento NÃO consta como concluído aqui (status ${a.status}): a regra só vale depois de concluído; enquanto ninguém marcar/sincronizar como concluído o pos não é selecionado`, comprovada: true };
    else if (sentAt) {
      const sentHour = wallClockInZone(sentAt, tz).hour;
      const dueOutside = dueHour >= POST_DEFAULT_LAST_HOUR || dueHour < POST_FIRST_HOUR;
      if (dueOutside && sentAt.getTime() - due.getTime() > 3 * 3_600_000 && sentHour >= POST_FIRST_HOUR) causa = { texto: `venceu às ${stamp(due, tz).slice(6)} (fora de 07h–21h) e saiu às ${stamp(sentAt, tz).slice(6)}: o portão de horário do fluxo adiou o envio até a manhã`, comprovada: true };
      else if (a.completedAt && a.completedAt.getTime() > due.getTime() + 15 * 60_000) causa = { texto: `a conclusão foi registrada aqui às ${stamp(a.completedAt, tz)}, depois do vencimento (${stamp(due, tz)}): o pos espera o registro de conclusão`, comprovada: true };
      else causa = { texto: "saiu dentro de poucas horas do vencimento", comprovada: true };
    } else if (!sent && due.getTime() > agora.getTime()) causa = { texto: "ainda não venceu", comprovada: true };
    else if (!sent && a.status === "completed") causa = { texto: dueHour >= POST_DEFAULT_LAST_HOUR || dueHour < POST_FIRST_HOUR ? "venceu fora do horário de envio (07h–21h) e aguarda a manhã" : "concluído e vencido, sem registro do pos: o job não selecionou (conferir as rodadas do pos)", comprovada: dueHour >= POST_DEFAULT_LAST_HOUR || dueHour < POST_FIRST_HOUR };
    resumo[causa.texto.split(":")[0].slice(0, 70)] = (resumo[causa.texto.split(":")[0].slice(0, 70)] ?? 0) + 1;
    linhas.push({
      agendamento: a.id, inicio: stamp(a.scheduledAt, tz), fim: stamp(new Date(reservationEndMs(a)), tz), venceEm: stamp(due, tz), status: a.status,
      concluidoEm: a.completedAt ? stamp(a.completedAt, tz) : null, posEstado: sent?.state ?? null, posAceitoEm: sentAt ? stamp(sentAt, tz) : null, causa,
    });
  }
  return {
    clinicaId: clinicId, fuso: tz,
    regras: relevant.map((r) => ({
      id: r.id, nome: r.name, intervalo: `${r.intervalValue} ${r.intervalUnit === "hours" ? "hora(s) depois do FIM do atendimento" : "dia(s) depois do INÍCIO do atendimento"}`, somenteConcluidos: r.onlyIfCompleted,
      procedimentos: r.procedureIds ? `${r.procedureIds.split(",").filter(Boolean).length} procedimento(s) escolhido(s)` : "TODOS os procedimentos", ativa: r.active, depoisDoFechamentoAte: r.lateSendUntilHour, temTexto: r.message.trim().length > 0,
    })),
    linhas, resumo,
    oQueIniciaOPrazo: "Regra em HORAS: o prazo conta do FIM da reserva (ends_at do Clínica Experts; sem ele, início + soma dos procedimentos). Regra em DIAS: do INÍCIO. Nos dois casos o pos só é selecionado depois que o atendimento consta como CONCLUÍDO aqui (status vindo do Clínica Experts ou marcado pela equipe) — o horário ter passado NÃO prova que o procedimento foi feito.",
    limites: [
      "O horário em que o atendimento foi dado como concluído só é gravado a partir desta versão (Appointment.completedAt); antes disso 'concluído em' aparece vazio e a causa 'conclusão registrada depois do vencimento' não pode ser provada.",
      "Produzido contra o banco ao qual este comando está conectado: só descreve a Lisboa de produção se rodar contra o banco de produção. Sem os registros reais, a causa em produção continua NÃO comprovada; a única barreira de horário no código é o portão 21h–7h do fluxo (comprovada pela leitura do código).",
    ],
  };
}

export interface ConfigurarPosOpts {
  dryRun?: boolean;
  aprovadoPor?: string;
  ateHora?: number; // 21..24 (padrao 23)
  regraIds?: string[]; // obrigatorio quando a regra vale para TODOS os procedimentos (a menos que todosProcedimentos)
  todosProcedimentos?: boolean; // decisao da clinica: o envio depois do fechamento vale para o pos de TODOS os atendimentos (todas as regras ativas de pos)
  padrao?: RegExp;
  actorName?: string | null;
}
export interface PlanoPos { somentePrevia: boolean; aplicado: boolean; ateHora: number; regras: { id: string; nome: string; acao: "ligar" | "manter" | "pendencia"; motivo: string }[]; decisoesPendentes: string[] }

export async function configurarPosDepoisDoFechamento(clinicId: string, opts: ConfigurarPosOpts = {}): Promise<PlanoPos> {
  const dryRun = opts.dryRun !== false;
  const ateHora = opts.ateHora ?? LATE_UNTIL_DEFAULT;
  if (!validLateUntilHour(ateHora)) throw new Error("ateHora deve ser um inteiro entre 21 e 24.");
  if (!dryRun && !(opts.aprovadoPor ?? "").trim()) throw new Error("Aplicar exige `aprovadoPor`.");
  const procs = await lavieenProcedures(clinicId, opts.padrao ?? /lavieen/i);
  const ids = new Set(procs.map((p) => p.id));
  const rules = await prisma.postProcedureRule.findMany({ where: { clinicId }, orderBy: { createdAt: "asc" } });
  const out: PlanoPos = { somentePrevia: dryRun, aplicado: false, ateHora, regras: [], decisoesPendentes: [] };
  if (ids.size === 0) out.decisoesPendentes.push("Nenhum procedimento com 'Lavieen' no nome foi encontrado nesta clínica.");
  const toApply: string[] = [];
  for (const r of rules) {
    const f = r.procedureIds.split(",").filter(Boolean);
    const onlyLavieen = f.length > 0 && f.every((x) => ids.has(x));
    const mixed = f.length > 0 && !onlyLavieen && f.some((x) => ids.has(x));
    const all = f.length === 0;
    if (!all && !onlyLavieen && !mixed && !opts.todosProcedimentos) continue; // regra de outros procedimentos: nao e deste pedido
    if (!r.active) { out.regras.push({ id: r.id, nome: r.name, acao: "pendencia", motivo: "regra desligada: nada a fazer" }); continue; }
    if (!r.message.trim()) { out.regras.push({ id: r.id, nome: r.name, acao: "pendencia", motivo: "a regra não tem texto aprovado cadastrado: não há o que enviar" }); continue; }
    if ((all || mixed) && !opts.todosProcedimentos && !(opts.regraIds ?? []).includes(r.id)) {
      out.regras.push({ id: r.id, nome: r.name, acao: "pendencia", motivo: all ? "vale para TODOS os procedimentos: ligar o envio depois do fechamento aqui valeria para todos. Informe a regra em regraIds se for isso mesmo; senão crie uma regra só do Lavieen com o texto aprovado." : "vale para o Lavieen e para outros procedimentos: informe a regra em regraIds se a clínica quer o envio depois do fechamento para todos eles." });
      out.decisoesPendentes.push(`Regra "${r.name}" (${r.id}): ${all ? "vale para todos os procedimentos" : "mistura o Lavieen com outros procedimentos"}. O envio depois do fechamento deve valer para todos eles?`);
      continue;
    }
    if (r.lateSendUntilHour === ateHora) out.regras.push({ id: r.id, nome: r.name, acao: "manter", motivo: `já autoriza o envio depois do fechamento até ${ateHora}h` });
    else { out.regras.push({ id: r.id, nome: r.name, acao: "ligar", motivo: `autoriza o envio depois do fechamento até ${ateHora}h (nunca antes das 7h; só quem venceu há até 6 h)` }); toApply.push(r.id); }
  }
  if (rules.filter((r) => r.active).length === 0) out.decisoesPendentes.push("A clínica não tem nenhuma regra de pós-procedimento ativa.");
  out.decisoesPendentes.push(`Até que horas o pos do Lavieen pode sair? Proposta: ${LATE_UNTIL_DEFAULT}h (nada de madrugada).`);
  if (!dryRun && toApply.length) {
    await prisma.postProcedureRule.updateMany({ where: { id: { in: toApply }, clinicId }, data: { lateSendUntilHour: ateHora } });
    out.aplicado = true;
    await logActivity({ clinicId, type: "automation_updated", area: "automacoes", title: "Pós-procedimento do Lavieen pode sair depois do fechamento", description: `Aprovado por ${opts.aprovadoPor}. Até ${ateHora}h, só para quem venceu há pouco; texto e intervalo inalterados.`, actorName: opts.actorName ?? null }).catch(() => undefined);
  }
  return out;
}
