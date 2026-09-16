# Alice — posicionamento, oferta e comunicação

Versão de trabalho · 15 de setembro de 2026 · Base: leitura do código e dos textos deste repositório.

Este documento organiza a marca para apresentação comercial e produção do motion. **Não altera a aplicação, a oferta contratada nem os preços.**

## 1. Como interpretar este documento

- **[CÓDIGO]**: comportamento ou estrutura encontrados nos arquivos. Isso demonstra implementação, não disponibilidade garantida em produção nem resultado de cliente.
- **[SITE]**: mensagem encontrada na página comercial atual. Não é, por si só, comprovação da promessa.
- **[PROPOSTA]**: direção recomendada de marca, texto ou oferta a validar com o responsável pela Alice.
- **[VALIDAR]**: decisão comercial ou evidência ainda necessária antes de anunciar como fato.

**Fontes principais:** [site](../../public/site/index.html), [regras de planos](../../src/crm/plan.ts), [limites de uso](../../src/crm/usage.ts), [controle administrativo de planos](../../src/api/routes.ts), [vigência dos planos](../../src/reminders/planExpiry.ts), [briefing de configuração](../briefing-cliente.md), [lógica da assistente](../../src/ai/alice.ts), [ajuda do painel](../../src/ai/siteAssistant.ts), [relatórios](../../src/crm/reports.ts), [recontato](../../src/crm/followup.ts), [eventos para Meta](../../src/meta/events.ts).

## 2. O que é a Alice

### Definição principal [PROPOSTA apoiada no CÓDIGO]

> A Alice é uma assistente virtual com IA que conecta atendimento no WhatsApp, agenda e acompanhamento de clientes em um painel, com a equipe no controle.

### Versão para clínicas de estética [PROPOSTA]

> A Alice ajuda sua clínica a cuidar da jornada que começa no WhatsApp: responde dúvidas, organiza o interesse, agenda avaliações e acompanha o próximo passo. Sua equipe vê o histórico e assume quando precisa.

### Categoria e arquitetura da marca [PROPOSTA]

| Elemento | Escolha recomendada | Uso |
| --- | --- | --- |
| Nome principal | Alice | Logo, interface, fala e assinatura |
| Descritor | Assistente virtual com IA para atendimento e agenda | Primeira apresentação; explica o produto |
| Categoria comercial | Plataforma de atendimento, agenda e relacionamento | Apresentação completa e proposta |
| Expressão familiar | Secretária virtual | Pode aparecer em busca e anúncios, acompanhada de explicação |
| Personalidade | Acolhedora, organizada e objetiva | A forma de falar e conduzir a experiência |

O site usa “Alice IA” e “Secretária Virtual Humanizada Completa”. Recomenda-se substituir superlativos genéricos por uma descrição concreta. “Humanizada” deve significar linguagem natural, cuidado e possibilidade de falar com a equipe; não fingir que a tecnologia é uma pessoa.

## 3. Para quem começar

**[SITE]** A comunicação atual abrange clínicas e consultórios, estética, odontologia, lojas, e-commerce, salões, studios e prestadores de serviço. Há modos de atendimento com e sem agenda no produto.

**[PROPOSTA] Público inicial provisório: clínicas de estética que recebem procura e agendam pelo WhatsApp.** O usuário pode escolher outro segmento. Este foco aproveita a linguagem, a agenda, os procedimentos, os profissionais e as automações já presentes no projeto. Não representa pesquisa de mercado concluída.

| Papel | O que precisa perceber |
| --- | --- |
| Proprietário ou gestor, comprador | Organização do atendimento e visibilidade do que acontece com cada oportunidade |
| Recepção ou comercial, usuário diário | Menos repetição, histórico acessível e passagem clara para atendimento humano |
| Profissional da clínica | Agenda organizada e limites para questões que exigem avaliação profissional |
| Paciente, usuário indireto | Informação clara, próximo passo simples e acesso à equipe |

**Sinais de aderência [PROPOSTA]:** mensagens sem continuidade, equipe acumulando recepção e WhatsApp, dificuldade de acompanhar quem pediu avaliação, lembretes feitos à mão e necessidade de reunir conversa e agenda.

