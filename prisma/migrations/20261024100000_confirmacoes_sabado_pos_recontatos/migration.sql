-- Confirmacoes por dia da semana do atendimento, pos fora do expediente e registro de remarcacao/conclusao (21/10/2026).
-- Somente colunas NOVAS e opcionais (ou com padrao que preserva o comportamento atual): nenhuma regra existente muda de comportamento por causa desta migracao.
ALTER TABLE "ReminderRule" ADD COLUMN "weekdays" TEXT;
ALTER TABLE "ReminderRule" ADD COLUMN "purpose" TEXT;
ALTER TABLE "ReminderRule" ADD COLUMN "resendIfConfirmed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Appointment" ADD COLUMN "scheduleChangedAt" DATETIME;
ALTER TABLE "Appointment" ADD COLUMN "completedAt" DATETIME;
ALTER TABLE "PostProcedureRule" ADD COLUMN "lateSendUntilHour" INTEGER;
