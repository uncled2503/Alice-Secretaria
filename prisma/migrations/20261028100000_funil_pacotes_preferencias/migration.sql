-- Fases 2/3 do checklist mestre (22/10/2026): preferencias (promocional x operacional), autorizacao de imagem, motivo estruturado de perda/cancelamento, lista de espera estruturada,
-- proposta aberta, pacote de sessoes (fonte interna) e comprovante de pagamento. Somente colunas anulaveis/default CONSTANTE e tabelas novas (compativel com ADD COLUMN do SQLite).
ALTER TABLE "Patient" ADD COLUMN "promoOptOut" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Patient" ADD COLUMN "promoOptOutAt" DATETIME;
ALTER TABLE "Patient" ADD COLUMN "imageConsent" TEXT;
ALTER TABLE "Patient" ADD COLUMN "imageConsentScope" TEXT;
ALTER TABLE "Patient" ADD COLUMN "imageConsentSource" TEXT;
ALTER TABLE "Patient" ADD COLUMN "imageConsentAt" DATETIME;
ALTER TABLE "Patient" ADD COLUMN "lossReasonCode" TEXT;
ALTER TABLE "Patient" ADD COLUMN "lossReasonNote" TEXT;
ALTER TABLE "Patient" ADD COLUMN "lossReasonAt" DATETIME;

ALTER TABLE "Appointment" ADD COLUMN "cancelReasonCode" TEXT;

ALTER TABLE "WaitlistEntry" ADD COLUMN "days" TEXT;
ALTER TABLE "WaitlistEntry" ADD COLUMN "shifts" TEXT;
ALTER TABLE "WaitlistEntry" ADD COLUMN "minLeadHours" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WaitlistEntry" ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WaitlistEntry" ADD COLUMN "validUntil" DATETIME;
ALTER TABLE "WaitlistEntry" ADD COLUMN "offeredSlotAt" DATETIME;

CREATE TABLE "Proposal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "itemsJson" TEXT NOT NULL DEFAULT '[]',
    "totalValue" REAL,
    "validUntil" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'aberta',
    "objectionCode" TEXT,
    "note" TEXT,
    "createdBy" TEXT,
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "Proposal_clinicId_status_idx" ON "Proposal"("clinicId", "status");
CREATE INDEX "Proposal_patientId_status_idx" ON "Proposal"("patientId", "status");

CREATE TABLE "PatientPackage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "procedureId" TEXT,
    "name" TEXT NOT NULL,
    "totalSessions" INTEGER NOT NULL,
    "startsAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'ativo',
    "source" TEXT NOT NULL DEFAULT 'interno',
    "createdBy" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "PatientPackage_clinicId_status_idx" ON "PatientPackage"("clinicId", "status");
CREATE INDEX "PatientPackage_patientId_status_idx" ON "PatientPackage"("patientId", "status");

CREATE TABLE "PackageUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "packageId" TEXT NOT NULL,
    "usedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appointmentId" TEXT,
    "recordedBy" TEXT,
    "note" TEXT,
    CONSTRAINT "PackageUsage_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "PatientPackage" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PackageUsage_packageId_usedAt_idx" ON "PackageUsage"("packageId", "usedAt");

CREATE TABLE "PaymentProof" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "appointmentId" TEXT,
    "messageId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'recebido',
    "amountClaimed" REAL,
    "checkedBy" TEXT,
    "checkedAt" DATETIME,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "PaymentProof_clinicId_status_idx" ON "PaymentProof"("clinicId", "status");
