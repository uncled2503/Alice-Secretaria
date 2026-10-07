-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN "ceBookingUuid" TEXT;

-- AlterTable
ALTER TABLE "Patient" ADD COLUMN "ceUuid" TEXT;

-- AlterTable
ALTER TABLE "Procedure" ADD COLUMN "ceId" INTEGER;

-- AlterTable
ALTER TABLE "Professional" ADD COLUMN "ceUuid" TEXT;

-- CreateTable
CREATE TABLE "ClinicaExpertsAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "tokenEnc" TEXT NOT NULL,
    "tokenHint" TEXT,
    "syncOut" BOOLEAN NOT NULL DEFAULT true,
    "blockBusy" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncAt" DATETIME,
    "lastCatalogAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClinicaExpertsAccount_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ClinicaExpertsAccount_clinicId_key" ON "ClinicaExpertsAccount"("clinicId");
