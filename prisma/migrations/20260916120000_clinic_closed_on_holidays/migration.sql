-- Feriados nacionais automaticos: quando ligado, a clinica fica fechada nos
-- feriados federais (data fixa + Sexta-feira Santa) sem precisar de um
-- bloqueio manual pra cada um. Aditivo, default false (comportamento atual
-- de toda clinica existente nao muda ate alguem ligar o toggle no painel).

ALTER TABLE "Clinic" ADD COLUMN "closedOnHolidays" BOOLEAN NOT NULL DEFAULT false;
