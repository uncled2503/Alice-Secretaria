-- Controle persistente dos lembretes automaticos (16/10/2026, Lisboa): uma linha por reserva+regra+horario, adquirida de forma atomica antes do envio.
-- Tabela nova e independente (sem chave estrangeira): nao altera nenhum dado existente.
CREATE TABLE "ReminderDispatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "bookingKey" TEXT NOT NULL,
    "appointmentId" TEXT,
    "patientId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "startsAt" DATETIME NOT NULL,
    "sendDay" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "detail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "ReminderDispatch_bookingKey_ruleId_startsAt_key" ON "ReminderDispatch"("bookingKey", "ruleId", "startsAt");
CREATE UNIQUE INDEX "ReminderDispatch_bookingKey_kind_startsAt_sendDay_key" ON "ReminderDispatch"("bookingKey", "kind", "startsAt", "sendDay");
CREATE INDEX "ReminderDispatch_clinicId_patientId_sendDay_idx" ON "ReminderDispatch"("clinicId", "patientId", "sendDay");
