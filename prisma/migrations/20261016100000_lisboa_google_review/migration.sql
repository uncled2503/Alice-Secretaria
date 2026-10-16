-- Lisboa (16/10/2026): link da avaliacao no Google (a Alice envia depois da nota alta da pesquisa de satisfacao, e a indicacao vai em mensagem separada).
-- So preenche se estiver vazio: nunca sobrescreve um link que a clinica ja tenha colocado no painel.
UPDATE "Clinic" SET "googleReviewUrl" = 'https://g.page/r/CVxcf78iE5IhEAE/review'
WHERE "name" = 'Lisboa Beauty Center' AND ("googleReviewUrl" IS NULL OR TRIM("googleReviewUrl") = '');
