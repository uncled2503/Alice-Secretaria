/*
  Warnings:

  - You are about to drop the column `uazapiBaseUrl` on the `Clinic` table. All the data in the column will be lost.
  - You are about to drop the column `uazapiToken` on the `Clinic` table. All the data in the column will be lost.

*/
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Clinic" ("createdAt", "id", "name", "timezone", "whatsappPhone", "workEndHour", "workStartHour") SELECT "createdAt", "id", "name", "timezone", "whatsappPhone", "workEndHour", "workStartHour" FROM "Clinic";
DROP TABLE "Clinic";
ALTER TABLE "new_Clinic" RENAME TO "Clinic";
CREATE UNIQUE INDEX "Clinic_whatsappPhone_key" ON "Clinic"("whatsappPhone");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
