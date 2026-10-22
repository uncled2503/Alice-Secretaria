// CONTINUIDADE COMERCIAL (Lisboa, 21/10/2026): casos Anara, Wilma, Kelly, Nathalia, Paula e Taise lidos PELO CODIGO (decisao do turno, jogada entregue ao modelo, travas), sem banco e sem OpenAI.
// LIMITE: prova o contrato do codigo (o que o modelo recebe, o que e proibido, o que a saida valida); o texto que o modelo REAL escreve depende do modelo e precisa de validacao controlada.
import assert from "node:assert/strict";
import test from "node:test";

const { analyzeFlow, turnObligations } = await import("../dist/ai/salesFlow.js");
const { identifyWanted, findChosenSlot } = await import("../dist/ai/bookingIntent.js");
const { understandConversation, planConduct, evaluationWordingViolation, withoutNotOffered } = await import("../dist/ai/conduct.js");
const { resolveSituation } = await import("../dist/ai/situation.js");
const { decideTurn, turnDecisionLog } = await import("../dist/ai/turnDecision.js");
const reading = await import("../dist/ai/turnReading.js");
const { parseSlotRequest, slotRespects, requestViolation } = await import("../dist/ai/slotRequest.js");
const { durationFactOf, durationBriefing } = await import("../dist/ai/durationFact.js");
const { unsupportedProductClaims, productClaimSentences, approvedProductFamilies, clarifyProductTerm } = await import("../dist/ai/productClaims.js");
const { promisesTeamFollowUp, announcesAction } = await import("../dist/ai/promises.js");
const { splitSentences } = await import("../dist/ai/repetition.js");
const { checkFinalReply, sanitizeReply, safeReplyFor } = await import("../dist/ai/replyGuard.js");
const { selectFocusProcedures } = await import("../dist/ai/procedureFocus.js");
const { stripGenericFarewell } = await import("../dist/ai/replyFacts.js");
const { collapseDuplicatedProcedureWord } = await import("../dist/crm/template.js");

const CATALOG = [
  { name: "Botox", aliases: "botox,toxina botulinica", goals: "rugas,linhas de expressao", benefits: "suaviza linhas de expressao", description: "Toxina botulinica.", bookingMode: "evaluation", durationMin: 30 },
  { name: "Despigmentação de Sobrancelhas", aliases: "remocao de micropigmentacao,despigmentacao", goals: "remover micropigmentacao", benefits: "", description: "Remocao de pigmento.", bookingMode: "evaluation", durationMin: 30, price: 199.99 },
  { name: "Remoção de Tatuagem", aliases: "remocao de tatuagem,tatuagem", goals: "tatuagem", benefits: "", description: "Remocao a laser.", bookingMode: "evaluation", durationMin: 30 },
  { name: "Lavieen Full Face", aliases: "lavieen", goals: "manchas,poros,textura", benefits: "melhora textura", description: "Laser para rejuvenescimento. A sessao dura cerca de 40 minutos.", bookingMode: "direct", durationMin: 45, ceId: 11 },
  { name: "Carboxiterapia", aliases: "carboxi,carboxiterapia", goals: "estrias,flacidez,celulite,olheira,costas", benefits: "melhora circulacao", description: "Aplicacao de CO2.", bookingMode: "direct", durationMin: 15, ceId: 12 },
  { name: "Limpeza de Pele", aliases: "limpeza", goals: "acne,poros", benefits: "limpeza profunda", description: "Limpeza de pele profunda. Produtos hipoalergenicos.", bookingMode: "direct", durationMin: 60, ceId: 13 },
  { name: "Avaliação Estética", aliases: "avaliacao", goals: "", benefits: "", description: "Avaliacao gratuita.", bookingMode: "direct", durationMin: 30, ceId: 14 },
];
const now = new Date("2026-10-20T15:00:00Z");
const at = (i) => new Date(now.getTime() - (100 - i) * 60_000);
const U = (c) => ({ role: "user", content: c });
const A = (c) => ({ role: "assistant", content: c });

