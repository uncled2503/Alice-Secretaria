# Alice — inventário funcional e limites de comunicação

**Auditoria do código em 15/09/2026.** Este documento descreve o que está implementado no repositório e ajuda a escolher o que mostrar no design system, na apresentação comercial e no motion. Não houve execução do servidor, acesso ao banco, leitura de credenciais ou teste das integrações. **Código existente não comprova operação em produção.**

## 1. Como ler os status

- **Implementado:** há tela, rota, modelo ou mecanismo correspondente no código. Não significa validado em produção.
- **Depende de configuração:** o mecanismo existe, mas precisa de conexão, credenciais, dados cadastrados, regra ativa ou plano compatível.
- **Parcial:** há suporte, com cobertura incompleta ou limites que mudam a promessa comercial.
- **Não evidenciado / futuro:** não foi encontrado um mecanismo que sustente a oferta. Só comunicar como evolução proposta, caso vire uma decisão de produto.

As referências `arquivo:linha` apontam para o código auditado; as linhas podem mudar com futuras alterações. Os valores para o cliente abaixo são **benefícios esperados**, não resultados medidos.

## 2. Definição funcional

A Alice reúne **atendimento assistido por IA no WhatsApp, organização comercial e automações de relacionamento**. Na configuração de clínica, a agenda conecta a conversa a horários, procedimentos e profissionais. Na configuração de loja/negócio geral, a conversa se apoia no catálogo, nas perguntas frequentes e nas regras comerciais, com continuidade humana quando necessário.

O fluxo central é: **mensagem recebida → contato e histórico → resposta e qualificação → próximo passo comercial → acompanhamento → visão da equipe**.

### Dois perfis do mesmo produto

| Perfil | O que o código adapta | Principal valor | Limite importante | Evidência |
|---|---|---|---|---|
| Clínica | Paciente, procedimentos, profissionais, agenda, lembretes, pós-procedimento, renovação, pesquisa de satisfação | Organizar a jornada do primeiro contato ao retorno | Dados, horários e políticas precisam estar cadastrados; a ferramenta não substitui avaliação clínica | `prisma/schema.prisma:47`; `src/ai/alice.ts:743`; `public/index.html:597` |
| Loja / negócio geral | Cliente, catálogo, FAQ, roteiro de vendas e transferência para a equipe; agenda e áreas clínicas ficam ocultas no painel | Responder dúvidas e conduzir o interesse para um próximo passo de compra | Não há evidência de estoque em tempo real, carrinho, pedido ou checkout próprio; parte do texto comercial ainda usa exemplos de varejo infantil | `src/ai/alice.ts:837`; `public/app.js:3522`; `public/app.js:3849` |

**Decisão editorial:** no motion principal, escolher um perfil por peça. Mostrar clínica e loja no mesmo fluxo tende a misturar promessas diferentes.

## 3. Mapa dos módulos e superfícies

A navegação principal contém **Início, Contatos, CRM, Chat, Agenda, Relatórios e Personalizar Alice**. As configurações se dividem em dados do negócio, briefing, catálogo, profissionais, canais, automações, funil, bloqueios, Google Agenda, lista de espera, histórico, aprendizado, comportamento, contas, equipe, API e Meta. Há também tema claro/escuro, navegação móvel, guia de uso e assistente de ajuda.

Evidências: `public/index.html:60`; `public/index.html:594`; `public/app.js:297`; `public/app.js:445`; `public/app.js:6652`; `public/app.js:6751`.

### 3.1 Atendimento pelo WhatsApp

