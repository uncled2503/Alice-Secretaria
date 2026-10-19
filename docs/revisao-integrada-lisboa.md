# Revisão integrada — Lisboa Beauty Center (18/10/2026)

Escrito para: o dono do sistema e quem for implantar/validar (não para a clínica).
Nada aqui foi commitado, enviado, implantado ou aplicado em produção. Tudo abaixo é **código local + testes simulados**.

## 0. O que foi e o que NÃO foi possível verificar

| Fonte | Situação |
|---|---|
| Código, diffs, migrações, testes, scripts | Lidos e executados localmente (seções 1 e 8). |
| Banco de produção (dados reais da Lisboa) | **Sem acesso.** Nenhuma afirmação sobre o que está cadastrado hoje em produção. Para isso existe a conferência de prontidão (`GET /api/clinics/lisboa-preflight`, seção 6), que precisa ser rodada **depois** da implantação. |
| Relatório externo / anexos / prints da Lisboa | **Nenhum disponível neste ambiente.** Os incidentes de 15 e 16/10 foram tratados pelo que consta no código, nos commits e nos documentos já existentes em `docs/`. |
| Versão que está no ar | **Desconhecida.** O último commit é `d9cbc2e`; o deploy é manual no EasyPanel (push ≠ implantação). Só `/health` (campo `revision`, `lastMigration`, uptime) diz o que roda. |
| OpenAI, UAZAPI e Clínica Experts reais | Não chamados. Nos testes são simulados (seção 9 explica o que isso prova e o que não prova). |

## 1. Estado levantado

- Branch `master`; `HEAD = origin/master = d9cbc2e` (0 à frente, 0 atrás). Ou seja: **nenhuma das cinco etapas está commitada** — o que está em `d9cbc2e` é só a correção da revisão por IA que barrava todas as respostas.
- Alterações locais: 45 arquivos modificados + 40 caminhos novos (arquivos e pastas de migração) — 2.570 linhas inseridas / 662 removidas nos modificados.
- Migrações **ainda não aplicadas em produção**: **nove** pastas novas (cinco de 16-18/10 + `20261019100000_google_compat_sem_validacao`, `20261019110000_contexto_da_resposta`, `20261019120000_retomadas_modo_restrito`, `20261019130000_recontato_recuperacao`); todas aditivas — seções 7 e 12.
  (as cinco primeiras: `20261016160000_controle_de_lembretes`, `20261017100000_conduta_comercial`, `20261018100000_recontatos_e_retomadas`, `20261018110000_pesquisa_google_indicacao`, `20261018120000_ofertas_sem_cadastro`)
- Scripts de atualização cadastral (todos com prévia por padrão, só admin, só a Lisboa, idempotentes): `lisboa-jornadas`, `lisboa-conduta`, `lisboa-limpar-regras`, `lisboa-recontatos`, `lisboa-google`, `lisboa-vincular-procedimentos`, `lisboa-descritivos`, `lisboa-servicos` e a conferência `lisboa-preflight` (só leitura; também `npm run preflight:lisboa`).
- Nada roda no boot além de `prisma migrate deploy` quando há migração pendente (`scripts/start.mjs`). Nenhum seed, nenhuma manutenção, nenhum envio: as tarefas só rodam por agendamento (`scheduleLocked`) com trava no banco.
- Versão do código: `2026-10-19-k` (`src/version.ts`), última migração esperada em `/health`: `20261019130000_recontato_recuperacao`.

## 2. Matriz de rastreabilidade

Legenda de estado: **IMPL** = no código local · **TEST** = coberto por teste automatizado simulado · **CFG** = preparado, **não aplicado** (depende de ação/decisão) · **PROD** = só se confirma em produção · **COMMIT** = já está em `d9cbc2e`.
"Já existe regra no prompt" não conta como evidência: a coluna *Código* aponta para trava/decisão em código quando existe.

### Etapa 1 — Conversas sem resposta, revisão por IA, registro de envio

| # | Problema | Esperado | Código | Teste | Dependência | Estado |
|---|---|---|---|---|---|---|
| 1.1 | Revisão por IA barrava TODAS as respostas | Resposta da Alice nunca é barrada; a revisão reformula; sem alternativa válida sai a original | `ai/sendGate.ts` | `revisao-envio` (25) | — | COMMIT (`d9cbc2e`) + TEST. Implantação **não verificada** |
| 1.2 | Texto reescrito podia sair sem passar pelas travas | A resposta final (inclusive a reescrita) é validada de novo; o que falha nas travas não sai | `ai/replyGuard.ts` | `resposta-final` (15); jornada E | — | IMPL + TEST |
| 1.3 | Falha da revisão derruba o atendimento | Disjuntor **por clínica** (barrar/reescrever ≥ 60% desliga a revisão 30 min); outra clínica não é afetada | `ai/sendGate.ts` | jornada E; `revisao-envio` | — | IMPL + TEST |
| 1.4 | Enviar qualquer coisa só para não ficar em silêncio | Sem alternativa segura: sai a original validada ou silêncio/encaminhamento válido; nunca texto reprovado | `sendGate.ts` + `replyGuard.ts` | jornada E | — | IMPL + TEST |
| 1.5 | "Enviado" fictício no painel | Estados reais (`pending/sending/sent/unconfirmed/failed/blocked/expired…`); envio incerto não é reenviado às cegas | `ai/delivery.ts`, `uazapi/client.ts` | `entrega-resposta` (12); jornada E | UAZAPI real | IMPL + TEST; **PROD** para a entrega real |
| 1.6 | Falha sem rastro | Falha de atendimento rastreável + "saúde do atendimento" | `ai/replyFailure.ts`, `crm/attendanceHealth.ts`, `crm/unanswered.ts` | `atendimento-integrado` (7); `reliability` | — | IMPL + TEST |
| 1.7 | Silêncio/encaminhamento silencioso inválido ou invisível | Encaminhamento silencioso é válido **e deixa pendência visível para a equipe** | `crm/nonCommercial.ts`, `ai/jobSeeker.ts`, `crm/hotLeads.ts` | jornada H | — | IMPL + TEST |

### Etapa 2 — Agenda, jornada, confirmações

