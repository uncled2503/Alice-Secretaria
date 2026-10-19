-- Recontatos e retomadas (18/10/2026): controle persistente, diagnostico por rodada, configuracao das retomadas e origem do cancelamento.
-- Nao altera nenhuma regra, mensagem ou dado existente (so colunas novas, anulaveis, e tabelas novas).

ALTER TABLE "Conversation" ADD COLUMN "recontactFingerprint" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "recontactJudgedAt" DATETIME;

ALTER TABLE "Appointment" ADD COLUMN "cancelledAt" DATETIME;
ALTER TABLE "Appointment" ADD COLUMN "cancelSource" TEXT;

CREATE TABLE "FollowUpDispatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "conversationId" TEXT,
    "flow" TEXT NOT NULL,
    "ruleId" TEXT,
    "step" INTEGER NOT NULL DEFAULT 0,
    "cycleKey" TEXT NOT NULL,
    "dueAt" DATETIME,
    "state" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "vetoes" INTEGER NOT NULL DEFAULT 0,
    "deferrals" INTEGER NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "layer" TEXT,
    "reason" TEXT,
    "temporary" BOOLEAN NOT NULL DEFAULT false,
    "reevaluateAt" DATETIME,
    "fingerprint" TEXT,
    "version" TEXT,
    "decidedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "FollowUpDispatch_patientId_flow_step_cycleKey_key" ON "FollowUpDispatch"("patientId", "flow", "step", "cycleKey");
CREATE INDEX "FollowUpDispatch_clinicId_flow_state_decidedAt_idx" ON "FollowUpDispatch"("clinicId", "flow", "state", "decidedAt");
CREATE INDEX "FollowUpDispatch_patientId_createdAt_idx" ON "FollowUpDispatch"("patientId", "createdAt");

CREATE TABLE "AutomationRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "job" TEXT NOT NULL,
    "clinicId" TEXT,
    "startedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME NOT NULL,
    "outcome" TEXT NOT NULL,
    "candidates" INTEGER NOT NULL DEFAULT 0,
    "eligible" INTEGER NOT NULL DEFAULT 0,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "deferred" INTEGER NOT NULL DEFAULT 0,
    "ignored" INTEGER NOT NULL DEFAULT 0,
    "vetoed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "uncertain" INTEGER NOT NULL DEFAULT 0,
    "reasons" TEXT,
    "error" TEXT,
    "version" TEXT
);
CREATE INDEX "AutomationRun_job_clinicId_startedAt_idx" ON "AutomationRun"("job", "clinicId", "startedAt");
CREATE INDEX "AutomationRun_startedAt_idx" ON "AutomationRun"("startedAt");

CREATE TABLE "ResumeFlowConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "flow" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "weekday" INTEGER,
    "startHour" INTEGER,
    "endHour" INTEGER,
    "lookbackDays" INTEGER NOT NULL DEFAULT 7,
    "maxPerRun" INTEGER NOT NULL DEFAULT 10,
    "maxPerDay" INTEGER NOT NULL DEFAULT 20,
    "message" TEXT,
    "enabledAt" DATETIME,
    "updatedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "ResumeFlowConfig_clinicId_flow_key" ON "ResumeFlowConfig"("clinicId", "flow");

CREATE TABLE "ResumeTarget" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "flow" TEXT NOT NULL,
    "note" TEXT,
    "markedBy" TEXT,
    "markedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resultNote" TEXT,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "ResumeTarget_patientId_flow_key" ON "ResumeTarget"("patientId", "flow");
CREATE INDEX "ResumeTarget_clinicId_flow_status_idx" ON "ResumeTarget"("clinicId", "flow", "status");
