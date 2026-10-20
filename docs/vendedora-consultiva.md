# Vendedora consultiva: decisão do turno, conflitos corrigidos e roteiro de validação real

Revisão do código: `2026-10-19-m`. **Nada foi para produção** (sem commit, push, deploy nem envio real). Testes com OpenAI e WhatsApp simulados.

## 1. Onde nasce cada instrução comercial (mapa de fontes)

| Fonte | O que decide | Arquivo |
|---|---|---|
| Prompt fixo (postura, regras gerais) | tom, limites gerais | `src/ai/alice.ts` (`postureLine`, `sellerLine`) |
| Fluxo de venda (`analyzeFlow`) | intenção do turno (agendar, recusar, pensar, preço, info, já agendada…) e a "jogada" | `src/ai/salesFlow.ts` |
| Leitura do turno (**novo**) | o que a fala significa em relação à pergunta anterior: resposta curta, correção de objetivo, objeção, pedido de desconto, perguntas pendentes | `src/ai/turnReading.ts` |
| Situação | cancelar, remarcar, equipe negociando, agradecimento a mensagem automática; ordem exata + ficha | `src/ai/situation.ts` |
| Condução | queixa x região x procedimento escolhido, modo de agendamento (direto/avaliação/desconhecido), oferta sem cadastro, serviço não oferecido, trava das ferramentas | `src/ai/conduct.ts`, `src/ai/concerns.ts` |
| Procedimento pedido e horário escolhido | `identifyWanted`, `findChosenSlot` | `src/ai/bookingIntent.ts` |
| Validação final / revisão de envio | barra promessa não cumprida, oferta indevida, repetição | `replyGuard.ts`, `sendGate.ts`, `repetition.ts` |
| **Contrato de decisão do turno (novo)** | agrega tudo acima em UM objeto (só leitura): etapa, próxima ação, ferramentas permitidas, proibições, fatos e origem, perguntas pendentes | `src/ai/turnDecision.ts` |

O contrato **não decide nada novo e não é uma segunda máquina de estados**: lê o que `analyzeFlow`, `resolveSituation` e `planConduct` já decidiram. Serve de log técnico (`[decisao] …` por turno) e de superfície de teste.

## 2. Matriz: problema → reprodução → causa → correção → teste

Reproduções feitas com o código real do commit `e405310` (pasta separada compilada) e com o atual, via `scripts/explorar-decisoes.mjs` (puro: sem banco, sem OpenAI). "Antes/depois" abaixo é **simulado** (decisão do código, não texto de modelo).

| # | Problema | Antes (e405310) | Causa | Correção | Teste |
|---|---|---|---|---|---|
| 1 | "Não" a "já fez algum procedimento parecido antes?" | jogada: *"Descubra o que ela quer com UMA pergunta…"* (pergunta de novo) | resposta curta lida sem a pergunta anterior | `interpretAnswer` → `experience_none`; jogada: "nunca fez", acolhe e avança, sem repetir | `vendedora-consultiva`, `vendedora-e2e` |
| 2 | "Sim" a "quer que eu explique como funciona?" | mesma jogada de descoberta | idem | `accepts_info`: explica com o cadastro, **não** abre horários nem avaliação | `vendedora-consultiva` |
| 3 | "Não quero tratar gordura, quero clarear" | intenção `hesitate` ("vou pensar"), agenda fechada, sem explicar | `HARD_NO_RE` casava "não quero…" | `isGoalCorrection`: é correção de objetivo; mantém a região (virilha), troca queixa; não é recusa nem pedido de horário | `vendedora-consultiva` |
| 4 | "Vou pensar, mas quanto tempo dura?" | só acolhimento; a pergunta se perdia | jogada de `hesitate` não olhava perguntas | `turnObligations`: responder TODAS as perguntas antes de acolher; `schedule_recontact` continua permitido, agenda fechada | `vendedora-consultiva`, `vendedora-e2e` |
| 5 | "Achei caro" | jogada de descoberta ("pergunte o que quer tratar") | objeção não era lida | `detectObjection`: responder o impedimento com o aprovado; sem desconto, sem urgência, **sem transferir só por achar caro** | `vendedora-consultiva`, `vendedora-e2e` |
| 6 | Pedido de desconto | sem tratamento específico | — | proíbe prometer; equipe (`transfer_to_human`) com o pedido | idem |
| 7 | Objeção dita quando a condução já substituía a jogada (queixa/região/recusa) | objeção engolida | `replacesFlowMove` descartava a jogada inteira | `turnObligations` anexado como "PRIORIDADE NESTE TURNO" também nesse caminho | `vendedora-e2e` |
| 8 | Oferta anunciada **sem cadastro** | `salesFlow` mandava *"agende a AVALIAÇÃO NESSE MESMO dia e hora"* e a condução mandava transferir (instruções opostas na mesma jogada) | duas fontes contraditórias | removida a frase do fluxo; `analyzeFlow` recebe `unmappedOffer` e manda: não listar horários, não associar a outro procedimento, não agendar avaliação no lugar | `vendedora-consultiva` |
| 9 | Negar / experiência passada / relato de terceiro virava "escolha" de procedimento | `identifyWanted` lia todas as mensagens como desejo | mencionar = escolher | `stripNonChoiceSegments` (texto do anúncio entra como está; "já fiz e quero de novo" continua escolha) | `vendedora-consultiva` |
| 10 | Corrigir objetivo abria agenda ("quero clarear" = nomeou procedimento) | `schedule` + agenda aberta | `namesProcedure` | não vale quando é correção de objetivo | `vendedora-consultiva` |
| 11 | Textos que empurravam venda mesmo com recusa/agradecimento | *"Cada mensagem tem UM objetivo: levar ao próximo passo"*, *"NÃO se despeça… perde a venda"*, *"feche com UMA pergunta"* | prompt/jogada com meta única de conversão | reescritos: responder primeiro; o próximo passo pode ser explicar, tirar dúvida, mostrar horários ou aguardar; pergunta de fechamento só se ajuda | `vendas` (assertiva trocada: comportamento, não frase) |
| 12 | Recontato para quem recusou claramente | dependia só do juiz de IA | sem trava determinística | `isExplicitRefusal` na última fala: nem consulta o juiz; "vou pensar"/adiamento seguem como antes | `recontato-contexto` |