| # | Problema | Esperado | Código | Teste | Dependência | Estado |
|---|---|---|---|---|---|---|
| 2.1 | Horário fora da jornada real / profissional sem habilitação | Só oferece/reserva dentro da jornada real × habilitação × duração inteira × CE | `scheduling/eligibility.ts`, `scheduling/slots.ts`, `clinicaexperts/availability.ts` | `agenda-jornada` (15); jornada B | Cadastro das jornadas | IMPL + TEST; **CFG** (2.2) |
| 2.2 | Jornadas cadastradas (Suelen/Adriana 12h–21h, Talita 8h–17h) | Início/fim corretos; dias, intervalos e exceções preservados; ambiguidade listada, não aplicada | `maintenance/lisboaJornadas.ts` | `agenda-jornada`; preflight (`jornada.*`) | **Aplicação em produção** (prévia → aplicar) | **CFG** — não aplicado |
| 2.3 | Lembrete/confirmação duplicado ou perdido no reinício | Registro persistente por reserva (`ReminderDispatch`); CE inconclusivo adia | `reminders/ledger.ts`, `reminders/cron.ts` | `lembretes-ciclo`, `confirmacoes-agenda` (15); jornada D | Migração `…controle_de_lembretes` | IMPL + TEST |
| 2.4 | Lembrete de reserva cancelada/trocada | Confere a reserva ao vivo no CE antes de enviar | `clinicaexperts/liveCheck.ts` | `ce-lembrete-vivo` (11) | CE real | COMMIT parcial + TEST; **PROD** |
| 2.5 | Reserva sem procedimento ficava sem confirmação | Mantém reserva e identidade; confirma só com data e hora; nome interno nunca aparece | `reminders/cron.ts`, `clinicaexperts/pull.ts` | jornada D | CE real | IMPL + TEST |
| 2.6 | Alice dizia "agendado" antes do CE aceitar | "Agendado/remarcado" só depois do CE aceitar | `ai/alice.ts` | jornadas B e C | CE real | COMMIT parcial + TEST; **PROD** |
| 2.7 | Remarcação virava desistência | Mantém o procedimento; histórico preservado; lembrete antigo não sai; **nenhuma retomada** sai (inclusive quando a recepção apaga e recria a reserva no CE) | `ai/alice.ts`, `clinicaexperts/pull.ts`, `Appointment.cancelSource` | jornadas C e C2 | CE real | IMPL + TEST |

### Etapa 3 — Entendimento da cliente e ofertas fora de contexto

| # | Problema | Esperado | Código | Teste | Dependência | Estado |
|---|---|---|---|---|---|---|
| 3.1 | "Clarear o interno da coxa" virava gordura/celulite e consulta de agenda | Objetivo e região lidos; nenhuma disponibilidade consultada só porque há agenda; falta de dado vira pergunta ou encaminhamento | `ai/concerns.ts`, `ai/conduct.ts`, `ai/bookingIntent.ts` | jornada A; `conduta-comercial` (34) | — | IMPL + TEST |
| 3.2 | Nome informado durante o agendamento reiniciava a venda; "obrigada" gerava nova oferta/reserva | Não reinicia; "obrigada" só fecha | `ai/salesFlow.ts`, `ai/relevance.ts`, `ai/situation.ts` | jornadas B e (obrigada pós-pesquisa); `alice-situacoes` | — | IMPL + TEST |
| 3.3 | Serviço que a clínica não faz (luz pulsada) | Honestidade, sem avaliação substituta, **sem equivalência inventada** com LEDterapia | `Clinic.notOfferedServices`, `ai/conduct.ts`, `maintenance/lisboaConduta.ts` | `conduta-comercial`; jornada de isolamento | Aplicar `lisboa-conduta` | IMPL + TEST; **CFG** |
| 3.4 | **Protocolo do Olhar** (oferta de anúncio sem cadastro no CE) virava avaliação ou "a clínica não realiza" | Fica **pendente**: nunca associado a outro procedimento, nunca trocado por avaliação; quem quer agendar vai para a equipe com motivo "Oferta sem cadastro: …"; se o cadastro passar a existir, o cadastro manda | `Clinic.unmappedOffers`, `ai/conduct.ts`, `ai/alice.ts` | jornada "Protocolo do Olhar"; `conduta-comercial` | **Cadastrar no CE/painel** + aplicar `lisboa-conduta` | IMPL + TEST; **CFG**; dependência documentada |
| 3.5 | Modo de agendamento por procedimento (direto × avaliação) | Cada procedimento declara; sem declaração, a conduta não presume | `Procedure.bookingMode`, `Clinic.strictBookingRules` | `conduta-comercial` | **Lista da clínica** (qual é direto, qual exige avaliação) | IMPL + TEST; informação **pendente** |
| 3.6 | Regras recomendadas contradiziam a condução | Texto-fonte harmonizado; troca no banco seletiva (seção 3) | `ai/rules.ts` | jornada "regras recomendadas…" | Aplicar `lisboa-conduta` | IMPL + TEST; **CFG** |
| 3.7 | Nota antiga da memória do lead valendo tanto quanto a agenda | Agenda, resultado de ferramenta e fala atual valem mais | `ai/situation.ts`, `ai/alice.ts`, `ai/sendGate.ts` | jornada "agenda real e ferramentas prevalecem" | — | IMPL + TEST (**texto de prompt + trava**: o modelo real pode ainda errar — PROD) |

### Etapa 4 — Recontatos e retomada de avaliações canceladas

| # | Problema | Esperado | Código | Teste | Dependência | Estado |
|---|---|---|---|---|---|---|
| 4.1 | Recontato fora da hora / em cascata | Vencimento, abertura e prazo no fuso da clínica; feriados; atraso máximo 3 dias; intervalo mínimo 6 h | `crm/followupSchedule.ts`, `crm/followup.ts` | `recontatos-retomadas` (36); jornada F | **Definição de horários** (8h / a partir das 12h / segundas — **não presumida**, não registrada em nenhum cadastro lido) | IMPL + TEST; horários **pendentes** | **(Atualizado em 19/10: ver seção 12.)** A recuperação (24 h/fim do dia) virou política por clínica; Lisboa: **pendente**.
| 4.2 | Reinício perde evento ou dispara tudo | Registro persistente (`FollowUpDispatch`); sem cascata | `crm/followupLedger.ts` | `recontatos-retomadas`; jornada F | Migração `…recontatos_e_retomadas` | IMPL + TEST |
| 4.3 | Retomada de avaliação cancelada | Só com **evidência confiável** de cancelamento (paciente, painel, API, CE) — nunca por apagão/desfeito/sem origem; nasce **desligada e sem texto** | `crm/resumeFlows.ts`, `ResumeFlowConfig` | `recontatos-retomadas`; jornadas C/C2 | **Texto e aprovação da clínica** | IMPL + TEST; **CFG** (desligada) |
| 4.4 | Conflito entre contatos | Prioridade: agendamento em curso > retorno combinado > fluxo específico > recontato genérico | `crm/followup.ts` (`competingContact`) | `recontatos-retomadas` | — | IMPL + TEST |
| 4.5 | Resposta à retomada tratada como "só agradeceu" | A mensagem da automação não conta como fala da Alice | `ai/situation.ts` | jornada "retomada → resposta" | — | IMPL + TEST |
| 4.6 | Pendência de transferência silenciosa invisível | Alerta para a equipe e relatório das 20h | `crm/hotLeads.ts`, `crm/dailyReport.ts` | jornada H; `recontatos-retomadas` | — | IMPL + TEST |

