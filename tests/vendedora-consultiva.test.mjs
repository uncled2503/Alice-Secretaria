// VENDEDORA CONSULTIVA: conversas de VARIOS TURNOS lidas pelo codigo (fluxo de venda + situacao + conducao + leitura do turno + contrato de decisao), sem banco e sem OpenAI.
// As verificacoes sao sobre a DECISAO (etapa, proxima acao, ferramentas permitidas, o que e proibido, fatos preservados, perguntas pendentes) e sobre o que a "jogada" manda
// FAZER ou NAO FAZER (nao so a presenca de uma frase): o que sai para a pessoa e responsabilidade do modelo, mas o que ele PODE fazer e decidido aqui.
import assert from "node:assert/strict";
import test from "node:test";

const { analyzeFlow, turnObligations } = await import("../dist/ai/salesFlow.js");
const { identifyWanted, findChosenSlot } = await import("../dist/ai/bookingIntent.js");
const { understandConversation, planConduct, gateDecision } = await import("../dist/ai/conduct.js");
const { resolveSituation } = await import("../dist/ai/situation.js");
const { decideTurn, turnDecisionLog } = await import("../dist/ai/turnDecision.js");
const reading = await import("../dist/ai/turnReading.js");

const CATALOG = [
  { name: "Hipro", aliases: "hipro", goals: "firmeza,flacidez", benefits: "melhora a firmeza da pele do rosto", description: "Tecnologia para flacidez e firmeza.", bookingMode: "direct" },
  { name: "Enzima GL Abdomen", aliases: "enzima abdomen", goals: "gordura,gordura localizada,barriga", benefits: "reduz gordura localizada no abdomen", description: "Reducao de gordura localizada.", bookingMode: "direct" },
  { name: "Clareamento de Virilha", aliases: "clareamento virilha", goals: "clareamento,manchas", benefits: "clareia a regiao", description: "Clareamento da regiao intima e virilha.", bookingMode: "evaluation" },
  { name: "Limpeza de Pele", aliases: "limpeza", goals: "acne,poros,limpeza", benefits: "limpeza profunda", description: "Limpeza de pele profunda.", bookingMode: null },
  { name: "Avaliação Estética", aliases: "avaliacao", goals: "", benefits: "", description: "Avaliacao gratuita.", bookingMode: "direct" },
];
const now = new Date("2026-10-20T15:00:00Z");
const at = (i) => new Date(now.getTime() - (100 - i) * 60_000);
const U = (c) => ({ role: "user", content: c });
const A = (c) => ({ role: "assistant", content: c });
const BOOKING = [{ id: "1", dateIso: "2026-10-22", time: "10:00", label: "quinta, 22/10 às 10:00", procedure: "Hipro", professional: null, isEvaluation: false, patientConfirmed: false }];

function decida({ history, trailing, upcoming = [], unmappedOffers = [], adText = "", notOffered = [], awaitingName = false, strictBooking = true }) {
  const full = [...history.map((m, i) => ({ ...m, createdAt: at(i) })), ...trailing.map((t, i) => ({ role: "user", content: t, createdAt: at(90 + i) }))];
  const hasBooking = upcoming.length > 0;
  const wanted = identifyWanted(CATALOG, [adText, ...full.filter((m) => m.role === "user").map((m) => m.content)].filter(Boolean), adText ? 1 : 0);
  const understanding = understandConversation({ history: full, now, wanted, catalog: CATALOG, strictBooking, notOffered, unmappedOffers, adText });
  const chosen = findChosenSlot(full, trailing, "2026-10-20", CATALOG.map((p) => p.name));
  const flow = analyzeFlow({
    history: full, trailing, priceAsked: /quanto|valor|preco|custa/i.test(trailing.join(" ")), hasBooking, pastVisits: false, wanted, chosen, chosenFullName: awaitingName ? trailing[0] : null,
    evaluationName: "Avaliação Estética", awaitingName, unmappedOffer: understanding.unmappedAsked, needOptions: understanding.objective.concerns.length ? understanding.families : undefined,
  });
  const situation = resolveSituation({ history: full, trailing, now, todayIso: "2026-10-20", upcoming, pastVisits: 0, schedulingSignal: flow.schedulingSignal });
  const plan = planConduct(understanding, { flow, situation, evaluationName: "Avaliação Estética", hasBooking, clinicIsStore: false, trailing });
  situation.forbidSlotOffer = situation.forbidSlotOffer || plan.forbidSlotOffer;
  situation.forbidEvaluationOffer = situation.forbidEvaluationOffer || plan.forbidEvaluationOffer;
  const decision = decideTurn({ flow, situation, understanding, plan, wanted, nextBookingLabel: upcoming[0]?.label ?? null, chosenSlotLabel: chosen?.label ?? null });
  // a jogada que o modelo recebe (mesma composicao de alice.ts)
  let move = flow.nextMove;
  const conduct = [plan.safety, situation.directive ? "" : plan.directive].filter(Boolean).join("\n");
  if (conduct) move = !situation.directive && plan.replacesFlowMove ? conduct : `${conduct}\n${move}`;
  if (situation.directive || plan.replacesFlowMove) { const ob = turnObligations(flow.reading, flow.intent); if (ob) move += `\nPRIORIDADE NESTE TURNO: ${ob}`; }
  return { flow, situation, understanding, plan, decision, move, chosen };
}
const sem = (move, re) => assert.ok(!re.test(move), `a jogada NAO pode conter ${re}: ${move.slice(0, 300)}`);

