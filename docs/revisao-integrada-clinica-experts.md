# Revisão integrada: Clínica Experts, identidade, acompanhantes, lembretes e automações (21/10/2026)

Escopo: cadastro/identificação do paciente, agendamento individual e para acompanhante, remarcar/cancelar, sincronização com o Clínica Experts (CE), confirmação de presença, mensagens pré-visita e preparo, pós-procedimento, aniversários, recontatos e o diagnóstico disso no painel.

**Estado do trabalho:** tudo está **local, sem commit, sem push, sem deploy**. Nenhuma mensagem real foi enviada, nenhuma chamada paga à OpenAI foi feita nos testes (tudo simulado), nenhuma automação desligada foi ligada e nenhum dado de produção foi tocado. A revisão do código é `2026-10-21-a`.

> Os pontos da auditoria anterior (revisão 2026-10-19-m / commit d818fd5) foram tratados como **hipóteses a verificar**, não como verdade. Onde a solução existente já estava correta (ledger de lembretes `ReminderDispatch`, estados de pós/preparo, janela de aniversário, conferência ao vivo antes do lembrete) foi **preservada** e só estendida.

---

## 1. Contrato do CE: o que a documentação diz × o que o código fazia × o que passou a valer

Fonte: <https://clinicaexperts.readme.io/reference/introduction>. Resumo do que foi conferido e as **limitações que a documentação não resolve** (a Alice não presume):

| Tema | Documentação | Antes | Agora |
|---|---|---|---|
| `GET /available-hours` | `data` = lista de **objetos** sem campos definidos | lia só texto `"HH:MM"`; forma desconhecida virava "dia sem horários" | aceita texto **e** objetos (`starts_at`, `time`, `start`…); forma não reconhecida = **disponibilidade não verificada** (fecha o portão e aparece no painel), nunca "dia livre/ocupado" |
| `procedure_id` / `procedure_from_event` / unidade de `interval` | sem semântica documentada | não enviava | **continua não enviando**; pede células de 15 em 15 e exige TODAS as células da duração livres. Limitação: o CE pode considerar duração por conta própria; a Alice não depende disso |
| `POST /bookings` | devolve 200; conflito **não** documentado como 409 | tratava erro 4xx como recusa | idem, mas conflito = 422 com `errors` (mensagem registrada); 200 **sem `data.uuid`** = resultado **incerto** (não sucesso) |
| Reagendar | `PATCH /bookings/{uuid}/reschedule` **sem corpo** (não permite informar o novo horário) | `PUT /bookings/{uuid}` | continua `PUT` (única forma de informar o horário), agora **depois de ler a reserva atual**, sem cancelar a antiga antes, recusando reserva com mais de um procedimento |
| Confirmar presença | `PATCH /bookings/{uuid}/confirm` | não existia (a confirmação do paciente nunca ia ao CE) | implementado, separado da confirmação do paciente (ver §5) |
| Paginação | `per_page` 1–1000, envelope `meta` com valores **em texto**; `page` não documentado | confiava em `per_page=1000`/`last_page` sem conferir o total | `ceListAll`: segue `meta.last_page` (texto), **confere `meta.of`**, marca `complete:false` se não fechou; sem `data` = resposta inválida |
| Respostas | JSON com `data` | 200 com corpo vazio/quebrado era "sucesso" | corpo vazio/ilegível/sem os campos essenciais = `invalid_response`; reserva ilegível é ignorada (nunca vira cancelamento) |
| Erros | 401/403/422/429/5xx | misturados | classificados: `auth`, `forbidden`, `validation`, `rate_limit`, `not_found`, `server`, `network`, `invalid_response`; **escrita incerta** = rede/tempo/5xx/corpo inválido |
| Limite de chamadas | 100/min ("Status of returns") **e** 120/min ("Request limits"), inconsistente | sem controle | usa o menor com folga (90/min por conta, `CE_RATE_PER_MIN`); `429` pausa a conta (respeita `Retry-After`) |
| Estados da reserva | scheduled, done, rescheduled, canceled, noshow, confirmed, waiting, progress, reserved | qualquer texto desconhecido virava **confirmado** | desconhecido **nunca** vira confirmado: o texto bruto fica em `Appointment.ceStatus`, a reserva não é importada como confirmada e a equipe é avisada |
| Horário sem fuso | não especifica | lido no fuso da clínica | idem (validado, inclusive perto da meia-noite) |

