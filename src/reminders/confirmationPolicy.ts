import type { ReminderRule } from "@prisma/client";
import { prisma } from "../db/client.js";
import { logActivity } from "../crm/activity.js";
import { effectivePurpose, explicitPurpose, findPolicyConflicts, parseWeekdays, ruleProblems, WEEKDAY_NAMES, type ReminderPurpose } from "./policy.js";
import { effectivePolicy, loadPolicy, type PolicyValues } from "../dispatch/policy.js";

// ---------------------------------------------------------------------------
// POLITICA DE CONFIRMACOES E LEMBRETES COMO CONFIGURACAO (geral, por empresa). Uma politica e uma lista de ETAPAS (o que a mensagem e, para qual dia da semana do atendimento,
// quantos dias antes, janela, texto e de qual etapa ela depende) mais os limites de envio (reposicao/limite noturno/antecedencia/intervalo entre etapas). Nada aqui e da Lisboa:
// a politica da Lisboa e um DADO (maintenance/lisboaPoliticaConfirmacoes.ts).
//
// O planejador compara a politica com as regras CADASTRADAS (ReminderRule) e devolve o plano: criar / ajustar / manter / desativar (nunca apaga) / pendencia. Valor que a empresa nao
// informou (ex.: hora do lembrete de sexta) NUNCA e inventado: a etapa vira PENDENCIA e nada e criado para ela. Aplicar exige aprovacao explicita; nunca envia nada e nunca mexe em
// registros de envio. Idempotente: aplicar duas vezes nao muda nada na segunda.
// ---------------------------------------------------------------------------

export interface HoraMin { h: number; m: number }
// fim da janela: hora cheia | "duracao_cadastrada" (mesma duracao da regra cadastrada que a etapa substitui; sem ela = pendencia) | null (nao informado = pendencia)
export type FimJanela = number | "duracao_cadastrada" | null;
// texto: literal | "manter" (o texto aprovado ja cadastrado na regra correspondente; sem regra = pendencia) | { derivarDe, de, para } (troca exata no texto aprovado de outra etapa) | null
export type TextoEtapa = string | "manter" | { derivarDe: string; trocar: [RegExp, string] } | null;

export interface EtapaPolitica {
  chave: string;
  descricao: string;
  finalidade: ReminderPurpose;
  diasAntes: number; // dayOffset: 0 = no dia, 1 = vespera...
  diasDaSemana: string | null; // dia da semana do ATENDIMENTO ("6" = sabado); null = todos (a etapa com dia substitui a generica naquele dia)
  inicio: HoraMin | null; // null = nao informado (pendencia)
  fim: FimJanela;
  texto: TextoEtapa;
  depende?: string; // chave da etapa-mae (cobranca)
  substituiEtapa?: string; // de qual etapa cadastrada reaproveitar a duracao da janela quando nao ha regra propria
  enviarParaConfirmados?: boolean; // so para confirmacao (lembrete sempre vai a todos)
}
export interface LimitesEnvio { lateStartHour: number | null; lateEndHour: number | null; minLeadMin: number | null; stepMinGapMin: number | null } // null = nao informado (vale o vigente; pendencia)
export interface PoliticaConfirmacoes { nome: string; versao: string; etapas: EtapaPolitica[]; limites: LimitesEnvio; pendenciasConhecidas?: { codigo: string; pergunta: string }[] }

export type AcaoPlano = "criar" | "ajustar" | "manter" | "desativar" | "pendencia";
export interface ItemPlanoPolitica { acao: AcaoPlano; etapa: string | null; regra: string | null; descricao: string; de?: Record<string, unknown>; para?: Record<string, unknown> }
export interface PlanoPolitica {
  politica: string; versao: string; clinicaId: string; somentePrevia: boolean; aplicado: boolean;
  itens: ItemPlanoPolitica[];
  pendencias: { codigo: string; pergunta: string }[];
  limites: { atual: Pick<PolicyValues, "lateStartHour" | "lateEndHour" | "minLeadMin" | "stepMinGapMin">; proposto: Partial<LimitesEnvio>; pendente: string[] };
  cronograma: string[];
  problemasDepois: { regra: string; codigo: string; detalhe: string }[];
  conflitosDepois: { a: string; b: string; detalhe: string }[];
}

