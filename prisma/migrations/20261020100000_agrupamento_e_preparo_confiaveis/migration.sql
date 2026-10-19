-- Duas lacunas de confiabilidade (20/10/2026), ambas aditivas e com padrao.
-- 1) Agrupamento de mensagens (replyDelaySeconds > 0): o timer vivia so em memoria; um reinicio entre o recebimento e o timer deixava a mensagem sem resposta.
--    Agora o prazo fica na conversa (replyDueAt) e a reivindicacao e atomica (replyClaimedAt).
-- 2) Preparo pre-procedimento: a reserva da etapa era tratada como envio. Agora a linha tem ESTADO (reservada, na fila da conversa, enviando, enviada, sem confirmacao,
--    falha, bloqueada...). Linhas antigas ficam como "enviada" (era assim que eram tratadas).

ALTER TABLE "Conversation" ADD COLUMN "replyDueAt" DATETIME;
ALTER TABLE "Conversation" ADD COLUMN "replyFirstAt" DATETIME;
ALTER TABLE "Conversation" ADD COLUMN "replyClaimedAt" DATETIME;
CREATE INDEX "Conversation_replyDueAt_idx" ON "Conversation"("replyDueAt");

ALTER TABLE "PreProcedureSent" ADD COLUMN "state" TEXT NOT NULL DEFAULT 'sent';
ALTER TABLE "PreProcedureSent" ADD COLUMN "channel" TEXT;
ALTER TABLE "PreProcedureSent" ADD COLUMN "messageId" TEXT;
ALTER TABLE "PreProcedureSent" ADD COLUMN "reservedAt" DATETIME;
ALTER TABLE "PreProcedureSent" ADD COLUMN "attemptedAt" DATETIME;
ALTER TABLE "PreProcedureSent" ADD COLUMN "finalAt" DATETIME;
ALTER TABLE "PreProcedureSent" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PreProcedureSent" ADD COLUMN "reevaluateAt" DATETIME;
ALTER TABLE "PreProcedureSent" ADD COLUMN "note" TEXT;
CREATE INDEX "PreProcedureSent_state_reservedAt_idx" ON "PreProcedureSent"("state", "reservedAt");
