-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN "uazapiToken" TEXT;
ALTER TABLE "Clinic" ADD COLUMN "uazapiBaseUrl" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Clinic_uazapiToken_key" ON "Clinic"("uazapiToken");
