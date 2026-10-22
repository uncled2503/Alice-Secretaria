-- Aba Disparos (21/10/2026): rastreio do envio, resolucao de telefone, politica de janela e execucoes de recuperacao em lote. Somente colunas/tabelas NOVAS (aditivo).
ALTER TABLE "ReminderDispatch" ADD COLUMN "destination" TEXT;
ALTER TABLE "ReminderDispatch" ADD COLUMN "providerId" TEXT;
ALTER TABLE "ReminderDispatch" ADD COLUMN "attemptedAt" DATETIME;
ALTER TABLE "ReminderDispatch" ADD COLUMN "deliveryState" TEXT;
ALTER TABLE "ReminderDispatch" ADD COLUMN "deliveryAt" DATETIME;
ALTER TABLE "ReminderDispatch" ADD COLUMN "nextAttemptAt" DATETIME;
ALTER TABLE "ReminderDispatch" ADD COLUMN "deadlineAt" DATETIME;
ALTER TABLE "ReminderDispatch" ADD COLUMN "extendedReason" TEXT;
CREATE INDEX "ReminderDispatch_providerId_idx" ON "ReminderDispatch"("providerId");

ALTER TABLE "BirthdaySent" ADD COLUMN "attemptedAt" DATETIME;
ALTER TABLE "BirthdaySent" ADD COLUMN "destination" TEXT;
ALTER TABLE "BirthdaySent" ADD COLUMN "providerId" TEXT;
ALTER TABLE "BirthdaySent" ADD COLUMN "detail" TEXT;
ALTER TABLE "BirthdaySent" ADD COLUMN "deliveryState" TEXT;
ALTER TABLE "BirthdaySent" ADD COLUMN "deliveryAt" DATETIME;
ALTER TABLE "BirthdaySent" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BirthdaySent" ADD COLUMN "nextAttemptAt" DATETIME;
ALTER TABLE "BirthdaySent" ADD COLUMN "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE "PhoneResolution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "originalDigits" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "patientId" TEXT,
    "validatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "PhoneResolution_clinicId_originalDigits_key" ON "PhoneResolution"("clinicId", "originalDigits");
CREATE INDEX "PhoneResolution_clinicId_validatedAt_idx" ON "PhoneResolution"("clinicId", "validatedAt");

CREATE TABLE "DispatchPolicy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "extendEnabled" BOOLEAN NOT NULL DEFAULT true,
    "extendUntil" TEXT,
    "maxExtendMin" INTEGER,
    "minLeadMin" INTEGER,
    "maxAttempts" INTEGER,
    "retryGapMin" INTEGER,
    "maxPerRun" INTEGER,
    "updatedBy" TEXT,
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "DispatchPolicy_clinicId_kind_key" ON "DispatchPolicy"("clinicId", "kind");

CREATE TABLE "DispatchRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "createdBy" TEXT,
    "note" TEXT,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "requested" INTEGER NOT NULL DEFAULT 0,
    "allowed" INTEGER NOT NULL DEFAULT 0,
    "leaseHolder" TEXT,
    "leaseUntil" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME
);
CREATE INDEX "DispatchRun_clinicId_createdAt_idx" ON "DispatchRun"("clinicId", "createdAt");
CREATE INDEX "DispatchRun_state_leaseUntil_idx" ON "DispatchRun"("state", "leaseUntil");

CREATE TABLE "DispatchRunItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "ruleId" TEXT,
    "startsAt" DATETIME,
    "refKey" TEXT NOT NULL,
    "activeKey" TEXT,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "result" TEXT,
    "reason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAt" DATETIME,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    CONSTRAINT "DispatchRunItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DispatchRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DispatchRunItem_activeKey_key" ON "DispatchRunItem"("activeKey");
CREATE UNIQUE INDEX "DispatchRunItem_runId_refKey_key" ON "DispatchRunItem"("runId", "refKey");
CREATE INDEX "DispatchRunItem_runId_state_idx" ON "DispatchRunItem"("runId", "state");
CREATE INDEX "DispatchRunItem_clinicId_state_idx" ON "DispatchRunItem"("clinicId", "state");
