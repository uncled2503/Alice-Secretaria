# Custo da OpenAI: medição, contexto e tentativas

Tudo aqui é **estimativa** de custo (tokens × tabela de preços por modelo). A cobrança real só a fatura/painel de uso da OpenAI mostra.

## Medição

Toda chamada à OpenAI passa por `src/ai/openaiCall.ts` (`tracked(...)`, `trackedChat`, `trackedRequest`). Cada **tentativa** (inclusive as que falharam, as correções e as reescritas) vira uma linha em `AiCall`: clínica, conversa, `traceId` (um por resposta gerada = um atendimento), finalidade, modelo pedido e **devolvido**, tokens de entrada / entrada em cache (já dentro da entrada) / saída, duração, resultado, tipo do erro, motivo da chamada (`answer`, `tool_result`, `correction:<qual>`, `retry:<causa>`, `fallback_model`, `second_reading:<critério>`) e número da tentativa. **Não** grava conteúdo de conversa, credencial nem dado pessoal.

### Estados de consumo (nunca "falhou = zero")

| Estado | Quando | Entra no custo? |
|---|---|---|
| `known` | a API devolveu o uso | sim |
| `unknown` | a requisição **foi enviada** e o consumo não veio: timeout, queda no meio, erro HTTP, resposta sem uso | não; é **contada** à parte |
| `not_sent` | bloqueada localmente (saldo/chave), nenhuma requisição saiu | zero de verdade |

A maioria dos erros 4xx não é cobrada pela OpenAI, então `unknownUsageCalls` é um **teto** de incerteza, não uma cobrança. Enquanto houver tentativa `unknown`, chamada sem preço ou perda de medição, o painel devolve `totalIsComplete: false` e `totalNote` explicando; o `totalEstimatedUsd` é então o **custo conhecido (piso)**.

Não existe tela no painel web para isso: o "painel" é a resposta JSON de `GET /api/ai-usage` (admin): sem parâmetros = desde que o servidor subiu; `?days=30&clinicId=…` = persistido; `?trace=<id>` = as chamadas de um atendimento, com soma de entrada e saída. `/health` mostra `openai: ok | sem_saldo | credencial_invalida`.

## Persistência e limites

- Escrita em lote (5 s ou 50 linhas, uma inserção), fora do caminho do atendimento. Cada registro tem **id próprio**.
- **Fila limitada** (`MAX_QUEUE = 2000`). Banco falhando: o lote volta para a fila (a gravação tem prazo de `AI_USAGE_WRITE_TIMEOUT_MS`, 15 s) e uma nova tentativa é agendada com espera crescente. Passando do limite, os registros **mais antigos** são descartados e **contados** (`telemetry.dropped` no JSON, linha no log). Regravar um lote que já tinha entrado cai em conflito de id e é tratado como "já gravado": não duplica.
- **Desligamento limpo** (SIGTERM): grava o que der em até 5 s; o que sobrar é contado em `telemetry.lostOnShutdown` e escrito no log.
- **Perda possível**: queda brusca do processo (kill -9, falta de energia) perde o que ainda estava na fila em memória (no máximo ~5 s ou 50 linhas), sem aviso. Banco fora do ar por muito tempo perde os registros mais antigos acima de 2000. Nesses casos `telemetry.complete` fica `false` e o total sai como parcial.
- **Retenção**: linhas por tentativa ficam `AI_USAGE_KEEP_DAYS` (14). Depois, **numa única transação**, são somadas em `AiUsageDaily` (dia × clínica × finalidade × modelo, com `unknownCalls` e `notSentCalls`) e apagadas; a soma só considera as linhas que **esta** transação apagou (contagem conferida), então duas execuções ao mesmo tempo, ou uma que falhe no meio, nunca contam duas vezes. Roda todo dia às 04:10 (Brasília).
- **Relatório persistido**: `days` = dias UTC inteiros contando o de hoje; agregado e linhas recentes usam o **mesmo** limite (início do dia UTC), então um registro está em `AiCall` **ou** em `AiUsageDaily`, nunca nos dois nem em nenhum.