### Etapa 5 — Pesquisa de satisfação, Google, indicação

| # | Problema | Esperado | Código | Teste | Dependência | Estado |
|---|---|---|---|---|---|---|
| 5.1 | Pesquisa em excesso | No máximo uma a cada **15 dias por pessoa** (identidade = paciente / mesmo `ceUuid`); NPS espera o pós | `reminders/nps.ts`, `reminders/surveyFlow.ts` | `pesquisa-google-indicacao` (30); jornada G | — | IMPL + TEST (15 dias é **fixo no código**) |
| 5.2 | "14" (horário) lido como nota | Número solto só vale se a última pergunta foi a pesquisa; hora/data/quantidade/idade excluídas | `reminders/surveyReply.ts` | `pesquisa-google-indicacao` | — | IMPL + TEST |
| 5.3 | Link do Google errado | Só é enviado se **confirmado** (`googleReviewConfirmedAt`) e com formato válido; o da Lisboa **nasce não confirmado** | `reminders/reviewLink.ts`, `maintenance/lisboaGoogle.ts` | `pesquisa-google-indicacao`; jornada G (com link de TESTE) | **Link correto + nome do estabelecimento** | IMPL + TEST; **bloqueado por informação** | **(Atualizado em 19/10: ver seção 12.)** Compatibilidade ≠ validação: migração compensatória.
| 5.4 | Indicação misturada com a pesquisa | Job **separado** (`convite-indicacao`), desligado sem texto + atraso definidos pela clínica | `reminders/surveyFlow.ts` | jornada G | **Política e texto da clínica** | IMPL + TEST; **CFG** (desligado) |
| 5.5 | Reclamação recebe convite | Reclamação interrompe mensagens incompatíveis; "obrigada" depois da nota só fecha | `reminders/surveyHandler.ts` | jornada G e "obrigada pós-pesquisa" | — | IMPL + TEST |
| 5.6 | Nota de quem está em atendimento humano | Registrada (sem responder, sem Google, sem indicação); depois da pausa, silêncio | `reminders/surveyHandler.ts`, `reminders/surveyFlow.ts`, `uazapi/client.ts` | `atendimento-integrado` (6 novos) | — | IMPL + TEST (resolvido em 19/10) |

### Itens desta revisão integrada

| # | Item | Estado |
|---|---|---|
| R1 | Contradição entre regras padrão e condução (4 textos) | IMPL + TEST (seção 3) |
| R2 | Memória × agenda × gate de revisão | IMPL + TEST |
| R3 | Travas de tarefa devolvidas no desligamento (`releaseMyLocks`, só as desta cópia) | IMPL + TEST |
| R4 | Conferência de prontidão só de leitura | IMPL + TEST |
| R5 | Paridade migrações × `schema.prisma` (os testes usam `db push`, que **não** exercita o SQL das migrações) | Verificado com script próprio: só divergência pré-existente (`Clinic.closedOnHolidays`: padrão `true` no schema, `false` no banco migrado) |
| R6 | Isolamento entre clínicas e modo loja (Laleblu) | IMPL + TEST |

**Fora das cinco etapas (nada implementado, nada testado, não verificado como a Alice se comporta):** pacotes, saldo de sessões, comprovante de pagamento, validade comercial, renovações. Seguem como pendência separada.

## 3. Fontes de conflito (onde a contradição nascia) e como foram tratadas

Princípio: corrigir **na fonte**, sem apagar treino nem memória inteiros, de forma seletiva e idempotente; fato ao vivo (agenda, ferramenta, fala atual) vence nota antiga.

| Fonte | Contradição | Tratamento | Preserva |
|---|---|---|---|
| `DEFAULT_RULES` (`ai/rules.ts`) — 4 regras recomendadas | "toda resposta termina oferecendo horário", "nunca pergunte quer agendar", "sempre ofereça os dois caminhos", "a clínica não realiza" até para oferta sem cadastro | Texto-fonte harmonizado (exceções: quem recusou/"vou pensar"/só agradeceu/já agendado/já escolheu; oferta sem cadastro vai para a equipe). Troca no banco só nas linhas **auto-semeadas com o texto antigo exato** (`substituirRegrasPadraoAntigas`, parte do `lisboa-conduta`: prévia, depois aplicar) | Regra editada à mão, regra apagada de propósito (não recria), qualquer outra regra |
| `RETIRED_DEFAULT_RULES` | Textos antigos voltariam a qualquer reaplicação de perfil | Os 4 antigos entram na lista de aposentadas | — |
| Regras do seed da Lisboa (`seedLisboa.ts`) | Compatíveis, mas dependem de a diretiva da conversa ter precedência | Mantidas; a precedência está no código (`conduct.ts`, hierarquia em `situation.ts`) e documentada em `hierarquia-de-regras.md` | Tudo |
| Regra "Toda resposta deve terminar…" do seed da Diamond Clinic | Outra clínica | **Não tocada** (regra da Lisboa não é global) | — |
| Apelidos/aliases (ex.: "luz pulsada" em Fototerapia) | Faziam o serviço recusado casar com um procedimento | `lisboa-conduta` remove **só** o apelido do serviço recusado; "LEDterapia" fica **sem** equivalência | Todo o resto do cadastro |
| Descrições/FAQ com "luz pulsada" | Texto livre | **Só relatado** (`revisar_texto`), não reescrito | Texto da clínica |
| Memória do lead (`briefingNotes`) | Nota velha ("cancelou", "sem horário") contra a agenda de hoje | Rótulo "podem estar velhas; vale a agenda"; hierarquia e gate de revisão dizem o mesmo; **memória não é apagada** | Memória inteira |
| Config de banco | `notOfferedServices`, `unmappedOffers`, `bookingMode`, `strictBookingRules` | Atualização seletiva com prévia (`lisboa-conduta`); modo estrito **nunca liga sozinho** | Valores já preenchidos |
| Textos automáticos (retomada, convite, link) | Texto antigo reutilizado | Retomada e convite nascem **desligados e sem texto**; link nasce **não confirmado** | — |
| Caches/memória em processo | Juiz de recontato (cache por impressão digital + 4 h); contexto de resposta em memória | Chave inclui o estado; contexto em memória **se perde no reinício** (limite aceito: a trava de resposta final volta a avaliar do zero na próxima mensagem) | — |

## 4. Lacunas corrigidas nesta revisão

