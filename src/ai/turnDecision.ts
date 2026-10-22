// CONTRATO DE DECISAO DO TURNO. Junta, em UM objeto, o que o codigo ja decide em lugares diferentes (fluxo de venda, situacao, conducao, procedimento pedido, leitura das
// mensagens novas): sobre o que ela fala, o que respondeu a Alice, o que ja se sabe e de onde veio, o que ficou sem resposta, em que etapa estamos, qual a proxima acao
// permitida e o que e proibido. NAO e uma segunda maquina de estados: nao decide nada novo, so le o que os modulos existentes ja decidiram e expoe isso de forma unica
// (log tecnico e superficie de teste). Puro: sem banco, sem OpenAI.
import type { ConductPlan, Understanding } from "./conduct.js";
import type { Wanted } from "./bookingIntent.js";
import type { SalesFlow } from "./salesFlow.js";
import type { Situation } from "./situation.js";

export type FactSource = "fala" | "cadastro" | "agenda" | "anuncio" | "conducao";
export interface KnownFact {
  key: "queixa" | "regiao" | "procedimento_escolhido" | "procedimento_citado" | "negado" | "agendamento_futuro" | "horario_escolhido" | "avaliacao_pedida";
  value: string;
  source: FactSource;
}

export type Stage = "descoberta" | "solucao" | "agendamento" | "agendado" | "recusou" | "pensando" | "equipe" | "encerrado";
export type NextAction =
  | "responder_perguntas" // o que ela perguntou vem antes de qualquer outra coisa
  | "descobrir" // falta saber o que ela quer tratar
  | "explicar" // apresentar a solucao aprovada / tirar duvida
  | "oferecer_horarios"
  | "agendar"
  | "passar_para_equipe"
  | "acolher_e_aguardar" // recusou / vai pensar / so agradeceu
  | "encerrar";

export interface TurnDecision {
  subject: string; // sobre o que e este turno (intencao do fluxo + situacao)
  stage: Stage;
  answeringPrevious: { question: string; meaning: string } | null; // pergunta anterior da Alice que a fala responde, e o que significa
  need: { concerns: string[]; regions: string[]; negated: string[]; regionOnly: boolean; complaintOnly: boolean };
  procedure: { chosen: string | null; mode: string | null; mentioned: string[]; unmappedOffer: string | null; notOffered: string | null };
  knownFacts: KnownFact[];
  unanswered: string[]; // perguntas das mensagens novas
  objection: string | null;
  goalCorrection: boolean;
  nextAction: NextAction;
  allowedTools: string[]; // ferramentas de agenda liberadas neste turno
  forbidden: string[]; // o que a resposta NAO pode fazer neste turno
}

