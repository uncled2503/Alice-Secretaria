# Entrega — lotes 1 a 4 (22–23/10/2026)

Estado de partida: branch `master`, commit `415cb08` (= `origin/master`). Sem `AGENTS.md` no repositório. Alterações locais sem commit (nada enviado, nada implantado, nenhuma mensagem real). Arquivos soltos não relacionados (`public/assets/*.jfif`, `hero.png`, `prisma/dev.db-*`) preservados e fora do escopo.

Ambientes de validação usados: **teste unitário** (funções puras) e **integração simulada** (banco SQLite temporário + WhatsApp/OpenAI por `fetch` falso + relógio controlado). **Nenhum item foi validado em integração real nem em produção** — por isso nada abaixo está como "CONCLUÍDO E VALIDADO".

## 1. Resumo das correções

**Lote 1 — agenda, confirmações e disparos**
- Regra final da Lisboa vira **configuração** de um motor geral (`reminders/confirmationPolicy.ts`): etapas com finalidade, dia da semana do atendimento, dias antes, janela, texto e dependência. Prévia por padrão; aplicar exige `aprovado: true`; nunca apaga regra (a antiga que se sobrepõe é **desligada**); valor não informado vira **pendência** (nada é criado).
- **Bug corrigido:** reposição de quem foi agendado depois da janela mandava o pedido de "amanhã" para atendimento **de hoje** (agendou 9h para 18h do mesmo dia).
- **Bug corrigido:** a ampliação automática de janela mandava o lembrete das 7h para quem agendou **depois** das 7h (nunca esteve na janela).
- Limites da reposição (início, **limite noturno**, antecedência "muito próximo") e **intervalo mínimo entre etapas** (qualquer regra, ex.: 16h59 + 17h00) agora são configuráveis por clínica (`DispatchPolicy`); sem configuração valem os padrões de antes (8h–20h, 120 min, 180 min).
- **Pedido inicial recuperado na etapa da cobrança:** quem nunca recebeu o pedido (job parado / falha recuperável) recebe às 17h o **pedido inicial**, não uma cobrança de algo que não recebeu. Incerto, barrado, bloqueado, número inválido e tentativas esgotadas **não** são reenviados.
- **Pedido de remarcação** de um horário identificado suspende confirmação/cobrança/lembrete daquele horário (ambíguo = nada marcado, a Alice pergunta qual). **Nova versão:** mudar o horário zera a confirmação e o pedido do horário antigo, em qualquer caminho (camada do banco).
- **Estado da resposta** por reserva: confirmou / pediu remarcação / cancelou (própria pessoa) / cancelada (outro caminho) / não respondeu / pedido incerto / pedido não enviado / sem pedido. Não responder nunca é cancelar.
- Reserva **sem procedimento**: texto neutro e **um** aviso à equipe por reserva.
- Carimbos de tentativa e de `ReminderSent` passam a usar o relógio da rodada (mesmo relógio da seleção e dos intervalos).
- **Central de Disparos — bug corrigido:** pesquisa e convite de indicação apareciam como "Retomada: avaliação sem fechamento". Agora cada fluxo tem o próprio tipo, e o **aviso de agendamento criado pelo painel/API** aparece na Central.

**Lote 2 — campanhas, preços e parcelamento**
- **Parcelamento em centavos** (`commerce/installments.ts`): máximo da empresa, parcela mínima, limite da oferta só reduz, Pix exclusivo e experiência não parcelável sem parcelas; divisão não exata com ajuste de centavos (R$ 397 em 3x = 132,34 + 132,33 + 132,33); textos "Em quantas vezes ficaria bom para você?" e de acima do limite. Integrado ao prompt da Alice e à conferência de valores citados.
- **Motor de ofertas** evoluindo a data especial existente: divulgação × validade comercial × datas do serviço; itens com preço/pagamento/parcelas; brinde e quantidade só se cadastrados; **origem** (todos/anúncio/orgânico; desconhecida = sem condição restrita; nunca mistura); **modo equipe** (Alice em silêncio para quem veio do anúncio listado); **versões + histórico**; aprovação só com cadastro completo e **sem conflito**; **condição combinada gravada na reserva** (vencer/alterar depois não muda o combinado); recesso lista reservas no período (nunca cancela); cartão-presente com comprador/presenteado/pago/crédito separados.
- **Calendário 2026 da Lisboa** como dado: substitui o anterior (rascunho antigo vira "substituída" com nota; **aprovado nunca é mexido**), com Lavieen 24/11 e Remoção 26/11; nada aprovado sozinho.

