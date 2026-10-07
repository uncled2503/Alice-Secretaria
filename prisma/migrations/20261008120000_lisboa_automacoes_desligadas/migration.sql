-- Lisboa: a primeira versão do seed criou o lembrete de 24h e o aniversário LIGADOS.
-- Desliga uma vez no deploy; a clínica liga de propósito depois de conectar o número e validar.
UPDATE "ReminderRule" SET "active" = 0
WHERE "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center');
UPDATE "BirthdayRule" SET "active" = 0
WHERE "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center');
UPDATE "FollowUpRule" SET "active" = 0
WHERE "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center');