1. **Oferta anunciada sem cadastro** (Protocolo do Olhar) — antes: avaliação no lugar ou "a clínica não realiza"; agora: encaminha à equipe, sem associar a outro procedimento. Também removida a exceção que deixava uma origem de anúncio escapar do modo estrito.
2. **Memória do lead × agenda** — a hierarquia e o gate de revisão passam a dizer que fato ao vivo vence nota antiga.
3. **Regras padrão contraditórias** — corrigidas na fonte + troca seletiva com prévia (idempotente).
4. **Travas de tarefa** — no desligamento limpo a cópia devolve as suas (a nova assume sem esperar o prazo de 15 min). Se o processo for **morto** sem desligamento limpo, o prazo de 15 min continua valendo.
5. **Conferência de prontidão** — nova rota/CLI só de leitura que separa aplicado × preparado × dependente da clínica.
6. **Migração `20261018120000_ofertas_sem_cadastro`** (coluna `Clinic.unmappedOffers`) + paridade verificada.
7. **Teste frágil de fuso** — `conduta-comercial` calculava "amanhã" em UTC; depois das 21h em São Paulo isso caía em "depois de amanhã" e a trava de data barrava a resposta simulada. Era defeito do teste, não do produto; corrigido para usar o calendário de São Paulo.

## 5. Cadastros e informações pendentes (nada foi inventado)

| Item | O que o sistema faz hoje | O que falta | Quem decide |
|---|---|---|---|
| Jornadas: Suelen 12h–21h, Adriana 12h–21h, Talita 8h–17h | Rotina pronta (prévia → aplicar); só altera início/fim, lista ambiguidades e conflitos | Rodar a prévia em produção, conferir, aplicar | Dono / clínica |
| Vínculos procedimento ↔ profissional | Preflight acusa procedimento sem profissional | Conferir/completar | Clínica |
| Luz pulsada (não oferecida) | Lista padrão (luz pulsada, luz intensa pulsada, IPL) pronta; LEDterapia sem equivalência | Aplicar `lisboa-conduta` | Dono |
| Protocolo do Olhar | Marcado como oferta sem cadastro (preparado) | Cadastrar no CE/painel **ou** manter pendente; decidir o que a equipe responde | Clínica |
| Modo de agendamento por procedimento | Sem declaração = não presume | Lista: quais agendam direto, quais exigem avaliação | Clínica |
| Link do Google | `https://g.page/r/CVxcf78iE5IhEAE/review` está no banco (origem: migração de 16/10) mas **NÃO confirmado** → não é enviado | Link correto **e** nome do estabelecimento de destino, conferidos por uma pessoa | Clínica |
| Pesquisa a cada 15 dias | Fixa no código | Só se quiserem outra frequência | Dono |
| Convite de indicação | Desligado, sem texto | Política, texto e atraso | Clínica |
| Recontatos "8h / a partir das 12h / segundas" | Não presumidos; preflight `recontato.horarios` aponta | Definição escrita de cada regra | Clínica |
| Retomadas de avaliação (cancelada / sem fechamento) | Desligadas, sem texto | Texto, janela de dias/horas e quem aprovou | Clínica |
| Pacotes, saldo de sessões, comprovante de pagamento, validade comercial, renovações | Fora das cinco etapas | Escopo próprio | Dono |

## 6. Sequência de implantação (preparada; **não executada**)

Base de endereços: `/api/…` exige sessão de administrador. Toda rota de manutenção roda em **prévia** por padrão; só grava com `"dryRun": false`.

1. **Decidir o que vai junto.** Hoje são 85 caminhos locais sem commit. O commit/push é decisão do dono (memória do projeto: push direto na `master`; o webhook **só sincroniza**).
2. **Anotar o estado atual.** `GET /health` → guardar `revision`, `lastMigration`, uptime. `revision` `2026-10-16-e…` é o que está em `d9cbc2e`; `2026-10-18-j…` é este lote. Qualquer outra marca (ou uma anterior a `2026-10-16-e`) significa que a versão em produção **não é** a que foi analisada.
3. **Backup antes de tudo.** `npm run backup` (ou confirmar o backup das 03:30), conferir `BACKUP_DIR` num volume persistente e **abrir** o arquivo (restaurar numa cópia, conforme `docs/backup.md`). Sem backup verificado, não seguir.
4. **Commit + push** (dono). O servidor ainda não mudou.
5. **Clicar em "Implantar" no EasyPanel.** No boot `scripts/start.mjs` roda `prisma migrate deploy` e aplica as 5 migrações (seção 7). Nenhum seed, nenhuma manutenção e nenhum envio no boot.
6. **Validar a versão:** `GET /health` → `revision` começa com `2026-10-18-j`, `lastMigration = 20261018120000_ofertas_sem_cadastro`, uptime recém-reiniciado.
7. **`GET /api/clinics/lisboa-preflight`** — registrar o resultado "antes" (esperado: itens de cadastro em `pendente`; nada `divergente` em ambiente/migração).
8. **Atualizações cadastrais, uma por vez, sempre prévia → conferir → aplicar**, nesta ordem:
   1. `lisboa-jornadas` (resolver as ambiguidades listadas com `escolhas`; não aplicar o que estiver ambíguo);
   2. `lisboa-conduta` (serviços não oferecidos, oferta sem cadastro, regras padrão, `marcar` **só** com a lista da clínica; **não** passar `ativarModoEstrito` sem decisão);
   3. `lisboa-limpar-regras` (se ainda houver regras antigas da lista aprovada);
   4. `lisboa-google` com `confirmar` — **somente** quando houver o link e o estabelecimento conferidos;
   5. `lisboa-recontatos` (conferência) e, **só com aprovação e texto da clínica**, `ativar`; idem `convite` em `lisboa-google`.
9. **Rodar o preflight de novo** e anexar "antes/depois".
10. **Roteiro de validação controlada** (seção 10), com contatos de teste autorizados.
11. **Acompanhar** as primeiras rodadas (seção 8).

**Rollback.**
- Código: reimplantar a imagem anterior no EasyPanel. As migrações **permanecem** (são aditivas); o código antigo ignora colunas/tabelas novas — verificado: nenhuma coluna nova obrigatória sem padrão em tabela existente.
- Dados que as rotinas cadastrais mudaram **não voltam sozinhos** com o rollback do código. Cada aplicação grava uma linha de atividade (quem, quando, o quê) e as prévias mostram o "antes"; reverter é refazer o cadastro (ex.: esvaziar `unmappedOffers`, restaurar a jornada, apagar a regra trocada).
- Restaurar o backup é o último recurso e **perde tudo o que entrou depois dele** (mensagens, reservas, pesquisas).
- Irreversível: mensagem já enviada ao paciente; linhas dos registros de envio (`ReminderDispatch`, `FollowUpDispatch`, `AutomationRun`) — por desenho elas impedem repetição; **apagá-las num rollback reabriria envios**, então não devem ser apagadas.

