-- Lisboa: renovacao automatica (material do MKT, 13/10/2026). Convite de reavaliacao/manutencao, nunca "obrigatorio".
-- Botox 4 meses, bioestimulador 1 ano, preenchimento 1 ano, limpeza de pele 2 meses, contados da data do atendimento.
-- Regras do job (reminders/renewal.ts): so pra quem fez (concluido ou agendado que ja passou; nao cancelou nem faltou); NAO envia se
-- a cliente ja tem novo agendamento (ou ja voltou) para o mesmo procedimento; so entre 8h e 20h; uma vez por atendimento.
-- Cada regra so vale pros procedimentos da clinica cujo nome combina (o filtro nunca fica vazio: vazio = todos). Se ja existe uma
-- regra ATIVA de renovacao cobrindo o mesmo procedimento, a nova nasce DESLIGADA (a paciente nao recebe duas mensagens).

INSERT INTO "RenewalRule" ("id", "clinicId", "name", "message", "intervalValue", "intervalUnit", "onlyIfCompleted", "procedureIds", "active")
SELECT lower(hex(randomblob(12))), c."id", 'Renovação - Botox (4 meses)',
  'Oi, {primeiro_nome}! 💗' || char(10) || 'Já faz cerca de 4 meses desde o seu Botox aqui na Lisboa e queríamos saber como você está percebendo o resultado. ✨' || char(10) || 'Se quiser, podemos verificar uma avaliação para acompanhar a evolução e entender se já é o momento de pensar em uma nova aplicação.' || char(10) || 'Quer que eu veja os horários disponíveis para você?',
  4, 'months', 0,
  (SELECT group_concat(p."id", ',') FROM "Procedure" p WHERE p."clinicId" = c."id" AND (lower(p."name") LIKE '%botox%' OR lower(p."name") LIKE '%toxina%')),
  CASE WHEN EXISTS (
    SELECT 1 FROM "RenewalRule" x
    WHERE x."clinicId" = c."id" AND x."active" = 1
      AND (x."procedureIds" = '' OR EXISTS (
        SELECT 1 FROM "Procedure" p2
        WHERE p2."clinicId" = c."id" AND (lower(p2."name") LIKE '%botox%' OR lower(p2."name") LIKE '%toxina%') AND (',' || x."procedureIds" || ',') LIKE '%,' || p2."id" || ',%'))
  ) THEN 0 ELSE 1 END
FROM "Clinic" c
WHERE c."name" = 'Lisboa Beauty Center'
  AND NOT EXISTS (SELECT 1 FROM "RenewalRule" y WHERE y."clinicId" = c."id" AND y."name" = 'Renovação - Botox (4 meses)')
  AND EXISTS (SELECT 1 FROM "Procedure" p3 WHERE p3."clinicId" = c."id" AND (lower(p3."name") LIKE '%botox%' OR lower(p3."name") LIKE '%toxina%'));

INSERT INTO "RenewalRule" ("id", "clinicId", "name", "message", "intervalValue", "intervalUnit", "onlyIfCompleted", "procedureIds", "active")
SELECT lower(hex(randomblob(12))), c."id", 'Renovação - Bioestimulador de colágeno (1 ano)',
  'Oi, {primeiro_nome}! ✨' || char(10) || 'Já faz aproximadamente 1 ano desde o seu Bioestimulador de Colágeno na Lisboa. 💗' || char(10) || 'Esse é um ótimo momento para fazermos uma nova avaliação da sua pele, acompanhar a evolução e entender se existe indicação de manutenção ou de um novo planejamento.' || char(10) || 'Quer que eu verifique um horário para sua avaliação?',
  1, 'years', 0,
  (SELECT group_concat(p."id", ',') FROM "Procedure" p WHERE p."clinicId" = c."id" AND (lower(p."name") LIKE '%bioestimul%' OR lower(p."name") LIKE '%sculptra%' OR lower(p."name") LIKE '%radiesse%' OR lower(p."name") LIKE '%elleva%')),
  CASE WHEN EXISTS (
    SELECT 1 FROM "RenewalRule" x
    WHERE x."clinicId" = c."id" AND x."active" = 1
      AND (x."procedureIds" = '' OR EXISTS (
        SELECT 1 FROM "Procedure" p2
        WHERE p2."clinicId" = c."id" AND (lower(p2."name") LIKE '%bioestimul%' OR lower(p2."name") LIKE '%sculptra%' OR lower(p2."name") LIKE '%radiesse%' OR lower(p2."name") LIKE '%elleva%') AND (',' || x."procedureIds" || ',') LIKE '%,' || p2."id" || ',%'))
  ) THEN 0 ELSE 1 END
