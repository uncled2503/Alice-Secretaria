# Matriz do checklist de 22/10/2026 (PDF "Checklist_MKT_Alice_Atualizado_22-10-2026")

Situação: **local, sem commit/deploy desta etapa, nenhum envio real, produção intocada.** O PDF contém requisitos e relatos: **não** foi tratado como prova de implementação nem de causa.

**Regra de status usada (do próprio PDF):** *Concluído e validado* exige conversa real e/ou log da automação em produção. **Nenhum item abaixo está "Concluído e validado"**: o que existe é código + testes simulados (banco isolado, relógio controlado, WhatsApp/CE simulados). Teste verde e build **não** são validação operacional.

Legenda: **IAT** = Implementado, aguardando teste (real) · **ER** = Erro recorrente (relato reiterado; correção implementada, aguarda a evidência do roteiro) · **PEND** = Pendente · **DC** = Depende da clínica.

Hotfix da migração: `docs/hotfix-migracao-disparos.md` (fez-se primeiro; a recuperação em produção depende de a clínica/operador executar o procedimento; **não verificado em produção**).

---

## 1. Resumo executivo (§1)

| Item | Regra atual (onde) | Divergência encontrada | Alteração | Teste | Evidência | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Confirmações automáticas (20–22/10) | ciclo `reminders/cron.ts` + controle persistente `ReminderDispatch`; janela 8–9h por data local; ampliação autorizada | causa real em produção **não comprovada**; faltavam rastro de envio, id do provedor, fila sem starvation, rodada por clínica | aba Disparos, ledger com destino/id/estado, rodada paralela por clínica, alerta de capacidade, relatório somente leitura `scripts/disparos-lisboa.mjs` | `confirmacoes-sabado-prazo`, `confirmacoes-agenda`, `disparos-envio`, `disparos-aba` | simulada; **faltam 2 dias reais** | **ER** |
| Recontatos de leads | `crm/followup.ts` (cadência 4h…180d, `nextDayHour`), controle `FollowUpDispatch`, exclusão de não-pacientes | recontato de parceria ocorreu porque a exclusão era só por texto do motivo de handoff | classificação **persistente** de não-paciente também no recontato (`contactKind`) | `recontatos-retomadas`, `checklist-22-10` | simulada | **ER** |
| Aniversariantes | `reminders/birthday.ts` | linha apagada em falha, `duplicate` contava como enviado, reserva abandonada sempre "incerta", rodada parava no 1º erro, sem janela estendida | reescrito (estados rastreáveis, erro por pessoa isolado, janela ampliada ≤21h, alerta) | `lisboa-fluxos`, `disparos-envio` | simulada; **faltam 3 dias reais** | **ER** |
| Agendamento pela Alice | só afirma "agendado" com reserva real (`ce-confirma-so-depois-do-ce`, `conduct.ts`, `replyGuard`) | relato de 21/10 sem causa comprovada | nenhuma nova nesta etapa | `ce-escrita-reconciliacao`, `incidentes-lisboa-e2e`, `continuidade-comercial-e2e` | simulada | IAT |
| Perfil comercial | `vendedora-consultiva`, `conduct.ts`, revisor | **conflito**: revisor reescrevia convite para avaliação "porque não pediu agenda" | ver §7 | `checklist-22-10` | simulada | IAT |
| Integração Clínica Experts | `clinicaexperts/*`, escrita com reconciliação, lembrete confere ao vivo | falhas de leitura/execução relatadas; **sem acesso ao CE real** | prévia/saúde da agenda; nada novo | `ce-*`, `espelho-ce` | **depende de comparação real (§15)** | **PEND** |
| Pós-procedimento | `reminders/postProcedure.ts`: `lateSendUntilHour` por regra; só quem venceu há ≤6h | config só preparada para Lavieen | opção `todosProcedimentos` já existe; falta **aplicar** (prévia + aprovação) | `pos-apos-fechamento` | simulada | IAT / DC |
| Rotina de sábado | `reminders/policy.ts` (`weekdays`), regras de quarta/sexta/sábado | — | — | `confirmacoes-sabado-prazo` | simulada | IAT |
| Confirmação do dia seguinte | idem, janela 8–9h por data local | — | — | idem | simulada | IAT |
| Recontato do dia seguinte | `nextDayHour` + janela 8–10 (`followupSchedule.ts`) | regra real da clínica no banco **não conferida** | previa por `lisboaRecontatos` | `recontatos-retomadas` | **conferir regra cadastrada** | IAT / DC |
| Não-pacientes / parcerias | detecção por frase forte (`jobSeeker.ts`) + silêncio | **não persistia**; automações não enxergavam | `Patient.contactKind*` + gate em `sendText` + filtros + revisão pela equipe (ver §9) | `checklist-22-10` | simulada | IAT |

