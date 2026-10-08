ALTER TABLE "ReminderRule" ADD COLUMN "parentRuleId" TEXT;

-- Lisboa: quem recebeu a confirmacao do dia seguinte e nao respondeu recebe, as 16h do dia anterior, um novo pedido de confirmacao.
INSERT INTO "ReminderRule" ("id", "clinicId", "hoursBefore", "dayOffset", "sendHour", "sendMinute", "sendEndHour", "pauseMinSec", "pauseMaxSec", "parentRuleId", "message", "active")
SELECT lower(hex(randomblob(12))), r."clinicId", 24, 1, 16, 0, 17, 10, 30, r."id",
  'Olá, {primeiro_nome}! 💗 Tudo bem?' || char(10) || 'Passando para lembrar que ainda não recebemos a sua confirmação para o seu agendamento de amanhã:' || char(10) || '' || char(10) || '📅 Data: {data} (amanhã)' || char(10) || '⏰ Horário: {hora}' || char(10) || '💆 Procedimento: {procedimento}' || char(10) || '' || char(10) || 'Pode nos confirmar a sua presença? ✨' || char(10) || 'Em caso de imprevisto, pedimos a gentileza de avisar com antecedência para reagendarmos 💖',
  1
FROM "ReminderRule" r
WHERE r."dayOffset" = 1 AND r."parentRuleId" IS NULL
  AND r."clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center')
  AND NOT EXISTS (SELECT 1 FROM "ReminderRule" c WHERE c."parentRuleId" = r."id");