function decida({ history, trailing, upcoming = [], notOffered = [], adText = "", catalog = CATALOG, strictBooking = false }) {
  const full = [...history.map((m, i) => ({ ...m, createdAt: at(i) })), ...trailing.map((t, i) => ({ role: "user", content: t, createdAt: at(90 + i) }))];
  const hasBooking = upcoming.length > 0;
  const wanted = identifyWanted(catalog, [adText, ...full.filter((m) => m.role === "user").map((m) => m.content)].filter(Boolean), adText ? 1 : 0);
  const understanding = understandConversation({ history: full, now, wanted, catalog, strictBooking, notOffered, unmappedOffers: [], adText });
  const chosen = findChosenSlot(full, trailing, "2026-10-20", catalog.map((p) => p.name));
  const flow = analyzeFlow({ history: full, trailing, priceAsked: /quanto|valor|preco|custa/i.test(trailing.join(" ")), hasBooking, pastVisits: false, wanted, chosen, evaluationName: "Avaliação Estética", needOptions: understanding.objective.concerns.length ? understanding.families : undefined, unmappedOffer: understanding.unmappedAsked });
  const situation = resolveSituation({ history: full, trailing, now, todayIso: "2026-10-20", upcoming, pastVisits: 0, schedulingSignal: flow.schedulingSignal });
  const plan = planConduct(understanding, { flow, situation, evaluationName: "Avaliação Estética", hasBooking, clinicIsStore: false, trailing });
  situation.forbidSlotOffer = situation.forbidSlotOffer || plan.forbidSlotOffer;
  situation.forbidEvaluationOffer = situation.forbidEvaluationOffer || plan.forbidEvaluationOffer;
  const decision = decideTurn({ flow, situation, understanding, plan, wanted, chosenSlotLabel: chosen?.label ?? null });
  let move = flow.nextMove;
  const conduct = [plan.safety, situation.directive ? "" : plan.directive].filter(Boolean).join("\n");
  if (conduct) move = !situation.directive && plan.replacesFlowMove ? conduct : `${conduct}\n${move}`;
  if (situation.directive || plan.replacesFlowMove) { const ob = turnObligations(flow.reading, flow.intent); if (ob) move += `\nPRIORIDADE NESTE TURNO: ${ob}`; }
  return { wanted, flow, understanding, plan, situation, decision, move };
}
const sem = (move, re) => assert.ok(!re.test(move), `a jogada NAO pode conter ${re}`);
const FOTOS = "📷 3 foto(s) de resultado enviada(s): Botox";

// ------------------------------------------------------------------ A. ANARA
test("A. gostou das fotos (procedimento que exige avaliacao): reconhece o interesse e convida para a AVALIACAO com uma pergunta, sem presumir aceite nem horarios", () => {
  const r = decida({ history: [U("Quero saber de botox"), A("O Botox suaviza linhas de expressão. Quer ver alguns resultados?"), A(FOTOS)], trailing: ["Sim, gostei dos resultados apresentados."] });
  assert.equal(r.flow.reading.positiveReaction, true);
  assert.match(r.move, /CONTINUIDADE/);
  assert.match(r.move, /AVALIACAO/);
  assert.match(r.move, /UMA pergunta simples/);
  assert.match(r.move, /sem presumir aceite/);
  assert.match(r.move, /SEM prometer resultado igual/);
  assert.deepEqual(r.decision.allowedTools, [], "nenhum horario listado antes de ela aceitar");
  assert.ok(r.decision.forbidden.includes("listar_horarios"));
  assert.notEqual(r.decision.nextAction, "acolher_e_aguardar");
});

test("A2. gostou das fotos de procedimento que agenda DIRETO: o convite e ver horario PARA ELE (nunca avaliacao no lugar)", () => {
  const r = decida({ history: [U("Quero fazer lavieen"), A("O Lavieen melhora a textura. Quer ver resultados?"), A("📷 2 foto(s) de resultado enviada(s): Lavieen Full Face")], trailing: ["Amei os resultados!"] });
  assert.match(r.move, /VER UM HORARIO para esse procedimento/);
  sem(r.move, /agendar a AVALIACAO/);
  assert.ok(r.decision.forbidden.includes("oferecer_avaliacao"));
});