Anotações no código: cabeçalho de `src/clinicaexperts/contract.ts`.

---

## 2. Matriz: problema → causa → correção → arquivos → testes

Legenda de testes: **CI** = `tests/ce-contrato-identidade.test.mjs`, **ER** = `tests/ce-escrita-reconciliacao.test.mjs`, **IMP** = `tests/ce-importacao.test.mjs`, **AL** = `tests/agenda-lembretes-integrados.test.mjs`, **CP** = `tests/alice-casal-e-presenca.test.mjs`.

| # | Problema | Causa | Correção | Arquivos | Testes |
|---|---|---|---|---|---|
| 1 | Resposta 200 vazia/quebrada tratada como sucesso; falhas indistintas | `ceCall` só olhava `res.ok` | validação em tempo de execução + classificação de erro + limitador + 429 | `clinicaexperts/client.ts` | ER (cliente) |
| 2 | Lista incompleta virava "não existe" | paginação sem conferir total | `ceListAll` com `complete` | `client.ts`, `pull.ts`, `sync.ts`, `birthdays.ts`, `ai/timeConflict.ts` | ER (paginação), IMP (paginação) |
| 3 | Disponibilidade com objetos | só texto | `parseAvailableHours` | `contract.ts`, `availability.ts` | CI, ER (parâmetros e forma desconhecida) |
| 4 | Paciente achado pelos **últimos 8 dígitos**, 1º resultado, criação após busca que falhou, sobrescrita de `ceUuid` | `ensurePatientUuid`/`enrichPatientFromCe`/`pull` | `identity.ts` (DDI/DDD/9º dígito; DDD precisa bater; nome completo desempata; ambíguo não escolhe; busca que falhou ≠ inexistente; criação incerta reconcilia por busca; uuid de outra pessoa nunca é ligado) | `identity.ts`, `sync.ts`, `pull.ts` | CI, ER (6 cenários) |
| 5 | Casal/família no mesmo telefone fundidos num cadastro | `Patient` único por telefone, uuid sobrescrito pela importação | `Attendee` (pessoa atendida que divide o telefone), importação cria acompanhante em vez de trocar o uuid; um único cadastro do CE com o telefone mas **nome de outra pessoa** não é "ele" | `schema.prisma`, `pull.ts`, `identity.ts` | IMP, ER, CI |
| 6 | "Marcar para mim e meu marido" ia sempre para a equipe | ferramenta só agendava a pessoa da conversa | `book_appointment` com `attendee_*`: nome completo + como falar (telefone dividido dito **explicitamente** ou telefone próprio → cadastro próprio); cada pessoa = uma reserva verificada; "os dois" só depois das duas; sucesso parcial relatado | `scheduling/companions.ts`, `ai/alice.ts`, `ai/replyFacts.ts` | AL (companions), CP (3 cenários) |
| 7 | Criação com resultado incerto recriava ou perdia a reserva | guarda em `ActivityLog` por 1 h; `findExistingBooking` por paciente+horário | `CeBookingAttempt` gravada **antes** do POST; reconciliação **estrita** (paciente, profissional, procedimentos, início e fim, não ligada a outro agendamento, duas candidatas = ambíguo); nunca recria; 6 h sem prova = `unresolved` + aviso | `sync.ts`, `match.ts` | ER (7 cenários), CI (comparador) |
| 8 | Reservas simultâneas (mesmo horário, outro profissional/procedimento) podiam ser fundidas | `pull` ligava por paciente+horário | comparador estrito (`matchReservation`); a que combina em tudo é adotada, as outras viram reservas próprias | `pull.ts`, `match.ts` | IMP, CI |
| 9 | Remarcação: sem conferir a reserva, sem tratar incerto, `PUT` apagaria procedimentos extras | `syncAppointment` direto | lê a reserva atual; mesmo horário = nada escrito; recusa multiprocedimento/cancelada/estado desconhecido; confere o resultado; timeout reconcilia (aplicou / não aplicou / incerto) | `sync.ts`, `ai/alice.ts` | ER (5), CP |
| 10 | Duração derivada do 1º procedimento | `procedure.durationMin` | `Appointment.endsAt` + `AppointmentProcedure`; `reservationEndMs` (fim do CE > soma dos procedimentos > principal) usado em agenda, remarcação, pós | `scheduling/reservation.ts`, `slots.ts`, `postProcedure.ts` | IMP (3) |
| 11 | Importação não refletia profissional, fim, procedimentos nem versão | só horário/status | atualiza profissional, fim, lista de procedimentos, `ceStatus`, `ceUpdatedAt`; "lista vazia" não apaga o que se sabe | `pull.ts` | IMP |
| 12 | Cancelamento nosso não recebido × reativação na recepção | reativava/recancelava sem critério; cancelamento bem-sucedido apagava o uuid | `ceCancelState` (pending/confirmed) + **versão** (`updated_at` do CE × `cancelledAt`): nosso e não alterado → reenvia; alterado depois → reativa; cancelado pelo CE e reativado → volta a valer; uuid **fica** | `pull.ts`, `sync.ts`, `liveCheck.ts` | IMP (3), ER (2), CP |
| 13 | Agendamento desfeito por falta de resposta do CE nunca voltava | `ce_mirror_uncertain` era só um log | `cancelSource = sistema_desfeito`; se a reserva aparece no CE, volta a valer (e a equipe é avisada) | `sync.ts`, `pull.ts` | IMP |
| 14 | Confirmação do paciente nunca ia ao CE; confirmar não conferia a reserva | só `patientConfirmed=true` | `markPatientConfirmed` + `syncPresence` (`PATCH /confirm` depois de ler: ativa, mesmo horário); CE fora do ar = pendente e visível, reconciliado a cada 5 min; confirmar confere ao vivo (cancelada/trocada ⇒ não confirma); 2 pessoas no dia ⇒ pergunta de quem | `sync.ts`, `ai/alice.ts` | ER (3), CP (2) |
| 15 | Estado desconhecido do CE virava "confirmado" | `mapCeStatus` default | `ceStatusInfo` (null = desconhecido) em importação, conferência ao vivo e histórico | `contract.ts`, `pull.ts`, `liveCheck.ts`, `sync.ts` | CI, IMP |
| 16 | Atendimento registrado como concluído dias depois nunca chegava | janela de importação (hoje −2 dias) | `recoverLateStatuses`: ≤7 dias, ≤25 por rodada, cada reserva a cada 6 h, auditável, não cria histórico | `liveCheck.ts`, `pull.ts` | IMP |
| 17 | Desconectar o CE apagava o uuid das reservas | `disconnectAccount` | mantém; troca de conta = `resetCeLinks` explícito | `client.ts` | ER |
| 18 | Lembrete ao acompanhante citava o contato; 2 pessoas = 1 mensagem | chave "primeiro do dia" por telefone | cobertura por **pessoa** (`patientId`+`attendeeId`); texto com o nome de quem será atendido | `reminders/cron.ts`, `firstOfDay.ts`, `preProcedure.ts`, `postProcedure.ts` | AL |
| 19 | Cobrança enviada a quem confirmou durante a rodada | recheck só de status/horário | recheck de `patientConfirmed` e de resposta no momento do envio | `reminders/cron.ts` | AL |
| 20 | Sem prévia do que sai/por quê | — | `previewReminders` (somente leitura, mesma conta do envio) + sobreposições explicadas + "por que não recebeu" | `reminders/preview.ts`, `api/routes.ts` | AL |
| 21 | Aniversário: 29/02, `date_birth`, inativos/telefone inválido, telefone repetido, reserva só depois do envio | job antigo | `isBirthdayToday` (29/02 → 28/02 em ano não bissexto), reserva **antes** do envio (`reserved→sent/unconfirmed/failed_permanent`), 1 por pessoa por ano na clínica (qualquer regra), mesmo telefone uma vez, só `active`, telefone válido; CE: telefone dividido não empresta data | `reminders/birthday.ts`, `clinicaexperts/birthdays.ts` | AL (3) |
| 22 | Preparo/pós ignoravam reservas com vários procedimentos | só `procedureId` principal | regra vale se **qualquer** procedimento da reserva está nela; texto cita o procedimento da regra; troca de procedimento invalida o preparo reservado | `preProcedure.ts`, `postProcedure.ts` | AL (2) |
| 23 | Horário sem fuso lido no servidor; vínculo por nome | `ai/timeConflict.ts` | usa o contrato (fuso da clínica), uuid antes de nome, ignora reserva já ligada a outro agendamento | `ai/timeConflict.ts` | suíte existente |
| 24 | Painel/API manuais ignoravam fim, cancelamento pendente e confirmação | `PATCH /appointments`, API externa | `endsAt` acompanha o horário, `ceCancelState=pending`, confirmação manual sincroniza com o CE | `api/routes.ts`, `api/external/router.ts`, `reservation.ts` | (revisão de código + build; **sem teste dedicado**) |
| 25 | Sem visibilidade de CE/WhatsApp/sincronização | — | `GET /api/clinic/agenda-health` (+ `POST …/reconcile`, só reconcilia o em aberto) | `clinicaexperts/health.ts`, `api/routes.ts` | (leitura do banco; coberto indiretamente — ver §9) |

