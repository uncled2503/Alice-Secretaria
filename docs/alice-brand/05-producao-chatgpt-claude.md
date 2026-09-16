# Como produzir o motion com ChatGPT/Astra e Claude

Guia consultado em 15/09/2026. Os prompts abaixo são instruções criativas propostas para este projeto; não são exemplos copiados das plataformas.

## 1. Escolha o caminho pelo resultado desejado

| Objetivo | Caminho | O que você recebe |
|---|---|---|
| Organizar a história e a direção visual | ChatGPT com Astra, quando disponível na sua conta, ou Claude com este pacote anexado | Roteiro, storyboard, revisão e especificações |
| Aprovar uma primeira animação interativa | Claude Artifacts com HTML/React; ou ambiente do ChatGPT que permita executar e visualizar código | Prévia para avaliar ritmo e aparência; verificar as ferramentas disponíveis na sessão |
| Produzir um MP4 com texto e interface consistentes | Codex com Astra ou Claude Code em um projeto Remotion | Código editável, prévia e vídeo renderizado, depois de executar o projeto e revisar o resultado |
| Montar visualmente em um editor que você já usa | Levar roteiro, assets, locução e quadros ao editor | Filme montado na timeline, com exportação feita pelo editor |

**Recomendação para a Alice:** usar ChatGPT/Astra para roteiro e revisão e produzir o motion em Remotion com Codex ou Claude Code. É uma escolha de fluxo de trabalho para manter textos, marca e componentes consistentes. As duas ferramentas também podem fazer roteiro e código; essa divisão é uma conveniência, não exclusividade técnica.

O [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) é documentado para raciocínio, código e trabalho com ferramentas; o modelo base não tem saída nativa de vídeo ou áudio. Acesso ao modelo e ferramentas no ChatGPT depende do que sua conta disponibiliza. Gerar código de animação é uma etapa; obter MP4 exige uma ferramenta de renderização.

O [Claude Artifacts](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) permite conteúdos como HTML, SVG e componentes React, úteis para uma prévia. A documentação atual pede a capacidade de execução de código e criação de arquivos habilitada. Uma prévia em HTML/React não comprova que um MP4 foi exportado; confira o arquivo final.

