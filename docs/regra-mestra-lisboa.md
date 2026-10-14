# Regra Mestra da Alice – Lisboa Beauty Center

Versão 1 · 14/10/2026 · **PROPOSTA para aprovação da Lisboa.** Nada deste documento foi aplicado na produção, exceto o que já foi aprovado na limpeza do treino (botão "Limpar regras em conflito").

Este documento tem 3 partes:

1. **Como uma regra chega até a Alice hoje** (as 5 camadas) e qual deve ser a fonte de cada tipo de regra.
2. **A Regra Mestra por tema**: uma regra principal por comportamento, a fonte única dela e o que deve sair dos outros lugares.
3. **Decisões que só a Lisboa pode tomar** e o plano de aplicação.

---

## 1. Como uma regra chega até a Alice

Hoje o mesmo comportamento pode ser controlado em até 5 lugares ao mesmo tempo:

| Camada | Onde fica | O que controla | Quem edita |
|---|---|---|---|
| **A. Prompt fixo** | `alice.ts` (`buildSystemPrompt`) | Texto montado a cada mensagem. Parte depende de chaves da clínica (`quotePrices`, `aliceCanBook`, `silentHandoff`, `humanizedTone`, `softSell`, `evaluationFirst`, `conciseFirstReply`) | Só com deploy |
| **B. Regras, FAQ, mensagens prontas, roteiros** | Banco (CustomRule, ClinicFaq, MessageTemplate, Playbook), semeados por `seedLisboa.ts` e editáveis no painel | Entram no prompt. As regras vêm no fim, com a frase "tem prioridade sobre o comportamento padrão" | Painel / seed |
| **C. Jogada do turno** | `salesFlow.ts` | A cada mensagem decide a intenção (agendar, recusou, vou pensar, valor, info) e manda a "JOGADA AGORA" como **última** instrução ao modelo | Só com deploy |
| **D. Travas no código** | `alice.ts` | Respostas fixas e filtros que passam por cima do modelo: valor→equipe (`handoffOnPrice`), reclamação do robô, urgência, reação pós-procedimento, "é robô?", modo silencioso, anti-repetição, "um instante" sem executar | Só com deploy |
| **E. Automações** | ReminderRule, FollowUpRule, RenewalRule, PreProcedureRule | Textos que saem sozinhos (confirmação, recontato, reativação, preparo) | Painel / seed |

**Princípio proposto** (uma fonte por tipo):

| Tipo de regra | Fonte única |
|---|---|
| Política da clínica (o que pode, o que não pode, como conduzir) | **1 CustomRule** da Lisboa por tema |
| Fato que o paciente pergunta (horário, estacionamento, convênio, política de 24h) | **FAQ** (resposta exata) |
| Texto fixo a enviar (Pix, confirmação) | **Mensagem pronta modo exato** |
| Mecanismo e segurança (urgência, silêncio, valor→equipe, repetição) | **Código** (e nenhuma regra repete o que o código já garante) |
| Texto de disparo automático | **Automação** (e nenhuma mensagem pronta duplica) |
| Como usar as ferramentas de agenda e formato de data | **Prompt fixo** |
| Roteiros | Só passos de condução, **sem repetir política** (ou removidos) |

---

## 2. A Regra Mestra por tema

As menções a "regra padrão do banco" vêm do código (`DEFAULT_RULES` em `rules.ts`, que o seed grava em toda clínica). Elas devem estar na produção da Lisboa, mas só a exportação das regras ativas confirma.

Legenda: **Regra** = texto final proposto · **Fonte** = onde ela deve viver · **Sai** = versões que devem ser removidas ou ajustadas. Os números de linha são do `seedLisboa.ts` antes da limpeza (a mesma numeração do e-mail de aprovação).

### 2.1 Valores e condições comerciais

