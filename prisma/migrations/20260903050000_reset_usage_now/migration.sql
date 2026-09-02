-- Zera o contador de atendimentos de TODAS as contas e "grandfather" nas
-- conversas que já estão em andamento (marca como já contadas neste mês), pra
-- a contagem começar do zero a partir de agora. Conversas novas (e reaberturas)
-- daqui pra frente é que contam.
UPDATE "Clinic"
  SET "usageCount" = 0,
      "usageMonth" = strftime('%Y-%m', 'now'),
      "usageLimitNotified" = 0;

UPDATE "Conversation"
  SET "aliceMonth" = strftime('%Y-%m', 'now')
  WHERE "archived" = 0;
