-- Lisboa (decisoes da Aline, 14/10/2026). Mexe so no que ainda esta com o valor/texto antigo EXATO: se alguem editou, nao toca.
-- 1) A Alice informa preco cadastrado e vigente; nao manda mais quem pergunta valor direto para a equipe.
UPDATE "Clinic" SET "handoffOnPrice" = 0, "quotePrices" = 1 WHERE "name" = 'Lisboa Beauty Center';

-- 2) Confirmacao assinada pela Alice (era "Fabi").
UPDATE "ReminderRule" SET "message" = replace("message", 'Aqui é a Fabi', 'Aqui é a Alice')
WHERE "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center') AND "message" LIKE '%Aqui é a Fabi%';

-- 3) Recontatos 4h, 1 dia e 7 dias: a Alice agenda ("a equipe verifica" saiu).
UPDATE "FollowUpRule" SET "message" = 'Oi, {primeiro_nome}! ✨ Passando para saber se ficou alguma dúvida sobre o procedimento. Se quiser, posso ver um horário para você.'
WHERE "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center') AND "message" = 'Oi, {primeiro_nome}! ✨ Passando para saber se ficou alguma dúvida sobre o procedimento. Se quiser, posso encaminhar para nossa equipe verificar os horários ou a condição vigente para você.';

UPDATE "FollowUpRule" SET "message" = 'Oi, {primeiro_nome}! 💗 Conseguiu pensar com calma? Se quiser, posso ver o melhor horário para a sua avaliação gratuita. ✨'
WHERE "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center') AND "message" = 'Oi, {primeiro_nome}! 💗 Conseguiu pensar com calma? Se quiser, nossa equipe verifica o melhor horário para a sua avaliação gratuita. ✨';

UPDATE "FollowUpRule" SET "message" = 'Oi, {primeiro_nome}! ✨ Passando para saber se você ainda tem interesse. Se quiser, posso ver uma condição vigente e o melhor horário para você. 💗'
WHERE "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center') AND "message" = 'Oi, {primeiro_nome}! ✨ Passando para saber se você ainda tem interesse. Se quiser, nossa equipe confirma uma condição vigente e o melhor horário para você. 💗';
