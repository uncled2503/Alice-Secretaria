-- Lisboa: pos-procedimentos (material do MKT, 13/10/2026). Uma regra por procedimento/grupo, enviada ~1h DEPOIS DO FIM do
-- atendimento (o job conta inicio + duracao), pra quem continua na agenda (nao cancelou nem faltou).
-- Cada regra so vale para os procedimentos da clinica cujo nome combina com o tratamento (o filtro nunca fica vazio: vazio
-- significaria "todos os procedimentos"). Regra que ja tem nome igual nao e recriada. Se ja existe uma regra ATIVA de
-- pos-procedimento cobrindo o mesmo procedimento, a nova nasce DESLIGADA (pra paciente nao receber duas mensagens) - revise em
-- Personalizar Alice -> Pos-procedimento.
-- Regra de seguranca: relato de reacao (dor intensa, alergia, bolha, queimadura, secrecao, febre...) -> a Alice para o fluxo
-- automatico e transfere pra equipe (src/ai/safety.ts; o job pula quem esta nessa situacao).

INSERT INTO "PostProcedureRule" ("id", "clinicId", "name", "message", "intervalValue", "intervalUnit", "onlyIfCompleted", "procedureIds", "active")
SELECT lower(hex(randomblob(12))), c."id", 'Pós - Criolipólise',
  'Oi, {primeiro_nome}! 💗 Foi um prazer cuidar de você hoje!' || char(10) || '' || char(10) || 'Passando para reforçar alguns cuidados importantes após sua criolipólise:' || char(10) || '• Beba bastante água nos próximos dias, de preferência pelo menos 2 litros por dia.' || char(10) || '• Use a cinta modeladora por pelo menos 8 horas ao dia, conforme orientação da nossa equipe.' || char(10) || '• Evite massagens ou outros procedimentos na região tratada nas próximas 72h.' || char(10) || '• Evite exposição solar direta na região por 7 dias.' || char(10) || '• A atividade física pode ser retomada a partir de amanhã.' || char(10) || '• Mantenha uma alimentação equilibrada.' || char(10) || '' || char(10) || 'É comum apresentar vermelhidão, inchaço, sensibilidade ou formigamento na região após o procedimento.' || char(10) || '' || char(10) || '💬 Caso perceba algo que te preocupe ou diferente do esperado, nos chame por aqui para que nossa equipe possa te orientar.',
  1, 'hours', 0,
  (SELECT group_concat(p."id", ',') FROM "Procedure" p WHERE p."clinicId" = c."id" AND (lower(p."name") LIKE '%criolip%')),
  CASE WHEN EXISTS (
    SELECT 1 FROM "PostProcedureRule" x
    WHERE x."clinicId" = c."id" AND x."active" = 1
      AND (x."procedureIds" = '' OR EXISTS (
        SELECT 1 FROM "Procedure" p2
        WHERE p2."clinicId" = c."id" AND (lower(p2."name") LIKE '%criolip%') AND (',' || x."procedureIds" || ',') LIKE '%,' || p2."id" || ',%'))
  ) THEN 0 ELSE 1 END
FROM "Clinic" c
WHERE c."name" = 'Lisboa Beauty Center'
  AND NOT EXISTS (SELECT 1 FROM "PostProcedureRule" y WHERE y."clinicId" = c."id" AND y."name" = 'Pós - Criolipólise')
  AND EXISTS (SELECT 1 FROM "Procedure" p3 WHERE p3."clinicId" = c."id" AND (lower(p3."name") LIKE '%criolip%'));

INSERT INTO "PostProcedureRule" ("id", "clinicId", "name", "message", "intervalValue", "intervalUnit", "onlyIfCompleted", "procedureIds", "active")
SELECT lower(hex(randomblob(12))), c."id", 'Pós - Botox',
  'Oi, {primeiro_nome}! 💗 Foi um prazer cuidar de você hoje!' || char(10) || '' || char(10) || 'Agora, alguns cuidados importantes após o seu Botox:' || char(10) || '• Não abaixe a cabeça e evite deitar nas próximas 4 horas.' || char(10) || '• Não massageie, esfregue ou pressione a região tratada.' || char(10) || '• Evite atividade física intensa nas próximas 24h.' || char(10) || '• Evite sol intenso, sauna, banho muito quente e outras fontes de calor por 24h.' || char(10) || '' || char(10) || '✨ O efeito começa a aparecer gradualmente nos próximos dias, com evolução do resultado em até aproximadamente 15 dias.' || char(10) || '' || char(10) || 'Qualquer dúvida ou alteração que te preocupe, fale com a gente por aqui.',
  1, 'hours', 0,
  (SELECT group_concat(p."id", ',') FROM "Procedure" p WHERE p."clinicId" = c."id" AND (lower(p."name") LIKE '%botox%' OR lower(p."name") LIKE '%toxina%')),
  CASE WHEN EXISTS (
    SELECT 1 FROM "PostProcedureRule" x
    WHERE x."clinicId" = c."id" AND x."active" = 1
      AND (x."procedureIds" = '' OR EXISTS (
        SELECT 1 FROM "Procedure" p2
        WHERE p2."clinicId" = c."id" AND (lower(p2."name") LIKE '%botox%' OR lower(p2."name") LIKE '%toxina%') AND (',' || x."procedureIds" || ',') LIKE '%,' || p2."id" || ',%'))
  ) THEN 0 ELSE 1 END
FROM "Clinic" c
WHERE c."name" = 'Lisboa Beauty Center'
  AND NOT EXISTS (SELECT 1 FROM "PostProcedureRule" y WHERE y."clinicId" = c."id" AND y."name" = 'Pós - Botox')
  AND EXISTS (SELECT 1 FROM "Procedure" p3 WHERE p3."clinicId" = c."id" AND (lower(p3."name") LIKE '%botox%' OR lower(p3."name") LIKE '%toxina%'));

