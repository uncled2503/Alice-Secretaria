ALTER TABLE "ReminderRule" ADD COLUMN "sendEndHour" INTEGER;

-- Lisboa: confirmacao do dia seguinte de 12h as 18h; confirmacao do dia de 7h as 10h (espalhadas, com pausa entre pacientes)
UPDATE "ReminderRule" SET "dayOffset" = 1, "sendHour" = 12, "sendMinute" = 0, "sendEndHour" = 18, "active" = 1,
  "message" = 'Olá, {primeiro_nome}! ♥️ Tudo bem?' || char(10) || 'Aqui é a Fabi, da Clínica Lisboa Beauty Center ✨' || char(10) || 'Passando para confirmar o seu agendamento conosco:' || char(10) || '' || char(10) || '📅 Data: {data} (amanhã)' || char(10) || '⏰ Horário: {hora}' || char(10) || '💆 Procedimento: {procedimento}' || char(10) || '' || char(10) || '📍 Endereço: Av. Índico, 294 – São Bernardo do Campo/SP – 09750-600' || char(10) || '🚗 Disponibilizamos estacionamento próprio e também temos convênio com desconto no endereço: Av. Índico, 231 – Jardim do Mar – São Bernardo do Campo.' || char(10) || '' || char(10) || 'Posso confirmar a sua presença?' || char(10) || '' || char(10) || 'Em caso de necessidade de cancelamento ou reagendamento, pedimos a gentileza de avisar com antecedência 💖'
WHERE "hoursBefore" = 24 AND "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center');
UPDATE "ReminderRule" SET "dayOffset" = 0, "sendHour" = 7, "sendMinute" = 0, "sendEndHour" = 10, "active" = 1,
  "message" = 'Bom dia, {primeiro_nome}! Tudo bem? ☀️' || char(10) || 'Estamos muito felizes em te receber hoje às {hora} 🥰' || char(10) || 'Será um prazer tê-la conosco e proporcionar uma experiência especial ❤️'
WHERE "hoursBefore" = 3 AND "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center');