**Lote 3 — atendimento comercial**
- **Banco de respostas a objeções** (preço, medo, dor, tempo, indecisão, parcelamento) aprovado e versionado; a Alice só usa a aprovada, como base, sem acrescentar desconto/brinde/escassez/garantia.
- **Trocas proibidas** por empresa (Lisboa: Lavieen ≠ carboxiterapia; LEDterapia ≠ luz pulsada): prompt + remoção determinística da frase.
- "Refrescância": a Alice não repete mais o termo na pergunta de esclarecimento.

**Lote 4 — CRM e relatórios**
- **Agenda fraca 48–72h** por profissional com janelas livres reais e o que cabe nelas (sugestão; nada enviado); alerta só com limite configurado, uma vez por data.

## 2. Matriz de rastreabilidade

Legenda de ambiente: U = teste unitário; S = integração simulada; R = integração real; P = produção.

| # | Requisito | Implementação | Lacuna/conflito encontrado | Configuração necessária | Testes / evidência | Amb. | Status |
|---|---|---|---|---|---|---|---|
| 4.1 | 7h lembrete do dia, sem pedir confirmação, só ativos, só a versão atual | etapa `lembrete_do_dia` da política; seleção existente (status, versão, cancelado) | texto antigo diferente | aplicar política Lisboa | politica-final: semana simulada | S | IMPLEMENTADO AGUARDANDO TESTE |
| 4.2 | 8h–10h confirmação do dia seguinte | etapa `confirmacao_vespera` (janela 8–10; texto aprovado mantido) | cadastro atual 8–11 | aplicar política | politica-final | S | IMPLEMENTADO AGUARDANDO TESTE |
| 4.3 | 17h só para não confirmados, com evidência do pedido inicial; inicial que falhou é recuperado | etapa `cobranca_vespera` + `selectInitialRecovery` | antes: quem não recebeu o pedido ficava sem nada | aplicar política | politica-final: recuperação, incerto não reenvia | S | IMPLEMENTADO AGUARDANDO TESTE |
| 4.4 | Sábado: quarta 8–10, sexta 17h só não confirmados, sábado 7h com texto próprio; quarta substitui a sexta | etapas `sabado_*`; substituição por dia da semana já existente | — | aplicar política | politica-final: semana simulada | S | IMPLEMENTADO AGUARDANDO TESTE |
| 4.5 | Sexta: lembrete a TODOS os de sábado | etapa `sabado_lembrete_sexta` | **hora não informada** | hora/janela | prévia mostra pendência | U | DEPENDE DA LISBOA |
| 4.6 | Agendado/remarcado depois da janela; mesmo dia só mensagem pertinente | `isLateCatchUp` (data local) + ampliação só para quem existia na janela | 2 bugs corrigidos | — | politica-final: reposição | S | IMPLEMENTADO AGUARDANDO TESTE |
| 4.7 | Limite noturno e "muito próximo" explícitos | `DispatchPolicy.lateStartHour/lateEndHour/minLeadMin` | valores da Lisboa não informados | limites | politica-final: limite 18h × 20h | S | DEPENDE DA LISBOA |
| 4.8 | Intervalo mínimo entre etapas configurável | `stepMinGapMin` (qualquer regra) | — | opcional | politica-final: 180 × 30 min | S | IMPLEMENTADO AGUARDANDO TESTE |
| 4.9 | Quem confirmou: sem novos pedidos, mantém lembretes, resposta associada à reserva | existente + nova versão zera confirmação | — | — | politica-final + suites existentes | S | IMPLEMENTADO AGUARDANDO TESTE |
| 4.10 | Remarcação/cancelamento: suspender etapas incompatíveis, invalidar versão antiga | `rescheduleRequestedAt` + extensão do banco | — | — | politica-final: remarcação | S | IMPLEMENTADO AGUARDANDO TESTE |
| 4.11 | Estados confirmou/não respondeu/pediu remarcação/cancelou | `confirmationStatus.ts` + `GET /appointments/:id/confirmation-state` | não havia | — | politica-final (puro) | U | IMPLEMENTADO AGUARDANDO TESTE |
| 4.12 | Sem procedimento: texto neutro + alerta sem repetir | `missingProcedureAlertAt` | antes sem aviso | `notifyPhone` | politica-final | S | IMPLEMENTADO AGUARDANDO TESTE |
| 5.1 | Central cobre pesquisa, indicação, aviso de reserva do painel/API | adaptadores `fu:` corrigido e `ac:` novo | **pesquisa/indicação rotuladas como retomada** | — | lotes-3-4: Central | S | IMPLEMENTADO AGUARDANDO TESTE |
| 5.2 | Texto exato, id do provedor, estados, recuperação, lote, conciliação | entregue em 415cb08 (lote 1 anterior) | pós/pré/pesquisa não guardam texto/id: aparecem como "não registrado" | — | confiabilidade-disparos, disparos-aba | S | IMPLEMENTADO AGUARDANDO TESTE |
| 3.A–F | Itens A–F do pedido (Central, renovação, retorno, campanha, pós, saúde/migração) | corrigidos em 415cb08; conferidos no código nesta rodada | fallback do 9º dígito DESLIGADO por padrão | — | confiabilidade-disparos (18), health | S | IMPLEMENTADO AGUARDANDO TESTE |
| 6.1 | Auditoria do cliente do CE contra documentação oficial | não refeita nesta rodada | sem acesso à documentação/conta nesta execução | acesso | — | — | PENDENTE |
| 6.2 | Jornadas Suelen 12–21, Adriana 12–21, Talita 8–17 | `ajustarJornadasLisboa` (prévia) existente | aplicação em produção não feita | aprovação | lisboaConfigDiff mostra divergência | U | DEPENDE DA LISBOA |
| 6.3 | Telefones: sem testar variante enviando | fallback desligado por padrão (415cb08) | — | — | conexao-whatsapp | S | IMPLEMENTADO AGUARDANDO TESTE |
| 7.x | Recontatos, pré 48h, pós por procedimento, pesquisa, reativação, renovações, retomadas, pacotes | entregues em lotes anteriores (ver docs/checklist-mestre-entrega.md); sem mudança de regra nesta rodada | reativação mensal dia 20: não implementada | texto/público/hora da reativação | suites existentes | S | PENDENTE (reativação) / IMPLEMENTADO AGUARDANDO TESTE (demais) |
| 8.1 | Banco de objeções aprovado e versionado | `crm/objectionBank.ts` + rotas | não existia | textos da clínica | lotes-3-4 | S | DEPENDE DA LISBOA (textos) |
| 8.2 | Sabrina biomédica, Botox 50 UI, criolipólise placas | `lisboaFatos` (existente) | — | aplicar prévia | incidentes-lisboa-fatos | S | IMPLEMENTADO AGUARDANDO TESTE |
| 8.3 | Não oferecer Endolaser / luz pulsada no lugar de LED | `notOfferedServices` (existente) | — | — | conduta-comercial | S | IMPLEMENTADO AGUARDANDO TESTE |
| 8.4 | Não trocar Lavieen por carboxiterapia | `forbiddenSwaps` (novo, geral) | não existia | aplicar `lisboa-trocas-proibidas` | lotes-3-4 | U | IMPLEMENTADO AGUARDANDO TESTE |
| 8.5 | Clareamento/manchas não vira gordura/celulite/flacidez | `concerns.ts` (existente) | — | — | conduta-comercial | S | IMPLEMENTADO AGUARDANDO TESTE |
| 8.6 | Linguagem natural sem "refrescância" | `CLARIFY_FRESHNESS` | a pergunta repetia o termo | — | continuidade-comercial | U | IMPLEMENTADO AGUARDANDO TESTE |
| 9.x | Motor de ofertas (períodos, origem, conflito, versão, condição na reserva, modo equipe, sem escassez/brinde inventado) | `crm/offers.ts` | — | aprovar cada oferta | ofertas-parcelamento | S | IMPLEMENTADO AGUARDANDO TESTE |
| 10.x | Parcelamento Lisboa (10x, mín. R$100, limites por oferta) | `commerce/installments.ts` + `Clinic.installmentMax/MinCents` | antes: divisão em float sem mínimo | aplicar `lisboa-parcelamento` | ofertas-parcelamento | U | IMPLEMENTADO AGUARDANDO TESTE |
| 11.x | Calendário 2026 | `LISBOA_CALENDARIO_2026` (rascunho) | condições incompletas: VIP Week, Lavieen dez., Remoção, cartão-presente, validade dos "Days" | ver §7 | ofertas-parcelamento | S | DEPENDE DA LISBOA |
| 12.1 | Agenda fraca 48–72h + oportunidade por profissional | `crm/weakAgenda.ts` + `GET /reports/weak-agenda` | bloqueios só no CE não entram | `weakAgendaPct` | lotes-3-4 | S | IMPLEMENTADO AGUARDANDO TESTE |
| 12.2 | Origem, temperatura, motivo de perda, proposta, lista de espera, VIP, consentimento, comprovante, relatórios com denominador | lotes anteriores (415cb08) | — | — | fases-2-3 | S | IMPLEMENTADO AGUARDANDO TESTE |
| 12.3 | Auditoria semanal (amostra, erros, conflitos, sugestões) | não implementada nesta rodada | — | — | — | — | PENDENTE |
| 12.4 | Saldo de sessões do CE | o cliente do CE não traz saldo; controle interno auditável (415cb08) | limitação da integração | — | — | — | NÃO É POSSÍVEL (pelo CE) — alternativa: controle interno |
| 13 | Migrações reais sobre banco anterior com dados | 20261029 + 20261030 aditivas | — | — | lotes-3-4: migração | S | IMPLEMENTADO AGUARDANDO TESTE |

