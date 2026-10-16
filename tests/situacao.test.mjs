import test from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY ??= "test-key";

const { resolveSituation, automationKindOf, wantsCancel, wantsReschedule, claimsExistingBooking } = await import("../dist/ai/situation.js");
const { parseSlotRequest, describeSlotRequest, requestViolation, slotRespects } = await import("../dist/ai/slotRequest.js");
const { identifyWanted } = await import("../dist/ai/bookingIntent.js");
const { judgeLiveBooking } = await import("../dist/clinicaexperts/liveCheck.js");
const { stripProcedureLines, isPlaceholderProcedure, PLACEHOLDER_PROCEDURE_NAME } = await import("../dist/clinicaexperts/placeholderProcedure.js");
const { announcesAction, brokenPromise, claimsCancel, claimsReschedule } = await import("../dist/ai/promises.js");
const { filterByTimeWindow } = await import("../dist/scheduling/slots.js");
const { postStillComing } = await import("../dist/reminders/nps.js");

// sexta-feira 16/10/2026, 16:24 (Sao Paulo = UTC-3)
const TODAY = "2026-10-16";
const NOW = new Date("2026-10-16T19:24:00Z");
const at = (iso) => new Date(iso);
const msg = (role, content, extra = {}) => ({ role, content, createdAt: NOW, authorName: null, ...extra });

const hipro = {
  id: "a1", dateIso: "2026-10-20", time: "13:30", label: "terca-feira, 20/10 as 13:30",
  procedure: "Hipro", professional: "Sabrina", isEvaluation: false, patientConfirmed: false,
};

function situation(over) {
  return resolveSituation({ history: [], trailing: [], now: NOW, todayIso: TODAY, upcoming: [], pastVisits: 0, ...over });
}

test("Vania: 'trocar meu horario na terca pra 12:30' e REMARCAR o horario que ja tem, nunca avaliacao", () => {
  const trailing = ["Na terça feira eu vejo direitinho. Por falar nisso, preciso trocar meu horário na terça pra 12:30"];
  const s = situation({ history: [msg("user", trailing[0])], trailing, upcoming: [hipro] });
  assert.equal(s.kind, "reschedule");
  assert.match(s.directive, /manage_my_appointment/);
  assert.match(s.directive, /Hipro/);
  assert.match(s.directive, /NUNCA ofereca avaliacao/);
  assert.equal(s.forbidEvaluationOffer, true);
  assert.deepEqual(s.request.dates, ["2026-10-20"]);
  assert.deepEqual(s.request.times, ["12:30"]); // o 13:30 e o horario ATUAL, nao pedido novo
  assert.ok(s.briefing.some((l) => /AGENDA DELA/.test(l) && /Hipro/.test(l)));
});

test("Bruna: 'avisei ontem que nao vou conseguir ir' e CANCELAR - a ferramenta tem que rodar", () => {
  const trailing = ["Bom dia eu avisei ontem que não vou conseguir ir"];
  const today = { ...hipro, dateIso: TODAY, time: "08:30", label: "sexta-feira, 16/10 as 08:30", procedure: "Limpeza de pele" };
  const s = situation({ history: [msg("user", trailing[0])], trailing, upcoming: [today] });
  assert.equal(s.kind, "cancel");
  assert.match(s.directive, /action="cancel"/);
  assert.match(s.directive, /NUNCA escreva 'vou cancelar'/);
});

test("cancelou mas propos outro horario = remarcacao, nao cancelamento", () => {
  assert.equal(wantsCancel("não vou conseguir ir hoje, pode ser amanhã?"), false);
  assert.equal(wantsReschedule("não vou conseguir ir hoje, pode ser amanhã?"), true);
  assert.equal(wantsCancel("qual a política de cancelamento?"), false);
});

test("lead sem horario que diz 'nao consigo ir ai' recusa convite: nao vira cancelamento nem transferencia", () => {
  const trailing = ["Moro longe, não consigo ir aí"];
  const s = situation({ history: [msg("user", trailing[0])], trailing });
  assert.equal(s.kind, "default");
  assert.equal(s.forceTransfer, null);
});

