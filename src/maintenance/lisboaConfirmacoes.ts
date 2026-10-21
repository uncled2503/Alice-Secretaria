import type { ReminderRule } from "@prisma/client";
import { prisma } from "../db/client.js";
import { logActivity } from "../crm/activity.js";
import { effectivePurpose, explicitPurpose, findPolicyConflicts, ruleProblems, type RuleProblem } from "../reminders/policy.js";
import { previewConfirmationsFor, type ConfirmationsPreview } from "../reminders/controlled.js";

// ---------------------------------------------------------------------------
// POLITICA DE CONFIRMACOES DA LISBOA (21/10/2026), em duas partes que a clinica pediu:
//   1. Confirmacao do dia seguinte: enviada numa janela matinal do DIA ANTERIOR que termina as 9h (fuso da clinica) - nao "24 horas antes".
//   2. Sabado: solicitacao na QUARTA, LEMBRETE na SEXTA para TODOS (inclusive quem ja confirmou; texto "Estamos te esperando amanha" ja cadastrado) e lembrete de novo no SABADO. A regra de sabado SUBSTITUI a generica nesse dia (nunca as duas).
//
// PREVIA POR PADRAO: nao altera nada. Aplicar exige `aprovadoPor` e os HORARIOS APROVADOS (a clinica nao definiu a janela da quarta nem a da sexta: o plano apenas REAPROVEITA a
// configuracao cadastrada que seja compativel e expoe a escolha). Idempotente. Regras de sabado nascem DESLIGADAS, a menos que `ativarSabado` venha com os horarios aprovados.
// Nunca apaga regra, nunca mexe em registros de envio e nunca envia nada.
// ---------------------------------------------------------------------------

export const PRAZO_PADRAO_HORA = 10; // pedido da clinica (21/10, Aline): confirmacao do dia seguinte numa janela de manha, 8h as 10h do dia anterior
const QUARTA = 3; // sabado - 3 dias
const SEXTA = 1;
const SABADO = "6";

export interface Janela { inicio: string; fim: string } // "HH:MM"
export interface ConfirmacoesOpcoes {
  dryRun?: boolean;
  agora?: Date;
  actorName?: string | null;
  aprovadoPor?: string;
  prazoHora?: number; // fim da janela do dia anterior (padrao 9)
  ativarSabado?: boolean;
  janelasAprovadas?: { quarta?: string; sexta?: string }; // "08:00-09:00" - precisa coincidir com o plano (ou com a escolha)
  escolhas?: {
    diaAnteriorInicioHora?: number; // se o inicio cadastrado nao cabe antes do prazo
    quarta?: { inicioHora: number; inicioMinuto?: number; fimHora: number };
    sexta?: { inicioHora: number; inicioMinuto?: number; fimHora: number };
    mensagemQuarta?: string;
    mensagemSexta?: string;
  };
}

export interface ItemPlano { acao: "ajustar" | "criar" | "manter" | "pendencia"; regra: string; descricao: string; de?: string; para?: string }
export interface PlanoConfirmacoes {
  clinicaId: string;
  somentePrevia: boolean;
  aplicado: boolean;
  prazoHora: number;
  itens: ItemPlano[];
  decisoesPendentes: { codigo: string; pergunta: string; proposta: string }[];
  problemas: { regra: string; codigo: string; detalhe: string }[];
  conflitos: { a: string; b: string; detalhe: string }[];
  sabado: { quarta: string | null; sexta: string | null; lembrete: string | null; textoQuarta: string | null };
  previaProximoSabado: ConfirmationsPreview | null;
  observacoes: string[];
}

const hh = (h: number, m = 0) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
const win = (r: Pick<ReminderRule, "sendHour" | "sendMinute" | "sendEndHour">) => (r.sendHour != null && r.sendEndHour != null ? `${hh(r.sendHour, r.sendMinute)}-${hh(r.sendEndHour)}` : "sem janela");

