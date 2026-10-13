-- Mensagem enviada pela clinica (celular/WhatsApp Web) trazia o nome do PROPRIO numero da clinica como "nome do contato", e a
-- paciente era gravada (e salva na agenda do celular) como "Lisboa Beauty Center", "Lisboa Beauty Center 4"... Limpa esses nomes:
-- o nome real entra de novo na proxima mensagem da paciente (ou pelo cadastro) e o contato e salvo outra vez com ele.
UPDATE "Patient"
SET "name" = NULL, "phoneContactName" = NULL
WHERE EXISTS (
  SELECT 1 FROM "Clinic" c
  WHERE c."id" = "Patient"."clinicId"
    AND ("Patient"."name" = c."name"
      OR ("Patient"."name" LIKE c."name" || ' %' AND substr("Patient"."name", length(c."name") + 2) GLOB '[0-9]*'))
);