INSERT INTO "PostProcedureRule" ("id", "clinicId", "name", "message", "intervalValue", "intervalUnit", "onlyIfCompleted", "procedureIds", "active")
SELECT lower(hex(randomblob(12))), c."id", 'Pós - Preenchimento facial/labial',
  'Oi, {primeiro_nome}! 💗 Foi um prazer cuidar de você hoje!' || char(10) || '' || char(10) || 'Para uma recuperação tranquila após o seu preenchimento:' || char(10) || '• É possível apresentar inchaço, sensibilidade ou pequenos hematomas nos primeiros dias.' || char(10) || '• Em caso de hematomas, utilize Hirudoid conforme orientação da profissional.' || char(10) || '• Evite maquiagem nas próximas 24h.' || char(10) || '• Evite atividade física intensa, exposição solar, sauna e calor excessivo por 72h.' || char(10) || '• Não massageie, aperte ou pressione a região tratada.' || char(10) || '• Caso tenha recebido orientação para compressa fria, siga conforme explicado pela profissional.' || char(10) || '' || char(10) || '💬 Se notar qualquer alteração que te preocupe, entre em contato conosco.',
  1, 'hours', 0,
  (SELECT group_concat(p."id", ',') FROM "Procedure" p WHERE p."clinicId" = c."id" AND (lower(p."name") LIKE '%preench%' AND lower(p."name") NOT LIKE '%gl_teo%')),
  CASE WHEN EXISTS (
    SELECT 1 FROM "PostProcedureRule" x
    WHERE x."clinicId" = c."id" AND x."active" = 1
      AND (x."procedureIds" = '' OR EXISTS (
        SELECT 1 FROM "Procedure" p2
        WHERE p2."clinicId" = c."id" AND (lower(p2."name") LIKE '%preench%' AND lower(p2."name") NOT LIKE '%gl_teo%') AND (',' || x."procedureIds" || ',') LIKE '%,' || p2."id" || ',%'))
  ) THEN 0 ELSE 1 END
FROM "Clinic" c
WHERE c."name" = 'Lisboa Beauty Center'
  AND NOT EXISTS (SELECT 1 FROM "PostProcedureRule" y WHERE y."clinicId" = c."id" AND y."name" = 'Pós - Preenchimento facial/labial')
  AND EXISTS (SELECT 1 FROM "Procedure" p3 WHERE p3."clinicId" = c."id" AND (lower(p3."name") LIKE '%preench%' AND lower(p3."name") NOT LIKE '%gl_teo%'));

INSERT INTO "PostProcedureRule" ("id", "clinicId", "name", "message", "intervalValue", "intervalUnit", "onlyIfCompleted", "procedureIds", "active")
SELECT lower(hex(randomblob(12))), c."id", 'Pós - Enzimas',
  'Oi, {primeiro_nome}! 💗 Seu procedimento de hoje foi concluído!' || char(10) || '' || char(10) || 'Agora é importante manter alguns cuidados após a aplicação de enzimas:' || char(10) || '• Beba bastante água nos próximos dias.' || char(10) || '• Evite exposição solar na região tratada nas próximas 48h.' || char(10) || '• Não aplique cremes ou cosméticos na região nas próximas 24h.' || char(10) || '• A atividade física pode ser realizada após 4 horas, conforme orientação da equipe.' || char(10) || '• Pode ocorrer vermelhidão, sensibilidade ou pequenos hematomas na região.' || char(10) || '' || char(10) || '✨ Mantenha uma alimentação equilibrada e siga as orientações passadas durante seu atendimento.' || char(10) || '' || char(10) || 'Qualquer dúvida ou alteração diferente do esperado, nos chame por aqui.',
  1, 'hours', 0,
  (SELECT group_concat(p."id", ',') FROM "Procedure" p WHERE p."clinicId" = c."id" AND (lower(p."name") LIKE '%enzima%')),
  CASE WHEN EXISTS (
    SELECT 1 FROM "PostProcedureRule" x
    WHERE x."clinicId" = c."id" AND x."active" = 1
      AND (x."procedureIds" = '' OR EXISTS (
        SELECT 1 FROM "Procedure" p2
        WHERE p2."clinicId" = c."id" AND (lower(p2."name") LIKE '%enzima%') AND (',' || x."procedureIds" || ',') LIKE '%,' || p2."id" || ',%'))
  ) THEN 0 ELSE 1 END
FROM "Clinic" c
WHERE c."name" = 'Lisboa Beauty Center'
  AND NOT EXISTS (SELECT 1 FROM "PostProcedureRule" y WHERE y."clinicId" = c."id" AND y."name" = 'Pós - Enzimas')
  AND EXISTS (SELECT 1 FROM "Procedure" p3 WHERE p3."clinicId" = c."id" AND (lower(p3."name") LIKE '%enzima%'));

INSERT INTO "PostProcedureRule" ("id", "clinicId", "name", "message", "intervalValue", "intervalUnit", "onlyIfCompleted", "procedureIds", "active")
SELECT lower(hex(randomblob(12))), c."id", 'Pós - Bioestimulador de colágeno',
  'Oi, {primeiro_nome}! 💗 Foi um prazer cuidar de você hoje!' || char(10) || '' || char(10) || 'Para favorecer uma boa recuperação após o seu Bioestimulador de Colágeno:' || char(10) || '• Realize a automassagem exatamente da forma e na frequência orientadas pela profissional, durante os próximos 5 dias.' || char(10) || '• É possível apresentar inchaço, sensibilidade ou pequenos hematomas na região.' || char(10) || '• Evite exposição solar e calor excessivo nos primeiros dias.' || char(10) || '• Não manipule a região além das massagens que foram orientadas.' || char(10) || '' || char(10) || '✨ O resultado acontece de forma gradual, já que o objetivo é estimular a produção de colágeno ao longo do tempo.' || char(10) || '' || char(10) || 'Qualquer dúvida sobre a massagem ou sobre sua recuperação, fale com nossa equipe.',
  1, 'hours', 0,
  (SELECT group_concat(p."id", ',') FROM "Procedure" p WHERE p."clinicId" = c."id" AND (lower(p."name") LIKE '%bioestimul%' OR lower(p."name") LIKE '%sculptra%' OR lower(p."name") LIKE '%radiesse%' OR lower(p."name") LIKE '%elleva%')),
  CASE WHEN EXISTS (
    SELECT 1 FROM "PostProcedureRule" x
    WHERE x."clinicId" = c."id" AND x."active" = 1
      AND (x."procedureIds" = '' OR EXISTS (
        SELECT 1 FROM "Procedure" p2
        WHERE p2."clinicId" = c."id" AND (lower(p2."name") LIKE '%bioestimul%' OR lower(p2."name") LIKE '%sculptra%' OR lower(p2."name") LIKE '%radiesse%' OR lower(p2."name") LIKE '%elleva%') AND (',' || x."procedureIds" || ',') LIKE '%,' || p2."id" || ',%'))
  ) THEN 0 ELSE 1 END