// ------------------------------------------------------------------ 1. lead de anuncio pergunta o preco
test("lead de anuncio pergunta o preco: responde o valor pela regra da clinica, sem abrir agenda e sem transferir", () => {
  const r = decida({ adText: "Enzima GL Abdomen", history: [U("Vi o anuncio"), A("Oi! Que bom que voce veio. Posso te ajudar?")], trailing: ["Quanto custa a enzima?"] });
  assert.equal(r.flow.intent, "price");
  assert.equal(r.decision.stage, "solucao");
  assert.deepEqual(r.decision.allowedTools, []);
  assert.ok(r.decision.forbidden.includes("listar_horarios"));
  assert.equal(r.decision.procedure.chosen, "Enzima GL Abdomen");
  assert.equal(r.plan.handoffForced, false);
});

// ------------------------------------------------------------------ 2. escolheu procedimento
test("escolheu o procedimento: trava nele, libera a agenda dele e proibe avaliacao e troca", () => {
  const r = decida({ history: [U("Oi"), A("Oi! Em que posso ajudar?")], trailing: ["Quero fazer o Hipro"] });
  assert.equal(r.decision.procedure.chosen, "Hipro");
  assert.match(r.decision.procedure.mode, /^direct/);
  assert.ok(r.decision.allowedTools.includes("check_availability") && r.decision.allowedTools.includes("book_appointment"));
  assert.ok(r.decision.forbidden.includes("oferecer_avaliacao") && r.decision.forbidden.includes("trocar_o_procedimento_escolhido"));
  assert.equal(r.decision.nextAction, "oferecer_horarios");
  assert.equal(gateDecision(r.plan.gate, "check_availability", "Avaliação Estética").allow, false, "a ferramenta nao agenda avaliacao no lugar");
  assert.equal(gateDecision(r.plan.gate, "check_availability", "Hipro").allow, true);
});

// ------------------------------------------------------------------ 3/4. regiao, queixa, tom de pele
test("so a regiao ('interno de coxa'): nao indica procedimento, nao abre agenda, descobre a queixa", () => {
  const r = decida({ history: [U("Oi"), A("Oi! Sobre o que gostaria de saber?")], trailing: ["Interno de coxa"] });
  assert.equal(r.decision.need.regionOnly, true);
  assert.deepEqual(r.decision.allowedTools, []);
  assert.ok(r.decision.forbidden.includes("indicar_procedimento_sem_queixa_aprovada") && r.decision.forbidden.includes("listar_horarios"));
  assert.equal(r.decision.nextAction, "descobrir");
  assert.match(r.move, /NAO sugira procedimento/);
});

test("'sou morena e quero tratar gordura': a queixa e gordura; o tom de pele e informacao, nao leva a clareamento", () => {
  const r = decida({ history: [U("Oi"), A("Oi! O que gostaria de tratar?")], trailing: ["Sou morena e quero tratar gordura"] });
  assert.deepEqual(r.decision.need.concerns, ["gordura"]);
  assert.ok(!r.decision.need.concerns.includes("pigmentacao"));
  assert.deepEqual(r.decision.allowedTools, []);
  assert.match(r.move, /tom de pele/);
});

