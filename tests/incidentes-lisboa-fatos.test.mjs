// INCIDENTES DA LISBOA (19-20/10/2026) NA RESPOSTA FINAL E NA LEITURA DO TURNO: funcoes puras, sem banco e sem OpenAI. Cada caso e uma conversa FICTICIA baseada nos prints
// (Veruska/Mariana: conclusao sem reserva; Robelia: formacao; Robelia/Orzy: quantidade; Eliana: sessoes; Paula: preco/indicacao; Orzy: expediente x vagas).
// Verifica o texto FINAL escolhido, os problemas apontados e o que o fluxo libera/fecha; nao so a presenca de frases.
import assert from "node:assert/strict";
import test from "node:test";

const facts = await import("../dist/ai/replyFacts.js");
const guard = await import("../dist/ai/replyGuard.js");
const { analyzeFlow } = await import("../dist/ai/salesFlow.js");
const { resolveSituation } = await import("../dist/ai/situation.js");
const { staffConfirmedBooking } = await import("../dist/ai/bookingIntent.js");
const { emptyRequest } = await import("../dist/ai/slotRequest.js");
const { newSlotState, knownFrom } = await import("../dist/ai/slotGuard.js");
const { looksLikeRealName, sameFirstName } = await import("../dist/ai/alice.js");

const TZ = "America/Sao_Paulo";
const NOW = new Date("2026-10-28T12:00:00-03:00"); // 29/10/2026 e QUINTA-feira
const mkCtx = (over = {}) => ({
  conversationId: "c1", tz: TZ, now: NOW, todayIso: "2026-10-28", situationKind: "default",
  forbidEvaluationOffer: false, forbidSlotOffer: false, request: emptyRequest(), trusted: false, agenda: true,
  actions: { booked: false, cancelled: false, rescheduled: false, transferred: false },
  evidence: { cancelledRecently: false, rescheduledRecently: false },
  slots: { state: newSlotState(), toolUsed: false, strict: knownFrom([], [], TZ), loose: knownFrom([], [], TZ), toolDates: [] },
  upcoming: [], complaintTexts: [], silentHandoff: false, ...over,
});
const codes = (text, ctx) => guard.checkFinalReply(text, ctx, { strict: false }).map((p) => p.code);
const A_QUINTA = new Date("2026-10-29T18:30:00-03:00");

// ------------------------------------------------------------------ VERUSKA / MARIANA: conclusao so com reserva real
test("conclusao por SIGNIFICADO: 'confirmado', 'seu horario ficou', 'te esperamos' e 'voces estao marcados' sem reserva sao barrados (nao so 'agendei')", () => {
  for (const t of [
    "Perfeito, Mariana! Fica confirmado amanhã às 12:00.",
    "Combinado! Seu horário ficou para quinta-feira, 29/10 às 18:30 com a Adriana.",
    "Tudo certo, está confirmado para 29/10 às 18:30. Te esperamos!",
    "Pronto, vocês estão marcados às 18:30 com a Adriana.",
    "Confirmei seu atendimento para amanhã às 12h.",
  ]) assert.ok(codes(t, mkCtx()).some((c) => c === "claims_booking" || c === "claims_group"), `deveria barrar: ${t}`);
  // pergunta, oferta e condicional NAO sao conclusao
  for (const t of ["Posso confirmar amanhã às 12:00 pra você?", "Se você confirmar, eu reservo às 12:00.", "Tenho quinta-feira, 29/10 às 18:30. Fica bom pra você?"]) {
    assert.ok(!codes(t, mkCtx({ slots: { state: newSlotState(), toolUsed: true, strict: knownFrom([t], [], TZ), loose: knownFrom([t], [], TZ), toolDates: [] } })).includes("claims_booking"), `nao e conclusao: ${t}`);
  }
});