| Tela / ação | Mecanismo e status | Valor para o cliente | Dependências e limites | Evidência |
|---|---|---|---|---|
| Conectar número | **Depende de configuração.** Conexão por QR, consulta de status, desconexão e reconfiguração de webhook por conta | Centraliza as conversas no número utilizado pelo negócio | Gateway UAZAPI, endereço público, webhook e pareamento; não afirmar uso da API oficial da Meta sem verificar a infraestrutura contratada | `src/uazapi/client.ts:263`; `src/uazapi/client.ts:343`; `src/api/routes.ts:908`; `public/app.js:5528` |
| Importar contatos e histórico | **Depende de configuração.** Importa contatos e parte do histórico recente do WhatsApp; informa andamento e estatísticas | Evita começar a operação sem contexto | Recorte de sete dias e disponibilidade do gateway; histórico pode ser parcial; mensagens antigas não devem disparar resposta retroativa | `src/uazapi/client.ts:996`; `src/uazapi/client.ts:1047`; `public/app.js:5608` |
| Receber mensagens | **Implementado.** Webhook assinado, fila persistida, identificação de duplicatas e processamento | Mantém histórico e organiza a entrada das conversas | Entrega depende da conexão e do servidor; não é prova de SLA | `src/api/routes.ts:65`; `src/uazapi/client.ts:915`; `src/uazapi/client.ts:946`; `prisma/schema.prisma:174` |
| Resposta da Alice | **Depende de configuração.** Modelo de linguagem usa contexto do negócio, histórico e ferramentas | Responde perguntas e orienta a próxima ação sem exigir intervenção humana em cada mensagem | Plano pago, chave/modelo de IA, catálogo e regras; qualidade precisa ser verificada em exemplos reais autorizados | `src/ai/alice.ts:680`; `src/ai/alice.ts:1147`; `src/ai/alice.ts:1171` |
| Conversa mais natural | **Implementado.** Agrupamento de mensagens, espera configurável, divisão de respostas longas e proteção contra repetição | Reduz respostas fragmentadas e conversas que não avançam | Naturalidade é uma diretriz e um mecanismo, não garantia de que o cliente confundirá IA com pessoa | `src/uazapi/client.ts:370`; `src/uazapi/client.ts:772`; `src/ai/alice.ts:34`; `public/app.js:3384` |
| Entender áudio recebido | **Depende de configuração.** Baixa áudio e transcreve com Whisper antes de gerar resposta | Cliente pode escrever ou mandar áudio | Transcrição pode falhar; o plano grátis registra o áudio sem transcrição automática; não há voz automática de saída evidenciada | `src/uazapi/client.ts:601`; `src/uazapi/client.ts:840` |
| Entender foto recebida | **Depende de configuração.** Inclui imagem na chamada multimodal do modelo | Ajuda a responder dúvidas com contexto visual | Qualidade e disponibilidade da mídia/modelo; foto não sustenta diagnóstico médico | `src/uazapi/client.ts:846`; `src/ai/alice.ts:1212`; `src/ai/alice.ts:743` |
| Vídeos e documentos recebidos | **Parcial.** Há armazenamento e exibição de anexos | A equipe acompanha materiais enviados pelo cliente | Recebimento/exibição não comprova leitura de PDF, interpretação de vídeo ou processamento de todos os documentos pela IA | `src/uazapi/client.ts:563`; `src/ai/alice.ts:920`; `public/app.js:1155` |

### 3.2 Chat da equipe e continuidade humana

| Tela / ação | Mecanismo e status | Valor para o cliente | Dependências e limites | Evidência |
|---|---|---|---|---|
| Lista de conversas | **Implementado.** Busca, seleção, filtros de atendimento, pendências e arquivadas | Ajuda a equipe a encontrar e priorizar conversas | Lista reflete registros do sistema; não é caixa de entrada omnichannel | `public/app.js:849`; `public/app.js:901`; `src/api/routes.ts:1447` |
| Assumir / devolver atendimento | **Implementado.** Pausa da IA, retomada, motivo e resumo de transferência | Permite que uma pessoa resolva negociação, reclamação ou caso fora da base | Retomada da IA indisponível no grátis; equipe precisa acompanhar pendências | `src/api/routes.ts:1700`; `src/api/routes.ts:1735`; `src/ai/alice.ts:148`; `src/ai/alice.ts:1035` |
| Responder no painel | **Depende de configuração.** Texto humano enviado pelo WhatsApp e registrado com autoria | Equipe continua no mesmo contexto | Conexão WhatsApp ativa; falha de envio pode deixar mensagem salva sem entrega | `src/api/routes.ts:1583`; `src/uazapi/client.ts:386` |
| Enviar anexos | **Depende de configuração.** Foto, vídeo, arquivo, áudio e nota de voz; visualizador e prévia | Atendimento humano compartilha materiais sem trocar de ferramenta | Limite de 10 MB por envio; formatos dependem do navegador e gateway | `src/api/routes.ts:1628`; `public/app.js:1637`; `src/uazapi/client.ts:413` |
| Gravar áudio no painel | **Implementado.** Gravação por microfone, prévia e envio humano | Agiliza explicações que funcionam melhor por voz | Permissão de microfone e suporte do navegador; não é TTS nem chamada telefônica | `public/app.js:1736`; `public/app.js:1771` |
| Resposta pelo aparelho | **Implementado.** Mensagem enviada pelo dispositivo conectado é registrada e pode assumir o atendimento | Reduz choque entre equipe e IA | Depende de eventos recebidos do gateway | `src/ai/alice.ts:1077`; `src/uazapi/client.ts:820` |
| Arquivar e marcar como visto | **Implementado.** Arquivamento individual/em lote e estado de leitura | Mantém fila de trabalho legível | Arquivar conversa não apaga o contato; leitura no painel não é promessa de recibo de leitura no WhatsApp | `src/api/routes.ts:1512`; `src/api/routes.ts:1529`; `src/api/routes.ts:1560` |
| Avisos para a equipe | **Depende de configuração.** Número e eventos configuráveis para agendamento, remarcação, cancelamento, confirmação e transferência | Dá visibilidade do que pede acompanhamento | WhatsApp configurado e eventos habilitados; não é central universal de notificações | `src/crm/notify.ts:4`; `src/crm/notify.ts:13` |

### 3.3 Contatos, ficha e CRM

