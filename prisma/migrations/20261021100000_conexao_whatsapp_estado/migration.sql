-- Estado da conexao do WhatsApp por clinica (21/10/2026). Quando o provedor responde que a sessao esta DESCONECTADA ("HTTP 503: WhatsApp disconnected: session is not reconnectable"),
-- a clinica fica marcada: os envios automaticos dela param de bater no provedor (nao ha o que repetir), a equipe e avisada pelo painel e a marca cai sozinha quando um envio
-- ou a consulta de status voltam a funcionar. So colunas novas e anulaveis; o estado de uma clinica nunca afeta outra.

ALTER TABLE "Clinic" ADD COLUMN "uazapiDownSince" DATETIME;
ALTER TABLE "Clinic" ADD COLUMN "uazapiDownReason" TEXT;
ALTER TABLE "Clinic" ADD COLUMN "uazapiDownCheckedAt" DATETIME;
