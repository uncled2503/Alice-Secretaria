-- Lisboa (pedido da Aline, 07/10/2026): "vou pensar" não pode ser aceito passivamente.
-- Atualiza o roteiro e a mensagem que já existem em produção (o seed nunca sobrescreve).
UPDATE "Playbook"
SET "name" = 'Paciente vai pensar ou responde só ''ok''',
    "triggerText" = 'Paciente diz ''vou pensar'', ''entendi'', ''ok'', ''depois eu vejo'' ou agradece sem agendar.',
    "goal" = 'Descobrir o motivo e a dúvida real e seguir conduzindo até o agendamento, sem aceitar passivamente.',
    "steps" = 'NÃO se despeça nem diga ''fique à vontade''. Acolha em uma frase curta.' || char(10) ||
              'Pergunte com interesse o que ficou pesando (valor, dúvida sobre o procedimento, resultado, tempo, medo) e qual é a dúvida dela.' || char(10) ||
              'Responda à dúvida com o que está cadastrado e conecte com a queixa que ela contou.' || char(10) ||
              'Proponha a avaliação estética gratuita como forma sem compromisso de tirar as dúvidas.' || char(10) ||
              'Termine perguntando qual dia e turno ficam melhores para a equipe agendar.' || char(10) ||
              'Só encerre se ela recusar com clareza mais de uma vez ou pedir para parar.'
WHERE "name" = 'Paciente vai pensar ou agradece'
  AND "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center');

UPDATE "MessageTemplate"
SET "whenToUse" = 'SÓ depois que o atendimento foi encaminhado/agendado pela equipe, ou se o paciente pedir para parar. Nunca como resposta a ''vou pensar'' ou ''ok'': nesses casos continue a conversa com uma pergunta.'
WHERE "name" = 'Agradecimento e despedida'
  AND "clinicId" IN (SELECT "id" FROM "Clinic" WHERE "name" = 'Lisboa Beauty Center');
