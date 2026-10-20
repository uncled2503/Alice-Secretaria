# Landing page comercial da Alice (reformulação, 21/10/2026)

Arquivos: `public/site/index.html`, `public/site/site.css`, `public/site/site.js`, `public/site/boot.js`, `public/site/privacidade.html`, `public/assets/logo-site.png` e `logotipo-branca-site.png` (cópias reduzidas dos arquivos oficiais, que seguem intactos). Backend de captação: `src/site/leads.ts` (`POST /site/lead`), tabela `SiteLead`, listagem para admin `GET /api/site-leads`.

Nada do painel administrativo nem do produto foi alterado. Estado: **local, sem commit, sem push, sem deploy.**

## O que foi preservado da página antiga
Somente: as **ondas** entre as seções (`.wsep`) e a **luz** que corre na costura de cada onda (`.wsep-light`, animação `snake-dash` por `stroke-dashoffset`). A implementação real estava em `public/site/site.css` (blocos "Ondas entre as seções" e "Luz correndo") e no markup de cada divisor em `index.html`; a estrutura (dois `<svg>` por divisor: onda preenchida + trilho/brilho na mesma curva aberta) foi mantida, com 10 ondas, durações diferentes e sentido alternado. Acréscimo: a luz **pausa fora da tela** e com o botão "Pausar animações".

## Copy e design
- **Posicionamento:** "Seu próximo cliente não pode ficar esperando." → dor → jornada → demonstração → recursos → segmentos → controle → implantação → planos → dúvidas → fechamento com formulário.
- **Removido** por falta de evidência/aprovação: "100% das conversas respondidas", "+40% de aproveitamento", "configurada em até 30 minutos", "24 horas por dia", garantia de 7 dias/devolução, "sem fidelidade", **preços dos planos** (a página antiga mostrava valores, por exemplo R$ 1.397/mês no Prestige), limites por plano, depoimentos e a faixa de números. Substituídos por benefícios concretos e por um bloco "Encontre a configuração ideal para sua operação" apontando para a demonstração.
- **Visual:** laranja da Alice como destaque (botões em `#b45309` por contraste), fundos creme/branco e três áreas escuras pontuais (dor, controle, fechamento), Poppins, ícones de uma única família (traço 1,8), mockups em HTML/CSS identificados como "demonstração ilustrativa com dados fictícios". Logo oficial preservado (cópia reduzida do mesmo arquivo; o original é um PNG com extensão `.webp`).
- **Textos, títulos e CTAs são HTML real.** Nenhuma imagem de título/botão.
- **Prints reais do produto:** **não** foram usados; as telas são composições demonstrativas identificadas. Substituir por prints reais (com dados sintéticos) é uma pendência.

## Seções e CTAs
| Local | Texto | Destino |
|---|---|---|
| Cabeçalho | Quero conhecer a Alice | `#demonstracao` (formulário) — `data-cta="header"` |
| Cabeçalho / menu / rodapé | Já sou cliente | `/admin` (link secundário) |
| Hero | Quero conhecer a Alice | `#demonstracao` — `hero-principal` |
| Hero | Ver como funciona | `#como-funciona` — `hero-secundario` |
| Planos | Quero conhecer a Alice | `#demonstracao` — `planos` |
| Segmentos | Quero ver para {segmento} | `#demonstracao` + preenche o segmento |
| Formulário | Quero conhecer a Alice (enviar) | `POST /site/lead` |
| Formulário / CTA fixo mobile | Conversar pelo WhatsApp | `https://wa.me/553298095202?text=…` (abre a conversa; **não envia**) |
| CTA fixo (mobile) | Quero conhecer a Alice | `#demonstracao` — some perto do formulário e do rodapé |

Nenhum botão comercial leva ao login.

## Animações
1. Entrada suave da primeira dobra (texto e mockup, em sequência). 2. Aparição ao rolar com *stagger* (cards, passos, FAQ). 3. Ondas entre seções. 4. Luz nas ondas. 5. Mockup flutuante discreto (pausa fora da tela). 6. Conversa demonstrativa com mensagens em sequência e indicador "digitando". 7. Transição entre abas. 8. Hover/foco/pressionado/carregando nos botões. 9. Cabeçalho muda ao rolar. 10. Accordions com transição de altura. 11. Progresso visual da jornada (linha preenchida e passos concluídos conforme a rolagem). 12. Troca animada do detalhe de segmento. Só `transform`/`opacity` (exceto a altura do accordion). **Respeita `prefers-reduced-motion`** (tudo aparece de uma vez, sem luz animada), há botão **"Pausar animações"** (guardado no navegador), sem rolagem controlada, sem parallax, sem cursor, sem som, sem vídeo, sem carrossel.