test("'nao quero tratar gordura, quero clarear' CORRIGE o objetivo: mantem a regiao, nao e recusa nem 'vou pensar', nao abre agenda sozinho", () => {
  const r = decida({ history: [U("Quero tratar gordura na virilha"), A("Entendi! Me conta mais.")], trailing: ["Não quero tratar gordura, quero clarear"] });
  assert.equal(r.decision.goalCorrection, true);
  assert.ok(!["pensando", "recusou"].includes(r.decision.stage), r.decision.stage);
  assert.ok(r.decision.need.negated.includes("gordura"));
  assert.ok(r.decision.need.concerns.includes("pigmentacao"));
  assert.deepEqual(r.decision.need.regions, ["virilha"], "a regiao ja dita continua valendo");
  assert.notEqual(r.flow.intent, "hesitate");
  assert.equal(r.flow.schedulingSignal, false, "corrigir o objetivo nao e pedir horario");
});

// ------------------------------------------------------------------ 5. resposta curta em relacao a pergunta anterior
test("'nao' depois de 'ja fez antes?' = nunca fez; nao e recusa, nao abre agenda", () => {
  const r = decida({ history: [U("Oi, queria saber do Hipro"), A("Oi! O Hipro é para firmeza do rosto. Você já fez algum procedimento parecido antes?")], trailing: ["Não"] });
  assert.equal(r.decision.answeringPrevious.meaning, "experience_none");
  assert.ok(!["hesitate", "refuse", "decline"].includes(r.flow.intent), r.flow.intent);
  assert.deepEqual(r.decision.allowedTools, []);
  assert.equal(r.decision.nextAction, "explicar");
  assert.match(r.move, /NUNCA fez/);
  sem(r.move, /ofereca (os )?horarios agora/i);
});

test("'sim' a 'quer entender como funciona?' aceita a EXPLICACAO: nao e agendamento", () => {
  const r = decida({ history: [U("Queria saber do Hipro"), A("O Hipro trata flacidez. Quer que eu te explique como funciona?")], trailing: ["Sim"] });
  assert.equal(r.decision.answeringPrevious.meaning, "accepts_info");
  assert.equal(r.flow.schedulingSignal, false);
  assert.ok(r.decision.forbidden.includes("listar_horarios"));
  assert.equal(r.decision.nextAction, "explicar");
  assert.match(r.move, /NAO e pedido de agendamento/);
});

test("'sim' a 'quer que eu veja um horario?' ACEITA o agendamento (a mesma palavra, outra pergunta anterior)", () => {
  const r = decida({ history: [U("Queria saber do Hipro"), A("O Hipro trata flacidez. Quer que eu veja um horário pra você?")], trailing: ["Sim"] });
  assert.equal(r.flow.schedulingSignal, true);
  assert.ok(r.decision.allowedTools.includes("check_availability"));
});

test("'amanha nao, quinta pode' depois da oferta de horarios continua o agendamento (nao e recusa)", () => {
  const r = decida({ history: [U("Quero fazer o Hipro"), A("Tenho amanhã às 10h ou 14h. Qual prefere?")], trailing: ["Amanhã não, quinta pode"] });
  assert.equal(r.flow.intent, "schedule");
  assert.ok(r.decision.allowedTools.includes("check_availability"));
});

test("o nome completo que a Alice pediu CONCLUI o agendamento em andamento (nao recomeca a venda)", () => {
  const r = decida({
    history: [U("Quero fazer o Hipro amanhã"), A("Tenho amanhã às 10h ou 14h. Qual prefere?"), U("10h"), A("Perfeito! Qual é o seu nome completo para eu confirmar?")],
    trailing: ["Maria Souza Lima"], awaitingName: true,
  });
  assert.equal(r.flow.intent, "schedule");
  assert.ok(r.decision.allowedTools.includes("book_appointment"));
  assert.match(r.move, /CONTINUACAO/);
  assert.match(r.move, /book_appointment/);
});

test("referencia a uma opcao anterior ('a de 14h'): reconhece o horario escolhido e vai agendar", () => {
  const r = decida({ history: [U("Quero fazer o Hipro"), A("Tenho estes horários: 21/10 às 10:00 ou 21/10 às 14:00. Qual prefere?")], trailing: ["A de 14h"] });
  assert.ok(r.chosen, "reconheceu o horario escolhido");
  assert.equal(r.decision.nextAction, "agendar");
});