test("A3. o convite NAO e universal: quem vai pensar, recusou, ja esta agendada ou e paciente nao recebe convite", () => {
  const pensa = decida({ history: [U("Quero botox"), A("Quer ver resultados?"), A(FOTOS)], trailing: ["Gostei, mas vou pensar"] });
  sem(pensa.move, /CONTINUIDADE/);
  assert.equal(pensa.decision.stage, "pensando");
  const agendada = decida({ history: [U("Quero botox"), A(FOTOS)], trailing: ["Gostei dos resultados"], upcoming: [{ id: "1", dateIso: "2026-10-22", time: "10:00", label: "quinta, 22/10 às 10:00", procedure: "Avaliação Estética", professional: null, isEvaluation: true, patientConfirmed: false }] });
  sem(agendada.move, /CONTINUIDADE/);
  assert.equal(agendada.decision.stage, "agendado");
  const recusa = decida({ history: [U("Quero botox"), A("Quer que eu veja um horário para a sua avaliação?")], trailing: ["Não"] });
  sem(recusa.move, /CONTINUIDADE/);
  assert.equal(recusa.decision.stage, "recusou");
  assert.equal(reading.detectPositiveReaction("Não gostei do resultado"), false);
  assert.equal(reading.detectPositiveReaction("amei, mas está doendo muito"), false);
});

test("A4. rodape: 'estou a disposicao' no fim de lead interessado sai (o convite e feito pelo fecho do codigo)", () => {
  const t = stripGenericFarewell("Que bom que gostou! O Botox suaviza as linhas de expressão. Qualquer dúvida, estou à disposição.");
  assert.doesNotMatch(t, /disposi/i);
});

// ------------------------------------------------------------------ B. WILMA
test("B. pergunta de preco de procedimento que exige avaliacao: valor PRIMEIRO (so do cadastro), finalidade da avaliacao e convite; print nao e tabela", () => {
  const r = decida({ adText: "Remoção de micropigmentação", history: [U("Oi, vi o anúncio"), A("Oi! Sobre o que gostaria de saber?")], trailing: ["Qual o valor da despigmentação de sobrancelhas?"] });
  assert.equal(r.flow.reading.askedPrice, true);
  assert.match(r.move, /ELA PERGUNTOU O VALOR: responda o valor PRIMEIRO/);
  assert.match(r.move, /print ou conversa de outra pessoa NAO e tabela/);
  assert.match(r.move, /Nao esconda o preco/);
  assert.match(r.move, /para que serve a avaliacao/);
  assert.match(r.move, /qual dia\/periodo/);
  assert.deepEqual(r.decision.allowedTools, []);
  // o valor so passa se vier do cadastro (199,99) - um valor do print que o cadastro nao tem e barrado na saida
  const ctx = { conversationId: "c", tz: "America/Sao_Paulo", now, todayIso: "2026-10-20", situationKind: "default", forbidEvaluationOffer: false, forbidSlotOffer: true, request: { dates: [], weekdays: [], onlyWeekdays: false, times: [], notBefore: null, notAfter: null, period: null }, trusted: false, agenda: true, actions: { booked: false, cancelled: false, rescheduled: false, transferred: false }, evidence: { cancelledRecently: false, rescheduledRecently: false }, slots: { state: { times: new Set(), dates: new Set(), instants: [], offer: [], offerProcedure: null, booked: null }, toolUsed: false, strict: { times: new Set(), dates: new Set() }, loose: { times: new Set(), dates: new Set() }, toolDates: [] }, upcoming: [], complaintTexts: [], silentHandoff: false, approvedPrices: [199.99] };
  assert.equal(checkFinalReply("A sessão custa R$ 199,99.", ctx, { strict: false }).length, 0);
  assert.ok(checkFinalReply("A sessão custa R$ 149,90.", ctx, { strict: false }).some((p) => p.code === "price_unproven"));
});