| Tela / ação | Mecanismo e status | Valor para o cliente | Dependências e limites | Evidência |
|---|---|---|---|---|
| Base de contatos | **Implementado.** Cadastro, consulta e exclusão; criação também a partir de conversas e agenda | Reduz contatos espalhados | Cadastro comercial, não prontuário clínico completo | `src/api/routes.ts:1392`; `src/api/routes.ts:1407`; `src/api/routes.ts:1429` |
| Ficha do contato | **Implementado.** Nome, telefone, e-mail, documento, nascimento, anotações e etiquetas | Equipe acessa contexto sem procurar em mensagens soltas | Exige preenchimento e manutenção adequados; não inventar campos não existentes no mockup | `prisma/schema.prisma:385`; `public/app.js:1508` |
| Etiquetas | **Implementado.** Criar, colorir, atribuir e remover etiquetas | Segmenta e identifica interesses ou prioridades | Classificação depende da equipe e dos fluxos existentes | `src/api/routes.ts:1966`; `public/app.js:1037`; `public/app.js:1376` |
| Quadro Kanban | **Implementado.** Cards por etapa, busca e movimentação | Mostra onde cada oportunidade está | Um funil configurável por conta; não há múltiplos pipelines independentes evidenciados | `src/api/routes.ts:1769`; `public/app.js:615`; `public/app.js:791` |
| Configurar o funil | **Implementado.** Criar, editar, ordenar e remover etapas com cor e finalidade | Adapta o processo comercial ao negócio | Modelo inicial tem dez etapas clínicas; revisar nomes no modo loja | `src/crm/stages.ts:13`; `src/api/routes.ts:2031`; `public/app.js:716` |
| Detalhes comerciais do card | **Implementado.** Valor estimado, temperatura, responsável, próxima ação e anotações | Ajuda a priorizar e dividir o trabalho | Campos majoritariamente manuais; data da próxima ação não prova disparo automático de tarefa | `prisma/schema.prisma:420`; `src/api/routes.ts:1813`; `public/app.js:610` |
| Resumo automático do lead | **Depende de configuração.** Extrai motivo, interesse e resumo das falas do cliente quando a conversa esfria | Equipe entende o caso sem reler todo o histórico | Plano pago, IA, janela de análise e limites; não é atualização instantânea nem garantia de extração correta | `src/crm/leadSummary.ts:27`; `src/crm/leadSummary.ts:139`; `src/crm/leadSummary.ts:183`; `public/app.js:1482` |
| Movimentação automática | **Implementado.** Ferramenta da IA e eventos da agenda podem mover o card; ações registradas em histórico | Mantém o funil conectado ao atendimento | Depende dos eventos, regras e mapeamento; valores de venda podem precisar ser completados pela equipe | `src/ai/alice.ts:549`; `src/crm/stageAutomation.ts:21`; `src/api/routes.ts:2010` |
| Histórico do lead | **Implementado.** Eventos, autoria, agendamentos e automações enviadas/pendentes | Facilita continuidade e revisão do atendimento | Histórico disponível depende de registros existentes; a ficha limita partes da listagem | `src/crm/dossier.ts:9`; `src/crm/dossier.ts:76`; `public/app.js:1316` |
| Remover do quadro | **Implementado.** Oculta o card sem apagar contato e histórico | Permite limpar o funil sem destruir contexto | Difere de excluir contato | `src/api/routes.ts:1936`; `prisma/schema.prisma:426` |

### 3.4 Agenda e capacidade de atendimento