**Regra:** Se o lead veio de anúncio, informe o valor ou a condição vigente daquele anúncio. Para os demais contatos, informe apenas valores cadastrados e vigentes. Nunca invente preço, desconto ou condição. Em dúvida, negociação fora do cadastrado ou condição indisponível, encaminhe para a equipe. Não fale de valor se a pessoa não perguntou.

**Fonte:** CustomRule 485 (já reescrita) **+ as chaves `quotePrices` e `handoffOnPrice`**, que precisam concordar com ela.

**Sai / ajustar:**
- **Chaves (código, conflito grave):** o seed grava `quotePrices=false` e `handoffOnPrice=true`. Com isso o prompt esconde todos os preços ("NÃO informar valor") e qualquer mensagem com "valor/preço/investimento/quanto custa" vai direto para a equipe, **antes** do modelo responder. A regra 485 nunca entra em ação. Para a política atual: `quotePrices=true` e `handoffOnPrice=false`. *Decisão da Lisboa (D2).*
- Valor de anúncio: o prompt só orienta "informe exatamente o valor do anúncio" quando `quotePrices=true`.
- Mensagem pronta "Resposta a 'quanto custa?'" ("verificar a condição vigente") e FAQ de promoções ("eu verifico para você") usam "verificar", que a regra de transferência proíbe → reescrever sem "verificar".
- `alice.ts` `removeEvaluationPitch`: função morta que manda "não informe valores". Apagar.
- Roteiro "Pedido de preço sem contexto" já está alinhado (informa valor cadastrado). Manter, tirando "Verifique a condição vigente".

### 2.2 Agendamento

**Regra:** A Alice agenda direto no Clínica Experts. Quem pediu avaliação ou horário vai direto para a agenda, sem perguntas de descoberta. Ofereça 2 a 3 opções reais por vez e só confirme depois que o sistema registrou. Se não localizar o cadastro, peça o nome completo antes de concluir; depois de agendar, a equipe recebe aviso interno com nome, procedimento, data e horário. Sem horário, registre na lista de espera.

**Fonte:** Prompt fixo (como usar as ferramentas) **+ CustomRule do nome completo** (já criada) · `aliceCanBook` deve estar ligado.

**Sai / ajustar:**
- Número de opções: seed 495/496 e roteiros dizem "2 a 3"; `salesFlow` diz "2 ou 3"; a regra padrão do banco diz "**no máximo DUAS**". Ficar com "2 a 3" e remover a regra padrão (*D3*).
- Ordem: o prompt manda "**dia primeiro, sem citar horário**" (2 passos); o `salesFlow` e a regra 496 mandam oferecer horários. Proposta: oferecer dias só quando houver muitos dias livres; se a pessoa já deu dia/turno, oferecer horários.
- Pergunta sim/não: a regra padrão do banco diz "**nunca pergunte 'quer agendar?'**", mas o prompt e o `salesFlow` usam o exemplo "Quer que eu veja um horário pra sua avaliação?". Trocar o exemplo por oferta direta de duas opções.
- "Antes de oferecer horários, pergunte manhã/tarde/noite" (prompt, `conciseFirstReply`) contradiz "pediu avaliação → agende na hora". A pergunta só vale quando ela ainda não deu preferência **e** não pediu para agendar.
- Regras padrão do banco "entenda a queixa com 2–3 perguntas antes de falar de horários" → remover (o `salesFlow` já trata).
- Seed 547 e 553 removidos (limpeza). Notas do seed (`pending`) ainda dizem "a Alice não agenda": atualizar.

### 2.3 Confirmação de presença

**Regra:** A clínica envia **uma** confirmação por dia (a do primeiro horário). Se a pessoa confirmar, a Alice confirma todos os horários do dia. Quem não responder recebe uma segunda cobrança às 16h do dia anterior.

**Fonte:** Automação (ReminderRule 24h + cobrança) **+ prompt fixo** (`manage_my_appointment confirm`).