## 3. Arquivos e migrações

Novos: `src/reminders/confirmationPolicy.ts`, `src/reminders/confirmationStatus.ts`, `src/maintenance/lisboaPoliticaConfirmacoes.ts`, `src/commerce/installments.ts`, `src/crm/offers.ts`, `src/crm/objectionBank.ts`, `src/crm/weakAgenda.ts`, testes `politica-final-confirmacoes`, `ofertas-parcelamento`, `lotes-3-4`.
Alterados: `reminders/cron.ts`, `dispatch/policy.ts`, `dispatch/model.ts`, `dispatch/adapters.ts`, `dispatch/actions.ts`, `api/dispatches.ts`, `api/routes.ts`, `db/client.ts`, `ai/alice.ts`, `ai/conduct.ts`, `ai/productClaims.ts`, `crm/specialDates.ts`, `maintenance/lisboaConfigDiff.ts`, `server.ts`, `version.ts`, `public/disparos.js`; testes ajustados por mudança de requisito/data: `checklist-22-10` (usa o calendário antigo explicitamente para testar a mecânica), `health` e `conduta-comercial` (revisão de 23/10 e última migração).

Migrações (só aditivas, colunas anuláveis ou default constante, tabelas novas; nenhuma migração aplicada foi alterada):
- `20261029100000_confirmacoes_versao_etapas`: `Appointment.rescheduleRequestedAt`, `missingProcedureAlertAt`; `DispatchPolicy.lateStartHour`, `lateEndHour`, `stepMinGapMin`.
- `20261030100000_ofertas_parcelamento`: `Clinic.installmentMax`, `installmentMinCents`, `forbiddenSwaps`, `weakAgendaPct`; `Appointment.offerId`, `offerVersion`, `offerTerms`; colunas de oferta em `SpecialDate`; tabelas `SpecialDateRevision`, `GiftCard`, `ObjectionAnswer`.

