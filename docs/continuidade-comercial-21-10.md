# Continuidade comercial, procedimento em discussão, serviço não realizado, produto e cobrança (Lisboa, 21/10/2026)

**Estado:** tudo local, **sem commit, sem push, sem deploy**; nenhuma mensagem real, nenhuma chamada paga à OpenAI, nenhum dado de produção tocado. Revisão do código: `2026-10-21-c`.
**Limite central:** os testes usam **modelo roteirizado** (provam o contrato do código: o que o modelo recebe, o que é proibido, o que a saída corrige e os efeitos no banco). **O texto que o modelo real escreve não foi avaliado** — ver o roteiro de validação (seção 7). Não houve acesso às conversas reais: onde a causa depende delas está dito.

## 1. Matriz: caso → causa → correção → teste → dependência cadastral

| Caso | Causa **comprovada** (código) | Hipótese sem evidência | Correção | Teste | Cadastro |
|---|---|---|---|---|---|
| **Anara** ("gostei dos resultados" → "estou à disposição") | "gostei" não era lido como interesse (só `isPositiveFeedback` de **paciente** pós-procedimento); `statedGoal` ignorava o procedimento citado (sem palavra de queixa); o convite final olhava a última fala da Alice e tratava o marcador "📷 fotos" como convite anterior | ordem exata das mensagens na conversa real | `turnReading.detectPositiveReaction`; `salesFlow` (`positiveReaction`, `statedGoal` inclui procedimento citado); `conduct` seção 7 "CONTINUIDADE" **conforme o modo cadastrado** (avaliação × horário direto); fecho em `alice.ts` ignora o marcador de fotos | `continuidade-comercial` A, A2, A3, A4; e2e A | `Procedure.bookingMode` |
| **Wilma** (preço → "à disposição") | quando a condução substituía a jogada (procedimento que exige avaliação), **nada mandava responder o valor primeiro** nem convidar: a ordem de preço só existia na jogada genérica | se o R$ 199,99 estava no cadastro (o código só barra valor fora do cadastro) | `turnObligations`: valor **primeiro**, só do cadastro (print/anúncio não é tabela), sem esconder preço, finalidade da avaliação + pergunta de dia/período | B; e2e B (inclui valor de print barrado **pelo contexto persistido** da entrega) | preço no cadastro |
| **Kelly** (expectativa de poucas sessões / "agendar horário para a remoção") | nenhuma leitura de expectativa; nada impedia "agendar o horário para a remoção" quando o cadastro exige avaliação | — | `detectResultExpectation` + ordem "não valide; profissional define na avaliação; escreva AVALIAÇÃO"; `evaluationWordingViolation`: **uma** correção (só se violar) e trava na entrega (`eval_wording`) | C; e2e C (2 chamadas só quando viola) | `bookingMode = evaluation` |
| **Nathália** (Lavieen → Carboxiterapia, 15 min, 13h30) | **(1)** a trava de relevância ignorava o procedimento **escolhido** quando a queixa era só de região ("costas"): apagava a frase com o Lavieen e a reescrita indicava a Carboxiterapia como "mais indicada" (reproduzido em teste); **(2)** o foco do prompt era por pontuação de região: sem os detalhes do Lavieen o modelo usava os de outro procedimento; **(3)** "saio do trabalho às 18h30" não era lido como restrição; **(4)** duração sem fonte nem distinção avaliação × sessão | memória antiga e ordem das mensagens reais | (1) `relevance.ts` respeita `allowed`; (2) `selectFocusProcedures(..., pinned)` fixa o assunto na frente; mesma regra de ancoragem em `identifyWanted` (mencionar ≠ escolher; só escolha explícita troca; `mentioned`); (3) `slotRequest` ("saio…às", "só consigo/posso depois/a partir"); (4) `durationFact.ts` + ordem "responda AS DUAS" e "sem 'o mais indicado para você'" | D, D2, E, F, G + relevância; e2e D/E | duração no cadastro/CE |
| **Paula** (Endolaser) | `notOfferedServices` da Lisboa **não tinha** Endolaser; a leitura de objetivo misturava "endolaser no abdômen" com "olheiras" (região do serviço inexistente herdada pela outra queixa); a promessa "vou confirmar e enviar valores" ficava | — | Endolaser/Endo laser entram na **configuração da Lisboa** (`lisboaConduta`, prévia); `withoutNotOffered` lê o outro interesse sem a região; a saída tira a promessa de valor; prompt com 3 estados (disponível / explicitamente não realizado / não localizado) | H/J, I; e2e H/J, I | `Clinic.notOfferedServices` (**a aplicar**) |
| **Taise** (refrescância) | nada distinguia fala da cliente de fato do produto; "vou verificar" com a equipe **não é detectado como promessa** (`announcesAction` exclui "equipe") e nenhuma pendência era criada | o que o cadastro dizia da marca | `detectProductConcern` (termo ambíguo, restrição); `productClaims`: afirmação de composição/sensação **sem fonte no cadastro** sai (e na entrega: `product_unproven`); pergunta curta de esclarecimento; `promisesTeamFollowUp` cria `transfer_to_human` **real** | K/L, K2; e2e K/L | texto de produtos no cadastro/FAQ |
| **Tatiana** (cobrança sem pedido inicial) | **comprovado:** o registro de "pedido enviado" (`ReminderSent`) é gravado **antes** do envio e **não era apagado** quando a revisão por IA barrava ou o plano bloqueava — a regra-filha enxergava "pai enviado" e cobrava (reproduzido no código antigo); `unconfirmed` também contava | por que o pedido não saiu na conversa real | cobrança só com `ReminderDispatch` do pedido **`sent`** para o mesmo agendamento+horário (legado sem linha de controle segue valendo); `vetoed/blocked` apagam o registro; incerto/falho/barrado → retido com motivo | P, Q, Q4, R, S, T | — |
| **"AvaliaçãoAvaliação"** | **não comprovado**: não achei concatenação duplicada no código; o texto cadastrado em produção (fora do repositório) pode ter a palavra colada a `{procedimento}` | texto da regra | `renderMessageTemplate` remove só a repetição **colada** do 1º termo do nome inserido | U | conferir o texto das regras |