test("reserva EXISTENTE verificada pode ser confirmada (lembrete/presenca); a proposta ou o aceite no chat nao; reserva criada agora pela ferramenta tambem vale", () => {
  const existente = mkCtx({
    upcoming: [{ dateIso: "2026-10-29", time: "18:30", ddmm: "29/10" }],
    slots: { state: newSlotState(), toolUsed: false, strict: knownFrom([], [A_QUINTA], TZ), loose: knownFrom([], [A_QUINTA], TZ), toolDates: [] },
  });
  assert.deepEqual(codes("Confirmado! Te esperamos quinta-feira, 29/10 às 18:30.", existente), [], "confirma a reserva que ja existe");
  assert.ok(codes("Confirmado! Te esperamos às 19:00.", existente).includes("claims_booking"), "outro horario nao esta provado");
  assert.deepEqual(codes("Pronto, agendado!", mkCtx({ actions: { booked: true, cancelled: false, rescheduled: false, transferred: false, bookedCount: 1 } })), [], "book_appointment deu certo agora");
});

test("DOIS PACIENTES: uma unica reserva NAO cobre 'os dois'; oferta do mesmo horario para as duas pessoas e barrada; a saida segura pede dados de cada uma e passa para a equipe", () => {
  const ctx = mkCtx({ companion: true, actions: { booked: true, cancelled: false, rescheduled: false, transferred: false, bookedCount: 1 } });
  const t = "Pronto! Os dois ficaram agendados às 18:30 com a Adriana.";
  assert.ok(codes(t, ctx).includes("claims_group"));
  const oferta = "Tenho às 18:30 com a Adriana para os dois.";
  assert.ok(codes(oferta, mkCtx({ companion: true })).includes("group_offer"), "nao presume que a mesma profissional atende duas pessoas ao mesmo tempo");
  const choice = guard.chooseFinalReply({ ctx, original: t });
  assert.equal(choice.source, "safe");
  assert.equal(choice.needsHandoff, true, "a pendencia vai para a equipe de forma visivel");
  assert.match(choice.text, /nome completo e um telefone de contato de cada uma/);
  assert.doesNotMatch(choice.text, /agendados|confirmados/);
  // com duas reservas de verdade a afirmacao e permitida
  assert.ok(!codes(t, mkCtx({ companion: true, actions: { booked: true, cancelled: false, rescheduled: false, transferred: false, bookedCount: 2 } })).includes("claims_group"));
});

test("identidade: o nome do acompanhante nunca sobrescreve o cadastro da cliente", () => {
  assert.equal(looksLikeRealName("Veruska Lima"), true);
  assert.equal(looksLikeRealName("Mari 🌸"), false, "apelido do WhatsApp nao conta como nome real");
  assert.equal(sameFirstName("Veruska Lima", "Carlos Alberto Lima"), false);
  assert.equal(sameFirstName("Mariana Souza", "Mari Souza Lima"), true);
  assert.equal(sameFirstName("Ana Paula", "Ana Paula Silva"), true);
});

test("DIA DA SEMANA coerente com a data: 'terca-feira, 29/10' (quinta) e corrigido na original E na reescrita, antes da validacao", () => {
  const ctx = mkCtx({
    upcoming: [{ dateIso: "2026-10-29", time: "18:30", ddmm: "29/10" }],
    slots: { state: newSlotState(), toolUsed: false, strict: knownFrom([], [A_QUINTA], TZ), loose: knownFrom([], [A_QUINTA], TZ), toolDates: [] },
  });
  const errado = "Confirmado! Te esperamos terça-feira, 29/10 às 18:30 com a Adriana.";
  const original = guard.chooseFinalReply({ ctx, original: errado });
  assert.match(original.text, /quinta-feira, 29\/10/);
  assert.doesNotMatch(original.text, /terça/i);
  const reescrita = guard.chooseFinalReply({ ctx, original: "Confirmado!", rewritten: errado });
  assert.match(reescrita.text, /quinta-feira, 29\/10/);
});

