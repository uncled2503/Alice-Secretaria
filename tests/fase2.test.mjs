import test from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY ??= "test-key";

const { detectIntentSignals, describeSignals } = await import("../dist/crm/intent.js");
const { isHotStalled, HOT_STALL_MS, renderCallbackMessage } = await import("../dist/crm/hotLeads.js");
const { callbackInstant, cleanObjections } = await import("../dist/crm/leadSummary.js");
const { handoffCard } = await import("../dist/crm/handoffCard.js");
const { riskNoteText } = await import("../dist/crm/patientRisk.js");
const { refusedAny, refusalKey } = await import("../dist/crm/broadcast.js");
const { originOf } = await import("../dist/crm/insights.js");

test("sinais de intencao: valor, parcelamento, horario e alta intencao", () => {
  assert.equal(detectIntentSignals("Qual o valor da criolipólise?").price, true);
  assert.equal(detectIntentSignals("quanto custa o botox").price, true);
  const parc = detectIntentSignals("Dá pra parcelar em 10x no cartão?");
  assert.equal(parc.installments, true);
  assert.equal(parc.price, true); // quem pergunta parcelamento esta perguntando o valor
  assert.equal(parc.highIntent, true);
  assert.equal(detectIntentSignals("tem horário amanhã de manhã?").schedule, true);
  assert.equal(detectIntentSignals("pode reservar pra mim?").highIntent, true);
  assert.equal(detectIntentSignals("como eu pago?").highIntent, true);
});

test("sinais de intencao: conversa comum nao esquenta o lead", () => {
  for (const t of ["oi, tudo bem?", "quanto tempo dura o procedimento?", "vocês estão fechados hoje?", "obrigada!", "", null]) {
    const s = detectIntentSignals(t);
    assert.equal(s.price || s.installments || s.schedule || s.highIntent, false, String(t));
  }
  assert.equal(describeSignals({ askedPriceAt: new Date(), askedInstallmentsAt: new Date(), askedScheduleAt: null }), "perguntou o parcelamento");
  assert.equal(describeSignals({ askedPriceAt: new Date(), askedInstallmentsAt: null, askedScheduleAt: new Date() }), "perguntou o valor e pediu horário");
});

test("lead quente parado: so depois de 90 min sem resposta e uma vez por sinal", () => {
  const now = new Date("2026-10-13T15:00:00Z");
  const ago = (min) => new Date(now.getTime() - min * 60_000);
  const base = { askedPriceAt: ago(120), askedInstallmentsAt: null, askedScheduleAt: null, hotAlertedAt: null };
  assert.equal(isHotStalled(base, ago(120), now), true);
  assert.equal(isHotStalled(base, ago(30), now), false); // respondeu ha pouco
  assert.equal(isHotStalled({ ...base, hotAlertedAt: ago(60) }, ago(120), now), false); // ja avisou desse sinal
  assert.equal(isHotStalled({ ...base, hotAlertedAt: ago(300) }, ago(120), now), true); // sinal novo depois do aviso antigo
  assert.equal(isHotStalled({ ...base, askedPriceAt: ago(60 * 30) }, ago(60 * 30), now), false); // sinal velho: ja e recontato normal
  assert.equal(isHotStalled({ askedPriceAt: null, askedInstallmentsAt: null, askedScheduleAt: null, hotAlertedAt: null }, ago(120), now), false);
  assert.equal(HOT_STALL_MS, 90 * 60_000);
});

test("retorno combinado: data valida no futuro vira 10h no fuso da clinica; passado/invalida nao", () => {
  const now = new Date("2026-10-13T12:00:00Z");
  assert.equal(callbackInstant("2026-10-20", "America/Sao_Paulo", now)?.toISOString(), "2026-10-20T13:00:00.000Z");
  assert.equal(callbackInstant("2026-10-01", "America/Sao_Paulo", now), null); // ja passou
  assert.equal(callbackInstant("amanha", "America/Sao_Paulo", now), null);
  assert.equal(callbackInstant("2026-13-40", "America/Sao_Paulo", now), null);
  assert.equal(callbackInstant("2030-01-01", "America/Sao_Paulo", now), null); // longe demais
  assert.equal(renderCallbackMessage("Maria Souza").startsWith("Oi, Maria!"), true);
  assert.equal(renderCallbackMessage(null).startsWith("Oi!"), true);
  assert.equal(renderCallbackMessage(null).includes("{"), false);
});

test("objecoes: so valores conhecidos", () => {
  assert.equal(cleanObjections("Preço, medo, outra coisa, preco"), "preco,medo");
  assert.equal(cleanObjections("preco, medo, preco"), "preco,medo");
  assert.equal(cleanObjections(""), "");
});

test("ficha de transferencia: so o que se sabe", () => {
  const card = handoffCard({
    adName: "Lavieen", adCampaignName: null, interestNote: "Lavieen", contactReason: "Quer tratar manchas",
    urgency: "este_mes", objections: "preco,medo", refusedProcedures: "botox", preferredProfessional: null,
    preferredPeriod: "tarde", preferredDays: "terça e quinta", leadTemperature: "quente",
    askedPriceAt: new Date(), askedInstallmentsAt: null, askedScheduleAt: null,
  });
  for (const part of ["Origem: Lavieen", "Procedimento de interesse: Lavieen", "Objetivo: Quer tratar manchas", "Prazo: quer fazer este mês", "Objeções: preço, medo", "Já recusou: botox", "período tarde", "Sinais: perguntou o valor", "Temperatura: quente"]) {
    assert.ok(card.includes(part), part + "\n" + card);
  }
  const empty = handoffCard({ adName: null, adCampaignName: null, interestNote: null, contactReason: null, urgency: null, objections: null, refusedProcedures: null, preferredProfessional: null, preferredPeriod: null, preferredDays: null, leadTemperature: null, askedPriceAt: null, askedInstallmentsAt: null, askedScheduleAt: null });
  assert.equal(empty, "");
});

test("alerta de agenda: faltas e remarcacoes repetidas", () => {
  assert.equal(riskNoteText(0, 0), "");
  assert.equal(riskNoteText(1, 2), "");
  assert.ok(riskNoteText(2, 0).includes("2 falta(s)"));
  assert.ok(riskNoteText(0, 3).includes("3 remarcações"));
});

test("campanha de procedimento nao vai pra quem recusou esse procedimento", () => {
  const chosen = ["aplicacao de botox", "limpeza de pele"].map(refusalKey);
  assert.equal(refusedAny("botox", chosen), true);
  assert.equal(refusedAny("Preenchimento, Botox", chosen), true);
  assert.equal(refusedAny("preenchimento", chosen), false);
  assert.equal(refusedAny(null, chosen), false);
  assert.equal(refusedAny("ab", chosen), false); // texto curto demais nao casa por acaso
});

test("origem do lead pra relatorio de conversao", () => {
  assert.equal(originOf({ adCampaignName: "Verão", adName: "x" }), "Verão");
  assert.equal(originOf({ adCampaignName: null, adName: "Lavieen" }), "Lavieen");
  assert.equal(originOf({ adCampaignName: null, adName: null }), "Orgânico (sem anúncio)");
});
