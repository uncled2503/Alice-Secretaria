-- Conversa arquivada (estilo WhatsApp): sai da lista principal, volta se
-- chegar mensagem nova ou se desarquivar na mao.
ALTER TABLE "Conversation" ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "Conversation_archived_lastMessageAt_idx" ON "Conversation"("archived", "lastMessageAt");
