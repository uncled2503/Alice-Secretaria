ALTER TABLE "Conversation" ADD COLUMN "unansweredAlertAt" DATETIME;
ALTER TABLE "Professional" ADD COLUMN "title" TEXT;

-- Lisboa: so Sabrina e Amanda sao "Dra." (biomedicas); as demais ficam so pelo nome
UPDATE "Professional" SET "title" = 'Dra.'
WHERE "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center')
  AND ("name" LIKE 'Sabrina%' OR "name" LIKE 'Amanda%');

-- Lisboa: formas de pagamento da clinica (Pix, credito e debito) nos procedimentos que ainda estao sem nada
UPDATE "Procedure" SET "paymentMethods" = 'pix,credito,debito'
WHERE "paymentMethods" = '' AND "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center');
