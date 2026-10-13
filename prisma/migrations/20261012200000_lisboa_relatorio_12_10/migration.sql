-- Etiqueta de origem do lead no CRM (ligavel por clinica)
ALTER TABLE "Clinic" ADD COLUMN "tagLeadOrigin" BOOLEAN NOT NULL DEFAULT false;

-- Lisboa Beauty Center - relatorio consolidado de 12/10/2026:
--  * a Alice volta a agendar (com aviso a equipe a cada agendamento: nome, procedimento, data e horario);
--  * a Alice volta a informar valores (os cadastrados e, nos leads de anuncio, o do proprio anuncio);
--  * pergunta de valor deixa de ir direto pro atendimento humano;
--  * etiqueta "Lead <campanha> | data" nos contatos novos.
UPDATE "Clinic"
SET "aliceCanBook" = 1, "quotePrices" = 1, "handoffOnPrice" = 0, "tagLeadOrigin" = 1
WHERE "name" = 'Lisboa Beauty Center';

-- O aviso interno de novo agendamento precisa estar ligado (nome, procedimento, data e hora ja vao no texto).
UPDATE "Clinic"
SET "notifyEvents" = CASE WHEN "notifyEvents" = '' THEN 'new_appointment' ELSE "notifyEvents" || ',new_appointment' END
WHERE "name" = 'Lisboa Beauty Center'
  AND ',' || "notifyEvents" || ',' NOT LIKE '%,new_appointment,%';

-- Reconfirmacao (quem nao confirmou o dia seguinte): das 17h as 18h (antes 16h-17h).
UPDATE "ReminderRule"
SET "sendHour" = 17, "sendMinute" = 0, "sendEndHour" = 18, "scheduledChange" = NULL
WHERE "parentRuleId" IS NOT NULL
  AND "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center');

-- Recontatos: oferece os resultados (antes/depois) do procedimento. A mensagem de encerramento e as que ja citam
-- "resultado" ficam como estao.
UPDATE "FollowUpRule"
SET "message" = "message" || char(10) || char(10) || 'Posso te enviar alguns resultados desse procedimento? 💗'
WHERE "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center')
  AND lower("message") NOT LIKE '%resultado%'
  AND lower("message") NOT LIKE '%encerrar%';
