import crypto from "node:crypto";
import { claimsBooking, claimsCancel, claimsReschedule } from "./promises.js";
import { checkSlotMentions, extractMentions, type SlotState } from "./slotGuard.js";
import { offersSlots, slotsOfferedIn } from "./bookingIntent.js";
import { requestViolation, type SlotRequest } from "./slotRequest.js";
import { findRelevanceMismatch } from "./relevance.js";
import { removeSentences, splitSentences } from "./repetition.js";
import { stripSlotOffers } from "./slotText.js";
import { notOfferedIn, NOT_OFFERED_REPLY } from "./conduct.js";
import type { ConcernId, ProcedureInfo } from "./concerns.js";

// ---------------------------------------------------------------------------
// VALIDACAO DA RESPOSTA FINAL (16/10/2026). A revisao por IA pode reescrever a resposta da Alice na hora da entrega; o texto novo NAO passou
// pelas travas que a resposta original passou na geracao (promessa sem acao, dia/hora que a agenda nao devolveu, oferta de avaliacao a quem pediu
// pra cancelar...). Aqui essas travas viram uma funcao PURA, com o CONTEXTO da geracao (o que as ferramentas de fato fizeram e devolveram), que roda
// sobre o texto que vai sair: reescrito OU original. Nada aqui chama ferramenta nem IA.
// ---------------------------------------------------------------------------

export interface Known {
  times: Set<string>;
  dates: Set<string>;
}

export interface ReplyContext {
  conversationId: string;
  tz: string;
  now: Date;
  todayIso: string;
  situationKind: string;
  forbidEvaluationOffer: boolean; // cancelar/remarcar, ja agendada, paciente, sem pedido de agenda...
  forbidSlotOffer: boolean; // ela nao pediu horario
  request: SlotRequest; // o que ela pediu de dia/hora
  trusted: boolean; // texto exato da clinica (preparo do procedimento): nao se valida
  agenda: boolean; // o negocio tem agenda (clinica); loja (modo geral) nao tem: sem checagem de agendamento nem de dia/hora
  actions: { booked: boolean; cancelled: boolean; rescheduled: boolean; transferred: boolean }; // o que as ferramentas FIZERAM nesta rodada
  evidence: { cancelledRecently: boolean; rescheduledRecently: boolean }; // cancelou/remarcou ha pouco (diario)
  slots: { state: SlotState; toolUsed: boolean; strict: Known; loose: Known; toolDates: string[] }; // o que as ferramentas de agenda DEVOLVERAM
  upcoming: { dateIso: string; time: string; ddmm: string }[]; // horarios ATIVOS dela (cancelado nao entra)
  complaintTexts: string[];
  silentHandoff: boolean;
  // CONDUCAO (ai/conduct.ts): o objetivo que a pessoa tem agora (queixa, nao so regiao), os procedimentos que ELA escolheu/ja tem agendados (citar o nome deles
  // e atender o pedido) e os servicos que a clinica NAO oferece. Opcionais: contextos antigos/fixos continuam validos.
  objective?: { concerns: ConcernId[]; regions: string[] };
  allowedProcedures?: string[];
  notOffered?: string[];
}

export type ProblemCode = "claims_booking" | "claims_cancel" | "claims_reschedule" | "claims_handoff" | "eval_offer" | "slot_offer_forbidden" | "slot_unproven" | "slot_request" | "relevance" | "not_offered";
export interface ReplyProblem { code: ProblemCode; detail: string }

function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

// Frase que OFERECE avaliacao ("posso agendar uma avaliacao", "avaliacao gratuita").
export const EVAL_OFFER_RE = /(avaliacao gratuita|agendar (uma |a )?avaliacao|marcar (uma |a )?avaliacao|vamos (agendar|marcar) (uma |a )?avaliacao|(posso|quer que eu|gostaria de|que tal)[^.?!]{0,30}avaliacao)/;

// "Agendei", "marquei", "reservei": acao feita AGORA. ("esta agendado" pode so descrever o horario que ela ja tinha.)
const BOOK_ACTION_RE = /\b(agendei|marquei|reservei|agendamos|consegui agendar|conseguimos agendar|consegui marcar|conseguimos marcar)\b/;