## 2. P0 (§2)

| Item | Regra atual | Divergência | Alteração | Teste | Evidência | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Confirmação de hoje – cobertura completa | cobertura por tipo na aba Disparos (esperado × tentado × aceito × entregue, motivo por paciente); alerta com quantidade e motivo | percentual não declarado 100% com fonte incompleta | aba **Disparos** | `disparos-aba` | relatório real do dia pendente | ER |
| Dia seguinte até 9h | `sendEndHour=9`, `dayOffset=1`, por data local; já confirmou não recebe; criado/remarcado após 9h → reposição no mesmo dia; ampliação só com causa operacional | — | — | `confirmacoes-sabado-prazo` | 2 dias reais pendentes | ER |
| Integração CE | ver §1 | — | — | — | comparar 10+ (roteiro 1) | PEND |
| Aba/controle de disparos | `src/dispatch/*`, `public/disparos.js`; recuperação em fila **idempotente**, revalidada | produção ainda sem a migração (hotfix) | hotfix + aba | `disparos-aba`, `migracao-disparos` | print real pendente | IAT |
| Recontatos de leads | ver §5 | — | persistência de não-paciente | `recontatos-retomadas` | conferência por regra pendente | ER |
| Recontato do dia seguinte 8–10h | ver §1 | regra cadastrada não conferida | — | — | teste com contatos do dia anterior (roteiro 9) | IAT |
| Aniversariantes | ver §1 | — | reescrita | `disparos-envio` | 3 dias reais | ER |
| Agendamento real | ver §1 | — | — | — | e2e (roteiro) | IAT |
| Barreira/estabilidade | disjuntor **por clínica**; falha isolada por resposta; confirmações não passam pelo revisor de resposta | — | — | `disjuntor-lembretes`, `reliability` | teste simultâneo real pendente | IAT |

## 3. Confirmações (§3) — regra consolidada

| Regra do PDF | Onde está | Status |
| --- | --- | --- |
| Nenhuma elegível fica sem confirmação por falha silenciosa | `ReminderDispatch` (estado por item), aviso de cobertura, aba Disparos | IAT |
| Janela 8–9h do dia anterior, data do atendimento, **não 24h** | `ReminderRule.dayOffset/sendHour/sendEndHour` (`cron.ts`, `selectReminderCandidates`) | IAT |
| Quem confirmou não recebe novo pedido | `skipsConfirmedPatient` / `resendIfConfirmed=false` | IAT |
| Criado/remarcado após 9h → catch-up no mesmo dia (sem acumular etapas) | `isLateCatchUp`, `LATE_QUIET_MS` | IAT |
| Cancelados não recebem; remarcados param no horário antigo | revalidação "estado fresco" antes do envio; chave por **versão do horário** | IAT |
| Reserva sem procedimento → confirmação neutra de data/hora | `appointmentMessages.ts` (modelo sem procedimento) | IAT (`jornadas-integradas` D) |
| Dia da semana derivado do sistema, não da IA | lembretes são **modelo + variáveis**; `{data}/{hora}` calculadas no fuso da clínica (`crm/template.ts`) | IAT |
| Horário enviado = horário do CE | conferência ao vivo antes de enviar (`lembrete-confere-no-ce`) | IAT (depende do CE) |
| Alerta com quantidade e motivo | `reportConfirmationGaps` + `dispatch_capacity_risk` | IAT |
| **Preservar** ampliação autorizada, sem virar horário normal | `dispatch/policy.ts` (causa operacional, ≤21h, mesmo dia local); `extendedReason` distingue | IAT |

## 4. Sábado (§4)

| Momento | Regra atual | Status |
| --- | --- | --- |
| Quarta 8–9h: confirmar sábado | regra `weekdays=6`, `dayOffset=3`, 8–9h | IAT |
| Sexta: lembrete para **todos** (inclusive confirmados) | regra `purpose=lembrete`, `weekdays=6`, `dayOffset=1`; **não** usa "sexta só para não confirmados" | IAT |
| Sábado: lembrete do dia sem novo pedido | regra de lembrete `dayOffset=0` | IAT |
| Proteções / substitui conflitantes | `overridingRule` (a específica do dia substitui a genérica); horários de sexta/sábado vêm **do cadastro** (nada inventado) | IAT / DC (conferir horários cadastrados) |
| Criado depois da quarta, sem etapas acumuladas | cada etapa só se ainda estiver na sua janela | IAT |

Teste: `confirmacoes-sabado-prazo` (17 testes simulados).

