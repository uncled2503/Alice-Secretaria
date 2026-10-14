-- Lisboa (Aline, 14/10/2026)
-- 1) Recontato de 1 dia: todos no DIA SEGUINTE as 8h (a equipe organiza a agenda do dia). Janela 8h-12h pra nao sair a tarde.
ALTER TABLE "FollowUpRule" ADD COLUMN "nextDayHour" INTEGER;
UPDATE "FollowUpRule" SET "nextDayHour" = 8, "sendWindowStart" = 8, "sendWindowEnd" = 12
WHERE "order" = 2 AND "afterMinutes" = 1440 AND "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center');

-- 2) Pesquisa pos-AVALIACAO: texto proprio (a mensagem anterior estava errada). Atendimento que nao e avaliacao continua com a npsMessage.
ALTER TABLE "Clinic" ADD COLUMN "npsEvaluationMessage" TEXT;
UPDATE "Clinic" SET "npsEvaluationMessage" = 'Olá, {primeiro_nome}! Tudo bem? 💕

Aqui é da Lisboa Beauty Center! ✨

Gostaríamos de saber como foi sua experiência durante a avaliação conosco. 💗

Você se sentiu bem atendida? Conseguiu esclarecer suas dúvidas sobre os procedimentos indicados?

Sua opinião é muito importante para nós, pois estamos sempre buscando melhorar nosso atendimento! 🥰

Pode compartilhar seu feedback com a gente? 💕' WHERE "name" = 'Lisboa Beauty Center';