O [Remotion documenta o uso com Codex e Claude Code](https://www.remotion.dev/docs/ai/coding-agents). Nesse fluxo, o agente escreve o projeto e o Remotion renderiza o vídeo. Verifique condições de licença da ferramenta e dos assets para seu uso comercial; este guia não pressupõe gratuidade ou uma assinatura específica.

## 2. Contexto que você deve levar para qualquer ferramenta

Anexe os arquivos 01, 02, 03, 04 e `alice.tokens.json` desta pasta. Inclua o logotipo, sua versão branca e a personagem de `public/assets/`. O arquivo 02 é a referência sobre recursos; o 03 define a proposta visual; o 04 define a história. Se tiver limite de anexos, use `ALICE-CONTEXTO-PARA-IA.md`, o roteiro e os assets.

Use capturas de um ambiente de demonstração com contatos fictícios. Não é necessário dar acesso ao banco de produção para criar o motion.

## 3. Prompt para ChatGPT/Astra: direção e roteiro

```text
Atue como diretor de criação e motion designer da Alice. Use os materiais
anexados como fonte do produto e da marca.

Alice é uma assistente virtual com IA para atendimento no WhatsApp, com CRM,
agenda e automações de acompanhamento. Neste filme, fale com gestores de
clínicas de estética. Conceito: “Do primeiro contato ao próximo passo”.
Objetivo: gerar pedidos de demonstração. CTA: “Agende uma demonstração”.

Leia o inventário antes de escrever. Diferencie recursos implementados em
código, recursos que dependem de configuração e sugestões ainda não implantadas.
Não invente métricas, depoimentos, disponibilidade garantida ou funcionalidades.

Parta do roteiro de 60 segundos anexo. Entregue:
1. Uma síntese da promessa em uma frase.
2. Locução em português brasileiro, com pausas naturais e ensaio de duração.
3. Storyboard com tempo, voz, texto na tela, componentes, ação e transição.
4. Oito quadros-chave seguindo tokens e assets existentes.
5. Uma revisão de legibilidade e correspondência com os recursos do produto.

Preserve o logotipo e a personagem. Fundo #FFFAF2; texto #231A12; CTA #C2410C
com branco; âmbar #F59E0B decorativo. Use tipografia Poppins nos títulos.
Mostre o atendimento humano e o histórico preservado na transferência.
Use contatos fictícios; a interface representada deve ser identificada como
demonstração. Faça escolhas de criação e marque suposições sem interromper
por detalhes menores. Se uma ferramenta de geração ou exportação não estiver
disponível, entregue os arquivos de projeto e explique o passo restante.
```

Após ver os quadros, peça uma revisão concreta: “Na cena 3, aumente o texto do balão e reduza a conversa a duas mensagens; preserve as outras cenas”. Pedidos por cena mantêm as revisões rastreáveis.

## 4. Prompt para Claude: prévia em Artifact

```text
Crie um Artifact em HTML, CSS e JavaScript autocontido para pré-visualizar
um motion da Alice, usando o roteiro e os assets anexados.

Monte uma timeline de 60 segundos com oito cenas:
0–7s rotina; 7–13s apresentação; 13–23s conversa; 23–31s agenda;
31–39s CRM; 39–47s lembrete e recontato; 47–54s equipe assume;
54–60s logo e CTA.

Inclua play/pause, reiniciar, scrubber de 0 a 60s, navegação por cena e uma
alternância entre 16:9 e 9:16 com recomposição real dos elementos.
Os controles ficam fora da área do filme. A animação deve depender de uma
única variável de tempo para que pausar e buscar funcionem com precisão.
Não use timers independentes que se desencontrem ao repetir.

Leia os tokens anexados. Visual: creme, laranja escuro, âmbar, Poppins,
cartões limpos e a mesma linha ligando conversa, contato e agenda.
Use SVG/CSS para ícones e interfaces. Preserve imagens originais da marca.
Se anexos não puderem ser carregados no Artifact, use um espaço reservado
claramente identificado e explique como substituir; não redesenhe o logo.

Use somente dados fictícios. Mostre lembrete para quem agendou e recontato
para OUTRO contato sem resposta. Depois de “Assumir conversa”, mostre o
estado humano. Nenhuma métrica ou prova social inventada.

A prévia deve funcionar sem som, com textos de tela e opção de legendas
da locução. Inclua estado estático para prefers-reduced-motion e permita
reprodução por comando do usuário. Entregue o arquivo-fonte para download.
Identifique este resultado como prévia interativa; não afirme que existe
MP4 exportado sem entregar e verificar esse arquivo.
```

Essa prévia serve para aprovar enquadramento e ritmo. Evite usar uma gravação com cursor, controles e notificações como master final do vídeo.

## 5. Prompt para Codex/Astra ou Claude Code: produção em Remotion

Use este prompt num projeto de vídeo separado. Ele não depende de o aplicativo Alice ser escrito em React.

```text
Implemente o motion Alice em um projeto Remotion separado do aplicativo.
Leia brief/04-roteiro-motion.md, brief/03-design-system.md e
brief/alice.tokens.json. Consulte brief/02-inventario-funcional.md para
conferir os recursos mostrados. Não altere o backend nem o painel Alice.

Crie as composições Alice60Horizontal (1920x1080) e Alice60Vertical
(1080x1920), ambas 30 fps e 1.800 quadros. Reorganize a composição vertical;
não apenas corte a horizontal. Use oito cenas com os intervalos do roteiro.

Componentes reutilizáveis: BrandLockup, ChatBubble, LeadCard, CalendarSlot,
StatusBadge, FlowLine, HumanHandoff e EndCard. Carregue logo, personagem,
fontes e áudio de arquivos locais. Não invente assets ausentes.

Animações devem ser determinísticas a partir de useCurrentFrame,
interpolate e/ou spring. Use Sequence para organizar cenas. Não use
Date.now, Math.random sem seed ou animações CSS dependentes do relógio.
O mesmo quadro deve produzir a mesma imagem em prévia e render.

Use os textos do roteiro, dados fictícios e marcações de demonstração.
Garanta que consulta de disponibilidade preceda confirmação e que recontato
por silêncio apareça em contato diferente daquele já agendado.

Organize textos e timings em dados editáveis. Se não existir locução,
entregue uma versão muda identificada como animatic; não simule arquivo
de voz. Quando a gravação existir, ajuste tempos e legendas a partir dela.

Renderize primeiro um quadro de cada cena e um teste de 10 segundos.
Inspecione textos, margens, assets, continuidade e erros do renderer.
Corrija problemas e depois exporte os MP4 finais. Verifique duração,
resolução, áudio (quando fornecido) e início/fim da timeline.
Entregue código, comandos para reproduzir, MP4 e legendas sincronizadas
quando houver locução. Relate o que foi efetivamente renderizado.
```

### Preparação técnica, para quem executar localmente

O comando oficial de criação abaixo deve ser executado em uma pasta de trabalho escolhida para o vídeo, não como substituição do projeto Alice. Os comandos são referência para a produção futura; não foram executados nesta entrega.

```powershell
npx create-video --yes --blank alice-motion
Set-Location -LiteralPath ./alice-motion
npm install
npx remotion skills add
npm run dev
```

Em outra janela, abra o agente que já está configurado no seu ambiente (`codex` ou `claude`) dentro de `alice-motion`, copie este pacote para `brief/` e os assets da marca para `public/brand/`, e envie o prompt acima.

Depois de o agente criar os IDs de composição e confirmar que a entrada é `src/index.ts`, os comandos de render esperados são:

```powershell
npx remotion render src/index.ts Alice60Horizontal out/alice-60-horizontal.mp4 --codec=h264
npx remotion render src/index.ts Alice60Vertical out/alice-60-vertical.mp4 --codec=h264
```

Se a entrada gerada tiver outro nome, use o caminho informado pelo projeto. A [documentação da CLI de render](https://www.remotion.dev/docs/cli/render) descreve entrada, composição e destino. No PowerShell, parâmetros de propriedades complexos devem ser passados por arquivo JSON quando necessário.

## 6. Prompt de revisão final

```text
Revise este motion contra o inventário Alice e o roteiro aprovado.
Avalie mensagem, sequência real das ações, leitura em celular, contraste,
marca, continuidade de personagens, timing de locução e CTA.
Liste problemas por cena com: problema, impacto e correção específica.
Separe erros factuais de sugestões estéticas. Confira se o resultado
entregue é um vídeo real ou somente uma prévia/código. Não considere
receita, conversão ou velocidade de resposta como comprovadas pelo desenho.
```

## 7. Ordem prática

1. Consolidar posicionamento e confirmar público/CTA.
2. Revisar oito quadros estáticos.
3. Gravar uma locução de teste e ajustar o ritmo.
4. Aprovar uma prévia de dez segundos com chat e transição para agenda.
5. Animar o restante, aplicar locução/trilha e legendar.
6. Renderizar e conferir horizontal e vertical; criar cortes de 30 e 15 s.

O projeto de vídeo deverá manter sua própria pasta e dependências. Este pacote é o briefing completo de produção, não uma instalação de Remotion no produto.
