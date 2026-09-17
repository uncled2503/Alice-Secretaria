-- Procedimento por ordem de chegada (ex.: aplicacao/injetavel): varios
-- pacientes podem ocupar o MESMO horario com o mesmo profissional, sem
-- contar como conflito de agenda entre si. Aditivo, default false
-- (comportamento atual de todo procedimento existente nao muda ate alguem
-- ligar o toggle no painel).

ALTER TABLE "Procedure" ADD COLUMN "allowConcurrentBooking" BOOLEAN NOT NULL DEFAULT false;