## 5. Recontatos (§5)

| Regra | Onde / divergência | Status |
| --- | --- | --- |
| Cadência 4h,1d,3,7,15,45,60,120,180 | `FollowUpRule` por clínica (regra cadastrada, **não hardcoded**): `lisboaRecontatos.ts` mostra a matriz real; **conferir no banco da Lisboa** | IAT / DC |
| 1 dia: manhã seguinte 8–10h | `nextDayHour` + `sendWindowStart/End` (`followupSchedule.ts`) | IAT |
| Evento que inicia a cadência | **a última mensagem da PESSOA** (`cycleKey = lastPatientMessage.createdAt`); criação do lead sem mensagem não inicia; nova mensagem da pessoa reinicia o ciclo (documentado em `followup.ts`/`followupSchedule.ts`) | IAT |
| Uma mensagem por etapa; não acumular | `FollowUpDispatch` + `MAX_OVERDUE_MS` + `MIN_GAP_BETWEEN_AUTOMATED_MS`; passou do prazo = expira | IAT |
| Revalidar resposta/agendamento/humano/fechamento/opt-out/classificação | `recheckBeforeSend`; **classificação agora persistente** (`contactKind`) | IAT |
| Não recontatar não-paciente | `contactKind` no filtro + gate no envio | IAT |
| Conferência diária previstos/enviados/retidos/falhos | `AutomationRun` por rodada + `previewFollowUpRound` | IAT |
| Recuperar com lista antes e revalidar | `followupRecovery.ts` (prévia + execução controlada) | IAT |
| Mostrar regra antiga ainda ativa/sobreposição | `conferirRecontatosLisboa` → `conflitos` | IAT |

## 6. Pós-procedimento (§6)

| Regra | Onde | Divergência / alteração | Status |
| --- | --- | --- | --- |
| Pós após expediente para **todos** os procedimentos | `PostProcedureRule.lateSendUntilHour` (21–24h) | existe por regra; a configuração preparada era só Lavieen. `configurarPosDepoisDoFechamento({todosProcedimentos:true})` já cobre todos: **prévia + aplicar com aprovação** (não aplicado) | IAT / DC |
| Evidência de concluído + término real | `Appointment.completedAt` (grava desde o deploy do pós), fim da reserva (`reservationEndMs`) | atendimentos anteriores ao campo: "sem evidência" no diagnóstico | IAT |
| Intervalo e texto cadastrados | `postDueAt`, texto da regra | — | IAT |
| Avaliação só com regra própria | filtro de avaliação em `postProcedure.ts` | — | IAT |
| Sem adiar para a manhã por trava genérica | `postHourGate`: padrão nada 21h–7h; **com `lateSendUntilHour` sai até o limite** | — | IAT |
| Exceção noturna só para pós (não campanha/aniversário/recontato) | `lateSendUntilHour` só em `PostProcedureRule`; ampliação do aniversário é outro mecanismo (≤21h) | — | IAT |
| Pós oportuno ≠ recuperação histórica na madrugada | `POST_LATE_FRESH_MS` (6h): depois do fechamento só o que venceu há ≤6h; nada de lote antigo | — | IAT |

## 7. Perfil comercial (§7) e Comercial (item 10 das regras)

| Item | Regra atual | Divergência | Alteração | Teste | Status |
| --- | --- | --- | --- | --- | --- |
| Convite contextual para avaliação não é proibido por pedir preço/informação | `conduct.ts` (`forbidEvaluationOffer` só em casos específicos) | **revisor de IA** (`REPLY_REVIEW_SYSTEM` item 2 e `GATE_SYSTEM` item 4) mandava reescrever/barrar convite "porque não pediu agenda" | os dois textos corrigidos: convite ≠ listar horários ≠ criar reserva; pedir preço/informação **não** proíbe o convite | `checklist-22-10` (COMERCIAL/REVISOR) | IAT |
| Veto de **aviso de agendamento** "porque a pessoa já tem horário" | — | categoria `ja_tem_horario` valia para avisos ligados a horário (absurdo: o aviso é sobre o horário) | `vetoStands(..., kind)`: para `agendamento/lembrete/preparo` essa categoria **não** barra; outros vetos (opt-out, divergência, equipe) continuam; `AUTOMATION_PURPOSE` diz ao revisor | idem | IAT |
| Responder dúvidas, respeitar restrições, avançar pela etapa; sem nova descoberta | `salesFlow`, `turnDecision`, `bookingIntent` | — | — | `vendedora-consultiva`, `continuidade-comercial` | IAT |
| Só afirmar agendamento com reserva real | `replyGuard` (`claims_booking`), `ce-confirma-so-depois-do-ce` | — | — | `incidentes-lisboa-e2e` | IAT |
| Preservar casos dos prints anteriores | suíte `continuidade-comercial*`, `conduta-comercial` | — | — | verdes na última suíte completa (ver §Resultado) | IAT |
| Demais bullets do §7 (comercial, consultiva, uma pergunta, após agendar não vender, não inventar) | `alice.ts` prompt + `conduct.ts` + guards | estabilidade **não** provada (PDF: oscila no fim do dia) | — | simulados | **ER** (PDF) |

