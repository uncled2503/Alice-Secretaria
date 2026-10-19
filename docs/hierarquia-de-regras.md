# Hierarquia de regras da Alice + diagnóstico dos erros de 16/10/2026

Escrito depois de ler o código com os prints da Lisboa na mão. As causas abaixo vêm do código; não tenho acesso aos dados nem aos logs de produção, então o que depende de dado real está marcado.

## 1. De onde vinham os erros

Não era "o ChatGPT" sozinho nem uma regra só. O prompt da Alice tinha dezenas de instruções que se contradiziam, e o modelo escolhia uma delas na hora. Exemplos reais que estavam no código:

| Instrução A | Instrução B (contradiz) |
|---|---|
| "se o paciente pedir para **mudar** o horário: não concorde, passe para a equipe" | "se pedir para **remarcar** ou cancelar: use `manage_my_appointment`" |
| "quem já tem horário: não ofereça horário nem avaliação" | "o cliente quer agendar: vá direto ao agendamento e ofereça os horários **mais próximos** (hoje/amanhã)" |
| "agende o procedimento que ela pediu" | "agende a avaliação no mesmo dia e hora" quando o procedimento não está no catálogo |
| "se a conversa foi assumida pela equipe, continue de onde ela parou" | a jogada de venda mandava reiniciar a oferta de avaliação |

Cada print caiu numa dessas brechas:

| Print | O que a Alice fez | Causa |
|---|---|---|
| **Vânia** (trocar terça pra 12:30) | ofereceu horários de *avaliação* (Fabíola, Sabrina) e disse "a clínica não atende nesse dia" | o pedido tinha as palavras "horário" e "12:30", então a jogada era "agendar" (avaliação). Remarcação não existia como situação. E o motivo `closed_day` é do **expediente do profissional** (o texto dizia "da clínica"). |
| **Maria** (Protocolo do Olhar) | disse que ela tinha "avaliação sexta 08:00" | quando o procedimento não está no catálogo, a regra mandava agendar **avaliação** no mesmo horário, mesmo para quem já tinha sessão marcada. A avaliação foi criada pela própria Alice. |
| **Bruna** (cancelou ontem e recebeu o lembrete) | "vou cancelar seu horário" duas vezes, sem cancelar | a Alice só **prometeu** (o detector de promessa não conhecia "vou cancelar"), então o agendamento continuou ativo e o lembrete saiu. |
| **Todas que cancelaram/remarcaram no CE** | confirmação para horário que não existe mais | a Alice guarda uma cópia da agenda do Clínica Experts e a atualiza a cada 10 min. Reserva apagada ou trocada lá **não era conferida antes de enviar**. |
| **Andreia e Isabela** | ofereceram horários "mais próximos" ignorando o que a equipe e a cliente tinham combinado | foi a função "Alice volta se a equipe demorar" (15 min). Ela voltava com a jogada genérica de avaliação, sem olhar a proposta da equipe nem o pedido ("só sábado", "aula às 18:40"). |
| **Aline** ("Obrigada" à pesquisa) | ofereceu 3 horários de avaliação | agradecimento a mensagem automática caía no fluxo de lead. Pesquisa e pós saíram no mesmo minuto para a mesma limpeza de pele. |
| **Jandira** (gordura localizada) | listou horários de Enzimas sem ela escolher | "gordura localizada" é apelido de Enzimas no catálogo e "queria" valia como pedido do procedimento. Queixa foi tratada como escolha. |
| **Reserva sem procedimento** | sem confirmação | a importação do CE **descartava** a reserva. |
| **Recontatos** | não saíram | **não consegui confirmar** a causa sem os dados. Hipóteses no fim deste documento. |

## 2. A hierarquia (a de cima vence)

Agora a decisão é do código, não do modelo. A cada mensagem o sistema olha os fatos e escolhe **uma** situação nesta ordem (`src/ai/situation.ts`):

1. **Segurança clínica**: urgência, reação, dúvida clínica → equipe.
2. **Não é paciente**: vaga/currículo, fornecedor, parceria, cobrança de empresa → equipe, em silêncio.
3. **Resposta a mensagem automática** (pesquisa, pós): só agradece, sem oferta.
4. **Já tem horário e quer cancelar / remarcar / tirar dúvida dele** → usa a agenda **dela**: mesmo procedimento, mesmo profissional, mesma duração. Nunca avaliação, nunca horário novo "mais próximo".
   - cita um horário que **não bate** com a agenda → equipe, sem a Alice afirmar nada.
