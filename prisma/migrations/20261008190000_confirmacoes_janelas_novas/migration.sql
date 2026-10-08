-- Lisboa: confirmação do dia seguinte das 8h às 11h; confirmação do dia das 7h às 8h
UPDATE "ReminderRule" SET "sendHour" = 8, "sendMinute" = 0, "sendEndHour" = 11
WHERE "dayOffset" = 1 AND "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center');
UPDATE "ReminderRule" SET "sendHour" = 7, "sendMinute" = 0, "sendEndHour" = 8
WHERE "dayOffset" = 0 AND "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center');
