-- Checklist 22/10: classificacao persistente de nao-pacientes, campanha com atendimento humano e datas especiais/recesso.
-- Somente colunas com default CONSTANTE (ou anulaveis) e uma tabela nova: compativel com ADD COLUMN do SQLite (licao do P3018 de 22/10 na migracao dos Disparos).
ALTER TABLE "Patient" ADD COLUMN "contactKind" TEXT NOT NULL DEFAULT 'paciente';
ALTER TABLE "Patient" ADD COLUMN "contactKindDetail" TEXT;
ALTER TABLE "Patient" ADD COLUMN "contactKindSource" TEXT;
ALTER TABLE "Patient" ADD COLUMN "contactKindAt" DATETIME;
ALTER TABLE "Patient" ADD COLUMN "contactKindEvidence" TEXT;

ALTER TABLE "BroadcastCampaign" ADD COLUMN "humanAfterReply" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BroadcastCampaign" ADD COLUMN "humanReplyWindowHours" INTEGER NOT NULL DEFAULT 72;
ALTER TABLE "BroadcastRecipient" ADD COLUMN "repliedAt" DATETIME;

CREATE TABLE "SpecialDate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startsOn" TEXT NOT NULL,
    "endsOn" TEXT,
    "services" TEXT NOT NULL DEFAULT '',
    "conditionText" TEXT,
    "status" TEXT NOT NULL DEFAULT 'rascunho',
    "notes" TEXT,
    "approvedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "SpecialDate_clinicId_kind_name_startsOn_key" ON "SpecialDate"("clinicId", "kind", "name", "startsOn");
CREATE INDEX "SpecialDate_clinicId_startsOn_idx" ON "SpecialDate"("clinicId", "startsOn");