---

## 3. Antes × depois (comportamento)

- **Timeout ao criar uma reserva:** antes → procurava por paciente+horário (qualquer profissional/procedimento) e, não achando, desfazia e deixava só um log; depois → grava a tentativa, nunca dispara um segundo POST, procura a reserva que combina em tudo (também depois, a cada 5 min), liga ou, em 6 h, marca `unresolved` e avisa a equipe.
- **Marido na linha da esposa:** antes → o 1º cadastro do CE com aquele telefone era "ele" e o uuid podia ser sobrescrito pela importação; depois → pessoas distintas, cada uma com o seu uuid e a sua reserva; o cadastro de quem conversa nunca é alterado.
- **Confirmar presença:** antes → "confirmado" para o paciente e nada no CE; depois → confere a reserva ao vivo, guarda a confirmação do paciente sempre, envia `PATCH /confirm` e mostra pendência se o CE não responder.
- **Cancelar:** antes → uuid apagado ao cancelar; o CE podia continuar com a reserva sem ninguém saber; depois → estado do cancelamento (`pending` até o CE confirmar), nova tentativa, aviso.
- **Reserva "estranha" (estado novo do CE):** antes → importada como confirmada; depois → não importada, estado bruto preservado, equipe avisada.

---

## 4. Regras de lembrete A, B, C, D — semântica real (lida do código e dos seeds)

