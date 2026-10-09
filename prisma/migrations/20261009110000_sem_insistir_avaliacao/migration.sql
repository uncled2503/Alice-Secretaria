ALTER TABLE "Clinic" ADD COLUMN "softSell" BOOLEAN NOT NULL DEFAULT false;

-- Lisboa (Aline, 08/10/2026): a Alice repetia a oferta de avaliacao a cada resposta.
UPDATE "Clinic" SET "softSell" = 1 WHERE "name" = 'Lisboa Beauty Center';

-- Regras antigas que mandavam empurrar avaliacao / dia e turno em resposta de preco:
UPDATE "CustomRule" SET "status" = 'inactive'
WHERE "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center')
  AND ("instruction" LIKE 'NUNCA informe valores, faixas de preço%'
    OR "instruction" LIKE 'Quando o paciente achar caro, pedir desconto%'
    OR "instruction" LIKE 'Depois de informar valores, não pare%');
