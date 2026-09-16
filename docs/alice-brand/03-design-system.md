# Alice — design system v1

**Status:** auditoria do código atual + proposta de unificação. **Data:** 15/09/2026. Nenhum componente abaixo foi alterado no aplicativo por esta entrega. O arquivo `alice.tokens.json` descreve a proposta, não o CSS já implementado.

## 1. Direção de design

**Uma assistente próxima, com uma operação organizada à vista.** A identidade combina o calor do laranja/âmbar, a personagem já existente e interfaces que tornam visível o caminho da conversa até o próximo passo do cliente.

Princípios propostos:

1. **A conversa é o ponto de partida.** Chat, contato, funil e agenda devem parecer partes do mesmo atendimento.
2. **A equipe entende o que aconteceu.** Mostrar autor, status, histórico e próxima ação; distinguir Alice e pessoa por texto, além da cor.
3. **Calor na marca, clareza na operação.** Âmbar dá destaque; informação operacional fica em superfícies estáveis e legíveis.
4. **Controle sem sobrecarga.** Uma ação principal por contexto, ajuda perto do campo e configuração progressiva.
5. **Movimento explica a mudança.** Um contato saindo de uma conversa e entrando no funil comunica mais que efeitos decorativos contínuos.

## 2. O que já existe

### 2.1 Escopo e limites da auditoria

Inspeção estática de `public/index.html`, `public/styles.css`, `public/app.js`, `public/site/index.html`, `public/site/site.css` e `public/site/site.js`; inspeção visual do logo existente. Não houve acesso a contas, banco de dados, `.env` nem conversas reais. As referências de linha são um retrato desta versão do repositório. A presença de controles e funções comprova implementação de interface; não certifica disponibilidade comercial nem funcionamento de integrações em produção.

### 2.2 Painel e site hoje

| Fundação | Painel atual | Site atual | Unificação proposta |
|---|---|---|---|
| Cor principal | `--accent: #EA580C`; botão `.btn-brand` usa `#C2410C` | `#D97706`; gradiente até `#F59E0B` | CTA `#C2410C`; âmbar para decoração e destaque com texto escuro |
| Tema claro | Fundo `#F7F7FB`, cards brancos, texto `#1A1A2E` | Branco e `#FFFAF2`, texto `#231A12` | Neutros quentes compartilhados |
| Tema escuro | Fundo `#0D0D0D`, cards `#1C1C1C`, texto `#F0F0F0` | Não há tema escuro no CSS inspecionado | Tema escuro quente, definido nesta proposta |
| Tipografia | `system-ui`, Segoe UI, Roboto | Poppins 400/500/600/700 via Google Fonts | Poppins em títulos de marca; system-ui no corpo e UI |
| Layout | Sidebar 240 px; conteúdo até 1.600 px; chat 300 px + conversa | Container 1.120 px, gutters 20 px, seções de 66 px | Escala de 4 px; layouts próprios sobre as mesmas bases |
| Forma | Cards ~10–14 px; botões novos pill; legados 6–8 px | Cards 16/24 px; botões pill; ondas entre seções | Card 16 px, campo 8 px, pill para ações principais/etiquetas |
| Movimento | Hover 150 ms; gaveta 220 ms; ajuda com entrada e indicador de digitação | Reveal 700 ms; entrada do hero; luz nas ondas em loop | UI rápida; motion de marca mais lento e com função narrativa |
| Responsivo | Quebra principal 860 px; agenda 900 px; cards 460 px | Hero 940 px; menu 720 px; ajustes 600/460/420 px | Consolidar após teste; preservar a intenção dos layouts atuais |

**Evidências:** `public/styles.css:12`, `:39`, `:214`, `:294`, `:594`, `:1039`, `:1351`; `public/site/site.css:8`, `:44`, `:94`, `:202`, `:765`; `public/site/index.html:48`.

O comentário inicial de `public/site/site.css` menciona “paleta roxa”; os valores efetivos são âmbar. Considerar esse comentário desatualizado, não uma orientação de marca.

### 2.3 Marca e arquivos existentes

| Arquivo | Uso atual / uso proposto |
|---|---|
| `public/assets/logo.webp` | Assinatura horizontal ALICE IA, personagem com headset/antena; usar sobre superfície clara |
| `public/assets/logotipo-branca.webp` | Assinatura para fundo escuro; usada no login escuro |
| `public/assets/logo-personagem.webp` | Mascote/ícone isolado no painel, site e ajuda |
| `public/assets/icon-192.png`, `icon-512.png` | Ícones do aplicativo |
| `public/assets/favicon-32.png`, `apple-touch-icon.png` | Ícones de navegador e dispositivo |