**Condições para uma boa implantação [PROPOSTA]:** informações e políticas atualizadas, responsável por revisar a configuração, equipe disponível para assumir exceções e conexão do canal em funcionamento. A adequação deve ser demonstrada no fluxo específico do cliente.

## 4. Qual problema resolve

### Problema central [PROPOSTA]

> O atendimento chega pelo WhatsApp, mas o próximo passo se perde entre mensagens, agenda e tarefas da equipe.

O problema não é apenas digitar respostas. É manter a continuidade: entender o pedido, registrar o interesse, encontrar horário, confirmar, lembrar e retomar o contato quando fizer sentido.

### Trabalho que o cliente quer realizar [PROPOSTA]

> “Quando alguém procura minha clínica, quero saber o que essa pessoa precisa, encaminhar o atendimento e acompanhar o que aconteceu, sem depender de lembrar de cada conversa.”

### Problema → mecanismo → benefício → prova

| Problema percebido | Mecanismo encontrado no produto [CÓDIGO] | Benefício a comunicar [PROPOSTA] | Prova adequada para demonstração |
| --- | --- | --- | --- |
| Perguntas se repetem e interrompem a equipe | Respostas orientadas por catálogo, FAQ, regras e roteiros | Menos trabalho repetitivo no atendimento | Pergunta de demonstração respondida com informação cadastrada |
| O interesse fica disperso nas mensagens | Contatos, histórico, resumo e funil | Visualizar cada oportunidade e seu próximo passo | Conversa associada à ficha e à etapa do contato |
| Marcar horário exige várias idas e vindas | Consulta de disponibilidade, agendamento e gestão de compromisso | Organizar o caminho até a avaliação | Horário disponível escolhido e compromisso criado |
| Confirmações e retornos dependem da memória | Regras de lembrete, recontato e acompanhamento | Dar continuidade à jornada | Regra configurada e evento de envio demonstrativo |
| A automação encontra uma exceção | Transferência para humano e pausa por conversa | Equipe no controle quando a situação pede uma pessoa | Botão de assumir e mudança explícita de estado |
| A gestão não sabe o que está acontecendo | Painel, funil e relatórios | Acompanhar operação e pontos de atenção | Relatório com período, origem e definição dos indicadores |
| O marketing perde contexto após o contato | Eventos e atribuição com integração Meta | Conectar etapas comerciais à medição, quando configurado | Evento de teste e status da integração; não promessa de melhora de campanha |

Benefícios como redução de faltas, mais vendas e tempo economizado são **hipóteses de impacto** até existirem medições. A presença da funcionalidade não comprova esse resultado.

## 5. O que vendemos

### Oferta em uma frase [PROPOSTA]

> Acesso à plataforma Alice e configuração do atendimento para conectar WhatsApp, organização dos contatos, agenda e acompanhamento, conforme o plano e o escopo acordados.

### As três partes que o cliente compra [PROPOSTA]

1. **Produto:** atendimento com IA nos planos pagos, painel de conversas, contatos, funil, agenda e recursos de acompanhamento.
2. **Configuração:** informações do negócio, serviços, regras, tom de voz, roteiros, horários e situações de passagem para a equipe.
3. **Operação acompanhada:** acesso da equipe, revisão do funcionamento e suporte conforme condições comerciais efetivamente combinadas.

O site afirma configuração inicial pela equipe e diferentes formas de suporte. Não há neste levantamento prova de prazo de implantação, SLA de suporte, revisão periódica executada nem cobrança automatizada. Não transformar essas possibilidades em compromissos sem definição comercial.

### Estrutura de proposta comercial pronta para preencher [PROPOSTA]

| Campo | Conteúdo a registrar |
| --- | --- |
| Contexto | Como chegam os contatos, quem responde e onde o próximo passo se perde |
| Objetivo | Organizar o fluxo acordado; registrar indicador de partida e meta definida com o cliente |
| Escopo | Canal, unidades, profissionais, recursos e automações que serão configurados |
| Responsabilidades | Quem fornece e aprova informações; quem assume exceções; quem faz ajustes |
| Entrega | Conta, configuração, validação em cenário de teste e orientação da equipe |
| Volume | Limite do plano e definição de atendimento contabilizado |
| Investimento | Valor comercial confirmado, periodicidade, implantação e eventuais custos adicionais |
| Condições | Vigência, renovação, suporte, cancelamento e reembolso confirmados |
| Aceite | Conferência do fluxo demonstrado e dos itens contratados |

