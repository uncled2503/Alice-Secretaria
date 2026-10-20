-- Captacao de leads da landing (21/10/2026). Tabela NOVA e isolada: nao altera nada existente.
CREATE TABLE "SiteLead" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "phoneKey" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "segment" TEXT NOT NULL,
    "volume" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "utmContent" TEXT,
    "utmTerm" TEXT,
    "gclid" TEXT,
    "fbclid" TEXT,
    "referrer" TEXT,
    "landingPath" TEXT,
    "userAgent" TEXT,
    "ipHash" TEXT,
    "submissions" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'novo',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSubmittedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "SiteLead_phoneKey_key" ON "SiteLead"("phoneKey");
CREATE INDEX "SiteLead_createdAt_idx" ON "SiteLead"("createdAt");
CREATE INDEX "SiteLead_ipHash_createdAt_idx" ON "SiteLead"("ipHash", "createdAt");