## 7. Migrações e compatibilidade

Todas as cinco são **aditivas** (verificado lendo o SQL): `CREATE TABLE`/`CREATE INDEX`/`ALTER TABLE … ADD COLUMN` com padrão ou anuláveis. Não há `DROP`, `DELETE`, nem renomeação.

| Migração | O que faz |
|---|---|
| `20261016160000_controle_de_lembretes` | Tabela `ReminderDispatch` (+ índices) |
| `20261017100000_conduta_comercial` | `Procedure.bookingMode`, `Clinic.strictBookingRules` (padrão `false`), `Clinic.notOfferedServices` |
| `20261018100000_recontatos_e_retomadas` | `FollowUpDispatch`, `AutomationRun`, `ResumeFlowConfig` (nasce `enabled=false`), `ResumeTarget`; colunas anuláveis `Appointment.cancelledAt/cancelSource` e `Conversation.recontactFingerprint/recontactJudgedAt` |
| `20261018110000_pesquisa_google_indicacao` | Colunas de confirmação do link do Google (`Clinic.googleReviewConfirmedAt/By/Place`), da pesquisa (`SatisfactionSurvey.answeredByMessageId/band/hasComplaint/linkState`) e `ResumeFlowConfig.delayMinutes`. **Contém um `UPDATE`:** clínicas **que não são a Lisboa** e já tinham link cadastrado ficam marcadas como confirmadas ("migração: link já cadastrado pela clínica"), para continuar enviando como antes. A Lisboa fica **fora**. |
| `20261018120000_ofertas_sem_cadastro` | `Clinic.unmappedOffers` (anulável) |

Divergência **pré-existente** (não criada nem corrigida aqui): `Clinic.closedOnHolidays` — padrão `true` no schema, `false` no banco criado só por migrações. Seeds e telas gravam o valor explicitamente.

## 8. Reinício, trava, duplicidade (examinado)

| Pergunta | Resposta (com base no código e nos testes) |
|---|---|
| O reinício dispara mensagens antigas? | Não em massa: recontato tem atraso máximo de 3 dias e intervalo mínimo de 6 h; retomadas e convite nascem **desligados**; lembretes consultam o registro persistente antes de enviar. **Atenção honesta:** um recontato legitimamente vencido **dentro** da janela de 3 dias pode sair na primeira rodada após a implantação — é o comportamento das regras já cadastradas, não uma regressão, mas a clínica deve saber. |
| Perde travas? | No desligamento limpo as devolve; em queda brusca o prazo de 15 min vale (a nova cópia espera). |
| Libera duplicidade? | Não: os registros de envio persistem no banco e identificam a mesma reserva/ciclo. |
| Reexecuta seeds? | Não: nada roda no boot; os seeds só criam o que falta e a Lisboa já não grava o link. |
| Reabre fluxos encerrados? | Não: estados finais do registro (`sent`, `duplicate`, `expired`, `skipped`…) não voltam a pendente; cancelamento antigo sem origem registrada **não** gera retomada. |
| Existe mecanismo destrutivo silencioso no boot? | Não encontrado. |

## 9. O que os testes simulados provam — e o que não provam

**Provam:** a lógica de decisão e a ordem de prioridades; a persistência e a idempotência num SQLite real (banco temporário por arquivo de teste, relógio controlado quando preciso); a integração entre os módulos reais (`alice.ts` + ferramentas + envio + registros); o isolamento entre clínicas e o modo loja; a regressão de cada defeito reportado.

**Não provam:** o que o modelo real da OpenAI escreve (nos testes as respostas são roteirizadas); a entrega e os formatos reais da UAZAPI; o contrato e a latência reais do CE e o que está cadastrado nele; o comportamento sob volume e concorrência reais; os dados reais da Lisboa; o texto/estilo que o modelo produzirá com os prompts novos. Tudo isso só se confirma na validação controlada (seção 10).

Resultado da execução desta revisão: ver seção 11.

## 10. Roteiro de validação controlada em produção

Regras: **só contatos de teste autorizados pela clínica** (número da própria equipe, cadastrado como `[TESTE] …`); nenhum paciente real; nenhum envio em lote; um cenário por vez; anotar horário, evidência e quem executou. Parar tudo e acionar o dono se a condição de interrupção ocorrer.

| # | Cenário | Preparação | Ação | Resultado esperado | Evidência | Interromper se |
|---|---|---|---|---|---|---|
| V0 | Linha de base | Backup verificado; contato de teste cadastrado | `/health`; `lisboa-preflight` | `revision 2026-10-18-j`; migração `20261018120000…`; nada `divergente` | Capturas/JSON | `revision` ou migração diferentes; item `divergente` |
| V1 | Resposta e entrega | — | Teste manda "Oi, que horário vocês atendem?" | Resposta única; entrega `sent` no painel | Conversa no painel; estado de entrega | Resposta duplicada ou `failed/unconfirmed` repetido |
| V2 | Revisão por IA | — | Observar as primeiras respostas reais | Respostas saem; disjuntor fechado | Painel de saúde do atendimento; `/api/ai-usage` | Disjuntor aberto, ou resposta barrada |
| V3 | A) Clareamento | Procedimento de clareamento cadastrado | "Quero clarear o interno da coxa" | Entende o objetivo; **não** lista horários nem fala de gordura/celulite; pergunta ou encaminha | Conversa; ausência de consulta de agenda | Oferece horário ou procedimento errado |
| V4 | B) Agendamento direto | Procedimento direto; profissional com jornada aplicada | Pedir horário dentro de 12h–21h (Suelen/Adriana) | Só horários válidos; reserva no CE; "agendado" **depois** do CE aceitar | Reserva no CE; mensagem posterior | Horário fora da jornada; "agendado" antes do CE; reserva duplicada |
| V5 | B) Nome durante o agendamento | — | Informar o nome completo no meio do fluxo; depois "obrigada" | Não reinicia; "obrigada" só fecha | Conversa | Nova oferta/reserva |
| V6 | C) Remarcação | Reserva de teste de procedimento que **não** seja avaliação | Pedir para remarcar | Mesmo procedimento; CE aceita; lembrete antigo não sai; **sem retomada** | CE; registro de lembretes | Retomada enviada; procedimento trocado |
| V7 | D) Reserva sem procedimento | Criar no CE uma reserva de teste sem procedimento | Aguardar importação e ciclo de confirmação | Reserva mantida; confirmação só com data e hora; sem nome interno | Mensagem recebida; painel | Texto com nome interno; duplicidade |
| V8 | E) Atendimento interrompido | — | Teste pergunta; equipe assume; depois devolve | Alice não responde durante a equipe; volta só conforme a regra; pendência visível | Painel (assumido); relatório | Alice fala durante o atendimento humano |
| V9 | F) Recontato | **Prévia** de `lisboa-recontatos`; horários definidos pela clínica | Conferir quem entraria; só então acompanhar a rodada | Só quem estiver vencido na janela; resposta/agendamento/equipe cancelam o recontato | Matriz da prévia; registro da rodada | Candidata real inesperada; mais de 1 recontato por janela |
| V10 | G) Satisfação | Atendimento de teste concluído; link **ainda não confirmado** | Esperar a pesquisa; responder "5"; depois "14" | Nota 5 registrada; agradecimento **sem link**; "14" não vira nota | `…/pesquisa-diagnostico` do paciente | Link enviado sem confirmação; nota lida de horário |
| V11 | G) Link confirmado e frequência | Link e estabelecimento conferidos e confirmados; **dois** contatos de teste (A e B) | B: atendimento concluído → pesquisa → nota 5. A: depois da pesquisa, concluir um **segundo** atendimento de teste dentro de 15 dias | B recebe o link só com nota positiva e o destino é o estabelecimento certo; A **não** recebe segunda pesquisa dentro de 15 dias | `…/pesquisa-diagnostico` de A e de B | Pesquisa repetida em < 15 dias; link para o destino errado |
| V12 | Indicação | Convite desligado | Verificar | Nenhum convite enviado | Registro do job | Qualquer convite |
| V13 | H) Contato não comercial | — | "Olá, envio meu currículo" | Vai à equipe em silêncio; sem horário, pesquisa ou recontato; pendência visível | Painel; alerta | Resposta comercial ou recontato depois |
| V14 | Protocolo do Olhar | `lisboa-conduta` aplicada com a oferta sem cadastro | "Vi o anúncio do Protocolo do Olhar, quero agendar" | Encaminha à equipe ("Oferta sem cadastro"); **sem** avaliação, **sem** outro procedimento | Conversa; motivo no encaminhamento | Avaliação ou procedimento oferecido |
| V15 | Isolamento | — | Só observar a Laleblu e outra clínica após a implantação | Atendimento normal; nenhuma regra da Lisboa | Conversas recentes | Qualquer regra da Lisboa em outra clínica |
| V16 | Reinício | Implantação concluída | Observar 30–60 min das rodadas | Nada em massa; tarefas retomam | Registro das rodadas | Envio em massa ou tarefas travadas |

