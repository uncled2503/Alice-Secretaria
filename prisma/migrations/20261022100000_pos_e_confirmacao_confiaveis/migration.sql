-- Duas lacunas de confiabilidade (19/10/2026), ambas aditivas e com padrao.
-- 1) Pos-procedimento: a reserva da etapa era tratada como envio e nao havia como recuperar uma queda antes do envio. Agora a linha tem ESTADO (reservada, enviando, enviada,
--    sem confirmacao, nova tentativa, barrada, bloqueada, duplicada, falha definitiva). Linhas antigas ficam como "legacy": provam a reserva, NAO a entrega; nunca sao reabertas.
-- 2) Confirmacao de agendamento criado FORA da conversa (painel manual / API externa): uma unica tentativa, sem controle persistente. Agora cada (agendamento, horario) tem uma
--    linha de controle, com recuperacao limitada de falha temporaria e revalidacao antes de cada envio.

ALTER TABLE "PostProcedureSent" ADD COLUMN "state" TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE "PostProcedureSent" ADD COLUMN "reservedAt" DATETIME;
ALTER TABLE "PostProcedureSent" ADD COLUMN "attemptedAt" DATETIME;
ALTER TABLE "PostProcedureSent" ADD COLUMN "finalAt" DATETIME;
ALTER TABLE "PostProcedureSent" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PostProcedureSent" ADD COLUMN "note" TEXT;
CREATE INDEX "PostProcedureSent_state_reservedAt_idx" ON "PostProcedureSent"("state", "reservedAt");

CREATE TABLE "AppointmentConfirmation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "startsAt" DATETIME NOT NULL,
    "state" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "reservedAt" DATETIME,
    "attemptedAt" DATETIME,
    "finalAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "AppointmentConfirmation_appointmentId_startsAt_key" ON "AppointmentConfirmation"("appointmentId", "startsAt");
CREATE INDEX "AppointmentConfirmation_state_createdAt_idx" ON "AppointmentConfirmation"("state", "createdAt");
CREATE INDEX "AppointmentConfirmation_clinicId_idx" ON "AppointmentConfirmation"("clinicId");