**Regras propostas:** preservar proporções e cores dos arquivos; área livre mínima igual a 1/4 da altura do símbolo; assinatura horizontal com largura mínima de 140 px em UI, sujeita a inspeção na tela final; mascote com mínimo de 32 px em interface. No vídeo, respeitar a leitura na tela de celular. Sobre escuro usar assinatura branca ou mascote sobre selo claro, como o painel já faz. Não distorcer, redesenhar o lettering, aplicar contornos improvisados ou atribuir uma nova fonte à marca desenhada. Fontes de interface não substituem o logotipo.

## 3. Biblioteca atual de componentes

### 3.1 Primitivos e pequenos padrões

“Existe” nesta tabela significa encontrado no código. Estados e melhorias marcados **v1** são especificações a implementar.

| Componente | Evidência / seletor | Variantes, estados e interação atuais | Contrato v1 / microcopy |
|---|---|---|---|
| Ícone | `.nav-icon`, `[data-icon]`; `app.js:284` | SVG gerado por `renderIcon`/`paintIcons`; tamanhos 14–18 px nos contextos | Grade 24 px, traço 1,75–2 px; 16/20/24 px; ícone decorativo oculto da tecnologia assistiva; ação só com ícone recebe nome |
| Botão de marca | `.btn-brand`; `styles.css:1039` | `--primary`, `--secondary`, `--sm`, `--icon`; hover, active, focus-visible, disabled; 44/36 px | Preservar pill e 44 px padrão; texto por ação: “Salvar contato”, “Agendar”; acrescentar loading e confirmação de salvamento |
| Botão legado | `.btn-save`, `.btn-approve`, `.btn-discard`, `.btn-cancel`, `.btn-danger-solid`, submit; `styles.css:1116` | Salvar, aprovar, descartar, cancelar, excluir; contrastes/raios distintos | Migrar para `primary`, `secondary`, `tertiary`, `danger`; cancelar não deve compartilhar aparência de exclusão |
| Campo | `.app-shell input/select/textarea`, `.auth-gate input`; `styles.css:950` | Texto, busca, senha, número, e-mail, data/hora, URL, arquivo, cor; foco, placeholder; textarea redimensionável | Label persistente, instrução, erro inline, required identificável, disabled e busy; placeholder nunca substitui label |
| Seleção | Checkbox/radio e `.weekday-picker`; `styles.css:982` | Dias da semana, filtros e ajustes; accent-color da marca | Área de interação de 44 px no rótulo; estado nomeado, sem depender apenas da cor |
| Badge | `.badge-green`, `-neutral`, `-red`, `-amber`, `-plan`; `styles.css:302` | Ativa, estado da conexão, plano, avisos | Separar sucesso/aviso/erro/informação de marca; texto obrigatório: “Conectado”, “Pendente”, “Desconectado” |
| Avatar | `.crm-avatar`, `.chat-avatar`; `app.js:561` | Foto e fallback por iniciais | Foto, iniciais, Alice; não sugerir que a imagem da Alice é de uma atendente humana |
| Etiqueta | `.conv-tag`, `.conv-tag-menu`, `.cp-tags`; `styles.css:644`; `app.js:1037` | Escolher/criar etiqueta; marcador selecionado; excluir globalmente com confirmação | Rótulo legível; remoção com alvo próprio; explicar alcance global na confirmação |
| Card | `.card`, `.rule-card`, `.location-card`; `styles.css:474`, `:1307`, `:1327` | Cards comuns, unidade, regra pendente; header e ações | Raio 16 px, padding 24 px ou 16 px compacto; card informativo sem cursor de ação |
| Cabeçalho | `.page-header`, `.page-subtitle`, `.section-header`; `styles.css:298`, `:1301` | Título, descrição e ação | Um H1 por tela; texto de apoio explica o dado ou próximo passo |
| Abas/filtros | `.settings-tabs`, `.chat-filter-tabs`, `.period-btn`; `styles.css:425`, `:479`, `:596` | Estado `.active`, subpainéis e períodos | Definir semântica e teclado por padrão: navegação versus tablist; seleção visível além da cor |
| Tabela | `table`, `th`, `td`, `td.actions`; `styles.css:543` | Hover, ações por linha, scroll horizontal mobile | Cabeçalhos associados; região de scroll nomeada; loading, vazio, erro e sem resultado |
| Progresso | `.usage-bar`, `--near`, `--over`, `.usage-fill`; `styles.css:650`; `app.js:3886` | Uso, perto do limite e acima do limite | Informar período/unidade do limite; não usar preenchimento como único indicador |
| Spinner | `.spinner`, `#channel-import-spinner`; `index.html:842` | Importação/conexão em andamento | Texto de status e `aria-busy`; animação opcional com movimento reduzido |
| Toast | `#error-toast-container`, `.error-toast`; `styles.css:75`; `app.js:65` | Notificação central com desaparecimento; a mesma função também mostra avisos e sucessos | Separar níveis; erros acionáveis e persistentes quando necessário; `role=alert` para falha crítica, status para sucesso |
| Estado vazio | `.chat-empty`, `.conv-empty`, `.agenda-empty-msg` | Conversa não selecionada, lista sem conversas, agenda vazia | Título + orientação + ação apenas quando aplicável; exemplo: “Nenhuma conversa neste filtro” |
| Código técnico | `code`, saída `<pre>` de diagnóstico | Chaves/instruções/diagnóstico no contexto de integração | Reservar ao contexto técnico; não colocar no vídeo comercial de apresentação |

