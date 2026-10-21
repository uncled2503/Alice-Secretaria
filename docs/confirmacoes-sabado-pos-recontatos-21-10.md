# Confirmações até as 9h, rotina de sábado, pós do Lavieen e recuperação de recontatos (21/10/2026)

Relato da Aline (Lisboa Beauty Center). **Estado:** tudo local, sem commit, sem push, sem deploy. Nenhuma mensagem real foi enviada; os testes usam banco temporário, relógio controlado e WhatsApp/OpenAI simulados. **Nada aqui prova que algo foi resolvido em produção.**

> Não houve acesso aos registros de produção. Onde a causa depende deles, este documento diz **"não comprovada"** e diz qual comando traz a prova.

## 1. Confirmações do dia seguinte

### O que o código fazia (comprovado pela leitura do código)
- A regra da Lisboa (`seedLisboa.ts`) é de **calendário**: `dayOffset=1`, janela 8h–11h, e não "24h antes" (o campo `hoursBefore=24` é só um valor de apoio). O caminho "N horas antes" só vale para regra **sem** `dayOffset` — isso já aconteceu uma vez (15/10) e foi corrigido; agora uma regra de confirmação sem janela de calendário é apontada como **inválida** (`ruleProblems`).
- Candidatas eram buscadas por `agora … agora+54h`, não pelo **dia local** do atendimento.
- Pontos onde uma confirmação podia **não sair** (todos presentes no código, nenhum provado como a causa em produção):
  1. WhatsApp marcado como fora do ar na janela → a rodada inteira adia; com janela de 3h havia folga, com janela de 1h não.
  2. Conferência no Clínica Experts inconclusiva → adia (até 16 vezes, só enquanto a janela vale).
  3. Agendamento **criado depois do fim da janela**: só entrava na "reposição" se a Alice **nunca** tivesse falado com a pessoa desde o agendamento — quem marcou pela conversa com a Alice (quase todos) ficava **sem confirmação, sem registro**.
  4. Agendamento **remarcado** depois da janela: `createdAt` não muda, então nunca entrava na reposição.
  5. A cobertura "primeiro horário do dia" dispensava o 2º horário mesmo que o 1º nunca recebesse mensagem.
  6. Revisão por IA barrando, falha do provedor (3 tentativas) e limite de 12 envios por rodada.
- Para a janela curta, o teto de 12 envios por rodada (4 rodadas entre 8h e 9h = 48 pessoas) podia **não caber**.

### Correção
| Ponto | Mudança | Arquivo |
|---|---|---|
| Janela | A regra do dia anterior termina às **9h** (`PRAZO_PADRAO_HORA`), **reaproveitando o início cadastrado (8h)**. Aplicada por plano com prévia e aprovação. | `maintenance/lisboaConfirmacoes.ts` |
| Seleção por data local | Atendimentos de "hoje + dayOffset" no fuso da clínica (`selectReminderCandidates`). | `reminders/cron.ts` |
| Finalidade | `ReminderRule.purpose` = `confirmacao` \| `cobranca` \| `lembrete`. Confirmação ≠ lembrete ≠ aviso de agendamento (este último é a mensagem da conversa de agendamento, não uma regra). | `reminders/policy.ts` |
| Já confirmou | Regra com finalidade `confirmacao` **não envia** a quem já confirmou, salvo `resendIfConfirmed` (política explícita). Regra legada (sem finalidade) mantém o comportamento de sempre. | `policy.ts`, `cron.ts` |
| Depois da janela | Criado **ou remarcado** depois do fim da janela → reposição entre 8h e 20h, com 2h de folga. `Appointment.scheduleChangedAt` é gravado **pela camada do banco** em qualquer caminho. Se a Alice conversou com a pessoa há < 3h, a reposição **espera** (retida e registrada) e depois pede; regra legada dispensa, mas agora **registra**. | `cron.ts`, `db/client.ts` |
| Sem cobertura silenciosa | Logo após o fim da janela, **uma vez por dia e por regra**, confere quem ficou sem a solicitação e **avisa a equipe + Diário** (`reminder_gap`) com quantidade e motivo. Nada é enviado fora da janela para "compensar". | `reminders/coverage.ts` |
| Capacidade | Teto por rodada sobe de 12 até 30 **só** quando a fila não cabe nas rodadas que restam da janela. | `policy.ts` (`perRunCap`) |
| Reserva não efetivada | Agendamento cuja criação no CE está `pending/uncertain/unresolved/failed` **não** recebe "confirmar o seu agendamento": fica retido com o motivo. | `reminders/effectuation.ts` |
| Uma via de envio | O envio de UM agendamento foi extraído para `deliverReminder`, usado pelo ciclo e pela execução controlada: mesmas travas, mesma idempotência. | `cron.ts` |

