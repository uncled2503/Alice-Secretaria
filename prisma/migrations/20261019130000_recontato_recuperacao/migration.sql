-- Recontato: POLITICA DE RECUPERACAO por clinica (19/10/2026).
-- "Recuperar" = enviar um recontato que venceu mas nao saiu na hora (servidor reiniciado, fora do expediente, janela perdida). A trava de 3 dias e do codigo desde 07/10/2026
-- (contra disparo em massa); os prazos mais curtos (24h depois da abertura da janela, fim do dia) foram INTRODUZIDOS pelas correcoes de 17-18/10 e nunca foram aprovados por clinica nenhuma.
-- Agora e escolha da clinica: NULL = comportamento atual de producao (padrao antigo: tolerancia de 3 dias); 0 = nao recupera (so sai na rodada em que vence/abre); N = ate N horas
-- depois que a janela abriu. Nada muda para nenhuma clinica enquanto ninguem preencher. Coluna anulavel.

ALTER TABLE "Clinic" ADD COLUMN "followupRecoveryHours" INTEGER;