FROM "Clinic" c
WHERE c."name" = 'Lisboa Beauty Center'
  AND NOT EXISTS (SELECT 1 FROM "PostProcedureRule" y WHERE y."clinicId" = c."id" AND y."name" = 'Pós - Bioestimulador de colágeno')
  AND EXISTS (SELECT 1 FROM "Procedure" p3 WHERE p3."clinicId" = c."id" AND (lower(p3."name") LIKE '%bioestimul%' OR lower(p3."name") LIKE '%sculptra%' OR lower(p3."name") LIKE '%radiesse%' OR lower(p3."name") LIKE '%elleva%'));

INSERT INTO "PostProcedureRule" ("id", "clinicId", "name", "message", "intervalValue", "intervalUnit", "onlyIfCompleted", "procedureIds", "active")
SELECT lower(hex(randomblob(12))), c."id", 'Pós - Preenchimento de glúteo',
  'Oi, {primeiro_nome}! 💗✨ Foi um prazer cuidar de você hoje!' || char(10) || '' || char(10) || 'Agora, alguns cuidados importantes após o seu preenchimento de glúteo:' || char(10) || '• Evite exercícios físicos que envolvam intensamente a região glútea pelos próximos 7 dias.' || char(10) || '• Evite pressão direta sobre a região tratada nas primeiras 48h.' || char(10) || '• Evite permanecer por longos períodos em superfícies muito rígidas.' || char(10) || '• É possível apresentar inchaço, sensibilidade ou pequenos hematomas nos primeiros dias.' || char(10) || '• Mantenha uma boa hidratação e alimentação equilibrada.' || char(10) || '' || char(10) || '💬 Se perceber qualquer alteração que te preocupe ou tiver dúvida sobre sua recuperação, fale conosco por aqui.',
  1, 'hours', 0,
  (SELECT group_concat(p."id", ',') FROM "Procedure" p WHERE p."clinicId" = c."id" AND (lower(p."name") LIKE '%preench%' AND lower(p."name") LIKE '%gl_teo%')),
  CASE WHEN EXISTS (
    SELECT 1 FROM "PostProcedureRule" x
    WHERE x."clinicId" = c."id" AND x."active" = 1
      AND (x."procedureIds" = '' OR EXISTS (
        SELECT 1 FROM "Procedure" p2
        WHERE p2."clinicId" = c."id" AND (lower(p2."name") LIKE '%preench%' AND lower(p2."name") LIKE '%gl_teo%') AND (',' || x."procedureIds" || ',') LIKE '%,' || p2."id" || ',%'))
  ) THEN 0 ELSE 1 END
FROM "Clinic" c
WHERE c."name" = 'Lisboa Beauty Center'
  AND NOT EXISTS (SELECT 1 FROM "PostProcedureRule" y WHERE y."clinicId" = c."id" AND y."name" = 'Pós - Preenchimento de glúteo')
  AND EXISTS (SELECT 1 FROM "Procedure" p3 WHERE p3."clinicId" = c."id" AND (lower(p3."name") LIKE '%preench%' AND lower(p3."name") LIKE '%gl_teo%'));

INSERT INTO "PostProcedureRule" ("id", "clinicId", "name", "message", "intervalValue", "intervalUnit", "onlyIfCompleted", "procedureIds", "active")
SELECT lower(hex(randomblob(12))), c."id", 'Pós - Pump glúteo',
  'Oi, {primeiro_nome}! 💗✨ Finalizamos seu Pump Glúteo de hoje!' || char(10) || '' || char(10) || 'Para cuidar da região após o procedimento:' || char(10) || '• Beba bastante água ao longo do dia.' || char(10) || '• Evite atividade física intensa nas próximas 24h.' || char(10) || '• Evite pressão direta sobre a região nas primeiras horas.' || char(10) || '• Pode ocorrer leve vermelhidão, sensibilidade ou pequenos hematomas.' || char(10) || '' || char(10) || '✨ A continuidade das sessões é importante para acompanhar a evolução do protocolo conforme o planejamento realizado para você.' || char(10) || '' || char(10) || 'Qualquer dúvida, estamos por aqui!',
  1, 'hours', 0,
  (SELECT group_concat(p."id", ',') FROM "Procedure" p WHERE p."clinicId" = c."id" AND (lower(p."name") LIKE '%pump%')),
  CASE WHEN EXISTS (
    SELECT 1 FROM "PostProcedureRule" x
    WHERE x."clinicId" = c."id" AND x."active" = 1
      AND (x."procedureIds" = '' OR EXISTS (
        SELECT 1 FROM "Procedure" p2
        WHERE p2."clinicId" = c."id" AND (lower(p2."name") LIKE '%pump%') AND (',' || x."procedureIds" || ',') LIKE '%,' || p2."id" || ',%'))
  ) THEN 0 ELSE 1 END
FROM "Clinic" c
WHERE c."name" = 'Lisboa Beauty Center'
  AND NOT EXISTS (SELECT 1 FROM "PostProcedureRule" y WHERE y."clinicId" = c."id" AND y."name" = 'Pós - Pump glúteo')
  AND EXISTS (SELECT 1 FROM "Procedure" p3 WHERE p3."clinicId" = c."id" AND (lower(p3."name") LIKE '%pump%'));

