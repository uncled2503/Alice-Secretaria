-- Aba Feriados: por padrao toda clinica fecha nos feriados nacionais; ela marca os que abre.
ALTER TABLE "Clinic" ADD COLUMN "holidayOpen" TEXT NOT NULL DEFAULT '';
UPDATE "Clinic" SET "closedOnHolidays" = 1 WHERE "businessType" = 'clinica';