## Preços

`src/ai/pricing.ts` traz o padrão (fonte e data de conferência por modelo; a página oficial não mostra data de vigência). Para um preço novo ou diferente, sem mexer no código:

```
OPENAI_PRICES_JSON={"modelo":{"input":0.15,"cachedInput":0.075,"output":0.6,"source":"fatura de out/2026","checkedAt":"2026-10-19"}}
```

Modelo sem preço aparece como **"custo não calculado"** (nunca zero, nunca o preço de outro modelo). A transcrição de áudio (`whisper-1`) é cobrada por minuto e fica "não calculada".

## Bloqueio por saldo / chave e recuperação

- O estado é **por credencial**: identificada por uma impressão digital curta (`cred-` + 8 caracteres do sha256 da chave), **nunca a chave nem parte dela**. Chaves independentes não se bloqueiam. Hoje o servidor tem **uma** chave para todas as clínicas: se ela esgota, esgota para todas (e todas são avisadas, uma vez por hora cada).
- Saldo esgotado (`insufficient_quota`, `credit_balance_exhausted`, limites de gasto) e chave inválida **nunca são repetidos** (a própria OpenAI diz que repetir não restaura o acesso). Passam a ser registradas como `not_sent` e lançam `OpenAiBlockedError` sem enviar requisição.
- Passado `AI_BLOCK_COOLDOWN_MS` (5 min), **uma única** chamada por credencial vira a tentativa de recuperação: é a próxima chamada **real e útil** que chegar (não há chamada artificial paga). Enquanto ela está em andamento, as demais continuam bloqueadas. Funcionou: libera todas. Falhou por saldo/chave: continua bloqueada até o próximo intervalo. Inconclusiva (timeout): a vez é liberada só no próximo intervalo.
- **Aviso à equipe** (Diário + WhatsApp interno): não usa a OpenAI (é texto fixo, enviado como mensagem interna, que não passa pela revisão por IA), portanto não depende do serviço bloqueado nem gera recursão. É marcado antes do envio assíncrono e limitado a 1 por hora por credencial **e** clínica.

## Tentativas: antes (e405310) e agora

| | Antes | Agora |
|---|---|---|
| SDK | `maxRetries: 1` (gate de envio: 0); o SDK 7.5.0 repete 408, 409, 429 (**inclusive saldo esgotado**), 5xx, queda de conexão e **timeout**, e obedece `x-should-retry` | `maxRetries: 0` em todos os clientes |
| Aplicação | só a troca de modelo da conversa em qualquer erro | `AI_APP_RETRIES` (padrão 1; 0 nos testes): repete **uma vez** 429 de limite temporário, 5xx e queda de conexão, respeitando `Retry-After`; **não** repete saldo/chave, timeout, modelo incompatível nem 400 |
| Troca de modelo (conversa) | em qualquer erro | só se o problema é do **modelo** da clínica (404/parâmetro recusado) |

Consequência: `AI_APP_RETRIES=0` **desliga** novas tentativas; **não** reproduz o comportamento antigo (que repetia também saldo, timeout e 408/409). O equivalente mais próximo do antigo para falhas temporárias é o padrão `AI_APP_RETRIES=1`.

## Compatibilidade com a documentação oficial e o SDK instalado