INSERT INTO "PostProcedureRule" ("id", "clinicId", "name", "message", "intervalValue", "intervalUnit", "onlyIfCompleted", "procedureIds", "active")
SELECT lower(hex(randomblob(12))), c."id", 'Pós - Limpeza de pele',
  'Oi, {primeiro_nome}! 💗 Foi um prazer cuidar da sua pele hoje!' || char(10) || '' || char(10) || 'Para manter sua pele protegida após a Limpeza de Pele:' || char(10) || '• Evite exposição solar direta nas próximas 48h.' || char(10) || '• Use protetor solar diariamente e lembre-se da reaplicação.' || char(10) || '• Evite maquiagem nas próximas 24h.' || char(10) || '• Não esprema, cutuque ou manipule a pele.' || char(10) || '• Pode ocorrer uma leve vermelhidão nas primeiras horas.' || char(10) || '' || char(10) || '💬 Qualquer dúvida sobre como sua pele está reagindo, pode falar com a gente por aqui.',
  1, 'hours', 0,
  (SELECT group_concat(p."id", ',') FROM "Procedure" p WHERE p."clinicId" = c."id" AND (lower(p."name") LIKE '%limpeza%')),
  CASE WHEN EXISTS (
    SELECT 1 FROM "PostProcedureRule" x
    WHERE x."clinicId" = c."id" AND x."active" = 1
      AND (x."procedureIds" = '' OR EXISTS (
        SELECT 1 FROM "Procedure" p2
        WHERE p2."clinicId" = c."id" AND (lower(p2."name") LIKE '%limpeza%') AND (',' || x."procedureIds" || ',') LIKE '%,' || p2."id" || ',%'))
  ) THEN 0 ELSE 1 END
FROM "Clinic" c
WHERE c."name" = 'Lisboa Beauty Center'
  AND NOT EXISTS (SELECT 1 FROM "PostProcedureRule" y WHERE y."clinicId" = c."id" AND y."name" = 'Pós - Limpeza de pele')
  AND EXISTS (SELECT 1 FROM "Procedure" p3 WHERE p3."clinicId" = c."id" AND (lower(p3."name") LIKE '%limpeza%'));

INSERT INTO "PostProcedureRule" ("id", "clinicId", "name", "message", "intervalValue", "intervalUnit", "onlyIfCompleted", "procedureIds", "active")
SELECT lower(hex(randomblob(12))), c."id", 'Pós - Detox',
  'Oi, {primeiro_nome}! 💗 Finalizamos seu Detox de hoje!' || char(10) || '' || char(10) || 'Agora, alguns cuidados para complementar o seu protocolo:' || char(10) || '• Beba bastante água, de preferência pelo menos 2 litros por dia.' || char(10) || '• Evite alimentos industrializados, frituras e bebidas alcoólicas nas próximas 24h.' || char(10) || '• Evite exposição solar intensa e banhos muito quentes nas próximas 6h.' || char(10) || '• Mantenha uma alimentação leve e equilibrada.' || char(10) || '' || char(10) || '✨ Continue cuidando de você e, se tiver qualquer dúvida, estamos por aqui!',
  1, 'hours', 0,
  (SELECT group_concat(p."id", ',') FROM "Procedure" p WHERE p."clinicId" = c."id" AND (lower(p."name") LIKE '%detox%')),
  CASE WHEN EXISTS (
    SELECT 1 FROM "PostProcedureRule" x
    WHERE x."clinicId" = c."id" AND x."active" = 1
      AND (x."procedureIds" = '' OR EXISTS (
        SELECT 1 FROM "Procedure" p2
        WHERE p2."clinicId" = c."id" AND (lower(p2."name") LIKE '%detox%') AND (',' || x."procedureIds" || ',') LIKE '%,' || p2."id" || ',%'))
  ) THEN 0 ELSE 1 END
FROM "Clinic" c
WHERE c."name" = 'Lisboa Beauty Center'
  AND NOT EXISTS (SELECT 1 FROM "PostProcedureRule" y WHERE y."clinicId" = c."id" AND y."name" = 'Pós - Detox')
  AND EXISTS (SELECT 1 FROM "Procedure" p3 WHERE p3."clinicId" = c."id" AND (lower(p3."name") LIKE '%detox%'));

INSERT INTO "PostProcedureRule" ("id", "clinicId", "name", "message", "intervalValue", "intervalUnit", "onlyIfCompleted", "procedureIds", "active")
SELECT lower(hex(randomblob(12))), c."id", 'Pós - Escleroterapia/secagem de vasinhos',
  'Oi, {primeiro_nome}! 💗 Foi um prazer cuidar de você hoje!' || char(10) || '' || char(10) || 'Após a sua Secagem de Vasinhos:' || char(10) || '• Evite exposição solar na região tratada pelos próximos 15 dias.' || char(10) || '• Evite exercícios físicos intensos nas próximas 24h.' || char(10) || '• Não coce, esfregue ou manipule a região.' || char(10) || '• Podem surgir pequenos hematomas ou leve coceira após o procedimento.' || char(10) || '• Caso tenha sido orientado o uso de meia compressiva, siga a recomendação passada pela profissional.' || char(10) || '' || char(10) || '💬 Se perceber alguma reação que te preocupe, fale com nossa equipe.',
  1, 'hours', 0,
  (SELECT group_concat(p."id", ',') FROM "Procedure" p WHERE p."clinicId" = c."id" AND (lower(p."name") LIKE '%escleroterapia%' OR lower(p."name") LIKE '%secagem%' OR lower(p."name") LIKE '%vasinho%')),
  CASE WHEN EXISTS (
    SELECT 1 FROM "PostProcedureRule" x
    WHERE x."clinicId" = c."id" AND x."active" = 1
      AND (x."procedureIds" = '' OR EXISTS (
        SELECT 1 FROM "Procedure" p2
        WHERE p2."clinicId" = c."id" AND (lower(p2."name") LIKE '%escleroterapia%' OR lower(p2."name") LIKE '%secagem%' OR lower(p2."name") LIKE '%vasinho%') AND (',' || x."procedureIds" || ',') LIKE '%,' || p2."id" || ',%'))
  ) THEN 0 ELSE 1 END