// ------------------------------------------------------------------ 6. objecoes
for (const [fala, tipo, deve] of [
  ["Achei caro", "price", /NAO invente desconto/],
  ["Tenho medo de doer", "fear", /prometer 'sem dor'/],
  ["Moro longe", "distance", /nao invente atendimento remoto/],
  ["Estou sem tempo", "time", /duracao e a frequencia que o cadastro/],
  ["Preciso falar com meu marido antes", "third_party", /sem pressao/],
  ["Vi em outra clínica mais barato", "compare", /Nao fale mal de ninguem/],
]) {
  test(`objecao '${fala}': responde o impedimento real com informacao aprovada, sem inventar nem pressionar`, () => {
    const r = decida({ history: [U("Quero saber da enzima"), A("A enzima reduz gordura localizada no abdômen.")], trailing: [fala] });
    assert.equal(r.decision.objection, tipo);
    assert.match(r.move, deve);
    assert.ok(r.decision.forbidden.includes("inventar_urgencia_ou_condicao"));
    assert.deepEqual(r.decision.allowedTools, [], "objecao nao abre agenda");
    sem(r.move, /ultimas vagas|so hoje|corre/i);
  });
}

test("'achei caro' nao transfere por conta propria; PEDIR desconto transfere e proibe prometer", () => {
  const caro = decida({ history: [U("Quanto custa a enzima?"), A("A enzima tem o valor apresentado na avaliação.")], trailing: ["Achei caro"] });
  assert.equal(caro.plan.handoffForced, false);
  assert.match(caro.move, /NAO transfira so por ela achar caro/);
  const desc = decida({ history: [U("Quanto custa a enzima?"), A("A enzima tem o valor apresentado na avaliação.")], trailing: ["Tem desconto se eu fechar hoje?"] });
  assert.ok(desc.decision.forbidden.includes("prometer_desconto"));
  assert.match(desc.move, /transfer_to_human/);
  assert.match(desc.move, /NAO prometa, invente nem insinue desconto/);
});

// ------------------------------------------------------------------ 7. "vou pensar" + pergunta; varios assuntos; obrigada + pergunta
test("'vou pensar, mas quanto tempo dura?': respeita o 'vou pensar' E responde a pergunta (antes ficava so o acolhimento)", () => {
  const r = decida({ history: [U("Queria saber do Hipro"), A("O Hipro trata flacidez. Quer ver um horário para a avaliação?")], trailing: ["Vou pensar, mas quanto tempo dura?"] });
  assert.equal(r.flow.intent, "hesitate");
  assert.equal(r.decision.unanswered.length, 1);
  assert.match(r.decision.unanswered[0], /quanto tempo dura/i);
  assert.equal(r.decision.nextAction, "responder_perguntas");
  assert.match(r.move, /ELA PERGUNTOU/);
  assert.match(r.move, /RESPONDA ESSA pergunta/);
  assert.ok(r.decision.allowedTools.includes("schedule_recontact") && !r.decision.allowedTools.includes("check_availability"));
  assert.ok(r.decision.forbidden.includes("listar_horarios"));
});

test("varios assuntos numa mensagem: todas as perguntas ficam pendentes e precisam de resposta", () => {
  const r = decida({ history: [U("Quero saber da enzima"), A("A enzima reduz gordura localizada.")], trailing: ["Quanto custa e qual o endereço? E tem estacionamento?"] });
  assert.ok(r.decision.unanswered.length >= 2, JSON.stringify(r.decision.unanswered));
  assert.match(r.move, /VARIAS COISAS/);
  assert.match(r.move, /RESPONDA TODAS/);
});

test("'obrigada, mas qual e o endereco?' de quem ja agendou: responde o endereco e para (sem venda nova)", () => {
  const r = decida({ history: [U("Quero o Hipro"), A("Perfeito, ficou agendado para quinta às 10h!"), U("ok")], trailing: ["Obrigada, mas qual é o endereço?"], upcoming: BOOKING });
  assert.equal(r.flow.intent, "booked");
  assert.equal(r.decision.stage, "agendado");
  assert.deepEqual(r.decision.allowedTools, []);
  assert.ok(r.decision.unanswered.some((q) => /endere/i.test(q)));
  assert.match(r.move, /Responda SO o que ela perguntou/);
  assert.match(r.move, /ELA PERGUNTOU/);
  sem(r.move, /pergunte o que ela gostaria/i);
});