| Tela / ação | Mecanismo e status | Valor para o cliente | Dependências e limites | Evidência |
|---|---|---|---|---|
| Agenda visual | **Implementado.** Grade/lista, períodos, minicalendário, filtros por profissional e resumo | Centraliza os horários e os estados dos atendimentos | Perfil clínica; agendamentos manuais dependem de operação da equipe | `public/app.js:1935`; `public/app.js:1999`; `public/app.js:2059`; `public/app.js:2106` |
| Agendamento pela IA | **Depende de configuração.** Consulta disponibilidade, checa horário específico e cria reserva | Reduz troca manual de mensagens para encontrar horário | Procedimentos, duração, expediente, profissional, bloqueios e conexão; fluxo precisa de validação funcional antes de divulgar garantias | `src/ai/alice.ts:61`; `src/ai/alice.ts:96`; `src/scheduling/slots.ts:212`; `src/scheduling/slots.ts:467` |
| Confirmar / cancelar / remarcar pelo WhatsApp | **Depende de configuração.** Ferramenta identifica o agendamento e executa a ação | Cliente resolve mudanças na própria conversa | Requer identificação correta e registros; equipe recebe aviso se configurado | `src/ai/alice.ts:115`; `src/ai/alice.ts:451` |
| Cadastro e edição manual | **Implementado.** Criar, editar, trocar profissional/procedimento, marcar presença, concluir, cancelar, registrar falta e excluir | Equipe controla exceções e atendimentos de outros canais | As rotas manuais não usam todas as verificações do motor de disponibilidade; evitar “zero conflitos” | `src/api/routes.ts:2150`; `src/api/routes.ts:2211`; `src/api/routes.ts:2325` |
| Expediente por profissional | **Implementado.** Dias/horas próprios, vínculo a procedimentos e identificação por cor | Permite tratar capacidades paralelas da equipe | Sem configuração própria, herda expediente do negócio; comentário antigo no schema que diz “sem agenda própria” está desatualizado | `prisma/schema.prisma:350`; `src/scheduling/slots.ts:57`; `public/app.js:4578` |
| Bloqueios | **Implementado.** Intervalos para a clínica toda ou profissional | Evita oferecer folgas, almoço ou outras indisponibilidades no motor da IA | Depende de cadastro; validações manuais têm cobertura diferente | `prisma/schema.prisma:737`; `src/api/routes.ts:2346`; `public/app.js:5780` |
| Lista de espera | **Depende de configuração.** Cadastro pela IA/equipe e oferta de vaga liberada ao primeiro contato compatível | Ajuda a aproveitar cancelamentos | A oferta não reserva nem remarca sozinha; nota de preferência é texto livre; não equivale a otimização automática de toda a fila | `src/ai/alice.ts:132`; `src/scheduling/waitlist.ts:7`; `src/api/routes.ts:2411` |
| Solicitação de sinal | **Parcial.** Configuração instrui a IA a aguardar comprovante antes de confirmar | Apoia a política de reserva do negócio | É instrução no prompt; não há conciliação bancária ou validação financeira do comprovante evidenciada | `src/ai/alice.ts:698`; `prisma/schema.prisma:45` |

### 3.5 Google Agenda

| Ação | Mecanismo e status | Valor para o cliente | Dependências e limites | Evidência |
|---|---|---|---|---|
| Conectar/desconectar Google | **Depende de configuração.** OAuth, token protegido, status e ajustes | Permite usar o calendário já conhecido pela equipe | Cliente OAuth, URI de retorno, chave de criptografia, autorização e calendário; uma conexão por conta | `src/google/calendar.ts:48`; `src/google/calendar.ts:84`; `src/api/routes.ts:3171`; `prisma/schema.prisma:719` |
| Alice → evento Google | **Parcial.** Cria/atualiza/remove eventos nos pontos integrados | Reduz duplicação de agenda em fluxos cobertos | Melhor esforço; criação manual no painel não chama o envio ao Google; edição manual chama; alterações via API externa não têm a mesma cobertura | `src/google/calendar.ts:314`; `src/google/calendar.ts:362`; `src/scheduling/slots.ts:467`; `src/api/routes.ts:2150`; `src/api/routes.ts:2249` |
| Ocupação Google → disponibilidade Alice | **Depende de configuração.** Consulta intervalos ocupados e os aplica ao motor de horários | Evita sugerir horários já ocupados no calendário conectado | Janela de 30 dias e cache de 60 segundos; falha retorna lista vazia; não importa eventos como agendamentos Alice nem sincroniza todos os campos nos dois sentidos | `src/google/calendar.ts:261`; `src/google/calendar.ts:271`; `src/scheduling/slots.ts:186` |

**Frase sustentada:** “Integração com Google Agenda, mediante configuração.” **Frase a evitar:** “Sincronização completa, instantânea e sem conflitos.”

### 3.6 Automações de relacionamento

Todos os itens abaixo possuem mecanismo no código, mas dependem de **plano pago, regras/dados adequados, WhatsApp conectado e processo agendado em execução**. A periodicidade do job não deve ser apresentada como entrega no segundo exato.