Rotas novas: `GET /appointments/:id/confirmation-state`, `POST /appointments/:id/reschedule-request`, `GET|POST /clinics/lisboa-politica-confirmacoes`, `GET|POST /clinics/lisboa-parcelamento`, `GET|POST /clinics/lisboa-trocas-proibidas`, `GET /special-dates/recess-conflicts`, `GET /special-dates/:id/revisions`, `GET /installments/simulate`, `POST /gift-cards`, `GET|POST /objection-answers`, `POST /objection-answers/:id/approve`, `GET /reports/weak-agenda`. `PUT /special-dates/:id` passa pelo motor (versão/conflito/completude). `PUT /dispatches/policy/:kind` aceita os 3 limites novos.

## 4. Resultados dos testes

Ver a seção "Execução" no fim deste arquivo (preenchida com a saída real da rodada).

## 5. Prévia da configuração da Lisboa (nada aplicado)

- `GET /clinics/lisboa-politica-confirmacoes` — sobre o cadastro do seed atual: lembrete 7h (texto novo), confirmação 8–11 → 8–10, cobrança 16–17 → 17–18 (texto novo), quarta 8–10 criada (texto derivado "(sábado)"), sexta 17–18 criada, sábado 7–8 criado, **lembrete de sexta pendente**; limites pendentes.
- `GET /clinics/lisboa-parcelamento` — 10x / R$ 100.
- `GET /clinics/lisboa-trocas-proibidas` — "Lavieen > carboxiterapia; LEDterapia > luz pulsada".
- `POST /special-dates/prepare { dryRun: true }` — calendário 2026 (cria/atualiza/substitui; aprovado fica como está).
- `GET /clinics/lisboa-regras-diff` — consolida tudo acima (somente leitura).