FROM "Clinic" c
WHERE c."name" = 'Lisboa Beauty Center'
  AND NOT EXISTS (SELECT 1 FROM "RenewalRule" y WHERE y."clinicId" = c."id" AND y."name" = 'Renovação - Bioestimulador de colágeno (1 ano)')
  AND EXISTS (SELECT 1 FROM "Procedure" p3 WHERE p3."clinicId" = c."id" AND (lower(p3."name") LIKE '%bioestimul%' OR lower(p3."name") LIKE '%sculptra%' OR lower(p3."name") LIKE '%radiesse%' OR lower(p3."name") LIKE '%elleva%'));

INSERT INTO "RenewalRule" ("id", "clinicId", "name", "message", "intervalValue", "intervalUnit", "onlyIfCompleted", "procedureIds", "active")
SELECT lower(hex(randomblob(12))), c."id", 'Renovação - Preenchimento (1 ano)',
  'Oi, {primeiro_nome}! 💕' || char(10) || 'Já faz cerca de 1 ano desde o seu preenchimento aqui na Lisboa.' || char(10) || 'Gostaríamos de te convidar para uma nova avaliação, para acompanhar o resultado e verificar se existe necessidade ou interesse em manutenção. ✨' || char(10) || 'Quer que eu veja os horários disponíveis para você?',
  1, 'years', 0,
  (SELECT group_concat(p."id", ',') FROM "Procedure" p WHERE p."clinicId" = c."id" AND (lower(p."name") LIKE '%preench%')),
  CASE WHEN EXISTS (
    SELECT 1 FROM "RenewalRule" x
    WHERE x."clinicId" = c."id" AND x."active" = 1
      AND (x."procedureIds" = '' OR EXISTS (
        SELECT 1 FROM "Procedure" p2
        WHERE p2."clinicId" = c."id" AND (lower(p2."name") LIKE '%preench%') AND (',' || x."procedureIds" || ',') LIKE '%,' || p2."id" || ',%'))
  ) THEN 0 ELSE 1 END
FROM "Clinic" c
WHERE c."name" = 'Lisboa Beauty Center'
  AND NOT EXISTS (SELECT 1 FROM "RenewalRule" y WHERE y."clinicId" = c."id" AND y."name" = 'Renovação - Preenchimento (1 ano)')
  AND EXISTS (SELECT 1 FROM "Procedure" p3 WHERE p3."clinicId" = c."id" AND (lower(p3."name") LIKE '%preench%'));

INSERT INTO "RenewalRule" ("id", "clinicId", "name", "message", "intervalValue", "intervalUnit", "onlyIfCompleted", "procedureIds", "active")
SELECT lower(hex(randomblob(12))), c."id", 'Renovação - Limpeza de pele (2 meses)',
  'Oi, {primeiro_nome}! 💗' || char(10) || 'Já faz aproximadamente 2 meses desde a sua última Limpeza de Pele na Lisboa. ✨' || char(10) || 'Que tal aproveitar para cuidar novamente da sua pele e manter sua rotina de cuidados em dia?' || char(10) || 'Se quiser, posso verificar os próximos horários disponíveis para você.',
  2, 'months', 0,
  (SELECT group_concat(p."id", ',') FROM "Procedure" p WHERE p."clinicId" = c."id" AND (lower(p."name") LIKE '%limpeza%')),
  CASE WHEN EXISTS (
    SELECT 1 FROM "RenewalRule" x
    WHERE x."clinicId" = c."id" AND x."active" = 1
      AND (x."procedureIds" = '' OR EXISTS (
        SELECT 1 FROM "Procedure" p2
        WHERE p2."clinicId" = c."id" AND (lower(p2."name") LIKE '%limpeza%') AND (',' || x."procedureIds" || ',') LIKE '%,' || p2."id" || ',%'))
  ) THEN 0 ELSE 1 END
FROM "Clinic" c
WHERE c."name" = 'Lisboa Beauty Center'
  AND NOT EXISTS (SELECT 1 FROM "RenewalRule" y WHERE y."clinicId" = c."id" AND y."name" = 'Renovação - Limpeza de pele (2 meses)')
  AND EXISTS (SELECT 1 FROM "Procedure" p3 WHERE p3."clinicId" = c."id" AND (lower(p3."name") LIKE '%limpeza%'));