| Tela / ação | Mecanismo | Valor para o cliente | Limite específico | Evidência |
|---|---|---|---|---|
| Lembrete de consulta | Regras com antecedência em horas, texto e controle de envio por agendamento | Ajuda o cliente a lembrar do compromisso | Job a cada 15 minutos; sem prova de redução de faltas em percentual | `src/reminders/cron.ts:10`; `src/api/routes.ts:2588` |
| Recontato / follow-up | Sequência após silêncio, filtros de etapa, janela de horário e mudança de etapa opcional | Retoma oportunidades que ficaram sem resposta | Ignora conversas em atendimento humano; depende da regra e do estado da conversa | `src/crm/followup.ts:62`; `src/api/routes.ts:2492`; `public/app.js:2550` |
| Pós-procedimento | Mensagem após intervalo definido, opcionalmente só para atendimento concluído e procedimentos selecionados | Mantém continuidade depois da visita | Não substitui acompanhamento clínico; conteúdo precisa estar cadastrado | `src/reminders/postProcedure.ts:15`; `src/api/routes.ts:2645` |
| Renovação | Contato após meses/anos, com filtro de procedimentos | Lembra sobre retornos ou renovação de serviços | Não determina indicação médica nem garante recompra | `src/reminders/renewal.ts:18`; `src/api/routes.ts:2731` |
| Aniversário | Mensagem no dia/mês cadastrado e horário configurável, com controle anual | Mantém contato com a base | Depende da data de nascimento; não pressupõe dado correto | `src/reminders/birthday.ts:23`; `src/api/routes.ts:2809` |
| Mensagens programadas | Campanha com texto, data, status, cancelamento e destinatários por grupo/etapa/seleção | Organiza comunicações para uma base definida | Não há criador de anúncios nem garantia de entrega; processamento em lotes | `src/crm/broadcast.ts:55`; `src/api/routes.ts:2928`; `public/app.js:2718` |
| Reativação de base | Seleciona quem concluiu procedimento há determinado tempo e não tem consulta futura | Ajuda a retomar relacionamento com clientes antigos | Recorte depende de agendamentos concluídos; é filtro de base, não previsão de quem comprará | `src/crm/broadcast.ts:19`; `public/app.js:2679` |
| Pesquisa NPS | Pergunta de 0 a 10 após atendimento concluído; registra resposta e comentário | Torna a percepção do cliente visível | Job a cada 15 minutos, janela de agendamentos de até cinco dias e resposta ligada a pesquisa recente | `src/reminders/nps.ts:10`; `src/ai/alice.ts:562` |
| Avaliação no Google / nota baixa | Nota acima do limite orienta pedido de avaliação; nota baixa gera aviso para equipe | Apoia reputação e recuperação de experiência | Link e limite configuráveis; não há comprovação de que a pessoa avaliou no Google; não prometer filtro reputacional como garantia | `src/ai/alice.ts:600`; `public/app.js:3444` |

### 3.7 Personalização, conteúdo e conhecimento

| Tela / ação | Mecanismo e status | Valor para o cliente | Dependências e limites | Evidência |
|---|---|---|---|---|
| Dados do negócio | **Implementado.** Nome, fuso, expediente, endereços, links e notificações | Respostas usam informações do negócio | Vários endereços na conta não significam agenda independente por endereço | `prisma/schema.prisma:13`; `prisma/schema.prisma:262`; `public/app.js:5288`; `public/app.js:5475` |
| Procedimentos / serviços | **Implementado.** Nome, duração, valor, preço variável, parcelamento, pagamento, descrição, objetivos, benefícios e nomes alternativos | Padroniza o que pode ser explicado e agendado | Valor e condições dependem do cadastro; link de pagamento não é processamento interno | `prisma/schema.prisma:320`; `src/ai/alice.ts:617`; `public/app.js:4302` |
| Produtos | **Implementado.** Nome, descrição, preço, foto e ativo/inativo | Organiza o catálogo usado no atendimento | Sem estoque, variações/SKU, pedido e pagamento integrados evidenciados | `prisma/schema.prisma:373`; `src/api/routes.ts:1210`; `public/app.js:4444` |
| Profissionais | **Implementado.** Foto, bio, Instagram, cor, serviços e expediente | Ajuda a escolher e distribuir os atendimentos | Agenda do profissional depende de vínculo e configuração | `src/api/routes.ts:1290`; `public/app.js:4518` |
| Nome, persona e postura | **Implementado.** Nome da assistente, apresentação, perfil comercial/consultivo, emojis, avaliação primeiro e frase de transferência | Aproxima atendimento da linguagem do negócio | Personalização não garante obediência perfeita do modelo; a diretriz atual de ocultar identidade de IA deve ser revista antes de virar princípio público de marca | `src/ai/alice.ts:666`; `src/ai/alice.ts:680`; `public/app.js:3384` |
| Regras personalizadas | **Depende de configuração.** Texto vira rascunho estruturado; permite revisar, aprovar, criar manualmente, editar e restaurar padrões | Registra políticas e reduz improvisação | Aprovação ativa o conteúdo; regra não equivale a trava de software em todos os casos | `src/ai/rules.ts:97`; `src/ai/rules.ts:258`; `src/api/routes.ts:3583` |
| Mensagens prontas | **Implementado.** Modelos com modo de uso e contexto | Mantém consistência de comunicação | Texto precisa ser configurado; não confundir com aprovação de template pela Meta | `prisma/schema.prisma:193`; `src/api/routes.ts:3694`; `public/app.js:3194` |
| Perguntas frequentes | **Implementado.** Pergunta, resposta, alternativas e opção de resposta exata | Dá base para dúvidas recorrentes | Exige manutenção conforme políticas mudam | `prisma/schema.prisma:208`; `src/api/routes.ts:3731`; `public/app.js:3258` |
| Roteiros de conversa | **Implementado.** Gatilho, objetivo e etapas do atendimento | Ajuda a conduzir diferentes intenções | Não é editor visual de fluxos evidenciado; execução usa o modelo e contexto | `prisma/schema.prisma:222`; `src/api/routes.ts:3768`; `public/app.js:3320` |
| Briefing de implantação | **Depende de configuração.** Modelo de briefing, interpretação por IA, prévia e aplicação estruturada | Acelera a configuração inicial | A interpretação precisa ser revisada antes da aplicação; não pressupõe implantação instantânea | `src/ai/briefing.ts:17`; `src/ai/briefing.ts:620`; `src/ai/briefing.ts:702`; `public/app.js:5888` |
| Aprendizado da Alice | **Depende de configuração.** Analisa conversas transferidas, propõe FAQ/regra/estilo e aponta conflitos; pessoa aprova ou rejeita | Usa casos de atendimento para melhorar a base | É aprendizado supervisionado de conteúdo; não é treinamento autônomo de modelo nem publicação automática de conhecimento | `src/ai/learning.ts:215`; `src/ai/learning.ts:294`; `src/ai/learning.ts:351`; `public/app.js:6253` |

