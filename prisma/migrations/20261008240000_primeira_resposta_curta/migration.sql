ALTER TABLE "Clinic" ADD COLUMN "conciseFirstReply" BOOLEAN NOT NULL DEFAULT false;

-- Lisboa (Aline, 08/10/2026): primeiro contato = conversa curta, nao enxurrada de informacao.
UPDATE "Clinic" SET "conciseFirstReply" = 1 WHERE "name" = 'Lisboa Beauty Center';

-- Regra antiga de anuncio mandava "conduzir rapido para qualificacao e agendamento": desativa.
UPDATE "CustomRule" SET "status" = 'inactive'
WHERE "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center')
  AND "instruction" LIKE 'Mensagens vindas de anúncio: reconheça o anúncio citado%';

-- Roteiro do primeiro atendimento: agora e conversa.
UPDATE "Playbook" SET
  "goal" = 'Iniciar uma conversa: se apresentar e perguntar o nome ou o que a pessoa quer melhorar, sem despejar informação.',
  "steps" = 'Apresente-se em UMA mensagem curta (no máximo 2 frases) e, se vier de anúncio, reconheça o assunto em poucas palavras.' || char(10) || 'Faça UMA pergunta para iniciar a conversa: o nome da pessoa ou o que ela gostaria de melhorar hoje, específica ao assunto (gordura: qual região; pele: o que melhorar na pele).' || char(10) || 'NÃO explique o procedimento, NÃO descreva benefícios, NÃO fale de avaliação gratuita, valores ou agendamento nessa primeira mensagem.' || char(10) || 'Espere a resposta. Depois, explique brevemente o que for pertinente ao que ela contou e só então proponha a avaliação.' || char(10) || 'Pergunte o melhor dia e turno para a equipe agendar.'
WHERE "name" = 'Primeiro atendimento' AND "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center');