**Sai:** mensagens prontas "Lembrete de consulta" e "Confirmação de horário agendado" duplicam a automação com texto diferente. Manter só a "Confirmação de horário agendado" (usada logo após agendar) e apagar "Lembrete de consulta". A automação está assinada "**Aqui é a Fabi**", enquanto a Alice se apresenta como Alice (*D5*).

### 2.4 Avaliação gratuita

**Regra:** A Alice conduz para um próximo passo sem pressionar. A avaliação pode ser sugerida **no máximo uma vez** no mesmo contexto, depois de responder o que a pessoa quis saber. Se a pessoa pedir avaliação ou horário, agende na hora. Quem mora longe ou só quer informação: não insistir.

**Fonte:** CustomRule 579 (mantida) + 468 reescrita (pendente de ok) · `salesFlow` (aplica a mesma ideia, sem texto próprio).

**Sai:** hoje vários pontos tratam disso, e muitos mandam oferecer:
- Prompt: `evaluationFirst` ("**sempre** ofereça os dois caminhos"), `softSell` (uma vez), `postureLine` ("proponha a avaliação" na objeção).
- Banco: regras padrão `evaluation_first` (2 regras, "conduza pra avaliação").
- Roteiros: "Primeiro atendimento", "Paciente indeciso" ("explique que o ideal é a avaliação"), "Contorno de objeções".
- Mensagem pronta "Convite para avaliação" (usar "se indeciso").
- `salesFlow` caso padrão fecha com pergunta rumo à avaliação toda vez que a pessoa já contou a queixa (trava só depois que a avaliação já foi oferecida).
Ficar com: regra 579 + 468 reescrita; desligar `evaluationFirst` ou reescrever o trecho "sempre"; ajustar roteiros e mensagem pronta para "no máximo uma vez".
- `EVAL_PITCH_RE` e `SCHEDULING_INTENT_RE` só são usadas em teste. Apagar com `removeEvaluationPitch`.

### 2.5 Recontatos

**Regra:** Cascata de 4h, 1 dia, 3, 7 e 15 dias, das 9h às 20h; só para quem parou de responder, nunca com atendimento humano ativo ou consulta marcada. Cada recontato é um novo contexto e pode citar a avaliação uma vez. O de 15 dias encerra o acompanhamento.

**Fonte:** FollowUpRule (5 registros). A mensagem pronta "Recontato de quem sumiu" duplica o de 4h e deve sair.

**Sai / ajustar (*D4*):** os textos de 4h ("posso encaminhar para nossa equipe verificar os horários"), de 1 dia ("nossa equipe verifica o melhor horário") e de 7 dias ("nossa equipe confirma uma condição vigente e o melhor horário") foram escritos quando a equipe agendava. Hoje a Alice agenda; reescrever para "posso ver um horário para você".

### 2.6 Objeções (caro, medo, tempo, compara com outro lugar)

**Regra:** Acolha; explique que o valor envolve profissional, produto/tecnologia, protocolo e acompanhamento; ofereça apenas formas de pagamento ou condição vigente já cadastrada; nunca crie nem prometa desconto; negociação fora do cadastrado vai para a equipe. Nunca falar mal de concorrente.

**Fonte:** CustomRule 492 (já reescrita) + 469 (concorrentes, política e religião).

**Sai:** `postureLine` e `objectionLine` do prompt repetem a mesma instrução (acolher e usar o aprovado); manter só a de `postureLine`. Roteiro "Contorno de objeções" duplica a 492 → remover os passos de política. Regra padrão do banco "nunca crie desconto, brinde…" duplica a 486/492 → remover.

### 2.7 "Vou pensar" / "ok" / "depois eu vejo"

**Regra:** Acolha em uma frase e, se fizer sentido, entenda o motivo da dúvida com **uma** pergunta aberta ("o que ficou pesando?" ou "quando podemos retomar?"). Não empurre avaliação. Nunca responder só "ok". Só encerrar se a pessoa recusar com clareza ou pedir para parar.