**CTA comercial recomendado:** “Veja a Alice no fluxo da sua clínica.”

## 6. Planos: separar página comercial e implementação

### Retrato encontrado em 15/09/2026

| Plano | Anúncio no site [SITE] | Regra encontrada [CÓDIGO] |
| --- | --- | --- |
| Grátis / Free | Não aparece nos cards de planos da landing page lida | CRM, contatos, integração Meta, atendimento humano e agenda manual; IA atendendo e automações ficam bloqueadas |
| Realce | R$ 597/mês; até 100 conversas; recursos básicos; 1 unidade e 1 profissional | Limite padrão de 100 atendimentos/mês; recursos pagos liberados conforme `plan.ts` |
| Prime | R$ 897/mês; até 300 conversas; inclui automações, relatórios e até 3 profissionais | Limite padrão de 300 atendimentos/mês; mesmo conjunto de recursos pagos no controle de planos |
| Prestige | R$ 1.397/mês; conversas, profissionais e unidades ilimitados; funcionalidades adicionais e suporte prioritário | Limite de conversas representado por zero, isto é, sem teto nesse controle; mesmos recursos pagos no controle de planos |

**Definição técnica de atendimento:** uma conversa atendida pela Alice no mês; não cada mensagem. Há possibilidade de alteração administrativa do limite. Isso precisa ser explicado de modo uniforme em site, venda e painel.

**Divergências a resolver [VALIDAR]:**

- O site diferencia planos pagos por funcionalidades; o arquivo de regras informa que a diferença entre pagos é apenas o limite. Confirmar qual oferta deve valer e alinhar ambos.
- Limites de profissionais e unidades anunciados não foram demonstrados pelo controle de planos lido. Não tratar a tabela do site como prova de restrição técnica.
- A FAQ promete aviso antes do limite. O código lido avisa quando o limite já foi atingido: conversas já contabilizadas no mês seguem; novos atendimentos da Alice são encaminhados à equipe.
- Plano e vigência são controlados pela administração. O vencimento gera aviso e não bloqueia automaticamente; o bloqueio é administrativo. Esse fluxo não comprova cobrança recorrente, checkout nem reembolso automático.
- O selo “Mais escolhido” do Prime não vem acompanhado de evidência comercial nos arquivos lidos.

**Recomendação para o motion:** apresentar o produto e convidar para demonstração. Não inserir preços, gratuidade da IA, recursos exclusivos por plano ou garantias comerciais até unificar a oferta.

## 7. Mensagem central e pilares

### Mensagem central [PROPOSTA]

> Atendimento, agenda e acompanhamento. Tudo conectado pela Alice.

### Assinatura recomendada [PROPOSTA]

> **Alice. Cada conversa, um próximo passo.**

É curta, descreve a continuidade que o produto oferece e funciona como fechamento de motion. Na primeira peça, deve vir acompanhada do descritor para não ficar abstrata.

### Alternativas [PROPOSTA]

- “Do primeiro oi ao próximo atendimento.” — mais ligada à jornada da clínica.
- “Mais organização para atender melhor.” — mais sóbria e adequada a material comercial.
- “A conversa continua. Sua equipe acompanha.” — destaca automação e controle.

### Quatro pilares [PROPOSTA]

1. **Acolher:** responder com clareza e contexto.
2. **Organizar:** conectar conversa, contato e agenda.
3. **Continuar:** lembrar, confirmar e acompanhar conforme as regras.
4. **Dar controle:** mostrar o que acontece e permitir que a equipe assuma.

No motion de 60 segundos, mostrar uma jornada contínua. Reservar funcionalidades avançadas para demos específicas.

## 8. Pitches prontos [PROPOSTA]

### Uma frase

> A Alice conecta atendimento no WhatsApp, agenda e acompanhamento, com sua equipe no controle.

### Curto — aproximadamente 20 segundos

> A Alice é uma assistente virtual com IA para o WhatsApp da sua clínica. Ela responde dúvidas, organiza contatos e ajuda a agendar avaliações. Você acompanha as conversas no painel e assume quando precisar.