Limite do roteiro (**corrigido em 19/10**): as retomadas e o convite agora têm **modo restrito** a contatos de teste com limite e prévia — ver seção 12.5. Ainda assim: ligar sem restrição só com aprovação da clínica e depois de conferir a prévia.

## 11. Testes desta revisão

Comandos (na pasta do projeto, Windows, Node 20): `npx prisma generate` · `npm run build` (tsc, sem erros) · `node --test tests/*.test.mjs` (63 arquivos). Execuções feitas em 18/10/2026 entre ~21h e ~23h de São Paulo (o UTC já era 19/10 — o que expôs dois testes dependentes da hora, abaixo).

| Execução | Testes | Passaram | Falharam |
|---|---|---|---|
| Arquivos tocados por esta revisão (`jornadas-integradas`, `conduta-comercial`, `health`, `limpezaRegras`) | 82 | 82 (depois de corrigir o teste de fuso e o texto do teste de precedência) | 0 |
| Suíte completa nº 1 | 633 | 631 | 2 — ambas em `painel-estatisticas` |
| Suíte completa nº 2 (depois de corrigir essas duas) | 633 | 632 | 1 — `anuncios` |

**Falhas, separadas por origem**
- **Nova nesta revisão: nenhuma.** Nenhuma falha aponta para o código alterado nas cinco etapas ou na revisão.
- **Pré-existentes, dependentes da hora (defeito do teste, corrigido):** `painel-estatisticas` ("Hoje, Ontem e 30 dias…" e "o gráfico mostra os últimos dias…") criava agendamentos em "agora + 2 h / + 3 h"; depois das 21h em São Paulo isso já é o dia seguinte. Os horários passaram a ser ancorados no dia da clínica (12h e 13h). Idem `conduta-comercial` ("depois da reserva concluída…"), que calculava "amanhã" em UTC. Os arquivos de código `period.ts` e `realStats.ts` não foram tocados.
- **Pré-existente, intermitente sob carga:** `anuncios` ("nomes do anúncio: a Marketing API preenche…") falhou na execução completa nº 2 (log: `[etiquetas] falha ao sincronizar: PrismaClientKnownRequestError`, conflito no SQLite temporário com a suíte inteira em paralelo) e **passa 26/26 isolado**, duas vezes. `src/ads` e `tests/anuncios.test.mjs` não foram alterados. Já havia aparecido antes desta revisão.

**Testes novos desta revisão:** 17 em `tests/jornadas-integradas.test.mjs` (jornadas A–H; Protocolo do Olhar; memória × agenda; isolamento + Laleblu; reinício/travas/boot; conferência de prontidão; C2 remarcação por apagar-e-recriar; retomada → resposta; "obrigada" depois da pesquisa; troca seletiva das regras padrão) + 2 asserções novas em `conduta-comercial` (oferta sem cadastro aplicada; forma nova de `aplicado`) + ajuste do `health` (última migração).

**O que a execução NÃO cobriu:** produção, OpenAI/UAZAPI/CE reais, modelo real (respostas roteirizadas), volume/concorrência real, a aplicação das atualizações cadastrais em produção, o link do Google, e os itens "fora das cinco etapas" (seção 2).



## 12. Segunda revisão (19/10/2026) — seis pendências do relatório anterior

Escrito para: o dono do sistema. Continua tudo **local** (`HEAD = origin/master = d9cbc2e`; 99 caminhos sem commit: 48 modificados + 51 novos). Nada commitado, enviado, implantado, aplicado em produção ou disparado. Esta seção **corrige** o texto das seções anteriores onde divergir (versão `2026-10-19-k`; última migração `20261019130000_recontato_recuperacao`; **nove** migrações novas, todas aditivas — as cinco da seção 7 mais `20261019100000_google_compat_sem_validacao`, `20261019110000_contexto_da_resposta`, `20261019120000_retomadas_modo_restrito`, `20261019130000_recontato_recuperacao`).

### 12.1 Causas confirmadas, hipóteses e o que não foi reproduzido

