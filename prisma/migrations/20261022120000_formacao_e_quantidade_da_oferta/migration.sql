-- Fatos comerciais/profissionais que a Alice nao pode deduzir (incidentes da Lisboa 19-20/10/2026), ambos aditivos e opcionais:
-- 1) Professional.qualification: formacao informada pela clinica (o tratamento "Dra." NAO indica que a pessoa e medica).
-- 2) Procedure.includedQuantity: quantidade incluida na oferta (ex.: "50 UI"), dado comercial aprovado, distinto de recomendacao individual de aplicacao.
ALTER TABLE "Professional" ADD COLUMN "qualification" TEXT;
ALTER TABLE "Procedure" ADD COLUMN "includedQuantity" TEXT;
