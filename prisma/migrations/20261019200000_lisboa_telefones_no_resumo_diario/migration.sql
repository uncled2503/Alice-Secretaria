-- Lisboa (19/10/2026): quer os telefones dos leads no resumo diario das 20h. So dados: acrescenta o aviso "daily_report_phones" a lista de avisos da Lisboa (o resumo continua indo ao
-- MESMO numero interno de sempre; nenhuma outra clinica muda). Idempotente: nao repete se ja estiver.
UPDATE "Clinic"
SET "notifyEvents" = CASE WHEN "notifyEvents" = '' THEN 'daily_report_phones' ELSE "notifyEvents" || ',daily_report_phones' END
WHERE "name" = 'Lisboa Beauty Center'
  AND ',' || "notifyEvents" || ',' NOT LIKE '%,daily_report_phones,%';
