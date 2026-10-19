-- Link do Google: COMPATIBILIDADE nao e VALIDACAO (19/10/2026).
-- A migracao 20261018110000_pesquisa_google_indicacao marcou como "confirmado" o link das clinicas que ja tinham um cadastrado, para elas continuarem enviando como antes.
-- Isso atribuia uma conferencia que ninguem fez. Esta migracao NAO reescreve aquela (pode ja ter sido aplicada em algum ambiente): ela corrige o estado por cima.
--  1) nova coluna: o envio continua permitido por COMPATIBILIDADE com o comportamento anterior, sem dizer que o destino foi conferido;
--  2) as linhas que receberam a marca falsa ("migracao: link ja cadastrado pela clinica") perdem a confirmacao e passam a "so compatibilidade".
-- Nada e enviado por esta migracao. A Lisboa nunca recebeu a marca (excluida pelo nome) e continua sem enviar link ate alguem confirmar o destino.
-- Colunas novas com padrao: o codigo anterior continua funcionando.

ALTER TABLE "Clinic" ADD COLUMN "googleReviewLegacyAllowed" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Clinic" SET "googleReviewLegacyAllowed" = true, "googleReviewConfirmedAt" = NULL, "googleReviewConfirmedBy" = NULL, "googleReviewPlace" = NULL
WHERE "googleReviewConfirmedBy" = 'migracao: link ja cadastrado pela clinica' AND "name" <> 'Lisboa Beauty Center';

-- Se a marca falsa tiver sido gravada na Lisboa por algum caminho, tambem some (a Lisboa nunca e "compatibilidade": ela exige confirmacao explicita).
UPDATE "Clinic" SET "googleReviewConfirmedAt" = NULL, "googleReviewConfirmedBy" = NULL, "googleReviewPlace" = NULL
WHERE "googleReviewConfirmedBy" = 'migracao: link ja cadastrado pela clinica' AND "name" = 'Lisboa Beauty Center';
