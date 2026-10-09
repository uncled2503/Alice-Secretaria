ALTER TABLE "Clinic" ADD COLUMN "silentHandoff" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Clinic" ADD COLUMN "humanizedTone" BOOLEAN NOT NULL DEFAULT false;

-- Lisboa (Aline, 09/10/2026): atendimento humano e natural; sem avisar "vou transferir", fica em silencio.
UPDATE "Clinic" SET "silentHandoff" = 1, "humanizedTone" = 1 WHERE "name" = 'Lisboa Beauty Center';

-- Regras/mensagens antigas que mandavam anunciar transferencia ou se apresentar como assistente virtual:
UPDATE "CustomRule" SET "status" = 'inactive'
WHERE "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center')
  AND ("instruction" LIKE 'Se não souber ou não tiver informação segura, admita e encaminhe%'
    OR "instruction" LIKE 'Fora do horário da equipe, diga:%'
    OR "instruction" LIKE 'A Alice se identifica como assistente virtual%');
UPDATE "MessageTemplate" SET "active" = 0
WHERE "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center')
  AND "name" = 'Fora do horário de atendimento';
