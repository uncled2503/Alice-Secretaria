ALTER TABLE "Clinic" ADD COLUMN "handoffOnPrice" BOOLEAN NOT NULL DEFAULT false;

-- Lisboa (Aline, 09/10/2026): quem pergunta o valor vai direto pro atendimento humano.
UPDATE "Clinic" SET "handoffOnPrice" = 1 WHERE "name" = 'Lisboa Beauty Center';
