-- "Aprendizado da Alice": staging de lições tiradas das conversas. Nada afeta
-- a Alice até um humano aprovar (aprovar promove pra ClinicFaq/CustomRule).
CREATE TABLE "LearningInsight" (
  "id"            TEXT NOT NULL PRIMARY KEY,
  "clinicId"      TEXT NOT NULL,
  "kind"          TEXT NOT NULL,
  "status"        TEXT NOT NULL DEFAULT 'pending',
  "title"         TEXT NOT NULL,
  "trigger"       TEXT NOT NULL DEFAULT '',
  "suggestion"    TEXT NOT NULL,
  "category"      TEXT,
  "targetType"    TEXT,
  "targetId"      TEXT,
  "source"        TEXT NOT NULL,
  "evidenceCount" INTEGER NOT NULL DEFAULT 1,
  "exampleConvId" TEXT,
  "fingerprint"   TEXT NOT NULL DEFAULT '',
  "lastSeenAt"    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt"    DATETIME,
  "reviewedBy"    TEXT,
  "appliedRefId"  TEXT,
  CONSTRAINT "LearningInsight_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "LearningInsight_clinicId_status_idx" ON "LearningInsight"("clinicId", "status");

ALTER TABLE "Clinic" ADD COLUMN "learningRunAt" DATETIME;