**Fonte:** `salesFlow` (jogada "hesitate", decide no código) **+ uma CustomRule curta**.

**Sai (conflito direto):** o **roteiro "Paciente vai pensar ou responde só 'ok'"** (seed) manda "**proponha a avaliação gratuita** e pergunte dia e turno", justamente o que a Lisboa pediu para parar de fazer. O roteiro entra no prompt como "conduza nestes passos". → Remover o roteiro ou reescrever (acolher + perguntar o motivo). Esta é a principal contradição que a limpeza do treino não alcança, porque ela mora em Roteiros e não em Regras.

### 2.8 Transferência para humano

**Regra:** Quando a dúvida exigir atendimento humano, não invente: acione a transferência, sem escrever "vou verificar com a equipe". Transferir sempre: desconto fora da regra, reclamação, paciente irritado, dúvida clínica, medicamentos, reação, gestação/amamentação, exames/laudos, problema de pagamento, jurídico.

**Fonte:** Código (`transfer_to_human` + modo silencioso) **+ CustomRule 509 (reescrita) e 510/511** (lista de motivos).

**Sai:**
- **Decisão D1 (a mais importante):** com `silentHandoff` ligado (como está na Lisboa), o código **apaga qualquer texto** da Alice quando ela transfere (exceto urgência). Então "encaminhar para a equipe de forma breve", como pedido na aprovação, **não acontece**: a Alice fica muda. Ou a Lisboa aceita o silêncio, ou desliga o `silentHandoff` e define uma frase única de encaminhamento (`handoffPhrase`).
- Textos que mandam dizer "vou confirmar com a equipe" e conflitam com isso: prompt (agendamentos, localização sem endereço, erro de ferramenta, "retomada"), FAQ (acessibilidade, acompanhante), roteiro "Paciente pede desconto", regra padrão "já combinou valor com o doutor", regra 486 (pendente de ok).
- A ferramenta `transfer_to_human` diz "escreva UMA frase de encerramento" (a descrição da própria ferramenta contradiz o modo silencioso). Ajustar.
- `HANDOFF` e `silentLine` no prompt dizem duas coisas opostas (a segunda declara "vale acima"). Com o silêncio ligado, tirar a `HANDOFF`.

### 2.9 Silêncio após a equipe assumir

**Regra:** Enquanto a equipe estiver atendendo, a Alice não responde. O sistema devolve a conversa à Alice **quando a equipe libera ou quando passa 15 minutos sem resposta** (só se uma pessoa já tinha agido; nunca em urgência ou reação).

**Fonte:** **Código somente** (`humanTakeover` + `humanReturn`). Nenhuma regra de texto.

**Sai:** CustomRule 513 ("só retome quando a conversa for encerrada ou liberada") contradiz a volta após 15 minutos (`humanReturnMinutes`), e a Alice nem é chamada durante a tomada. Remover a 513 e a última frase da 509 ("permaneça em silêncio até a liberação"). O roteiro "Reclamação" também tem "fique em silêncio depois".

### 2.10 Identidade da Alice

**Regra:** A Alice não se apresenta por conta própria como assistente virtual, IA ou robô. Se a pessoa perguntar diretamente, responde com verdade, em uma frase curta, e continua ajudando (resposta fixa do sistema). Nunca afirma ser humana.

**Fonte:** **Código** (a resposta fixa de "é robô?") **+ 1 CustomRule (573)**.

**Sai (conflito grave):**
- A regra padrão do banco (`DEFAULT_RULES`, em **todas** as clínicas, gravada com o marcador "regra recomendada padrão") diz: "**Nunca revele… Se perguntarem diretamente, desconverse**". Contradiz o código, que responde a verdade. Corrigir o texto no código e remover a linha do banco da Lisboa.
- 4 versões do mesmo comportamento: prompt (`COMO VOCÊ SE APRESENTA`), `humanLine`, regra 573 e a mensagem pronta "Pergunta se é robô" (texto diferente do código). Manter o código e a 573; apagar a mensagem pronta.
- Seed 467 já removido (limpeza).
- Primeira apresentação ("Aqui é a Alice, da equipe da Lisboa") continua válida; não é "assistente virtual".