### 3.2 Componentes compostos do produto

| Família | Elementos reais / comportamento | Estados ou variantes relevantes | Referência |
|---|---|---|---|
| Acesso | Login com usuário/senha, erro de autenticação, entrada no painel | Autenticado, bloqueado, erro; logo claro/escuro | `index.html:18`; `app.js:328` |
| Shell | Marca, seletor de negócio, sidebar por grupos, tema, sessão, Guia | Item ativo; menu mobile com backdrop e Escape; papéis admin/client afetam visibilidade | `.app-shell`, `.sidebar`, `.mobile-topbar`; `app.js:343`, `:445` |
| Início | Saudação, períodos, KPIs, gráfico diário, miniagenda, mapa por DDD e ranking | Clínica/loja, período, plano, uso; números começam com travessão | `#tab-dashboard`; `app.js:3915`, `:4020` |
| Contatos | Busca por nome/telefone, criação, tabela e exclusão | Lista, filtro, formulário expandido, confirmação | `#tab-contacts`; `app.js:479` |
| CRM | Colunas, contadores, avatar, dados, seletor de etapa e arrastar/soltar | `.dragging`, `.drag-over`; algumas etapas abrem valor da venda/agendamento; alerta de dado ausente | `.crm-board`, `.crm-column`, `.crm-card`; `app.js:621`, `:806` |
| Lista de conversas | Filtros Todos/Alice/Humano/Arquivadas; não lidas; tags; arquivar e contato | Selecionada, não lida, arquivada, atendimento humano; ações de lote | `#conversations-list`, `.chat-filter-tabs`; `app.js:901` |
| Conversa | Autor, timestamp, mensagens, eventos, envio, áudio e anexos | `.msg.user`, `.msg.assistant`, `.msg.human`; alternar humano/Alice; rascunho, gravação, falha no envio | `#chat-window`, `#chat-controls`; `app.js:1155`, `:1620`, `:1685` |
| Visualizador de mídia | Imagem/vídeo ampliado, áudio nativo e download | Abrir/fechar, Escape, reprodução; preview/remover anexo | `.media-viewer-*`, `.msg-media`, `.chat-audio-*`; `app.js:18`, `:1736` |
| Ficha do contato | Drawer: Resumo, Agendamentos, Automações, Timeline; campos, etiquetas, responsável e próxima ação | Abrir atendimento, agendar, salvar, remover do CRM; “O que a Alice entendeu” | `#contact-panel-overlay`; `index.html:342`; `app.js:1508` |
| Agenda | Navegação no período, pesquisa, filtros, grade/lista, legenda, profissionais, mini calendário e resumo | Hoje, selecionado, outro mês, com agendamento, cancelado; criação/edição/bloqueio | `#tab-agenda`, `.agenda-*`, `.ag-*`; `app.js:1935`, `:2106` |
| Relatórios | Funil, origem, faturamento por dia/procedimento/profissional, satisfação/NPS | Período e variante do negócio; barras, valor e comentários | `#tab-reports`, `.rp-*`; `app.js:4091` |
| Personalização | Subabas, formulários, tabelas, regras, templates, FAQ, roteiros, unidades | Clínica/loja, plano e papel; edição/criação; pendente/aprovado no aprendizado | `#tab-settings`; lista detalhada na seção 3.3 |
| Modal | Overlay, título, fechar, campos e ações | Normal até 460 px; grande 680 px; no mobile folha inferior; confirmação e ações específicas | `.modal-overlay`, `.modal-card`, `.modal-card-lg`; `styles.css:1178`, `:1418` |
| Guia | Spotlight, popover, progresso, próximo/anterior/encerrar | Passo atual; navegação por áreas | `.tour-*`; `index.html:114`; `app.js:6533` |
| Upgrade | Hero, faixa, botão lateral, cadeado e modal | Somente gratuito: `[data-plan-free]`; ocultar/lock por recurso | `.upsell-*`, `.unlock-cta`, `[data-plan-lock]`; `app.js:3543`, `:3694` |
| Ajuda dentro do painel | Botão da personagem, janela, conversa, texto e envio | Aberto/fechado, digitando, envio desabilitado; mensagens com `aria-live` | `.panel-ai-*`; `index.html:2354`; `styles.css:1429` |

**Distinção importante:** a janela “Ajuda da Alice” auxilia o usuário do painel; o chat principal acompanha o atendimento dos clientes. No design e no vídeo, dar nomes e contextos distintos a essas duas experiências.

### 3.3 Todas as subáreas de configuração presentes na navegação

