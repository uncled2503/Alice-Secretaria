-- Motor de ofertas/campanhas e parcelamento (lote 2, 22/10/2026). Somente colunas anulaveis ou com default CONSTANTE e tabelas novas (compativel com ADD COLUMN do SQLite;
-- nenhuma linha existente muda de significado: origin='todos' e responseMode='alice' sao o comportamento de hoje).
ALTER TABLE "Clinic" ADD COLUMN "installmentMax" INTEGER;
ALTER TABLE "Clinic" ADD COLUMN "installmentMinCents" INTEGER;

ALTER TABLE "Appointment" ADD COLUMN "offerId" TEXT;
ALTER TABLE "Appointment" ADD COLUMN "offerVersion" INTEGER;
ALTER TABLE "Appointment" ADD COLUMN "offerTerms" TEXT;

ALTER TABLE "SpecialDate" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "SpecialDate" ADD COLUMN "promoteFrom" TEXT;
ALTER TABLE "SpecialDate" ADD COLUMN "promoteUntil" TEXT;
ALTER TABLE "SpecialDate" ADD COLUMN "validUntil" TEXT;
ALTER TABLE "SpecialDate" ADD COLUMN "items" TEXT;
ALTER TABLE "SpecialDate" ADD COLUMN "benefits" TEXT;
ALTER TABLE "SpecialDate" ADD COLUMN "quantityLimit" INTEGER;
ALTER TABLE "SpecialDate" ADD COLUMN "audience" TEXT;
ALTER TABLE "SpecialDate" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'todos';
ALTER TABLE "SpecialDate" ADD COLUMN "adSourceIds" TEXT;
ALTER TABLE "SpecialDate" ADD COLUMN "responseMode" TEXT NOT NULL DEFAULT 'alice';
ALTER TABLE "SpecialDate" ADD COLUMN "approvedTexts" TEXT;
ALTER TABLE "SpecialDate" ADD COLUMN "replacedById" TEXT;

-- CreateTable
CREATE TABLE "SpecialDateRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "specialDateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" TEXT NOT NULL,
    "changedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "SpecialDateRevision_specialDateId_version_idx" ON "SpecialDateRevision"("specialDateId", "version");

-- CreateTable
CREATE TABLE "GiftCard" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "specialDateId" TEXT,
    "buyerPatientId" TEXT,
    "buyerName" TEXT NOT NULL,
    "recipientName" TEXT,
    "paidCents" INTEGER NOT NULL,
    "creditCents" INTEGER NOT NULL,
    "usedCents" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'emitido',
    "validUntil" TEXT,
    "restrictions" TEXT,
    "paymentProofId" TEXT,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "GiftCard_clinicId_createdAt_idx" ON "GiftCard"("clinicId", "createdAt");

-- Trocas proibidas por empresa (ex.: Lisboa: Lavieen nao vira carboxiterapia)
ALTER TABLE "Clinic" ADD COLUMN "forbiddenSwaps" TEXT;

-- Banco de respostas a objecoes (aprovado e versionado)
CREATE TABLE "ObjectionAnswer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'rascunho',
    "approvedBy" TEXT,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ObjectionAnswer_clinicId_code_version_key" ON "ObjectionAnswer"("clinicId", "code", "version");
CREATE INDEX "ObjectionAnswer_clinicId_code_status_idx" ON "ObjectionAnswer"("clinicId", "code", "status");

-- Alerta de agenda fraca (48-72h): limite por empresa; null = desligado
ALTER TABLE "Clinic" ADD COLUMN "weakAgendaPct" INTEGER;