### 2.11 Leads de anúncio

**Regra:** Reconheça o anúncio em poucas palavras ("vi que você veio pelo anúncio de ..."), mantenha a oferta, nunca a contradiga e informe o valor/condição do anúncio se perguntarem. O texto de entrada da campanha é o **procedimento de interesse**, nunca o nome da pessoa.

**Fonte:** Prompt fixo (`ORIGEM`, lê o nome do anúncio) **+ CustomRule 561** (nome ≠ procedimento).

**Sai:** a regra 482 manda "conduza **rápido** para qualificação e agendamento", e a primeira resposta ("regra rígida") manda não falar de agendamento nem de avaliação. Remover da 482 o trecho "conduza rápido…", mantendo "reconheça o anúncio e nunca contradiga a oferta".

### 2.12 Contatos orgânicos e primeira resposta

**Regra:** Primeira mensagem, em até 2 frases: apresenta-se e faz **uma** pergunta (o nome ou o que a pessoa quer melhorar). Só explica, fala de avaliação ou pede dia/turno depois que ela responde. Se ela já contou a queixa ou pediu para agendar, vai direto ao ponto. No mesmo dia, não se reapresenta.

**Fonte:** Prompt fixo (`PRIMEIRA RESPOSTA`, `CONTINUIDADE`) **+ CustomRule 567**; o filtro de código só encurta.

**Sai:** a "ABERTURA DO ATENDIMENTO" faz até 4 perguntas (nome, se já conhece, queixa, quando pretende), contra "uma pergunta" da 567. Manter nome + queixa; "se já fez" e "quando pretende" saem ou ficam só quando ela der abertura. A mensagem pronta "Boas-vindas" tem texto próprio de apresentação; apagar ou alinhar. A 462 (cumprimentar e dar boas-vindas) repete a mensagem pronta.

### 2.13 Pagamentos e sinal

**Regra:** Sinal conforme a regra cadastrada do procedimento ou campanha; prazo de 24 horas; peça o comprovante por aqui e não confirme o pagamento (a conferência é do financeiro). Não prometa devolução de sinal nem reembolso. A chave Pix só é enviada quando houver sinal.

**Fonte:** CustomRule 487/489 + **mensagem pronta "Pix" (modo exato) como único lugar do dado**.

**Sai:** o CNPJ do Pix está em 3 lugares (regra 488, FAQ e mensagem pronta). Deixar só a mensagem pronta; FAQ e regra apontam para ela. Prazo de 24h está na 487, no FAQ e no roteiro de agendamento: deixar no FAQ. Seed 552 (removida na limpeza) tinha "Pix só quando houver sinal".

### 2.14 Pré e pós-procedimento

**Regra:** Logo após a confirmação do horário, o sistema envia o preparo do procedimento (texto da clínica, exato). Pós-procedimento: só fale quando a paciente perguntar e só com o que estiver cadastrado. Qualquer relato de reação, dor, medicação ou gestação antes ou depois vai para a equipe.

**Fonte:** Pré: automação (PreProcedureRule). Pós: CustomRule 543.

**Sai:** mensagens prontas "Orientações antes/depois do procedimento" (sem conteúdo, e dizem "me avise que eu encaminho") duplicam a aba Pré-procedimento: apagar. Regra padrão do banco "pós só quando perguntar" duplica a 543: remover.

### 2.15 Renovação / reativação

**Regra:** Reativar paciente inativo (6 meses) com a mensagem da automação, só com ela ligada.

**Fonte:** RenewalRule. Nenhuma regra de prompt.

**Sai:** a mensagem pronta "Paciente inativo (reativação)" é o mesmo texto da automação; apagar.

