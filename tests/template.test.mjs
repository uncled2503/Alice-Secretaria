import assert from "node:assert/strict";
import test from "node:test";
import { renderMessageTemplate } from "../dist/crm/template.js";

test("renderiza variaveis de paciente, clinica e agendamento", () => {
  const result = renderMessageTemplate(
    "Oi {primeiro_nome}! {procedimento} com {profissional}, {data_hora}, na {unidade}: {endereco}.",
    {
      patientName: "Ana Souza",
      patientPhone: "5511999999999",
      clinicName: "Clinica Alice",
      locationName: "Unidade Centro",
      locationAddress: "Rua Principal, 10",
      procedureName: "Avaliacao",
      professionalName: "Dra. Camila",
      when: new Date("2026-08-28T15:00:00.000Z"),
    }
  );

  assert.match(result, /^Oi Ana!/);
  assert.match(result, /Avaliacao com Dra\. Camila/);
  assert.match(result, /28\/08\/2026/);
  assert.match(result, /12:00/);
  assert.match(result, /Unidade Centro: Rua Principal, 10/);
});

test("campos opcionais ausentes nao deixam placeholders", () => {
  const result = renderMessageTemplate("{nome_completo}|{procedimento}|{aniversario}", {
    patientName: null,
    patientPhone: "5511888888888",
    clinicName: "Clinica Alice",
  });

  assert.equal(result, "||");
});
