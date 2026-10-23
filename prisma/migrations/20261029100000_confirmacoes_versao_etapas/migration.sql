-- Politica final de confirmacoes (lote 1, 22/10/2026): pedido de remarcacao pendente por horario, aviso unico de reserva sem procedimento e limites configuraveis da reposicao e do
-- intervalo entre etapas. Somente colunas anulaveis (compativel com ADD COLUMN do SQLite; nenhuma linha existente muda de valor).
ALTER TABLE "Appointment" ADD COLUMN "rescheduleRequestedAt" DATETIME;
ALTER TABLE "Appointment" ADD COLUMN "missingProcedureAlertAt" DATETIME;

ALTER TABLE "DispatchPolicy" ADD COLUMN "lateStartHour" INTEGER;
ALTER TABLE "DispatchPolicy" ADD COLUMN "lateEndHour" INTEGER;
ALTER TABLE "DispatchPolicy" ADD COLUMN "stepMinGapMin" INTEGER;
