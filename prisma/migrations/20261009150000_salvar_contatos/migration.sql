ALTER TABLE "Clinic" ADD COLUMN "saveContactsToPhone" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Patient" ADD COLUMN "phoneContactName" TEXT;

-- Lisboa (Aline, 09/10/2026): salvar os contatos na agenda do celular da clinica.
UPDATE "Clinic" SET "saveContactsToPhone" = 1 WHERE "name" = 'Lisboa Beauty Center';
