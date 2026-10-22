import crypto from "node:crypto";
import { claimsBooking, claimsCancel, claimsReschedule } from "./promises.js";
import { checkSlotMentions, extractMentions, type SlotState } from "./slotGuard.js";
import { offersSlots, slotsOfferedIn } from "./bookingIntent.js";
import { requestViolation, type SlotRequest } from "./slotRequest.js";
import { findRelevanceMismatch } from "./relevance.js";
import { removeSentences, splitSentences } from "./repetition.js";
import { stripSlotOffers } from "./slotText.js";
import { notOfferedIn, NOT_OFFERED_REPLY, evaluationWordingViolation } from "./conduct.js";
import { claimsOutsideFamilies } from "./productClaims.js";
import type { ConcernId, ProcedureInfo } from "./concerns.js";
import { claimIsSupported, claimsPhotosSent, conclusionClaims, GROUP_RE, qualificationProblems, unprovenPriceSentences, unprovenUnitSentences, type ExistingSlot, type ProRef } from "./replyFacts.js";
import { fixRelativeDateLabels, fixRelativeDayLabels, fixWeekdayDatePairs } from "./relativeDays.js";

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
  actions: { booked: boolean; cancelled: boolean; rescheduled: boolean; transferred: boolean; bookedCount?: number; bookedSlots?: ExistingSlot[]; photosSent?: boolean }; // o que as ferramentas FIZERAM nesta rodada (quantas reservas, quais, fotos enviadas)
  evidence: { cancelledRecently: boolean; rescheduledRecently: boolean }; // cancelou/remarcou ha pouco (diario)
  slots: { state: SlotState; toolUsed: boolean; strict: Known; loose: Known; toolDates: string[] }; // o que as ferramentas de agenda DEVOLVERAM
  upcoming: { dateIso: string; time: string; ddmm: string }[]; // horarios ATIVOS dela (cancelado nao entra)
  complaintTexts: string[];
  silentHandoff: boolean;
  confirmationGuard?: boolean; // a mensagem da pessoa parece confirmacao de presenca e ela tem reserva proxima: a resposta final NUNCA oferece horarios nem avaliacao
  // CONDUCAO (ai/conduct.ts): o objetivo que a pessoa tem agora (queixa, nao so regiao), os procedimentos que ELA escolheu/ja tem agendados (citar o nome deles
  // e atender o pedido) e os servicos que a clinica NAO oferece. Opcionais: contextos antigos/fixos continuam validos.
  objective?: { concerns: ConcernId[]; regions: string[] };
  allowedProcedures?: string[];
  notOffered?: string[];
  approvedProductFamilies?: string[]; // familias de composicao/sensacao (frescor, fragrancia, mentol, ativos) que o cadastro aprovado sustenta; undefined = nao conferir
  evaluationOnly?: string; // procedimento que EXIGE avaliacao previa e que ela nao pediu avaliacao: convite/horario precisa dizer AVALIACAO
  // FATOS APROVADOS (cadastro): so o que esta aqui pode ser afirmado sobre formacao e quantidade
  companion?: boolean; // a conversa e sobre agendar MAIS DE UMA pessoa (ela + acompanhante)
  professionals?: ProRef[]; // equipe ativa com a formacao cadastrada (null = nao informada)
  approvedUnits?: number[]; // quantidades (UI/unidades) que o cadastro sustenta
  unitsKnown?: boolean; // o cadastro tem alguma quantidade para citar (se nao tem, qualquer numero de UI e inventado)
  approvedPrices?: number[]; // valores (R$) que o cadastro/regras da clinica sustentam; qualquer outro valor citado e inventado
}