// ------------------------------------------------------------------ 8. agenda existente x novo procedimento; cancelar/remarcar
test("'ja tenho horario, quero marcar outro procedimento': o horario existente nao bloqueia o novo pedido", () => {
  const r = decida({ history: [U("Oi"), A("Oi! Como posso ajudar?")], trailing: ["Já tenho horário, mas quero marcar outro procedimento: a enzima da barriga"], upcoming: BOOKING });
  assert.equal(r.flow.intent, "schedule");
  assert.equal(r.decision.procedure.chosen, "Enzima GL Abdomen");
  assert.ok(r.decision.allowedTools.includes("check_availability"));
  assert.ok(r.decision.knownFacts.some((f) => f.key === "agendamento_futuro" && f.source === "agenda"));
});

test("cancelar e remarcar sao decididos pela situacao (agenda real), nao pela jogada de venda", () => {
  const cancel = decida({ history: [U("Oi"), A("Oi!")], trailing: ["Preciso cancelar meu horário"], upcoming: BOOKING });
  assert.equal(cancel.situation.kind, "cancel");
  assert.match(cancel.decision.subject, /cancel/);
  const resched = decida({ history: [U("Oi"), A("Oi!")], trailing: ["Preciso remarcar para sexta"], upcoming: BOOKING });
  assert.equal(resched.situation.kind, "reschedule");
});

// ------------------------------------------------------------------ 9. oferta sem cadastro / servico que a clinica nao faz / procedimento sem regra
test("oferta anunciada SEM cadastro nao vira avaliacao nem outro procedimento: vai para a equipe", () => {
  const r = decida({ history: [U("Vi o anuncio do Protocolo do Olhar"), A("Que legal! Quer que eu veja um horário?"), U("Quero sim, amanhã às 10h")], trailing: ["Pode ser amanhã às 10h"], unmappedOffers: ["Protocolo do Olhar"] });
  assert.equal(r.decision.procedure.unmappedOffer, "Protocolo do Olhar");
  assert.ok(r.decision.forbidden.includes("agendar_avaliacao_no_lugar_da_oferta_sem_cadastro"));
  assert.equal(r.decision.nextAction, "passar_para_equipe");
  assert.equal(r.plan.handoffForced, true);
  assert.deepEqual(r.decision.allowedTools, []);
  sem(r.flow.nextMove, /NESSE MESMO dia e hora/);
  sem(r.flow.nextMove, /agende a AVALIACAO gratuita/i);
  assert.match(r.flow.nextMove, /NAO agende avaliacao no lugar/);
});

test("servico que a clinica NAO oferece: proibe dizer que faz e nao oferece substituto", () => {
  const r = decida({ history: [U("Oi"), A("Oi!")], trailing: ["Vocês fazem botox?"], notOffered: ["botox"] });
  assert.equal(r.decision.procedure.notOffered, "botox");
  assert.ok(r.decision.forbidden.some((f) => f.startsWith("dizer_que_a_clinica_faz:")));
  assert.match(r.move, /NAO ofereca outro procedimento/);
});

test("procedimento escolhido SEM regra cadastrada (modo desconhecido): nao agenda nem cria avaliacao; equipe valida", () => {
  const r = decida({ history: [U("Oi"), A("Oi!")], trailing: ["Quero marcar uma limpeza de pele"] });
  assert.equal(r.decision.procedure.chosen, "Limpeza de Pele");
  assert.match(r.decision.procedure.mode, /^unknown/);
  assert.equal(r.plan.handoffForced, true);
  assert.equal(gateDecision(r.plan.gate, "book_appointment", "Limpeza de Pele").allow, false);
});

test("procedimento que exige avaliacao: explica a regra da clinica e oferece a avaliacao, sem agendar o procedimento direto", () => {
  const r = decida({ history: [U("Oi"), A("Oi!")], trailing: ["Quero marcar o clareamento de virilha"] });
  assert.equal(r.decision.procedure.chosen, "Clareamento de Virilha");
  assert.match(r.decision.procedure.mode, /^evaluation/);
  assert.equal(gateDecision(r.plan.gate, "book_appointment", "Clareamento de Virilha").allow, false);
  assert.equal(gateDecision(r.plan.gate, "book_appointment", "Avaliação Estética").allow, true);
});

