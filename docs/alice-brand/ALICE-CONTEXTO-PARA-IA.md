# Alice: contexto portátil para criação

Use este texto junto do roteiro e dos assets. Data: 15/09/2026. É uma síntese da auditoria do repositório local e de uma proposta de marca; não certifica funcionamento em produção.

## Produto

Alice é uma assistente virtual com IA para atendimento no WhatsApp, conectada a CRM, agenda e automações de acompanhamento. O projeto tem uma base para clínicas e adaptação para lojas/negócios gerais. O primeiro motion assume clínicas de estética como foco, sujeito a ajuste do proprietário.

O cliente compra continuidade no atendimento, organização dos contatos e apoio à rotina da equipe. Benefícios esperados: menos tarefas repetitivas, próximos passos mais claros e oportunidades acompanhadas. Não há comprovação fornecida para aumento percentual de vendas ou redução percentual de faltas.

Recursos encontrados em código: conversa com contexto configurável, transcrição de áudio recebido, análise de imagens, atendimento humano com transferência, contatos, CRM configurável, agendamento, lembretes, recontato, campanhas, pós-procedimento, renovação, aniversário, pesquisa de satisfação, catálogo, profissionais, relatórios, múltiplas clínicas, API externa, Google Agenda e Meta API de Conversões. Recursos externos dependem de credenciais/configuração; não confundir código existente com recurso funcionando numa conta real.

Limites: não prometer ligações, voz sintetizada automática, diagnóstico, checkout, estoque, faturamento financeiro conciliado, Pixel de navegador automaticamente instalado nem sincronização bidirecional completa de calendários. Aprendizado gera sugestões para aprovação. O README ficou desatualizado em API externa e mídias; o inventário detalhado usa código como referência.

Planos implementados: Grátis com CRM, chat humano, Meta e agenda manual; pagos Realce, Prime e Prestige com os mesmos recursos pagos e limites de 100, 300 e ilimitado para novas conversas atendidas pela Alice no mês, com possibilidade de ajuste administrativo. O site apresenta ofertas que divergem desse controle. Não colocar preço/limite/oferta no filme antes da consolidação comercial.

## Marca proposta

- Nome: Alice. Grafia do asset: ALICE IA.
- Conceito: **Do primeiro contato ao próximo passo.**
- Categoria: assistente virtual com IA para atendimento e acompanhamento no WhatsApp.
- Tom: próximo, claro, responsável, competente; sempre transparente sobre ser uma assistente virtual.
- CTA: **Agende uma demonstração.** Destino a definir.
- Preservar logo, logo branco e personagem de `public/assets/`.
- Fundo #FFFAF2; texto #231A12; CTA #C2410C com branco; destaque #F59E0B com texto escuro.
- Escuro: fundo #141210; cartões #211C18; texto #FFF7ED; acento #FDBA74.
- Poppins títulos; system-ui no corpo/interface.
- Uma linha âmbar conecta conversa, contato, agenda e acompanhamento. Mostrar tarefas e evolução de estado com movimento discreto.

## História de 60 segundos

0–7s rotina com mensagens pendentes; 7–13s Alice; 13–23s atendimento contextual; 23–31s consulta de horário e agendamento; 31–39s CRM; 39–47s lembrete e recontato em contatos diferentes; 47–54s equipe assume; 54–60s marca e CTA.

Mostrar dados fictícios e interfaces de demonstração. Não inventar depoimentos, resultados, certificações ou telas de recursos inexistentes. Texto, logo e interface precisam permanecer legíveis. Usar roteiro 04 para locução exata, storyboard e cortes.

## Resultado esperado

Master 1920×1080, versão recomposta 1080×1920, 30 fps, 60 s; cortes posteriores de 30 e 15 s. Entregar arquivos de projeto e conferir MP4 real quando houver render. Uma prévia HTML/React é animatic interativo, não garantia de exportação de vídeo.

Autoridade dos arquivos: `02-inventario-funcional.md` para fatos/limites; `01-posicionamento-e-comunicacao.md` para estratégia; `03-design-system.md` e `alice.tokens.json` para proposta visual; `04-roteiro-motion.md` para o filme de 60s (master 16:9 + cortes); `05-producao-chatgpt-claude.md` para execução em Remotion/Claude Code; `06-reels-vertical-e-sora.md` para o corte vertical nativo (9:16, 22s) e o guia específico de uso do Sora como camada de atmosfera.

Atualização de 16/09/2026: `alice.tokens.json` foi gerado (estava referenciado nos arquivos 04/05 mas não existia) e `06-reels-vertical-e-sora.md` foi adicionado a pedido do dono, depois de confirmar destino Reels/Instagram vertical e uso do Sora. Nenhum dos arquivos 01–05 foi alterado.