// PURO: o texto da quarta a partir do texto aprovado do dia anterior. So troca a marca "(amanhã)" por "(sábado)"; se o texto tiver outra referencia a "amanhã", ou nenhuma marca, nao inventa: devolve null.
export function sabadoTextFrom(generic: string): string | null {
  if (!/\(\s*amanh[ãa]\s*\)/i.test(generic)) return null;
  const out = generic.replace(/\(\s*amanh[ãa]\s*\)/gi, "(sábado)");
  return /amanh[ãa]/i.test(out) ? null : out;
}

export async function conferirConfirmacoesLisboa(clinicId: string, opts: ConfirmacoesOpcoes = {}): Promise<PlanoConfirmacoes> {
  const dryRun = opts.dryRun !== false;
  const prazo = opts.prazoHora ?? PRAZO_PADRAO_HORA;
  if (!Number.isInteger(prazo) || prazo < 7 || prazo > 12) throw new Error("prazoHora deve ser um inteiro entre 7 e 12.");
  if (!dryRun && !(opts.aprovadoPor ?? "").trim()) throw new Error("Aplicar exige `aprovadoPor` (quem da clinica aprovou os horarios). Sem isso so a previa e gerada.");
  const agora = opts.agora ?? new Date();

  const rules = await prisma.reminderRule.findMany({ where: { clinicId }, orderBy: { createdAt: "asc" } });
  const active = rules.filter((r) => r.active);
  const generic = active.find((r) => !r.parentRuleId && !r.weekdays && r.dayOffset === 1 && effectivePurpose(r) === "confirmacao") ?? null;
  const cobranca = generic ? active.find((r) => r.parentRuleId === generic.id && !r.weekdays) ?? null : null;
  const doDia = active.find((r) => !r.parentRuleId && !r.weekdays && r.dayOffset === 0) ?? null;
  const quartaRule = rules.find((r) => !r.parentRuleId && r.weekdays === SABADO && r.dayOffset === QUARTA && effectivePurpose(r) === "confirmacao") ?? null;
  const sextaRule = rules.find((r) => !r.parentRuleId && r.weekdays === SABADO && r.dayOffset === SEXTA && effectivePurpose(r) === "lembrete") ?? null;
  // o texto que a clinica JA usa na vespera ("Estamos te esperando amanha ..."): reaproveitado como esta; nunca inventado
  const textoVespera = rules.find((r) => !r.weekdays && !r.parentRuleId && /esperando\s+(voc[eê]s?\s+|a\s+sua\s+|te\s+)?amanh[ãa]|te\s+esperando\s+amanh[ãa]/i.test(r.message) && r.dayOffset !== 0) ?? null;

  const itens: ItemPlano[] = [];
  const decisoes: PlanoConfirmacoes["decisoesPendentes"] = [];
  const observacoes: string[] = [];
  const ops: (() => Promise<unknown>)[] = [];
  const e = opts.escolhas ?? {};

  // ---- 1. prazo das 9h na confirmacao do dia anterior ----
  let inicioDiaAnterior: { h: number; m: number } | null = null;
  if (!generic) {
    itens.push({ acao: "pendencia", regra: "-", descricao: "Não há regra ATIVA de confirmação do dia anterior (dia -1, com janela): nada a ajustar." });
    decisoes.push({ codigo: "sem_regra_dia_anterior", pergunta: "A clínica quer a confirmação do dia anterior? Hoje não existe regra ativa com janela de calendário.", proposta: "Cadastrar a regra antes de aplicar a política." });
  } else {
    const startMin = (generic.sendHour ?? 0) * 60 + generic.sendMinute;
    const startOk = generic.sendHour != null && startMin < prazo * 60;
    if (startOk) inicioDiaAnterior = { h: generic.sendHour!, m: generic.sendMinute };
    else if (e.diaAnteriorInicioHora != null && e.diaAnteriorInicioHora >= 7 && e.diaAnteriorInicioHora < prazo) inicioDiaAnterior = { h: e.diaAnteriorInicioHora, m: 0 };
    if (!inicioDiaAnterior) {
      itens.push({ acao: "pendencia", regra: generic.id, descricao: `O início cadastrado (${generic.sendHour == null ? "sem horário" : hh(generic.sendHour, generic.sendMinute)}) não cabe antes das ${prazo}h.` });
      decisoes.push({ codigo: "inicio_dia_anterior", pergunta: `A que horas começa a janela da confirmação do dia anterior (ela termina às ${prazo}h)?`, proposta: "informar escolhas.diaAnteriorInicioHora (7 a " + (prazo - 1) + ")" });
    } else {
      const alvo = { sendHour: inicioDiaAnterior.h, sendMinute: inicioDiaAnterior.m, sendEndHour: prazo };
      const mudou = generic.sendHour !== alvo.sendHour || generic.sendMinute !== alvo.sendMinute || generic.sendEndHour !== alvo.sendEndHour || explicitPurpose(generic) !== "confirmacao";
      if (!mudou) itens.push({ acao: "manter", regra: generic.id, descricao: `Confirmação do dia anterior já está em ${win(generic)} com finalidade explícita.` });
      else {
        itens.push({ acao: "ajustar", regra: generic.id, descricao: "Confirmação do dia anterior termina no prazo; início cadastrado reaproveitado.", de: win(generic), para: `${hh(alvo.sendHour, alvo.sendMinute)}-${hh(prazo)}` });
        ops.push(() => prisma.reminderRule.update({ where: { id: generic.id }, data: { ...alvo, purpose: "confirmacao" } }));
      }
      if (generic.scheduledChange) observacoes.push(`A regra do dia anterior tem uma mudança de janela AGENDADA (${generic.scheduledChange.slice(0, 80)}): ela pode reescrever a janela depois de aplicar este plano. Confira em Lembretes.`);
      const pausa = `${generic.pauseMinSec}-${generic.pauseMaxSec}s entre pessoas`;
      observacoes.push(`Capacidade da janela: o ciclo roda a cada 15 min (${Math.max(1, Math.ceil(((prazo * 60) - inicioDiaAnterior.h * 60 - inicioDiaAnterior.m) / 15))} rodadas); com ${pausa} cada rodada envia 12 (sobe até 30 só quando a fila não caberia). O que não couber na janela NÃO sai depois: a equipe é avisada com a quantidade e o motivo.`);
    }
    if (cobranca && explicitPurpose(cobranca) !== "cobranca") {
      itens.push({ acao: "ajustar", regra: cobranca.id, descricao: "Cobrança do dia anterior ganha finalidade explícita (sem mudar horário nem texto).", de: "legado", para: "cobranca" });
      ops.push(() => prisma.reminderRule.update({ where: { id: cobranca.id }, data: { purpose: "cobranca" } }));
    }
  }
  if (doDia && explicitPurpose(doDia) !== "lembrete") {
    itens.push({ acao: "ajustar", regra: doDia.id, descricao: "Lembrete do dia ganha finalidade explícita (sem mudar horário nem texto; janela preservada).", de: "legado", para: "lembrete" });
    ops.push(() => prisma.reminderRule.update({ where: { id: doDia.id }, data: { purpose: "lembrete" } }));
  }

  // ---- 2. sabado: quarta, sexta e lembrete ----
  let textoQuarta: string | null = quartaRule?.message ?? null;
  const janelaQuarta = (() => {
    if (quartaRule) return { h: quartaRule.sendHour ?? 0, m: quartaRule.sendMinute, fim: quartaRule.sendEndHour ?? 0, origem: "cadastrada" };
    if (e.quarta) return { h: e.quarta.inicioHora, m: e.quarta.inicioMinuto ?? 0, fim: e.quarta.fimHora, origem: "escolhida" };
    if (inicioDiaAnterior) return { h: inicioDiaAnterior.h, m: inicioDiaAnterior.m, fim: prazo, origem: "reaproveitada da confirmação do dia anterior" };
    return null;
  })();
  const janelaSexta = (() => {
    if (sextaRule) return { h: sextaRule.sendHour ?? 0, m: sextaRule.sendMinute, fim: sextaRule.sendEndHour ?? 0, origem: "cadastrada" };
    if (e.sexta) return { h: e.sexta.inicioHora, m: e.sexta.inicioMinuto ?? 0, fim: e.sexta.fimHora, origem: "escolhida" };
    if (textoVespera && textoVespera.dayOffset === 1 && textoVespera.sendHour != null && textoVespera.sendEndHour != null) return { h: textoVespera.sendHour, m: textoVespera.sendMinute, fim: textoVespera.sendEndHour, origem: "reaproveitada da regra que já usa o texto da véspera" };
    if (cobranca && cobranca.sendHour != null && cobranca.sendEndHour != null) return { h: cobranca.sendHour, m: cobranca.sendMinute, fim: cobranca.sendEndHour, origem: "reaproveitada da janela da cobrança cadastrada" };
    return null;
  })();
  const plano = (j: { h: number; m: number; fim: number } | null) => (j ? `${hh(j.h, j.m)}-${hh(j.fim)}` : null);

  if (!quartaRule) {
    textoQuarta = e.mensagemQuarta ?? (generic ? sabadoTextFrom(generic.message) : null);
    if (!janelaQuarta) decisoes.push({ codigo: "janela_quarta", pergunta: "Em que janela da quarta-feira sai a solicitação de confirmação dos atendimentos de sábado?", proposta: "informar escolhas.quarta { inicioHora, fimHora }" });
    if (!textoQuarta) decisoes.push({ codigo: "texto_quarta", pergunta: "Qual o texto da solicitação de quarta? O texto do dia anterior diz '(amanhã)' e na quarta o atendimento é sábado.", proposta: "informar escolhas.mensagemQuarta (ou ajustar o texto do dia anterior para conter exatamente '(amanhã)')" });
    if (janelaQuarta && textoQuarta) {
      itens.push({ acao: "criar", regra: "sabado-quarta", descricao: `Solicitação de confirmação dos atendimentos de SÁBADO, às quartas (3 dias antes), janela ${plano(janelaQuarta)} (${janelaQuarta.origem}).`, para: textoQuarta === generic?.message ? "texto do dia anterior" : "texto do dia anterior com '(amanhã)' trocado por '(sábado)'" });
      decisoes.push({ codigo: "confirmar_janela_quarta", pergunta: "A clínica não definiu a janela da quarta. A janela proposta foi reaproveitada da confirmação do dia anterior; vale?", proposta: plano(janelaQuarta)! });
      decisoes.push({ codigo: "confirmar_texto_quarta", pergunta: "O texto da quarta é o texto aprovado do dia anterior com uma única troca ('(amanhã)' → '(sábado)'). A clínica aprova?", proposta: "aprovar o texto derivado" });
    }
  } else {
    itens.push({ acao: "manter", regra: quartaRule.id, descricao: `Regra de sábado (quarta) já cadastrada, janela ${win(quartaRule)}, ${quartaRule.active ? "ativa" : "desligada"}.` });
  }
  if (!sextaRule) {
    const textoSexta = e.mensagemSexta ?? textoVespera?.message ?? null;
    if (!janelaSexta) decisoes.push({ codigo: "janela_sexta", pergunta: "Em que janela da sexta-feira sai o lembrete (para TODOS os agendamentos de sábado)?", proposta: "informar escolhas.sexta { inicioHora, fimHora }" });
    if (!textoSexta) decisoes.push({ codigo: "texto_sexta", pergunta: "Não encontrei no cadastro a regra que usa 'Estamos te esperando amanhã…'. Qual é o texto do lembrete de sexta?", proposta: "informar escolhas.mensagemSexta" });
    if (janelaSexta && textoSexta) {
      itens.push({ acao: "criar", regra: "sabado-sexta", descricao: `LEMBRETE na sexta (1 dia antes) para TODOS os agendamentos de sábado, inclusive quem já confirmou, janela ${plano(janelaSexta)} (${janelaSexta.origem}). Substitui a confirmação genérica de sexta nesse dia.`, para: e.mensagemSexta ? "texto informado" : "texto já cadastrado da véspera (sem alteração)" });
      decisoes.push({ codigo: "confirmar_janela_sexta", pergunta: `A clínica não definiu a janela da sexta. Proposta: ${plano(janelaSexta)} (${janelaSexta.origem}). Vale?`, proposta: plano(janelaSexta)! });
    }
  } else {
    itens.push({ acao: "manter", regra: sextaRule.id, descricao: `Regra de sábado (sexta) já cadastrada, janela ${win(sextaRule)}, ${sextaRule.active ? "ativa" : "desligada"}.` });
  }
  if (doDia) itens.push({ acao: "manter", regra: doDia.id, descricao: `Lembrete de sábado = o lembrete do dia cadastrado (${win(doDia)}), janela PRESERVADA; confirmados também o recebem.` });
  else decisoes.push({ codigo: "sem_lembrete_do_dia", pergunta: "Não há lembrete do dia ativo (dia 0). A clínica quer o lembrete no sábado? Qual janela?", proposta: "cadastrar a regra do dia" });

  // ---- aplicar ----
  const quer = !dryRun;
  let aplicado = false;
  if (quer) {
    const falta = decisoes.filter((d) => !d.codigo.startsWith("confirmar_"));
    if (falta.length) throw new Error(`Há escolhas obrigatórias sem resposta (${falta.map((d) => d.codigo).join(", ")}); nada foi alterado.`);
    const creating = !quartaRule && janelaQuarta && textoQuarta;
    const creatingSexta = !sextaRule && janelaSexta;
    if (opts.ativarSabado) {
      const aprovQ = plano(janelaQuarta), aprovS = plano(janelaSexta);
      if (opts.janelasAprovadas?.quarta !== aprovQ || opts.janelasAprovadas?.sexta !== aprovS) throw new Error(`Para ativar o sábado, informe janelasAprovadas { quarta: "${aprovQ}", sexta: "${aprovS}" } (os horários que a clínica aprovou); nada foi alterado.`);
    }
    const ativa = opts.ativarSabado === true;
    for (const op of ops) await op();
    let quartaId = quartaRule?.id ?? null;
    if (creating) {
      const created = await prisma.reminderRule.create({
        data: {
          clinicId, hoursBefore: 72, dayOffset: QUARTA, sendHour: janelaQuarta!.h, sendMinute: janelaQuarta!.m, sendEndHour: janelaQuarta!.fim,
          pauseMinSec: generic?.pauseMinSec ?? 10, pauseMaxSec: generic?.pauseMaxSec ?? 30, message: textoQuarta!, active: ativa, weekdays: SABADO, purpose: "confirmacao",
        },
      });
      quartaId = created.id;
    }
    if (creatingSexta) {
      await prisma.reminderRule.create({
        data: {
          clinicId, hoursBefore: 24, dayOffset: SEXTA, sendHour: janelaSexta!.h, sendMinute: janelaSexta!.m, sendEndHour: janelaSexta!.fim,
          pauseMinSec: cobranca?.pauseMinSec ?? 10, pauseMaxSec: cobranca?.pauseMaxSec ?? 30, message: (e.mensagemSexta ?? textoVespera?.message)!, active: ativa,
          weekdays: SABADO, purpose: "lembrete",
        },
      });
    }
    if (ativa) {
      // ligar uma regra que ja existia desligada
      for (const r of [quartaRule, sextaRule]) if (r && !r.active) await prisma.reminderRule.update({ where: { id: r.id }, data: { active: true } });
    }
    aplicado = true;
    await logActivity({ clinicId, type: "automation_updated", area: "automacoes", title: "Política de confirmações aplicada (prazo das " + prazo + "h e sábado)", description: `Aprovado por ${opts.aprovadoPor}. ${itens.filter((i) => i.acao !== "manter").map((i) => i.descricao).join(" ")}`.slice(0, 900), actorName: opts.actorName ?? null }).catch(() => undefined);
  }

  // ---- validacao do resultado (o que ficaria) ----
  const depois = aplicado ? await prisma.reminderRule.findMany({ where: { clinicId } }) : rules;
  const problemas: PlanoConfirmacoes["problemas"] = [];
  for (const r of depois.filter((x) => x.active)) for (const p of ruleProblems(r as ReminderRule, effectivePurpose(r) === "confirmacao" && r.dayOffset === 1 && !r.weekdays ? prazo : null) as RuleProblem[]) problemas.push({ regra: r.id, codigo: p.code, detalhe: p.detail });
  const conflitos = findPolicyConflicts(depois).map((c) => ({ a: c.a, b: c.b, detalhe: c.detail }));
  if (conflitos.length) observacoes.push("Há regras ativas que se pisam (ver 'conflitos'): a segunda seria bloqueada pelo controle de duplicidade. Corrija na origem.");

  // ---- prévia do próximo sábado (data explícita, sem envio) ----
  let previa: ConfirmationsPreview | null = null;
  try {
    const virtual = quartaRule ?? (janelaQuarta && textoQuarta
      ? ({
          id: "plano:sabado-quarta", clinicId, hoursBefore: 72, dayOffset: QUARTA, sendHour: janelaQuarta.h, sendMinute: janelaQuarta.m, sendEndHour: janelaQuarta.fim, parentRuleId: null,
          pauseMinSec: generic?.pauseMinSec ?? 10, pauseMaxSec: generic?.pauseMaxSec ?? 30, scheduledChange: null, message: textoQuarta, active: true, createdAt: agora, weekdays: SABADO, purpose: "confirmacao", resendIfConfirmed: false,
        } as ReminderRule)
      : undefined);
    previa = await previewConfirmationsFor(clinicId, { now: agora, diaDaSemana: 6, regra: virtual });
  } catch (err) {
    observacoes.push(`A prévia do próximo sábado não pôde ser gerada: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    clinicaId: clinicId, somentePrevia: dryRun, aplicado, prazoHora: prazo, itens, decisoesPendentes: decisoes, problemas, conflitos,
    sabado: { quarta: quartaRule?.id ?? (janelaQuarta ? `(a criar) ${plano(janelaQuarta)}` : null), sexta: sextaRule?.id ?? (janelaSexta ? `(a criar) ${plano(janelaSexta)}` : null), lembrete: doDia ? `${doDia.id} ${win(doDia)}` : null, textoQuarta },
    previaProximoSabado: previa, observacoes,
  };
}

// CLI (padrao = PREVIA):  node dist/maintenance/lisboaConfirmacoes.js [--clinica="Lisboa Beauty Center"] [--prazo=9]
if (process.argv[1] && /lisboaConfirmacoes\.js$/.test(process.argv[1].replace(/\\/g, "/"))) {
  const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const nome = arg("clinica") ?? "Lisboa Beauty Center";
  prisma.clinic.findFirst({ where: { name: nome } })
    .then(async (c) => {
      if (!c) throw new Error(`Clinica "${nome}" nao encontrada.`);
      console.log(JSON.stringify(await conferirConfirmacoesLisboa(c.id, { prazoHora: arg("prazo") ? Number(arg("prazo")) : undefined }), null, 2));
    })
    .catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