| # | Tema | Confirmado (com evidência) | Hipótese / não reproduzido |
|---|---|---|---|
| 1 | Link do Google | A migração `20261018110000` gravava `googleReviewConfirmedBy = 'migracao: link ja cadastrado pela clinica'` + `ConfirmedAt` em todas as clínicas (menos a Lisboa) que tinham link: atribuía uma conferência que ninguém fez. **Aplicação em algum ambiente: sem evidência** — a pasta nunca esteve no git (`git log` vazio) e o `prisma/dev.db` local parou em `20261009120000_job_lock`. Produção: **desconhecido**. | Se alguém aplicou a mão em produção: coberto pela migração compensatória (funciona nos dois casos). |
| 2 | Falha `anuncios` | Causa: **espera fixa de 250 ms** pela busca de nomes em segundo plano (duas vezes no teste). Reproduzido: 8 cópias do arquivo em paralelo → a resolução levou 571–1050 ms; a cópia 7 falhou na segunda espera (`'pending'` ≠ `'unavailable'`), idêntico à falha da suíte. **Não era banco compartilhado**: cada processo usa `alice-anuncios-<pid>-<timestamp>.db` próprio. `src/ads` e `tests/anuncios.test.mjs` eram idênticos ao HEAD ⇒ o defeito é do teste, comparável e preexistente. | O ruído `[etiquetas] falha ao sincronizar… Tag does not exist` aparece quando tarefas em segundo plano continuam depois de o arquivo de teste apagar o banco; é só ruído (origem: não corrigida, sem efeito em resultado). |
| 3 | Contexto da resposta | "Contexto em memória" = `Map` do processo em `ai/replyGuard.ts`, validade 15 min, que guarda o que as ferramentas **fizeram e devolveram** na geração. Serve **só** para a entrega validar o texto que vai sair (inclusive a reescrita da revisão por IA). Sem ele (reinício, ou retomada depois de 15 min) a original saía **sem** conferência e a reescrita só era comparada com a original. Reserva, procedimento, remarcação, pesquisa, encaminhamento e deduplicação **não dependem dele** (vêm do banco). | `pendingReplies` (agrupamento por `replyDelaySeconds > 0`, timer em memória) e `pendingPreProcedure` (texto de preparo entre a ferramenta de confirmação e a resposta; a reserva em `PreProcedureSent` é gravada antes do envio) **se perdem** num reinício nesse intervalo. Por leitura do código: com `replyDelaySeconds` (padrão 0) a pessoa fica sem resposta até escrever de novo (o aviso de "sem resposta" sinaliza); no preparo, o texto reservado pode nunca sair. **Não reproduzido em teste e não corrigido** (fora do pedido; precisa de decisão). |
| 4 | Retomadas sem limite | `ativar` não expunha público, limite nem janela; `lookbackDays/maxPerRun/maxPerDay` existiam, mas sem restrição a contatos de teste. | — |
| 5 | Janela de 3 dias | **Padrão antigo do código** (commit `d52e649`, 07/10/2026, "travas contra disparo em massa" depois de reconectar o WhatsApp). Global, fixo, já em produção; **não é configuração nem autorização comercial**. Os prazos de **24 h depois da abertura** e **fim do dia** nas regras de dia seguinte foram **valores introduzidos pelas minhas correções de 17-18/10**; nunca aprovados. | Qual política a Lisboa quer: **pendente**. |
| 6 | Nota com equipe | Com `humanTakeover`, o webhook fazia `continue` antes de `generateReply`: a nota **não era registrada**. | — |

Incidentes de 15 e 16/10: **continuam sem causa comprovada** (sem logs de produção). Nada aqui os declara resolvidos.

### 12.2 Correções e arquivos

1. **Link do Google** — migração compensatória `20261019100000_google_compat_sem_validacao` (não reescreve a anterior): `Clinic.googleReviewLegacyAllowed`; as linhas com a marca falsa perdem `ConfirmedAt/By/Place` e viram "compatibilidade". `reviewLinkState` passou a devolver `basis: "confirmado" | "compatibilidade"` e `placeChecked`; o diagnóstico diz "SÓ POR COMPATIBILIDADE (o destino NUNCA foi conferido)"; o preflight só dá `ok` para confirmado. Painel: mudar/apagar o link zera a compatibilidade. Lisboa: continua sem link (agradece sem link); URL nunca presumida. Arquivos: `prisma/schema.prisma`, migração, `reminders/reviewLink.ts`, `reminders/surveyFlow.ts`, `api/routes.ts`, `maintenance/lisboaGoogle.ts`, `maintenance/lisboaPreflight.ts`.
2. **`anuncios`** — `catalogoResolvido()` espera o estado final (até 15 s) em vez de 250 ms; asserções intactas. Teste `tests/anuncios.test.mjs`.
3. **Contexto** — `Message.replyContext` (resumo mínimo: flags, o que as ferramentas fizeram, dias/horas devolvidos pela agenda, agendamentos ativos; **sem texto de conversa**; só o número de falas da queixa, relidas das próprias mensagens), apagado quando a mensagem chega a estado final (`mark` + poda a cada minuto). Entrega: memória → resumo gravado. Arquivos: `ai/replyGuard.ts` (serializa/lê), `ai/replyContextStore.ts`, `ai/alice.ts`, `uazapi/client.ts`, migração `20261019110000_contexto_da_resposta`. **Bug real achado pelo teste de reinício:** pedir remarcação para o horário que ela **já tem** refazia tudo (apagava o controle de lembretes — saíam de novo —, avisava a equipe outra vez, registrava outra remarcação e oferecia "a vaga que liberou", que é a mesma, à lista de espera); agora é no-op (`ai/alice.ts`).
4. **Retomadas restritas** — `ResumeFlowConfig.runMode/testPatientIds/testMaxSends/testStartedAt`, `FollowUpDispatch.runMode`, `AutomationRun.mode` (migração `20261019120000_retomadas_modo_restrito`); `crm/resumeGuard.ts` (regras e `checkResumeSend`); aplicado na rodada (`crm/resumeFlows.ts`), no convite de indicação (`reminders/surveyFlow.ts`) e **dentro de `sendText`** (`uazapi/client.ts`). Prévia: `previewResumeFlow`. Manutenção: `modoRestrito`, `voltarAoNormal` em `maintenance/lisboaRecontatos.ts` e na rota. **Bug real achado:** `getFunnelStages` tinha corrida (duas chamadas simultâneas para clínica nova → violação de unicidade); corrigido em `crm/stages.ts`.
5. **Recuperação do recontato** — `Clinic.followupRecoveryHours` (migração `20261019130000`): `null` = padrão antigo (3 dias, o de produção hoje), `0` = não recupera, `1–72` = até N horas depois que a janela abriu. Prévia da primeira rodada: `crm/followupPreview.ts` (`previaRecontato` na rota). Revalidação imediatamente antes do envio (`recheckBeforeSend` em `crm/followup.ts`): opt-out/sem interesse (definitivos), retorno combinado, atendimento humano, equipe falou há < 2 h, pessoa escreveu depois, reserva vigente. Preflight: `recontato.recuperacao` **pendente**. **Mudança de comportamento declarada:** os prazos de 24 h / fim do dia deixaram de ser padrão (eram meus); outras clínicas ficam **exatamente como em produção**.
6. **Nota com equipe** — `recordSurveyAnswer({ humanOwned })` (registra, avisa a equipe quando baixa/reclamação, **não** responde, **não** manda Google, **não** agenda indicação; `linkState = atendimento_humano`); `reminders/surveyHandler.ts` (`recordSurveyNoteHumanOwned`; depois da pausa a mesma mensagem recebe **silêncio**); `uazapi/client.ts` (webhook e reprocessamento).

