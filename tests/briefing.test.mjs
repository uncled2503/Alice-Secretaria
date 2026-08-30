import assert from "node:assert/strict";
import test from "node:test";
import { BriefingPlanSchema } from "../dist/ai/briefing.js";

test("plano de briefing preenche defaults e aceita objeto vazio", () => {
  const p = BriefingPlanSchema.parse({});
  assert.deepEqual(p.clinic, {});
  assert.deepEqual(p.procedures, []);
  assert.deepEqual(p.rules, []);
  assert.equal(p.automations.birthday.enabled, false);
  assert.deepEqual(p.automations.reminders, []);
  assert.deepEqual(p.warnings, []);
});

test("plano de briefing normaliza um caso realista", () => {
  const p = BriefingPlanSchema.parse({
    clinic: { name: "  Clinica Bella  ", workStartHour: 9, workEndHour: 19, workDays: "1,2,3,4,5", assistantPersona: "clinic_secretary" },
    procedures: [
      { name: "Toxina Botulinica", durationMin: 30, price: 1200, paymentMethods: "pix,credito", goals: ["rosto cansado"] },
      { name: "Preenchimento", price: null, priceVariable: true },
    ],
    professionals: [{ name: "Dra. Camila", procedureNames: ["Toxina Botulinica"] }],
    faqs: [{ question: "Tem estacionamento?", answer: "Sim, convênio na rua ao lado." }],
    rules: [{ category: "pagamento", instruction: "Só informar preço quando o paciente perguntar." }],
    automations: {
      reminders: [{ hoursBefore: 24 }],
      followups: [{ afterDays: 2 }],
      birthday: { enabled: true, sendHour: 10 },
    },
  });

  assert.equal(p.clinic.name, "Clinica Bella");
  assert.equal(p.procedures.length, 2);
  assert.equal(p.procedures[1].priceVariable, true);
  assert.equal(p.professionals[0].procedureNames[0], "Toxina Botulinica");
  assert.equal(p.automations.reminders[0].hoursBefore, 24);
  assert.equal(p.automations.birthday.enabled, true);
  assert.equal(p.rules[0].category, "pagamento");
});

test("plano de briefing rejeita categoria de regra invalida e hora fora do intervalo", () => {
  assert.equal(BriefingPlanSchema.safeParse({ rules: [{ category: "xpto", instruction: "teste" }] }).success, false);
  assert.equal(BriefingPlanSchema.safeParse({ clinic: { workStartHour: 30 } }).success, false);
});
