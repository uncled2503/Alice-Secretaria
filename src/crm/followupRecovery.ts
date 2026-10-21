import { prisma } from "../db/client.js";
import { acquireJobLock, INSTANCE_ID } from "../jobs/lock.js";
import { isoDateInZone, wallClockInZone, zonedWallClockToUtc } from "../scheduling/time.js";
import { describeRule, ruleDueAt } from "./followupSchedule.js";
import { RECOVERY_LOCK_PREFIX, runFollowUpCheck } from "./followup.js";
import { previewFollowUpRound, type FollowUpPreview, type PreviewRow } from "./followupPreview.js";
import { isClosingMessage, isExplicitRefusal } from "./followupGuards.js";
import { STALE_RESERVED_MS } from "./followupLedger.js";
import { maskPhone } from "./leadPhones.js";

// ---------------------------------------------------------------------------
// CONFERENCIA E RECUPERACAO CONTROLADA DOS RECONTATOS (Lisboa, 21/10/2026: "nem todos os recontatos previstos para ontem foram feitos; os de hoje sairam?").
//
// A CONFERENCIA separa, para um periodo (dias LOCAIS da clinica, pelo vencimento da etapa) e opcionalmente uma regra, o que o sistema PODE afirmar de cada etapa:
//   previstos       - etapas que venceram no periodo (pela linha do tempo das mensagens: a pessoa calou ate o vencimento);
//   elegiveis       - dessas, as que passaram pelas exclusoes (humano, optou por sair, tem horario, encerrou, respondeu...);
//   retidos         - com o MOTIVO (juiz de IA, revisao de envio, janela, expediente, concorrencia, adiamento...);
//   tentados        - o provedor foi chamado (aceito, falhou, ou sem confirmacao);
//   aceitos         - o provedor ACEITOU a mensagem. NAO e "entregue": o sistema nao recebe recibo de entrega;
//   entregues       - SO quando ha evidencia: a pessoa respondeu depois do recontato;
//   falhos          - falha de envio registrada;
//   sem confirmacao - timeout / processo caiu no envio: pode ter chegado, NUNCA reenviado as cegas;
//   sem registro    - previstas, sem linha de controle e sem motivo conhecido (nao se sabe o que houve: nao e inventado).
// Limites honestos: a linha do tempo reconstroi o "previsto" a partir das mensagens e das regras de HOJE; exclusoes que valiam so naquele dia (ex.: tinha horario marcado e cancelou) nao
// sao reconstruiveis. O que depende do estado de hoje vem marcado como "hoje".
//
// A RECUPERACAO usa a MESMA rodada do recontato (followup.ts, parametro `recovery`): so as pessoas aprovadas na previa, as regras e o periodo escolhidos, mesmas exclusoes e
// revalidacao imediatamente antes de cada envio, MESMO juiz de IA, MESMA revisao de envio, MESMO controle persistente. Respeita atendimento humano, cadencia (6 h entre mensagens
// automaticas), janelas e limite de atraso da clinica (NAO os ultrapassa). Uma etapa por pessoa: as etapas ja vencidas que viriam em seguida ficam registradas como absorvidas. Resultado
// incerto nunca e reenviado. Uma TRAVA no banco impede a rodada automatica de mexer na clinica enquanto a recuperacao roda. So com `executar` E `autorizado`.
// ---------------------------------------------------------------------------