5. **A equipe estava negociando o horário** → continua de onde a equipe parou (aceitou a proposta? agenda esse; recusou? respeita o pedido).
6. **O pedido explícito dela** (dia, hora, limite, turno) vale mais que "horários mais próximos".
7. **Conduta comercial** (17/10, `src/ai/conduct.ts`): recusa e "vou pensar" são respeitados; queixa **não** é procedimento escolhido; só se indica o que o cadastro aprovado diz atender a queixa; serviço que a clínica não oferece nunca é citado. Detalhes na seção 8.
8. Regras da clínica (valores, tom, postura comercial).
9. Padrões do sistema (avaliação para quem não sabe, descoberta).

Cada situação traz a **ordem exata** para o modelo (substitui a jogada genérica) e travas que o **código** confere depois de o modelo responder:

- oferta de avaliação a quem cancela/remarca é removida;
- "vou cancelar" / "cancelei" / "remarquei" sem a ferramenta ter dado certo → o modelo é obrigado a executar;
- lista de horários que não respeita "só sábados", "antes das 18:40" ou o dia pedido (que nem foi consultado) → o modelo refaz.

### Regra de ouro: horário só quando a pessoa pede (caso Clarinda, 16/10)

A Alice **só lista horários ou oferece avaliação quando a pessoa está em conversa de agendamento** (pediu, aceitou, escolheu, recusou uma oferta ou está respondendo a uma pergunta de dia/turno). Isso é conferido pelo código a cada mensagem (`schedulingSignal`):

- `Ok.`, `Não.`, `Vou tentar.`, `Pra minha amiga.`, agradecimento, comentário: **sem sinal** → nada de lista de horários e nada de venda.
- Resposta curta ("ok", "obrigada") a uma fala que **não fez pergunta**: a Alice fica em **silêncio**.
- Quem **já é paciente** (já foi atendida/avaliada, ou recebeu pesquisa/pós) ou a conversa que a **equipe estava conduzindo** e a Alice retomou: só responde o que foi dito, **sem avaliação e sem horários**.
- Se o modelo oferecer mesmo assim, o código manda refazer uma vez e, se insistir, **tira a oferta** da mensagem (nunca fica sem resposta: sobra uma frase neutra).

A causa do print: um pedido de horário **antigo** deixava a conversa em "modo agendar" para sempre, e qualquer mensagem depois virava "vá direto ao agendamento". Agora um pedido antigo só vale se a conversa ainda está no meio do agendamento.

## 3. O que a Alice lê antes de responder (a ficha)

Em toda resposta, no topo da última instrução:

- a hierarquia acima;
- **AGENDA DELA** (procedimento, profissional, dia/hora, se confirmou);
- se a última mensagem foi **automática** (pesquisa, pós, lembrete, recontato) e há quanto tempo;
- o que a **equipe** falou e quando;
- o **pedido de dia/hora** dela já estruturado ("só consegue sábados; citou 10:00 e 10:30; não pode a partir das 18:40");
- a leitura da conversa que já existia (quem é, o que quer, o que já foi dito).

## 4. Confirmações: nunca mais para horário que não existe

Antes de mandar **qualquer** lembrete de um agendamento ligado ao Clínica Experts, a reserva é consultada ao vivo:

- cancelada, apagada ou marcada como falta no CE → cancela aqui e **não envia**;
- horário trocado no CE → corrige aqui, libera os lembretes pro horário novo e **não envia o antigo**;
- a importação (a cada 10 min) também cancela o que sumiu da agenda do CE, depois de conferir ao vivo.

Remarcar pela Alice agora só vale **depois que o CE aceita** (como o agendamento novo já fazia). Se o CE recusar, o horário antigo volta e a equipe é avisada.

**Reserva sem procedimento** entra na Alice com um procedimento interno e a confirmação sai só com data e horário (a linha "Procedimento" é retirada do texto).

## 5. O que ainda depende de dados de produção