test("aceite apos atendimento humano: 'pode ser sim' sem reserva no sistema NAO vira 'confirmado'; a saida e util (nao silencio) e nao promete o que nao fez", () => {
  const ctx = mkCtx({ situationKind: "staff_followup" });
  const choice = guard.chooseFinalReply({ ctx, original: "Perfeito, Mariana! Então fica confirmado amanhã às 12h." });
  assert.notEqual(choice.source, "original");
  assert.doesNotMatch(choice.text, /confirmad|agendad|marcad|te esperamos/i);
  assert.ok(choice.text.length > 20, "resposta util, nao vazia");
});

test("fala da EQUIPE no chat nao e retorno de ferramenta: pergunta/proposta nao conta como 'a equipe marcou'", () => {
  const h = (c) => [{ role: "human", content: c }];
  assert.equal(staffConfirmedBooking(h("Posso agendar amanhã às 12h para você?")), false);
  assert.equal(staffConfirmedBooking(h("Vamos concluir o agendamento? Amanhã às 12h fica bom?")), false);
  assert.equal(staffConfirmedBooking(h("Pronto! O agendamento foi concluído para amanhã às 12h.")), true);
});

// ------------------------------------------------------------------ ROBELIA: formacao da Sabrina
test("FORMACAO: Sabrina e biomedica; 'Dra.' nao implica medica; 'nossas medicas' nao existe quando a equipe cadastrada nao tem; outra clinica sem formacao cadastrada nao e afetada", () => {
  const pros = [{ name: "Sabrina Alves", qualification: "Biomédica" }, { name: "Adriana", qualification: null }];
  const probs = facts.qualificationProblems("Geralmente nossas médicas fazem o procedimento. Posso agendar com a médica Dra. Sabrina?", pros);
  assert.equal(probs.length, 2);
  assert.match(probs[1].why, /Biomédica/);
  assert.deepEqual(facts.qualificationProblems("A Sabrina é biomédica e faz a aplicação.", pros), []);
  assert.deepEqual(facts.qualificationProblems("A Sabrina não é médica, é biomédica.", pros), []);
  assert.deepEqual(facts.qualificationProblems("Nossas médicas fazem esse procedimento.", [{ name: "Fulana", qualification: null }]), [], "sem formacao cadastrada nesta clinica: nada a contrariar");
  const ctx = mkCtx({ professionals: pros });
  const choice = guard.chooseFinalReply({ ctx, original: "Quem faz é a médica Dra. Sabrina. Quer que eu veja um horário?" });
  assert.doesNotMatch(choice.text, /m[eé]dica/i, "a afirmacao errada sai da resposta");
});

// ------------------------------------------------------------------ ROBELIA / ORZY: quantidade (UI)
test("QUANTIDADE: so a cadastrada; faixa inventada ('20 a 50 UI') nunca; 40 UI quando nada foi cadastrado nunca; a oferta de 50 UI e dita como esta", () => {
  assert.deepEqual(facts.unprovenUnitSentences("A oferta inclui 50 UI.", [50]), []);
  assert.equal(facts.unprovenUnitSentences("Geralmente de 20 a 50 UI.", [50]).length, 1);
  assert.equal(facts.unprovenUnitSentences("Para a testa costumam ser 40 UI.", [50]).length, 1);
  assert.equal(facts.unprovenUnitSentences("A oferta inclui 50 UI.", []).length, 1, "sem cadastro de quantidade, qualquer numero e inventado");
  const ctx = mkCtx({ approvedUnits: [50], unitsKnown: true });
  assert.ok(codes("A quantidade varia, geralmente de 20 a 50 UI.", ctx).includes("unit_unproven"));
  const choice = guard.chooseFinalReply({ ctx, original: "Sobre a oferta: geralmente de 20 a 50 UI. Quer ver um horário?" });
  assert.doesNotMatch(choice.text, /20 a 50/);
  assert.deepEqual(codes("A oferta inclui 50 UI.", ctx), []);
});