test("Maria: cita um horario que nao bate com a agenda da Alice -> equipe, sem oferecer nada", () => {
  const evalWrong = { ...hipro, id: "a2", dateIso: TODAY, time: "08:00", label: "sexta-feira, 16/10 as 08:00", procedure: "Avaliação", isEvaluation: true };
  for (const t of ["Meu horário é às 13:15 hs", "Eu tenho no dia 20/10 uma sessão de Lavieen as 12:30 hs"]) {
    const s = situation({ history: [msg("user", t)], trailing: [t], upcoming: [evalWrong] });
    assert.equal(s.kind, "booking_claim", t);
    assert.ok(s.forceTransfer, t);
    assert.equal(s.forbidSlotOffer, true);
  }
});

test("citar um horario que BATE com a agenda nao e disputa", () => {
  const t = "Meu horário é às 13:30";
  const s = situation({ history: [msg("user", t)], trailing: [t], upcoming: [hipro] });
  assert.equal(s.forceTransfer, null);
});

test("'meu horario e flexivel' (sem hora) nao dispara disputa", () => {
  const t = "Meu horário é flexível";
  assert.equal(claimsExistingBooking(t), true); // padrao reconhecido...
  const s = situation({ history: [msg("user", t)], trailing: [t] });
  assert.equal(s.forceTransfer, null); // ...mas sem dia/hora nao ha o que conferir
});

test("Isabela: a equipe propos 21/10 18h, ela recusou ('aula as 18h40') -> retomar do pedido dela, nao dos mais proximos", () => {
  const history = [
    msg("user", "Tem pro sábado, dia 24, era melhor... umas 10 ou 10:30"),
    msg("human", "Não temos esse horário disponível no dia 24/10 Isa"),
    msg("human", "Vamos reservar para o dia 21/10 ás 18h00?"),
    msg("user", "Não da"),
    msg("user", "eu tenho aula as 1840"),
    msg("user", "18h40"),
  ];
  const trailing = ["Não da", "eu tenho aula as 1840", "18h40"];
  const s = situation({ history, trailing, resumedAfterStaffDelay: true });
  assert.equal(s.kind, "staff_followup");
  assert.match(s.directive, /CONTINUE DE ONDE A EQUIPE PAROU/);
  assert.match(s.directive, /nunca 'hoje'/);
  assert.equal(s.request.notAfter, "18:40");
});

test("Andreia: a equipe propos 'amanha as 12h30', ela aceitou ('pode ser...') -> a Alice nao recomeca com 3 horarios de avaliacao", () => {
  const history = [
    msg("user", "somente aos sábados eu consigo"),
    msg("user", "estou trabalhando hoje"),
    msg("human", "Amanhã às 12h30"),
    msg("user", "pode ser..."),
  ];
  const s = situation({ history, trailing: ["pode ser..."], resumedAfterStaffDelay: true });
  assert.equal(s.kind, "staff_followup");
  assert.match(s.directive, /PROPOSTA DA EQUIPE/);
  assert.match(s.directive, /12:30/);
  assert.match(s.directive, /check_specific_time/);
  // "estou trabalhando hoje" nao e pedido de dia
  assert.ok(!s.request.dates.includes(TODAY));
  assert.equal(s.request.onlyWeekdays, true);
  assert.deepEqual(s.request.weekdays, [6]);
});

test("equipe falou de outro assunto (endereco): nao vira retomada de horario", () => {
  const history = [msg("human", "Enviei o endereço pra você"), msg("user", "ok")];
  const s = situation({ history, trailing: ["ok"] });
  assert.equal(s.kind, "default");
});

test("Aline: 'Obrigada' a pesquisa/pos automatica so agradece (sem 3 horarios de avaliacao)", () => {
  const history = [
    msg("assistant", "Oi, 💗 Como foi sua experiência aqui na Lisboa? De 0 a 10, que nota você daria?", { authorName: "Pesquisa de satisfação" }),
    msg("assistant", "Oi, Aline! Passando para saber como sua pele está hoje após Limpeza de Pele.", { authorName: "Pós-procedimento automático" }),
    msg("user", "Obrigada"),
  ];
  const s = situation({ history, trailing: ["Obrigada"], pastVisits: 1 });
  assert.equal(s.kind, "automation_ack");
  assert.equal(s.closeWith, "thanks");
  assert.equal(s.forbidSlotOffer, true);
  assert.equal(automationKindOf(history[0]), "nps");
  assert.equal(automationKindOf(history[1]), "pos");
  assert.equal(automationKindOf(msg("assistant", "Oi!")), null); // resposta normal da Alice nao e automatica
});

