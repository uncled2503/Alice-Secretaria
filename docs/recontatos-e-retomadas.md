# Recontatos e retomadas de avaliação (Lisboa) — 17-18/10/2026

> O que este documento afirma vale para o **código**. O que aconteceu em produção nos dias 15 e 16/10 **não foi comprovado** (não há acesso aos dados de produção): ver seção 6.

## 1. As três ideias que antes se misturavam

`src/crm/followupSchedule.ts` (puro, no fuso da **clínica**, nunca o do servidor):

| Conceito | O que é |
|---|---|
| **Vencimento** (`dueAt`) | Quando a regra "pede" o envio: *N minutos de silêncio* **ou** *o dia civil seguinte às N horas* (`nextDayHour`). "Dia seguinte às 8h" ≠ "24h depois". |
| **Abertura** (`opensAt`) | Primeiro instante ≥ vencimento em que a clínica pode mandar: expediente (dias e horários, `hoursByDay`), feriado (só se a clínica fecha em feriado) **e** janela da regra (`sendWindowStart/End`, fim exclusivo). A jornada das profissionais **não** entra. |
| **Prazo** (`deadline`) | Até quando ainda vale enviar depois de aberto. **É decisão da clínica** (`Clinic.followupRecoveryHours`): sem decisão vale o **padrão antigo** (3 dias desde o vencimento); `0` = não recupera; `N` = até N horas depois que a janela abriu. |

**Política de recuperação** (servidor caiu, job atrasado, reinício) — *origem de cada número, revisada em 19/10/2026*:
- **3 dias** (`MAX_OVERDUE_MS`): **padrão antigo do código** (commit `d52e649`, 07/10/2026, trava contra disparo em massa depois que reconectar o WhatsApp mandou recontato para todos). Fixo, global, **não é autorização comercial**. Já estava em produção.
- **24 h depois da abertura** e **"fim do dia" nas regras de dia seguinte**: foram valores **introduzidos pelas correções de 17-18/10**, nunca aprovados por clínica nenhuma. Deixaram de ser padrão: agora só valem se a clínica escolher (`followupRecoveryHours = 24`, por exemplo).
- **Lisboa: decisão PENDENTE** (preflight `recontato.recuperacao`). Sem decisão, a Lisboa segue o padrão antigo — o mesmo comportamento de produção de hoje. Aplicar com `recuperacao: { horas, aprovadoPor }` na rota `lisboa-recontatos` (`null` volta ao padrão antigo).
- dentro do prazo e aberto → envia (mesmo minutos atrasado);
- aberto mais tarde ainda dentro do prazo → espera abrir;
- passou do prazo → com política da clínica a etapa **expira** (fica registrada, não sai atrasada nem acumulada) e a cascata segue; no padrão antigo vira "conversa fria" (nada gravado);
- mais de 3 dias de atraso → "conversa fria": nada é enviado nem gravado (não se reativam mensagens antigas em massa);
- no máximo **1 mensagem por conversa por rodada** e **6 h** entre duas mensagens automáticas para a mesma pessoa (qualquer automação).

## 2. Matriz das automações de contato (o que existe, o que dispara, quem executa)

| Automação | Público | Gatilho | Quando | Exclusões principais | Config (origem) | Código |
|---|---|---|---|---|---|---|
| Recontato (cascata) | lead que parou de responder (funil aberto) | silêncio desde a última msg **da pessoa** | por regra: *N min* ou *dia seguinte às N h*, + janela da regra, + expediente/feriado | tem horário, encerrou ("ok"), optou por sair, sem interesse, retorno combinado futuro, atendimento humano (e equipe falou há <2 h), contato não comercial, outra automação <6 h, fluxo específico em andamento | `FollowUpRule` (painel/seed/migração 14/10 para o "1 dia" da Lisboa) | `crm/followup.ts` |
| Retorno combinado | quem pediu para ser chamada numa data | `Patient.callbackAt` vencido | no expediente | atendimento humano (avisa a equipe) | a própria conversa | `crm/hotLeads.ts` |
| Retomada de avaliação **cancelada** | quem cancelou a avaliação e não remarcou | cancelamento **comprovado** nos últimos `lookbackDays` | dia/janela da clínica (`weekday`, `startHour`–`endHour`) | ver seção 4 | `ResumeFlowConfig` (**nasce desligada e sem texto**) | `crm/resumeFlows.ts` |
| Retomada **sem fechamento** | pessoas que a **equipe marcou** | marcação manual | idem | idem + já remarcou/fechou | `ResumeFlowConfig` + `ResumeTarget` | `crm/resumeFlows.ts` |
| Alice volta se a equipe demora | quem esperava a equipe | N min sem resposta humana | contínuo | urgência/reação | `Clinic.humanReturnMinutes` | `crm/humanReturn.ts` |