| | A — dia anterior | B — no dia | C — 4 h antes | D — cobrança |
|---|---|---|---|---|
| Config. típica | `dayOffset=1`, 08–11 h | `dayOffset=0`, 07–08 h | `hoursBefore=4` (ponto; empurrado para 07 h se cair de madrugada) | filha de A, `dayOffset=1`, 17–18 h (seed original: 16–17) |
| Quem entra | reserva `confirmed`, **primeiro horário do dia de cada pessoa** | idem | idem | só quem recebeu A, **não confirmou** e **não respondeu** desde A (≥3 h depois de A) |
| Quando vence | início da janela (08:00 do dia anterior) | 07:00 do dia | horário−4 h | início da janela (17:00) |
| Janela | [08:00, 11:00) | [07:00, 08:00) | horário previsto + 40 min | [17:00, 18:00) |
| Confirmação do paciente | **não** impede A | não impede B | não impede C | **impede** D (rechecado no momento do envio) |
| Cancelamento / apagado no CE | conferência ao vivo ⇒ não envia | idem | idem | idem |
| Remarcação | chave do ledger inclui o horário: o novo horário tem linha própria; histórico do antigo preservado | idem | idem | idem |
| Reserva criada depois da janela | **reposição**: sai assim que possível, 08–20 h, ≥2 h antes (só para `dayOffset≥1`, não filha) | não há reposição | não há | não há |
| CE/WhatsApp indisponível | CE inconclusivo ⇒ adia (até 16 tentativas) só enquanto a janela valer; WhatsApp fora ⇒ nada é tentado e **nada é despejado** quando volta (só o que ainda está na janela) | idem | idem | idem |
| Expiração | fim da janela; depois do horário do atendimento nunca envia | idem | idem | idem |
| Tipo (`ReminderDispatch.kind`) | `dia_seguinte` | `do_dia` | `do_dia` | `cobranca` |

**Sobreposição detectada (decisão da clínica, não alterada aqui):** B e C são do **mesmo tipo** (`do_dia`). O controle contra duplicidade permite **uma por dia** por reserva: se B saiu, C é bloqueada (e vice-versa). Isso é o que evitou o incidente de "duas confirmações no mesmo dia", mas também significa que **C só sai se B não saiu**. Opções para a clínica (nenhuma foi aplicada): (1) manter; (2) tornar C um tipo próprio (as duas saem, com o intervalo da regra); (3) desligar C. A prévia (`GET /api/clinic/reminder-preview`) mostra, por reserva, qual sairia em cada cenário e marca a sobreposição com o texto do controle.

Nenhuma cadência, janela ou texto foi mudado.