// ------------------------------------------------------------------ PAULA: preco
test("PRECO: valor em R$ so se o cadastro/regras sustentam (valor de print ou de conversa antiga nao e cadastro)", () => {
  assert.deepEqual(facts.priceValues("Carboxiterapia R$ 250,00 e Skinbooster R$ 1.200"), [250, 1200]);
  const ctx = mkCtx({ approvedPrices: [180] });
  assert.ok(codes("A Carboxiterapia está R$ 250,00.", ctx).includes("price_unproven"));
  assert.deepEqual(codes("A sessão está R$ 180,00.", ctx), []);
});

// ------------------------------------------------------------------ FOTOS
test("FOTOS: 'te enviei as fotos' sem envio confirmado pela ferramenta e barrado; com envio confirmado passa", () => {
  assert.ok(codes("Te enviei algumas fotos de resultado!", mkCtx()).includes("claims_photos"));
  assert.deepEqual(codes("Te enviei algumas fotos de resultado!", mkCtx({ actions: { booked: false, cancelled: false, rescheduled: false, transferred: false, photosSent: true } })), []);
  const choice = guard.chooseFinalReply({ ctx: mkCtx(), original: "Te enviei fotos de resultado do peeling. Quer saber mais?" });
  assert.doesNotMatch(choice.text, /enviei/);
});

// ------------------------------------------------------------------ fecho generico e saudacao repetida
test("acabamento: 'se precisar, estou a disposicao' no fim e removido; novo 'Oi' no meio da conversa e removido; mensagem curta nao e esvaziada", () => {
  assert.equal(facts.stripGenericFarewell("O peeling ajuda a uniformizar a textura da pele. Se precisar de algo, estou à disposição!"), "O peeling ajuda a uniformizar a textura da pele.");
  assert.equal(facts.stripGenericFarewell("Estou à disposição!"), "Estou à disposição!");
  assert.equal(facts.stripRedundantGreeting("Oi, Maria! O peeling trata cicatrizes de acne."), "O peeling trata cicatrizes de acne.");
  assert.equal(facts.stripRedundantGreeting("Oi!"), "Oi!");
});

// ------------------------------------------------------------------ ORZY: expediente x vagas ; ELIANA: pergunta informativa
const U = (c) => ({ role: "user", content: c });
const A = (c) => ({ role: "assistant", content: c });
const flowOf = (history, trailing, over = {}) => analyzeFlow({ history: [...history.map((m, i) => ({ ...m, createdAt: new Date(NOW.getTime() - (100 - i) * 60_000) })), ...trailing.map((t, i) => ({ role: "user", content: t, createdAt: new Date(NOW.getTime() - (10 - i) * 60_000) }))], trailing, priceAsked: false, hasBooking: false, ...over });

test("EXPEDIENTE x VAGAS: 'dias e horarios de atendimento' responde o expediente, nao abre a agenda e nao volta ao assunto anterior", () => {
  const f = flowOf([U("Quero saber da oferta de toxina"), A("A oferta inclui 50 UI. Quer que eu veja um horário?")], ["Quais os dias e horários de atendimento?"]);
  assert.equal(f.reading.asksHours, true);
  assert.equal(f.schedulingSignal, false);
  assert.match(f.nextMove, /EXPEDIENTE da clinica/);
  assert.match(f.nextMove, /NAO consulte a agenda/);
  assert.equal(facts.asksOpeningHours("Tem vaga amanhã de manhã?"), false);
  assert.equal(facts.asksOpeningHours("Que horas vocês abrem aos sábados?"), true);
});

