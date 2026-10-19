# Pesquisa de satisfação, avaliação no Google e indicação (Lisboa) — 18/10/2026

> **O link correto de avaliação da Lisboa no Google NÃO foi informado.** Nada neste documento (nem no código) o inventa. O link hoje gravado no banco veio de uma migração de 16/10 e **nunca foi conferido**: o sistema o trata como **pendente** e não o envia até alguém confirmar o destino.

## 1. O fluxo, em etapas separadas

| # | Etapa | Quem faz | Persistência |
|---|---|---|---|
| 1 | **Pesquisa 0–10** após o atendimento concluído | job `pesquisa-satisfacao` (`reminders/nps.ts`) | `FollowUpDispatch` (flow `pesquisa`) + `SatisfactionSurvey` |
| 2 | **Nota**: lida e gravada | o **código** (`surveyReply.ts` + `surveyHandler.ts`), antes do modelo | `SatisfactionSurvey` (nota, faixa, reclamação, id da mensagem) |
| 3 | **Agradecimento** (+ link do Google se confirmado) | resposta fixa do sistema (`surveyFlow.thankYouText`) | `Message` (entrega rastreada) |
| 4 | **Convite de indicação** — mensagem **separada** | job `convite-indicacao` (`surveyFlow.runReferralSteps`) | `FollowUpDispatch` (flow `indicacao`) |

## 2. Frequência: no máximo 1 pesquisa a cada 15 dias por pessoa

- **Semântica:** janela **móvel** contada do **último envio** da pesquisa à mesma pessoa. A próxima só pode sair quando passam 15 × 24 h; **no instante exato dos 15 dias já pode**, um minuto antes não.
- Vale **entre procedimentos, profissionais e reservas** (a chave é a pessoa) e é **restrita à clínica**. Conta o que pode ter chegado: pesquisa enviada, ou com **timeout** (`unconfirmed`). **Não** contam falha de envio, veto da revisão, bloqueio de plano nem duplicada.
- Quem está dentro da janela **não entra em fila**: a pesquisa daquele atendimento é descartada e **registrada** (`skipped`, camada `politica`, motivo e próxima data permitida). Quando completam 15 dias ela **não dispara** para compensar.
- Não depende de cache em memória nem de a pessoa ter respondido a anterior. Persiste após reinício; rodadas sobrepostas disputam a mesma reserva atômica.
- Identidade: a pessoa é a linha de `Patient` (clínica + telefone) e, quando mais de uma linha tem o **mesmo vínculo do Clínica Experts** (`ceUuid`), elas são a mesma pessoa (o diagnóstico sinaliza `identidade.ambigua`). **Nunca** se une por telefone parecido.
- Mantido: só atendimento `completed` (cancelado/falta não recebem), nunca para quem pediu para sair, espera o pós-procedimento, espera atendimento humano em curso, respeita o expediente. A **avaliação clínica** continua sendo atendimento concluído (texto próprio da avaliação) e **conta** para a frequência.

## 3. Como a nota é lida

- Número **sozinho** (`10`, `9!`, `dez`) só vale se a **última pergunta da Alice foi a pesquisa**.
- Marca clara vale sempre: `nota 9`, `dou 10`, `10/10`, `8 de 10`, `nota dez`.
- **Não** é nota: horário (`às 10`, `10h`, `10:30`), data (`dia 10`, `10/11`, `10 de novembro`), quantidade (`10 sessões`, `10 reais`), idade (`tenho 10 anos`), `9,5`, `um/uma/dois` sozinhos, mais de um número. Nesses casos a conversa segue normalmente e a pesquisa continua pendente.
- `10, amei o atendimento` → nota 10 com comentário. `Nota 9, mas tive um problema` → nota **com reclamação**: agradece, avisa a equipe e **não** manda link nem convite.
- A mesma mensagem **nunca grava duas vezes** (atualização atômica + `answeredByMessageId`).
- **Política de "nota positiva" (a que já existia, mantida):** `Clinic.npsThreshold` (padrão **9**). `≤ 6` = baixa (aviso à equipe); entre 7 e o corte−1 = neutra (só agradece). Nenhum limiar foi alterado.

## 4. Link do Google (uma fonte só)

