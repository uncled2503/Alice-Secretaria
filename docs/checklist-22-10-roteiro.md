# Roteiro de validação OPERACIONAL do checklist de 22/10/2026

Este roteiro é **validação real** (conversa/log/CE em produção). Os testes automáticos (`npm test`) são **simulados** e **não substituem** nada daqui. Nada aqui foi executado ainda. **Não simular a passagem de dias**: os critérios de dias consecutivos só contam com dias reais.

Ferramentas: aba **Disparos** (Organização) · `node scripts/disparos-lisboa.mjs [AAAA-MM-DD] [AAAA-MM-DD]` (somente leitura) · Diário de atividades · CE aberto ao lado.

Pré-requisitos (nesta ordem): (1) hotfix da migração aplicado e `/health` com `revision 2026-10-22-b…`; (2) webhook reaplicado (evento `messages_update`); (3) aprovar/aplicar com prévia: jornadas (Suelen/Adriana 12–21h, Talita 8–17h), pós para todos (`todosProcedimentos`), regras de recontato conferidas; (4) clínica preenche/aprova as datas especiais (`/special-dates`) e confirma o link do Google.

## Critérios de baixa (do PDF)

- **Confirmações:** evidência de **dois dias consecutivos** (hoje + dia seguinte) com relatório elegíveis × enviados × retidos × falhos e motivo por paciente.
- **Aniversários:** evidência de **três dias consecutivos** com aniversariantes encontrados × elegíveis × enviados × falhas.
- Demais itens: uma execução real documentada (print/log/exemplo) por item.

## Execução

| # | Teste (PDF §15) | Como executar | Evidência a anexar | Status |
| --- | --- | --- | --- | --- |
| 1 | Comparar **10+** agendamentos CE × Alice (data, hora, procedimento, profissional, status) | escolher 10+ do CE (incl. 1 remarcado e 1 cancelado); conferir na aba Disparos/Compromissos | tabela CE × Alice com divergências | PEND |
| 2 | Confirmação do **próprio dia** (5 elegíveis) | rodar no dia; Disparos → Hoje | print da aba + relatório do script; "sem envio" com motivo | PEND |
| 3 | Confirmação do **dia seguinte** 8–9h (5 pacientes) | acompanhar 8h–9h do dia anterior | log por paciente (horário de aceite) | PEND |
| 4 | Agendamento **criado após 9h** → catch-up no mesmo dia | criar no CE/painel depois das 9h para amanhã | linha "reposição" no Disparos com hora | PEND |
| 5 | **Sábado completo** quarta+sexta+sábado, sem duplicidade | acompanhar os 3 dias para os mesmos agendados (inclui um já confirmado) | 3 linhas por paciente; sexta inclui confirmados | PEND |
| 6 | **Remarcação**: horário antigo não recebe | remarcar após o pedido; observar o ciclo seguinte | histórico: nada para o horário antigo | PEND |
| 7 | **Cancelamento**: não recebe | cancelar e aguardar a janela | linha "excluído: cancelado" | PEND |
| 8 | **Reserva sem procedimento**: confirmação neutra | reserva sem procedimento vinculado | mensagem com só data/hora | PEND |
| 9 | **Recontato 1 dia 8h–10h** | lead que parou de responder no dia anterior | hora do envio entre 8h e 10h | PEND |
| 10 | Recontato com cliente que **respondeu / agendou / opt-out** | preparar 3 contatos | os 3 retidos com motivo | PEND |
| 11 | **Aniversariante** (3 dias consecutivos) | aniversariantes reais de 3 dias seguidos | log diário encontrados/elegíveis/enviados/falhas | PEND |
| 12 | **Pós após 21h** | atendimento que termina após 21h (concluído no sistema) | pós aceito antes de `lateSendUntilHour`; não envia lote antigo à madrugada | PEND |
| 13 | Lead de **clareamento corporal** | conversa de teste | sem indicação de gordura/celulite/flacidez | PEND |
| 14 | Lead **genérico de gordura localizada** | conversa de teste | queixa investigada antes de indicar | PEND |
| 15 | Cliente que quer **procedimento específico** | conversa de teste | horários do procedimento (se agendável) | PEND |
| 16 | Conversa já agendada + **"obrigada"** | conversa de teste | agradece, sem nova oferta | PEND |
| 17 | **Currículo** | enviar currículo de teste | silêncio + equipe avisada + contato "não-paciente: currículo" | PEND |
| 18 | **Parceria / IA de parceiro** | proposta de parceria de teste; deixar a "IA" insistir | Alice não conversa em loop; sem recontato; classificação visível e **corrigível** no cadastro | PEND |
| 19 | **Resposta a disparo promocional configurado para humano** | campanha de teste com "atendimento humano" para 2 contatos | conversa na equipe com pendência; **sem** resposta da Alice; retorno por inatividade não devolve | PEND |
| 20 | **Satisfação já enviada <15 dias** | paciente com pesquisa recente | nova pesquisa retida | PEND |
| 21 | **Nota positiva + Google + indicação separada** | nota 9/10 de teste (com link correto configurado) | agradecimento + link; indicação em mensagem separada | PEND |
| 22 | **Nota baixa** | nota 3/10 | equipe avisada; sem pedido de avaliação pública | PEND |
| 23 | **Duas pessoas** (cliente + acompanhante) | pedido para duas | dois atendimentos; nome completo/telefone do acompanhante | PEND |
| 24 | **Pergunta informativa antes de horários** | "quantas sessões?" | resposta cadastrada antes de qualquer horário | PEND |
| 25 | **Erro/barreira em uma conversa enquanto outra responde** | provocar falha controlada em uma conversa | a outra segue; falha rastreável | PEND |
| 26 | Pesquisa **durante atendimento humano** | nota enviada com a equipe na conversa | nota registrada; Alice não responde | PEND |
| 27 | **Datas especiais**: antes/dia/depois da vigência (dependem da clínica aprovar) | simular no cadastro (data local) | Alice cita só o aprovado; some após a vigência; recesso sem retorno não inventa | PEND (DC) |

## Registro

Para cada linha: STATUS (Concluído e validado / Implementado aguardando teste / Em andamento / Pendente / Depende da clínica / Não é possível) + O QUE FOI ALTERADO + ONDE A REGRA ESTÁ + TESTE EXECUTADO + EVIDÊNCIA, conforme §16 do PDF (a coluna "onde" está em `docs/checklist-22-10-matriz.md`).