## 8. Procedimentos, informações e agenda (§8)

| Item | Regra atual | Status |
| --- | --- | --- |
| Perguntas informativas antes de horários | `conduct.ts`/`salesFlow` | IAT |
| Não inventar valores/UI/fotos/formação | `claimsOutsideFamilies`, `price_unproven`, `lisboaFatos` | IAT |
| Sabrina biomédica; "Dra." só tratamento | `cleanLisboaRules`/seed (Sabrina e Amanda "Dra."; esteticistas sem) | IAT |
| Duas pessoas = atendimentos separados | `Attendee` (acompanhante), pedir nome completo/telefone | IAT |
| Disponibilidade ≠ "tem vaga" | `bookingIntent`/`conduct` | IAT |
| **Jornadas** Suelen/Adriana 12–21h, Talita 8–17h | `maintenance/lisboaJornadas.ts` (prévia; rota admin). Log de produção mostrou **herança 08–21h = jornada não aplicada** (`scheduling/eligibility.ts`) | **PEND → aplicar com prévia** (não aplicado; dias/intervalos não inventados: só horas) |
| Clareamento sem gordura/celulite | `concerns.ts`/relevância | IAT |
| Luz pulsada não citada | `notOfferedServices` + `not_offered` | IAT |
| Fotos só aprovadas/vinculadas | `send_procedure_photos` | IAT |

## 9. Não-pacientes (§9 / regra 5)

| Regra | Alteração desta etapa | Teste | Status |
| --- | --- | --- | --- |
| Parceria, currículo, fornecedor, influenciador, cobrança, administrativo **não entram no fluxo de paciente** | `Patient.contactKind` (`paciente`/`nao_paciente`) + `contactKindDetail` (6 tipos) + `Source` (alice/equipe) + `Evidence` (trecho) | `checklist-22-10` | IAT |
| Classificação persistida e **compartilhada** atendimento ↔ automações | gate em `sendText` bloqueia `recontato/retomada/indicacao/pesquisa/aniversario/renovacao/campanha`; filtros em recontato, aniversário, campanha, pesquisa e retorno automático; aba Disparos mostra "não-paciente" | idem | IAT |
| Encaminhar à equipe, **sem conversa automática interminável** | contato já classificado → `transfer_to_human` em silêncio, sem resposta | idem | IAT |
| Não classificar por **palavra isolada**; revisão pela equipe; mudança de contexto | detecção só por frases fortes; `PATCH /patients/:id` + seletor "Tipo de contato" no cadastro (equipe prevalece, fica no Diário); classificação da Alice **reverte** se a pessoa traz pedido clínico claro | idem | IAT |
| Lembrete/confirmação/pós de quem tem agendamento **não** é bloqueado | gate só nos tipos comerciais | idem | IAT |

## 10. Disparos promocionais (§10 / regra 6)

| Regra | Alteração | Teste | Status |
| --- | --- | --- | --- |
| Configuração **por campanha** de atendimento humano | `BroadcastCampaign.humanAfterReply` + janela `humanReplyWindowHours` (padrão 72h); checkbox no formulário; contador de respostas | `checklist-22-10` | IAT |
| Vincular resposta à campanha **com evidência**; ambiguidade não inventa atribuição | `BroadcastRecipient(status=sent, sentAt)` dentro da janela; `repliedAt`; ≥2 campanhas → "atribuição ambígua" para a equipe, sem citar condição | idem | IAT |
| Ao responder: pendência/alerta + controle humano **antes** da resposta automática; sem corrida webhook × Alice × equipe | hook na fila do webhook (por clínica, sequencial) antes de `generateReply`; entrega da Alice já confere `humanTakeover` de novo | idem (função); fila do webhook por inspeção | IAT |
| Retorno por inatividade não desfaz | `isCampaignHumanHandoff` em `humanReturn.ts` | idem | IAT |
| Não mandar valor não cadastrado; não misturar preços | a Alice **não responde** nessas conversas; datas especiais sem condição dizem que não há condição (item 14) | `checklist-22-10` | IAT |