---

## 5. Confirmação: três coisas diferentes

1. **Paciente confirmou** (`patientConfirmed`): sempre registrado, mesmo com o CE fora do ar.
2. **Sincronizada com o CE** (`cePresenceState`): `pending` (a confirmar), `synced` (o `PATCH /confirm` foi aceito ou a reserva já constava como confirmada), `skipped` (reserva cancelada/encerrada no CE). Só é feita com a reserva ativa **e no mesmo horário**.
3. **Atendido/concluído**: vem do CE (`done`/`noshow`), nunca do relógio.

Mudança de horário no CE zera 1 e 2 (a confirmação era do horário antigo).

---

## 6. Envio confiável: estados e janela de incerteza

Estados persistidos (já existentes, preservados): lembretes `deferred|reserved|sent|unconfirmed|blocked|vetoed|duplicate|failed|failed_permanent|exhausted`; pós `legacy|reserved|sending|sent|unconfirmed|retry|vetoed|blocked|duplicate|failed_permanent`; preparo `reserved|queued|sending|sent|unconfirmed|failed|…|superseded|expired`; **aniversário (novo)** `reserved|sent|unconfirmed|failed_permanent|legacy`.

- "Aceito pelo provedor" **não** é "entregue": a UAZAPI não oferece idempotência nem consulta de status. A previa e a saúde dizem "aceito pelo provedor".
- **Janela incerta:** um envio que deu timeout fica `unconfirmed`; **nunca** é reenviado. Para o aniversário, o mesmo vale (reserva antes do envio; reserva sem desfecho vira `unconfirmed` em 30 min).
- Duas cópias do servidor / reinício: índice único do banco (ledger, aniversário, pós, preparo); processo que cai com `reserved` não reenvia.

---

## 7. Migração e prévias cadastrais

- Migração **aditiva** `20261023100000_clinica_experts_confiabilidade` (colunas novas opcionais em `Appointment`; tabelas `AppointmentProcedure`, `Attendee`, `CeBookingAttempt`; `BirthdaySent.state` com default `legacy`). Nada é reescrito nem reaberto; registros antigos de aniversário continuam provando a reserva do ano.
- Nenhuma alteração cadastral foi aplicada. **Não há** correção de cadastro que dependa de aplicação: a importação passa a criar acompanhantes e a preencher fim/procedimentos sozinha nas próximas rodadas (idempotente: repetir não duplica).
- Troca de conta do CE: `resetCeLinks(clinicId)` (ação explícita, retorna a contagem do que desvinculou).

---

## 8. Painel / API

Somente leitura, sem dados pessoais além de ids e dos nomes que a própria clínica já vê:

- `GET /api/clinic/reminder-preview?day=today|tomorrow` — por reserva e regra: enviado / vai enviar / aguarda janela / janela encerrada / bloqueado / não se aplica, com o motivo, a janela e o texto como sairia; sobreposições.
- `GET /api/clinic/reminder-why?appointmentId=…` — "por que esta pessoa não recebeu?" (mesma conta + trilha persistida).
- `GET /api/clinic/agenda-health` — CE e WhatsApp, última sincronização boa, escritas incertas/não resolvidas, reservas sem vínculo, confirmações pendentes de sincronizar, envios das últimas 24 h por estado, próximos envios.
- `POST /api/clinic/agenda-health/reconcile` — **recuperação controlada**: reconcilia só o que está em aberto (escritas incertas e confirmações de presença). Não reenvia mensagem e não recria reserva. **Não existe "reenviar tudo".**

A **tela** do painel ainda não foi construída: os quatro endpoints estão prontos e testáveis, mas nenhuma aba os consome (ver pendências).

---

## 9. O que não foi validado / limites honestos

- Nada foi validado contra o **CE real** nem contra o WhatsApp real: tudo com provedores simulados. O formato real de `/available-hours`, o efeito de `PATCH /confirm` na agenda deles e se o CE aceita `PUT` sem `procedure` para reservas com vários procedimentos **dependem de evidência de produção**.
- Agendamento manual do painel/API (`PATCH /appointments`, API externa): alterações revisadas e compiladas, **sem teste automatizado dedicado**.
- `GET /agenda-health` não tem teste de resposta (a lógica reaproveita funções testadas).
- Aniversário: `29/02 → 28/02` em ano não bissexto é uma **decisão minha**, documentada aqui; a clínica pode preferir 01/03.
- Pós/preparo para reservas com vários procedimentos: com regras para procedimentos diferentes, a pessoa recebe uma mensagem por regra (um orientação por procedimento), nunca a mesma duas vezes.
- Telefones brasileiros: a normalização trata DDI/DDD/9º dígito; não trata números internacionais.

