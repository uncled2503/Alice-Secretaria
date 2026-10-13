-- Lisboa: pre-procedimentos (material do MKT, 14/10/2026). Enviados LOGO APOS a cliente confirmar o horario na conversa com a
-- Alice (manage_my_appointment "confirm"): a mensagem comeca agradecendo a confirmacao e segue com as orientacoes de preparo.
-- Uma vez por agendamento por regra (PreProcedureSent). Cada regra so vale pros procedimentos da clinica cujo nome combina
-- (o filtro nunca fica vazio: vazio significaria "todos os procedimentos"). Regra com o mesmo nome nao e recriada.
-- Regra de seguranca (src/ai/alice.ts): se a paciente relatar medicamento recente, alteracao de saude, gestacao, amamentacao,
-- alergia ou qualquer duvida clinica antes do procedimento, a Alice encaminha pra equipe e nao improvisa orientacao.

-- CreateTable
CREATE TABLE "PreProcedureRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "procedureIds" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PreProcedureRule_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PreProcedureSent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "appointmentId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PreProcedureSent_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PreProcedureSent_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "PreProcedureRule" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "PreProcedureSent_appointmentId_ruleId_key" ON "PreProcedureSent"("appointmentId", "ruleId");

INSERT INTO "PreProcedureRule" ("id", "clinicId", "name", "message", "procedureIds", "active")
SELECT lower(hex(randomblob(12))), c."id", 'Pré - Lavieen',
  'Obrigada pela confirmação, {primeiro_nome}! 💗' || char(10) || 'Para preparar sua pele para o Lavieen, siga estes cuidados nos 7 dias que antecedem o procedimento:' || char(10) || '• Evite exposição solar.' || char(10) || '• Suspenda o uso de ácidos e produtos irritativos, como retinoides, vitamina C e ácido glicólico.' || char(10) || '• Não realize limpeza de pele, peeling ou outros procedimentos estéticos faciais nesse período.' || char(10) || '• Use protetor solar diariamente e faça a reaplicação.' || char(10) || '• No dia do procedimento, venha com o rosto limpo, sem maquiagem ou cremes.' || char(10) || 'Se tiver dúvida sobre algum produto que esteja usando, fale com a nossa equipe antes do atendimento. ✨',
  (SELECT group_concat(p."id", ',') FROM "Procedure" p WHERE p."clinicId" = c."id" AND (lower(p."name") LIKE '%lavieen%')),
  1
FROM "Clinic" c
WHERE c."name" = 'Lisboa Beauty Center'
  AND NOT EXISTS (SELECT 1 FROM "PreProcedureRule" y WHERE y."clinicId" = c."id" AND y."name" = 'Pré - Lavieen')
  AND EXISTS (SELECT 1 FROM "Procedure" p3 WHERE p3."clinicId" = c."id" AND (lower(p3."name") LIKE '%lavieen%'));

INSERT INTO "PreProcedureRule" ("id", "clinicId", "name", "message", "procedureIds", "active")
SELECT lower(hex(randomblob(12))), c."id", 'Pré - Protocolo de gordura localizada',
  'Obrigada pela confirmação, {primeiro_nome}! 💗' || char(10) || 'Para se preparar para o procedimento, siga estes cuidados nas 24 horas anteriores:' || char(10) || '• Evite bebidas alcoólicas e alimentos muito gordurosos.' || char(10) || '• Beba bastante água no dia anterior e no dia do procedimento.' || char(10) || '• Evite refeições pesadas nas 2 horas que antecedem o atendimento.' || char(10) || '• Venha com roupas leves e confortáveis.' || char(10) || '• No dia do procedimento, não aplique cremes na região que será tratada.',
  (SELECT group_concat(p."id", ',') FROM "Procedure" p WHERE p."clinicId" = c."id" AND (lower(p."name") LIKE '%gordura%' OR lower(p."name") LIKE '%hidrolipo%' OR lower(p."name") LIKE '%enzima%')),
  1
FROM "Clinic" c
WHERE c."name" = 'Lisboa Beauty Center'
  AND NOT EXISTS (SELECT 1 FROM "PreProcedureRule" y WHERE y."clinicId" = c."id" AND y."name" = 'Pré - Protocolo de gordura localizada')
  AND EXISTS (SELECT 1 FROM "Procedure" p3 WHERE p3."clinicId" = c."id" AND (lower(p3."name") LIKE '%gordura%' OR lower(p3."name") LIKE '%hidrolipo%' OR lower(p3."name") LIKE '%enzima%'));

INSERT INTO "PreProcedureRule" ("id", "clinicId", "name", "message", "procedureIds", "active")
SELECT lower(hex(randomblob(12))), c."id", 'Pré - Criolipólise',
  'Obrigada pela confirmação, {primeiro_nome}! 💗' || char(10) || 'Antes da sua criolipólise, siga estas recomendações:' || char(10) || '• Evite bebidas alcoólicas e alimentos muito gordurosos nas 48h anteriores.' || char(10) || '• Hidrate-se bem no dia anterior e no dia do procedimento.' || char(10) || '• Não aplique cremes ou óleos na área que será tratada.' || char(10) || '• Use roupas leves e confortáveis.' || char(10) || '• A pele da região precisa estar íntegra, sem feridas, machucados ou irritações.' || char(10) || '• Se estiver usando antibiótico ou anti-inflamatório, ou houver previsão de iniciar algum deles, avise nossa equipe antes do atendimento.',
  (SELECT group_concat(p."id", ',') FROM "Procedure" p WHERE p."clinicId" = c."id" AND (lower(p."name") LIKE '%criolip%')),
  1