Testes que dependiam do relógio e foram corrigidos: `conduta-comercial` ("amanhã" em UTC), `painel-estatisticas` (agora + 2/3 h), `pesquisa-google-indicacao` (data fixa 18/10), `jornadas-integradas` F (agora com política de recuperação explícita).

### 12.3 Evidência das migrações em banco temporário (SQL real, não `db push`)

`tests/migracoes-google.test.mjs` copia as pastas de `prisma/migrations` e roda `prisma migrate deploy` num SQLite temporário em **três etapas com dados no meio**: (1) até `20261018100000`; insere Lisboa (com o link de 16/10), uma clínica B com link e uma C sem link; (2) aplica `20261018110000` e **demonstra o defeito** (B fica "confirmada" pela marca; Lisboa não); uma confirmação humana verdadeira ("Maria", com estabelecimento) é gravada em C; (3) aplica o resto, inclusive as quatro novas. Resultado verificado: a migração antiga não foi reescrita; B perde a confirmação falsa e fica `basis: compatibilidade, placeChecked: false` (continua enviando); a Lisboa continua sem enviar e com o link intacto; a confirmação humana de C é preservada; o `UPDATE` é idempotente; clínica nova nasce sem confirmação nem compatibilidade. Paridade geral (`migrate diff`): a única divergência é a **preexistente** `Clinic.closedOnHolidays` (padrão `true` no schema, `false` no banco migrado); nenhuma coluna/tabela nova falta.

### 12.4 Comportamento após reinício (processos Node novos sobre o mesmo SQLite, morte injetada no ponto exato — `tests/reinicio-contexto.test.mjs`)

| Onde o processo morre | Ao subir de novo |
|---|---|
| Entre a ferramenta (reserva já gravada) e a resposta | O evento volta à fila; a ferramenta **recusa** a segunda reserva ("JÁ tem…"); **uma** resposta; webhook reentregue não faz nada. |
| Resposta gravada (`pending`), na revisão por IA | A retomada a coloca em reenvio; a reescrita da revisão que cita serviço recusado é **recusada pela validação completa** (contexto recuperado do banco); sai a original, **uma vez**; estado final apaga o resumo. |
| Depois de o texto ter ido ao WhatsApp | Fica `unconfirmed`; **nunca** reenvia às cegas. |
| Pesquisa aguardando resposta | A nota é lida pelo código, sem modelo, gravada uma vez; "obrigada" seguinte só fecha. |
| Depois da transferência para a equipe | A Alice **não** responde (conversa da equipe). |
| Depois de remarcar | Continua **uma** reserva, horário novo; repetir a remarcação **não** reavisa a equipe nem apaga o controle de lembretes. |

### 12.5 Como validar as retomadas só com contatos de teste

1. Os contatos de teste (números da equipe) precisam **já existir como pacientes** da clínica (eles mesmos mandam uma mensagem antes). Nada é criado nem adivinhado.
2. `POST /api/clinics/lisboa-recontatos` (prévia, o padrão): `{ "modoRestrito": { "fluxo": "avaliacao_cancelada", "aprovadoPor": "…", "telefones": ["55…"], "limite": 1 } }` — confere os contatos (só o final do telefone aparece), o limite e mostra `previa`.
3. Só então `dryRun: false` (junto de `ativar`, se for o caso: a restrição é gravada **antes** de ligar). Acompanhar `previa`, o diagnóstico (`/api/automations/diagnostico`) e `FollowUpDispatch.runMode = restrito`.
4. Terminado o teste: `voltarAoNormal` (pedido explícito, com aprovador) — **só se a clínica aprovar o público normal**. Ligar/desligar nunca tira da restrição.
5. Para o convite de indicação: o mesmo, com `fluxo: "indicacao"` (precisa estar configurado).

### 12.6 Pendências de informação da Lisboa (nada foi presumido)

Link correto do Google + nome do estabelecimento; **política de recuperação do recontato** (recuperar? por quanto tempo? — hoje vale só o padrão antigo de 3 dias, nunca aprovado); horários dos recontatos (8h / a partir das 12h / segundas); lista de procedimentos de agendamento direto × avaliação; Protocolo do Olhar (cadastro/encaminhamento); texto e janela das retomadas; política do convite de indicação; aplicação das jornadas; decisão sobre `replyDelaySeconds` e o texto de preparo (item 12.1, #3).

### 12.7 Estado final

**Pronto para revisão; bloqueado para produção** por: (a) nada commitado/implantado; (b) as nove migrações precisam ser aplicadas e conferidas na ordem da seção 6; (c) as pendências de informação acima (em especial link do Google confirmado e política de recuperação); (d) a validação controlada com contatos de teste (seção 10 + 12.5). Os incidentes de 15 e 16/10 seguem **sem causa comprovada**.

### 12.8 Testes desta rodada

Comandos: `npx prisma generate` · `npm run build` (tsc, sem erros) · `node --test tests/*.test.mjs` (65 arquivos). Relógio da máquina: depois das 21h em São Paulo (UTC já no dia seguinte), o que expôs testes dependentes de data.

| Execução | Testes | Passaram | Falharam |
|---|---|---|---|
| Suíte completa, antes dos ajustes de teste desta etapa | 665 | 662 | 3 — todas **causadas por esta rodada** ou por data fixa: `jornadas-integradas` F (a política de recuperação deixou de ser 24 h implícita), `pesquisa-google-indicacao` (texto do diagnóstico; e um teste com **data fixa 18/10**, preexistente) |
| Suíte completa final (após corrigir) | **665** | **665** | **0** |

Testes novos: `migracoes-google` (4), `reinicio-contexto` (9, com processos reiniciados de verdade), 8 modo restrito + 4 recuperação/prévia/revalidação em `recontatos-retomadas` (total do arquivo: 49), 6 nota-com-equipe em `atendimento-integrado` (total: 13). `anuncios`: 8 cópias em paralelo, 8/8 com 26/26 (antes: 1 falha em 8). Não coberto: produção, OpenAI/UAZAPI/CE reais, modelo real, `replyDelaySeconds` e preparo pré-procedimento com reinício (12.1 #3).