export function decideTurn(i: { flow: SalesFlow; situation: Situation; understanding: Understanding | null; plan: ConductPlan | null; wanted: Wanted; nextBookingLabel?: string | null; chosenSlotLabel?: string | null }): TurnDecision {
  const { flow, situation, understanding: u, plan } = i;
  const r = flow.reading;
  const closing = situation.closeWith != null;
  const forcedTransfer = !!(situation.forceTransfer || plan?.handoffForced);

  const facts: KnownFact[] = [];
  if (u?.objective.concerns.length) facts.push({ key: "queixa", value: u.objective.concerns.join("+"), source: "fala" });
  if (u?.objective.regions.length) facts.push({ key: "regiao", value: u.objective.regions.join("+"), source: "fala" });
  if (u?.objective.negated.length) facts.push({ key: "negado", value: u.objective.negated.join("+"), source: "fala" });
  if (u?.chosen) facts.push({ key: "procedimento_escolhido", value: u.chosen.name, source: "fala" });
  if (u && !u.chosen && u.options.length) facts.push({ key: "procedimento_citado", value: u.options.join("|"), source: "fala" });
  if (u?.unmappedAsked) facts.push({ key: "procedimento_citado", value: u.unmappedAsked, source: "anuncio" });
  if (i.nextBookingLabel) facts.push({ key: "agendamento_futuro", value: i.nextBookingLabel, source: "agenda" });
  if (i.chosenSlotLabel) facts.push({ key: "horario_escolhido", value: i.chosenSlotLabel, source: "fala" });
  if (u?.evaluationRequested) facts.push({ key: "avaliacao_pedida", value: "sim", source: "fala" });

  const schedulingOpen = plan ? plan.gate.schedulingOpen : flow.schedulingSignal;
  const thinking = flow.intent === "hesitate" || u?.declineState === "thinking";
  const refused = flow.intent === "refuse" || u?.declineState === "offer_refused";

  let stage: Stage;
  if (forcedTransfer) stage = "equipe";
  else if (closing) stage = "encerrado";
  else if (thinking) stage = "pensando";
  else if (refused) stage = "recusou";
  else if (flow.hasBooking && !schedulingOpen) stage = "agendado";
  else if (schedulingOpen) stage = "agendamento";
  else if (u?.chosen || (u && u.eligible.length && u.complaintOnly)) stage = "solucao";
  else stage = "descoberta";

  let nextAction: NextAction;
  if (forcedTransfer || (plan?.handoff && !schedulingOpen)) nextAction = "passar_para_equipe";
  else if (closing) nextAction = "encerrar";
  else if (r.questions.length && (stage === "pensando" || stage === "recusou" || stage === "agendado" || r.discountAsk || r.objection)) nextAction = "responder_perguntas";
  else if (stage === "pensando" || stage === "recusou") nextAction = "acolher_e_aguardar";
  else if (stage === "agendamento") nextAction = i.chosenSlotLabel ? "agendar" : "oferecer_horarios";
  else if (stage === "agendado") nextAction = "responder_perguntas";
  else if (stage === "solucao" || (r.meaning === "accepts_info" || r.meaning === "experience_none")) nextAction = "explicar";
  else nextAction = "descobrir";

  const forbidden: string[] = [];
  if (plan?.forbidSlotOffer || situation.forbidSlotOffer || !schedulingOpen) forbidden.push("listar_horarios");
  if (plan?.forbidEvaluationOffer || situation.forbidEvaluationOffer) forbidden.push("oferecer_avaliacao");
  if (u?.notOfferedAsked) forbidden.push("dizer_que_a_clinica_faz:" + u.notOfferedAsked);
  if (u?.unmappedAsked) forbidden.push("agendar_avaliacao_no_lugar_da_oferta_sem_cadastro");
  if (plan?.gate.blocked) forbidden.push("agendar:" + plan.gate.blocked.procedure);
  if (plan?.gate.lockedProcedure) forbidden.push("trocar_o_procedimento_escolhido");
  if (r.discountAsk) forbidden.push("prometer_desconto");
  if (r.objection) forbidden.push("inventar_urgencia_ou_condicao");
  if (u?.regionOnly || (u?.complaintOnly && !schedulingOpen)) forbidden.push("indicar_procedimento_sem_queixa_aprovada");

  const allowedTools: string[] = [];
  if (schedulingOpen && !forcedTransfer && !(plan?.gate.blocked && !plan.gate.evaluationAllowed)) allowedTools.push("check_availability", "check_specific_time", "book_appointment");
  if (thinking) allowedTools.push("schedule_recontact");

  return {
    subject: situation.kind !== "default" && situation.kind !== "plain_reply" ? `${flow.intent}/${situation.kind}` : flow.intent,
    stage,
    answeringPrevious: r.meaning ? { question: r.prevQuestion, meaning: r.meaning } : null,
    need: {
      concerns: u?.objective.concerns ?? [],
      regions: u?.objective.regions ?? [],
      negated: u?.objective.negated ?? [],
      regionOnly: !!u?.regionOnly,
      complaintOnly: !!u?.complaintOnly,
    },
    procedure: {
      chosen: u?.chosen?.name ?? null,
      mode: u?.chosen ? `${u.chosen.mode}/${u.chosen.source}` : null,
      mentioned: u?.alsoMentioned?.length ? u.alsoMentioned : u?.options ?? (i.wanted.kind === "options" ? i.wanted.options : []),
      unmappedOffer: u?.unmappedAsked ?? null,
      notOffered: u?.notOfferedAsked ?? null,
    },
    knownFacts: facts,
    unanswered: r.questions,
    objection: r.objection,
    goalCorrection: r.goalCorrection,
    nextAction,
    allowedTools,
    forbidden,
  };
}

// Linha curta para o log tecnico (sem conteudo da conversa alem de rotulos).
export function turnDecisionLog(d: TurnDecision): string {
  return `etapa=${d.stage} acao=${d.nextAction} sujeito=${d.subject} ferramentas=${d.allowedTools.join("+") || "-"} proibido=${d.forbidden.join("+") || "-"} perguntas=${d.unanswered.length} objecao=${d.objection ?? "-"}${d.answeringPrevious ? ` resposta_curta=${d.answeringPrevious.meaning}` : ""}${d.goalCorrection ? " corrigiu_objetivo=sim" : ""}`;
}