As 23 subabas estão em `public/index.html:593`. São famílias funcionais construídas com os componentes anteriores, não 23 estilos novos.

| ID da subaba | Conteúdo e componentes principais | Dependência de interface |
|---|---|---|
| `clinic-data` | Dados, identidade de atendimento, expediente, fuso, dias, unidades | Rótulos clínica/loja |
| `briefing` | Entrada de briefing, análise e prévia de configuração | Bloqueado no gratuito |
| `products` | Cadastro de produtos e modal com campos/mídia | Geral |
| `procedures` | Cadastro de procedimentos/serviços, preços e modal | Clínica |
| `staff` | Profissionais e disponibilidade; modal | Clínica |
| `channels` | Estado de conexão, QR, instruções, importar; configuração/diagnóstico por papel | WhatsApp e permissões |
| `broadcasts` | Lista e editor de mensagens programadas, público e data | Bloqueado no gratuito |
| `appt-reminder` | Regras de lembrete de consulta e editor | Clínica, bloqueado no gratuito |
| `post-procedure` | Regras de pós-procedimento e editor | Clínica, bloqueado no gratuito |
| `renewal` | Regras de renovação e editor | Clínica, bloqueado no gratuito |
| `birthday` | Regras de aniversário e editor | Bloqueado no gratuito |
| `followup` | Regras de recontato e editor | Bloqueado no gratuito |
| `funnel` | Etapas, cores e comportamento do funil | Geral |
| `blocks` | Bloqueios de agenda e criação rápida | Clínica |
| `google` | Conexão e configuração do Google Agenda | Clínica, depende da integração |
| `waitlist` | Lista de espera | Clínica, bloqueado no gratuito |
| `history` | Filtros e histórico de atividades | Geral |
| `learning` | Sugestões extraídas dos atendimentos, aprovação/descartar | Bloqueado no gratuito |
| `rules` | Ajustes da Alice, regras, mensagens, FAQ e roteiros | Bloqueado no gratuito |
| `clinics` | Gestão de negócios, conexão, planos e acesso do cliente | Administrador; validar sempre pelo papel |
| `team` | Equipe e contas | Visibilidade condicionada ao papel |
| `external-api` | Chaves de API, criação/revogação e instruções | Bloqueado no gratuito |
| `meta` | Configuração Meta/Pixel, diagnóstico e eventos | Depende de configuração |

**Família de modais existente:** agendamento, produto, procedimento, mensagem programada, lembrete, pós-procedimento, renovação, aniversário, recontato, regra, template de mensagem, FAQ, chave API, bloqueio, roteiro, profissional, upgrade, conexão de negócio, plano, acesso, confirmação, valor da venda e agendamento pelo CRM. IDs terminam em `-overlay`, entre `index.html:1454` e `:2341`. Unificar estrutura e estados; manter os campos específicos de cada tarefa.

### 3.4 Componentes do site

| Componente | Seletores / evidência | Uso e variantes |
|---|---|---|
| Anúncio e header | `.announce`, `.site-header`, `.nav-links`, `.nav-toggle`; `site.css:239` | Navegação fixa, estado `.scrolled`, menu `.open` no mobile |
| Hero | `.hero`, `.hero-grid`, `.eyebrow`, `.hero-cta`, `.hero-mini`; `site.css:311` | Proposta principal, CTA e mockup de conversa |
| Chat demonstrativo | `.chat-top`, `.chat-avatar`; `site/index.html:191` | Conversa ilustrativa; deve ser identificada como demonstração no material comercial |
| Botões | `.btn-primary`, `.btn-ghost`, `.btn-light`, `.btn-lg`, `.btn-block` | Gradiente, contorno/claro, grande/largura total |
| Prova | `.proof-grid`; `site.css:455` | Números comerciais; publicar apenas dados comprovados |
| Comparativo | `.compare-col`, `.tag.good`, `.tag.bad`; `site.css:472` | Situação do atendimento e benefícios |
| Cards | `.cards`, `.card`; `site.css:517` | Públicos, benefícios e recursos |
| Depoimentos | `.testi`, `.testi-card`, `.testi-who`; `site.css:553` | Depoimento, identificação; exigir autorização e evidência antes de divulgar |
| Passos | `.steps`, `.step`; `site.css:579` | Configurar, conectar e começar |
| Planos | `.plans`, `.plan`; `site.css:610` | Comparação e destaque de plano; conteúdo comercial depende de validação |
| FAQ | `.faq details`, `summary`; `site.css:672` | Accordion nativo aberto/fechado |
| Faixa de CTA | `.band`; `site.css:656` | Fechamento com chamada; promessa/garantia deve refletir oferta vigente |
| Rodapé/contato | `.footer-links`, `.footer-bottom`, `.wa-float`; `site.css:709` | Navegação secundária e ação comercial |
| Ondas/reveal | `.wsep`, `.wsep-light`, `.reveal`; `site.css:63`, `:103`; `site.js:16` | Continuidade de marca e entrada em scroll; já há tratamento parcial de movimento reduzido |

