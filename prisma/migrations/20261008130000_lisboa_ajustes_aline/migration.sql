-- Colunas novas
ALTER TABLE "ReminderRule" ADD COLUMN "dayOffset" INTEGER;
ALTER TABLE "ReminderRule" ADD COLUMN "sendHour" INTEGER;
ALTER TABLE "ReminderRule" ADD COLUMN "sendMinute" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Clinic" ADD COLUMN "hoursByDay" TEXT;
ALTER TABLE "Clinic" ADD COLUMN "quotePrices" BOOLEAN NOT NULL DEFAULT true;

-- Lisboa (pedidos da Aline, 07/10/2026): sem valores pela Alice; sabado ate 15h nas automacoes
UPDATE "Clinic" SET "quotePrices" = 0, "hoursByDay" = '{"6":[8,15]}' WHERE "name" = 'Lisboa Beauty Center';

-- Confirmacoes em horario fixo: dia anterior 7h30 e proprio dia 7h. Ligadas (a clinica pediu).
UPDATE "ReminderRule" SET "dayOffset" = 1, "sendHour" = 7, "sendMinute" = 30, "active" = 1,
  "message" = 'Olá, {primeiro_nome}! ♥️ Tudo bem?' || char(10) || 'Aqui é a Alice, da Clínica Lisboa Beauty Center ✨' || char(10) || 'Passando para confirmar o seu agendamento conosco:' || char(10) || '📅 Data: {data} (amanhã)' || char(10) || '⏰ Horário: {hora}' || char(10) || '💆 Procedimento: {procedimento}' || char(10) || '' || char(10) || '📍 Endereço: Av. Índico, 294 – São Bernardo do Campo/SP – 09750-600' || char(10) || '🚗 Disponibilizamos estacionamento próprio e também temos convênio com desconto no endereço: Av. Índico, 231 – Jardim do Mar – São Bernardo do Campo.' || char(10) || '' || char(10) || 'Posso confirmar a sua presença?' || char(10) || '' || char(10) || 'Em caso de necessidade de cancelamento ou reagendamento, pedimos a gentileza de avisar com antecedência 💖'
WHERE "hoursBefore" = 24 AND "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center');
UPDATE "ReminderRule" SET "dayOffset" = 0, "sendHour" = 7, "sendMinute" = 0, "active" = 1,
  "message" = 'Olá, {primeiro_nome}! ☀️ Tudo bem?' || char(10) || 'Estamos muito felizes em te receber hoje às {hora} 🥰' || char(10) || 'Será um prazer tê-la conosco e proporcionar uma experiência especial ❤️'
WHERE "hoursBefore" = 3 AND "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center');

-- Recontatos: dentro do expediente da clinica (dias e horas), sem janela propria
UPDATE "FollowUpRule" SET "sendWindowStart" = NULL, "sendWindowEnd" = NULL
WHERE "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center');

-- Regras antigas que mandavam informar preco
UPDATE "CustomRule" SET "status" = 'inactive'
WHERE "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center')
  AND ("instruction" LIKE 'Pode informar preço pelo WhatsApp%');

-- Roteiro e mensagem que mandavam passar valor
UPDATE "Playbook" SET "steps" = 'Não informe valores: diga que o investimento é apresentado pela equipe na avaliação gratuita.' || char(10) || 'Faça uma única pergunta curta para entender o procedimento ou a área de interesse.' || char(10) || 'Ofereça a avaliação gratuita e pergunte o melhor dia e turno para a equipe agendar.'
WHERE "name" = 'Pedido de preço sem contexto' AND "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center');
UPDATE "MessageTemplate" SET "body" = 'Claro! 😊 O investimento é apresentado pela nossa equipe na avaliação, que é gratuita e personalizada para o seu caso. Me diz qual procedimento/área você está buscando e qual o melhor dia e turno para você?'
WHERE "name" = 'Resposta a ''quanto custa?''' AND "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center');
