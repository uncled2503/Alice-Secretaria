-- Perfil comercial do lead (fase 2 da Lisboa): urgencia, objecoes, recusas, preferencias, sinais de intencao,
-- "sem interesse" e retorno prometido pela propria pessoa.
ALTER TABLE "Patient" ADD COLUMN "urgency" TEXT;
ALTER TABLE "Patient" ADD COLUMN "objections" TEXT;
ALTER TABLE "Patient" ADD COLUMN "refusedProcedures" TEXT;
ALTER TABLE "Patient" ADD COLUMN "preferredProfessional" TEXT;
ALTER TABLE "Patient" ADD COLUMN "preferredPeriod" TEXT;
ALTER TABLE "Patient" ADD COLUMN "preferredDays" TEXT;
ALTER TABLE "Patient" ADD COLUMN "askedPriceAt" DATETIME;
ALTER TABLE "Patient" ADD COLUMN "askedInstallmentsAt" DATETIME;
ALTER TABLE "Patient" ADD COLUMN "askedScheduleAt" DATETIME;
ALTER TABLE "Patient" ADD COLUMN "hotAlertedAt" DATETIME;
ALTER TABLE "Patient" ADD COLUMN "noInterest" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Patient" ADD COLUMN "noInterestAt" DATETIME;
ALTER TABLE "Patient" ADD COLUMN "callbackAt" DATETIME;
ALTER TABLE "Patient" ADD COLUMN "callbackNote" TEXT;

-- Lisboa: liga o relatorio diario e o alerta de lead quente no WhatsApp interno (alem dos avisos que ja estavam ligados).
UPDATE "Clinic"
SET "notifyEvents" = CASE WHEN "notifyEvents" = '' THEN 'daily_report,hot_lead' ELSE "notifyEvents" || ',daily_report,hot_lead' END
WHERE "name" = 'Lisboa Beauty Center'
  AND ',' || "notifyEvents" || ',' NOT LIKE '%,daily_report,%';
