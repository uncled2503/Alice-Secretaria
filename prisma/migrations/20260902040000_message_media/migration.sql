-- Anexos nas mensagens (foto/arquivo enviado no atendimento humano, e foto
-- recebida do cliente). mediaUrl guarda o data URI pra mostrar no painel.
ALTER TABLE "Message" ADD COLUMN "mediaType" TEXT;
ALTER TABLE "Message" ADD COLUMN "mediaUrl" TEXT;
ALTER TABLE "Message" ADD COLUMN "mediaName" TEXT;