## 2. Rotina de sábado
Política **por dia da semana do atendimento** (`ReminderRule.weekdays`, data local, 0=domingo…6=sábado):
- **Quarta** (`dayOffset=3`, `weekdays="6"`, `purpose=confirmacao`): solicitação.
- **Sexta** (`dayOffset=1`, `weekdays="6"`, filha da de quarta): nova solicitação **só a quem não confirmou nem respondeu**, ≥ 3h depois da primeira.
- **Sábado**: o **lembrete do dia já cadastrado** (7h–8h) — janela preservada; confirmados também recebem.
- Regra com dia **substitui** a genérica do mesmo propósito nesse dia (`overridingRule`): nunca as duas. Cancelado não recebe; remarcado perde o horário antigo (chave de controle inclui o horário); criado na quinta/sexta cai na reposição.
- **Resposta de confirmação** entre quarta e sexta agora é associada ao sábado (janela de busca de 5 dias; reservas citadas pelo lembrete valem além de 72h). Duas reservas citadas em dias diferentes → a Alice **pergunta qual**.

### Horários que a clínica NÃO definiu (decisões pendentes — o plano expõe, não inventa)
| Decisão | Proposta (reaproveitada do cadastro) | Observação |
|---|---|---|
| Janela da **quarta** | 08:00–09:00 (a do dia anterior) | clínica não definiu |
| Janela da **sexta** | 16:00–17:00 (a cobrança já cadastrada) | fica **depois** das 9h; a clínica quer a sexta também até 9h? |
| Texto da quarta | texto aprovado do dia anterior com **uma** troca: "(amanhã)" → "(sábado)" | precisa de aprovação |
| Janela do dia anterior | 08:00–09:00 | início cadastrado (8h) mantido |
| Segunda-feira | confirmação sai no **domingo** 8h–9h (inalterado) | confirmar se é desejado |

As regras de sábado nascem **desligadas**; ligá-las exige `ativarSabado` + `janelasAprovadas` iguais ao plano.

### Prévia do próximo sábado (antecipação)
`GET /api/clinic/confirmations-preview` (ou o plano) mostra a **data explícita**, quantos agendamentos, quantos elegíveis e o motivo de cada um; não envia, não reserva, não grava. A execução (`POST /api/clinics/lisboa-confirmacoes/executar`) exige `executar` **e** `autorizado`, passa por `deliverReminder` (conferência ao vivo no CE, reserva atômica) e não duplica com o ciclo automático.

## 3. Pós do Lavieen depois das 19h30
**Causa comprovada pela leitura do código:** `postProcedure.ts` tinha um portão fixo — **nada entre 21h e 7h** — para todas as regras. Regra em horas conta do **fim** da reserva (início + duração, ou `ends_at` do CE): Lavieen que começa 19h30 e dura 60 min com pós "1h depois" vence às **21h30** → espera até as 7h.
**Não comprovada em produção:** que essa tenha sido a causa das mensagens da Aline. Outra hipótese plausível é a **conclusão** do atendimento só ser registrada de manhã (a regra exige `status=completed`). Até hoje o horário da conclusão **não era gravado**; agora `Appointment.completedAt` é (pela camada do banco) e `GET /api/clinic/post-procedure-diagnostico` mostra, por atendimento, início, fim, vencimento, conclusão e envio, com a causa que os tempos comprovam.

Correção: `PostProcedureRule.lateSendUntilHour` (21–24, padrão vazio). Só a regra do Lavieen é ligada (`POST /api/clinics/lisboa-pos-fechamento`, prévia por padrão). Regras para **todos** os procedimentos viram pendência. Depois do fechamento sai **apenas quem venceu há até 6h** e nunca antes das 7h. Texto, intervalo e `onlyIfCompleted` intactos; recontatos, campanhas, lembretes, pesquisa e aniversário não são tocados. Etapas fechadas/`unconfirmed` não reabrem.

