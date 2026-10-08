-- Lisboa: confirmação do dia passa a rodar das 7h às 12h (antes 7h às 10h)
UPDATE "ReminderRule" SET "sendEndHour" = 12
WHERE "dayOffset" = 0 AND "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center');