## 2. Investigação das mensagens consecutivas
`generateReply` roda sob **trava por conversa** (`generateReplyUnlocked`), lê **todas** as mensagens novas consecutivas (`trailingNow`), descarta resposta superada por mensagem mais nova (`guardAgainstNewerThan`, `newerIncomingPending`) e persiste uma resposta por vez. **Não encontrei contexto parcial nem respostas concorrentes**; teste V confirma (uma resposta, com região + restrição + pergunta). Não há evidência de produção em contrário.

## 3. Conflitos corrigidos na origem
- Condução (procedimento escolhido que exige avaliação) mandava "ofereça a avaliação" **também para quem já tem horário** — agora só fora de `booked`.
- Trava de relevância contradizia a escolha explícita da pessoa (acima).
- `statedGoal` e foco do prompt contradiziam o procedimento citado (acima).
- Nenhuma regra nova empilhada: as ordens novas vivem em `turnObligations`/`planConduct` (já existentes). Não há segunda máquina de estados.

## 4. Arquivos alterados
`src/ai/`: `turnReading.ts`, `salesFlow.ts`, `conduct.ts`, `bookingIntent.ts`, `slotRequest.ts`, `relevance.ts`, `procedureFocus.ts`, `promises.ts`, `replyGuard.ts`, `turnDecision.ts`, `alice.ts`; **novos** `productClaims.ts`, `durationFact.ts`. `src/reminders/cron.ts`, `src/crm/template.ts`, `src/maintenance/lisboaConduta.ts`, `src/version.ts`. Testes novos: `continuidade-comercial`, `continuidade-comercial-e2e`, `cobranca-evidencia`; ajustado `conduta-comercial` (lista padrão da Lisboa agora inclui Endolaser — mudança intencional).