Precedência quando há conflito: **atendimento/agendamento em curso > retorno combinado > fluxo específico (retomada) > recontato genérico**. O genérico nunca acompanha um fluxo específico da mesma pessoa. Código: `competingContact` em `crm/followupLedger.ts`.

## 3. Cascata: correções de lógica

- A próxima etapa é a **primeira regra ativa com ordem maior que a última enviada**. Antes era "última + 1": se a etapa 1 estivesse desligada e a 2 ligada, a cascata **nunca andava** e, depois de 2 dias, a conversa era dada como **perdida** e fechada sem nenhum recontato.
- O desfecho do envio tem tratamento próprio (antes `sendText` devolvendo "vetoed/blocked/duplicate" **consumia a etapa em silêncio**): `sent`, `unconfirmed` (timeout: pode ter saído, **não reenvia**), `blocked`, `duplicate`, `vetoed` (**temporário**, reavalia quando o contexto muda ou em 6 h; 2 vetos = definitivo), `failed` (tenta de novo, 3 vezes, 10 min), `failed_permanent`, `expired`, `skipped`, `deferred` (falha **técnica** do juiz de IA: não é decisão de negócio).
- Veredito do juiz de IA em cache **só vale no mesmo contexto** (impressão digital + etapa) **e por 4 h** (antes valia enquanto a conversa não tivesse mensagem nova). O mesmo vale para a revisão de envio (`sendGate`): a chave do cache inclui a impressão digital da ficha.
- Texto com `{procedimento}` e interesse desconhecido agora fica **registrado** (adiado), não some.
- Conversa fora do funil aberto, contato não comercial e transferência parada com a equipe ficam **contados** no diagnóstico.

## 4. Retomada de avaliação cancelada — critérios

Entra quando **todas** valem: reserva de **avaliação** (`procedure` com "avalia"), `status = cancelled`, `cancelledAt` dentro de `lookbackDays` (padrão 7) e **origem comprovada** (`cancelSource` ∈ `paciente_whatsapp`, `equipe_painel`, `api_externa`, `ce_cancelada`).

**Não** entra (e fica registrado quando é definitivo): origem não comprovada (`ce_apagada` — a reserva sumiu do CE, pode ser troca; `sistema_desfeito` — a Alice desfez porque o CE recusou; sem origem/data — cancelado antes deste registro existir), remarcou, tem outra reserva (mesmo com outro id/uuid), avaliação feita depois, falta (`no_show`), procedimento que não é avaliação, optou por sair, sem interesse, já é cliente. **Temporário** (reavalia): retorno combinado futuro, atendimento humano em curso, equipe falou nas últimas 48 h, conversa nas últimas 24 h, recontato nas últimas 48 h, outra automação <6 h, fora do dia/horário configurado, teto por rodada/dia.

Texto: sem "desistiu", sem motivo inventado, sem desconto, sem horários (convite sem compromisso). A pessoa responde → o fluxo normal da Alice conduz (a mensagem é da automação "Retomada de avaliação", não vira "só agradece").

**Dado novo:** `Appointment.cancelledAt` e `Appointment.cancelSource` passam a ser gravados em todos os pontos que cancelam. **Cancelamentos anteriores a este deploy não têm data nem origem: não entram** (não dá para provar). Isso é um limite deliberado.

## 5. Avaliação realizada sem fechamento

O sistema **não enxerga o "fechou"** (acontece fora da Alice). Por isso **não há varredura**: só recebe quem a equipe marcar (`POST /patients/:id/retomada-pos-avaliacao`), uma a uma. `GET /retomadas/sugestoes-sem-fechamento` lista quem *pode* ter ficado sem fechar (avaliação concluída nos últimos 30 dias, sem reserva depois) só para a equipe escolher — **nunca dispara sozinha**.

## 5b. Modo restrito para validar as retomadas e o convite de indicação (19/10/2026)

