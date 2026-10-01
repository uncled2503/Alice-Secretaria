-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Clinic" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "whatsappPhone" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    "workStartHour" INTEGER NOT NULL DEFAULT 9,
    "workEndHour" INTEGER NOT NULL DEFAULT 19,
    "lunchStartHour" INTEGER,
    "lunchEndHour" INTEGER,
    "workStartMinute" INTEGER NOT NULL DEFAULT 0,
    "workEndMinute" INTEGER NOT NULL DEFAULT 0,
    "lunchStartMinute" INTEGER NOT NULL DEFAULT 0,
    "lunchEndMinute" INTEGER NOT NULL DEFAULT 0,
    "workDays" TEXT NOT NULL DEFAULT '1,2,3,4,5,6',
    "closedOnHolidays" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notifyPhone" TEXT,
    "notifyEvents" TEXT NOT NULL DEFAULT '',
    "uazapiBaseUrl" TEXT,
    "uazapiToken" TEXT,
    "assistantPersona" TEXT NOT NULL DEFAULT 'team',
    "assistantPersonaName" TEXT,
    "assistantName" TEXT NOT NULL DEFAULT 'Alice',
    "activityArea" TEXT,
    "handoffPhrase" TEXT,
    "splitLongMessages" BOOLEAN NOT NULL DEFAULT true,
    "splitMaxMessages" INTEGER NOT NULL DEFAULT 4,
    "splitThresholdChars" INTEGER NOT NULL DEFAULT 450,
    "replyDelaySeconds" INTEGER NOT NULL DEFAULT 0,
    "requireDepositProof" BOOLEAN NOT NULL DEFAULT false,
    "businessType" TEXT NOT NULL DEFAULT 'clinica',
    "businessLabel" TEXT,
    "servicePosture" TEXT NOT NULL DEFAULT 'comercial',
    "clinicKind" TEXT NOT NULL DEFAULT 'estetica',
    "evaluationFirst" BOOLEAN NOT NULL DEFAULT false,
    "allowEmojis" BOOLEAN NOT NULL DEFAULT true,
    "schedulingLink" TEXT,
    "npsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "npsHoursAfter" INTEGER NOT NULL DEFAULT 24,
    "npsThreshold" INTEGER NOT NULL DEFAULT 9,
    "npsMessage" TEXT,
    "googleReviewUrl" TEXT,
    "importStatus" TEXT,
    "importStats" TEXT,
    "importUpdatedAt" DATETIME,
    "plan" TEXT NOT NULL DEFAULT 'prime',
    "planActivatedAt" DATETIME,
    "planExpiresAt" DATETIME,
    "planExpiryNotified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "learningRunAt" DATETIME,
    "conversationLimitOverride" INTEGER,
    "usageMonth" TEXT NOT NULL DEFAULT '',
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "usageLimitNotified" BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO "new_Clinic" ("active", "activityArea", "allowEmojis", "assistantName", "assistantPersona", "assistantPersonaName", "businessLabel", "businessType", "clinicKind", "closedOnHolidays", "conversationLimitOverride", "createdAt", "evaluationFirst", "googleReviewUrl", "handoffPhrase", "id", "importStats", "importStatus", "importUpdatedAt", "learningRunAt", "lunchEndHour", "lunchStartHour", "name", "notifyEvents", "notifyPhone", "npsEnabled", "npsHoursAfter", "npsMessage", "npsThreshold", "plan", "planActivatedAt", "planExpiresAt", "planExpiryNotified", "replyDelaySeconds", "requireDepositProof", "schedulingLink", "servicePosture", "splitLongMessages", "splitMaxMessages", "splitThresholdChars", "timezone", "uazapiBaseUrl", "uazapiToken", "usageCount", "usageLimitNotified", "usageMonth", "whatsappPhone", "workDays", "workEndHour", "workStartHour") SELECT "active", "activityArea", "allowEmojis", "assistantName", "assistantPersona", "assistantPersonaName", "businessLabel", "businessType", "clinicKind", "closedOnHolidays", "conversationLimitOverride", "createdAt", "evaluationFirst", "googleReviewUrl", "handoffPhrase", "id", "importStats", "importStatus", "importUpdatedAt", "learningRunAt", "lunchEndHour", "lunchStartHour", "name", "notifyEvents", "notifyPhone", "npsEnabled", "npsHoursAfter", "npsMessage", "npsThreshold", "plan", "planActivatedAt", "planExpiresAt", "planExpiryNotified", "replyDelaySeconds", "requireDepositProof", "schedulingLink", "servicePosture", "splitLongMessages", "splitMaxMessages", "splitThresholdChars", "timezone", "uazapiBaseUrl", "uazapiToken", "usageCount", "usageLimitNotified", "usageMonth", "whatsappPhone", "workDays", "workEndHour", "workStartHour" FROM "Clinic";
DROP TABLE "Clinic";
ALTER TABLE "new_Clinic" RENAME TO "Clinic";
CREATE UNIQUE INDEX "Clinic_whatsappPhone_key" ON "Clinic"("whatsappPhone");
CREATE UNIQUE INDEX "Clinic_uazapiToken_key" ON "Clinic"("uazapiToken");
CREATE TABLE "new_Professional" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "instagram" TEXT,
    "bio" TEXT,
    "color" TEXT,
    "photoUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "workDays" TEXT,
    "workStartHour" INTEGER,
    "workEndHour" INTEGER,
    "lunchStartHour" INTEGER,
    "lunchEndHour" INTEGER,
    "workStartMinute" INTEGER NOT NULL DEFAULT 0,
    "workEndMinute" INTEGER NOT NULL DEFAULT 0,
    "lunchStartMinute" INTEGER NOT NULL DEFAULT 0,
    "lunchEndMinute" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Professional_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Professional" ("active", "bio", "clinicId", "color", "createdAt", "id", "instagram", "lunchEndHour", "lunchStartHour", "name", "photoUrl", "workDays", "workEndHour", "workStartHour") SELECT "active", "bio", "clinicId", "color", "createdAt", "id", "instagram", "lunchEndHour", "lunchStartHour", "name", "photoUrl", "workDays", "workEndHour", "workStartHour" FROM "Professional";
DROP TABLE "Professional";
ALTER TABLE "new_Professional" RENAME TO "Professional";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