- **Recontatos**: o relatório das 20h agora lista cada recontato ativo, quando dispara e quantos saíram no dia, e mostra as **conversas esperando a equipe há mais de 12h**. A Alice não recontata conversa em atendimento humano; se a equipe não responde uma transferência silenciosa, o lead fica parado e nunca é recontatado. Isso pode explicar parte dos "recontatos que não saíram". Confirmar também qual horário vale (8h ou 12h): a regra hoje tem janela de 8h às 12h.
- **Terça "a clínica não atende"** (Vânia): o motivo agora diz que é o expediente do **profissional**. Falta conferir o expediente da profissional do Hipro no cadastro.
- **Procedimentos fora do catálogo** (Protocolo do Olhar): continua sem agendar direto até ser cadastrado, mas quem já tem horário ou já é paciente vai para a equipe em vez de ganhar avaliação.

## 6. Revisão por IA de TODA mensagem antes de sair + memória do lead sempre atualizada (pedido de 16/10)

**Revisão de envio (`src/ai/sendGate.ts`).** Antes de qualquer mensagem automática (lembrete, recontato, pós, pesquisa, aniversário, renovação, campanha, preparo, lista de espera) ou resposta da Alice sair para o WhatsApp de uma pessoa, uma chamada curta à IA lê a ficha dela e decide: **enviar**, **não enviar** ou (só resposta da Alice) **reescrever** um trecho.
- Barra quando há motivo concreto na ficha: horário cancelado/remarcado/diferente da agenda; pessoa pediu para não receber ou não tem interesse; mensagem igual enviada nas últimas ~20h; oferta de avaliação/horário a quem já tem horário, já foi avaliada ou não pediu; contradiz o que a equipe combinou ou a equipe está falando agora; momento inadequado (pesquisa logo após reclamação, recontato a quem disse que não pode); resposta da Alice que inventa valor/horário.
- **Resposta da Alice NUNCA é barrada** (lead sem resposta é o pior erro): se a revisão acha problema, **ela mesma escreve uma resposta melhor** (natural, curta, que responde ao que a pessoa escreveu, usando só fatos da ficha ou da resposta original) e **essa é a que sai**. Se a IA não devolver uma alternativa aceitável (vazia, ou com horário/valor inventado), sai a resposta original. A revisão lê a ficha **sem** a resposta que está sendo entregue (antes ela aparecia como "já enviada" e a IA a barrava como repetida).
- **Mensagem automática** (lembrete, recontato, pós, pesquisa...) pode ser barrada, só com confiança "alta" (ex.: lembrete de horário cancelado).
- **Disjuntor:** se a revisão barrar ou reescrever 60% ou mais das últimas mensagens (mínimo 6 em 15 min), ela se desliga sozinha por 30 min e tudo sai sem revisão (fica no Diário de atividades).
- **IA fora do ar ou resposta estranha = envia** (a revisão nunca trava o atendimento). Aviso interno da equipe, número que não é paciente e mensagem escrita pela equipe não passam pela revisão.
- Toda mensagem barrada fica no **Diário de atividades** (com o motivo) e entra no **relatório das 20h**. Resposta da Alice barrada vira conversa **não lida** com aviso para a equipe responder.
- Desligar (emergência): variável `AI_SEND_REVIEW=off`. Modelo: `OPENAI_GATE_MODEL` (padrão `gpt-4o-mini`). Custo: 1 chamada curta por mensagem enviada; o resultado de uma mesma mensagem é lembrado (10 min; barrada 3 h).

**Memória do lead (`src/ai/leadBriefing.ts`).** Duas camadas, sempre lidas pela Alice e pela revisão:
1. **Fatos ao vivo** (montados na hora do banco, nunca velhos): agenda, atendimentos anteriores, cancelamentos dos últimos 14 dias, mensagens automáticas das últimas 24h, o que a equipe falou, últimas mensagens, opt-out/sem interesse/retorno combinado.
2. **Notas da memória** (`Patient.briefingNotes`, escritas por IA): o que quer, restrições de dia/hora, o que a equipe combinou, "já foi avaliada em 14/10", "vai pensar até sexta", o que **não** fazer. Atualizadas quando algo relevante acontece: mensagem da pessoa (após a conversa assentar), fala da equipe (celular ou painel), resposta da Alice entregue, agendamento criado/cancelado/remarcado (Alice, painel, Clínica Experts), mais um job a cada 20 min que atualiza quem teve conversa nova. Desligar: `AI_BRIEFING=off`.

## 7. Economia de tokens da OpenAI (sem mudar o fluxo)

