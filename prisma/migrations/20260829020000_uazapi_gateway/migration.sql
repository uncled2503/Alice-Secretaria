-- Credenciais UAZAPI por clinica
ALTER TABLE "Clinic" ADD COLUMN "uazapiBaseUrl" TEXT;
ALTER TABLE "Clinic" ADD COLUMN "uazapiToken" TEXT;

CREATE UNIQUE INDEX "Clinic_uazapiToken_key" ON "Clinic"("uazapiToken");

-- Fila duravel e idempotente de eventos recebidos por webhook
CREATE TABLE "UazapiWebhookEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UazapiWebhookEvent_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "UazapiWebhookEvent_clinicId_externalId_key" ON "UazapiWebhookEvent"("clinicId", "externalId");
CREATE INDEX "UazapiWebhookEvent_status_createdAt_idx" ON "UazapiWebhookEvent"("status", "createdAt");