export type ProblemCode = "price_unproven" | "claims_group" | "claims_photos" | "unit_unproven" | "qualification" | "group_offer" | "claims_booking" | "claims_cancel" | "claims_reschedule" | "claims_handoff" | "eval_offer" | "slot_offer_forbidden" | "slot_unproven" | "slot_request" | "relevance" | "not_offered" | "product_unproven" | "eval_wording";
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

  // CONCLUSAO de reserva por SIGNIFICADO e ORIGEM (nao so a palavra "agendei"): "confirmado", "seu horario ficou", "te esperamos as 14h", "voces estao marcados"...
  // So vale se a reserva foi criada nesta rodada pela ferramenta, ou ja existe na agenda (e bate com o dia/hora citados). Proposta no chat e aceite do cliente nao sao reserva.
  if (ctx.agenda) {
    const existing: ExistingSlot[] = [...ctx.upcoming.map((a) => ({ ddmm: a.ddmm, time: a.time })), ...(ctx.actions.bookedSlots ?? [])];
    const booked = ctx.actions.booked || ctx.actions.rescheduled; // reserva criada OU trocada nesta rodada pela ferramenta
    const bookedCount = ctx.actions.bookedCount ?? (booked ? 1 : 0);
    for (const c of (process.env.ALICE_REPLY_FACTS === "off" ? [] : conclusionClaims(text))) {
      if (c.group && bookedCount < 2) { add("claims_group", c.sentence); continue; } // "os dois estao agendados" sem duas reservas confirmadas
      if (!claimIsSupported(c, existing, booked)) { add("claims_booking", `afirma reserva/horario como feito sem reserva verificada: "${c.sentence.slice(0, 90)}"`); }
    }
    // uma unica reserva criada nao cobre duas pessoas
    if (ctx.companion) {
      for (const s of splitSentences(text)) {
        const f = fold(s);
        if (GROUP_RE.test(f) && extractMentions(s).times.length > 0 && !/\?/.test(s) && bookedCount < 2) add("group_offer", s);
      }
    }
  }
  // fotos: nao diz que enviou se a ferramenta nao enviou
  const factsOn = process.env.ALICE_REPLY_FACTS !== "off"; // chave de reversao das travas de FATOS (conclusao por significado, fotos, quantidade, valor, formacao); as travas anteriores seguem
  if (factsOn && claimsPhotosSent(text) && !ctx.actions.photosSent) add("claims_photos", "diz que enviou fotos sem envio confirmado pela ferramenta");
  // quantidade (UI): so a que o cadastro sustenta; faixa inventada nunca
  if (factsOn && (ctx.approvedUnits !== undefined || ctx.unitsKnown !== undefined)) {
    for (const s of unprovenUnitSentences(text, ctx.approvedUnits ?? [])) add("unit_unproven", s);
  }
  // valores em R$: so os do cadastro (preco do procedimento, parcela, ou escritos nas regras/FAQ/mensagens). Valor de print, de conversa antiga ou de memoria nao e cadastro.
  if (factsOn && ctx.approvedPrices !== undefined) for (const s of unprovenPriceSentences(text, ctx.approvedPrices)) add("price_unproven", s);
  // formacao profissional: nunca inferida pelo titulo "Dra."
  if (factsOn && ctx.professionals?.length) {
    for (const q of qualificationProblems(text, ctx.professionals)) add("qualification", q.sentence);
  }

  // oferta indevida
  const norm = fold(text).replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  if (ctx.forbidEvaluationOffer && EVAL_OFFER_RE.test(norm)) add("eval_offer", "oferece avaliacao a quem nao deve receber");
  if ((ctx.forbidSlotOffer || ctx.confirmationGuard) && offersSlots(text)) add("slot_offer_forbidden", ctx.confirmationGuard ? "oferece horarios a quem so confirmou a presenca" : "lista horarios sem a pessoa ter pedido");
  if (ctx.confirmationGuard && /(que horas|qual (dia|turno|horario)|prefere (manha|tarde|noite)|manha, tarde ou noite)/.test(fold(text))) add("slot_request", "pergunta dia/turno a quem so confirmou a presenca");

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

  // afirmacao sobre produto/composicao/sensacao sem fonte no cadastro (a fala da cliente e o texto anterior da Alice nao sao fonte)
  if (process.env.ALICE_REPLY_FACTS !== "off" && ctx.approvedProductFamilies) {
    for (const c of claimsOutsideFamilies(text, ctx.approvedProductFamilies, splitSentences)) add("product_unproven", c.sentence);
  }
  // procedimento que exige avaliacao previa: o horario/convite e da AVALIACAO, nao da sessao
  if (ctx.evaluationOnly && evaluationWordingViolation(text, ctx.evaluationOnly)) add("eval_wording", `agenda "${ctx.evaluationOnly}" sem dizer que e a avaliacao`);

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
  for (const p of problems) if (p.code === "product_unproven") drop.push(p.detail);
  for (const p of problems) if (p.code === "unit_unproven" || p.code === "price_unproven" || p.code === "qualification" || p.code === "group_offer" || p.code === "claims_group") drop.push(p.detail);
  if (problems.some((p) => p.code === "claims_booking")) {
    for (const p of problems) if (p.code === "claims_booking") { const s = /: "(.*)"$/.exec(p.detail)?.[1]; if (s) drop.push(...splitSentences(out).filter((x) => x.startsWith(s.slice(0, 40)))); }
  }
  if (problems.some((p) => p.code === "claims_photos")) drop.push(...splitSentences(out).filter((x) => claimsPhotosSent(x)));
  if (drop.length) out = removeSentences(out, [...new Set(drop)]);
  out = out.trim();
  // Tirar uma afirmacao falsa nao pode deixar um 'Perfeito, Maria!' que soa como aceite: o que sobra precisa ter conteudo proprio (senao sai a resposta segura)
  const factual = problems.some((p) => ["claims_booking", "claims_group", "group_offer", "claims_photos", "unit_unproven", "price_unproven", "qualification", "product_unproven"].includes(p.code));
  const minLen = factual && drop.length ? 45 : 12;
  return out && out !== text.trim() && out.length >= minLen ? out : null;
}