export type Grupo = "aceito" | "incerto" | "falho" | "retido" | "excluido" | "nao_tentado" | "futuro";
export interface LinhaFunil {
  ref: string; // id interno da pessoa
  pessoa: string; // Primeiro S. + final do telefone
  regra: { ordem: number; nome: string; quando: string; ativa: boolean };
  vence: string; // dd/mm hh:mm (fuso da clinica)
  estado: string;
  grupo: Grupo;
  motivo: string;
  elegivel: boolean;
  tentado: boolean;
  entregaComprovada: boolean; // a pessoa respondeu depois do recontato aceito
  recuperavel: boolean; // a previa da recuperacao inclui
  controle: string | null; // estado da linha de controle, se houver
}
export interface FunilRecontatos {
  somenteLeitura: true;
  clinica: string;
  fuso: string;
  geradoEm: string;
  periodo: { de: string; ate: string; regras: string[] };
  politicaDeAtraso: string;
  totais: {
    previstos: number; elegiveis: number; retidos: number; tentados: number; aceitosPeloProvedor: number; entreguesComprovados: number; falhos: number; semConfirmacaoDoResultado: number;
    semRegistro: number; excluidos: number; aindaNaoVenceram: number; recuperaveisAgora: number;
  };
  retidosPorMotivo: Record<string, number>;
  excluidosPorMotivo: Record<string, number>;
  rodadasDoJob: { registradas: number; resumo: Record<string, number> };
  avisos: string[];
  linhas: LinhaFunil[];
  limites: string[];
}

export interface FunilOpts { now?: Date; de: string; ate?: string; regraIds?: string[]; maxLinhas?: number }

const first = (n: string | null | undefined) => (n ?? "").trim().split(/\s+/)[0] || "(sem nome)";
const stampOf = (d: Date, tz: string) => { const w = wallClockInZone(d, tz); return `${String(w.day).padStart(2, "0")}/${String(w.month).padStart(2, "0")} ${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`; };
const chunks = <T>(a: T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };

function dayStart(date: string, tz: string, plus = 0): Date {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + plus));
  return zonedWallClockToUtc(tz, t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), 0, 0);
}

