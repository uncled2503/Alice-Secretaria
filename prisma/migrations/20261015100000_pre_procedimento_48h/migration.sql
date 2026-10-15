-- Lisboa (Aline, 15/10/2026): as recomendacoes de preparo so saiam NO DIA (logo apos a cliente confirmar). Passam a sair SEMPRE 48 horas antes
-- do atendimento (job em reminders/preProcedure.ts). Quem ja recebeu (PreProcedureSent) nao recebe de novo ao confirmar.
ALTER TABLE "PreProcedureRule" ADD COLUMN "sendHoursBefore" INTEGER;

UPDATE "PreProcedureRule" SET "sendHoursBefore" = 48
WHERE "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center');
