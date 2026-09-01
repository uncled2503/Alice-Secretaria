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

test("plano de briefing aceita perfil de atendimento", () => {
  const p = BriefingPlanSchema.parse({
    clinic: { servicePosture: "consultivo", clinicKind: "medica", evaluationFirst: true, allowEmojis: false, schedulingLink: "https://x.com/agendar" },
  });
  assert.equal(p.clinic.servicePosture, "consultivo");
  assert.equal(p.clinic.clinicKind, "medica");
  assert.equal(p.clinic.evaluationFirst, true);
  assert.equal(p.clinic.allowEmojis, false);
  // enum fora da lista some (vira undefined) em vez de derrubar o plano todo
  const j = BriefingPlanSchema.parse({ clinic: { servicePosture: "outra" } });
  assert.equal(j.clinic.servicePosture, undefined);
});

test("plano de briefing descarta ruido em vez de falhar", () => {
  // categoria de regra invalida: a regra ruim some, a boa fica
  const r = BriefingPlanSchema.parse({
    rules: [
      { category: "xpto", instruction: "categoria inexistente" },
      { category: "tom_de_voz", instruction: "Falar sempre com gentileza." },
    ],
  });
  assert.equal(r.rules.length, 1);
  assert.equal(r.rules[0].category, "tom_de_voz");
  // hora fora do intervalo: campo some, resto do plano segue
  const h = BriefingPlanSchema.parse({ clinic: { name: "X", workStartHour: 30 } });
  assert.equal(h.clinic.workStartHour, undefined);
  assert.equal(h.clinic.name, "X");
});

test("plano de briefing tolera null, string no lugar de array e numero como texto", () => {
  const p = BriefingPlanSchema.parse({
    clinic: { name: "Clinica X", timezone: null, workStartHour: "9", workEndHour: "19", assistantPersonaName: null, allowEmojis: null, schedulingLink: "" },
    procedures: [
      { name: "Toxina", durationMin: "30", price: "1200", goals: "rosto cansado", aliases: null },
      { name: "", price: null },
      { name: "Cirurgia", price: "depende de avaliacao", priceVariable: true },
    ],
    professionals: [{ name: "Dra. Ana", procedureNames: "Toxina" }],
    playbooks: [{ name: "Primeiro contato", scriptType: "saudacao", steps: "Cumprimente" }],
    warnings: null,
  });
  assert.equal(p.clinic.workStartHour, 9);
  assert.equal(p.clinic.workEndHour, 19);
  assert.equal(p.clinic.timezone, undefined);
  assert.equal(p.procedures.length, 2); // o sem nome foi descartado
  assert.equal(p.procedures[0].durationMin, 30);
  assert.equal(p.procedures[0].price, 1200);
  assert.deepEqual(p.procedures[0].goals, ["rosto cansado"]);
  assert.equal(p.procedures[1].price, undefined); // "depende" nao vira numero
  assert.equal(p.procedures[1].priceVariable, true);
  assert.deepEqual(p.professionals[0].procedureNames, ["Toxina"]);
  assert.equal(p.playbooks[0].scriptType, undefined); // enum invalido -> some
  assert.deepEqual(p.playbooks[0].steps, ["Cumprimente"]);
  assert.deepEqual(p.warnings, []);
});
