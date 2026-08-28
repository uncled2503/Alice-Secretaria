-- Ajustes da Alice
ALTER TABLE "Clinic" ADD COLUMN "assistantName" TEXT NOT NULL DEFAULT 'Alice';
ALTER TABLE "Clinic" ADD COLUMN "activityArea" TEXT;
ALTER TABLE "Clinic" ADD COLUMN "handoffPhrase" TEXT;
ALTER TABLE "Clinic" ADD COLUMN "splitLongMessages" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Clinic" ADD COLUMN "splitMaxMessages" INTEGER NOT NULL DEFAULT 4;
ALTER TABLE "Clinic" ADD COLUMN "splitThresholdChars" INTEGER NOT NULL DEFAULT 450;
ALTER TABLE "Clinic" ADD COLUMN "requireDepositProof" BOOLEAN NOT NULL DEFAULT false;

-- Mensagens prontas
CREATE TABLE "MessageTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'adapt',
    "whenToUse" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MessageTemplate_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- FAQ da clinica
CREATE TABLE "ClinicFaq" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "alternates" TEXT NOT NULL DEFAULT '',
    "exactAnswer" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClinicFaq_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Roteiros
CREATE TABLE "Playbook" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scriptType" TEXT NOT NULL DEFAULT 'livre',
    "triggerText" TEXT,
    "goal" TEXT,
    "steps" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Playbook_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