FROM "Clinic" c
WHERE c."name" = 'Lisboa Beauty Center'
  AND NOT EXISTS (SELECT 1 FROM "PostProcedureRule" y WHERE y."clinicId" = c."id" AND y."name" = 'Pós - Escleroterapia/secagem de vasinhos')
  AND EXISTS (SELECT 1 FROM "Procedure" p3 WHERE p3."clinicId" = c."id" AND (lower(p3."name") LIKE '%escleroterapia%' OR lower(p3."name") LIKE '%secagem%' OR lower(p3."name") LIKE '%vasinho%'));

INSERT INTO "PostProcedureRule" ("id", "clinicId", "name", "message", "intervalValue", "intervalUnit", "onlyIfCompleted", "procedureIds", "active")
SELECT lower(hex(randomblob(12))), c."id", 'Pós - Microagulhamento',
  'Oi, {primeiro_nome}! 💗 Seu Microagulhamento foi realizado hoje e agora sua pele precisa de alguns cuidados especiais:' || char(10) || '' || char(10) || '• Evite exposição solar pelos próximos 15 dias.' || char(10) || '• Não use maquiagem nas próximas 24h.' || char(10) || '• Use protetor solar diariamente e faça a reaplicação ao longo do dia.' || char(10) || '• Evite produtos com ácidos pelos próximos 7 dias.' || char(10) || '• É possível apresentar vermelhidão, leve ardência ou descamação durante a recuperação.' || char(10) || '' || char(10) || '💬 Evite manipular a pele e, se tiver qualquer dúvida, fale conosco por aqui.',
  1, 'hours', 0,
  (SELECT group_concat(p."id", ',') FROM "Procedure" p WHERE p."clinicId" = c."id" AND (lower(p."name") LIKE '%microagulh%')),
  CASE WHEN EXISTS (
    SELECT 1 FROM "PostProcedureRule" x
    WHERE x."clinicId" = c."id" AND x."active" = 1
      AND (x."procedureIds" = '' OR EXISTS (
        SELECT 1 FROM "Procedure" p2
        WHERE p2."clinicId" = c."id" AND (lower(p2."name") LIKE '%microagulh%') AND (',' || x."procedureIds" || ',') LIKE '%,' || p2."id" || ',%'))
  ) THEN 0 ELSE 1 END
FROM "Clinic" c
WHERE c."name" = 'Lisboa Beauty Center'
  AND NOT EXISTS (SELECT 1 FROM "PostProcedureRule" y WHERE y."clinicId" = c."id" AND y."name" = 'Pós - Microagulhamento')
  AND EXISTS (SELECT 1 FROM "Procedure" p3 WHERE p3."clinicId" = c."id" AND (lower(p3."name") LIKE '%microagulh%'));

INSERT INTO "PostProcedureRule" ("id", "clinicId", "name", "message", "intervalValue", "intervalUnit", "onlyIfCompleted", "procedureIds", "active")
SELECT lower(hex(randomblob(12))), c."id", 'Pós - Hidrolipoclasia não aspirativa',
  'Oi, {primeiro_nome}! 💗 Finalizamos sua Hidrolipoclasia Não Aspirativa de hoje!' || char(10) || '' || char(10) || 'Para cuidar da região e acompanhar a evolução do seu protocolo:' || char(10) || '• Beba pelo menos 2 litros de água por dia.' || char(10) || '• Use a cinta modeladora conforme orientação da nossa equipe.' || char(10) || '• Evite exposição solar e o uso de cremes na região nas próximas 24h.' || char(10) || '• Pode ocorrer inchaço, sensibilidade ou pequenos hematomas.' || char(10) || '• Mantenha atividade física conforme a orientação recebida.' || char(10) || '• Uma alimentação equilibrada e os cuidados complementares ajudam na continuidade do protocolo.' || char(10) || '' || char(10) || '💬 Qualquer dúvida ou reação diferente do esperado, fale conosco.',
  1, 'hours', 0,
  (SELECT group_concat(p."id", ',') FROM "Procedure" p WHERE p."clinicId" = c."id" AND (lower(p."name") LIKE '%hidrolipo%')),
  CASE WHEN EXISTS (
    SELECT 1 FROM "PostProcedureRule" x
    WHERE x."clinicId" = c."id" AND x."active" = 1
      AND (x."procedureIds" = '' OR EXISTS (
        SELECT 1 FROM "Procedure" p2
        WHERE p2."clinicId" = c."id" AND (lower(p2."name") LIKE '%hidrolipo%') AND (',' || x."procedureIds" || ',') LIKE '%,' || p2."id" || ',%'))
  ) THEN 0 ELSE 1 END
FROM "Clinic" c
WHERE c."name" = 'Lisboa Beauty Center'
  AND NOT EXISTS (SELECT 1 FROM "PostProcedureRule" y WHERE y."clinicId" = c."id" AND y."name" = 'Pós - Hidrolipoclasia não aspirativa')
  AND EXISTS (SELECT 1 FROM "Procedure" p3 WHERE p3."clinicId" = c."id" AND (lower(p3."name") LIKE '%hidrolipo%'));

