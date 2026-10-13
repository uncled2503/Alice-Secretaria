-- Campanha mensal "Leads do mes": no dia configurado, leads que entraram no mes e ainda nao agendaram nem compraram.
ALTER TABLE "Clinic" ADD COLUMN "leadReactivationDay" INTEGER;
ALTER TABLE "Clinic" ADD COLUMN "leadReactivationMessage" TEXT;

-- Lisboa (pedido de 13/10/2026): todo dia 20, texto aprovado pela clinica ([NOME] -> {primeiro_nome}, [PROCEDIMENTO] -> {procedimento}).
UPDATE "Clinic"
SET "leadReactivationDay" = 20,
    "leadReactivationMessage" =
      'Oi, {primeiro_nome}! 💕' || char(10) ||
      'Lembrei de você porque estamos com uma condição especial de {procedimento} este mês. ✨' || char(10) ||
      'Como você já tinha demonstrado interesse nesse tratamento, quis te avisar.' || char(10) ||
      'Quer que eu te envie os detalhes?'
WHERE "name" = 'Lisboa Beauty Center' AND "leadReactivationDay" IS NULL;