## 6. Dependências exatas (não inventadas)

1. Hora (início e fim) do **lembrete de sexta** para os atendimentos de sábado.
2. **Limite noturno** e início da reposição; **antecedência mínima** ("muito próximo"); **intervalo mínimo entre etapas** (hoje: 8h–20h, 120 min, 180 min, padrões herdados).
3. Fim das janelas das 7h e das 17h: a prévia reaproveita a duração cadastrada (1h) — confirmar.
4. Condições incompletas: **VIP Week/Black November** (cada oferta), **Lavieen Day 16/12** (condição de dezembro), **Remoção 26/11 e 17/12** (condição vigente), **validade comercial** dos "Days" de um dia (até quando a condição pode ser fechada), período exato da Agenda Pré-Festas.
5. **Cartão-presente**: período de venda, validade do crédito, regras de uso e restrições.
6. **Retorno do recesso**.
7. **Link do Google** validado.
8. **Saldo de sessões** no CE: não disponível na integração atual (controle interno).
9. Textos do **banco de objeções**.
10. Limite da **agenda fraca** (`weakAgendaPct`), se a clínica quiser o alerta.
11. Aplicação cadastral (jornadas, fatos, conduta) e validação em produção.

## 7. Roteiro de validação controlada (sem envio em massa)

1. Fazer backup do banco; implantar; conferir `/health` (`revision` 2026-10-23-a, `lastMigration` 20261030100000_ofertas_parcelamento, `migrationsFailed` vazio).
2. `GET /clinics/lisboa-regras-diff` e `GET /clinics/lisboa-politica-confirmacoes`: conferir com a clínica; responder as pendências.
3. Aplicar com `POST ... { aprovado: true }` (política, parcelamento, trocas). Conferir em Lembretes que nada ficou duplicado (a resposta traz `conflitosDepois`).
4. Na Central de Disparos (dia seguinte): conferir 8h–10h, 17h só para não confirmados, aviso/pesquisa/indicação com tipo próprio; abrir o detalhe de 3 itens e conferir texto e estado.
5. Uma reserva de teste (número da equipe) agendada hoje para hoje: não deve receber pedido de "amanhã".
6. Aprovar UMA oferta (ex.: Ritual 26–31/10) com validade; perguntar no WhatsApp de teste o valor e o parcelamento; conferir que R$ 47 não parcela.
7. Só depois liberar as demais ofertas, uma a uma.

