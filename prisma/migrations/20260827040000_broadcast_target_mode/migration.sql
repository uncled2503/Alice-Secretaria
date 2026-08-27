-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_BroadcastCampaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "targetStage" TEXT,
    "targetMode" TEXT NOT NULL DEFAULT 'all',
    "scheduledFor" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BroadcastCampaign_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_BroadcastCampaign" ("clinicId", "createdAt", "id", "message", "scheduledFor", "status", "targetStage", "title") SELECT "clinicId", "createdAt", "id", "message", "scheduledFor", "status", "targetStage", "title" FROM "BroadcastCampaign";
DROP TABLE "BroadcastCampaign";
ALTER TABLE "new_BroadcastCampaign" RENAME TO "BroadcastCampaign";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;


-- Backfill: campanhas antigas com targetStage preenchido eram por etapa do funil.
UPDATE "BroadcastCampaign" SET "targetMode" = 'stage' WHERE "targetStage" IS NOT NULL;
