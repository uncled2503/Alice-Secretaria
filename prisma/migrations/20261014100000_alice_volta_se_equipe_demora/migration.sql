-- Pedido da Lisboa (14/10/2026): se a equipe assumiu a conversa, o cliente continuou escrevendo e ninguem respondeu em 15 min,
-- a Alice volta a atender. Clinic.humanReturnMinutes = minutos de espera (0 = desligado); Conversation.staffTouchedAt = ultima
-- vez que uma pessoa da equipe agiu na conversa.
ALTER TABLE "Clinic" ADD COLUMN "humanReturnMinutes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Conversation" ADD COLUMN "staffTouchedAt" DATETIME;

-- Conversas que JA estao com a equipe: a ultima resposta de uma pessoa vira o ponto de partida.
UPDATE "Conversation"
SET "staffTouchedAt" = (SELECT max(m."createdAt") FROM "Message" m WHERE m."conversationId" = "Conversation"."id" AND m."role" = 'human')
WHERE "humanTakeover" = 1;

UPDATE "Clinic" SET "humanReturnMinutes" = 15 WHERE "name" = 'Lisboa Beauty Center';