// ------------------------------------------------------------------ 10. mencionar nao e escolher
test("negar, experiencia passada e relato de outra pessoa NAO escolhem procedimento", () => {
  const nega = identifyWanted(CATALOG, ["Não quero Hipro, quero tratar gordura na barriga"]);
  assert.notDeepEqual(nega, { kind: "specific", procedure: "Hipro" });
  const passada = identifyWanted(CATALOG, ["Já fiz hipro e não gostei"]);
  assert.equal(passada.kind, "none");
  const amiga = identifyWanted(CATALOG, ["Minha amiga fez hipro e amou"]);
  assert.equal(amiga.kind, "none");
  const repete = identifyWanted(CATALOG, ["Já fiz hipro e quero fazer de novo"]);
  assert.deepEqual(repete, { kind: "specific", procedure: "Hipro" }, "'quero de novo' e escolha");
  const texto = reading.stripNonChoiceSegments("Já fiz botox. Quero o hipro");
  assert.match(texto, /Quero o hipro/);
  assert.doesNotMatch(texto, /botox/);
});

test("o texto do ANUNCIO entra como esta (nao e cortado pela leitura de negacao)", () => {
  const w = identifyWanted(CATALOG, ["Não perca a chance de fazer Hipro", "Oi"], 1);
  assert.deepEqual(w, { kind: "specific", procedure: "Hipro" });
});

// ------------------------------------------------------------------ 11. leitura do turno: unidades
test("leitura do turno: classifica a pergunta anterior e a resposta curta", () => {
  assert.equal(reading.classifyPrevQuestion("Quer ver horários?").kind, "schedule_offer");
  assert.equal(reading.classifyPrevQuestion("Você já fez antes?").kind, "experience");
  assert.equal(reading.classifyPrevQuestion("Qual é o seu nome completo?").kind, "name");
  assert.equal(reading.classifyPrevQuestion("Prefere manhã ou tarde?").kind, "preference");
  assert.equal(reading.classifyPrevQuestion("Entendi, obrigada.").kind, "none");
  assert.equal(reading.interpretAnswer("Quer que eu te explique como funciona?", ["Não"]).meaning, "declines_info");
  assert.equal(reading.interpretAnswer("Você já fez antes?", ["Sim, já fiz"]).meaning, "experience_yes");
  assert.equal(reading.interpretAnswer("Algo sem pergunta.", ["Sim"]).meaning, null, "sem pergunta anterior nao se inventa significado");
  assert.equal(reading.detectObjection("Obrigada pela explicação"), null, "sem sinal claro nao ha objecao (inferencia fraca nao vira fato)");
  assert.equal(reading.isGoalCorrection("Não quero fazer isso agora"), false, "recusa do atendimento nao e correcao de objetivo");
});

// ------------------------------------------------------------------ 12. contrato de decisao: log tecnico
test("o log tecnico da decisao traz etapa, acao, ferramentas e proibicoes (sem conteudo da conversa)", () => {
  const r = decida({ history: [U("Queria saber do Hipro"), A("Quer ver um horário?")], trailing: ["Vou pensar, mas quanto tempo dura?"] });
  const linha = turnDecisionLog(r.decision);
  assert.match(linha, /etapa=pensando acao=responder_perguntas/);
  assert.match(linha, /perguntas=1/);
  assert.doesNotMatch(linha, /quanto tempo dura/);
});

// ------------------------------------------------------------------ 13. reversao
test("ALICE_TURN_READING=off volta a jogada generica anterior (resposta curta/objecao/perguntas deixam de ser lidas) e religar restaura", () => {
  const cena = { history: [U("Oi, queria saber do Hipro"), A("O Hipro é para firmeza do rosto. Você já fez algum procedimento parecido antes?")], trailing: ["Não"] };
  process.env.ALICE_TURN_READING = "off";
  try {
    const off = decida(cena);
    assert.equal(off.decision.answeringPrevious, null);
    assert.doesNotMatch(off.move, /NUNCA fez/);
    const caro = decida({ history: [U("Quero saber da enzima"), A("A enzima reduz gordura localizada.")], trailing: ["Achei caro"] });
    assert.equal(caro.decision.objection, null);
  } finally {
    delete process.env.ALICE_TURN_READING;
  }
  assert.match(decida(cena).move, /NUNCA fez/);
});