const hh = (h: number | null | undefined, m = 0) => (h == null ? "—" : `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
const normDays = (w: string | null | undefined) => { const p = parseWeekdays(w); return p.days ? [...p.days].sort().join(",") : null; };
const winOf = (r: Pick<ReminderRule, "sendHour" | "sendMinute" | "sendEndHour">) => `${hh(r.sendHour, r.sendMinute)}–${hh(r.sendEndHour)}`;

// PURO: acha a regra cadastrada que corresponde a etapa (mesma finalidade efetiva, mesmo dia-offset, mesmos dias, mesma mae). Prefere a ativa e a mais antiga.
export function matchRule(etapa: EtapaPolitica, rules: ReminderRule[], parentId: string | null): ReminderRule | null {
  const hits = rules.filter((r) =>
    (r.parentRuleId ?? null) === parentId &&
    (etapa.depende ? !!r.parentRuleId : !r.parentRuleId) &&
    r.dayOffset === etapa.diasAntes &&
    normDays(r.weekdays) === normDays(etapa.diasDaSemana) &&
    effectivePurpose(r) === etapa.finalidade,
  );
  return hits.sort((a, b) => Number(b.active) - Number(a.active) || a.createdAt.getTime() - b.createdAt.getTime())[0] ?? null;
}

// PURO: a "agenda" da politica em palavras (o que sai em que dia), para a previa e para a documentacao.
export function cronogramaDe(p: PoliticaConfirmacoes): string[] {
  const out: string[] = [];
  for (const e of p.etapas) {
    const dias = e.diasDaSemana ? parseWeekdays(e.diasDaSemana).days! : null;
    const alvo = dias ? [...dias].map((d) => WEEKDAY_NAMES[d]).join(", ") : "qualquer dia";
    const quando = e.diasAntes === 0 ? "no próprio dia" : e.diasAntes === 1 ? "na véspera" : `${e.diasAntes} dias antes`;
    const envio = dias && dias.size === 1 ? ` (${WEEKDAY_NAMES[([...dias][0] - e.diasAntes + 7) % 7]})` : "";
    const hora = e.inicio ? `${hh(e.inicio.h, e.inicio.m)}${typeof e.fim === "number" ? `–${hh(e.fim)}` : ""}` : "HORÁRIO NÃO INFORMADO";
    out.push(`${e.chave}: ${e.finalidade} para atendimentos de ${alvo}, ${quando}${envio}, ${hora}${e.depende ? ` — só para quem recebeu "${e.depende}" e não confirmou` : ""}`);
  }
  return out;
}

export interface AplicarOpcoes { dryRun?: boolean; aprovado?: boolean; actorName?: string | null; desativarConflitantes?: boolean }

export async function planejarPolitica(clinicId: string, politica: PoliticaConfirmacoes, opts: AplicarOpcoes = {}): Promise<PlanoPolitica> {
  const dryRun = opts.dryRun !== false;
  if (!dryRun && opts.aprovado !== true) throw new Error("Aplicar a política exige aprovado=true (prévia revisada). Nada foi alterado.");
  const rules = await prisma.reminderRule.findMany({ where: { clinicId }, orderBy: { createdAt: "asc" } });
  const itens: ItemPlanoPolitica[] = [];
  const pendencias: PlanoPolitica["pendencias"] = [...(politica.pendenciasConhecidas ?? [])];
  const ops: { etapa: string; run: (ids: Map<string, string>) => Promise<string> }[] = [];
  const matched = new Map<string, ReminderRule | null>();
  const targetIds = new Set<string>();

  // texto final de cada etapa (resolvido na ordem, para "derivarDe")
  const textos = new Map<string, string | null>();
  for (const e of politica.etapas) {
    const parent = e.depende ? matched.get(e.depende) ?? null : null;
    const r = matchRule(e, rules, e.depende ? parent?.id ?? "__sem_mae__" : null);
    matched.set(e.chave, r);
    let texto: string | null = null;
    if (typeof e.texto === "string" && e.texto !== "manter") texto = e.texto;
    else if (e.texto === "manter") texto = r?.message ?? null;
    else if (e.texto && typeof e.texto === "object") {
      const base = textos.get(e.texto.derivarDe) ?? null;
      const [re, to] = e.texto.trocar;
      texto = base && re.test(base) ? base.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"), to) : null;
    }
    textos.set(e.chave, texto);

    const fonteDuracao = r ?? (e.substituiEtapa ? matched.get(e.substituiEtapa) ?? null : null);
    let fim: number | null = null;
    if (typeof e.fim === "number") fim = e.fim;
    else if (e.fim === "duracao_cadastrada" && e.inicio && fonteDuracao?.sendHour != null && fonteDuracao.sendEndHour != null) {
      const dur = fonteDuracao.sendEndHour * 60 - (fonteDuracao.sendHour * 60 + fonteDuracao.sendMinute);
      fim = dur > 0 ? Math.ceil((e.inicio.h * 60 + e.inicio.m + dur) / 60) : null;
    }
    const falta: string[] = [];
    if (!e.inicio) falta.push("horário de início");
    if (e.inicio && fim == null) falta.push("fim da janela");
    if (!texto) falta.push("texto aprovado");
    if (e.depende && !parent && !ops.some((o) => o.etapa === e.depende)) falta.push(`etapa-mãe "${e.depende}"`);
    if (falta.length) {
      itens.push({ acao: "pendencia", etapa: e.chave, regra: r?.id ?? null, descricao: `${e.descricao}: falta ${falta.join(", ")}. Nada é criado/alterado para esta etapa${r ? ` (a regra cadastrada ${r.id} fica como está, ${r.active ? "ativa" : "desligada"})` : ""}.` });
      pendencias.push({ codigo: `etapa_${e.chave}`, pergunta: `${e.descricao}: informe ${falta.join(", ")}.` });
      if (r?.active) targetIds.add(r.id);
      continue;
    }
    const alvo = { sendHour: e.inicio!.h, sendMinute: e.inicio!.m, sendEndHour: fim!, message: texto!, purpose: e.finalidade as string, weekdays: e.diasDaSemana, dayOffset: e.diasAntes, resendIfConfirmed: e.finalidade === "confirmacao" ? e.enviarParaConfirmados === true : false, active: true };
    if (r) {
      targetIds.add(r.id);
      const de: Record<string, unknown> = {}, para: Record<string, unknown> = {};
      if (r.sendHour !== alvo.sendHour || r.sendMinute !== alvo.sendMinute || r.sendEndHour !== alvo.sendEndHour) { de.janela = winOf(r); para.janela = `${hh(alvo.sendHour, alvo.sendMinute)}–${hh(alvo.sendEndHour)}`; }
      if (r.message !== alvo.message) { de.texto = r.message; para.texto = alvo.message; }
      if (explicitPurpose(r) !== e.finalidade) { de.finalidade = r.purpose ?? "legado"; para.finalidade = e.finalidade; }
      if (r.resendIfConfirmed !== alvo.resendIfConfirmed) { de.enviarParaConfirmados = r.resendIfConfirmed; para.enviarParaConfirmados = alvo.resendIfConfirmed; }
      if (!r.active) { de.ativa = false; para.ativa = true; }
      if (r.scheduledChange) { de.mudancaAgendada = r.scheduledChange.slice(0, 80); para.mudancaAgendada = null; }
      if (Object.keys(para).length === 0) itens.push({ acao: "manter", etapa: e.chave, regra: r.id, descricao: `${e.descricao}: já conforme (${winOf(r)}).` });
      else {
        itens.push({ acao: "ajustar", etapa: e.chave, regra: r.id, descricao: e.descricao, de, para });
        ops.push({ etapa: e.chave, run: async () => { await prisma.reminderRule.update({ where: { id: r.id }, data: { sendHour: alvo.sendHour, sendMinute: alvo.sendMinute, sendEndHour: alvo.sendEndHour, message: alvo.message, purpose: alvo.purpose, resendIfConfirmed: alvo.resendIfConfirmed, active: true, scheduledChange: null } }); return r.id; } });
      }
    } else {
      itens.push({ acao: "criar", etapa: e.chave, regra: null, descricao: e.descricao, para: { janela: `${hh(alvo.sendHour, alvo.sendMinute)}–${hh(alvo.sendEndHour)}`, diasAntes: alvo.dayOffset, diasDaSemana: alvo.weekdays ?? "todos", finalidade: alvo.purpose, texto: alvo.message, ...(e.depende ? { depende: e.depende } : {}) } });
      const pauseSrc = fonteDuracao;
      ops.push({
        etapa: e.chave,
        run: async (ids) => {
          const parentRuleId = e.depende ? ids.get(e.depende) ?? matched.get(e.depende)?.id ?? null : null;
          if (e.depende && !parentRuleId) throw new Error(`etapa-mãe ${e.depende} sem regra`);
          const created = await prisma.reminderRule.create({ data: { clinicId, hoursBefore: Math.max(1, alvo.dayOffset * 24), dayOffset: alvo.dayOffset, sendHour: alvo.sendHour, sendMinute: alvo.sendMinute, sendEndHour: alvo.sendEndHour, pauseMinSec: pauseSrc?.pauseMinSec ?? 10, pauseMaxSec: pauseSrc?.pauseMaxSec ?? 30, message: alvo.message, active: true, weekdays: alvo.weekdays, purpose: alvo.purpose, resendIfConfirmed: alvo.resendIfConfirmed, parentRuleId } });
          return created.id;
        },
      });
    }
  }

  // Regras ATIVAS fora da politica que se pisam com uma etapa dela (mesma finalidade, mesmo dia-offset, dias sobrepostos) ou que pedem confirmacao sem janela de calendario:
  // propostas para DESLIGAR (nunca apagar; historico preservado). "Regra nova remove a antiga" - mas so com aprovacao.
  const virtual: ReminderRule[] = rules.map((r) => ({ ...r }));
  const extras = rules.filter((r) => r.active && !targetIds.has(r.id));
  const novas = itens.filter((i) => i.acao === "criar").map((i, k) => ({ id: `nova:${i.etapa}:${k}`, parentRuleId: null, message: String(i.para?.texto ?? ""), purpose: String(i.para?.finalidade ?? ""), dayOffset: Number(i.para?.diasAntes ?? 0), weekdays: i.para?.diasDaSemana === "todos" ? null : (i.para?.diasDaSemana as string), active: true, depende: i.para?.depende }));
  for (const x of extras) {
    const conflita = findPolicyConflicts([x, ...virtual.filter((r) => targetIds.has(r.id)), ...novas.map((n) => ({ ...n, parentRuleId: n.depende ? "x" : null }))]).some((c) => c.a === x.id || c.b === x.id);
    const semJanela = ruleProblems(x).some((p) => p.code === "sem_janela_de_calendario");
    if (!conflita && !semJanela) continue;
    itens.push({ acao: "desativar", etapa: null, regra: x.id, descricao: `Regra ativa fora da política (${effectivePurpose(x)}, ${x.dayOffset == null ? `${x.hoursBefore}h antes` : `dia -${x.dayOffset}`}, ${winOf(x)}${x.weekdays ? `, dias ${x.weekdays}` : ""}): ${semJanela ? "pede confirmação sem janela de calendário" : "se sobrepõe a uma etapa da política"}. Proposta: DESLIGAR (não apagar).`, de: { ativa: true, texto: x.message.slice(0, 120) }, para: { ativa: false } });
    if (opts.desativarConflitantes !== false) ops.push({ etapa: `desativar:${x.id}`, run: async () => { await prisma.reminderRule.update({ where: { id: x.id }, data: { active: false } }); return x.id; } });
  }

  // limites de envio (reposicao, limite noturno, antecedencia, intervalo entre etapas): o que nao foi informado fica como esta e vira pendencia
  const atualC = await loadPolicy(clinicId, "confirmacao");
  const atualB = await loadPolicy(clinicId, "cobranca");
  const L = politica.limites;
  const pendenteL: string[] = [];
  if (L.lateEndHour == null) pendenteL.push("limite noturno da reposição (hoje vale " + atualC.lateEndHour + "h)");
  if (L.lateStartHour == null) pendenteL.push("início da reposição (hoje vale " + atualC.lateStartHour + "h)");
  if (L.minLeadMin == null) pendenteL.push(`antecedência mínima ("muito próximo"; hoje vale ${atualC.minLeadMin} min)`);
  if (L.stepMinGapMin == null) pendenteL.push(`intervalo mínimo entre etapas (hoje vale ${atualB.stepMinGapMin} min)`);
  for (const p of pendenteL) pendencias.push({ codigo: "limite_envio", pergunta: `Confirmar ${p}.` });
  const propostoL = Object.fromEntries(Object.entries(L).filter(([, v]) => v != null)) as Partial<LimitesEnvio>;
  if (Object.keys(propostoL).length) {
    ops.push({
      etapa: "limites",
      run: async () => {
        for (const kind of ["confirmacao", "cobranca", "lembrete"] as const) {
          const row = await prisma.dispatchPolicy.findUnique({ where: { clinicId_kind: { clinicId, kind } } });
          const eff = effectivePolicy(kind, { ...(row ?? {}), ...propostoL });
          const data = { lateStartHour: eff.lateStartHour, lateEndHour: eff.lateEndHour, stepMinGapMin: eff.stepMinGapMin, ...(kind === "confirmacao" && propostoL.minLeadMin != null ? { minLeadMin: eff.minLeadMin } : {}), updatedBy: opts.actorName ?? "politica" };
          await prisma.dispatchPolicy.upsert({ where: { clinicId_kind: { clinicId, kind } }, create: { clinicId, kind, ...data }, update: data });
        }
        return "limites";
      },
    });
  }

  let aplicado = false;
  if (!dryRun) {
    const ids = new Map<string, string>();
    for (const op of ops) ids.set(op.etapa, await op.run(ids));
    aplicado = true;
    await logActivity({ clinicId, type: "automation_updated", area: "automacoes", title: `Política de confirmações aplicada: ${politica.nome} (${politica.versao})`, description: itens.filter((i) => i.acao !== "manter").map((i) => `${i.acao}: ${i.descricao}`).join(" | ").slice(0, 900), actorName: opts.actorName ?? null }).catch(() => undefined);
  }

  const depois = aplicado ? await prisma.reminderRule.findMany({ where: { clinicId } }) : rules;
  const problemasDepois: PlanoPolitica["problemasDepois"] = [];
  for (const r of depois.filter((x) => x.active)) for (const p of ruleProblems(r)) problemasDepois.push({ regra: r.id, codigo: p.code, detalhe: p.detail });
  const conflitosDepois = aplicado ? findPolicyConflicts(depois).map((c) => ({ a: c.a, b: c.b, detalhe: c.detail })) : [];

  return {
    politica: politica.nome, versao: politica.versao, clinicaId: clinicId, somentePrevia: dryRun, aplicado, itens, pendencias,
    limites: { atual: { lateStartHour: atualC.lateStartHour, lateEndHour: atualC.lateEndHour, minLeadMin: atualC.minLeadMin, stepMinGapMin: atualB.stepMinGapMin }, proposto: propostoL, pendente: pendenteL },
    cronograma: cronogramaDe(politica), problemasDepois, conflitosDepois,
  };
}