FROM "Clinic" c
WHERE c."name" = 'Lisboa Beauty Center'
  AND NOT EXISTS (SELECT 1 FROM "PreProcedureRule" y WHERE y."clinicId" = c."id" AND y."name" = 'Pré - Criolipólise')
  AND EXISTS (SELECT 1 FROM "Procedure" p3 WHERE p3."clinicId" = c."id" AND (lower(p3."name") LIKE '%criolip%'));

INSERT INTO "PreProcedureRule" ("id", "clinicId", "name", "message", "procedureIds", "active")
SELECT lower(hex(randomblob(12))), c."id", 'Pré - Botox',
  'Obrigada pela confirmação, {primeiro_nome}! 💗' || char(10) || 'Antes do seu Botox, caso tenha ocorrido alguma mudança no seu estado de saúde, iniciado algum medicamento ou tenha qualquer dúvida, nos avise para que nossa equipe possa te orientar corretamente.',
  (SELECT group_concat(p."id", ',') FROM "Procedure" p WHERE p."clinicId" = c."id" AND (lower(p."name") LIKE '%botox%' OR lower(p."name") LIKE '%toxina%')),
  1
FROM "Clinic" c
WHERE c."name" = 'Lisboa Beauty Center'
  AND NOT EXISTS (SELECT 1 FROM "PreProcedureRule" y WHERE y."clinicId" = c."id" AND y."name" = 'Pré - Botox')
  AND EXISTS (SELECT 1 FROM "Procedure" p3 WHERE p3."clinicId" = c."id" AND (lower(p3."name") LIKE '%botox%' OR lower(p3."name") LIKE '%toxina%'));

INSERT INTO "PreProcedureRule" ("id", "clinicId", "name", "message", "procedureIds", "active")
SELECT lower(hex(randomblob(12))), c."id", 'Pré - Preenchimento',
  'Obrigada pela confirmação, {primeiro_nome}! 💕' || char(10) || 'Antes do seu preenchimento, caso tenha iniciado algum medicamento, apresentado alguma alteração de saúde ou tenha qualquer dúvida, nos avise para que nossa equipe possa te orientar corretamente.',
  (SELECT group_concat(p."id", ',') FROM "Procedure" p WHERE p."clinicId" = c."id" AND (lower(p."name") LIKE '%preench%')),
  1
FROM "Clinic" c
WHERE c."name" = 'Lisboa Beauty Center'
  AND NOT EXISTS (SELECT 1 FROM "PreProcedureRule" y WHERE y."clinicId" = c."id" AND y."name" = 'Pré - Preenchimento')
  AND EXISTS (SELECT 1 FROM "Procedure" p3 WHERE p3."clinicId" = c."id" AND (lower(p3."name") LIKE '%preench%'));

INSERT INTO "PreProcedureRule" ("id", "clinicId", "name", "message", "procedureIds", "active")
SELECT lower(hex(randomblob(12))), c."id", 'Pré - Bioestimulador de colágeno',
  'Obrigada pela confirmação, {primeiro_nome}! ✨' || char(10) || 'Antes do seu Bioestimulador de Colágeno, caso tenha ocorrido alguma mudança no seu estado de saúde, iniciado algum medicamento ou tenha qualquer dúvida, nos avise para que nossa equipe possa te orientar corretamente.',
  (SELECT group_concat(p."id", ',') FROM "Procedure" p WHERE p."clinicId" = c."id" AND (lower(p."name") LIKE '%bioestimul%' OR lower(p."name") LIKE '%sculptra%' OR lower(p."name") LIKE '%radiesse%' OR lower(p."name") LIKE '%elleva%')),
  1
FROM "Clinic" c
WHERE c."name" = 'Lisboa Beauty Center'
  AND NOT EXISTS (SELECT 1 FROM "PreProcedureRule" y WHERE y."clinicId" = c."id" AND y."name" = 'Pré - Bioestimulador de colágeno')
  AND EXISTS (SELECT 1 FROM "Procedure" p3 WHERE p3."clinicId" = c."id" AND (lower(p3."name") LIKE '%bioestimul%' OR lower(p3."name") LIKE '%sculptra%' OR lower(p3."name") LIKE '%radiesse%' OR lower(p3."name") LIKE '%elleva%'));

INSERT INTO "PreProcedureRule" ("id", "clinicId", "name", "message", "procedureIds", "active")
SELECT lower(hex(randomblob(12))), c."id", 'Pré - Peeling químico',
  'Obrigada pela confirmação, {primeiro_nome}! 💗' || char(10) || 'Para preparar sua pele para o Peeling Químico:' || char(10) || '• Suspenda o uso de ácidos, como retinol, ácido glicólico e ácido salicílico, antes do procedimento.' || char(10) || '• Evite exposição solar nos dias anteriores.' || char(10) || '• Use protetor solar diariamente.' || char(10) || '• No dia do procedimento, venha com o rosto limpo, sem maquiagem, cremes ou protetor solar.' || char(10) || '• Se estiver em tratamento com isotretinoína (Roacutan), avise nossa equipe com antecedência.' || char(10) || 'Se tiver dúvida sobre algum produto que está usando, fale conosco antes do atendimento. ✨',
  (SELECT group_concat(p."id", ',') FROM "Procedure" p WHERE p."clinicId" = c."id" AND (lower(p."name") LIKE '%peeling%')),
  1
FROM "Clinic" c
WHERE c."name" = 'Lisboa Beauty Center'
  AND NOT EXISTS (SELECT 1 FROM "PreProcedureRule" y WHERE y."clinicId" = c."id" AND y."name" = 'Pré - Peeling químico')
  AND EXISTS (SELECT 1 FROM "Procedure" p3 WHERE p3."clinicId" = c."id" AND (lower(p3."name") LIKE '%peeling%'));