INSERT INTO "PostProcedureRule" ("id", "clinicId", "name", "message", "intervalValue", "intervalUnit", "onlyIfCompleted", "procedureIds", "active")
SELECT lower(hex(randomblob(12))), c."id", 'Pós - Skinbooster',
  'Oi, {primeiro_nome}! 💗 Foi um prazer cuidar da sua pele hoje!' || char(10) || '' || char(10) || 'Após o Skinbooster:' || char(10) || '• Evite sol, calor excessivo e atividade física nas próximas 24h.' || char(10) || '• Evite maquiagem por 24h.' || char(10) || '• Mantenha a pele bem hidratada nos próximos dias.' || char(10) || '• Pode ocorrer leve inchaço ou pequenos hematomas na região.' || char(10) || '' || char(10) || '✨ O resultado acontece de forma gradual e acompanha a evolução da hidratação e qualidade da pele.' || char(10) || '' || char(10) || 'Qualquer dúvida, estamos por aqui!',
  1, 'hours', 0,
  (SELECT group_concat(p."id", ',') FROM "Procedure" p WHERE p."clinicId" = c."id" AND (lower(p."name") LIKE '%skinbooster%' OR lower(p."name") LIKE '%skin booster%')),
  CASE WHEN EXISTS (
    SELECT 1 FROM "PostProcedureRule" x
    WHERE x."clinicId" = c."id" AND x."active" = 1
      AND (x."procedureIds" = '' OR EXISTS (
        SELECT 1 FROM "Procedure" p2
        WHERE p2."clinicId" = c."id" AND (lower(p2."name") LIKE '%skinbooster%' OR lower(p2."name") LIKE '%skin booster%') AND (',' || x."procedureIds" || ',') LIKE '%,' || p2."id" || ',%'))
  ) THEN 0 ELSE 1 END
FROM "Clinic" c
WHERE c."name" = 'Lisboa Beauty Center'
  AND NOT EXISTS (SELECT 1 FROM "PostProcedureRule" y WHERE y."clinicId" = c."id" AND y."name" = 'Pós - Skinbooster')
  AND EXISTS (SELECT 1 FROM "Procedure" p3 WHERE p3."clinicId" = c."id" AND (lower(p3."name") LIKE '%skinbooster%' OR lower(p3."name") LIKE '%skin booster%'));

INSERT INTO "PostProcedureRule" ("id", "clinicId", "name", "message", "intervalValue", "intervalUnit", "onlyIfCompleted", "procedureIds", "active")
SELECT lower(hex(randomblob(12))), c."id", 'Pós - Peeling químico',
  'Oi, {primeiro_nome}! 💗 Seu Peeling Químico foi realizado hoje!' || char(10) || '' || char(10) || 'Agora começa uma etapa muito importante: os cuidados em casa.' || char(10) || '• Evite exposição solar por pelo menos 15 dias.' || char(10) || '• Use protetor solar diariamente e faça a reaplicação.' || char(10) || '• É normal a pele começar a descamar - não puxe nem retire as pelinhas.' || char(10) || '• Evite maquiagem enquanto houver descamação.' || char(10) || '• Mantenha a pele bem hidratada com o produto orientado pela nossa equipe.' || char(10) || '' || char(10) || '💬 Qualquer dúvida sobre a evolução da pele, nos chame por aqui.',
  1, 'hours', 0,
  (SELECT group_concat(p."id", ',') FROM "Procedure" p WHERE p."clinicId" = c."id" AND (lower(p."name") LIKE '%peeling%')),
  CASE WHEN EXISTS (
    SELECT 1 FROM "PostProcedureRule" x
    WHERE x."clinicId" = c."id" AND x."active" = 1
      AND (x."procedureIds" = '' OR EXISTS (
        SELECT 1 FROM "Procedure" p2
        WHERE p2."clinicId" = c."id" AND (lower(p2."name") LIKE '%peeling%') AND (',' || x."procedureIds" || ',') LIKE '%,' || p2."id" || ',%'))
  ) THEN 0 ELSE 1 END
FROM "Clinic" c
WHERE c."name" = 'Lisboa Beauty Center'
  AND NOT EXISTS (SELECT 1 FROM "PostProcedureRule" y WHERE y."clinicId" = c."id" AND y."name" = 'Pós - Peeling químico')
  AND EXISTS (SELECT 1 FROM "Procedure" p3 WHERE p3."clinicId" = c."id" AND (lower(p3."name") LIKE '%peeling%'));

INSERT INTO "PostProcedureRule" ("id", "clinicId", "name", "message", "intervalValue", "intervalUnit", "onlyIfCompleted", "procedureIds", "active")
SELECT lower(hex(randomblob(12))), c."id", 'Pós - Subcisão',
  'Oi, {primeiro_nome}! 💗 Passando para reforçar os cuidados após sua Subcisão de hoje:' || char(10) || '' || char(10) || '• Pode ocorrer inchaço, sensibilidade e formação de hematomas.' || char(10) || '• Evite esforço físico nas próximas 24h.' || char(10) || '• Não massageie, aperte ou manipule a região tratada.' || char(10) || '• Prefira roupas leves e confortáveis.' || char(10) || '• Evite calor excessivo.' || char(10) || '• Beba bastante água nos próximos dias.' || char(10) || '' || char(10) || '💬 Se perceber algo que te preocupe durante a recuperação, fale imediatamente com nossa equipe.',
  1, 'hours', 0,
  (SELECT group_concat(p."id", ',') FROM "Procedure" p WHERE p."clinicId" = c."id" AND (lower(p."name") LIKE '%subcis%')),
  CASE WHEN EXISTS (
    SELECT 1 FROM "PostProcedureRule" x
    WHERE x."clinicId" = c."id" AND x."active" = 1
      AND (x."procedureIds" = '' OR EXISTS (
        SELECT 1 FROM "Procedure" p2
        WHERE p2."clinicId" = c."id" AND (lower(p2."name") LIKE '%subcis%') AND (',' || x."procedureIds" || ',') LIKE '%,' || p2."id" || ',%'))
  ) THEN 0 ELSE 1 END
FROM "Clinic" c
WHERE c."name" = 'Lisboa Beauty Center'
  AND NOT EXISTS (SELECT 1 FROM "PostProcedureRule" y WHERE y."clinicId" = c."id" AND y."name" = 'Pós - Subcisão')
  AND EXISTS (SELECT 1 FROM "Procedure" p3 WHERE p3."clinicId" = c."id" AND (lower(p3."name") LIKE '%subcis%'));

