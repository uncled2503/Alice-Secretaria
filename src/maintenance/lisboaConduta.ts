import { prisma } from "../db/client.js";
import { logActivity } from "../crm/activity.js";
import { bookingModeOf, notOfferedIn, parseNotOffered } from "../ai/conduct.js";
import { procedureConcerns } from "../ai/concerns.js";
import { substituirRegrasPadraoAntigas, type SubstituicaoRegras } from "../ai/rules.js";

// ---------------------------------------------------------------------------
// CONDUTA COMERCIAL DA LISBOA (pedido de 16/10/2026): servico que a clinica NAO oferece (luz pulsada; a Lisboa trabalha com LEDterapia), como cada
// procedimento agenda (direto x exige avaliacao) e quais regras antigas conflitam com a conducao nova. Mecanismo restrito a UMA clinica, com PREVIA
// (dryRun) e idempotente. Atualizar o seed NAO corrige o cadastro ja usado: por isso o ajuste mexe nas linhas reais da clinica.
//
// O que APLICA (so com dryRun:false): (1) a lista de servicos nao oferecidos; (2) tirar o termo dos APELIDOS de procedimentos (apelido e como a Alice acha o
// procedimento: "luz pulsada" la faria a cliente cair num procedimento que nao e esse); (3) o modo de agendamento explicito que a clinica informar em
// `marcar`; (4) o modo estrito, SO se `ativarModoEstrito` vier verdadeiro (decisao da clinica: com ele ligado, procedimento sem regra vai para a equipe).
// O que SO RELATA (precisa de pessoa): termos dentro de descricao/FAQ/regra/mensagem pronta/roteiro, regras que empurram avaliacao, procedimentos
// sem regra de agendamento e sem queixa declarada no cadastro.
// ---------------------------------------------------------------------------

// Endolaser: informado EXPRESSAMENTE pela clinica em 21/10/2026 ("a Lisboa nao realiza Endolaser"). Fica na configuracao DA LISBOA (campo da clinica), nao no codigo global.
export const LISBOA_NAO_OFERECIDOS = ["luz pulsada", "luz intensa pulsada", "IPL", "Endolaser", "Endo laser"];
// Ofertas que a Lisboa ANUNCIA mas que nao tem cadastro correspondente (nem no sistema nem no Clinica Experts): informadas pela clinica em 18/10/2026.
// Enquanto nao houver cadastro/mapeamento AUTORIZADO, a Alice nao as associa a outro procedimento nem as troca por avaliacao: encaminha para a equipe.
export const LISBOA_OFERTAS_SEM_CADASTRO = ["Protocolo do Olhar"];

export interface Ocorrencia {
  onde: string; // procedimento (nome) | apelido | FAQ | regra | mensagem pronta | roteiro
  id: string;
  termo: string;
  trecho: string;
  acao: "apelido_removido" | "revisar_texto";
}

export interface CondutaResult {
  dryRun: boolean;
  clinicId: string;
  clinica: string;
  naoOferecidos: { atual: string[]; proposto: string[]; muda: boolean };
  ofertasSemCadastro: { atual: string[]; proposto: string[]; muda: boolean; jaCadastradas: string[] }; // jaCadastradas = tem procedimento com esse nome: o cadastro manda, a entrada fica sem efeito
  ocorrencias: Ocorrencia[];
  modoAgendamento: {
    total: number;
    explicitoDireto: number;
    explicitoAvaliacao: number;
    inferidoAvaliacao: string[]; // texto aprovado diz que exige avaliacao (confirme; pode ser marcado como "direct" para vencer)
    semRegra: number;
    semRegraExemplos: string[];
  };
  semQueixaDeclarada: string[]; // sem objetivo no cadastro: a Alice nao os indica para queixa nenhuma
  regrasEmConflito: { id: string; categoria: string; trecho: string }[];
  regrasPadrao: SubstituicaoRegras; // regras recomendadas com o texto antigo (contradiziam a conducao): na aplicacao, trocadas pelo texto novo (so as auto-semeadas, texto exato)
  modoEstrito: { atual: boolean; proposto: boolean };
  marcar: { aplicados: string[]; ignorados: { nome: string; motivo: string }[] };
  aplicado: { naoOferecidos: boolean; ofertasSemCadastro: boolean; apelidosLimpos: number; marcados: number; modoEstrito: boolean; regrasPadraoTrocadas: number };
}

export interface CondutaOptions {
  dryRun: boolean;
  naoOferecidos?: string[]; // substitui a lista proposta
  ofertasSemCadastro?: string[]; // substitui a lista proposta de ofertas anunciadas sem cadastro
  marcar?: { direct?: string[]; evaluation?: string[] }; // nomes EXATOS de procedimentos (a clinica decide)
  ativarModoEstrito?: boolean;
  actorName?: string | null;
}

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ").trim();
const snippet = (text: string, term: string) => {
  const i = fold(text).indexOf(fold(term));
  const start = Math.max(0, i - 40);
  return text.replace(/\s+/g, " ").slice(start, start + 120);
};