### Médio — para abertura comercial

> Na rotina da clínica, uma conversa pode ficar parada entre a primeira dúvida e o agendamento. A Alice conecta essas etapas: responde com base nas informações do seu negócio, organiza o contato, consulta horários e acompanha a jornada com lembretes e recontatos configurados. Sua equipe acompanha o histórico, vê as oportunidades no funil e assume as situações que precisam de uma pessoa. O objetivo é dar continuidade ao atendimento e reduzir o trabalho repetitivo da equipe.

### Explicação sem jargão

> Pense na Alice como uma assistente conectada ao WhatsApp e ao painel da clínica. Enquanto conversa, ela ajuda a registrar o que a pessoa procura e o que deve acontecer depois. A equipe consegue ver esse caminho e entrar na conversa.

## 9. Tom de voz

**[PROPOSTA] A marca fala com a mesma organização que promete ao cliente.**

| Característica | Como escrever | Evitar |
| --- | --- | --- |
| Acolhedora | Reconhecer a situação real da rotina | Culpar a recepção ou ridicularizar o trabalho humano |
| Clara | Explicar uma ação por frase | Empilhar IA, CRM, automação e integrações sem dizer para que servem |
| Confiante | Demonstrar mecanismos e limites concretos | “A melhor”, “infalível”, “revolucionária” sem comprovação |
| Próxima | “Sua equipe”, “sua clínica”, “próximo passo” | Intimidade forçada, exagero de emojis e diminutivos |
| Transparente | Dizer que é assistente virtual com IA | Fingir ser pessoa ou esconder automação quando perguntado |

### Vocabulário padronizado [PROPOSTA]

- **Atendimento**: jornada de conversa, com definição de contabilização em material de plano.
- **Contato**: pessoa registrada; “lead” só com públicos familiarizados.
- **Funil**: etapas do atendimento; explicar na primeira vez.
- **Recontato**: mensagem para retomar uma conversa; “follow-up” pode aparecer entre parênteses.
- **Assumir conversa**: ação clara para a equipe; “handoff” fica fora da comunicação pública.
- **Avaliação agendada**: usar quando for realmente esse serviço, sem chamar toda conversa de venda.
- **Faturamento em relatório**: explicar a origem do cálculo. O arquivo de relatórios usa preços associados a atendimentos; isso não equivale automaticamente a dinheiro recebido e conciliado.

### Microcopy de demonstração [PROPOSTA; dados fictícios]

- Abertura: “Oi! Sou a Alice, assistente virtual da clínica. Como posso ajudar?”
- Dúvida operacional: “A avaliação tem duração de 30 minutos. Você prefere manhã ou tarde?” Somente se essa duração estiver cadastrada na demonstração.
- Disponibilidade: “Encontrei estes horários disponíveis. Qual funciona melhor para você?”
- Confirmação: “Sua avaliação está agendada. Aqui estão a data, o horário e o endereço.”
- Humano: “Uma pessoa da equipe vai continuar o atendimento por aqui.”
- Falta de informação: “Vou confirmar essa informação com a equipe para te orientar corretamente.”

**Nota de alinhamento com o produto [CÓDIGO + PROPOSTA]:** a lógica atual contém instrução para não se apresentar como IA e responder de forma evasiva à pergunta sobre ser robô. A política de transparência acima é uma mudança recomendada, ainda não aplicada. Não anunciar que esse comportamento já está implementado.

## 10. Mensagens por canal [PROPOSTA]

### Página inicial

**Título:** “Seu atendimento no WhatsApp, conectado à agenda da clínica.”

**Subtítulo:** “A Alice responde dúvidas, organiza contatos e acompanha o próximo passo. Sua equipe vê o histórico e assume quando precisar.”

**CTA principal:** “Ver a Alice em ação”

**CTA secundário:** “Conhecer as funcionalidades”

### Bio de Instagram

> Assistente com IA para clínicas de estética. WhatsApp, agenda e acompanhamento em um só fluxo. Veja a Alice em ação ↓

### Legenda de lançamento

> Uma dúvida chega pelo WhatsApp. Depois dela, vêm o horário, a confirmação e o acompanhamento. A Alice ajuda sua clínica a conectar essas etapas, com a equipe acompanhando tudo pelo painel. Conheça o fluxo em uma demonstração.

