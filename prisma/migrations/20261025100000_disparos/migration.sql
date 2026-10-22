-- Aba Disparos (21/10/2026): rastreio do envio, resolucao de telefone, politica de janela e execucoes de recuperacao em lote. Colunas/tabelas NOVAS; unica reconstrucao: BirthdaySent (ver abaixo). Nenhuma linha existente e perdida.
ALTER TABLE "ReminderDispatch" ADD COLUMN "destination" TEXT;
ALTER TABLE "ReminderDispatch" ADD COLUMN "providerId" TEXT;
ALTER TABLE "ReminderDispatch" ADD COLUMN "attemptedAt" DATETIME;
ALTER TABLE "ReminderDispatch" ADD COLUMN "deliveryState" TEXT;
ALTER TABLE "ReminderDispatch" ADD COLUMN "deliveryAt" DATETIME;
ALTER TABLE "ReminderDispatch" ADD COLUMN "nextAttemptAt" DATETIME;
ALTER TABLE "ReminderDispatch" ADD COLUMN "deadlineAt" DATETIME;
ALTER TABLE "ReminderDispatch" ADD COLUMN "extendedReason" TEXT;
CREATE INDEX "ReminderDispatch_providerId_idx" ON "ReminderDispatch"("providerId");

-- BirthdaySent: RECONSTRUCAO da tabela (RedefineTables), nao ALTER TABLE ... ADD COLUMN.
-- Motivo (hotfix 22/10/2026): o SQLite NAO aceita ADD COLUMN com default nao constante. A coluna "updatedAt" precisa de NOT NULL DEFAULT CURRENT_TIMESTAMP
-- (@default(now()) @updatedAt) e a versao anterior desta migracao falhou aqui com P3018 ("Cannot add a column with non-constant default"), depois de aplicar
-- as colunas anteriores. A tabela e refeita copiando TODAS as linhas e identificadores; "updatedAt" das linhas antigas recebe o proprio "sentAt" (a ultima
-- alteracao conhecida delas), nunca uma data fixa inventada. Linhas antigas ficam com attempts = 0 (registro anterior ao controle por tentativa).
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_BirthdaySent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "state" TEXT NOT NULL DEFAULT 'legacy',
    "patientId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attemptedAt" DATETIME,
    "destination" TEXT,
    "providerId" TEXT,
    "detail" TEXT,
    "deliveryState" TEXT,
    "deliveryAt" DATETIME,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BirthdaySent_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BirthdaySent_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "BirthdayRule" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_BirthdaySent" ("id", "state", "patientId", "ruleId", "year", "sentAt", "updatedAt") SELECT "id", "state", "patientId", "ruleId", "year", "sentAt", "sentAt" FROM "BirthdaySent";
DROP TABLE "BirthdaySent";
ALTER TABLE "new_BirthdaySent" RENAME TO "BirthdaySent";
CREATE UNIQUE INDEX "BirthdaySent_patientId_ruleId_year_key" ON "BirthdaySent"("patientId", "ruleId", "year");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

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