// Diz que passou/vai passar pra equipe ("ja encaminhei", "a equipe vai te responder", "vou pedir pra uma pessoa da equipe continuar").
const HANDOFF_CLAIM_RE =
  /(\bvou\b|\birei\b|\biremos\b|\bvamos\b|\bja vou\b)[^.!?]{0,60}(transferir|encaminhar|passar|repassar|pedir)[^.!?]{0,50}(equipe|time|responsavel|profissional|atendente|colega|pessoa)|\b(ja )?(encaminhei|transferi|repassei|acionei)\b|\bavisei (a )?equipe|\ba equipe (vai|ira) (te )?(responder|retornar|entrar em contato|falar com voce|continuar|te atender)|\buma pessoa da equipe (vai|ira|continua)/;

export function claimsHandoff(text: string): boolean {
  return HANDOFF_CLAIM_RE.test(fold(text));
}

function isoOf(dd: number, mm: number, todayIso: string): string {
  const [y, m, d] = todayIso.split("-").map(Number);
  const year = mm < m || (mm === m && dd < d - 1) ? y + 1 : y;
  return `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

// A afirmacao e sobre um horario que ELA JA TEM (agenda ativa) e nao sobre uma acao nova?
function refersToExistingBooking(text: string, ctx: ReplyContext): boolean {
  if (!ctx.upcoming.length) return false;
  if (BOOK_ACTION_RE.test(fold(text))) return false; // "agendei": acao nova, exige o book_appointment desta rodada
  const m = extractMentions(text);
  const times = new Set(ctx.upcoming.map((a) => a.time));
  const dates = new Set(ctx.upcoming.map((a) => a.ddmm));
  return m.times.every((t) => times.has(t)) && m.dates.every((d) => dates.has(d));
}

export function checkFinalReply(text: string, ctx: ReplyContext, opts: { strict: boolean; catalog?: ProcedureInfo[] }): ReplyProblem[] {
  if (ctx.trusted) return [];
  const problems: ReplyProblem[] = [];
  const add = (code: ProblemCode, detail: string) => problems.push({ code, detail });

  // afirmou uma acao que NAO aconteceu
  if (ctx.agenda && claimsBooking(text) && !ctx.actions.booked && !refersToExistingBooking(text, ctx)) add("claims_booking", "diz que agendou/confirmou sem book_appointment nesta rodada");
  if (ctx.agenda && claimsCancel(text) && !ctx.actions.cancelled && !ctx.evidence.cancelledRecently) add("claims_cancel", "diz que cancelou sem cancelamento executado");
  if (ctx.agenda && claimsReschedule(text) && !ctx.actions.rescheduled && !ctx.evidence.rescheduledRecently) add("claims_reschedule", "diz que remarcou sem remarcacao executada");
  if (claimsHandoff(text) && !ctx.actions.transferred) add("claims_handoff", "diz que encaminhou/vai encaminhar pra equipe sem transferencia registrada");

  // oferta indevida
  const norm = fold(text).replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  if (ctx.forbidEvaluationOffer && EVAL_OFFER_RE.test(norm)) add("eval_offer", "oferece avaliacao a quem nao deve receber");
  if (ctx.forbidSlotOffer && offersSlots(text)) add("slot_offer_forbidden", "lista horarios sem a pessoa ter pedido");

  // dia/hora: so o que uma ferramenta de agenda devolveu nesta rodada, o horario ATIVO dela, ou o que ela mesma escreveu
  if (ctx.agenda) {
    const known = opts.strict || ctx.slots.toolUsed ? ctx.slots.strict : ctx.slots.loose;
    const slotCheck = checkSlotMentions({ text, state: ctx.slots.state, known, toolUsed: opts.strict ? true : ctx.slots.toolUsed, now: ctx.now, tz: ctx.tz });
    if (!slotCheck.ok) add("slot_unproven", slotCheck.problems.slice(0, 2).join("; "));

    // horarios oferecidos tem que respeitar o pedido dela (so sabados, antes das 18:40...)
    const offered = slotsOfferedIn(text).map((o) => ({ date: isoOf(o.dd, o.mm, ctx.todayIso), time: o.time }));
    if (offered.length) {
      const v = requestViolation(ctx.request, offered, ctx.slots.toolDates, ctx.todayIso);
      if (v) add("slot_request", v.slice(0, 120));
    }
  }

  // servico que a clinica NAO oferece (ex.: luz pulsada) citado como se fosse oferta
  if (ctx.notOffered?.length) {
    const sentence = splitSentences(text).find((s) => notOfferedIn(s, ctx.notOffered!) && !NEGATES_OFFER_RE.test(fold(s)));
    if (sentence) add("not_offered", `oferece servico que a clinica nao tem: "${notOfferedIn(sentence, ctx.notOffered)}"`);
  }

  if (opts.catalog && ctx.complaintTexts.length) {
    const mismatch = findRelevanceMismatch({ complaintTexts: ctx.complaintTexts, reply: text, procedures: opts.catalog, objective: ctx.objective, allowed: ctx.allowedProcedures });
    if (mismatch) add("relevance", `indica "${mismatch.procedure}" para queixa de ${mismatch.complaintLabel}`);
  }
  return problems;
}

// "nao trabalhamos com X" nao e oferta
const NEGATES_OFFER_RE = /\bnao (trabalh|temos|tem|oferec|fazemos|faz|realiz|disponibiliz)\w*|\bnao faz parte\b|\bnao (utiliz|usamos|usa)\w*/;

// Limpeza DETERMINISTICA do texto (sem IA): tira as frases que oferecem avaliacao e a lista de horarios. null = nada a limpar / sobrou pouco.
export function sanitizeReply(text: string, problems: ReplyProblem[]): string | null {
  let out = text;
  if (problems.some((p) => p.code === "slot_offer_forbidden" || p.code === "slot_unproven" || p.code === "slot_request")) out = stripSlotOffers(out);
  if (problems.some((p) => p.code === "eval_offer")) {
    const bad = splitSentences(out).filter((s) => EVAL_OFFER_RE.test(fold(s).replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ")));
    if (bad.length) out = removeSentences(out, bad);
  }
  // servico que a clinica nao oferece / procedimento sem relacao com a queixa: tira SO as frases que os citam (o resto da resposta continua util)
  const drop: string[] = [];
  for (const p of problems) {
    if (p.code === "relevance") {
      const name = /indica "([^"]+)"/.exec(p.detail)?.[1];
      if (name) drop.push(...splitSentences(out).filter((s) => fold(s).includes(fold(name))));
    }
    if (p.code === "not_offered") {
      const term = /"([^"]+)"/.exec(p.detail)?.[1];
      if (term) drop.push(...splitSentences(out).filter((s) => notOfferedIn(s, [term]) && !NEGATES_OFFER_RE.test(fold(s))));
    }
  }
  if (drop.length) out = removeSentences(out, [...new Set(drop)]);
  out = out.trim();
  return out && out !== text.trim() && out.length >= 12 ? out : null;
}

export const NEUTRAL_REPLY = "Combinado! Qualquer coisa é só me chamar. 💗";

// Resposta curta e adequada quando NENHUM texto e seguro: sem fato inventado e SEM prometer acao pendente (a Alice nao "volta depois").
export function safeReplyFor(ctx: ReplyContext | null, problems: ReplyProblem[]): string {
  const codes = new Set(problems.map((p) => p.code));
  const hasBooking = !!ctx && ctx.upcoming.length > 0;
  if (codes.has("claims_cancel") || codes.has("claims_reschedule") || (codes.has("claims_booking") && ctx && (ctx.situationKind === "cancel" || ctx.situationKind === "reschedule"))) {
    return hasBooking
      ? "Pra eu te ajudar certinho: qual dos seus horários você quer ajustar, e para quando fica melhor pra você?"
      : "Pra eu te ajudar certinho: me confirma o dia e o horário do agendamento que você quer ajustar?";
  }
  if (codes.has("claims_booking")) return "Pra eu te ajudar certinho: qual dia e turno (manhã, tarde ou noite) ficam melhores pra você?";
  if (codes.has("slot_unproven") || codes.has("slot_request")) return "Pra eu te passar os horários certinhos: você prefere manhã, tarde ou noite? E algum dia da semana fica melhor pra você?";
  if (codes.has("not_offered")) return "Esse serviço não faz parte do que a gente oferece por aqui. Me conta o que você gostaria de tratar que eu vejo as opções que temos? 💗";
  if (codes.has("relevance")) return "Entendi! Pra isso quem indica o melhor caminho com segurança é a profissional. Me conta um pouco mais do que você gostaria de tratar? 💗";
  return NEUTRAL_REPLY;
}

// ---------------- contexto da geracao (para a entrega) ----------------

const registry = new Map<string, { at: number; ctx: ReplyContext }>();
const TTL_MS = 15 * 60_000;
const keyOf = (conversationId: string, text: string) => `${conversationId}|${crypto.createHash("sha1").update(text.trim()).digest("hex").slice(0, 20)}`;

export function rememberReplyContext(ctx: ReplyContext, text: string): void {
  const now = Date.now();
  registry.set(keyOf(ctx.conversationId, text), { at: now, ctx });
  if (registry.size > 500) for (const [k, v] of registry) if (now - v.at > TTL_MS) registry.delete(k);
}

export function recallReplyContext(conversationId: string, text: string): ReplyContext | null {
  const hit = registry.get(keyOf(conversationId, text));
  return hit && Date.now() - hit.at < TTL_MS ? hit.ctx : null;
}

export function forgetReplyContext(conversationId: string, text: string): void {
  registry.delete(keyOf(conversationId, text));
}

// ---------------- contexto PERSISTIDO (sobrevive a reinicio) ----------------
// O registro em memoria acima some no reinicio e depois de 15 min: uma resposta ja gravada ("pending") e entregue DEPOIS disso perdia a validacao completa (a original
// passava sem conferencia e a reescrita so era comparada com a original). Por isso um resumo MINIMO acompanha a mensagem ainda nao entregue (Message.replyContext) e e
// apagado quando ela chega a um estado final. Guarda so: flags da situacao, o que as ferramentas fizeram, os dias/horas que a agenda DEVOLVEU, os agendamentos ativos
// (dia/hora) e nomes de procedimentos. NAO guarda texto de conversa: os trechos da queixa sao relidos das proprias mensagens (so o NUMERO delas e salvo).

const CAP = 300; // teto de cada lista (a agenda de um dia tem dezenas de horarios)
const arr = (s: Iterable<string>): string[] => [...s].slice(0, CAP);

export function serializeReplyContext(ctx: ReplyContext, complaintCount: number): string {
  const st = ctx.slots.state;
  return JSON.stringify({
    v: 1,
    tz: ctx.tz, now: ctx.now.toISOString(), todayIso: ctx.todayIso, situationKind: ctx.situationKind,
    forbidEvaluationOffer: ctx.forbidEvaluationOffer, forbidSlotOffer: ctx.forbidSlotOffer, request: ctx.request, trusted: ctx.trusted, agenda: ctx.agenda,
    actions: ctx.actions, evidence: ctx.evidence,
    slots: {
      state: { times: arr(st.times), dates: arr(st.dates), instants: st.instants.slice(0, CAP), offer: st.offer.slice(0, 50), booked: st.booked },
      toolUsed: ctx.slots.toolUsed, strict: { times: arr(ctx.slots.strict.times), dates: arr(ctx.slots.strict.dates) }, loose: { times: arr(ctx.slots.loose.times), dates: arr(ctx.slots.loose.dates) },
      toolDates: ctx.slots.toolDates.slice(0, CAP),
    },
    upcoming: ctx.upcoming.slice(0, 50), complaintCount: Math.max(0, Math.min(complaintCount, 10)), silentHandoff: ctx.silentHandoff,
    objective: ctx.objective, allowedProcedures: ctx.allowedProcedures?.slice(0, 50), notOffered: ctx.notOffered?.slice(0, 50),
  });
}

// Devolve null se o JSON nao for de uma versao conhecida ou estiver quebrado (a entrega segue como sem contexto: nunca falha por isso).
export function deserializeReplyContext(json: string | null | undefined, conversationId: string, complaintTexts: string[]): ReplyContext | null {
  if (!json) return null;
  try {
    const p = JSON.parse(json);
    if (!p || p.v !== 1) return null;
    const known = (k: { times: string[]; dates: string[] }): Known => ({ times: new Set(k.times ?? []), dates: new Set(k.dates ?? []) });
    return {
      conversationId, tz: p.tz, now: new Date(p.now), todayIso: p.todayIso, situationKind: p.situationKind,
      forbidEvaluationOffer: !!p.forbidEvaluationOffer, forbidSlotOffer: !!p.forbidSlotOffer, request: p.request, trusted: !!p.trusted, agenda: !!p.agenda,
      actions: p.actions, evidence: p.evidence,
      slots: {
        state: { times: new Set(p.slots.state.times ?? []), dates: new Set(p.slots.state.dates ?? []), instants: p.slots.state.instants ?? [], offer: p.slots.state.offer ?? [], booked: p.slots.state.booked ?? null },
        toolUsed: !!p.slots.toolUsed, strict: known(p.slots.strict), loose: known(p.slots.loose), toolDates: p.slots.toolDates ?? [],
      },
      upcoming: p.upcoming ?? [], complaintTexts, silentHandoff: !!p.silentHandoff,
      ...(p.objective ? { objective: p.objective } : {}), ...(p.allowedProcedures ? { allowedProcedures: p.allowedProcedures } : {}), ...(p.notOffered ? { notOffered: p.notOffered } : {}),
    };
  } catch {
    return null;
  }
}

export function persistedComplaintCount(json: string | null | undefined): number {
  try { return json ? Math.max(0, Math.min(Number(JSON.parse(json).complaintCount) || 0, 10)) : 0; } catch { return 0; }
}

// ---------------- escolha do texto FINAL ----------------

// Sem o contexto da geracao (o servidor reiniciou, ou a resposta veio de um caminho fixo): uma REESCRITA so vale se nao trouxer nada novo em relacao a original
// (afirmacao de acao, oferta de horario/avaliacao, dia/hora), porque nao ha como conferir se a acao aconteceu.
export function checkRewriteWithoutContext(original: string, rewritten: string): ReplyProblem[] {
  const problems: ReplyProblem[] = [];
  const add = (code: ProblemCode, detail: string) => problems.push({ code, detail });
  if (claimsBooking(rewritten) && !claimsBooking(original)) add("claims_booking", "afirma agendamento que a original nao afirmava");
  if (claimsCancel(rewritten) && !claimsCancel(original)) add("claims_cancel", "afirma cancelamento que a original nao afirmava");
  if (claimsReschedule(rewritten) && !claimsReschedule(original)) add("claims_reschedule", "afirma remarcacao que a original nao afirmava");
  if (claimsHandoff(rewritten) && !claimsHandoff(original)) add("claims_handoff", "afirma encaminhamento que a original nao afirmava");
  const norm = (t: string) => fold(t).replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  if (EVAL_OFFER_RE.test(norm(rewritten)) && !EVAL_OFFER_RE.test(norm(original))) add("eval_offer", "oferece avaliacao que a original nao oferecia");
  if (offersSlots(rewritten) && !offersSlots(original)) add("slot_offer_forbidden", "lista horarios que a original nao listava");
  const a = extractMentions(original);
  const b = extractMentions(rewritten);
  if (b.times.some((t) => !a.times.includes(t)) || b.dates.some((d) => !a.dates.includes(d))) add("slot_unproven", "cita dia/hora que a original nao citava");
  return problems;
}

export interface FinalChoice {
  text: string;
  source: "rewrite" | "original" | "cleaned" | "safe";
  needsHandoff: boolean; // o texto diz que encaminhou: a transferencia tem que ser EXECUTADA antes de enviar
  rejected: { source: string; problems: ReplyProblem[] }[]; // candidatos recusados (para o log)
}

// Escolhe o que sai: a reescrita da revisao SE passar nas travas; senao a original SE continuar valida; senao a original limpa (sem a oferta indevida);
// senao uma resposta curta e segura. So "diz que encaminhou" sem transferencia nao descarta o texto: pede a transferencia (executada pelo chamador).
export function chooseFinalReply(p: { ctx: ReplyContext | null; original: string; rewritten?: string | null; catalog?: { name: string; aliases?: string | null }[] }): FinalChoice {
  const { ctx, original } = p;
  const rejected: FinalChoice["rejected"] = [];
  const evaluate = (text: string, strict: boolean, base?: string): ReplyProblem[] =>
    ctx ? checkFinalReply(text, ctx, { strict, catalog: p.catalog }) : base !== undefined ? checkRewriteWithoutContext(base, text) : [];
  const accept = (source: FinalChoice["source"], text: string, problems: ReplyProblem[]): FinalChoice | null => {
    if (problems.length === 0) return { text, source, needsHandoff: false, rejected };
    if (problems.every((x) => x.code === "claims_handoff")) return { text, source, needsHandoff: true, rejected };
    rejected.push({ source, problems });
    return null;
  };

  if (p.rewritten) {
    const hit = accept("rewrite", p.rewritten, evaluate(p.rewritten, true, original));
    if (hit) return hit;
  }
  const origProblems = evaluate(original, false);
  const keep = accept("original", original, origProblems);
  if (keep) return keep;
  const cleaned = sanitizeReply(original, origProblems);
  if (cleaned) {
    const hit = accept("cleaned", cleaned, evaluate(cleaned, false));
    if (hit) return hit;
  }
  return { text: safeReplyFor(ctx, origProblems), source: "safe", needsHandoff: false, rejected };
}