## 4. Recontatos
**Conferência** (`GET /api/automations/recontatos/conferencia?de=…&ate=…&regra=…`): previstos, elegíveis, retidos (motivo), tentados, aceitos pelo provedor, **entregues só com evidência** (a pessoa respondeu depois), falhos, sem confirmação do resultado e **sem registro** (não se sabe o que houve — não se inventa causa). O "previsto" é reconstruído pela linha do tempo das mensagens e pelas regras de hoje.
**Recuperação** (`POST /api/clinics/lisboa-recontatos/recuperar`, prévia por padrão): usa a **mesma rodada** do recontato com o parâmetro `recovery` — só as pessoas aprovadas, mesmas exclusões e revalidação, mesmo juiz de IA e revisão de envio, atendimento humano, cadência (6h), janelas e **limite de atraso** da clínica (não ultrapassa). Uma etapa por pessoa (as seguintes já vencidas ficam `expired` "absorvidas"). Resultado incerto nunca é reenviado. Trava no banco por clínica (`recontato-recuperacao:<id>`) impede a rodada automática de mexer na clínica durante a recuperação. Reinício não dispara lote: teto de 8 por clínica por rodada, `reserved` órfão vira `unconfirmed`.

**Atenção (informação, não correção):** com a política atual da Lisboa (padrão antigo de **3 dias**, `followupRecoveryHours` vazio), os recontatos de ontem que ainda estão dentro do limite **a rodada automática enviará sozinha**, até 8 por rodada. Se a clínica quer controlar, defina `followupRecoveryHours` antes de subir a versão.

### O que NÃO foi possível verificar (sem acesso a produção)
Quantos recontatos de ontem foram previstos/enviados/falharam, se os de hoje saíram, por que cada um não saiu, quantas confirmações ficaram sem mensagem, e quando o Lavieen foi concluído. Os três comandos acima respondem isso quando executados **contra o banco de produção**.

## 5. Consistência
Isolamento por clínica (todas as consultas filtram `clinicId`); idempotência por reserva+regra+horário (`ReminderDispatch`, índice único) e por pessoa+etapa+ciclo (`FollowUpDispatch`); revalidação imediatamente antes de cada envio (status, horário, confirmação, conferência ao vivo no CE); `unconfirmed` explícito; nenhuma confirmação de sucesso ao cliente sem evidência; a escrita no CE **não mudou** (continua o contrato validado na revisão de 21/10).

## 6. Implantação e reversão
1. `prisma migrate deploy` → `20261024100000_confirmacoes_sabado_pos_recontatos` (só colunas novas/opcionais; nada muda de comportamento sozinho).
2. Implantar (EasyPanel, manual) e conferir `/health`.
3. Rodar as **prévias** (Lisboa): `lisboa-confirmacoes`, `lisboa-pos-fechamento`, conferência de recontatos de ontem/hoje.
4. A clínica decide os horários/texto → aplicar com `aprovadoPor`.
5. Ligar o sábado só com `janelasAprovadas`.
**Reversão:** o código novo sem dados novos se comporta como o antigo para todas as clínicas (colunas vazias). Para voltar a Lisboa: `PUT /reminder-rules/:id` (`weekdays: ""`, `active:false` nas de sábado; janela de volta a 8h–11h) e `lateSendUntilHour = null`. Colunas podem ficar.

## 7. Respostas da Aline (21/10, depois do relatório) — já incorporadas no código
- **Sexta de sábado = LEMBRETE para TODOS** (inclusive quem já confirmou), com o texto já cadastrado "Estamos te esperando amanhã…" (reaproveitado sem alteração; se a regra com esse texto não for achada, o plano pede o texto). O sábado repete o lembrete do dia. A cobrança de quem não confirmou deixa de existir para sábado. O lembrete de sexta substitui a confirmação genérica de sexta nesse dia e não tem reposição própria (quem é agendado depois da janela recebe a confirmação como reposição, não os dois).
- **Janela das confirmações: 8h–10h** do dia anterior (prazo padrão passou de 9h para 10h; quarta de sábado idem, início 8h reaproveitado). A janela de quarta dita pela clínica estava ilegível; usa-se a proposta 08:00–10:00. Janela da sexta: a da regra que já usa o texto da véspera, senão a cobrança cadastrada — continua sendo decisão a confirmar.
- **Pós depois do fechamento para TODOS os atendimentos**: `todosProcedimentos: true` em `POST /api/clinics/lisboa-pos-fechamento` (só o limite muda; texto e intervalo intactos; só quem venceu há até 6h; nunca antes das 7h).
- **Não alterado:** a cascata de recontato de leads (dia seguinte 8h–12h). O "8h–10h" foi entendido como a janela das confirmações; se ela também quer o recontato da cascata até 10h, é só ajustar `sendWindowEnd` dessa regra.
