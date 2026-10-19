import { prisma } from "../db/client.js";
import { logActivity } from "../crm/activity.js";
import { describeRule, firstOpenAtOrAfter, ruleDueAt } from "../crm/followupSchedule.js";
import { DEFAULT_CANCELLED_TEXT, RESUME_CANCELLED, RESUME_NOCLOSE, DEFAULT_NOCLOSE_TEXT, previewResumeFlow, type ResumePreview } from "../crm/resumeFlows.js";
import { MAX_TEST_SENDS, readRestriction, resolveTestContacts, type GuardedFlow } from "../crm/resumeGuard.js";
import { describePolicy, previewFollowUpRound, type FollowUpPreview } from "../crm/followupPreview.js";
import { MAX_RECOVERY_HOURS, validRecoveryHours } from "../crm/followupSchedule.js";
import { wallClockInZone } from "../scheduling/time.js";

// ---------------------------------------------------------------------------
// RECONFERENCIA DOS RECONTATOS E PREPARO DAS RETOMADAS DA LISBOA (pedido de 17-18/10/2026). Mecanismo restrito a UMA clinica, com PREVIA (dryRun) e
// idempotente. Nao liga, nao desliga e nao reescreve nenhum recontato existente: so MOSTRA a matriz das regras (quando vencem, quando podem sair, o que
// uma conversa tipica faria), aponta conflitos e cria - desligada e sem texto aprovado - a configuracao das retomadas. Ligar uma retomada exige pedido
// explicito (`ativar`) com o nome de quem aprovou e o texto.
// ---------------------------------------------------------------------------

export interface RegraRecontato {
  ordem: number;
  nome: string;
  ativa: boolean;
  quando: string; // "dia seguinte às 8h, só entre 8h e 12h" / "4h de silêncio"
  origem: string; // de onde veio a regra (painel/seed/migracao): o banco nao guarda; deixa claro o que se sabe
  observacoes: string[];
}

export interface RecontatosResult {
  dryRun: boolean;
  clinicId: string;
  clinica: string;
  expediente: string;
  fusoHorario: string;
  regras: RegraRecontato[];
  exemploDeConversa: { fim: string; etapas: { ordem: number; vence: string; podeSairEm: string | null }[] }[];
  conflitos: string[];
  perguntasPendentes: string[];
  retomadas: { fluxo: string; existe: boolean; ligada: boolean; dia: number | null; janela: string; temTexto: boolean; modo: string; restricao: string | null }[];
  // PREVIA do que a primeira rodada selecionaria agora (so leitura; nada enviado, nenhuma tentativa consumida, nenhum registro de controle gravado)
  previa: ResumePreview[];
  // PREVIA da primeira rodada do recontato por silencio (so leitura) e a politica de recuperacao em vigor (decisao da clinica ainda pendente quando null)
  previaRecontato: FollowUpPreview;
  recuperacao: { valorAtual: number | null; pendente: boolean; descricao: string; origem: string; opcoes: string[] };
  // validacao controlada: o que o pedido de modo restrito resolveu (contatos sem telefone completo)
  modoRestrito: { fluxo: string; valido: boolean; problemas: string[]; contatos: { nome: string | null; final: string }[]; limite: number | null } | null;
  aplicado: { configuracoesCriadas: string[]; ligadas: string[]; restritas: string[]; voltaramAoNormal: string[]; recuperacaoDefinida: boolean };
}

export interface RecontatosOptions {
  dryRun: boolean;
  ativar?: { fluxo: typeof RESUME_CANCELLED | typeof RESUME_NOCLOSE; aprovadoPor: string; mensagem?: string; diaDaSemana?: number | null; horaInicio?: number | null; horaFim?: number | null };
  // VALIDACAO CONTROLADA: restringe o fluxo (retomadas ou convite de indicacao) a contatos de teste autorizados, com limite de envios. Aplicado ANTES de `ativar` na mesma chamada.
  modoRestrito?: { fluxo: GuardedFlow; aprovadoPor: string; telefones: string[]; limite: number };
  // volta ao publico normal: pedido explicito e separado (nunca acontece sozinho nem ao ligar/desligar)
  voltarAoNormal?: { fluxo: GuardedFlow; aprovadoPor: string };
  // POLITICA DE RECUPERACAO do recontato (decisao da clinica): 0 = nao recupera; 1-72 = ate N horas depois que a janela abriu; null = volta ao padrao antigo (3 dias). Nunca e aplicada sozinha.
  recuperacao?: { horas: number | null; aprovadoPor: string };
  actorName?: string | null;
}

