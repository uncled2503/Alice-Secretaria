-- Integracao com o Google Agenda. Tudo aditivo: nenhuma tabela ou coluna
-- existente muda de forma, entao a migration e segura de rodar em producao.

-- CreateTable: conexao OAuth da clinica com o Google Agenda (uma por clinica).
-- refreshToken/accessToken ficam criptografados (AES-256-GCM).
CREATE TABLE "GoogleCalendarAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "googleEmail" TEXT,
    "calendarId" TEXT NOT NULL DEFAULT 'primary',
    "refreshToken" TEXT NOT NULL,
    "accessToken" TEXT,
    "accessExpiresAt" DATETIME,
    "syncOut" BOOLEAN NOT NULL DEFAULT true,
    "blockBusy" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GoogleCalendarAccount_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "GoogleCalendarAccount_clinicId_key" ON "GoogleCalendarAccount"("clinicId");

-- AlterTable: guarda o id do evento espelhado no Google, pra depois conseguir
-- atualizar/apagar o evento certo quando o agendamento muda ou e cancelado.
ALTER TABLE "Appointment" ADD COLUMN "googleEventId" TEXT;