## 5. Antes/depois (SIMULADOS — modelo roteirizado; "antes" = texto do relato, "depois" = saída do código sobre o mesmo texto do modelo)
- **Anara** — modelo: "Que bom que você gostou! Estou à disposição para qualquer dúvida sobre o Botox." → depois: sem "estou à disposição" + "Quer que eu veja um horário para sua avaliação?" (nada agendado).
- **Kelly** — modelo: "Vamos agendar um horário para a remoção da sua tatuagem e, assim, poderemos avaliar…" → uma correção → "…o número de sessões quem define é a profissional… Vamos agendar a sua avaliação?".
- **Paula** — modelo: "O Endolaser é uma excelente opção… Vou confirmar e te enviar os valores. Para as olheiras…" → depois: só a parte das olheiras e o convite; ninguém é transferido.
- **Taise** — modelo: "O produto … tem refrescância, mas podemos personalizar…" → depois: sem a afirmação + "Quando você fala em refrescância, você quer dizer a sensação de frescor/gelado… ou o perfume/cheiro?".

## 6. Alterações cadastrais **preparadas e NÃO aplicadas**
- **Endolaser não realizado:** `POST /api/clinics/lisboa-conduta` (admin; **prévia por padrão**, `dryRun:false` aplica). Acrescenta "Endolaser" e "Endo laser" a `Clinic.notOfferedServices`, tira o termo dos apelidos de procedimentos e **só relata** (não reescreve) ocorrências em descrições/FAQ/regras/mensagens. Idempotente; não toca outras clínicas.
- Conferir (manual) o texto da regra de cobrança da Lisboa e se `{procedimento}` está colado a uma palavra.
- Conferir produtos/marcas no cadastro/FAQ (a Alice só afirma composição que estiver lá).

## 7. Roteiro de validação controlada (modelo real, só com autorização para chamadas pagas e contatos de teste)
1. Aplicar a prévia do `lisboa-conduta` e conferir o `diff`; depois aplicar.
2. Com 3 contatos de teste: reproduzir Anara, Wilma, Kelly, Nathália, Paula e Taise e conferir o texto final (convite com pergunta, valor do cadastro, "avaliação" explícita, Lavieen mantido, Endolaser não oferecido, produto sem afirmação inventada).
3. Conferir nos logs: `[decisao]`, `[conduta]`, `[avaliacao-x-sessao]`, `[produto-sem-fonte]`, `[promessa-equipe]`, `[nao-oferecido]`.
4. Acompanhar a próxima janela de confirmação/cobrança no Diário e em `reminder-trail`.

## 8. Chamadas e tokens (sem economia inventada)
- **Chamadas novas por padrão: nenhuma.** Uma correção extra **só** quando o modelo viola "avaliação × sessão" (mesmo padrão das correções existentes).
- **Contexto:** +1 parágrafo fixo no prompt (≈110 tokens) e linhas condicionais na ordem do turno (≈80–250 tokens, só nos turnos que casam); o assunto em discussão é **fixado** no foco do prompt sem aumentar o teto de 6 detalhes (+avaliação); o contexto da resposta persistido ganhou dois campos pequenos. Não medi consumo real.

## 9. Riscos, implantação e reversão
- **Risco:** `promisesTeamFollowUp` cria transferência automática quando a Alice **diz** que a equipe vai confirmar/retornar sem ter chamado a ferramenta (a conversa passa a "com a equipe"). Se a equipe achar excessivo, desligar com `ALICE_REPLY_FACTS=off` (desliga também as travas de produto) ou ajustar a regex em `promises.ts`.
- `ALICE_TURN_READING=off` desliga as leituras novas (reação positiva, expectativa etc.) e a ancoragem do procedimento.
- Implantação: sem migração; subir, aplicar a prévia/aplicação do Endolaser, rodar o roteiro 7. Reversão: variáveis acima ou voltar o commit; `notOfferedServices` volta editando o campo.