---

## 10. Roteiro de validação (contatos de teste **autorizados** apenas)

1. `/health`: `revision` começa com `2026-10-21-a` e `lastMigration` = `20261023100000_clinica_experts_confiabilidade`.
2. `GET /api/clinic/agenda-health`: CE conectado, `lastSyncAgeMin` baixo, nenhuma escrita `unresolved`.
3. `GET /api/clinic/reminder-preview?day=tomorrow` para a clínica de teste: conferir cada regra, janela e a sobreposição B×C.
4. Com 2 contatos de teste (um com telefone próprio, outro dividindo o telefone): pedir "para mim e para (nome)" → conferir no CE 2 reservas, cada uma no nome certo, e `Attendee` no banco.
5. Provocar falha controlada do CE (token inválido temporário na clínica de teste): agendar → "equipe confirma", `CeBookingAttempt` aberta; restaurar → reconciliação liga a reserva sem duplicar.
6. Confirmar presença com o CE desligado → `cePresenceState=pending`; religar → `synced` e a reserva fica confirmada no CE.
7. Cancelar no CE e conferir a importação; reativar no CE e conferir o retorno.
8. Aniversário: contato de teste com data de hoje e regra ligada **só na clínica de teste**.

---

## 11. Deploy e reversão

- Deploy: o push **não** reinicia (EasyPanel → "Implantar"); conferir `/health`.
- A migração é aditiva: se algo der errado, **reverter só o código** (as colunas/tabelas novas ficam sem uso). Histórico de envios (ledger, pós, preparo, aniversário) é preservado nos dois sentidos.
- Reversão pontual: `CE_RATE_PER_MIN` (limite), `CE_GATE_FAIL_OPEN=on` (portão de disponibilidade, já existente).
- Primeira hora após o deploy: `agenda-health` a cada ~15 min; esperado `attempts.open=0`.

---

## 12. Pendências (precisam da clínica ou de evidência de produção)

1. Decisão sobre B×C (§4).
2. Tela do painel para os endpoints do §8.
3. Confirmar com o CE real: formato de `/available-hours`, efeito de `/confirm`, `PUT` multiprocedimento.
4. Link correto do Google e demais pendências da Lisboa (sem alteração aqui).
5. Teste dedicado para o caminho manual do painel/API e para `agenda-health`.
6. Telefones internacionais.

---

## 13. Resultados dos testes

Ambiente: Windows, Node 24, SQLite temporário por arquivo de teste, CE/UAZAPI/OpenAI **simulados** (fetch falso), relógio controlado onde há data.

- `npm run build` (tsc + stamp): sem erros.
- **Suíte completa** (`node --test tests/*.test.mjs`, ~40 min): **943 testes, 943 passaram, 0 falharam** (rodada final, depois das correções abaixo).
- Arquivos novos (cobrem a lista obrigatória): `ce-contrato-identidade` (10), `ce-escrita-reconciliacao` (≈30), `ce-importacao` (16), `agenda-lembretes-integrados` (≈15), `alice-casal-e-presenca` (≈8).
- **Expectativas de testes antigos que mudaram (e por quê):** `espelho-ce` — a reserva "já existente" do cenário de timeout agora precisa trazer profissional/procedimento/fim (reconciliação estrita); `ce2`, `comportamento`, `limpezaRegras` — eram verificações do TEXTO do código (nome de variável, tamanho do trecho, ordem) e foram atualizadas para os novos marcadores sem afrouxar a intenção; `agenda-ferramentas`/`jornadas-integradas` — o CE simulado devolvia `data: []` para `GET /bookings/{uuid}` (uma lista, não uma reserva); como a Alice agora lê a reserva antes de remarcar/confirmar, o simulado passou a devolver a reserva de verdade; `conduta-comercial`/`health` — pinos de revisão e de migração.
- **Bug real achado pelos testes novos:** um único cadastro do CE com o telefone da esposa era ligado ao marido (acompanhante) porque só havia um candidato; corrigido em `pickCandidate` (nome completo diferente ⇒ não é a mesma pessoa).
- **Limitação do ambiente:** nenhuma validação contra o CE ou o WhatsApp reais; nada de produção foi tocado.