### 2.16 Cancelamentos, faltas e reagendamentos

**Regra:** Cancelar ou remarcar usa a ferramenta (nunca dizer que cancelou sem chamar). Se houver mais de um agendamento, perguntar qual. Depois de cancelar, oferecer reagendar uma vez. Menos de 24h pode contar como sessão realizada; em contestação, transferir. Quem faltou: acolher sem cobrar e oferecer remarcar.

**Fonte:** Prompt fixo (uso da ferramenta) **+ FAQ (política das 24h)** + CustomRule 500 reduzida a "em contestação, transfira".

**Sai:** a política das 24h está escrita em 5 lugares (regra 500, FAQ, roteiro de remarcação, roteiro de falta, mensagens prontas de falta e cancelamento). Ficar com o FAQ. A mensagem pronta "Cancelamento ou remarcação" abre com "vou te ajudar com a remarcação" mesmo quando a pessoa quer só cancelar.

### 2.17 Medicamentos e dúvidas clínicas

**Regra:** Nunca diagnosticar, prescrever, falar de medicamento, dose, contraindicação ou efeito colateral; nunca prometer resultado. Encaminhar para a equipe. Urgência (falta de ar, sangramento, reação alérgica, dor forte): resposta fixa orientando emergência e aviso à equipe. Reação nos 21 dias após procedimento: a equipe assume na hora.

**Fonte:** **Código** (urgência e reação, que já respondem sozinhos) **+ 1 CustomRule** (diagnóstico/medicamento).

**Sai:** esse conteúdo aparece em 8 regras (475, 476, 477, 510, 511, 512, 515, 516), em 3 trechos do prompt (`PRÉ-PROCEDIMENTO`, `COMO EXPLICAR`, `ferramentas`) e em 2 roteiros. Consolidar em uma regra de "não clínico" (475/476/477/512) e uma de "urgência e reação" (515/516); 510/511 ficam só como lista de motivos de transferência.

### 2.18 Campanhas e promoções

**Regra:** Só oferecer promoção, combo ou pacote vigente e cadastrado, relacionado ao interesse. Nunca criar, prorrogar nem juntar procedimentos por conta própria. A campanha de indicação só vale enquanto estiver ativa.

**Fonte:** CustomRule 480 + **FAQ** (cada campanha em um único registro, com data para sair).

**Sai:** a campanha de indicação está igual na regra 481 **e** no FAQ. Quando acabar o Outubro Rosa seria preciso lembrar de apagar nos dois. Ficar só com o FAQ. O FAQ de promoções usa "eu verifico para você". O `postureLine` já proíbe montar combo por conta própria (duplica a 480).

### 2.19 Tom, formato e repetição

**Regra:** Mensagens curtas (até 3 frases) e **uma** pergunta por resposta; sem markdown de documento; no máximo 1 emoji; usar o nome da pessoa no máximo uma vez; não repetir informação nem pergunta; não se despedir de novo se a conversa já terminou.

**Fonte:** Prompt fixo (uma vez) **+ CustomRule 568**. O resto é código (anti-repetição).

**Sai (conflitos):**
- Negrito e listas: 461 e 545 permitem; `humanLine` proíbe ("sem listas, sem negrito").
- Emoji: 463 lista emojis preferidos; `humanLine` diz "no máximo 1"; a regra padrão do banco diz "nenhum emoji em mensagens sobre valores e **confirmação de agendamento**" (a mensagem pronta de confirmação tem 2).
- "Uma pergunta por resposta": está em 461, 568, `postureLine`, `salesFlow`, `discoveryLine`. A regra padrão do banco "**toda resposta deve terminar movendo a conversa**… nunca encerre sem ação" contradiz o "pode só responder e parar" (e a 537, já removida, era a mesma).
- Não repetir/despedir: `noRepeatLine`, `naturalnessLine`, `humanLine`, regra padrão do banco e 4 travas de código dizem o mesmo. Manter código + `noRepeatLine`; remover a regra padrão.