const DIAS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

export async function conferirRecontatosLisboa(clinicId: string, opts: RecontatosOptions): Promise<RecontatosResult> {
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId } });
  const tz = clinic.timezone || "America/Sao_Paulo";
  const cal = { timezone: tz, workDays: clinic.workDays, workStartHour: clinic.workStartHour, workEndHour: clinic.workEndHour, hoursByDay: clinic.hoursByDay, closedOnHolidays: clinic.closedOnHolidays, holidayOpen: clinic.holidayOpen };
  const rules = await prisma.followUpRule.findMany({ where: { clinicId }, orderBy: { order: "asc" } });

  const conflitos: string[] = [];
  const perguntasPendentes: string[] = [];
  const regras: RegraRecontato[] = rules.map((r, i) => {
    const obs: string[] = [];
    const prevInactive = rules.slice(0, i).some((p) => !p.active);
    if (r.active && prevInactive) obs.push("há etapa ANTERIOR desligada: a cascata agora pula a etapa desligada (antes travava e dava a conversa como perdida)");
    if (r.nextDayHour != null && r.sendWindowStart != null && r.sendWindowEnd != null && (r.nextDayHour < r.sendWindowStart || r.nextDayHour >= r.sendWindowEnd)) obs.push(`o horário do dia seguinte (${r.nextDayHour}h) está fora da janela ${r.sendWindowStart}h-${r.sendWindowEnd}h: só sairá quando a janela abrir`);
    if (r.sendWindowStart != null && r.sendWindowEnd != null && r.sendWindowStart >= r.sendWindowEnd) obs.push("janela vira a meia-noite (permitido, confira se era a intenção)");
    if (r.active && !r.skipIfHumanTakeover) obs.push("(a Alice nunca recontata conversa em atendimento humano, independente desta opção)");
    return {
      ordem: r.order, nome: r.name, ativa: r.active, quando: describeRule(r),
      origem: r.nextDayHour != null ? "horário fixo do dia seguinte (definido por migração; o painel não edita este campo)" : "silêncio corrido (painel/seed)",
      observacoes: obs,
    };
  });

  const activeRules = rules.filter((r) => r.active);
  for (let i = 1; i < activeRules.length; i++) {
    const a = activeRules[i - 1];
    const b = activeRules[i];
    if (b.nextDayHour != null && a.nextDayHour == null && a.afterMinutes > 0 && a.afterMinutes < 24 * 60) {
      conflitos.push(`A etapa "${a.name}" (${describeRule(a)}) pode vencer no MESMO início de manhã que "${b.name}" (${describeRule(b)}) para quem parou de responder à noite: a primeira sai e a segunda só pode sair 6h depois, possivelmente fora da janela (${b.sendWindowStart ?? "-"}h-${b.sendWindowEnd ?? "-"}h) e expira. É por isso que "o recontato das 8h do dia seguinte" parecia não sair.`);
    }
  }
  if (rules.some((r) => r.active) && rules.some((r) => !r.active)) conflitos.push("Há etapas desligadas no meio da cascata. Elas são puladas; confira se era isso que a clínica queria.");
  const win = rules.find((r) => r.active && r.sendWindowStart != null);
  if (win && win.sendWindowStart != null && win.sendWindowStart >= 12) perguntasPendentes.push(`A regra "${win.name}" só envia a partir das ${win.sendWindowStart}h. Foi isso que a clínica pediu?`);
  perguntasPendentes.push('Qual horário vale para o recontato do dia seguinte: 8h (janela 8h-12h, como está na migração de 14/10) ou "a partir das 12h"? As duas coisas ao mesmo tempo não existem no sistema.');
  perguntasPendentes.push("As retomadas de avaliação cancelada saem em quais dias e horários (a clínica citou as segundas) e com qual texto? Nada foi presumido: ficam desligadas até a clínica aprovar.");

  // exemplo: uma conversa que termina em 3 horas diferentes de uma segunda-feira, e o que a cascata faria com cada etapa
  const base = new Date(Date.UTC(2026, 9, 12, 12, 0, 0)); // segunda 12/10/2026 09:00 em Sao Paulo (referencia fixa so para o exemplo)
  const exemploDeConversa = [{ h: 9 }, { h: 14 }, { h: 20 }].map(({ h }) => {
    const wc = wallClockInZone(base, tz);
    const lastAt = new Date(base.getTime() + (h - wc.hour) * 3_600_000);
    return {
      fim: `${DIAS[wallClockInZone(lastAt, tz).weekday]} ${String(wallClockInZone(lastAt, tz).hour).padStart(2, "0")}h (última mensagem da pessoa)`,
      etapas: activeRules.map((r) => {
        const due = ruleDueAt(r, lastAt, tz);
        const opens = firstOpenAtOrAfter(r, cal, due);
        const f = (d: Date | null) => (d ? `${DIAS[wallClockInZone(d, tz).weekday]} ${String(wallClockInZone(d, tz).hour).padStart(2, "0")}h${String(wallClockInZone(d, tz).minute).padStart(2, "0")}` : null);
        return { ordem: r.order, vence: f(due) ?? "-", podeSairEm: f(opens) };
      }),
    };
  });

  const configs = await prisma.resumeFlowConfig.findMany({ where: { clinicId } });
  const retomadas = [RESUME_CANCELLED, RESUME_NOCLOSE].map((fluxo) => {
    const c = configs.find((x) => x.flow === fluxo);
    const r = readRestriction(c);
    return {
      fluxo, existe: !!c, ligada: !!c?.enabled, dia: c?.weekday ?? null, janela: c && c.startHour != null && c.endHour != null ? `${c.startHour}h-${c.endHour}h` : "qualquer horário de atendimento", temTexto: !!c?.message?.trim(),
      modo: r.mode, restricao: r.mode === "normal" ? null : r.valid ? `${r.patientIds.length} contato(s) de teste, limite de ${r.maxSends} envio(s)` : `INVÁLIDA (${r.problem}): nada é enviado`,
    };
  });

  // pedido de modo restrito: resolve os telefones em pacientes DA CLINICA (previa e aplicacao usam a mesma validacao)
  let modoRestrito: RecontatosResult["modoRestrito"] = null;
  let restritoResolvido: { ids: string[]; limite: number; fluxo: GuardedFlow; aprovadoPor: string } | null = null;
  const m = opts.modoRestrito;
  if (m) {
    const problemas: string[] = [];
    if (!m.aprovadoPor?.trim()) problemas.push("informe quem aprovou o teste (aprovadoPor)");
    if (!Number.isInteger(m.limite) || m.limite < 1 || m.limite > MAX_TEST_SENDS) problemas.push(`limite de envios do teste invalido (inteiro de 1 a ${MAX_TEST_SENDS})`);
    if (!configs.some((c) => c.flow === m.fluxo) && m.fluxo === "indicacao") problemas.push("o convite de indicação ainda não foi configurado nesta clínica (rota lisboa-google, convite)");
    const resolved = await resolveTestContacts(clinicId, Array.isArray(m.telefones) ? m.telefones.map(String) : []);
    if (!resolved.ok) problemas.push(resolved.error);
    modoRestrito = { fluxo: m.fluxo, valido: problemas.length === 0, problemas, contatos: resolved.ok ? resolved.patients.map((p) => ({ nome: p.name, final: p.phoneLast4 })) : [], limite: Number.isInteger(m.limite) ? m.limite : null };
    if (!opts.dryRun && problemas.length) throw new Error(`Modo restrito recusado: ${problemas.join("; ")}`);
    if (resolved.ok && problemas.length === 0) restritoResolvido = { ids: resolved.patients.map((p) => p.id), limite: m.limite, fluxo: m.fluxo, aprovadoPor: m.aprovadoPor.trim() };
  }
  if (!opts.dryRun && opts.voltarAoNormal && !opts.voltarAoNormal.aprovadoPor?.trim()) throw new Error("Para voltar ao modo normal informe quem aprovou (aprovadoPor).");

  const rc = opts.recuperacao;
  if (rc && !opts.dryRun) {
    if (!rc.aprovadoPor?.trim()) throw new Error("Para definir a política de recuperação informe quem aprovou (aprovadoPor).");
    if (rc.horas !== null && !validRecoveryHours(rc.horas)) throw new Error(`Política de recuperação inválida: use null (padrão antigo), 0 (não recupera) ou um número inteiro de 1 a ${MAX_RECOVERY_HOURS} horas.`);
  }
  const aplicado: RecontatosResult["aplicado"] = { configuracoesCriadas: [], ligadas: [], restritas: [], voltaramAoNormal: [], recuperacaoDefinida: false };
  if (!opts.dryRun) {
    for (const fluxo of [RESUME_CANCELLED, RESUME_NOCLOSE] as const) {
      if (configs.some((c) => c.flow === fluxo)) continue;
      // proposta: a clinica falou em retomadas "as segundas" para as canceladas; hora e publico NAO foram informados. Desligada e SEM texto aprovado.
      await prisma.resumeFlowConfig.create({ data: { clinicId, flow: fluxo, enabled: false, weekday: fluxo === RESUME_CANCELLED ? 1 : null, message: null, updatedBy: "preparo automatico (nao aprovado)" } });
      aplicado.configuracoesCriadas.push(fluxo);
    }
    if (rc) {
      await prisma.clinic.update({ where: { id: clinicId }, data: { followupRecoveryHours: rc.horas } });
      aplicado.recuperacaoDefinida = true;
      await logActivity({
        clinicId, type: "briefing_applied", area: "automacoes", title: "Política de recuperação do recontato definida",
        description: `Recuperação: ${rc.horas === null ? "padrão antigo (3 dias)" : rc.horas === 0 ? "não recupera" : `até ${rc.horas}h depois que a janela abriu`}; aprovado por ${rc.aprovadoPor.trim()}.`,
        actorName: opts.actorName ?? null,
      });
    }
    // modo restrito ANTES de ligar: se o pedido liga e restringe de uma vez, nunca existe um instante "ligado para todo mundo"
    if (restritoResolvido) {
      await prisma.resumeFlowConfig.update({
        where: { clinicId_flow: { clinicId, flow: restritoResolvido.fluxo } },
        data: { runMode: "restrito", testPatientIds: JSON.stringify(restritoResolvido.ids), testMaxSends: restritoResolvido.limite, testStartedAt: new Date(), updatedBy: `teste restrito aprovado por ${restritoResolvido.aprovadoPor}` },
      });
      aplicado.restritas.push(restritoResolvido.fluxo);
    }
    if (opts.voltarAoNormal) {
      const v = opts.voltarAoNormal;
      const row = await prisma.resumeFlowConfig.findUnique({ where: { clinicId_flow: { clinicId, flow: v.fluxo } } });
      if (row && row.runMode !== "normal") {
        await prisma.resumeFlowConfig.update({ where: { id: row.id }, data: { runMode: "normal", testPatientIds: null, testMaxSends: null, testStartedAt: null, updatedBy: `volta ao modo normal aprovada por ${v.aprovadoPor.trim()}` } });
        aplicado.voltaramAoNormal.push(v.fluxo);
      }
    }
    const a = opts.ativar;
    if (a) {
      if (!a.aprovadoPor?.trim()) throw new Error("Para ligar uma retomada informe quem aprovou (aprovadoPor).");
      const texto = (a.mensagem ?? "").trim();
      if (!texto) throw new Error(`Para ligar a retomada informe o texto aprovado pela clínica (sugestão: "${a.fluxo === RESUME_CANCELLED ? DEFAULT_CANCELLED_TEXT : DEFAULT_NOCLOSE_TEXT}").`);
      await prisma.resumeFlowConfig.update({
        where: { clinicId_flow: { clinicId, flow: a.fluxo } },
        data: { enabled: true, enabledAt: new Date(), message: texto, ...(a.diaDaSemana !== undefined ? { weekday: a.diaDaSemana } : {}), ...(a.horaInicio !== undefined ? { startHour: a.horaInicio } : {}), ...(a.horaFim !== undefined ? { endHour: a.horaFim } : {}), updatedBy: `aprovado por ${a.aprovadoPor.trim()}` },
      });
      aplicado.ligadas.push(a.fluxo);
    }
    if (aplicado.configuracoesCriadas.length || aplicado.ligadas.length || aplicado.restritas.length || aplicado.voltaramAoNormal.length) { // (a recuperacao ja tem o proprio registro de atividade)
      await logActivity({
        clinicId, type: "briefing_applied", area: "automacoes",
        title: "Retomadas de avaliação preparadas",
        description: `Configurações criadas (desligadas): ${aplicado.configuracoesCriadas.join(", ") || "nenhuma"}; ligadas: ${aplicado.ligadas.join(", ") || "nenhuma"}; em modo restrito (teste): ${aplicado.restritas.join(", ") || "nenhuma"}; de volta ao normal: ${aplicado.voltaramAoNormal.join(", ") || "nenhuma"}.`,
        actorName: opts.actorName ?? null,
      });
    }
  }

  const hours = (() => {
    let by = "";
    try { if (clinic.hoursByDay) by = " · " + Object.entries(JSON.parse(clinic.hoursByDay) as Record<string, [number, number]>).map(([d, h]) => `${DIAS[Number(d)]} ${h[0]}h-${h[1]}h`).join(", "); } catch { /* ignora */ }
    return `${clinic.workDays.split(",").map((d) => DIAS[Number(d)]).join("/")} ${clinic.workStartHour}h-${clinic.workEndHour}h${by}`;
  })();

  const previa = [await previewResumeFlow(clinicId, RESUME_CANCELLED), await previewResumeFlow(clinicId, RESUME_NOCLOSE)];
  const previaRecontato = await previewFollowUpRound(clinicId);
  const atual = (await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { followupRecoveryHours: true } })).followupRecoveryHours;
  const pol = describePolicy(validRecoveryHours(atual) ? atual : null);
  const recuperacao = {
    valorAtual: validRecoveryHours(atual) ? atual : null, pendente: !pol.decididaPelaClinica, descricao: pol.descricao, origem: pol.origem,
    opcoes: ["manter o padrão antigo (tolerância de 3 dias)", "0: não recupera (só sai na rodada em que a janela abre)", `1 a ${MAX_RECOVERY_HOURS}: recupera até N horas depois que a janela abriu`],
  };
  perguntasPendentes.push("Um recontato que venceu mas não saiu na hora (servidor reiniciado, fora do expediente) deve ser RECUPERADO? Por quanto tempo? Hoje vale só o padrão antigo do sistema (3 dias, trava contra disparo em massa), que a clínica nunca aprovou.");
  return { dryRun: opts.dryRun, clinicId, clinica: clinic.name, expediente: hours, fusoHorario: tz, regras, exemploDeConversa, conflitos, perguntasPendentes, retomadas: await recompute(), previa, previaRecontato, recuperacao, modoRestrito, aplicado };

  // as linhas de "retomadas" refletem o estado DEPOIS da aplicacao (modo/ligada podem ter mudado nesta chamada)
  async function recompute() {
    const fresh = await prisma.resumeFlowConfig.findMany({ where: { clinicId } });
    return [RESUME_CANCELLED, RESUME_NOCLOSE].map((fluxo) => {
      const c = fresh.find((x) => x.flow === fluxo);
      const r = readRestriction(c);
      return {
        fluxo, existe: !!c, ligada: !!c?.enabled, dia: c?.weekday ?? null, janela: c && c.startHour != null && c.endHour != null ? `${c.startHour}h-${c.endHour}h` : "qualquer horário de atendimento", temTexto: !!c?.message?.trim(),
        modo: r.mode as string, restricao: r.mode === "normal" ? null : r.valid ? `${r.patientIds.length} contato(s) de teste, limite de ${r.maxSends} envio(s)` : `INVÁLIDA (${r.problem}): nada é enviado`,
      };
    });
  }
}