- SDK instalado: `openai@7.5.0` (`package.json: ^7.5.0`). Confirmado no código dele: `client.apiKey` existe (usado só para a impressão digital), `Retry-After` chega em `err.headers`, os códigos de erro seguem o guia oficial de erros (https://developers.openai.com/api/docs/guides/error-codes: 401 chave incorreta; 429 de saldo `insufficient_quota` / `credit_balance_exhausted` / limites de gasto **não** é limite de taxa; 429 de limite de taxa; 503 `server_is_overloaded`; "repetir erro de saldo não restaura o acesso").
- `max_tokens`: marcado como **deprecated** em favor de `max_completion_tokens` e não compatível com modelos de raciocínio (documentação de tipos do próprio SDK 7.5.0; a página oficial da referência da API não pôde ser aberta por esta ferramenta, então a conferência é pelo SDK e por publicações da OpenAI). O código só usa `max_tokens`/penalidades para modelos `gpt-4*` na conversa. As chamadas auxiliares (revisão de envio, memória, assistente de ajuda, sugestão de anúncio) usam `max_tokens`/`temperature` fixos: se `OPENAI_MODEL`/`OPENAI_GATE_MODEL` forem trocados para um modelo de raciocínio, essas chamadas passam a receber 400, classificado como incompatibilidade de modelo (sem repetir). Isto **não foi alterado** nesta entrega.
- `reasoning_effort: "none"` para `gpt-6*` continua sem validação (comentário do código: "relato de terceiros").

## Configurações e o que cada reversão realmente restaura

| Variável | Padrão | O que faz | O que reverter **restaura** e o que **não** |
|---|---|---|---|
| `AI_CONTEXT_SELECT` | ligado | seleção de FAQ / mensagens / roteiros | `off`: manda **todo** o conteúdo (mesma lista de antes). **Não** restaura: a posição do bloco (continua depois do marcador de contexto variável) e o texto da instrução `explainLine` |
| `AI_REWRITE_MODE` | `consolidated` | reescritas | `legacy`: uma chamada de reescrita por problema, com os mesmos prompts de antes. É o que reproduz as chamadas do commit anterior |
| `AI_SECOND_READING` | seletivo | segunda leitura | `always`: mesma condição de antes (4+ mensagens), **mantendo** as exceções que já existiam (agendada, remarcação, equipe, situação decidida pelo código, só cortesia). `off` desliga |
| `AI_APP_RETRIES` | 1 (0 nos testes) | novas tentativas | ver acima: `0` desliga, não restaura |
| `AI_BLOCK_COOLDOWN_MS` | 300000 | pausa após saldo/chave | não há chave que desligue o bloqueio; o mínimo é 1000 ms |
| `AI_USAGE_PERSIST` | ligado | gravação no banco | `off`: só memória; as contagens do painel continuam |
| `AI_USAGE_KEEP_DAYS` / `AI_USAGE_WRITE_TIMEOUT_MS` | 14 / 15000 | retenção / prazo de gravação | — |
| `OPENAI_PRICES_JSON` | — | preços por modelo | — |

**Não têm chave de reversão** (mudaram junto, de forma permanente): a remoção da lista "mensagens da pessoa que você já respondeu" do lembrete final; o texto novo de `explainLine`; o perfil do CRM enviado à memória do lead; a remoção do `maxRetries` do SDK; e o registro de medição em si.

## Comparação fiel antes × depois

Para não depender dos modos de compatibilidade, a comparação roda o **código de duas pastas** (checkout do commit `e405310` e a árvore atual), com os mesmos fixtures e as mesmas respostas simuladas (`scripts/comparar-custo.mjs`):

```
git worktree add --detach ../alice-antigo e405310
# node_modules compartilhado (junction no Windows / symlink) e: npx tsc -p tsconfig.json  (dentro de ../alice-antigo)
ALICE_ROOT=../alice-antigo COMPARE_OUT=antigo.json node scripts/comparar-custo.mjs
ALICE_ROOT=.               COMPARE_OUT=novo.json   node scripts/comparar-custo.mjs
```

Conferência dos modos de compatibilidade (`AI_CONTEXT_SELECT=off AI_REWRITE_MODE=legacy AI_SECOND_READING=always` na árvore atual): as **sequências de chamadas** foram iguais às do commit anterior em 11 de 11 cenários (inclusive as exceções da segunda leitura), mas o **texto do prompt não é idêntico** (cerca de 32 tokens a menos por chamada: lista de respondidas removida, `explainLine`). Por isso a tabela usa o checkout antigo como "antes".

"Contexto" = tamanho da **primeira chamada principal** do atendimento; a soma por atendimento (todas as chamadas, entrada e saída separadas) está na tabela. Tokens = caracteres/4 (**aproximação**), OpenAI simulada.
