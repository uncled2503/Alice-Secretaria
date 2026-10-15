# Atribuição de anúncios, etiquetas e feedback de qualificação para a Meta

Implementado em 15/10/2026 (código em `src/ads/`, testes em `tests/anuncios.test.mjs`).

## O que é capturado (por entrada de anúncio — tabela `AdAttribution`)
`source_id` (ID do anúncio), `source_type`, `ctwa_clid`, `headline`, `body`, `source_url`, `media_type`, plataforma (só se a URL deixar claro: Instagram/Facebook), WABA ID (da configuração da clínica), data/hora, conversa, ID interno do lead, ID da mensagem (idempotência) e os **nomes dos campos** recebidos (`rawKeys`, para diagnóstico). Só existe entrada quando o referral traz `source_id` **ou** `ctwa_clid` — nunca por palavra-chave, mensagem padrão ou URL isolada. A captura roda em toda mensagem que traga referral (a primeira é a que normalmente traz) e é idempotente. O mesmo contato voltando por outro anúncio gera **nova entrada** (`new_ad` / `new_click`); a primeira origem nunca é sobrescrita.

Nome do anúncio, conjunto e campanha **não vêm no webhook**: são buscados na Marketing API pelo `source_id` (`AdCatalog`). Sem permissão/ token, fica o ID e o aviso "nome ainda não identificado". Nunca bloqueia a mensagem.

## Etiquetas automáticas (`Tag.system`)
Origem: Meta Ads (+ Facebook Ads / Instagram Ads quando identificável), WhatsApp Orgânico (só quando há WABA configurado, isto é, o referral é confiável) ou Origem Não Identificada. Situação: Lead Novo → Em Qualificação → Lead Qualificado **ou** Lead Desqualificado (nunca os dois). Marcos: Agendamento Realizado, Venda Realizada. Cores distintas; aparecem na lista de Pessoas, na Jornada e no cabeçalho da conversa; filtros por situação e origem em Pessoas e por situação na Jornada. Etiquetas da equipe nunca são tocadas.

## Classificação (`LeadClassification`)
Manual (aba "Origem e qualificação" do contato), por etapa (etapas mapeadas em Meta > mapeamento) ou **sugestão da IA** (pendente de revisão humana; só vira etiqueta/evento depois de confirmada, salvo "aprovar automaticamente", que é opt-in e fica registrado). Histórico com quem, quando, motivo e origem. A IA só usa motivos comerciais de uma lista fixa e nunca dado de saúde; silêncio/demora não desqualifica.

## O que é enviado à Meta
- **Envio antigo ("website")**: continua exatamente como era (pixel/dataset do site; eventos Lead, Schedule, CRMStageChanged, QualifiedLead, DisqualifiedLead, Purchase, LostLead por etapa). Não foi alterado.
- **Novo — API de Conversões para mensagens comerciais (WhatsApp)**, desligado por padrão (`MetaConfig.messagingEnabled`), conforme a documentação oficial: `POST /{DATASET_DO_WABA}/events`, `action_source: business_messaging`, `messaging_channel: whatsapp`, `user_data { whatsapp_business_account_id, ctwa_clid }`. Eventos: **QualifiedLead** (lead qualificado, uma vez por lead+entrada de anúncio) e **Purchase** (venda, só por decisão humana; com valor quando informado). Elegível apenas com: envio ligado + token + WABA + dataset + `ctwa_clid` do lead. Caso contrário o evento fica registrado como `skipped` com o motivo ("não elegível") e pode ser reavaliado.
- **Fica só na Alice**: desqualificação e agendamento — a API de mensagens comerciais **não tem** evento oficial para eles (lista oficial: Purchase, LeadSubmitted, InitiateCheckout, AddToCart, ViewContent, OrderCreated, OrderShipped, OrderDelivered, OrderCanceled, OrderReturned, CartAbandoned, QualifiedLead, RatingProvided, ReviewProvided). Nada é "emprestado" de outro evento.

## Limitações que dependem da Meta / da conta
- Exige WhatsApp Business Platform (WABA, Cloud API), dataset ligado ao WABA, app com acesso avançado a `whatsapp_business_management` e `whatsapp_business_manage_events`, e token com essas permissões.
- O `ctwa_clid` só aparece no webhook da API oficial. A Alice recebe mensagens pelo gateway UAZAPI (QR code): se ele não entregar o `referral` (ou `source_id`/`ctwa_clid`), não há atribuição nem como devolver a conversão. **Validar com uma conversa real de anúncio** (ver `rawKeys` da entrada).
- A Meta não deduplica eventos: a deduplicação é nossa (`event_id` único por lead+entrada / transição).
- Otimização de campanha por QualifiedLead/Purchase depende da campanha na conta de anúncios; os eventos só fornecem sinal de conversão. Otimização por compra não está disponível para Instagram (segundo a documentação).
- Custos (investimento, custo por lead/qualificado/agendamento/venda) **não** foram implementados: exigem a Marketing API de insights liberada.

## Relatório "Desempenho dos Anúncios" (Resultados)
Dados reais do CRM, com filtros por período, campanha, conjunto, anúncio, atendente e situação. Lead = pessoa que entrou pelo anúncio no período; cada resultado conta uma vez, no anúncio da entrada mais recente do lead no período. **Não** são as conversões atribuídas pela Meta no Gerenciador de Anúncios.
