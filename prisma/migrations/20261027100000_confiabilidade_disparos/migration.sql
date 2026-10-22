-- Confiabilidade dos disparos (22/10/2026): texto exato da tentativa, controle persistente da renovacao e do retorno combinado, tentativa por destinatario de campanha.
-- SOMENTE colunas anulaveis ou com default CONSTANTE e uma tabela nova (compativel com ADD COLUMN do SQLite; licao do P3018 dos Disparos). Linhas antigas de RenewalSent ficam 'legacy' (continuam consumidas).
ALTER TABLE "ReminderDispatch" ADD COLUMN "messageText" TEXT;
ALTER TABLE "BirthdaySent" ADD COLUMN "messageText" TEXT;

ALTER TABLE "RenewalSent" ADD COLUMN "state" TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE "RenewalSent" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RenewalSent" ADD COLUMN "attemptedAt" DATETIME;
ALTER TABLE "RenewalSent" ADD COLUMN "acceptedAt" DATETIME;
ALTER TABLE "RenewalSent" ADD COLUMN "providerId" TEXT;
ALTER TABLE "RenewalSent" ADD COLUMN "destination" TEXT;
ALTER TABLE "RenewalSent" ADD COLUMN "detail" TEXT;
ALTER TABLE "RenewalSent" ADD COLUMN "messageText" TEXT;
ALTER TABLE "RenewalSent" ADD COLUMN "nextAttemptAt" DATETIME;
ALTER TABLE "RenewalSent" ADD COLUMN "deliveryState" TEXT;
ALTER TABLE "RenewalSent" ADD COLUMN "deliveryAt" DATETIME;
ALTER TABLE "RenewalSent" ADD COLUMN "updatedAt" DATETIME;

ALTER TABLE "BroadcastRecipient" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BroadcastRecipient" ADD COLUMN "attemptedAt" DATETIME;
ALTER TABLE "BroadcastRecipient" ADD COLUMN "providerId" TEXT;
ALTER TABLE "BroadcastRecipient" ADD COLUMN "destination" TEXT;
ALTER TABLE "BroadcastRecipient" ADD COLUMN "detail" TEXT;
ALTER TABLE "BroadcastRecipient" ADD COLUMN "messageText" TEXT;
ALTER TABLE "BroadcastRecipient" ADD COLUMN "nextAttemptAt" DATETIME;
ALTER TABLE "BroadcastRecipient" ADD COLUMN "deliveryState" TEXT;
ALTER TABLE "BroadcastRecipient" ADD COLUMN "deliveryAt" DATETIME;
ALTER TABLE "BroadcastRecipient" ADD COLUMN "updatedAt" DATETIME;

CREATE TABLE "CallbackDispatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "dueAt" DATETIME NOT NULL,
    "note" TEXT,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "attemptedAt" DATETIME,
    "providerId" TEXT,
    "destination" TEXT,
    "detail" TEXT,
    "messageText" TEXT,
    "nextAttemptAt" DATETIME,
    "deliveryState" TEXT,
    "deliveryAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME
);
CREATE UNIQUE INDEX "CallbackDispatch_patientId_dueAt_key" ON "CallbackDispatch"("patientId", "dueAt");
CREATE INDEX "CallbackDispatch_clinicId_state_idx" ON "CallbackDispatch"("clinicId", "state");