### Itens que já estavam corretos e foram **mantidos** (e testados no cenário de vários turnos)
"amanhã não, quinta pode" continua o agendamento; "sim" a "quer ver um horário?" aceita; nome completo conclui o agendamento em andamento; "obrigada, mas qual é o endereço?" de quem já agendou é respondido; "já tenho horário, quero marcar outro procedimento" não é bloqueado; só a região não indica procedimento; tom de pele não é queixa; modo desconhecido/avaliação/serviço não oferecido seguem a condução.

## 3. Operacional (itens A, B, C)

| Item | Antes | Agora | Teste |
|---|---|---|---|
| **A) Confirmação de agendamento criado fora da conversa** (painel / API) | uma tentativa; falha temporária = paciente nunca sabia | tabela `AppointmentConfirmation` (1 linha por agendamento+horário); falha temporária → `retry` + recuperação a cada 5 min (janela 6 h, teto 5 tentativas); incerto (timeout) → `unconfirmed`, nunca reenvia às cegas, equipe avisada 1×; **revalida antes de cada envio** (existe, confirmado, mesmo horário, futuro, não pediu para sair, não é reserva sem procedimento); cancelou/remarcou → `superseded`; sem varredura do histórico; A→B→A reabre A | `confirmacao-pos-auditoria` |
| **B) Pós-procedimento** | linha gravada **antes** do envio e tratada como enviada; queda no meio = perda ou duplicidade | `PostProcedureSent` com estado (`reserved/sending/sent/unconfirmed/retry/vetoed/blocked/duplicate/failed_permanent`, `legacy` para o que já existia); `sending` marcado imediatamente antes do provedor (`beforeProvider`); reserva velha sem tentativa → recupera; `sending` velho → `unconfirmed`; duas rodadas simultâneas → 1 envio; teto de 6 tentativas; registros `legacy` e atendimentos fora da folga de 3 dias nunca reabrem | idem |
| **C) Auditoria** | "enviado" para registro aceito; pós/aniversário antigos contavam como envio | categorias `aceito_pelo_provedor` (nunca "entregue"), `sem_evidencia` (registro antigo ambíguo, inclusive aniversário anterior a 19/10), `adiado` (retry), `a_conferir` (sending); novo fluxo "Confirmação de agendamento criado fora da conversa"; texto explicita que não há recibo de entrega e que ausência de registro **não** prova que o job não rodou (isso só o resumo da rodada prova) | idem + `lisboa-fluxos` |

Migração nova: `20261022100000_pos_e_confirmacao_confiaveis` (aditiva; nenhuma migração aplicada foi alterada). O prefixo de data vem **depois** da última migração existente (`20261021…`) para manter a ordem.

## 4. Impacto em chamadas e contexto

