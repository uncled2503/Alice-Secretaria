-- Procedimentos que so existem pra agendamentos importados do Clinica Experts (retoque, cortesia, itens internos): ficam no
-- cadastro pra a reserva receber confirmacao, mas a Alice nao os oferece nem agenda.
ALTER TABLE "Procedure" ADD COLUMN "internalOnly" BOOLEAN NOT NULL DEFAULT false;