### Anúncio curto

**Chamada:** “O próximo passo da conversa também merece atenção.”

**Texto:** “Conheça a Alice: atendimento com IA, agenda e acompanhamento conectados ao WhatsApp da sua clínica.”

**Botão:** “Ver demonstração”

### WhatsApp comercial

> Oi! A Alice ajuda clínicas a organizar o atendimento que chega pelo WhatsApp: responde dúvidas, conecta a agenda e acompanha o próximo passo. Na demonstração, mostramos uma conversa chegando até o agendamento e como a equipe assume quando precisa.

### E-mail de apresentação

**Assunto:** “Do WhatsApp à agenda: conheça a Alice”

> A Alice conecta as etapas do atendimento da sua clínica em um só fluxo. Com as informações e regras do negócio configuradas, ela responde dúvidas, organiza contatos e ajuda no agendamento. Sua equipe acompanha o histórico e assume as exceções. Veja como esse caminho funciona em uma demonstração.

### Encerramento do motion

> “Alice. Cada conversa, um próximo passo.”
>
> “Veja a Alice em ação.”

Todos os exemplos acima são textos preparados para revisão e uso. Nenhuma mensagem foi enviada a terceiros.

## 11. Objeções e respostas orientadoras [PROPOSTA]

| Objeção | Resposta base | O que demonstrar ou confirmar |
| --- | --- | --- |
| “Vai ficar com cara de robô?” | “Configuramos tom de voz, informações e roteiros do seu negócio. Vamos mostrar como ela responde a situações da sua rotina.” | Conversas fictícias variadas, incluindo ambiguidade e exceção |
| “Vou perder o controle?” | “Você acompanha pelo painel e pode assumir a conversa; enquanto sua equipe atende, a Alice fica pausada naquele contato.” | Assumir, responder e devolver |
| “Ela substitui minha recepcionista?” | “A proposta é automatizar etapas repetitivas e apoiar a organização. Sua equipe continua responsável por acolhimento, exceções e decisões que pedem uma pessoa.” | Limites e fluxo de transferência |
| “Ela conhece nossos serviços?” | “A configuração usa as informações, regras e materiais aprovados pela clínica.” | Catálogo, FAQ e briefing revisados; não prometer ausência total de erro |
| “Atende fora do expediente?” | “O atendimento automático pode receber e responder fora do expediente, conforme a configuração e a conexão. A agenda respeita os horários cadastrados.” | Separar atendimento, horário da agenda e janela das automações; sem SLA inventado |
| “Tenho muitas mensagens.” | “Vamos olhar o volume de atendimentos e escolher o plano correspondente, com o funcionamento do limite descrito na proposta.” | Contabilização por conversa/mês e encaminhamento ao atingir limite |
| “Ela dá orientação médica?” | “O foco é atendimento e organização. Dúvidas clínicas, avaliação e decisões de tratamento devem seguir para a equipe responsável.” | Regra de passagem para humano, sem apresentar trava como garantia absoluta |
| “Quanto vou vender a mais?” | “O efeito depende da operação. Podemos medir agendamentos, continuidade e comparecimento antes e depois da implantação.” | Métricas e período definidos; sem percentual antecipado |
| “Integra com meu sistema?” | “Há recursos de integração no projeto; precisamos verificar o sistema e o fluxo que você usa para confirmar o escopo.” | Integração específica funcionando; API disponível não significa integração pronta com tudo |

## 12. Promessas atuais que precisam de evidência