test("PERGUNTA INFORMATIVA no meio da conversa de agenda ('em quantas sessoes?', 'inclui radiofrequencia?'): responde, nao muda para a agenda", () => {
  const hist = [U("Quero fazer criolipólise, tem horário?"), A("A criolipólise leva cerca de 90 minutos de reserva. Quer que eu veja os horários?")];
  const f = flowOf(hist, ["Em quantas sessões é feito?"]);
  assert.equal(f.reading.infoQuestionOnly, true);
  assert.equal(f.schedulingSignal, false);
  assert.match(f.nextMove, /ELA PERGUNTOU|cadastrad/);
  const g = flowOf(hist, ["E inclui radiofrequência?"]);
  assert.equal(g.schedulingSignal, false);
  // pedido de dia/horario continua sendo agenda
  const h = flowOf(hist, ["Pode ser quinta à tarde?"]);
  assert.equal(h.schedulingSignal, true);
});

// ------------------------------------------------------------------ VIRADA DA MEIA-NOITE
test("MEIA-NOITE: 'amanha' da equipe e da cliente conta a partir do dia em que foi ESCRITO (fuso da clinica), nao do dia em que a Alice processa", () => {
  const staffAt = new Date("2026-10-27T22:00:00-03:00");
  const userAt = new Date("2026-10-27T23:50:00-03:00");
  const processed = new Date("2026-10-28T00:30:00-03:00");
  const sit = resolveSituation({
    history: [
      { role: "user", content: "Quero amanhã por volta das 11:00 ou 12:00", createdAt: new Date("2026-10-27T21:50:00-03:00") },
      { role: "human", content: "Mariana, amanhã às 12h fica bom? Já te encaixo.", authorName: "Aline", createdAt: staffAt },
      { role: "user", content: "pode ser sim", createdAt: userAt },
    ],
    trailing: ["pode ser sim"], now: processed, todayIso: "2026-10-28", tz: TZ, refIso: "2026-10-27", upcoming: [], pastVisits: 0, schedulingSignal: true,
  });
  assert.equal(sit.kind, "staff_followup");
  assert.match(sit.directive, /28\/10/, "a proposta da equipe e para 28/10 (dia seguinte ao dia em que foi escrita), nao 29/10");
  assert.doesNotMatch(sit.directive, /29\/10/);
});

test("SUCESSO PARCIAL (duas pessoas): diz exatamente o que foi concluido e o que continua pendente; nao desfaz a primeira", () => {
  const ctx = mkCtx({
    companion: true,
    actions: { booked: true, cancelled: false, rescheduled: false, transferred: true, bookedCount: 1, bookedSlots: [{ ddmm: "29/10", time: "18:30" }] },
    slots: { state: newSlotState(), toolUsed: true, strict: knownFrom(["quinta-feira, 29/10 às 18:30"], [], TZ), loose: knownFrom(["quinta-feira, 29/10 às 18:30"], [], TZ), toolDates: ["2026-10-29"] },
  });
  const ok = "O seu horário ficou confirmado: quinta-feira, 29/10 às 18:30 com a Adriana. O do seu marido continua pendente: a equipe vai confirmar e te avisa.";
  assert.deepEqual(codes(ok, ctx).filter((c) => c !== "slot_unproven"), []);
  assert.equal(guard.chooseFinalReply({ ctx, original: ok }).text.includes("O do seu marido continua pendente"), true);
});

test("reversao: ALICE_REPLY_FACTS=off desliga so as travas novas de fatos (conclusao por significado, fotos, UI, valor, formacao); a trava antiga de 'agendei' segue", () => {
  process.env.ALICE_REPLY_FACTS = "off";
  try {
    assert.deepEqual(codes("Perfeito! Fica confirmado amanhã às 12:00.", mkCtx()), []);
    assert.deepEqual(codes("A oferta é de 20 a 50 UI.", mkCtx({ approvedUnits: [50], unitsKnown: true })), []);
    assert.ok(codes("Pronto, agendei para amanhã às 12:00.", mkCtx()).includes("claims_booking"), "a trava antiga segue ligada");
  } finally { delete process.env.ALICE_REPLY_FACTS; }
  assert.ok(codes("Perfeito! Fica confirmado amanhã às 12:00.", mkCtx()).includes("claims_booking"));
});