// Regras que empurram avaliacao/horario de forma geral e conflitam com a conducao (recusa, procedimento escolhido, so queixa...).
const PUSH_RE = /nunca pergunte .?quer agendar|ofereca direto duas opcoes de horario|toda resposta deve terminar|antes de falar de horarios ou preco, entenda|sempre ofereca os dois caminhos|conduza pra avaliacao|conduza (direto )?(a|para|pra) avaliacao|sempre (ofereca|sugira) (a )?avaliacao|toda conversa (deve|tem que) (terminar|levar)|ofereca (a )?avaliacao (gratuita )?(em toda|sempre)/;

export async function ajustarCondutaLisboa(clinicId: string, opts: CondutaOptions): Promise<CondutaResult> {
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId } });
  const atual = parseNotOffered(clinic.notOfferedServices);
  const alvo = (opts.naoOferecidos ?? LISBOA_NAO_OFERECIDOS).map((s) => s.trim()).filter(Boolean);
  const proposto = [...new Set([...atual, ...alvo])];
  const muda = proposto.length !== atual.length;
  const ofertasAtual = parseNotOffered(clinic.unmappedOffers);
  const ofertasProposto = [...new Set([...ofertasAtual, ...(opts.ofertasSemCadastro ?? LISBOA_OFERTAS_SEM_CADASTRO).map((s) => s.trim()).filter(Boolean)])];
  const mudaOfertas = ofertasProposto.length !== ofertasAtual.length;

  const [procs, faqs, templates, playbooks, rules] = await Promise.all([
    prisma.procedure.findMany({ where: { clinicId }, select: { id: true, name: true, aliases: true, description: true, goals: true, benefits: true, bookingMode: true, internalOnly: true } }),
    prisma.clinicFaq.findMany({ where: { clinicId }, select: { id: true, question: true, answer: true, alternates: true } }),
    prisma.messageTemplate.findMany({ where: { clinicId }, select: { id: true, name: true, body: true } }),
    prisma.playbook.findMany({ where: { clinicId }, select: { id: true, name: true, steps: true, goal: true, triggerText: true } }),
    prisma.customRule.findMany({ where: { clinicId, status: "active" }, select: { id: true, category: true, instruction: true } }),
  ]);

  // 1) onde o termo aparece
  const ocorrencias: Ocorrencia[] = [];
  const terms = proposto;
  const hit = (text: string | null | undefined) => (text ? notOfferedIn(text, terms) : null);
  for (const p of procs) {
    const aliasTerm = (p.aliases ?? "").split(/[,\n;]+/).map((a) => a.trim()).filter(Boolean).find((a) => notOfferedIn(a, terms));
    if (aliasTerm) ocorrencias.push({ onde: "apelido de procedimento", id: p.id, termo: notOfferedIn(aliasTerm, terms)!, trecho: `${p.name}: "${aliasTerm}"`, acao: "apelido_removido" });
    for (const [campo, texto] of [["nome", p.name], ["descrição", p.description], ["objetivos", p.goals], ["benefícios", p.benefits]] as const) {
      const t = hit(texto);
      if (t) ocorrencias.push({ onde: `procedimento (${campo})`, id: p.id, termo: t, trecho: `${p.name}: ${snippet(texto!, t)}`, acao: "revisar_texto" });
    }
  }
  for (const x of faqs) {
    const t = hit(`${x.question} ${x.answer} ${x.alternates}`);
    if (t) ocorrencias.push({ onde: "FAQ", id: x.id, termo: t, trecho: snippet(`${x.question} ${x.answer}`, t), acao: "revisar_texto" });
  }
  for (const x of templates) {
    const t = hit(`${x.name} ${x.body}`);
    if (t) ocorrencias.push({ onde: "mensagem pronta", id: x.id, termo: t, trecho: snippet(x.body, t), acao: "revisar_texto" });
  }
  for (const x of playbooks) {
    const t = hit(`${x.name} ${x.goal ?? ""} ${x.triggerText ?? ""} ${x.steps}`);
    if (t) ocorrencias.push({ onde: "roteiro", id: x.id, termo: t, trecho: snippet(`${x.goal ?? ""} ${x.steps}`, t), acao: "revisar_texto" });
  }
  for (const x of rules) {
    const t = hit(x.instruction);
    if (t) ocorrencias.push({ onde: "regra ativa", id: x.id, termo: t, trecho: snippet(x.instruction ?? "", t), acao: "revisar_texto" });
  }

  // 2) modo de agendamento por procedimento
  const sellable = procs.filter((p) => !p.internalOnly && !/avalia/i.test(p.name));
  let explicitoDireto = 0;
  let explicitoAvaliacao = 0;
  const inferido: string[] = [];
  const semRegra: string[] = [];
  const semQueixa: string[] = [];
  for (const p of sellable) {
    const m = bookingModeOf(p);
    if (m.source === "cadastro") (m.mode === "direct" ? explicitoDireto++ : explicitoAvaliacao++);
    else if (m.mode === "evaluation") inferido.push(p.name);
    else semRegra.push(p.name);
    if (procedureConcerns(p).size === 0) semQueixa.push(p.name);
  }

  // 3) regras antigas que empurram avaliacao/horario
  const regrasEmConflito = rules
    .filter((r) => PUSH_RE.test(fold(r.instruction ?? "")))
    .map((r) => ({ id: r.id, categoria: r.category, trecho: (r.instruction ?? "").replace(/\s+/g, " ").slice(0, 140) }));

  // 4) marcacoes pedidas
  const marcar: CondutaResult["marcar"] = { aplicados: [], ignorados: [] };
  const toMark: { id: string; mode: "direct" | "evaluation" }[] = [];
  for (const [mode, names] of [["direct", opts.marcar?.direct ?? []], ["evaluation", opts.marcar?.evaluation ?? []]] as const) {
    for (const nome of names) {
      const found = procs.filter((p) => fold(p.name) === fold(nome));
      if (found.length === 0) marcar.ignorados.push({ nome, motivo: "nenhum procedimento com esse nome exato nesta clínica" });
      else if (found.length > 1) marcar.ignorados.push({ nome, motivo: "mais de um procedimento com esse nome: não alterado" });
      else { toMark.push({ id: found[0].id, mode }); marcar.aplicados.push(`${found[0].name} → ${mode === "direct" ? "agenda direto" : "exige avaliação"}`); }
    }
  }

  const regrasPadrao = await substituirRegrasPadraoAntigas(clinicId, { dryRun: opts.dryRun });
  const aplicado: CondutaResult["aplicado"] = { naoOferecidos: false, ofertasSemCadastro: false, apelidosLimpos: 0, marcados: 0, modoEstrito: false, regrasPadraoTrocadas: opts.dryRun ? 0 : regrasPadrao.substituidas.length };
  if (!opts.dryRun) {
    if (mudaOfertas) {
      await prisma.clinic.update({ where: { id: clinicId }, data: { unmappedOffers: ofertasProposto.join(", ") } });
      aplicado.ofertasSemCadastro = true;
    }
    if (muda) {
      await prisma.clinic.update({ where: { id: clinicId }, data: { notOfferedServices: proposto.join(", ") } });
      aplicado.naoOferecidos = true;
    }
    // apelidos: tira SO o apelido que e o servico nao oferecido (o resto do cadastro fica)
    for (const o of ocorrencias.filter((x) => x.acao === "apelido_removido")) {
      const p = procs.find((x) => x.id === o.id)!;
      const kept = (p.aliases ?? "").split(/[,\n;]+/).map((a) => a.trim()).filter(Boolean).filter((a) => !notOfferedIn(a, terms));
      await prisma.procedure.updateMany({ where: { id: p.id, clinicId }, data: { aliases: kept.length ? kept.join(", ") : null } });
      aplicado.apelidosLimpos++;
    }
    for (const m of toMark) {
      const r = await prisma.procedure.updateMany({ where: { id: m.id, clinicId }, data: { bookingMode: m.mode } });
      aplicado.marcados += r.count;
    }
    if (opts.ativarModoEstrito === true && !clinic.strictBookingRules) {
      await prisma.clinic.update({ where: { id: clinicId }, data: { strictBookingRules: true } });
      aplicado.modoEstrito = true;
    }
    if (aplicado.naoOferecidos || aplicado.ofertasSemCadastro || aplicado.apelidosLimpos || aplicado.marcados || aplicado.modoEstrito || aplicado.regrasPadraoTrocadas) {
      await logActivity({
        clinicId, type: "briefing_applied", area: "clinica",
        title: "Conduta comercial da Lisboa ajustada",
        description: `Serviços não oferecidos: ${proposto.join(", ") || "—"}; ofertas sem cadastro: ${ofertasProposto.join(", ") || "—"}; apelidos limpos: ${aplicado.apelidosLimpos}; procedimentos marcados: ${aplicado.marcados}; modo estrito: ${opts.ativarModoEstrito ? "ligado" : "inalterado"}.`,
        actorName: opts.actorName ?? null,
      });
    }
  }

  return {
    dryRun: opts.dryRun,
    clinicId,
    clinica: clinic.name,
    naoOferecidos: { atual, proposto, muda },
    ofertasSemCadastro: { atual: ofertasAtual, proposto: ofertasProposto, muda: mudaOfertas, jaCadastradas: ofertasProposto.filter((o) => procs.some((p) => fold(p.name) === fold(o) || fold(p.name).includes(fold(o)))) },
    ocorrencias,
    modoAgendamento: {
      total: sellable.length,
      explicitoDireto,
      explicitoAvaliacao,
      inferidoAvaliacao: inferido.slice(0, 40),
      semRegra: semRegra.length,
      semRegraExemplos: semRegra.slice(0, 40),
    },
    semQueixaDeclarada: semQueixa.slice(0, 60),
    regrasEmConflito,
    regrasPadrao,
    modoEstrito: { atual: clinic.strictBookingRules, proposto: opts.ativarModoEstrito === true ? true : clinic.strictBookingRules },
    marcar,
    aplicado,
  };
}