export async function conferirRecontatos(clinicId: string, opts: FunilOpts, pre?: { preview?: FollowUpPreview }): Promise<FunilRecontatos> {
  const now = opts.now ?? new Date();
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { name: true, timezone: true, followupRecoveryHours: true } });
  const tz = clinic.timezone || "America/Sao_Paulo";
  const de = opts.de;
  const ate = opts.ate ?? opts.de;
  const from = dayStart(de, tz);
  const to = dayStart(ate, tz, 1);
  if (to.getTime() <= from.getTime()) throw new Error("O período é inválido: 'ate' vem antes de 'de'.");
  if (to.getTime() - from.getTime() > 14 * 86_400_000) throw new Error("O período máximo é de 14 dias.");

  const allRules = await prisma.followUpRule.findMany({ where: { clinicId }, orderBy: { order: "asc" } });
  const rules = allRules.filter((r) => !opts.regraIds || opts.regraIds.includes(r.id));
  const avisos: string[] = [];
  if (opts.regraIds && rules.length !== opts.regraIds.length) avisos.push("Alguma regra pedida não pertence a esta clínica ou não existe: foi ignorada.");

  const lookback = new Date(from.getTime() - 75 * 86_400_000);
  const convs = await prisma.conversation.findMany({
    where: { patient: { clinicId }, lastMessageAt: { gte: lookback } },
    select: { id: true, patientId: true, status: true, humanTakeover: true, lastFollowUpOrder: true, patient: { select: { name: true, phone: true, optedOut: true, noInterest: true } } },
    take: 6000,
  });
  const convById = new Map(convs.map((c) => [c.id, c]));
  const userMsgs = new Map<string, { at: Date; content: string }[]>();
  for (const part of chunks([...convById.keys()], 400)) {
    const rows = await prisma.message.findMany({ where: { conversationId: { in: part }, role: "user", createdAt: { gte: lookback } }, orderBy: { createdAt: "asc" }, select: { conversationId: true, createdAt: true, content: true } });
    for (const m of rows) { const l = userMsgs.get(m.conversationId) ?? []; l.push({ at: m.createdAt, content: m.content }); userMsgs.set(m.conversationId, l); }
  }
  const ledger = new Map<string, Awaited<ReturnType<typeof prisma.followUpDispatch.findMany>>[number]>();
  for (const part of chunks([...new Set(convs.map((c) => c.patientId))], 400)) {
    const rows = await prisma.followUpDispatch.findMany({ where: { clinicId, flow: "recontato", patientId: { in: part }, createdAt: { gte: lookback } } });
    for (const r of rows) ledger.set(`${r.patientId}|${r.step}|${r.cycleKey}`, r);
  }

  // o que esta valendo HOJE (uma consulta; so descreve o ciclo ATUAL de cada pessoa)
  const preview = pre?.preview ?? (await previewFollowUpRound(clinicId, now, { maxRows: 20_000 }));
  const rowsByRef = new Map<string, PreviewRow[]>();
  for (const p of preview.pessoas) { const l = rowsByRef.get(p.ref) ?? []; l.push(p); rowsByRef.set(p.ref, l); }

  const linhas: LinhaFunil[] = [];
  const totals = { previstos: 0, elegiveis: 0, retidos: 0, tentados: 0, aceitosPeloProvedor: 0, entreguesComprovados: 0, falhos: 0, semConfirmacaoDoResultado: 0, semRegistro: 0, excluidos: 0, aindaNaoVenceram: 0, recuperaveisAgora: 0 };
  const retidos: Record<string, number> = {};
  const excluidos: Record<string, number> = {};
  const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };

  for (const conv of convs) {
    const msgs = userMsgs.get(conv.id) ?? [];
    if (msgs.length === 0) continue;
    const latest = msgs[msgs.length - 1];
    for (const rule of rules) {
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        const dueAt = ruleDueAt(rule, m.at, tz);
        if (dueAt.getTime() < from.getTime() || dueAt.getTime() >= to.getTime()) continue;
        const next = msgs[i + 1];
        if (next && next.at.getTime() <= dueAt.getTime()) continue; // a pessoa voltou a escrever antes de a etapa vencer: nao era silencio
        const cycleKey = String(m.at.getTime());
        const row = ledger.get(`${conv.patientId}|${rule.order}|${cycleKey}`);
        const currentCycle = m.at.getTime() === latest.at.getTime();
        const base = {
          ref: conv.patientId, pessoa: `${first(conv.patient.name)} (${maskPhone(conv.patient.phone)})`,
          regra: { ordem: rule.order, nome: rule.name, quando: describeRule(rule), ativa: rule.active }, vence: stampOf(dueAt, tz),
        };
        const repliedAfter = (sentAt: Date) => msgs.some((x) => x.at.getTime() > sentAt.getTime());
        let l: LinhaFunil;

        if (row) {
          const ctl = row.state;
          const why = `${row.layer ?? "-"}: ${row.reason ?? "sem motivo registrado"}`;
          if (ctl === "sent") {
            const prova = repliedAfter(row.updatedAt);
            l = { ...base, estado: "aceito_pelo_provedor", grupo: "aceito", motivo: prova ? "a pessoa respondeu depois: entrega comprovada pela resposta" : "aceito pelo provedor; entrega NÃO comprovada (sem recibo)", elegivel: true, tentado: true, entregaComprovada: prova, recuperavel: false, controle: ctl };
          } else if (ctl === "unconfirmed" || (ctl === "reserved" && now.getTime() - row.updatedAt.getTime() > STALE_RESERVED_MS)) {
            l = { ...base, estado: "sem_confirmacao_do_resultado", grupo: "incerto", motivo: "tempo esgotado ou processo interrompido no envio: pode ter chegado; NÃO reenviado", elegivel: true, tentado: true, entregaComprovada: repliedAfter(row.updatedAt), recuperavel: false, controle: ctl };
          } else if (ctl === "reserved") {
            l = { ...base, estado: "em_andamento", grupo: "retido", motivo: "reservado nesta rodada, sem desfecho ainda", elegivel: true, tentado: false, entregaComprovada: false, recuperavel: false, controle: ctl };
          } else if (ctl === "failed" || ctl === "failed_permanent") {
            l = { ...base, estado: ctl === "failed" ? "falhou_tentara_de_novo" : "falhou_definitivo", grupo: "falho", motivo: why, elegivel: true, tentado: true, entregaComprovada: false, recuperavel: false, controle: ctl };
          } else if (ctl === "expired" || ctl === "skipped") {
            l = { ...base, estado: ctl === "expired" ? "expirada" : "pulada", grupo: "excluido", motivo: why, elegivel: false, tentado: false, entregaComprovada: false, recuperavel: false, controle: ctl };
          } else {
            // vetoed | deferred | blocked | duplicate
            l = { ...base, estado: ctl === "vetoed" ? (row.temporary ? "vetada_temporariamente" : "vetada_definitivamente") : ctl === "deferred" ? "adiada" : ctl === "blocked" ? "bloqueada_pelo_plano" : "duplicada", grupo: "retido", motivo: why, elegivel: true, tentado: false, entregaComprovada: false, recuperavel: false, controle: ctl };
          }
        } else if (dueAt.getTime() > now.getTime()) {
          l = { ...base, estado: "ainda_nao_venceu", grupo: "futuro", motivo: `vence ${stampOf(dueAt, tz)}`, elegivel: true, tentado: false, entregaComprovada: false, recuperavel: false, controle: null };
        } else if (!rule.active) {
          l = { ...base, estado: "regra_desligada_hoje", grupo: "excluido", motivo: "a regra está desligada hoje (não dá para provar se estava ligada na época)", elegivel: false, tentado: false, entregaComprovada: false, recuperavel: false, controle: null };
        } else if (!currentCycle) {
          l = { ...base, estado: "pessoa_voltou_a_escrever", grupo: "excluido", motivo: "a pessoa escreveu depois do vencimento: o ciclo mudou", elegivel: false, tentado: false, entregaComprovada: false, recuperavel: false, controle: null };
        } else {
          // sem linha de controle e ainda no ciclo atual: o que vale HOJE explica (marcado como "hoje")
          const pr = rowsByRef.get(conv.patientId) ?? [];
          const mine = pr.find((x) => x.regra.ordem === rule.order);
          const exclusion = preview.exclusoesPorPessoa[conv.patientId];
          const hojeEstado = (conv.status !== "active" && `conversa_${conv.status}`) || (conv.humanTakeover && "atendimento_humano") || (conv.patient.optedOut && "pediu_para_nao_receber") || (conv.patient.noInterest && "sem_interesse") || null;
          if (mine) {
            const rec = mine.decisao === "enviaria" && !mine.controleExistente;
            if (mine.decisao === "enviaria") l = { ...base, estado: "elegivel_agora", grupo: "nao_tentado", motivo: "passa nas regras de hoje e não tem registro de tentativa: a rodada automática ainda não pegou ou está limitada pelo teto", elegivel: true, tentado: false, entregaComprovada: false, recuperavel: rec, controle: null };
            else if (mine.decisao === "aguardando") l = { ...base, estado: "retida_hoje", grupo: "retido", motivo: `hoje: aguardando (${mine.motivo})`, elegivel: true, tentado: false, entregaComprovada: false, recuperavel: false, controle: null };
            else if (mine.decisao === "expira") l = { ...base, estado: "fora_do_prazo_de_atraso", grupo: "excluido", motivo: `hoje: passou do limite de atraso (${mine.motivo}); a recuperação NÃO ultrapassa o limite`, elegivel: true, tentado: false, entregaComprovada: false, recuperavel: false, controle: null };
            else l = { ...base, estado: "excluida_hoje", grupo: "excluido", motivo: `hoje: ${mine.motivo}`, elegivel: false, tentado: false, entregaComprovada: false, recuperavel: false, controle: null };
          } else if (pr.length) {
            const earlier = pr[0];
            l = { ...base, estado: "etapa_anterior_pendente", grupo: "retido", motivo: `a etapa ${earlier.regra.ordem} vem antes na cascata (${earlier.decisao}): etapas vencidas não se acumulam`, elegivel: true, tentado: false, entregaComprovada: false, recuperavel: false, controle: null };
          } else if (hojeEstado) {
            l = { ...base, estado: "fora_do_recontato_hoje", grupo: "excluido", motivo: `hoje: ${hojeEstado}`, elegivel: false, tentado: false, entregaComprovada: false, recuperavel: false, controle: null };
          } else if (exclusion) {
            l = { ...base, estado: "excluida_hoje", grupo: "excluido", motivo: `hoje: ${exclusion}`, elegivel: false, tentado: false, entregaComprovada: false, recuperavel: false, controle: null };
          } else if (isClosingMessage(m.content) || isExplicitRefusal(m.content)) {
            l = { ...base, estado: "encerrou_ou_recusou", grupo: "excluido", motivo: "a última mensagem da pessoa encerra o assunto ou recusa", elegivel: false, tentado: false, entregaComprovada: false, recuperavel: false, controle: null };
          } else {
            l = { ...base, estado: "sem_registro", grupo: "nao_tentado", motivo: "nenhuma linha de controle e nenhum motivo conhecido: NÃO se sabe o que houve (conferir as rodadas do job e os logs do servidor)", elegivel: true, tentado: false, entregaComprovada: false, recuperavel: false, controle: null };
          }
        }

        linhas.push(l);
        totals.previstos++;
        if (l.grupo === "futuro") totals.aindaNaoVenceram++;
        if (l.elegivel && l.grupo !== "futuro") totals.elegiveis++;
        if (l.grupo === "retido") { totals.retidos++; bump(retidos, `${l.estado}: ${l.motivo.slice(0, 90)}`); }
        if (l.grupo === "excluido") { totals.excluidos++; bump(excluidos, `${l.estado}: ${l.motivo.slice(0, 90)}`); }
        if (l.tentado) totals.tentados++;
        if (l.grupo === "aceito") totals.aceitosPeloProvedor++;
        if (l.entregaComprovada && l.grupo === "aceito") totals.entreguesComprovados++;
        if (l.grupo === "falho") totals.falhos++;
        if (l.grupo === "incerto") totals.semConfirmacaoDoResultado++;
        if (l.estado === "sem_registro" || l.estado === "elegivel_agora") totals.semRegistro += l.estado === "sem_registro" ? 1 : 0;
        if (l.recuperavel) totals.recuperaveisAgora++;
      }
    }
  }

  // prova de execucao do job no periodo (AutomationRun existe desde 17/10; ausencia de linha NAO prova que o job nao rodou)
  const runs = await prisma.automationRun.findMany({ where: { job: "recontato", clinicId, startedAt: { gte: from, lt: to < now ? to : now } }, select: { reasons: true } });
  const resumo: Record<string, number> = {};
  for (const r of runs) { try { for (const [k, v] of Object.entries(JSON.parse(r.reasons ?? "{}") as Record<string, number>)) resumo[k] = (resumo[k] ?? 0) + v; } catch { /* resumo ilegivel */ } }

  const hours = clinic.followupRecoveryHours;
  const politica = hours == null
    ? "Padrão antigo do sistema: um recontato vencido ainda pode sair até 3 dias depois do vencimento, com a janela aberta. A clínica ainda não definiu o prazo (followupRecoveryHours)."
    : hours === 0 ? "A clínica definiu: sem recuperação (só na rodada em que a janela abre)." : `A clínica definiu: recupera até ${hours} h depois que a janela abriu.`;
  if (totals.recuperaveisAgora > 0 && hours == null) avisos.push(`${totals.recuperaveisAgora} etapa(s) ainda estão dentro do limite de atraso padrão (3 dias) e a rodada AUTOMÁTICA vai enviá-las sozinha nas próximas rodadas (até 8 por clínica a cada 15 min). A recuperação controlada serve para decidir ANTES, com prévia e aprovação.`);
  if (runs.length === 0 && to.getTime() <= now.getTime()) avisos.push("Nenhuma rodada do job de recontato aparece registrada neste período. Isso NÃO prova que o job não rodou (o registro de rodadas só existe desde 17/10); confira os logs do servidor.");

  return {
    somenteLeitura: true, clinica: clinic.name, fuso: tz, geradoEm: stampOf(now, tz),
    periodo: { de, ate, regras: rules.map((r) => `${r.order}. ${r.name || "(sem nome)"} — ${describeRule(r)}${r.active ? "" : " [DESLIGADA]"}`) },
    politicaDeAtraso: politica, totais: totals, retidosPorMotivo: retidos, excluidosPorMotivo: excluidos, rodadasDoJob: { registradas: runs.length, resumo }, avisos,
    linhas: linhas.sort((a, b) => Number(b.recuperavel) - Number(a.recuperavel) || a.vence.localeCompare(b.vence)).slice(0, opts.maxLinhas ?? 400),
    limites: [
      "'Aceito pelo provedor' NÃO é 'entregue': o sistema não recebe recibo de entrega dos recontatos. 'Entregue comprovado' = a pessoa respondeu depois.",
      "O 'previsto' é reconstruído pela linha do tempo das mensagens e pelas regras de HOJE; exclusões que valiam só naquele dia não são reconstruíveis. Motivos marcados 'hoje:' descrevem o estado de agora.",
      "'Sem registro' = previsto, sem linha de controle e sem motivo conhecido: o sistema NÃO sabe o que houve e não inventa uma causa.",
      "Produzido contra o banco ao qual este comando está conectado: só descreve a Lisboa de produção se rodar contra o banco de produção.",
    ],
  };
}