### 3.8 Início, relatórios e histórico

| Tela / ação | Mecanismo e status | Valor para o cliente | Dependências e limites | Evidência |
|---|---|---|---|---|
| Visão geral | **Implementado.** Indicadores, gráfico por período, minicalendário e uso do plano | Dá um resumo da operação | Dados dependem dos registros; cartões variam por modo e plano | `src/api/routes.ts:1012`; `public/app.js:3886`; `public/app.js:3915` |
| Funil e comparecimento | **Implementado.** Leads, agendamentos, concluídos, faltas, cancelamentos e taxa calculada | Facilita encontrar pontos de atenção | A “conversão” do relatório usa concluídos sobre concluídos + faltas + cancelamentos; não é automaticamente taxa lead→venda | `src/crm/reports.ts:39`; `public/app.js:4091` |
| Valores e rankings | **Implementado, com limite de interpretação.** Soma preços de procedimentos concluídos/futuros e agrupa por serviço/profissional | Oferece referência comercial da agenda | Não é caixa, faturamento fiscal ou conciliação; preços atuais de cadastro podem alterar a leitura histórica | `src/crm/reports.ts:39`; `src/crm/reports.ts:63` |
| Origem de agendamento | **Implementado.** WhatsApp, Instagram, presencial, telefone e não informado | Ajuda a comparar registros por origem | Instagram é valor de atribuição, não integração de atendimento em DM | `src/crm/reports.ts:3`; `src/crm/reports.ts:101` |
| Recuperados por recontato | **Implementado, com limite de interpretação.** Conta quem recebeu follow-up antes de agendar/concluir | Indica jornadas em que houve recontato | Associação temporal não comprova causalidade ou receita incremental | `src/crm/reports.ts:112` |
| Satisfação | **Implementado.** NPS, média, quantidade de respostas e comentários | Mostra percepção dos clientes que responderam | Não representa automaticamente toda a base | `src/crm/reports.ts:133` |
| Mapa por estado | **Implementado.** Infere UF a partir do DDD | Mostra distribuição aproximada dos contatos | Não é geolocalização atual nem endereço verificado | `src/crm/geo.ts:1`; `public/app.js:4020` |
| Histórico de atividades | **Implementado.** Lista de eventos com filtros por área/tipo e autoria | Ajuda a acompanhar mudanças e automações | Não declarar auditoria regulatória completa | `src/crm/activity.ts:1`; `src/api/routes.ts:2878`; `public/app.js:2968` |

### 3.9 Meta e atribuição de campanhas

| Tela / ação | Mecanismo e status | Valor para o cliente | Dependências e limites | Evidência |
|---|---|---|---|---|
| Capturar atribuição | **Depende de configuração.** Extrai referências de anúncios do webhook e associa dados ao contato | Liga parte do contexto da campanha à oportunidade | Depende dos campos entregues pelo gateway; não garante atribuição completa de todo contato | `src/uazapi/client.ts:468`; `src/ai/alice.ts:923`; `prisma/schema.prisma:400` |
| API de Conversões | **Depende de configuração.** Enfileira Lead, Schedule e eventos de CRM; mapeia qualificado, desqualificado, ganho e perdido | Devolve sinais comerciais para a mensuração na Meta | Pixel/dataset, token, chave de proteção e mapeamento válidos; não cria/gerencia campanhas nem garante melhora de anúncios | `src/meta/events.ts:144`; `src/meta/events.ts:172`; `src/meta/capi.ts:1` |
| Valor de venda | **Implementado.** Movimento de ganho pode receber valor real informado naquela transição | Diferencia valor estimado de negócio e valor informado ao fechar | Não confirma pagamento bancário; ausência de valor exige ação da equipe | `src/meta/events.ts:183`; `public/app.js:114`; `public/app.js:806` |
| Diagnóstico e reenvio | **Implementado.** Teste de conexão/evento, fila, estados, tentativas e repetição de falhas | Facilita conferir se os sinais estão sendo processados | Evento aceito não garante atribuição ou resultado de campanha | `src/api/routes.ts:3379`; `src/api/routes.ts:3410`; `src/api/routes.ts:3470`; `public/app.js:6197` |
| Pixel de navegador | **Parcial / não evidenciado.** Há configuração `pixelEnabled`, mas não foi localizado emissor `fbq`/`fbevents` em `src`/`public` | Poderia completar mensuração de navegação se implementado | Não anunciar instalação automática de Pixel no site; a CAPI servidor está evidenciada | `src/api/routes.ts:3335`; `public/app.js:6109`; `src/meta/events.ts:114` |

