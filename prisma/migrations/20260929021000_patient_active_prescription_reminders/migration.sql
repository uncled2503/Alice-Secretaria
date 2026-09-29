-- CreateTable
CREATE TABLE "PrescriptionReminder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "patientId" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "message" TEXT NOT NULL,
    "sentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PrescriptionReminder_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Patient" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "cpf" TEXT,
    "notes" TEXT,
    "birthDate" DATETIME,
    "funnelStage" TEXT NOT NULL DEFAULT 'novo_lead',
    "optedOut" BOOLEAN NOT NULL DEFAULT false,
    "optedOutAt" DATETIME,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "hasPrescription" BOOLEAN NOT NULL DEFAULT false,
    "metaFbc" TEXT,
    "metaFbp" TEXT,
    "metaFbclid" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "utmContent" TEXT,
    "utmTerm" TEXT,
    "adCampaignName" TEXT,
    "adsetName" TEXT,
    "adName" TEXT,
    "sourceUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "estimatedValue" REAL,
    "leadTemperature" TEXT,
    "assignedToId" TEXT,
    "nextActionAt" DATETIME,
    "nextActionNote" TEXT,
    "crmHidden" BOOLEAN NOT NULL DEFAULT false,
    "contactReason" TEXT,
    "interestNote" TEXT,
    "conversationSummary" TEXT,
    "crmSummaryAt" DATETIME,
    CONSTRAINT "Patient_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Patient_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "StaffUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Patient" ("adCampaignName", "adName", "adsetName", "assignedToId", "birthDate", "clinicId", "contactReason", "conversationSummary", "cpf", "createdAt", "crmHidden", "crmSummaryAt", "email", "estimatedValue", "funnelStage", "id", "interestNote", "leadTemperature", "metaFbc", "metaFbclid", "metaFbp", "name", "nextActionAt", "nextActionNote", "notes", "optedOut", "optedOutAt", "phone", "sourceUrl", "utmCampaign", "utmContent", "utmMedium", "utmSource", "utmTerm") SELECT "adCampaignName", "adName", "adsetName", "assignedToId", "birthDate", "clinicId", "contactReason", "conversationSummary", "cpf", "createdAt", "crmHidden", "crmSummaryAt", "email", "estimatedValue", "funnelStage", "id", "interestNote", "leadTemperature", "metaFbc", "metaFbclid", "metaFbp", "name", "nextActionAt", "nextActionNote", "notes", "optedOut", "optedOutAt", "phone", "sourceUrl", "utmCampaign", "utmContent", "utmMedium", "utmSource", "utmTerm" FROM "Patient";
DROP TABLE "Patient";
ALTER TABLE "new_Patient" RENAME TO "Patient";
CREATE UNIQUE INDEX "Patient_clinicId_phone_key" ON "Patient"("clinicId", "phone");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "PrescriptionReminder_date_sentAt_idx" ON "PrescriptionReminder"("date", "sentAt");