Antes, ligar uma retomada a abria para todo o público elegível, sem limite de teste. Agora a configuração (`ResumeFlowConfig`) tem um **modo de execução**:
- `normal` — comportamento de sempre (padrão; nada muda para quem não pedir);
- `restrito` — só os **contatos de teste autorizados** (pacientes DA CLÍNICA, resolvidos por telefone exato), no máximo `limite` envios (1 a 20), contados desde o início do teste.

Garantias: lista vazia/inválida, limite ausente/zero/enorme, início ausente, id de outra clínica ou **modo desconhecido bloqueiam a rodada inteira** (nunca liberam todos). Os demais pacientes **nem são lidos** pela rodada restrita e não ganham registro de controle. A restrição é **revalidada imediatamente antes do envio** (lendo a configuração de novo) **e dentro de `sendText`** — vale para a rodada, para nova tentativa e para chamada direta. Cada decisão grava o modo (`FollowUpDispatch.runMode`) e cada rodada também (`AutomationRun.mode`). Ligar (`ativar`) **não** tira da restrição; voltar ao normal é pedido explícito (`voltarAoNormal`, com aprovador).

`lisboa-recontatos` (prévia por padrão): `modoRestrito: { fluxo, aprovadoPor, telefones, limite }` e `voltarAoNormal: { fluxo, aprovadoPor }`. A **prévia** (`previa`) mostra, sem enviar, sem consumir tentativa, sem gravar controle e sem consultar o juiz de IA, quem seria selecionado (regra, evento, motivo, janela, teto, quantas pessoas reais o modo normal alcançaria) — com só "Primeiro S." e o id interno, nunca o telefone. `previaRecontato` faz o mesmo para a primeira rodada do recontato por silêncio (regra, vencimento, abertura, prazo, motivo).

**Revalidação antes do envio** (recontato por silêncio): depois do juiz de IA a rodada confere de novo, no banco: pediu para sair / sem interesse (definitivo), retorno combinado futuro, atendimento humano, equipe falou há menos de 2 h, a pessoa escreveu depois, reserva vigente.

## 6. O que NÃO foi possível concluir (precisa de produção)

- **"Recontatos do dia anterior não ocorreram", "a partir das 12h", "8h do dia seguinte"**: não há como atribuir a uma causa sem os dados da Lisboa. Defeitos **reais** encontrados no código que explicam parte disso: (a) etapa desligada travando a cascata; (b) a etapa de 4 h e a do "dia seguinte 8h" colidem para quem para de responder à noite (a de 4 h sai de manhã e a do dia seguinte só pode sair 6 h depois, fora da janela 8–12h, e expira); (c) `vetoed/blocked/duplicate` consumindo a etapa sem rastro — em 16/10 a revisão por IA barrava mensagens; (d) veredito "não" do juiz preso em cache; (e) conversa transferida em silêncio nunca é recontatada e não aparecia em lugar nenhum.
- Nenhum desses é declarado "a causa" do incidente. Para confirmar: depois do deploy, o diagnóstico (`GET /api/automations/diagnostico`) e o relatório das 20h mostram, por rodada, candidatas, elegíveis, enviadas, adiadas, vetadas, falhas e os motivos.
- **Perguntas objetivas à clínica** (também no `POST /api/clinics/lisboa-recontatos`): qual horário vale — "8h do dia seguinte (janela 8–12h)" ou "a partir das 12h"? As retomadas de avaliação cancelada saem em quais dias/horários (a clínica citou as segundas) e com qual texto aprovado?

## 7. Diagnóstico e relatório

- `AutomationRun`: uma linha por clínica por rodada (candidatas, elegíveis, enviadas, adiadas, ignoradas, barradas pela IA, falhas, incertas, motivos). Guardada 14 dias. Sem conteúdo de conversa.
- `FollowUpDispatch`: uma linha por (pessoa, fluxo, etapa, ciclo) com estado, **camada** (`janela`, `elegibilidade`, `concorrencia`, `juiz_ia`, `revisao_envio`, `envio`, `politica`), motivo, se é temporário, quando reavaliar e a versão do código.
- `GET /api/automations/diagnostico?clinicId=&days=`: distingue *"o job não rodou"*, *"rodou sem candidatas"*, *"todas excluídas"*, *"rodou e enviou"*, *"rodou mas nada saiu"*, com última e próxima rodada.
- Relatório das 20h: usa o resultado **persistido** (enviado ≠ tentado), avisa quando o job **não rodou** no dia e lista as retomadas.