INSERT INTO "PostProcedureRule" ("id", "clinicId", "name", "message", "intervalValue", "intervalUnit", "onlyIfCompleted", "procedureIds", "active")
SELECT lower(hex(randomblob(12))), c."id", 'Pós - HIPRO',
  'Oi, {primeiro_nome}! 💗 Foi um prazer realizar seu HIPRO hoje!' || char(10) || '' || char(10) || 'Agora, alguns cuidados importantes:' || char(10) || '• Use protetor solar diariamente.' || char(10) || '• Evite sol intenso, sauna e banhos muito quentes nas próximas 48h.' || char(10) || '• Mantenha a pele bem hidratada.' || char(10) || '• Evite ácidos ou produtos irritantes nas próximas 48h.' || char(10) || '• Não realize outros procedimentos na região sem orientação da nossa equipe.' || char(10) || '• Pode ocorrer leve vermelhidão, inchaço ou sensibilidade temporariamente.' || char(10) || '' || char(10) || '✨ O estímulo de colágeno acontece de forma progressiva ao longo dos próximos meses.',
  1, 'hours', 0,
  (SELECT group_concat(p."id", ',') FROM "Procedure" p WHERE p."clinicId" = c."id" AND (lower(p."name") LIKE '%hipro%')),
  CASE WHEN EXISTS (
    SELECT 1 FROM "PostProcedureRule" x
    WHERE x."clinicId" = c."id" AND x."active" = 1
      AND (x."procedureIds" = '' OR EXISTS (
        SELECT 1 FROM "Procedure" p2
        WHERE p2."clinicId" = c."id" AND (lower(p2."name") LIKE '%hipro%') AND (',' || x."procedureIds" || ',') LIKE '%,' || p2."id" || ',%'))
  ) THEN 0 ELSE 1 END
FROM "Clinic" c
WHERE c."name" = 'Lisboa Beauty Center'
  AND NOT EXISTS (SELECT 1 FROM "PostProcedureRule" y WHERE y."clinicId" = c."id" AND y."name" = 'Pós - HIPRO')
  AND EXISTS (SELECT 1 FROM "Procedure" p3 WHERE p3."clinicId" = c."id" AND (lower(p3."name") LIKE '%hipro%'));

INSERT INTO "PostProcedureRule" ("id", "clinicId", "name", "message", "intervalValue", "intervalUnit", "onlyIfCompleted", "procedureIds", "active")
SELECT lower(hex(randomblob(12))), c."id", 'Pós - Fios de PDO',
  'Oi, {primeiro_nome}! 💗 Seu procedimento com Fios de PDO foi realizado hoje.' || char(10) || '' || char(10) || 'Para uma recuperação mais tranquila:' || char(10) || '• Pode ocorrer leve inchaço ou pequenos hematomas.' || char(10) || '• Evite atividade física pelos próximos 3 dias.' || char(10) || '• Durma de barriga para cima durante os próximos 7 dias.' || char(10) || '• Não massageie ou pressione a região tratada.' || char(10) || '• Evite movimentos faciais muito intensos, como mastigação excessiva ou movimentos bruscos, nos primeiros dias.' || char(10) || '' || char(10) || '💬 Qualquer dúvida ou alteração que te preocupe, entre em contato conosco.',
  1, 'hours', 0,
  (SELECT group_concat(p."id", ',') FROM "Procedure" p WHERE p."clinicId" = c."id" AND (lower(p."name") LIKE '%pdo%' OR lower(p."name") LIKE '%fios%')),
  CASE WHEN EXISTS (
    SELECT 1 FROM "PostProcedureRule" x
    WHERE x."clinicId" = c."id" AND x."active" = 1
      AND (x."procedureIds" = '' OR EXISTS (
        SELECT 1 FROM "Procedure" p2
        WHERE p2."clinicId" = c."id" AND (lower(p2."name") LIKE '%pdo%' OR lower(p2."name") LIKE '%fios%') AND (',' || x."procedureIds" || ',') LIKE '%,' || p2."id" || ',%'))
  ) THEN 0 ELSE 1 END
FROM "Clinic" c
WHERE c."name" = 'Lisboa Beauty Center'
  AND NOT EXISTS (SELECT 1 FROM "PostProcedureRule" y WHERE y."clinicId" = c."id" AND y."name" = 'Pós - Fios de PDO')
  AND EXISTS (SELECT 1 FROM "Procedure" p3 WHERE p3."clinicId" = c."id" AND (lower(p3."name") LIKE '%pdo%' OR lower(p3."name") LIKE '%fios%'));

INSERT INTO "PostProcedureRule" ("id", "clinicId", "name", "message", "intervalValue", "intervalUnit", "onlyIfCompleted", "procedureIds", "active")
SELECT lower(hex(randomblob(12))), c."id", 'Pós - Lavieen',
  'Oi, {primeiro_nome}! 💗 Foi um prazer realizar seu Lavieen hoje!' || char(10) || '' || char(10) || 'Agora começa uma etapa muito importante: os cuidados com a sua pele em casa.' || char(10) || '• Evite exposição solar nos próximos 7 dias.' || char(10) || '• Use protetor solar diariamente e faça a reaplicação.' || char(10) || '• Mantenha a pele bem hidratada, conforme a orientação recebida.' || char(10) || '• Evite maquiagem nas próximas 24h.' || char(10) || '• Pode ocorrer leve ardência e descamação durante a recuperação.' || char(10) || '' || char(10) || '💬 Não puxe pelinhas e evite acrescentar produtos diferentes à sua rotina sem orientação.' || char(10) || '' || char(10) || 'Se tiver qualquer dúvida sobre como sua pele está evoluindo, fale com a gente. Estamos acompanhando você!',
  1, 'hours', 0,
  (SELECT group_concat(p."id", ',') FROM "Procedure" p WHERE p."clinicId" = c."id" AND (lower(p."name") LIKE '%lavieen%')),
  CASE WHEN EXISTS (
    SELECT 1 FROM "PostProcedureRule" x
    WHERE x."clinicId" = c."id" AND x."active" = 1
      AND (x."procedureIds" = '' OR EXISTS (
        SELECT 1 FROM "Procedure" p2
        WHERE p2."clinicId" = c."id" AND (lower(p2."name") LIKE '%lavieen%') AND (',' || x."procedureIds" || ',') LIKE '%,' || p2."id" || ',%'))
  ) THEN 0 ELSE 1 END