// ---------------------------------------------------------------------------
// EXECUCAO
// ---------------------------------------------------------------------------
export interface ExecutarOpts extends FunilOpts {
  executar: boolean;
  autorizado: boolean;
  aprovadoPor?: string; // opcional: so aparece no registro
  apenas?: string[]; // ids internos das pessoas (subconjunto da previa)
  limite?: number; // teto de envios (padrao 10, maximo 30)
  sleep?: (ms: number) => Promise<void>;
}
export interface ResultadoRecuperacao {
  executado: true;
  periodo: { de: string; ate: string };
  aprovadas: number;
  rodadaAutomaticaEmAndamento: boolean;
  tentados: number;
  aceitosPeloProvedor: number;
  semConfirmacao: number;
  falhos: number;
  retidosNaRevalidacao: { ref: string; estado: string; motivo: string }[];
  naoProcessados: string[];
  resumoDaRodada: Record<string, number>;
}

export async function executarRecuperacaoRecontatos(clinicId: string, opts: ExecutarOpts): Promise<ResultadoRecuperacao> {
  if (!opts.executar || !opts.autorizado) throw new Error("Execução recusada: exige `executar` E `autorizado` (autorização explícita de uma pessoa). Sem isso o comando só gera a prévia.");
  const now = opts.now ?? new Date();
  const lockName = `${RECOVERY_LOCK_PREFIX}${clinicId}`;
  if (!(await acquireJobLock(lockName, 30 * 60_000, now, INSTANCE_ID))) throw new Error("Já existe uma recuperação em andamento para esta clínica (travada no banco): nada foi feito.");
  try {
    const funil = await conferirRecontatos(clinicId, { ...opts, now });
    const ids = funil.linhas.filter((l) => l.recuperavel && (!opts.apenas || opts.apenas.includes(l.ref))).map((l) => l.ref);
    const aprovadas = [...new Set(ids)];
    const rules = await prisma.followUpRule.findMany({ where: { clinicId, ...(opts.regraIds ? { id: { in: opts.regraIds } } : {}) }, select: { id: true } });
    const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { timezone: true } });
    const tz = clinic.timezone || "America/Sao_Paulo";
    const out: ResultadoRecuperacao = {
      executado: true, periodo: { de: opts.de, ate: opts.ate ?? opts.de }, aprovadas: aprovadas.length, rodadaAutomaticaEmAndamento: false,
      tentados: 0, aceitosPeloProvedor: 0, semConfirmacao: 0, falhos: 0, retidosNaRevalidacao: [], naoProcessados: [], resumoDaRodada: {},
    };
    if (aprovadas.length === 0) return out;
    const startedAt = new Date();
    const ran = await runFollowUpCheck({
      now, clinicId, ...(opts.sleep ? { sleep: opts.sleep } : {}),
      recovery: {
        patientIds: new Set(aprovadas), ruleIds: opts.regraIds ? new Set(rules.map((r) => r.id)) : undefined,
        dueFrom: dayStart(opts.de, tz), dueTo: dayStart(opts.ate ?? opts.de, tz, 1), maxSends: Math.min(opts.limite ?? 10, 30), approvedBy: opts.aprovadoPor?.trim() || "administrador",
      },
    });
    if (!ran) { out.rodadaAutomaticaEmAndamento = true; out.naoProcessados = aprovadas; return out; }

    const rows = await prisma.followUpDispatch.findMany({ where: { clinicId, flow: "recontato", patientId: { in: aprovadas }, runMode: "recuperacao", updatedAt: { gte: new Date(startedAt.getTime() - 1000) } } });
    const touched = new Set<string>();
    for (const r of rows) {
      touched.add(r.patientId);
      if (r.state === "sent") { out.tentados++; out.aceitosPeloProvedor++; }
      else if (r.state === "unconfirmed") { out.tentados++; out.semConfirmacao++; }
      else if (r.state === "failed" || r.state === "failed_permanent") { out.tentados++; out.falhos++; }
      else if (r.state !== "expired") out.retidosNaRevalidacao.push({ ref: r.patientId, estado: r.state, motivo: `${r.layer ?? "-"}: ${r.reason ?? "-"}` });
    }
    out.naoProcessados = aprovadas.filter((id) => !touched.has(id));
    const run = await prisma.automationRun.findFirst({ where: { job: "recontato", clinicId, mode: "recuperacao", startedAt: { gte: new Date(now.getTime() - 1000) } }, orderBy: { startedAt: "desc" }, select: { reasons: true } });
    try { out.resumoDaRodada = run?.reasons ? (JSON.parse(run.reasons) as Record<string, number>) : {}; } catch { out.resumoDaRodada = {}; }
    return out;
  } finally {
    await prisma.jobLock.updateMany({ where: { name: lockName, holder: INSTANCE_ID }, data: { expiresAt: new Date(0) } }).catch(() => undefined);
  }
}

