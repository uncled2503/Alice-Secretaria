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
7. Regras da clínica (valores, tom, postura comercial).
8. Padrões do sistema (avaliação para quem não sabe, descoberta).

Cada situação traz a **ordem exata** para o modelo (substitui a jogada genérica) e travas que o **código** confere depois de o modelo responder:

- oferta de avaliação a quem cancela/remarca é removida;
- "vou cancelar" / "cancelei" / "remarquei" sem a ferramenta ter dado certo → o modelo é obrigado a executar;
- lista de horários que não respeita "só sábados", "antes das 18:40" ou o dia pedido (que nem foi consultado) → o modelo refaz.

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