### 3.10 API externa

**Existe implementação e montagem de rota**, não apenas cadastro de chave ou promessa futura. Base: `/external/v1`.

| Superfície | O que está implementado | Valor | Limites / evidência |
|---|---|---|---|
| Autenticação | Chave Bearer com escopos, hash, revogação e último uso | Integração entre sistemas com permissões por chave | Depende de chave válida; `src/api/external/keys.ts:5`; `src/api/external/keys.ts:53`; `src/server.ts:163` |
| Contatos | Listar, obter, criar/atualizar por telefone e editar campos; etiquetas na criação | Entrada e atualização de leads por outro sistema | Não há CRUD universal de todo o produto; `src/api/external/router.ts:172`; `src/api/external/router.ts:210`; `src/api/external/router.ts:268` |
| CRM | Ler etapas/quadro e mover contato de etapa | Integra o processo comercial | Formato e cobertura não são idênticos à interface; `src/api/external/router.ts:304`; `src/api/external/router.ts:335` |
| Catálogo | Ler procedimentos, produtos e profissionais | Compartilha referências para outras ferramentas | Rotas de catálogo são de leitura; `src/api/external/router.ts:351`; `src/api/external/router.ts:379` |
| Agenda | Ler agendamentos/disponibilidade, criar reserva, alterar data/status/profissional | Permite que sistemas externos consultem e alimentem a agenda | Criação usa motor de reserva; alteração grava direto e não tem a mesma validação/sincronização Google; `src/api/external/router.ts:403`; `src/api/external/router.ts:455`; `src/api/external/router.ts:502` |
| Controles e documentação | Escopos, limite de 60/minuto e 1.000/hora por chave, suporte a Idempotency-Key e página de documentação | Ajuda desenvolvedores a construir integrações | Não é conector nativo pronto para qualquer ERP; idempotência/cobertura precisa ser validada no caso de uso; `src/api/external/router.ts:62`; `src/api/external/router.ts:77`; `public/api-docs.html:1` |

### 3.11 Contas, acesso e ajuda

| Tela / ação | Mecanismo e status | Valor para o cliente | Dependências e limites | Evidência |
|---|---|---|---|---|
| Login e equipe | **Implementado.** Contas, senhas protegidas, sessão e papéis `admin` / `client` | Define quem acessa o painel e quem operou uma ação | Dois papéis gerais evidenciados, sem matriz granular de permissões por módulo | `prisma/schema.prisma:288`; `src/api/routes.ts:3882`; `src/api/routes.ts:3940` |
| Administração de contas | **Implementado.** Cadastro, dados, responsável, plano, vigência, bloqueio e conexão por negócio | Permite operar vários clientes pela administração Alice | Conta cliente é vinculada a um negócio; vários endereços e múltiplas contas são conceitos distintos | `src/api/routes.ts:128`; `src/api/routes.ts:416`; `src/api/routes.ts:678` |
| Revogar acessos e ver logins | **Implementado.** Invalida sessões e registra acesso com data/navegador | Ajuda a administrar credenciais e acesso | Não é certificação de segurança; escopo desta auditoria não foi teste de invasão | `src/api/routes.ts:552`; `src/api/routes.ts:571`; `prisma/schema.prisma:307` |
| Tema e mobile | **Implementado.** Tema claro/escuro e navegação adaptada | Facilita uso em contextos diferentes | Não comprova paridade de aplicativo nativo ou acessibilidade integral | `public/app.js:297`; `public/app.js:445` |
| Guia de uso | **Implementado.** Tour das áreas do painel | Ajuda na primeira utilização | Conteúdo pode precisar de atualização conforme o produto muda | `public/app.js:6652` |
| Assistente de ajuda | **Depende de configuração.** Chat com base de conhecimento do painel | Responde dúvidas sobre como usar a ferramenta | Não executa ações administrativas; base contém descrições que precisam acompanhar a evolução do código | `src/ai/siteAssistant.ts:7`; `src/api/routes.ts:93`; `public/app.js:6751` |

## 4. Planos: o que o código realmente separa

| Plano | Escopo implementado | Atendimentos automáticos / mês | Observação |
|---|---|---|---|
| Grátis | CRM, contatos, Meta, chat humano e agenda manual, além de cadastros de apoio | IA não atende nesse plano | Não descrevê-lo como “só CRM”; chat humano e agenda manual estão liberados |
| Realce | Atendimento IA e módulos pagos | 100, por padrão | Pode haver limite personalizado pelo administrador |
| Prime | Atendimento IA e módulos pagos | 300, por padrão | Mesmo conjunto funcional pago no código auditado |
| Prestige | Atendimento IA e módulos pagos | Sem teto de conversas definido no código | Não significa ausência de qualquer limitação operacional ou contratual |