---

## 3. Decisões da Lisboa e plano de aplicação

### Respostas da Lisboa (14/10/2026, 08:55) e o que foi feito

| # | Resposta da Lisboa | Aplicação |
|---|---|---|
| D1 | Quando não souber responder: **fica em silêncio** e **não retoma o contato**; aguarda a equipe | Regra 509 reescrita (silêncio, sem "vou verificar"); 513 removida. O sistema já só devolve a conversa à Alice se uma pessoa da equipe tinha agido e demorou 15 min; conversa transferida pela própria Alice nunca volta sozinha |
| D2 | A Alice **informa o preço cadastrado e vigente**; anúncio: a condição do anúncio; dúvida, negociação ou condição não cadastrada: equipe | Migração: `handoffOnPrice=0`, `quotePrices=1` na Lisboa; regras 485/492/540/486 reescritas |
| D3 | **3 horários** por vez | Regra padrão "no máximo DUAS" desativada; fica "2 a 3" |
| D4 | Recontatos: **"posso ver um horário para você"** | Migração (texto antigo exato): 4h, 1 dia e 7 dias |
| D5 | Confirmação assinada **Alice** | Migração (substitui "Fabi" pelo texto) |
| D6 | Regras 470, 468 e 486: ajustar. **"Vou pensar"**: acolher, entender o motivo se fizer sentido, sem empurrar avaliação, **propor um momento e recontatar na data e hora pedidas** | 470 removida; 468 e roteiro reescritos; nova ferramenta `schedule_recontact` registra o dia e a hora e o sistema manda a retomada |

### Decisões que só a Lisboa pode tomar (histórico)

| # | Decisão | Impacto |
|---|---|---|
| **D1** | **Modo silencioso (`silentHandoff`)**: a Alice transfere sem escrever nada (como está), ou escreve uma frase curta de encaminhamento? | Define o texto da 509 e o que a pessoa vê quando a Alice não sabe responder |
| **D2** | **Valores**: confirmar que `quotePrices` fica **ligado** e `handoffOnPrice` **desligado** (a Alice responde preço cadastrado) | Sem isso a regra 485 não funciona |
| **D3** | **Opções de horário**: "2 a 3" ou "no máximo 2"? | Uma só regra de quantidade |
| **D4** | **Textos dos recontatos** (4h, 1 dia, 7 dias): reescrever para a Alice agendar, em vez de "a equipe verifica"? | Automações que a pessoa lê |
| **D5** | **Assinatura da confirmação**: "Fabi" ou "Alice"? | Coerência de identidade |
| **D6** | Roteiros: remover "Paciente vai pensar…" e ajustar "Primeiro atendimento", "Indeciso" e "Objeções" | Fim do conflito de avaliação |

### Plano de aplicação (nada disso está aplicado)

1. Exportar as regras ativas reais da produção (botão **Exportar regras ativas (conferência)**) e fechar a coluna "banco" com o que existe de fato. Não consegui ler a produção.
2. Com as decisões D1–D6: ampliar o botão de limpeza (regras, roteiros, mensagens prontas, FAQ), sempre com **prévia**, **texto exato** e **substituir = remover o antigo**.
3. Ajustes de código/prompt (um commit por tema, com teste): chaves de valor e agenda, `DEFAULT_RULES` (identidade, "quer agendar?", duas opções, emoji), `transfer_to_human`, `HANDOFF` x modo silencioso, `evaluationFirst`, código morto (`removeEvaluationPitch`, `EVAL_PITCH_RE`).
4. Congelar esta Regra Mestra como referência oficial.

### Regra de manutenção (combinada)

Toda regra nova que substituir uma antiga **remove ou desativa a antiga no mesmo passo**; nunca se adiciona por cima. O botão de limpeza e o `seedRulesOnce` passam a registrar o que foi substituído.