test("resposta a recontato automatico NAO e encerrada ('ok' pode ser aceite de horario)", () => {
  const history = [msg("assistant", "Oi! Posso ver um horário pra você?", { authorName: "Recontato automático" }), msg("user", "ok")];
  const s = situation({ history, trailing: ["ok"] });
  assert.notEqual(s.kind, "automation_ack");
});

test("pedido de dia e hora: 'so aos sabados', dia 24, 10 ou 10:30, limite 18:40", () => {
  const r = parseSlotRequest(["Tem pro sábado, dia 24, era melhor... umas 10 ou 10:30", "somente aos sábados eu consigo", "eu tenho aula as 1840"], TODAY);
  assert.ok(r.dates.includes("2026-10-24"));
  assert.equal(r.onlyWeekdays, true);
  assert.deepEqual(r.weekdays, [6]);
  assert.ok(r.times.includes("10:00") && r.times.includes("10:30"));
  assert.equal(r.notAfter, "18:40");
  assert.match(describeSlotRequest(r), /SO consegue sábado/);
});

test("a oferta tem que respeitar o pedido: so sabados e a lista veio so de sexta -> refazer", () => {
  const r = parseSlotRequest(["somente aos sábados eu consigo"], TODAY);
  const friday = [{ date: "2026-10-16", time: "10:30" }, { date: "2026-10-16", time: "15:00" }];
  assert.match(requestViolation(r, friday, [], TODAY), /NAO respeitam/);
  assert.equal(requestViolation(r, [{ date: "2026-10-17", time: "08:00" }], [], TODAY), null);
  assert.equal(slotRespects(r, "2026-10-17", "08:00"), true);
  assert.equal(slotRespects(r, "2026-10-16", "08:00"), false);
});

test("dia explicito que nem foi consultado -> refazer; consultado e vazio -> ok", () => {
  const r = parseSlotRequest(["Na terça pra 12:30"], TODAY);
  const other = [{ date: "2026-10-16", time: "15:00" }];
  assert.match(requestViolation(r, other, [], TODAY), /nao consultou esse dia/);
  assert.equal(requestViolation(r, other, ["2026-10-20"], TODAY), null);
});

test("limite 'tenho aula as 18:40': atendimento de 60 min nao pode comecar 18:00", () => {
  const r = parseSlotRequest(["tenho aula às 18:40"], TODAY);
  assert.equal(slotRespects(r, "2026-10-21", "17:30", 60), true);
  assert.equal(slotRespects(r, "2026-10-21", "18:00", 60), false);
});

test("Jandira: 'gordura localizada' e uma NECESSIDADE, nao pedido de procedimento", () => {
  const catalog = [
    { name: "Enzimas", aliases: "gordura localizada, enzima" },
    { name: "Criolipólise", aliases: "gordura localizada, congelamento" },
    { name: "Lavieen", aliases: "laser" },
    { name: "Avaliação Estética", aliases: "" },
  ];
  const w = identifyWanted(catalog, ["Boa tarde, queria um tratamento pra tirar gordura localizada"]);
  assert.equal(w.kind, "need");
  assert.ok(w.options.includes("Enzimas") && w.options.includes("Criolipólise"));
  // citou o NOME: ai e pedido de verdade
  assert.deepEqual(identifyWanted(catalog, ["quero fazer enzimas"]), { kind: "specific", procedure: "Enzimas" });
});