## 4. Fundações propostas para a v1

### 4.1 Paleta semântica

Tokens devem descrever o papel, como `text.primary` e `action.primary.background`, evitando espalhar hexadecimais por componente.

| Papel | Claro | Escuro |
|---|---|---|
| Canvas | `#FFFAF2` | `#141210` |
| Superfície | `#FFFFFF` | `#211C18` |
| Superfície secundária | `#FFF7ED` | `#2D251E` |
| Texto principal | `#231A12` | `#FFF7ED` |
| Texto secundário | `#6B5D4F` | `#C6B8AA` |
| Texto discreto, ainda legível | `#796A5C` | `#A6988A` |
| Borda decorativa/divisória | `#E8DDD0` | `#493C31` |
| Borda de campo funcional | `#8F7A66` | `#8F7A66` |
| Ação primária | `#C2410C`, texto branco | `#C2410C`, texto branco |
| Ação primária hover | `#9A3412`, texto branco | `#9A3412`, texto branco |
| Link/acento textual | `#C2410C` | `#FDBA74` |
| Foco | `#C2410C` | `#FDBA74` |
| Realce decorativo | `#F59E0B`, texto `#231A12` | `#F59E0B`, texto `#231A12` |
| Selecionado | `#FFEDD5`, texto `#7C2D12` | `#40290F`, texto `#FDBA74` |
| Sucesso | `#DCFCE7` / `#166534` | `#163322` / `#86EFAC` |
| Atenção | `#FEF3C7` / `#92400E` | `#3F2A0C` / `#FCD34D` |
| Erro | `#FEE2E2` / `#991B1B` | `#411B1B` / `#FCA5A5` |
| Informação | `#DBEAFE` / `#1E40AF` | `#172B46` / `#93C5FD` |

Status são fundo/texto. Bordas decorativas não são indicadores de estado nem delimitadores exclusivos de campos. No tema escuro, manter verde para sucesso e vermelho para erro: o painel atual converte parte dessas cores em âmbar, reduzindo a distinção semântica. Link deve usar sublinhado em texto corrido. Foco: contorno sólido 3 px, offset 3 px e espaço para não ficar cortado.

**Mensagens propostas:** recebido em superfície neutra; Alice em fundo laranja suave; humano em verde suave. Mostrar também “Cliente”, “Alice” ou o nome do atendente. O código já distingue os três papéis por classe; a v1 formaliza rótulos e contraste.

### 4.2 Tipografia

| Token | Tamanho / entrelinha | Peso | Aplicação |
|---|---|---|---|
| `caption` | 12 / 16 px | 400–500 | Metadados secundários; não instruções essenciais |
| `label` | 14 / 20 px | 500–600 | Campos, botões e etiquetas |
| `body` | 16 / 24 px | 400 | Conteúdo padrão |
| `bodyLarge` | 18 / 28 px | 400 | Introduções curtas |
| `titleSmall` | 20 / 28 px | 600 | Cards e diálogos |
| `title` | 24 / 32 px | 600 | Título de tela |
| `heading` | 32 / 40 px | 600 | Seções de marca |
| `displaySmall` | 40 / 48 px | 600 | Hero compacto |
| `display` | 56 / 64 px | 700 | Hero desktop |

Poppins para títulos de comunicação; `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` para UI/corpo. Em tabelas densas, body pode usar 14/20 px. Limitar linhas corridas a cerca de 60–75 caracteres. Valores numéricos e horários usam `font-variant-numeric: tabular-nums`. Títulos não devem depender de caixa alta; caixa alta fica restrita a pequenas etiquetas. Prever fallback de fonte sem deslocamentos excessivos.

### 4.3 Espaçamento, tamanho e layout