- **Nenhuma chamada nova à OpenAI**: a leitura do turno é código puro. Teste: um turno comercial normal continua sendo 1 chamada principal (`vendedora-e2e`).
- Contexto do prompt: +0 a ~700 caracteres por turno **só quando** há objeção, pergunta pendente ou resposta curta interpretada (a jogada específica *substitui* a genérica, não se soma); nos demais turnos o tamanho é o mesmo. A economia de tokens da etapa anterior (contexto pertinente, reescritas consolidadas, segunda leitura seletiva) não foi tocada.
- Recontato: sem chamada extra; a trava de recusa **reduz** consultas ao juiz.

## 5. Dependem de cadastro / decisão da clínica (não inventados)

- Condições de pagamento, descontos, parcelamento: a Alice só diz o que estiver em FAQ/mensagens/regras da clínica; sem isso diz que a equipe apresenta as condições. **Nenhuma política de desconto foi criada.**
- Duração, número de sessões, cuidados, como funciona: só do cadastro do procedimento (`description`, `benefits`, FAQ). Procedimento sem descrição fica sem resposta específica (a Alice confirma com a equipe).
- Modo de agendamento por procedimento (`bookingMode`) e ofertas anunciadas sem cadastro (`unmappedOffers`): continuam sendo decisão da clínica.
- Prova social, fotos e condições: só de fontes aprovadas (galeria/FAQ); nada novo foi criado.
- Recontatos: cadências, janelas e retomadas desligadas **não** foram alteradas; o texto do recontato continua sendo o da regra cadastrada.

## 6. Riscos e reversão

- Reversão da leitura do turno sem mexer no código: `ALICE_TURN_READING=off` (volta à jogada genérica anterior e à leitura anterior do procedimento). Não desfaz: o contrato/log `[decisao]`, a remoção da frase conflitante da oferta sem cadastro, a correção de `namesProcedure` e a trava de recusa do recontato (que são correções, não comportamento novo de venda).
- Confirmação externa / pós / auditoria: reverter = voltar o commit (a tabela e as colunas novas são aditivas e ignoradas pelo código antigo; linhas `legacy` e `AppointmentConfirmation` não atrapalham).
- Risco conhecido: o texto final é do **modelo**; o código garante o que ele pode fazer e o que não pode, não a qualidade da frase. Isso só a validação real mostra (seção 7).
- Risco conhecido: a leitura de objeção/resposta curta é por frases (regex em português). Fala fora do padrão cai na jogada genérica anterior (comportamento de antes), nunca numa conclusão inventada.

## 7. Roteiro de validação REAL (contatos de teste autorizados, clínica de teste)

Não executado. Para cada cenário: conferir o texto enviado, a linha `[decisao]` no log e o que ficou gravado.

1. Lead de anúncio pergunta preço → valor pela regra; sem horário.
2. Escolhe procedimento direto → só horários dele; sem avaliação.
3. "Interno de coxa" → pergunta a queixa; sem indicar procedimento.
4. "Sou morena e quero tratar gordura" → gordura, nunca clareamento.
5. Meio da conversa: "não quero tratar gordura, quero clarear" → troca o objetivo, mantém a região.
6. "Não" a "já fez antes?" → trata como primeira vez; não repete a pergunta.
7. "Sim" a "quer entender como funciona?" → explica; não oferece horário.
8. Objeções: preço, medo, distância, horário → responde o impedimento com o cadastrado; sem desconto/urgência inventados.
9. "Tem desconto?" → equipe, sem prometer.
10. "Vou pensar, mas quanto tempo dura?" → responde a duração e respeita o "vou pensar".
11. Nome completo para fechar o agendamento → agenda; confirma só depois do sucesso da ferramenta.
12. Várias perguntas numa mensagem → todas respondidas.
13. Confirmação de presença / cancelar / remarcar com agenda real.
14. Paciente com horário pede outro procedimento → agenda o novo.
15. Currículo / fornecedor / cobrança → equipe, sem venda.
16. Oferta anunciada sem cadastro → equipe; sem avaliação no lugar.
17. Conteúdo fora do contexto inicial (FAQ específica) → consulta a ferramenta de conteúdo antes de dizer que a clínica não oferece.
18. Equipe assume no meio → a Alice não interfere; volta só pela regra de retorno.
19. Recontato com memória antiga → sem recomeço; recusa clara respeitada.
20. Falha de ferramenta (horário indisponível) → sem falsa confirmação.
21. Confirmação externa: criar agendamento no painel com o WhatsApp da clínica desconectado → após reconectar, a confirmação sai uma vez; cancelar antes → não sai.
22. Pós-procedimento: atendimento concluído de teste → estado `sent`; desconectar → `retry`; reconectar → sai 1 vez.

## 8. Não validado em produção (explícito)

Nenhuma taxa de conversão foi medida nem prometida. Nada acima foi observado com lead real. Os "antes/depois" são decisões do código sobre conversas simuladas.