FROM "Clinic" c
WHERE c."name" = 'Lisboa Beauty Center'
  AND NOT EXISTS (SELECT 1 FROM "PostProcedureRule" y WHERE y."clinicId" = c."id" AND y."name" = 'Pós - Lavieen')
  AND EXISTS (SELECT 1 FROM "Procedure" p3 WHERE p3."clinicId" = c."id" AND (lower(p3."name") LIKE '%lavieen%'));

INSERT INTO "PostProcedureRule" ("id", "clinicId", "name", "message", "intervalValue", "intervalUnit", "onlyIfCompleted", "procedureIds", "active")
SELECT lower(hex(randomblob(12))), c."id", 'Pós - Remoção de tatuagem',
  'Oi, {primeiro_nome}! 💗 Finalizamos sua sessão de Remoção de Tatuagem de hoje.' || char(10) || '' || char(10) || 'Agora é muito importante cuidar bem da região:' || char(10) || '• Pode ocorrer vermelhidão, leve inchaço e sensibilidade nas primeiras horas.' || char(10) || '• Mantenha a região limpa e seca nas primeiras 24h.' || char(10) || '• Não coce, esfregue, estoure bolhas ou retire casquinhas.' || char(10) || '• Evite exposição solar até a pele estar totalmente recuperada.' || char(10) || '• Evite piscina, mar, sauna e suor excessivo nos próximos dias.' || char(10) || '• Prefira roupas leves para evitar atrito na região.' || char(10) || '• Hidrate a pele com Bepantol, conforme orientação da equipe.' || char(10) || '• Compressas frias podem ser usadas para conforto nas primeiras horas, conforme orientação recebida.' || char(10) || '' || char(10) || '💬 Caso observe uma reação que te preocupe, fale conosco imediatamente.',
  1, 'hours', 0,
  (SELECT group_concat(p."id", ',') FROM "Procedure" p WHERE p."clinicId" = c."id" AND (lower(p."name") LIKE '%tatuagem%' AND lower(p."name") LIKE '%remo%')),
  CASE WHEN EXISTS (
    SELECT 1 FROM "PostProcedureRule" x
    WHERE x."clinicId" = c."id" AND x."active" = 1
      AND (x."procedureIds" = '' OR EXISTS (
        SELECT 1 FROM "Procedure" p2
        WHERE p2."clinicId" = c."id" AND (lower(p2."name") LIKE '%tatuagem%' AND lower(p2."name") LIKE '%remo%') AND (',' || x."procedureIds" || ',') LIKE '%,' || p2."id" || ',%'))
  ) THEN 0 ELSE 1 END
FROM "Clinic" c
WHERE c."name" = 'Lisboa Beauty Center'
  AND NOT EXISTS (SELECT 1 FROM "PostProcedureRule" y WHERE y."clinicId" = c."id" AND y."name" = 'Pós - Remoção de tatuagem')
  AND EXISTS (SELECT 1 FROM "Procedure" p3 WHERE p3."clinicId" = c."id" AND (lower(p3."name") LIKE '%tatuagem%' AND lower(p3."name") LIKE '%remo%'));

INSERT INTO "PostProcedureRule" ("id", "clinicId", "name", "message", "intervalValue", "intervalUnit", "onlyIfCompleted", "procedureIds", "active")
SELECT lower(hex(randomblob(12))), c."id", 'Pós - Remoção de micropigmentação de sobrancelhas',
  'Oi, {primeiro_nome}! 💗 Finalizamos sua sessão de Remoção de Micropigmentação das Sobrancelhas.' || char(10) || '' || char(10) || 'Agora, alguns cuidados importantes para a região:' || char(10) || '• Pode ocorrer vermelhidão, leve inchaço e sensibilidade nas primeiras horas.' || char(10) || '• Mantenha a região limpa e seca nas primeiras 24h.' || char(10) || '• Não coce, esfregue ou retire casquinhas.' || char(10) || '• Caso surjam bolhas, não estoure nem manipule.' || char(10) || '• Evite exposição solar até a pele estar totalmente recuperada.' || char(10) || '• Evite piscina, mar, sauna e suor excessivo nos próximos dias.' || char(10) || '• Hidrate a região com Bepantol, conforme orientação da equipe.' || char(10) || '' || char(10) || '💬 Qualquer reação que te preocupe ou dúvida sobre a recuperação, fale conosco por aqui.',
  1, 'hours', 0,
  (SELECT group_concat(p."id", ',') FROM "Procedure" p WHERE p."clinicId" = c."id" AND (lower(p."name") LIKE '%micropigment%' AND lower(p."name") LIKE '%remo%')),
  CASE WHEN EXISTS (
    SELECT 1 FROM "PostProcedureRule" x
    WHERE x."clinicId" = c."id" AND x."active" = 1
      AND (x."procedureIds" = '' OR EXISTS (
        SELECT 1 FROM "Procedure" p2
        WHERE p2."clinicId" = c."id" AND (lower(p2."name") LIKE '%micropigment%' AND lower(p2."name") LIKE '%remo%') AND (',' || x."procedureIds" || ',') LIKE '%,' || p2."id" || ',%'))
  ) THEN 0 ELSE 1 END
FROM "Clinic" c
WHERE c."name" = 'Lisboa Beauty Center'
  AND NOT EXISTS (SELECT 1 FROM "PostProcedureRule" y WHERE y."clinicId" = c."id" AND y."name" = 'Pós - Remoção de micropigmentação de sobrancelhas')
  AND EXISTS (SELECT 1 FROM "Procedure" p3 WHERE p3."clinicId" = c."id" AND (lower(p3."name") LIKE '%micropigment%' AND lower(p3."name") LIKE '%remo%'));