- Escala em px: **0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96**.
- Campo/botão padrão: **44 px** de altura; compacto **36 px**, com área maior nas ações frequentes de toque; hero **52 px**.
- Card: **24 px** interno desktop e **16 px** compacto/mobile; distância entre cards **16–24 px**.
- Raios: **4** detalhe, **8** campo, **12** mensagem, **16** card/modal, **24** mockup, **999** pill.
- Layout app: sidebar **240 px**; área de conteúdo até **1.600 px**; gutters **32 px** desktop/**16 px** mobile; inbox **300 px** antes da conversa.
- Layout site: container **1.120 px**; gutters **24 px** desktop/**16 px** mobile; espaço de seção **80 px** desktop/**48 px** mobile.
- Breakpoints propostos: **480, 768, 960, 1280 px**. São uma meta de consolidação, não uma substituição automática das media queries atuais.
- Pequenas telas: navegação em gaveta, chat com uma coluna por vez, filtros que quebram linha, agenda com alternativa em lista, ações fixas sem cobrir conteúdo.
- Camadas: base **0**, sticky **100**, dropdown **200**, drawer **300**, modal **400**, toast **500**, tour **600**. São tokens propostos; o código atual usa outros valores, inclusive toast 3000.

### 4.4 Estados obrigatórios da v1

| Padrão | Estados mínimos e comportamento |
|---|---|
| Carregamento | Preservar o espaço do conteúdo; spinner ou skeleton quando útil; “Carregando conversas…”; não mostrar zero como dado carregado |
| Salvamento | Ação ocupada sem envio duplo; preservar valores; “Salvando…” → “Alterações salvas” |
| Falha | Texto em linguagem de tarefa; instrução de recuperação; manter o trabalho digitado; detalhe técnico em diagnóstico |
| Lista vazia | Distinguir sem dados, sem resultados de filtro e erro; CTA contextual |
| Desabilitado | Motivo próximo quando não for óbvio; controles indisponíveis não devem parecer carregando |
| Recurso do plano | Nome do recurso, benefício e caminho claro para conhecer condições; cadeado acompanhado de explicação |
| Destrutivo | Verbo preciso, nome do objeto, consequência e confirmação quando cabível; foco inicial na opção segura |
| Conectividade | Conectando/conectado/desconectado/erro com texto e ícone; não simular presença disponível |
| IA/humano | Autor, estado da automação e ação de controle inequívocos; transição registrada no histórico |

### 4.5 Microcopy proposta

| Situação | Texto atual ou contexto | Proposta |
|---|---|---|
| Lista de conversas sem seleção | “Selecione uma conversa para ver as mensagens” | Manter; é direto e acionável |
| Envio falhou | “Não consegui enviar. Tente de novo.” | “Mensagem não enviada. Tentar novamente.” com ação e conteúdo preservado |
| Erro técnico global | `Erro de JS…`, `API… HTTP…` exibidos por `showError` | “Não foi possível carregar os contatos. Tentar novamente.”; diagnóstico separado |
| Transferir atendimento | Alternância entre humano/Alice | “Assumir atendimento” / “Devolver à Alice”; confirmar o novo estado |
| Gratuito | “Você está fazendo o trabalho da Alice.” | “Ative o atendimento automático da Alice.” + benefício e condições do plano |
| Identificação da assistente | Texto do formulário diz que nunca se identifica como IA (`index.html`, área de identidade) | “Sou a Alice, assistente virtual da [empresa]. Como posso ajudar?”; comunicação transparente |
| Configuração | “Personalizar Alice” | Manter; instrução: “Defina como a Alice apresenta seu negócio e quando chama sua equipe.” |
| Aprendizado | “O que você quer ensinar para a Alice hoje?” | Manter no contexto correto; deixar claro quando algo aguarda revisão/aprovação |
| CTA de apresentação | Várias promessas comerciais no site | “Conheça a Alice” ou “Ver demonstração”, conforme o destino efetivo |

Esses textos são recomendações editoriais. Não alteram o comportamento existente, as configurações nem o escopo dos planos.

## 5. Acessibilidade e contraste

Meta proposta: WCAG 2.2 AA. Texto comum precisa de pelo menos **4,5:1**; texto grande, **3:1**. Usar a regra de 4,5:1 para toda microcopy simplifica a especificação. Bordas/ícones necessários para entender controles ou estados precisam de **3:1** contra as cores adjacentes. Referências: [contraste de texto](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) e [contraste não textual](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html).

Alvos de toque propostos de **44 × 44 px** são uma escolha do sistema. O mínimo AA da WCAG 2.2 é 24 × 24 CSS px, com exceções e condições de espaçamento; não confundir os dois valores. [Referência W3C sobre alvos](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).

### 5.1 Contrastes calculados

Cálculo por luminância relativa sRGB; valores exibidos com duas casas. O teste compara o valor completo, sem arredondar para aprovar. São pares sólidos, sem opacidade, blur ou imagem ao fundo. Verificar composições reais no momento da implementação.

| Par de cores (texto / fundo) | Razão | Leitura |
|---|---:|---|
| Atual: branco / `#EA580C` | 3,56:1 | Insuficiente para texto comum; afeta botões legados/badge de plano |
| Atual: branco / `#D97706` | 3,19:1 | Insuficiente para texto comum no início do gradiente do site |
| Atual: branco / `#F59E0B` | 2,15:1 | Insuficiente inclusive para texto grande no extremo claro do gradiente |
| Atual: `#9CA3AF` / branco | 2,54:1 | Texto discreto do painel insuficiente para texto comum |
| Atual: `#9A8B7C` / branco | 3,30:1 | Texto discreto do site insuficiente para texto comum |
| Atual: `#787878` / `#1C1C1C` | 3,86:1 | Texto discreto escuro insuficiente para texto comum |
| V1: `#231A12` / `#FFFAF2` | 16,46:1 | Texto principal claro |
| V1: `#6B5D4F` / branco | 6,36:1 | Texto secundário claro |
| V1: `#796A5C` / `#FFFAF2` | 5,02:1 | Metadados claros |
| V1: branco / `#C2410C` | 5,18:1 | CTA primário em ambos os temas; já usado em `.btn-brand` |
| V1: branco / `#9A3412` | 7,31:1 | Hover do CTA |
| V1: `#C2410C` / `#FFFAF2` | 4,98:1 | Link/acento textual claro |
| V1: `#231A12` / `#F59E0B` | 7,96:1 | Realce âmbar com texto escuro |
| V1: `#FFF7ED` / `#211C18` | 15,90:1 | Texto sobre card escuro |
| V1: `#C6B8AA` / `#211C18` | 8,71:1 | Texto secundário escuro |
| V1: `#A6988A` / `#211C18` | 6,01:1 | Metadados escuros |
| V1: `#FDBA74` / `#211C18` | 10,01:1 | Link/foco escuro |
| V1: borda `#8F7A66` / branco | 4,08:1 | Indicador não textual de campo claro |
| V1: borda `#8F7A66` / `#211C18` | 4,13:1 | Indicador não textual de campo escuro |

Pares de status também calculados: sucesso claro/escuro **6,49/9,77**; atenção **6,37/9,41**; erro **6,80/7,92**; informação **7,15/7,92**. Todos passam 4,5:1 nos fundos especificados.

### 5.2 Lacunas a tratar na implementação

1. Migrar cores de botões legados, badges e gradientes com texto branco que falham; preservar a cor de marca nos usos decorativos.
2. Completar foco sólido e consistente: o painel usa em alguns lugares halos translúcidos, cuja aparência depende do fundo.
3. Formalizar modal/drawer: nome acessível, foco inicial, contenção de foco quando modal, Escape, retorno ao disparador e fundo inerte. Muitos overlays atuais são `div`; não presumir que a presença de fechar/Escape resolva todo o teclado.
4. Formalizar seleção e teclado de abas, cards clicáveis e agenda. O CRM já oferece select de etapa além do arrastar, uma base útil para acesso por teclado.
5. Acrescentar nome acessível explícito e área confortável a ações compactas. `title` isolado não deve ser o único modo de instruir o usuário.
6. Sincronizar `aria-expanded` no menu mobile do site: `site.js` alterna a classe `.open`, mas não atualiza esse atributo no trecho inspecionado.
7. Separar mensagens de erro, sucesso e atenção; não depender de cor ou emoji nem expor erro técnico como instrução principal.
8. Validar zoom, foco não encoberto, textos longos em português e teclado nos estados reais. Esta auditoria estática não é uma certificação de acessibilidade.

## 6. Motion system proposto

### 6.1 Interface

| Token | Duração | Easing / uso |
|---|---:|---|
| `instant` | 0 ms | Atualização imediata e modo reduzido |
| `fast` | 120 ms | Hover, cor, pequeno feedback |
| `base` | 180 ms | Entrada de menu/tooltip; `cubic-bezier(0.2, 0, 0, 1)` |
| `panel` | 240 ms | Drawer, modal e mudança de painel |
| `emphasis` | 360 ms | Estado concluído ou destaque breve |
| `brand` | 600 ms | Apresentação editorial/hero |
| `stagger` | 60 ms | Distância entre entradas de itens; máximo 4 itens em cascata |

Easing de saída: `cubic-bezier(0.4, 0, 1, 1)`; deslocamento entre posições: `cubic-bezier(0.4, 0, 0.2, 1)`; marca: `cubic-bezier(0.22, 1, 0.36, 1)`. Priorizar transform e opacity. Deslocamento de entrada de UI: 8–16 px; escala de entrada de modal: 0,98→1. Evitar saltos elásticos em tarefas operacionais e animação como atraso artificial de atendimento.

**Movimento reduzido:** em `prefers-reduced-motion: reduce`, remover deslocamentos, escalas, ondas animadas, scroll suave e loops de digitação; mudar estado diretamente ou por fade de até 80 ms. Informação de “processando” permanece textual. A implementação atual já tem regras para reveal, ondas, hero, botão de marca e ajuda, mas isso não cobre automaticamente todas as transições do painel/site.

### 6.2 Componentes para o vídeo

São componentes de composição propostos, não telas adicionais do produto. Compartilham tokens, rótulos e fluxo do aplicativo. Todos os dados devem ser sintéticos, com identificação de demonstração quando houver risco de confundir com resultado real.

| Componente de motion | Conteúdo mínimo | Entrada / transformação | Limite de fidelidade |
|---|---|---|---|
| `BrandLockup` | Logo + assinatura curta | Fade e deslocamento de 16–24 px | Usar arquivo original; não gerar lettering por IA |
| `ConversationCard` | Cabeçalho, papel do autor, 2–3 mensagens legíveis | Mensagens entram em 180–240 ms, intervalo para leitura | Texto editável; sem números/nomes de clientes reais |
| `ContactSummary` | Nome fictício, interesse, próxima ação | Recolher a conversa em cartão | Resumo é demonstrativo, não prova de acerto automático |
| `PipelineCard` | Etapa, nome fictício e ação | Cartão caminha por 2–3 etapas em 480–600 ms | Etapas do vídeo devem ser definidas na demo; não inventar venda fechada como resultado garantido |
| `AppointmentCard` | Serviço, data/hora de demonstração e status | Card ocupa um horário disponível | Usar somente na versão de clínica/serviço agendável |
| `AutomationCard` | Gatilho, mensagem e momento | Linha conecta etapa ao próximo contato | Não representar todos os disparos fora do horário/regras configuradas |
| `HandoffCard` | “Atendimento com a equipe” e contexto | Ícone/avatar muda com status textual | Mostrar continuidade e controle humano |
| `MetricCard` | Indicador + unidade + período | Revelação do valor já definido | Nunca inventar crescimento, NPS ou receita como dado real |
| `BrandWave` | Traço/onda âmbar entre cenas | Uma passagem controlada de 500–700 ms | Retomar ondas do site com moderação; não cobrir mensagem |
| `EndCard` | Logo, promessa curta e um CTA | Entrada 600 ms, permanência mínima de 3 s | URL/contato/preço só após validação |

**Formato mestre:** 1920 × 1080, 30 fps; variação social 1080 × 1920, recomposta. Não cortar automaticamente o widescreen. Área segura inicial: 5% nas bordas; na versão vertical, reservar pelo menos 15% inferior e 10% superior para sobreposições da plataforma e confirmar no destino de publicação. Título do vídeo 64–88 px no mestre; texto de UI ampliada 32–40 px; legenda 36–44 px, máximo duas linhas. São pontos de partida, sempre conferir a reprodução em um celular real.

**Ritmo:** uma ideia por cena; tempo de leitura precede efeito; elementos menores podem entrar juntos, mas a atenção segue conversa → organização → ação → controle. Trilhas não devem competir com a voz. Exportar versão legendada e fornecer roteiro/transcrição; a versão para web pode incluir alternativa sem animação.

## 7. Organização da biblioteca e adoção

Estrutura proposta para Figma ou biblioteca equivalente:

- `00 / Marca`: assinaturas, mascote, uso e exemplos.
- `01 / Fundamentos`: temas, cores, tipografia, espaçamento, raio, sombra e movimento.
- `02 / Primitivos`: Button, Input, Select, Checkbox, Radio, Badge, Avatar, Icon, Divider, Spinner.
- `03 / Padrões`: Field, Search, Tabs, Table, EmptyState, Toast, Dialog, Drawer, TagPicker.
- `04 / Produto`: Shell, Metric, Chat, Contact, Pipeline, Calendar, Automation, Rule, Channel, PlanGate, Help.
- `05 / Comunicação`: Hero, Feature, Steps, Pricing, FAQ, Proof, CTA, Wave.
- `06 / Motion`: os componentes da seção 6.2 e as cenas do roteiro.

Nome de variante de componente: `Button / variant=primary / size=md / state=default / theme=light`. Usar propriedades para texto, ícone e estado; não desenhar versões independentes para cada tela.

**Ordem de implementação sugerida:** (1) tokens/contraste e semântica de cores; (2) botões/campos/foco; (3) mensagens de estado e modais; (4) chat/CRM/agenda; (5) site e biblioteca de motion. Para cada família, verificar claro/escuro, teclado, 360 px e desktop, estado vazio/erro/loading, rótulos longos e papel/plano aplicáveis. Planejar migração gradual; não substituir todas as cores ou classes por busca global.

## 8. Arquivo de tokens e reprodução dos cálculos

`alice.tokens.json` usa **JSON simples com esquema próprio**: `meta`, `primitive`, `semantic`, `typography`, `space`, `radius`, `shadow`, `layout`, `component`, `motion`, `video` e `contrastChecks`. Valores de cor por tema já estão resolvidos; dimensões em px, tempos em ms. Não é um arquivo de importação direta garantida para Figma/Tokens Studio. Serve como contrato técnico para gerar CSS, adaptar uma biblioteca ou montar o motion.

Exemplo conceitual de mapeamento futuro: `semantic.light.action.primary.background` → `--alice-action-primary-bg`; `semantic.dark.*` sobrescrito em `[data-theme="dark"]`. Nenhum desses tokens já foi conectado ao aplicativo por esta documentação.

Fórmula usada, executável em JavaScript/Node sem dependências:

```js
function luminance(hex) {
  const c = hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255)
    .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
}
function contrast(foreground, background) {
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
// Exemplo: contrast('#FFFFFF', '#C2410C') >= 4.5
// Usar o valor completo para avaliar; arredondar apenas ao apresentar.
```
