-- Confiabilidade da integracao com o Clinica Experts (CE), identidade e acompanhantes (21/10/2026). Tudo ADITIVO: colunas/tabelas novas, todas opcionais; nada e reescrito nem reaberto.
-- 1) Appointment guarda o que o CE disse (estado bruto, versao, fim da reserva) e o que falta sincronizar (cancelamento, confirmacao de presenca).
ALTER TABLE "Appointment" ADD COLUMN "endsAt" DATETIME;
ALTER TABLE "Appointment" ADD COLUMN "ceStatus" TEXT;
ALTER TABLE "Appointment" ADD COLUMN "ceUpdatedAt" DATETIME;
ALTER TABLE "Appointment" ADD COLUMN "ceSyncedAt" DATETIME;
ALTER TABLE "Appointment" ADD COLUMN "ceCancelState" TEXT;
ALTER TABLE "Appointment" ADD COLUMN "cePresenceState" TEXT;
ALTER TABLE "Appointment" ADD COLUMN "cePresenceAt" DATETIME;
ALTER TABLE "Appointment" ADD COLUMN "attendeeId" TEXT REFERENCES "Attendee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Appointment" ADD COLUMN "bookedByPatientId" TEXT;
CREATE INDEX "Appointment_clinicId_ceBookingUuid_idx" ON "Appointment"("clinicId", "ceBookingUuid");

-- 2) Todos os procedimentos de uma reserva (a reserva do CE pode ter varios).
CREATE TABLE "AppointmentProcedure" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "appointmentId" TEXT NOT NULL,
    "procedureId" TEXT,
    "ceProcedureId" INTEGER,
    "name" TEXT NOT NULL,
    "durationMin" INTEGER,
    "position" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "AppointmentProcedure_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AppointmentProcedure_appointmentId_idx" ON "AppointmentProcedure"("appointmentId");

-- 3) Pessoa atendida que compartilha o telefone de quem conversa (nunca funde cadastros).
CREATE TABLE "Attendee" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "contactPatientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "relation" TEXT,
    "ceUuid" TEXT,
    "birthDate" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Attendee_contactPatientId_fkey" FOREIGN KEY ("contactPatientId") REFERENCES "Patient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "Attendee_clinicId_contactPatientId_idx" ON "Attendee"("clinicId", "contactPatientId");
CREATE INDEX "Attendee_ceUuid_idx" ON "Attendee"("ceUuid");

-- 4) Tentativas no CE com resultado incerto (reconciliacao persistente).
CREATE TABLE "CeBookingAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "startsAt" DATETIME,
    "endsAt" DATETIME,
    "professionalUuid" TEXT,
    "patientUuid" TEXT,
    "procedureCeIds" TEXT,
    "ceBookingUuid" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "resolvedAt" DATETIME
);
CREATE INDEX "CeBookingAttempt_clinicId_state_idx" ON "CeBookingAttempt"("clinicId", "state");
CREATE INDEX "CeBookingAttempt_appointmentId_kind_idx" ON "CeBookingAttempt"("appointmentId", "kind");

-- 5) Aniversario: reserva ANTES do envio. Registros que ja existem ficam como "legacy" (provam a reserva, nao o envio; nunca sao reabertos).
ALTER TABLE "BirthdaySent" ADD COLUMN "state" TEXT NOT NULL DEFAULT 'legacy';