## 11. Aniversariantes (§11)

| Regra | Status |
| --- | --- |
| Rodar na janela aprovada; texto/cortesia vigentes; log encontrados/elegíveis/enviados/falhas | IAT (`AutomationRun` + aba Disparos por dia) |
| 20 e 21/10 não enviou | **ER** — causa não comprovada; a aba/relatório mostram, por pessoa, o motivo registrado ou "sem evidência" |
| Só dar baixa após **3 dias consecutivos** reais | **PEND** (roteiro 7) |
| Aniversariantes só no CE (não importados) | **PEND/DC**: só prévia mascarada (`notInAliceSample`); importação **não** implementada |

## 12. Pesquisa / Google / indicação (§12 / regra 7)

| Regra | Onde | Status |
| --- | --- | --- |
| Máx. 1 pesquisa/15 dias por paciente | `reminders/nps.ts` | IAT |
| Nota positiva → agradecer + **só** link correto do Google | proteção sem link configurado (`lisboaGoogle`); **link correto da Lisboa pendente** | IAT / DC |
| Indicação em mensagem separada, após experiência positiva | `indicacao` (desligada por padrão) | IAT |
| Nota baixa → equipe, sem pedir avaliação pública | `nps.ts` | IAT |
| Não confundir números com nota | nota lida pelo código com contexto | IAT |
| Durante atendimento humano: registrar a nota sem a Alice interromper | `noteSurveyWhileHumanOwned` (`uazapi/client.ts`) | IAT |

## 13. "Corrigidos 19–20/10" — todos continuam IAT (aguardando teste real)

Queixa antes de indicação · clareamento · continuidade após nome · agradecimento sem nova oferta · conferência de profissional/jornada/duração · só confirmar após sucesso do sistema · remarcação sem duplicar · reserva sem procedimento · pesquisa 15 dias · link Google · logs de envio (aba Disparos). Evidência: suítes simuladas listadas na seção Resultado. **"Currículo/fornecedor/parceria" fica IAT e NÃO concluído** (como o PDF manda): agora com classificação persistente (§9).

## 14. Campanhas e datas (§14 / regra 9)

Datas e serviços **extraídos do PDF** (nada além): 22/10 HIPRO Day · 27/10 Remoção de tatuagem, micropigmentação e Black Peel · 10/11 HIPRO Day · 17/11 Lavieen Day · 24/11 Remoção de tatuagem · 08/12 HIPRO Day · 16/12 Lavieen Day · 17/12 Remoção + Black Peel · 23/12 Início do recesso.

| Ponto | Alteração | Status |
| --- | --- | --- |
| Cadastro/prévia com validade e identificação | tabela `SpecialDate` (`kind`, `name`, `startsOn`, `endsOn`, `services`, `conditionText`, `status`); `POST /special-dates/prepare` (prévia/criação idempotente como **rascunho**); `PUT /special-dates/:id` (completar e **aprovar**) | IAT |
| Não inventar preço, desconto, vaga, texto, retorno | rascunho nasce **sem** condição, validade e retorno; a Alice só conhece data **aprovada e vigente**; sem condição → diz que **não há condição cadastrada**; recesso sem retorno → "não invente" | IAT (`checklist-22-10`) |
| Não manter urgência de campanha vencida | fora da vigência (`endsOn`, ou só o próprio dia) a data **some** do prompt | IAT |
| Campos faltantes = dependência | **DC**: condição/valor de cada campanha, validade, vagas, texto promocional, **data de retorno do recesso**, aprovação de cada data | **DC** |

## 15. Bateria obrigatória → ver `docs/checklist-22-10-roteiro.md`

Todos os 24 testes do §15 estão no roteiro com procedimento, evidência esperada e status **PEND (execução real)**. Nenhum foi executado em produção.

## Resultado dos testes simulados desta etapa

- `tests/checklist-22-10.test.mjs`: 5 testes (não-paciente ×2, campanha com humano, datas especiais, revisor/veto).
- `tests/migracao-disparos.test.mjs`: 10 testes (SQL real do hotfix). `tests/disparos-envio|aba`: 16 testes.
- Suíte completa e falhas preexistentes (dependem da data/relógio): ver relatório de entrega.

## Itens que NÃO foram alterados nesta etapa (e por quê)

- Integração CE (leitura/execução): sem acesso ao CE real; precisa do roteiro 1.
- Aplicar jornadas da Lisboa, pós para todos e regras de recontato: são **atualizações seletivas com prévia e aprovação** (rotas admin existentes); nada foi aplicado em produção.
- Importação de aniversariantes do CE; link correto do Google; textos/condições das campanhas: dependem da clínica.
