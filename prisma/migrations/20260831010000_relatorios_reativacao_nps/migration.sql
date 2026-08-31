-- Pesquisa de satisfacao (NPS + avaliacao no Google)
ALTER TABLE "Clinic" ADD COLUMN "npsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Clinic" ADD COLUMN "npsHoursAfter" INTEGER NOT NULL DEFAULT 24;
ALTER TABLE "Clinic" ADD COLUMN "npsThreshold" INTEGER NOT NULL DEFAULT 9;
ALTER TABLE "Clinic" ADD COLUMN "npsMessage" TEXT;
ALTER TABLE "Clinic" ADD COLUMN "googleReviewUrl" TEXT;

-- Reativacao de base: config extra da campanha
ALTER TABLE "BroadcastCampaign" ADD COLUMN "targetConfig" TEXT;

CREATE TABLE "SatisfactionSurvey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "appointmentId" TEXT,
    "score" INTEGER,
    "comment" TEXT,
    "askedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" DATETIME,
    "reviewLinkSent" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "SatisfactionSurvey_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SatisfactionSurvey_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "SatisfactionSurvey_clinicId_askedAt_idx" ON "SatisfactionSurvey"("clinicId", "askedAt");
CREATE INDEX "SatisfactionSurvey_patientId_answeredAt_idx" ON "SatisfactionSurvey"("patientId", "answeredAt");