| Texto encontrado [SITE] | Situação observada | Direção recomendada [PROPOSTA] |
| --- | --- | --- |
| “< 5s”, “100% das conversas”, “+40%” | A própria seção tem comentário para substituir pelos números reais | Retirar da narrativa até medição documentada |
| Depoimentos, estrelas e casos numerados | Há comentário para substituir por depoimentos reais | Não usar nomes, falas nem resultados como prova; produzir demonstração identificada |
| “Configurada em até 30 minutos” e “em um dia” | Prazos no site, sem comprovação operacional lida | “Configuração guiada conforme o fluxo do seu negócio” |
| “A melhor” e “para qualquer negócio” | Afirmações amplas, sem comparação ou validação de aderência | Dizer o que faz e para qual cenário foi configurada |
| “Nunca fica sem resposta”, “responde na hora” | Absolutos incompatíveis com limites, transferência e dependência de conexão | Mostrar atendimento automático e continuidade sem prometer cobertura perfeita |
| “A Alice só fala o que você cadastrou” | Regras instruem a usar a base; isso não garante zero erro de modelo | “Responde com base nas informações e regras configuradas” |
| “Reduz faltas”, “aproveita cada contato” | Benefícios afirmados sem série de resultados | “Ajuda a confirmar compromissos e acompanhar contatos” |
| “Garantia incondicional de 7 dias” e “sem fidelidade” | Condições escritas no site, não verificadas em contrato/operação | Confirmar política comercial antes de repetir; não confundir com teste grátis |
| “Sem depender de folga, humor ou horário” | Texto de comparação desvaloriza a equipe | Valorizar organização e alívio de tarefas repetitivas |

### Mensagens que este sistema de marca não deve usar [PROPOSTA]

- “Nunca erra”, “100% seguro”, “100% em conformidade” ou “risco zero”.
- “Agenda cheia garantida”, “venda automática garantida”, “+40% de resultado” sem estudo documentado.
- “Substitua sua equipe” ou ataques à recepção como argumento de venda.
- “Sou uma pessoa de verdade” ou tentativa de ocultar IA diante de pergunta direta.
- “Diagnostica”, “prescreve”, “avalia resultados por foto” ou outros serviços clínicos não correspondentes ao papel da ferramenta.
- “Parceira oficial da Meta/WhatsApp”, “integra com qualquer sistema” ou certificações sem comprovação.
- “Teste grátis por 7 dias” deduzido de uma promessa de reembolso: são ofertas diferentes.
- Preços, nomes de clientes, depoimentos, métricas e selos inventados para preencher o layout.

## 13. Provas que podemos construir

**[PROPOSTA] Primeiro, provar o funcionamento com uma demonstração; depois, medir impacto.**

### Demonstração para o motion

Usar uma clínica fictícia e mostrar uma única jornada: mensagem recebida → informação correta → escolha entre horários disponíveis → avaliação agendada → contato organizado → equipe assumindo uma exceção. Legendar “Demonstração ilustrativa”. Não expor conversas, telefones, históricos ou nomes de clientes reais.

### Plano simples de evidências

| Alegação desejada | Evidência necessária |
| --- | --- |
| Resposta mais rápida | Tempo entre mensagem recebida e primeira resposta, com período, volume e exceções |
| Menos trabalho repetitivo | Amostra de tarefas manuais antes/depois e método consistente de medição |
| Mais continuidade | Percentual de contatos com próximo passo registrado, definindo o denominador |
| Mais agendamentos | Agendamentos por contato qualificado, com período e contexto comparáveis |
| Menos faltas | Faltas sobre compromissos elegíveis, controlando cancelamentos e remarcações |
| Caso de cliente | Autorização de uso, fatos conferidos e limites da comparação |

Relatórios e prints devem indicar se os dados são reais, anonimizados ou de demonstração. Números de exemplo não viram resultado comercial.

## 14. Decisões de marca já propostas e pendências

### Direção pronta para trabalhar [PROPOSTA]

- Público do primeiro motion: gestor de clínica de estética.
- Ideia central: o próximo passo da conversa não precisa se perder.
- Produto em foco: atendimento + agenda + acompanhamento + controle humano.
- Assinatura: “Alice. Cada conversa, um próximo passo.”
- Convite: “Veja a Alice em ação.”
- Prova visual: uma jornada fictícia completa e identificada, usando componentes do produto.

### Validar antes de publicar oferta definitiva [VALIDAR]

1. O público inicial será estética ou outro segmento prioritário?
2. A diferenciação dos planos será por volume, recursos ou também por serviço de implantação?
3. Quais preços, suporte, prazos e regras de cancelamento estão efetivamente aprovados?
4. Quais provas e depoimentos têm documentação e autorização de uso?
5. A apresentação transparente como IA será alinhada ao comportamento da assistente?

Essas definições não impedem preparar identidade, narrativa e animatic. Elas determinam quais afirmações comerciais podem entrar na peça final.
