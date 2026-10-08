-- Lisboa: texto da confirmação do dia (enviada todo dia às 7h para os agendamentos daquele dia)
UPDATE "ReminderRule" SET "message" =
  'Bom dia, {primeiro_nome}! Tudo bem? ☀️' || char(10) ||
  'Estamos muito felizes em te receber hoje às {hora} 🥰' || char(10) ||
  'Será um prazer tê-la conosco e proporcionar uma experiência especial ❤️'
WHERE "dayOffset" = 0 AND "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center');