// ------------------------------------------------------------------ C. KELLY
test("C. expectativa de poucas sessoes: sem promessa, avaliacao EXPLICITA; 'agendar a remocao' sem dizer avaliacao e barrado", () => {
  const r = decida({ history: [U("Quero remover uma tatuagem"), A("Temos remoção de tatuagem. Quer ver resultados?"), A("📷 4 foto(s) de resultado enviada(s): Remoção de Tatuagem")], trailing: ["Eu acredito que a minha não demore muitas sessões para resolver."] });
  assert.equal(r.flow.reading.resultExpectation, true);
  assert.match(r.move, /NAO valide nem contradiga/);
  assert.match(r.move, /PROFISSIONAL define isso na AVALIACAO/);
  assert.match(r.move, /nunca 'agendar a remocao/);
  assert.match(r.move, /CONTINUIDADE/);
  assert.equal(r.plan.gate.blocked.procedure, "Remoção de Tatuagem", "a sessao do procedimento nao e agendada");
  assert.equal(evaluationWordingViolation("Vamos agendar um horário para a remoção da sua tatuagem e, assim, poderemos avaliar.", "Remoção de Tatuagem"), true);
  assert.equal(evaluationWordingViolation("Vamos agendar a sua avaliação, para a profissional ver o seu caso. Qual período fica melhor?", "Remoção de Tatuagem"), false);
  assert.equal(reading.detectResultExpectation("Acho que resolve em uma sessão só"), true);
  assert.equal(reading.detectResultExpectation("Quantas sessões precisa?"), false);
  // a saida (entrega) tambem confere, inclusive o que a revisao reescrever
  const ctx = { conversationId: "c", tz: "America/Sao_Paulo", now, todayIso: "2026-10-20", situationKind: "default", forbidEvaluationOffer: false, forbidSlotOffer: true, request: { dates: [], weekdays: [], onlyWeekdays: false, times: [], notBefore: null, notAfter: null, period: null }, trusted: false, agenda: true, actions: { booked: false, cancelled: false, rescheduled: false, transferred: false }, evidence: { cancelledRecently: false, rescheduledRecently: false }, slots: { state: { times: new Set(), dates: new Set(), instants: [], offer: [], offerProcedure: null, booked: null }, toolUsed: false, strict: { times: new Set(), dates: new Set() }, loose: { times: new Set(), dates: new Set() }, toolDates: [] }, upcoming: [], complaintTexts: [], silentHandoff: false, evaluationOnly: "Remoção de Tatuagem" };
  const problems = checkFinalReply("Vamos agendar um horário para a remoção da sua tatuagem?", ctx, { strict: false });
  assert.ok(problems.some((p) => p.code === "eval_wording"));
  assert.match(safeReplyFor(ctx, problems), /\*avaliação\*/);
});

// ------------------------------------------------------------------ D/E/F. NATHALIA
const HIST_LAVIEEN = [U("Oi, queria saber do Lavieen"), A("O Lavieen melhora a textura da pele. Qual região você quer tratar?"), U("Costas. Só consigo depois das 18h30, saio do trabalho nesse horário"), A("Entendi! O que você gostaria de melhorar nas costas?")];

test("D. Lavieen em discussao + 'qual seria o procedimento? demora quanto tempo?': mantem Lavieen e manda responder AS DUAS perguntas com a duracao do cadastro dele", () => {
  const r = decida({ history: HIST_LAVIEEN, trailing: ["E qual seria o procedimento? Demora quanto tempo?"] });
  assert.equal(r.decision.procedure.chosen, "Lavieen Full Face");
  assert.ok(r.decision.forbidden.includes("trocar_o_procedimento_escolhido"));
  assert.equal(r.flow.reading.asksDuration, true);
  assert.equal(r.flow.reading.asksWhichProcedure, true);
  assert.match(r.move, /RESPONDA TODAS/);
  assert.match(r.move, /responda AS DUAS coisas/);
  assert.match(r.move, /sem declarar 'o mais indicado para voce'/);
  assert.match(r.move, /NAO troque por outro procedimento/);
  // fato de duracao: do cadastro do Lavieen (texto aprovado), nunca o da carboxiterapia (15 min)
  const lav = CATALOG.find((p) => p.name === "Lavieen Full Face");
  const f = durationFactOf(lav, { clinicUsesCe: true });
  assert.equal(f.source, "texto_aprovado");
  assert.match(f.text, /40 minutos/);
  const b = durationBriefing(lav, CATALOG.find((p) => /Avalia/.test(p.name)), { clinicUsesCe: true, evaluationFirst: false });
  assert.match(b, /SESSAO de "Lavieen Full Face": 40 minutos/);
  assert.match(b, /AVALIACAO/);
  assert.doesNotMatch(b, /15 minutos/);
});

test("D2. duracao: sem texto aprovado e clinica com CE, so confiavel se o procedimento esta vinculado ao CE; senao 'confirmar com a equipe', nunca a de outro servico; sem CE a clinica digitou", () => {
  const semCe = { name: "Peeling X", durationMin: 60, description: "Renova a pele." };
  assert.equal(durationFactOf(semCe, { clinicUsesCe: true }).source, "nenhuma");
  assert.match(durationBriefing(semCe, null, { clinicUsesCe: true, evaluationFirst: false }), /confirma com a equipe.*NUNCA use a duracao de outro procedimento/);
  assert.equal(durationFactOf({ ...semCe, ceId: 9 }, { clinicUsesCe: true }).source, "reserva_ce");
  assert.match(durationFactOf({ ...semCe, ceId: 9 }, { clinicUsesCe: true }).text, /nao e necessariamente o tempo de aplicacao/);
  assert.equal(durationFactOf(semCe, { clinicUsesCe: false }).source, "reserva_cadastro");
  assert.match(durationBriefing(null, null, { clinicUsesCe: true, evaluationFirst: false }), /nao ha procedimento identificado/);
});

test("E. memoria/fala antiga da Alice sobre Carboxiterapia nao troca o Lavieen; o assunto em discussao entra SEMPRE no foco do prompt", () => {
  const r = decida({ history: [...HIST_LAVIEEN, A("A Carboxiterapia seria o procedimento mais indicado para as costas.")], trailing: ["E qual seria o procedimento? Demora quanto tempo?"] });
  assert.equal(r.decision.procedure.chosen, "Lavieen Full Face", "texto anterior da propria Alice nao vira evidencia");
  const procs = CATALOG.map((p, i) => ({ ...p, id: String(i) }));
  const sem = selectFocusProcedures(procs, ["Costas", "A Carboxiterapia seria o procedimento mais indicado para as costas", "E qual seria o procedimento?"], 6, []);
  const com = selectFocusProcedures(procs, ["Costas", "A Carboxiterapia seria o procedimento mais indicado para as costas", "E qual seria o procedimento?"], 6, ["Lavieen Full Face"]);
  assert.equal(com[0].name, "Lavieen Full Face", "fixado na frente");
  assert.ok(com.length <= 7);
  assert.ok(sem.some((p) => p.name === "Carboxiterapia"));
});

test("F. mudanca EXPLICITA acompanha; mencao, pergunta e comparacao nao trocam o procedimento; ambiguidade e registrada", () => {
  const base = [U("Oi, queria saber do Lavieen"), A("O Lavieen melhora a textura. Quer saber mais?")];
  const troca = decida({ history: base, trailing: ["Na verdade quero fazer a carboxiterapia"] });
  assert.equal(troca.decision.procedure.chosen, "Carboxiterapia");
  const pergunta = decida({ history: base, trailing: ["O que é carboxiterapia?"] });
  assert.equal(pergunta.decision.procedure.chosen, "Lavieen Full Face");
  assert.deepEqual(pergunta.decision.procedure.mentioned, ["Carboxiterapia"]);
  assert.match(pergunta.move, /MENCIONAR NAO E ESCOLHER/);
  const comparacao = decida({ history: base, trailing: ["Qual a diferença entre o lavieen e a carboxiterapia?"] });
  assert.equal(comparacao.decision.procedure.chosen, "Lavieen Full Face");
  const negou = decida({ history: base, trailing: ["Não quero carboxiterapia"] });
  assert.equal(negou.decision.procedure.chosen, "Lavieen Full Face");
  const jaFez = decida({ history: base, trailing: ["Minha amiga fez carboxiterapia e amou"] });
  assert.equal(jaFez.decision.procedure.chosen, "Lavieen Full Face");
  // sem ancora, quem cita um procedimento pela primeira vez o escolhe (comportamento anterior)
  const primeira = decida({ history: [U("Oi"), A("Oi! Em que posso ajudar?")], trailing: ["Quero fazer carboxiterapia"] });
  assert.equal(primeira.decision.procedure.chosen, "Carboxiterapia");
});

// ------------------------------------------------------------------ G. restricao de horario
test("G. 'so consigo depois das 18h30' / 'saio do trabalho as 18h30': 13h30 NAO e opcao compativel; 18h30 e", () => {
  for (const frase of ["Só consigo depois das 18h30, saio do trabalho nesse horário", "Eu saio do trabalho às 18h30", "Só posso a partir das 18:30"]) {
    const req = parseSlotRequest([frase], "2026-10-20");
    assert.equal(req.notBefore, "18:30", frase);
    assert.equal(slotRespects(req, "2026-10-21", "13:30", 45), false);
    assert.equal(slotRespects(req, "2026-10-21", "18:30", 45), true);
  }
  const req = parseSlotRequest(["Só consigo depois das 18h30"], "2026-10-20");
  assert.ok(requestViolation(req, [{ date: "2026-10-21", time: "13:30" }], [], "2026-10-20"), "a oferta de 13h30 e recusada e o modelo manda consultar de novo com o limite");
  assert.equal(requestViolation(req, [{ date: "2026-10-21", time: "18:30" }], ["2026-10-21"], "2026-10-20"), null);
  const r = decida({ history: HIST_LAVIEEN, trailing: ["Pode ser amanhã?"] });
  assert.match(r.situation.briefing.join("\n"), /so depois das 18:30/);
});

// ------------------------------------------------------------------ H/J. ENDOLASER
test("H/J. Endolaser (explicitamente nao realizado): nao oferece nem cota; preserva OLHEIRAS sem herdar a regiao do abdomen", () => {
  const r = decida({ notOffered: ["Endolaser", "Endo laser"], history: [U("Oi"), A("Oi! Em que posso ajudar?")], trailing: ["Queria saber sobre endolaser no abdômen e também tenho olheiras"] });
  assert.equal(r.understanding.notOfferedAsked, "Endolaser");
  assert.ok(r.decision.forbidden.includes("dizer_que_a_clinica_faz:Endolaser"));
  assert.match(r.move, /NAO realiza/);
  assert.match(r.move, /NUNCA diga que a clinica faz "Endolaser"/);
  assert.match(r.move, /OUTROS interesses dela/);
  assert.deepEqual(r.decision.need.concerns, ["olheiras"]);
  assert.ok(!r.decision.need.regions.includes("abdomen"), "a regiao do servico que nao existe nao vira regiao da outra queixa");
  assert.equal(withoutNotOffered("Queria endolaser no abdômen e também tenho olheiras", ["Endolaser"]).includes("olheiras"), true);
  assert.equal(withoutNotOffered("Queria endolaser no abdômen e também tenho olheiras", ["Endolaser"]).includes("abdômen"), false);
  // a saida: oferecer endolaser como opcao e barrado, em qualquer caminho (inclusive o que a revisao reescrever)
  const ctx = { conversationId: "c", tz: "America/Sao_Paulo", now, todayIso: "2026-10-20", situationKind: "default", forbidEvaluationOffer: false, forbidSlotOffer: true, request: { dates: [], weekdays: [], onlyWeekdays: false, times: [], notBefore: null, notAfter: null, period: null }, trusted: false, agenda: true, actions: { booked: false, cancelled: false, rescheduled: false, transferred: false }, evidence: { cancelledRecently: false, rescheduledRecently: false }, slots: { state: { times: new Set(), dates: new Set(), instants: [], offer: [], offerProcedure: null, booked: null }, toolUsed: false, strict: { times: new Set(), dates: new Set() }, loose: { times: new Set(), dates: new Set() }, toolDates: [] }, upcoming: [], complaintTexts: [], silentHandoff: false, notOffered: ["Endolaser", "Endo laser"] };
  assert.ok(checkFinalReply("O Endolaser é uma excelente opção para o abdômen.", ctx, { strict: false }).some((p) => p.code === "not_offered"));
  assert.equal(checkFinalReply("Hoje a clínica não realiza Endolaser.", ctx, { strict: false }).length, 0, "negar nao e oferecer");
  assert.ok(promisesTeamFollowUp("Vou confirmar com a equipe e te enviar os valores do Endolaser."));
});

test("I. servico desconhecido (nem no cadastro nem na lista de nao realizados): a decisao NAO afirma indisponibilidade", () => {
  const r = decida({ notOffered: ["Endolaser"], history: [U("Oi"), A("Oi! Em que posso ajudar?")], trailing: ["Vocês fazem ultraformer?"] });
  assert.equal(r.understanding.notOfferedAsked, null);
  assert.ok(!r.decision.forbidden.some((f) => f.startsWith("dizer_que_a_clinica_faz")), "ausencia na busca nao prova que a clinica nao faz");
  assert.equal(r.plan.safety, "");
});

// ------------------------------------------------------------------ K/L. TAISE
test("K/L. 'refrescancia': termo ambiguo e RESTRICAO; nao vira fato do produto; pergunta curta; pendencia real", () => {
  const r = decida({ history: [U("Qual marca vocês usam na limpeza de pele?"), A("Utilizamos Cosmobeauty.")], trailing: ["Porque ele também tem refrescancia eu não uso produtos com refrescancia."] });
  const pc = r.flow.reading.productConcern;
  assert.equal(pc.ambiguous, true);
  assert.equal(pc.restriction, true);
  assert.match(r.move, /AMBIGUO/);
  assert.match(r.move, /NAO afirme marca, composicao/);
  assert.match(r.move, /Fala dela NAO e fato sobre o produto da clinica/);
  assert.match(r.move, /nao presuma alergia/);
  assert.match(r.move, /NAO garanta adaptacao/);
  assert.match(r.move, /chame transfer_to_human/);
  // a afirmacao inventada e detectada e barrada; o que o cadastro sustenta passa
  const bad = "O produto utilizado na Limpeza de Pele tem refrescância, mas podemos personalizar.";
  assert.equal(unsupportedProductClaims(bad, "Limpeza de pele profunda. Produtos hipoalergenicos.", splitSentences).length, 1);
  assert.equal(unsupportedProductClaims(bad, "O gel da limpeza tem efeito refrescante e leve perfume.", splitSentences).length, 0, "com fonte cadastrada pode");
  assert.equal(unsupportedProductClaims("Qual produto você usa hoje? Ele tem cheiro forte?", "", splitSentences).length, 0, "pergunta nao e afirmacao");
  assert.deepEqual(approvedProductFamilies("Gel com mentol e perfume suave"), ["fragrancia", "mentol"]);
  assert.match(clarifyProductTerm("refrescância"), /sensação de frescor\/gelado.*perfume\/cheiro/);
  // entrega: a mesma checagem no contexto final
  const ctx = { conversationId: "c", tz: "America/Sao_Paulo", now, todayIso: "2026-10-20", situationKind: "default", forbidEvaluationOffer: false, forbidSlotOffer: true, request: { dates: [], weekdays: [], onlyWeekdays: false, times: [], notBefore: null, notAfter: null, period: null }, trusted: false, agenda: true, actions: { booked: false, cancelled: false, rescheduled: false, transferred: false }, evidence: { cancelledRecently: false, rescheduledRecently: false }, slots: { state: { times: new Set(), dates: new Set(), instants: [], offer: [], offerProcedure: null, booked: null }, toolUsed: false, strict: { times: new Set(), dates: new Set() }, loose: { times: new Set(), dates: new Set() }, toolDates: [] }, upcoming: [], complaintTexts: [], silentHandoff: false, approvedProductFamilies: [] };
  const problems = checkFinalReply(bad, ctx, { strict: false });
  assert.ok(problems.some((p) => p.code === "product_unproven"));
  assert.match(safeReplyFor(ctx, problems), /confirmar com a equipe/);
  assert.equal(sanitizeReply(bad + " A profissional avalia o seu tipo de pele na avaliação e orienta a escolha dos produtos.", problems)?.includes("refrescância"), false);
});

test("K2. promessa de retorno da equipe sem acao e detectada (vira pendencia real na rodada); 'ja volto' continua sendo promessa quebrada", () => {
  assert.equal(promisesTeamFollowUp("Vou verificar com a equipe e retorno com você."), true);
  assert.equal(promisesTeamFollowUp("A equipe vai confirmar e te responder em breve."), true);
  assert.equal(promisesTeamFollowUp("Quer que eu veja um horário para a sua avaliação?"), false);
  assert.equal(promisesTeamFollowUp("Qualquer coisa é só me chamar."), false);
  assert.equal(announcesAction("Um instante, vou verificar."), true);
});

// ------------------------------------------------------------------ M/N/O
test("M. recusa e pedido de tempo: nao insiste (nenhuma jogada de convite)", () => {
  const r = decida({ history: [U("Quero saber de botox"), A("Quer que eu veja um horário para a sua avaliação?")], trailing: ["Vou pensar com calma, obrigada"] });
  assert.equal(r.decision.stage, "pensando");
  sem(r.move, /CONTINUIDADE/);
  assert.match(r.move, /NAO ofereca avaliacao/);
});

test("N. ja agendada: nao reinicia a venda (sem descoberta, sem convite)", () => {
  const r = decida({ history: [U("Quero botox"), A("Agendado!")], trailing: ["Qual o valor?"], upcoming: [{ id: "1", dateIso: "2026-10-22", time: "10:00", label: "quinta, 22/10 às 10:00", procedure: "Avaliação Estética", professional: null, isEvaluation: true, patientConfirmed: false }] });
  assert.equal(r.decision.stage, "agendado");
  sem(r.move, /CONTINUIDADE/);
  assert.match(r.move, /NAO ofereca avaliacao nem outro horario/);
});

// ------------------------------------------------------------------ U. montagem de texto
test("U. 'AvaliaçãoAvaliação': a repeticao colada do nome do procedimento sai; nomes legitimos e repeticao com espaco ficam", () => {
  assert.equal(collapseDuplicatedProcedureWord("Procedimento: AvaliaçãoAvaliação", "Avaliação"), "Procedimento: Avaliação");
  assert.equal(collapseDuplicatedProcedureWord("Procedimento: AvaliaçãoAvaliação Estética", "Avaliação Estética"), "Procedimento: Avaliação Estética");
  assert.equal(collapseDuplicatedProcedureWord("Avaliação ou Avaliação", "Avaliação"), "Avaliação ou Avaliação", "com espaco/pontuacao nao mexe");
  assert.equal(collapseDuplicatedProcedureWord("Botox", "Botox"), "Botox");
  assert.equal(collapseDuplicatedProcedureWord("seu atendimento", "seu atendimento"), "seu atendimento");
});

// ------------------------------------------------------------------ trava de relevancia x procedimento ESCOLHIDO (causa do caso Nathalia)
test("relevancia: citar o procedimento que a PESSOA escolheu (mesmo com queixa so de regiao 'costas') nao e indicacao e nao apaga a frase; indicar OUTRO para a regiao continua sendo barrado", async () => {
  const { findRelevanceMismatch } = await import("../dist/ai/relevance.js");
  const procs = CATALOG.map((p) => ({ name: p.name, aliases: p.aliases, goals: p.goals, benefits: p.benefits, description: p.description }));
  const reply = "O Lavieen Full Face é feito em uma sessão de cerca de 40 minutos.";
  assert.equal(findRelevanceMismatch({ complaintTexts: ["Costas. So consigo depois das 18h30"], reply, procedures: procs, allowed: ["Lavieen Full Face"] }), null);
  const sem = findRelevanceMismatch({ complaintTexts: ["Costas. So consigo depois das 18h30"], reply, procedures: procs, allowed: [] });
  assert.equal(sem?.procedure, "Lavieen Full Face", "sem a escolha dela, a trava continua valendo");
});
