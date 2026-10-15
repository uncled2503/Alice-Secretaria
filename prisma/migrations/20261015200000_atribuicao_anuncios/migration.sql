-- AlterTable
ALTER TABLE "Patient" ADD COLUMN "leadClass" TEXT;
ALTER TABLE "Patient" ADD COLUMN "leadClassAt" DATETIME;

-- CreateTable
CREATE TABLE "AdAttribution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "conversationId" TEXT,
    "messageExternalId" TEXT,
    "receivedAt" DATETIME NOT NULL,
    "sourceId" TEXT,
    "sourceType" TEXT,
    "ctwaClid" TEXT,
    "headline" TEXT,
    "body" TEXT,
    "sourceUrl" TEXT,
    "mediaType" TEXT,
    "platform" TEXT,
    "wabaId" TEXT,
    "rawKeys" TEXT,
    "entryKind" TEXT NOT NULL DEFAULT 'first',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdAttribution_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AdCatalog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "adName" TEXT,
    "adsetName" TEXT,
    "campaignName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "checkedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "LeadClassification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reasonCode" TEXT,
    "reason" TEXT,
    "source" TEXT NOT NULL,
    "confirmed" BOOLEAN NOT NULL DEFAULT true,
    "actorName" TEXT,
    "attributionId" TEXT,
    "metaStatus" TEXT,
    "metaEventId" TEXT,
    "supersededAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" DATETIME,
    CONSTRAINT "LeadClassification_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Colunas novas por ALTER TABLE simples (sem recriar tabelas): a producao tem dados e o SQLite aceita ADD COLUMN com valor padrao.
-- Clinic: criterios de qualificacao (configuraveis por cliente)
ALTER TABLE "Clinic" ADD COLUMN "qualificationCriteria" TEXT;
ALTER TABLE "Clinic" ADD COLUMN "qualificationAi" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Clinic" ADD COLUMN "qualificationAutoApprove" BOOLEAN NOT NULL DEFAULT false;
-- MetaConfig: API de Conversoes para mensagens comerciais (WhatsApp) - desligada por padrao
ALTER TABLE "MetaConfig" ADD COLUMN "messagingEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "MetaConfig" ADD COLUMN "wabaId" TEXT;
ALTER TABLE "MetaConfig" ADD COLUMN "messagingDatasetId" TEXT;
-- MetaEvent: canal do evento (os historicos ficam como "website")
ALTER TABLE "MetaEvent" ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'website';
-- Tag: etiqueta automatica do sistema
ALTER TABLE "Tag" ADD COLUMN "system" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "AdAttribution_patientId_receivedAt_idx" ON "AdAttribution"("patientId", "receivedAt");

-- CreateIndex
CREATE INDEX "AdAttribution_clinicId_sourceId_idx" ON "AdAttribution"("clinicId", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdAttribution_clinicId_messageExternalId_key" ON "AdAttribution"("clinicId", "messageExternalId");

-- CreateIndex
CREATE UNIQUE INDEX "AdCatalog_clinicId_sourceId_key" ON "AdCatalog"("clinicId", "sourceId");

-- CreateIndex
CREATE INDEX "LeadClassification_patientId_createdAt_idx" ON "LeadClassification"("patientId", "createdAt");

-- CreateIndex
CREATE INDEX "LeadClassification_clinicId_confirmed_createdAt_idx" ON "LeadClassification"("clinicId", "confirmed", "createdAt");
