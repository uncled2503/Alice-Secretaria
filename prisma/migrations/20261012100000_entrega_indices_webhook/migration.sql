-- Idempotencia do webhook e estado de entrega das respostas
ALTER TABLE "Message" ADD COLUMN "externalId" TEXT;
ALTER TABLE "Message" ADD COLUMN "deliveryStatus" TEXT;

-- Rotacao da assinatura do webhook da UAZAPI
ALTER TABLE "Clinic" ADD COLUMN "webhookVersion" INTEGER NOT NULL DEFAULT 0;

-- Indices que faltavam (Message/Appointment/Conversation eram lidos por varredura completa)
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");
CREATE INDEX "Message_role_createdAt_idx" ON "Message"("role", "createdAt");
CREATE INDEX "Message_externalId_idx" ON "Message"("externalId");
CREATE INDEX "Appointment_clinicId_scheduledAt_idx" ON "Appointment"("clinicId", "scheduledAt");
CREATE INDEX "Appointment_patientId_scheduledAt_idx" ON "Appointment"("patientId", "scheduledAt");
CREATE INDEX "Conversation_patientId_idx" ON "Conversation"("patientId");
CREATE INDEX "Patient_clinicId_createdAt_idx" ON "Patient"("clinicId", "createdAt");