Onde cada chamada gasta (estimativa com a Lisboa semeada, sem o catálogo do Clínica Experts): o **prompt da conversa** tem ~16 mil tokens (regras ~5 mil) e é reaproveitado do cache da OpenAI (desconto de 50%) quando o início não muda; a **segunda leitura** da conversa custa ~3 mil; a **revisão de envio** ~1,3 mil; a **memória do lead** ~1 mil.

O que foi feito:
- **Segunda leitura** só roda quando o código ainda não decidiu o caminho (ela é descartada quando a situação já foi definida: cancelar, remarcar, equipe negociando, "ok", retomada sem pedido, já agendada).
- **Hierarquia de regras** passou para o início do prompt (parte cacheada), em vez de ir na última mensagem (paga a cada resposta).
- **Mensagens bem antigas** da conversa (além das 10 últimas) vão cortadas em 320 caracteres; as recentes seguem inteiras.
- **Revisão de envio:** respostas fixas do sistema (agradecimentos, aviso de urgência, "sou a assistente virtual") não gastam a chamada — e as de segurança nunca podem ser barradas; a ficha vai enxuta (8 últimas mensagens, cortadas) e a resposta é curta.
- **Memória do lead:** só manda as mensagens **novas** (as notas anteriores carregam o resto), no máximo 1 atualização a cada 15 min por pessoa (3 min quando a agenda muda), e ignora conversa que é só "oi/ok".
- **Medição:** `GET /api/ai-usage` (só admin) mostra, desde que o servidor subiu, chamadas, tokens de entrada/cache/saída e custo estimado **por finalidade** (conversa, segunda leitura, revisão de envio, memória, resumo do CRM, juiz de recontato).
- Interruptores extras: `AI_SECOND_READING=off` (desliga a segunda leitura de vez), `AI_BRIEFING=off`, `AI_SEND_REVIEW=off`.

Para conferir o custo real: abrir `/api/ai-usage` depois de um dia de uso. Se a **conversa da Alice** dominar, o que mais pesa é o tamanho do prompt (regras ativas) e o modelo configurado por clínica (`Clinic.aiModel`: modelo maior que o `gpt-4o-mini` multiplica o custo).

## 8. Conduta comercial e entendimento da conversa (pedido de 17/10)

Código: `src/ai/concerns.ts` (leitura da queixa), `src/ai/conduct.ts` (plano da conduta + trava das ferramentas), `src/maintenance/lisboaConduta.ts` (ajuste de cadastro da Lisboa, com prévia).

- **Queixa x procedimento escolhido.** "Gordura localizada" é queixa; só vira escolha quando a pessoa **nomeia** o procedimento. A queixa é lida por frase (negação, correção, duas demandas, tom de pele ≠ queixa, queixa antiga ou de outra pessoa não contamina).
- **Região sozinha nunca recomenda.** A relação queixa ↔ procedimento vem do **cadastro aprovado** (objetivos, nome, apelidos; descrição só como reserva), não do conhecimento do modelo. Sem procedimento aprovado para a queixa: pergunta curta ou transferência para a equipe.
- **Como cada procedimento agenda.** `Procedure.bookingMode` (`direct` / `evaluation`); sem o campo, vale o texto aprovado; sem nenhum dos dois, o modo é "desconhecido". Com `Clinic.strictBookingRules` ligado (decisão da clínica), desconhecido vai para a equipe — a Alice não presume agenda direta nem cria avaliação substituta.
- **Trava no código.** As ferramentas de agenda passam por `ConductGate`: sem sinal de agendamento não consulta nem reserva; procedimento diferente do escolhido, bloqueado ou não oferecido é recusado; reserva duplicada no mesmo dia não é criada.
- **Recusa / "vou pensar" / "ok".** Respeitados e registrados (histórico + `lead_decision` + `Patient.objections`); sem opt-out permanente e sem nova automação.
- **Serviço que a clínica não oferece** (`Clinic.notOfferedServices`, Lisboa: luz pulsada): nunca citado; LEDterapia não é substituta automática.
- **Contatos não comerciais** (currículo, fornecedor, parceria, cobrança) seguem para a equipe em silêncio; "Última vaga da semana" em anúncio **não** é vaga de emprego.
- **Limite:** os testes usam modelo e serviços simulados — provam o que o código envia ao modelo, quais ferramentas executa e o que sai depois das travas, **não** o comportamento real do modelo em produção.
