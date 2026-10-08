-- Correcao: Aline e Fabiola ATENDEM na clinica (so nao sao "Dra." por nao serem medicas).
UPDATE "Professional" SET "active" = 1, "title" = NULL
WHERE "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center')
  AND ("name" LIKE 'Aline%' OR "name" LIKE 'Fab_ola%');

-- Regra antiga dizia que Aline/Brenda/Fabi nao atendem: desativa
UPDATE "CustomRule" SET "status" = 'inactive'
WHERE "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center')
  AND "instruction" LIKE 'Aline, Brenda e Fabi são da equipe administrativa%';
