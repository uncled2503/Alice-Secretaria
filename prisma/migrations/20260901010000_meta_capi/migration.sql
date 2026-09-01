-- Integracao com a Meta (Pixel + API de Conversoes). Configuracao por clinica,
-- fila de eventos do servidor com deduplicacao e auditoria.

-- Configuracao da Meta de cada clinica (1:1). O token da API de Conversoes
-- fica criptografado em accessTokenEnc (nunca volta pro navegador).
CREATE TABLE "MetaConfig" (
  "id"                TEXT NOT NULL PRIMARY KEY,
  "clinicId"          TEXT NOT NULL,
  "name"              TEXT NOT NULL DEFAULT '',
  "pixelId"           TEXT,
  "accessTokenEnc"    TEXT,
  "tokenHint"         TEXT,
  "graphVersion"      TEXT NOT NULL DEFAULT 'v21.0',
  "siteUrl"           TEXT,
  "testEventCode"     TEXT,
  "pixelEnabled"      BOOLEAN NOT NULL DEFAULT false,
  "capiEnabled"       BOOLEAN NOT NULL DEFAULT false,
  "stageQualified"    TEXT,
  "stageDisqualified" TEXT,
  "stageWon"          TEXT,
  "stageLost"         TEXT,
  "stagesIgnored"     TEXT NOT NULL DEFAULT '',
  "lastTestAt"        DATETIME,
  "lastTestResult"    TEXT,
  "createdAt"         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         DATETIME NOT NULL,
  CONSTRAINT "MetaConfig_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "MetaConfig_clinicId_key" ON "MetaConfig"("clinicId");

-- Fila de saida + registro auditavel dos eventos enviados pra Meta. O par
-- (clinicId, eventId) e unico: essa e a garantia de idempotencia/deduplicacao.
CREATE TABLE "MetaEvent" (
  "id"            TEXT NOT NULL PRIMARY KEY,
  "clinicId"      TEXT NOT NULL,
  "eventId"       TEXT NOT NULL,
  "eventName"     TEXT NOT NULL,
  "source"        TEXT NOT NULL DEFAULT 'server',
  "leadId"        TEXT,
  "payload"       TEXT NOT NULL,
  "status"        TEXT NOT NULL DEFAULT 'pending',
  "attempts"      INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" DATETIME,
  "lastError"     TEXT,
  "metaResponse"  TEXT,
  "testEventCode" TEXT,
  "createdAt"     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt"   DATETIME,
  CONSTRAINT "MetaEvent_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "MetaEvent_clinicId_eventId_key" ON "MetaEvent"("clinicId", "eventId");
CREATE INDEX "MetaEvent_status_nextAttemptAt_idx" ON "MetaEvent"("status", "nextAttemptAt");
CREATE INDEX "MetaEvent_clinicId_createdAt_idx" ON "MetaEvent"("clinicId", "createdAt");

-- Atribuicao de campanha preservada no lead, pra eventos posteriores do CRM
-- terem boa correspondencia com o anuncio de origem (Click-to-WhatsApp).
ALTER TABLE "Patient" ADD COLUMN "metaFbc"        TEXT;
ALTER TABLE "Patient" ADD COLUMN "metaFbp"        TEXT;
ALTER TABLE "Patient" ADD COLUMN "metaFbclid"     TEXT;
ALTER TABLE "Patient" ADD COLUMN "utmSource"      TEXT;
ALTER TABLE "Patient" ADD COLUMN "utmMedium"      TEXT;
ALTER TABLE "Patient" ADD COLUMN "utmCampaign"    TEXT;
ALTER TABLE "Patient" ADD COLUMN "utmContent"     TEXT;
ALTER TABLE "Patient" ADD COLUMN "utmTerm"        TEXT;
ALTER TABLE "Patient" ADD COLUMN "adCampaignName" TEXT;
ALTER TABLE "Patient" ADD COLUMN "adsetName"      TEXT;
ALTER TABLE "Patient" ADD COLUMN "adName"         TEXT;
ALTER TABLE "Patient" ADD COLUMN "sourceUrl"      TEXT;