export const NEUTRAL_REPLY = "Combinado! Qualquer coisa é só me chamar. 💗";

// Resposta curta e adequada quando NENHUM texto e seguro: sem fato inventado e SEM prometer acao pendente (a Alice nao "volta depois").
export function safeReplyFor(ctx: ReplyContext | null, problems: ReplyProblem[]): string {
  const codes = new Set(problems.map((p) => p.code));
  // quem so confirmou a presenca nunca recebe pergunta de horario/turno como resposta segura: agradece
  if (ctx?.confirmationGuard && problems.every((p) => ["slot_unproven", "slot_request", "slot_offer_forbidden", "eval_offer", "claims_booking", "relevance"].includes(p.code))) return "Obrigada pela confirmação! 💗";
  const hasBooking = !!ctx && ctx.upcoming.length > 0;
  if (codes.has("claims_cancel") || codes.has("claims_reschedule") || (codes.has("claims_booking") && ctx && (ctx.situationKind === "cancel" || ctx.situationKind === "reschedule"))) {
    return hasBooking
      ? "Pra eu te ajudar certinho: qual dos seus horários você quer ajustar, e para quando fica melhor pra você?"
      : "Pra eu te ajudar certinho: me confirma o dia e o horário do agendamento que você quer ajustar?";
  }
  if (codes.has("claims_group") || codes.has("group_offer")) return "Pra duas pessoas eu organizo cada atendimento separado, um de cada vez. Me passa o nome completo e um telefone de contato de cada uma? Só confirmo o que estiver realmente reservado na agenda. 💗";
  if (codes.has("claims_photos")) return "Não consegui enviar as fotos agora, mas posso te explicar direitinho como funciona e o que esperar. O que você gostaria de saber? 💗";
  if (codes.has("unit_unproven") || codes.has("price_unproven") || codes.has("qualification")) return "Esse detalhe eu prefiro confirmar com a equipe antes de te passar, pra não te informar nada errado. Já deixo registrado pra pessoa certa te responder. 💗";
  if (codes.has("product_unproven")) return "Sobre a composição desse produto eu prefiro confirmar com a equipe antes de te passar, pra não te informar nada errado. Pode me contar o que você quer evitar nele? 💗";
  if (codes.has("eval_wording")) return "Posso agendar a sua *avaliação*: nela a profissional examina o seu caso e orienta o tratamento e a previsão de sessões. Qual dia e período ficam melhores pra você? 💗";
  if (codes.has("claims_booking")) return "Pra eu te ajudar certinho: qual dia e turno (manhã, tarde ou noite) ficam melhores pra você? Só confirmo o horário depois que ele estiver reservado na agenda.";
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
      state: { times: arr(st.times), dates: arr(st.dates), instants: st.instants.slice(0, CAP), offer: st.offer.slice(0, 50), offerProcedure: st.offerProcedure, booked: st.booked },
      toolUsed: ctx.slots.toolUsed, strict: { times: arr(ctx.slots.strict.times), dates: arr(ctx.slots.strict.dates) }, loose: { times: arr(ctx.slots.loose.times), dates: arr(ctx.slots.loose.dates) },
      toolDates: ctx.slots.toolDates.slice(0, CAP),
    },
    upcoming: ctx.upcoming.slice(0, 50), complaintCount: Math.max(0, Math.min(complaintCount, 10)), silentHandoff: ctx.silentHandoff, confirmationGuard: !!ctx.confirmationGuard,
    objective: ctx.objective, allowedProcedures: ctx.allowedProcedures?.slice(0, 50), notOffered: ctx.notOffered?.slice(0, 50), approvedProductFamilies: ctx.approvedProductFamilies, evaluationOnly: ctx.evaluationOnly,
    companion: !!ctx.companion, professionals: ctx.professionals?.slice(0, 40), approvedUnits: ctx.approvedUnits?.slice(0, 40), unitsKnown: ctx.unitsKnown, approvedPrices: ctx.approvedPrices?.slice(0, 200),
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
        state: { times: new Set(p.slots.state.times ?? []), dates: new Set(p.slots.state.dates ?? []), instants: p.slots.state.instants ?? [], offer: p.slots.state.offer ?? [], offerProcedure: p.slots.state.offerProcedure ?? null, booked: p.slots.state.booked ?? null },
        toolUsed: !!p.slots.toolUsed, strict: known(p.slots.strict), loose: known(p.slots.loose), toolDates: p.slots.toolDates ?? [],
      },
      upcoming: p.upcoming ?? [], complaintTexts, silentHandoff: !!p.silentHandoff, confirmationGuard: !!p.confirmationGuard,
      ...(p.objective ? { objective: p.objective } : {}), ...(p.allowedProcedures ? { allowedProcedures: p.allowedProcedures } : {}), ...(p.notOffered ? { notOffered: p.notOffered } : {}), ...(Array.isArray(p.approvedProductFamilies) ? { approvedProductFamilies: p.approvedProductFamilies } : {}), ...(typeof p.evaluationOnly === "string" ? { evaluationOnly: p.evaluationOnly } : {}),
      ...(p.companion ? { companion: true } : {}), ...(p.professionals ? { professionals: p.professionals } : {}), ...(p.approvedUnits ? { approvedUnits: p.approvedUnits } : {}), ...(p.unitsKnown !== undefined ? { unitsKnown: p.unitsKnown } : {}), ...(p.approvedPrices ? { approvedPrices: p.approvedPrices } : {}),
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
  const { ctx } = p;
  // Dia da semana x data e rotulos 'hoje/amanha' sao montados pelo CODIGO a partir da data validada, tanto na original quanto na reescrita da revisao: o texto que
  // passa pelas travas e exatamente o que sai (nada e alterado depois da validacao).
  const fixDates = (t: string): string => (ctx ? fixRelativeDateLabels(fixRelativeDayLabels(fixWeekdayDatePairs(t, ctx.now, ctx.tz), ctx.now, ctx.tz), ctx.now, ctx.tz) : t);
  const original = fixDates(p.original);
  const rewritten = p.rewritten ? fixDates(p.rewritten) : p.rewritten;
  const rejected: FinalChoice["rejected"] = [];
  const evaluate = (text: string, strict: boolean, base?: string): ReplyProblem[] =>
    ctx ? checkFinalReply(text, ctx, { strict, catalog: p.catalog }) : base !== undefined ? checkRewriteWithoutContext(base, text) : [];
  const accept = (source: FinalChoice["source"], text: string, problems: ReplyProblem[]): FinalChoice | null => {
    if (problems.length === 0) return { text, source, needsHandoff: false, rejected };
    if (problems.every((x) => x.code === "claims_handoff")) return { text, source, needsHandoff: true, rejected };
    rejected.push({ source, problems });
    return null;
  };

  if (rewritten) {
    const hit = accept("rewrite", rewritten, evaluate(rewritten, true, original));
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
  const factual = origProblems.some((x) => x.code === "unit_unproven" || x.code === "price_unproven" || x.code === "qualification" || x.code === "claims_group" || x.code === "group_offer"); // a resposta segura promete que a equipe/pessoa certa responde: o encaminhamento e EXECUTADO
  return { text: safeReplyFor(ctx, origProblems), source: "safe", needsHandoff: factual, rejected };
}