## Captação
- `POST /site/lead` (JSON): nome, WhatsApp com DDD (normalizado por `canonicalBrPhone`), empresa, segmento (obrigatórios), volume (opcional) + origem (UTM, `gclid`, `fbclid`, página de origem, landing) guardada na sessão do visitante.
- Proteções: limite por IP (6/min e 25/h), teto por origem (15/h, por HMAC do IP — o IP não é guardado), campo isca (`website`), checagem de `Origin`, tamanho/limpeza dos campos, validação no servidor, **um registro por telefone** (reenvio só atualiza `submissions` e preenche o que faltava), corrida entre duas requisições tratada.
- **Nunca simula sucesso:** o servidor só responde `ok` depois de gravar; falha → erro claro e **os dados preenchidos ficam no formulário**.
- Destino: tabela `SiteLead` (status `novo`). A equipe comercial vê em `GET /api/site-leads` (admin). **Não há notificação automática** (WhatsApp/e-mail) nem disparo ao visitante: ver pendências.
- Privacidade: aviso com link para `/privacidade.html` (descreve o que é coletado). Sem checkbox pré-marcado.

## Mensuração
Eventos disparados no navegador (sem IDs de terceiros; sem nome/telefone/empresa): `alice_cta_click {cta_id}`, `alice_whatsapp_click {cta_id}`, `alice_form_start`, `alice_lead_submitted {segment}` (**só depois** da confirmação do servidor), `alice_segment_select {segment}`, `alice_demo_interaction {tab}` (1× por aba), `alice_client_link_click`. Saem por `window.dataLayer.push` (se existir) e pelo evento `alice:track` do `window`. Não havia tracking antes; **nenhum pixel/ID foi inventado** — para ligar GTM/Meta/GA basta alguém instalar o contêiner (a CSP atual só permite scripts do próprio domínio: isso precisa ser decidido junto).

## Dependências comerciais / de integração NÃO confirmadas
1. **Planos e preços:** nenhum confirmado como aprovado; a página não mostra preço nem limite.
2. **Número de WhatsApp comercial** `553298095202`: veio do site anterior (botão flutuante e JSON-LD); confirmar que é o contato comercial vigente.
3. **Google Agenda:** a integração existe, mas depende de credenciais no servidor; a página fala "conforme a integração configurada".
4. **Destino dos leads:** hoje só banco + API admin; falta decidir quem é avisado e como.
5. **Política de Privacidade:** texto factual sobre o formulário; **revisar com o jurídico** (retenção, controlador, canal do titular).
6. **Prova social:** nenhum depoimento/logotipo/número foi usado. Se houver cliente que autorize, entra como seção própria.
7. **Prints reais do produto** (com dados sintéticos) no lugar das telas ilustrativas.
8. **Imagem de compartilhamento:** usa o `logo-personagem` existente (1347×1168); uma arte 1200×630 oficial melhoraria o card social.

## Atualização — reformulação final (out/2026)

- **Foco:** geração de leads com "7 dias grátis" (hero, planos, formulário, CTA fixo, FAQ e mensagem do WhatsApp). Condições do teste NÃO definidas: o texto diz que são apresentadas no contato.
- **Hero:** wordmark "alice." (o mesmo passa a acompanhar o menu depois que o hero sai da tela), imagem leve (`hero-960/1672.jpg`, `hero-hd.jpg`), cartões flutuantes, botão verde "Testar 7 dias grátis".
- **Seções novas/redesenhadas:** "dia a dia" em vermelho (X, alertas, tremida); jornada em S fixada no desktop; "Veja o produto" com fundo aquarela e ondas sobrepostas; "Recursos" em verde (selo ✓, etiquetas); segmentos em carrossel 3D (card da frente = selecionado; clique pausa o giro; painel com altura fixa); "Personalização" com 8 benefícios dentro da imagem; **Alice + Meta Ads** em azul (kanban → sinal → campanha; sem prometer número, com condição explícita); "Implantação" em 4 passos simples com linha que se completa.
- **Animações:** ondas com luz (snake-dash), cartões flutuantes, jornada em S, X/✓ que "carimbam", carrossel, kanban→Meta, linha dos passos. Todas respeitam `prefers-reduced-motion` e o controle "Pausar animações"; fora da tela as contínuas pausam (`.is-off`).
- **Desempenho:** hero de 1,6 MB → 120 KB (srcset 960/1672/3344); animações pausadas fora da tela; imagens abaixo da dobra com `loading=lazy`; fontes sem bloquear. Medição de LCP/TBT só é confiável em máquina ociosa (as medidas locais deste ambiente carregado não valem).
- **CTAs (data-cta):** hero-principal, hero-secundario, planos, formulario, meta-ads, segmento, sticky, WhatsApp flutuante.
- **Dependências comerciais NÃO confirmadas:** condições do teste de 7 dias, planos/preços, número comercial do WhatsApp, revisão jurídica da política de privacidade, telas reais do produto no lugar das ilustrativas, arte de OG, e a integração Meta (precisa de conta, dataset/WABA e token; nunca validada com lead real de anúncio).