- Fonte: `Clinic.googleReviewUrl`. Só é enviado se (a) tem **formato de link de avaliação do Google** (`g.page/r/<código>/review`, `search.google.com/local/writereview…`, `maps.app.goo.gl/…`; **página de busca não vale**) **e** (b) `googleReviewConfirmedAt` está preenchido.
- **Validar a URL não prova que ela é da Lisboa.** Por isso a confirmação é um ato explícito, com **quem conferiu** e o **nome do estabelecimento** que o link abre (`googleReviewConfirmedBy`, `googleReviewPlace`): painel (digitar um link **novo** confirma; salvar outra configuração com o mesmo link **não**) ou `POST /api/clinics/lisboa-google` (admin; prévia por padrão).
- **Compatibilidade não é validação (19/10/2026).** A migração `20261018110000` marcava como "confirmado" o link das outras clínicas que já tinham um cadastrado, para elas continuarem enviando — o que atribuía uma conferência que ninguém fez. A migração `20261019100000_google_compat_sem_validacao` (por cima, sem reescrever a anterior, que pode já ter sido aplicada) desfaz essa marca e grava `Clinic.googleReviewLegacyAllowed`: o envio continua **por compatibilidade com o comportamento anterior**, e o estado do link passa a dizer isso (`base: "compatibilidade"`, `destinoConferido: false`). Só a confirmação explícita (quem/quando/estabelecimento) vale como validação. Mudar ou apagar o link no painel zera a compatibilidade. A Lisboa nunca recebeu a marca e **nunca** envia por compatibilidade.
- Enquanto ausente / inválido / não confirmado: a Alice **agradece normalmente**, **não envia link**, registra a pendência (`google_review_pending`) e avisa a equipe (no máximo 1×/dia). A conversa nunca fica sem resposta.
- A prévia da Lisboa lista **outros links do Google espalhados** em FAQs, mensagens prontas, regras, roteiros e textos da pesquisa (conflitos com o cadastrado). O seed deixou de gravar o link.
- URLs de teste existem **somente** em `tests/` e não podem aparecer em `src/`.

## 5. Convite de indicação

- É uma mensagem **separada** (outro envio, outro registro), nunca um parágrafo do agradecimento, e **não depende do divisor de mensagens longas**.
- **Desligado por padrão.** Só existe com `ResumeFlowConfig(flow = indicacao)` ligado, **texto aprovado** e **intervalo** (`delayMinutes`) definidos pela clínica — **o intervalo não foi definido: nada foi presumido**.
- Texto: convida a **própria cliente** a compartilhar o contato da clínica (sugestão em `reviewLink.DEFAULT_REFERRAL_TEXT`). O sistema **recusa** texto que peça nome/telefone de terceiros ou ofereça recompensa/desconto/brinde.
- Antes de enviar (cada item é registrado): agradecimento **entregue** (falha definitiva = não convida; em andamento = espera), sem reclamação/opt-out/atendimento humano, conversa **quieta por 30 min**, no expediente, não passou de 24 h do previsto, uma vez por 90 dias. Provedor fora do ar tenta de novo; timeout **não reenvia**; veto da revisão é **temporário**.
- "Obrigada/ok" depois da pesquisa ou do convite só agradece (a automação do convite se identifica como "Pesquisa de satisfação (indicação)").

## 5b. Nota recebida com a conversa na equipe (19/10/2026)

Três coisas separadas: (1) **reconhecer e registrar** uma resposta válida ligada a uma pesquisa pendente; (2) **permissão para a Alice responder**; (3) **permissão para enviar Google ou indicação**. Com atendimento humano ativo só a (1) existe: a nota é registrada (mesmas regras de leitura; número solto só vale se a última fala foi a pesquisa — se a equipe falou depois, é ambíguo e **não** vira nota), a equipe é avisada nos casos que pedem retorno (nota baixa, reclamação), e **nada** é escrito para a pessoa: sem agradecimento, sem link, sem convite — nem depois que a pausa acabar (`linkState = atendimento_humano`; o tratamento seguinte dessa mensagem é silêncio). Idempotente por id da mensagem, também no reprocessamento do evento.

## 6. Diagnóstico

`GET /api/patients/:id/pesquisa-diagnostico`: atendimento de origem, última pesquisa e **quando pode receber a próxima**, nota e pesquisa associada, cada etapa (estado, camada, motivo, se é temporária, quando reavaliar, versão do código) e a situação do link (cadastrado? válido? confirmado por quem e quando? estabelecimento conferido). Distingue **ausência de configuração**, **bloqueio por frequência** e **falha técnica**. O resumo por rodada está em `GET /api/automations/diagnostico` (jobs `pesquisa-satisfacao` e `convite-indicacao`).

## 7. Pendências (dependem da clínica)

1. **Link correto de avaliação da Lisboa** (e o nome do estabelecimento que ele abre). Hoje: link de 16/10 não conferido → não é enviado.
2. Se a clínica quer o **convite de indicação**; texto aprovado e quanto tempo depois do agradecimento.
3. Se o limiar de "nota positiva" (9) está certo para a Lisboa.