**Atendimento**, no controle de consumo, significa uma conversa atendida pela Alice no mês, não cada mensagem. Ao atingir o limite, novas conversas são direcionadas à equipe; conversas já contadas naquele mês continuam. A vigência gera aviso administrativo, sem bloqueio automático por vencimento. O bloqueio da conta é ação separada.

Evidências: `src/crm/plan.ts:1`; `src/crm/plan.ts:39`; `src/crm/usage.ts:13`; `src/crm/usage.ts:42`; `src/reminders/planExpiry.ts:12`; `public/app.js:3533`.

O frontend contém referências de **R$ 0 / R$ 597 / R$ 897 / R$ 1.397** para Grátis/Realce/Prime/Prestige (`public/app.js:4681`). São valores encontrados no produto, **não validação de oferta vigente, periodicidade, condições ou autorização para anúncio**. Separar essa informação do roteiro institucional até consolidar a política comercial.

## 5. Pontos parciais que mudam a promessa

1. **Google Agenda:** suporte real, com cobertura por fluxo e consulta de ocupação; não há sincronização completa de toda alteração em todo canal. Criação manual e atualização pela API externa merecem revisão antes de demonstração integrada.
2. **Agenda:** o motor usado pela IA/criação externa valida disponibilidade, mas rotas manuais e alteração externa têm caminho diferente. Não prometer impossibilidade de conflito.
3. **Áudio:** compreender áudio recebido e gravar áudio humano estão implementados. Voz sintetizada automática, ligação e atendimento telefônico não foram evidenciados.
4. **Mídia:** foto recebida entra na visão da IA. Vídeo/documento podem ser anexos visíveis sem leitura semântica pela IA.
5. **Aprendizado:** sugestões viram regras/FAQ depois de revisão humana. Evitar “aprende tudo sozinha”.
6. **Catálogo/comércio:** informações e orientação comercial não equivalem a estoque, pedido, entrega e checkout integrados.
7. **Indicadores:** valores são estimativas com base em preços; recuperação é associação temporal; não usar os gráficos como prova de ROI.
8. **Pixel:** configuração visual não comprova disparo no navegador. A integração CAPI do servidor tem evidência concreta.
9. **Opt-out:** o campo existe e há filtros em Meta, NPS, reativação e lista de espera. Não foi encontrada checagem universal em `sendText` ou em todos os crons; revisar cobertura antes de prometer bloqueio total de comunicações (`src/uazapi/client.ts:386`; `src/reminders/nps.ts:29`; `src/meta/events.ts:102`).
10. **Controle por plano/conta:** alguns bloqueios são de interface e rotas específicas. A API externa resolve a chave sem verificar plano/estado ativo no mesmo ponto da sessão do painel (`src/api/external/keys.ts:53`; `src/server.ts:214`). Não tratar a matriz comercial como uma auditoria completa de enforcement.

Esses itens não foram corrigidos nesta entrega; são limites encontrados para orientar produto e comunicação.

## 6. Capacidades não evidenciadas para não acrescentar ao motion

- Atendimento nativo de DM do Instagram, Messenger, e-mail e telefone em uma caixa omnichannel.
- Chamadas de voz, voz clonada ou áudio automático produzido pela Alice.
- Prontuário médico completo, diagnóstico, prescrição e análise de exames.
- Checkout próprio, conciliação de Pix/cartão, emissão fiscal, estoque ou gestão de pedidos.
- Criação/otimização automática de anúncios, painel de investimento de mídia ou garantia de ROAS.
- Agendamento independente por sala/equipamento/endereço, otimização matemática de filas ou múltiplos pipelines de CRM.
- Aplicativo móvel nativo, modo offline completo, certificação de conformidade, disponibilidade contratual medida.

“Não evidenciado” significa ausência de mecanismo encontrado nesta auditoria de código; não descarta serviço manual contratado ou integração externa não representada no repositório.

## 7. O que selecionar para a demonstração visual

### Prioridade A — história principal

1. Mensagem de um cliente fictício chegando pelo WhatsApp.
2. Alice responde com informação cadastrada e uma pergunta relevante.
3. Contato aparece no CRM com etapa e resumo.
4. Na peça clínica: horário disponível vira agendamento. Na peça loja: próximo passo de compra ou continuidade humana.
5. Lembrete/recontato configurado mantém continuidade.
6. Equipe acompanha e assume quando precisa.

### Prioridade B — prova complementar

Personalização de linguagem, ficha do lead, filtros da agenda, integração Meta CAPI, relatórios e aprendizado com aprovação. Exibir poucos elementos por cena; a peça não precisa enumerar o painel inteiro.

### Preparação de uma demo

Usar contatos, negócios, telefones, horários, valores e conversas **fictícios**. Identificar telas reconstruídas como demonstração quando puderem ser confundidas com captura real. Conferir os fluxos escolhidos em ambiente de teste antes de chamar uma animação de “demonstração do produto”.

