-- Intervalo (ex.: almoco) dentro do expediente - sem isso, uma clinica com
-- 2 turnos por dia (ex.: 9h-13h e 14h-18h) so conseguia representar um
-- unico bloco continuo, e a Alice ofereceria horario durante a pausa.
-- Aditivo, null = sem pausa (comportamento atual de toda clinica existente
-- nao muda).

ALTER TABLE "Clinic" ADD COLUMN "lunchStartHour" INTEGER;
ALTER TABLE "Clinic" ADD COLUMN "lunchEndHour" INTEGER;
ALTER TABLE "Professional" ADD COLUMN "lunchStartHour" INTEGER;
ALTER TABLE "Professional" ADD COLUMN "lunchEndHour" INTEGER;
