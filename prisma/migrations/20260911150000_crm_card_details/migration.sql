-- Card do CRM (modal de detalhes do lead): campos comerciais + timeline por
-- paciente. Tudo aditivo - nao mexe em dado nem indice existente.

-- AlterTable: Patient ganha os campos do card (valor, temperatura, responsavel,
-- proxima acao, "remover do CRM").
ALTER TABLE "Patient" ADD COLUMN "estimatedValue" REAL;
ALTER TABLE "Patient" ADD COLUMN "leadTemperature" TEXT;
ALTER TABLE "Patient" ADD COLUMN "assignedToId" TEXT REFERENCES "StaffUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Patient" ADD COLUMN "nextActionAt" DATETIME;
ALTER TABLE "Patient" ADD COLUMN "nextActionNote" TEXT;
ALTER TABLE "Patient" ADD COLUMN "crmHidden" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: ActivityLog ganha patientId opcional - alimenta a timeline do card.
ALTER TABLE "ActivityLog" ADD COLUMN "patientId" TEXT REFERENCES "Patient" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "ActivityLog_patientId_createdAt_idx" ON "ActivityLog"("patientId", "createdAt");
