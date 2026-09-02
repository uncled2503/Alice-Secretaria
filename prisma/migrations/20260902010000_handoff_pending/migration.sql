-- Conversa que a Alice transferiu pra uma pessoa e que ninguem abriu ainda no
-- painel. Mantem um aviso visivel na lista de conversas ate alguem ver.
ALTER TABLE "Conversation" ADD COLUMN "handoffPending" BOOLEAN NOT NULL DEFAULT false;
