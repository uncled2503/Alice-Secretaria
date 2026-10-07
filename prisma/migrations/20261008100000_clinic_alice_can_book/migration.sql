-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN "aliceCanBook" BOOLEAN NOT NULL DEFAULT true;
UPDATE "Clinic" SET "aliceCanBook" = 0 WHERE "name" = 'Lisboa Beauty Center';
-- Aline e Fabíola são administrativo/comercial e não realizam atendimentos (vieram do catálogo do Clínica Experts como profissionais)
UPDATE "Professional" SET "active" = 0
WHERE "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center')
  AND ("name" LIKE 'Aline%' OR "name" LIKE 'Fab_ola%');