// CLI. Padrao = CONFERENCIA/PREVIA (somente leitura):
//   node dist/crm/followupRecovery.js --de=AAAA-MM-DD [--ate=AAAA-MM-DD] [--regra=<id>] [--clinica="Lisboa Beauty Center"]
// Execucao real (so com autorizacao explicita): acrescentar  --executar --autorizado --aprovado-por="Nome"  (e opcionalmente --apenas=id1,id2 --limite=10)
if (process.argv[1] && /followupRecovery\.js$/.test(process.argv[1].replace(/\\/g, "/"))) {
  const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const flag = (n: string) => process.argv.includes(`--${n}`);
  const nome = arg("clinica") ?? "Lisboa Beauty Center";
  prisma.clinic.findFirst({ where: { name: nome } })
    .then(async (c) => {
      if (!c) throw new Error(`Clinica "${nome}" nao encontrada.`);
      const tz = (await prisma.clinic.findUniqueOrThrow({ where: { id: c.id }, select: { timezone: true } })).timezone || "America/Sao_Paulo";
      const de = arg("de") ?? isoDateInZone(new Date(), tz);
      const common = { de, ate: arg("ate"), regraIds: arg("regra")?.split(",") };
      if (flag("executar")) console.log(JSON.stringify(await executarRecuperacaoRecontatos(c.id, { ...common, executar: true, autorizado: flag("autorizado"), aprovadoPor: arg("aprovado-por") ?? "", apenas: arg("apenas")?.split(","), limite: arg("limite") ? Number(arg("limite")) : undefined }), null, 2));
      else console.log(JSON.stringify(await conferirRecontatos(c.id, common), null, 2));
    })
    .catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