## 8. Implantação e reversão

- Implantação: push → no EasyPanel clicar **Implantar** (o webhook só sincroniza) → conferir `/health` e uptime. As migrações são aditivas e rodam no boot; em falha o modo de recuperação existente continua valendo.
- Reversão do código: implantar o commit anterior (`415cb08`). As colunas/tabelas novas ficam no banco sem uso (o código anterior as ignora); **não apagar** histórico de mensagens nem de envios. Reversão de configuração: as regras desligadas pela política continuam no banco (religar em Lembretes); `DispatchPolicy` volta ao padrão apagando os 3 valores; ofertas voltam a rascunho por `PUT /special-dates/:id`.

## 9a. Achado fora do escopo (não corrigido)

O teste de migração comparou o banco migrado com um banco criado direto do schema: a coluna `Clinic.closedOnHolidays` tem default **false** no banco (migração `20260916120000_clinic_closed_on_holidays`, mantido na reconstrução de `20261001182457`) e **true** no schema. Como o Prisma usa o default do banco no SQLite, clínica nova criada em produção nasce **sem** fechar nos feriados, ao contrário do que o schema diz. Não alterei: corrigir exige reconstruir a tabela `Clinic` (migração não trivial) e decidir qual default vale. Clínicas existentes não são afetadas (o valor delas já está gravado).

## 9. O que NÃO foi feito nesta rodada

Auditoria do cliente do CE contra a documentação oficial; reativação mensal (dia 20); auditoria semanal; fluxo de falta (no-show) próprio; múltiplos números; nenhuma validação real ou em produção.

## Execução (resultados reais desta rodada, 23/10)

- `npm run build` (tsc): sem erros.
- Testes novos: `politica-final-confirmacoes` 9/9, `ofertas-parcelamento` 7/7, `lotes-3-4` 5/5 (inclui as migrações 20261029 + 20261030 aplicadas sobre banco do estado anterior com dados; colunas/tipos/defaults/índices iguais aos do schema, exceto o achado 9a).
- Suíte completa (`node --test tests/*.test.mjs`, 1118 testes): **1111 passaram, 7 falharam**. Das 7:
  - 4 eram expectativas da regra anterior ou do calendário/schema anterior e foram atualizadas (justificativa abaixo); reexecutadas e passando: `cobranca-evidencia` P e Q, `fases-2-3` prévia Lisboa e migração 28.
  - 3 já falhavam antes desta rodada e dependem do relógio real (não relacionadas): conferência ao vivo no CE, recontato em atendimento humano parado, confirmação com/sem 9º dígito.
- Testes alterados e por quê (mudança de requisito, não de comportamento esperado):
  - `cobranca-evidencia` P/Q: a regra nova manda recuperar o pedido inicial que não saiu; os testes continuam exigindo que a **cobrança** nunca saia sem pedido aceito e que barrado/incerto não recebam nada.
  - `fases-2-3`: a prévia Lisboa agora usa a regra final (8h–10h; lembrete de sexta pendente); a migração 28 passa a aplicar também as posteriores antes de comparar com o schema atual.
  - `checklist-22-10`: a mecânica genérica é testada com o calendário antigo explícito (o novo tem teste próprio).
  - `health` e `conduta-comercial`: revisão de 23/10 e última migração.
- Corrigido depois da suíte: o tema das etapas na prévia comparativa cortava no primeiro ":" (ex.: "Sábado"). Teste da prévia reexecutado: passando.