test("conferencia ao vivo no Clinica Experts: cancelada/apagada/trocada nao recebe lembrete do horario velho", () => {
  const appt = { scheduledAt: new Date("2026-10-20T16:30:00Z") }; // 13:30 em SP
  const tz = "America/Sao_Paulo";
  assert.equal(judgeLiveBooking(appt, { ok: false, status: 404 }, tz).kind, "gone");
  assert.equal(judgeLiveBooking(appt, { ok: false, status: 500 }, tz).kind, "unknown");
  assert.equal(judgeLiveBooking(appt, { ok: true, data: { data: { status: "canceled", starts_at: "2026-10-20T13:30:00-03:00" } } }, tz).kind, "gone");
  assert.equal(judgeLiveBooking(appt, { ok: true, data: { data: { status: "scheduled", starts_at: "2026-10-20T13:30:00-03:00" } } }, tz).kind, "ok");
  const moved = judgeLiveBooking(appt, { ok: true, data: { data: { status: "scheduled", starts_at: "2026-10-21T10:00:00-03:00" } } }, tz);
  assert.equal(moved.kind, "moved");
  assert.equal(moved.to.toISOString(), "2026-10-21T13:00:00.000Z");
});

test("reserva sem procedimento: confirmacao sai so com data e horario", () => {
  const msg1 = "Olá, {primeiro_nome}!\n\n📅 Data: {data}\n⏰ Horário: {hora}\n💆 Procedimento: {procedimento}\n\nPodemos contar com a sua presença?";
  const out = stripProcedureLines(msg1);
  assert.ok(!/rocedimento/.test(out));
  assert.match(out, /Data: \{data\}/);
  assert.match(out, /Horário: \{hora\}/);
  assert.match(out, /Podemos contar/);
  assert.equal(isPlaceholderProcedure({ name: PLACEHOLDER_PROCEDURE_NAME }), true);
  assert.equal(isPlaceholderProcedure({ name: "Botox" }), false);
  // texto com o procedimento no meio da frase fica como esta (o disparo troca por "seu atendimento")
  assert.equal(stripProcedureLines("Confirmando seu {procedimento} amanhã"), "Confirmando seu {procedimento} amanhã");
});

test("'vou cancelar' / 'cancelei' sem a ferramenta e promessa quebrada", () => {
  assert.equal(announcesAction("Entendi, Bruna. Vou cancelar seu horário para hoje."), true);
  assert.equal(announcesAction("Vou remarcar pra você"), true);
  assert.equal(claimsCancel("Pronto, cancelei o seu horário"), true);
  assert.equal(claimsCancel("Qual agendamento você quer cancelar?"), false);
  assert.equal(claimsReschedule("Remarquei para quarta às 12:30"), true);
  assert.equal(brokenPromise("Cancelei seu horário", false, { cancelOk: false }), true);
  assert.equal(brokenPromise("Cancelei seu horário", false, { cancelOk: true }), false);
  assert.equal(brokenPromise("Remarquei para quarta às 12:30", false, { rescheduleOk: true }), false);
  assert.equal(brokenPromise("Remarquei para quarta às 12:30", false, {}), true);
});

test("janela de horario: 'ate 18:40' com atendimento de 60 min", () => {
  const mk = (h, m) => ({ start: new Date(Date.UTC(2026, 9, 21, h + 3, m)) }); // SP = UTC-3
  const slots = [mk(10, 0), mk(17, 30), mk(18, 0), mk(19, 0)];
  const ok = filterByTimeWindow(slots, "America/Sao_Paulo", 60, null, "18:40");
  assert.equal(ok.length, 2);
  const after = filterByTimeWindow(slots, "America/Sao_Paulo", 60, "17:00", null);
  assert.equal(after.length, 3);
});

test("NPS espera o pos-procedimento que ainda vai sair (e nao espera por avaliacao)", () => {
  const now = new Date("2026-10-16T16:00:00Z").getTime();
  const rules = [{ intervalValue: 1, intervalUnit: "hours", procedureIds: "" }];
  const limpeza = { scheduledAt: new Date("2026-10-16T14:00:00Z"), procedureId: "p1", procedure: { name: "Limpeza de Pele" } };
  assert.equal(postStillComing(limpeza, rules, 0, now), true);
  assert.equal(postStillComing(limpeza, rules, 1, now), false); // o pos ja saiu (a regra de 4h cuida do resto)
  assert.equal(postStillComing({ ...limpeza, procedure: { name: "Avaliação" } }, rules, 0, now), false);
  assert.equal(postStillComing(limpeza, [], 0, now), false);
});
