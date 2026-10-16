# Lisboa Beauty Center — resposta ao checklist de 15/10/2026

Base: conferência do código (o que está no sistema), os testes automatizados e o histórico de entregas. **O que depende de ver o comportamento em produção está marcado como "validar em conversa real"** — o código não prova que a clínica não verá a falha de novo.

Legenda: **CONCLUÍDO** (no código + teste) · **EM ANDAMENTO** · **DEPENDE** (do Clínica Experts / de decisão ou texto da clínica) · **NÃO É POSSÍVEL**

## P0 — antes de considerar a Alice estável

| Entrega | Status | Observação |
|---|---|---|
| Confirmações sem duplicidade/erro | EM ANDAMENTO | Já no código: 1 confirmação por pessoa por dia (primeiro horário); texto igual ou do mesmo tipo (hoje/amanhã) não sai 2x em 20 h; trava de "uma cópia do servidor por tarefa" (JobLock) contra duas instâncias; reposição só para quem não recebeu nada. A repetição de 15/10 veio de uma regra copiada com o nome em negrito (corrigido em 15/10). Relatório das 20h mostra "confirmação enviada X de Y" e quem ficou de fora. **Validar:** acompanhar o relatório das 20h de hoje e de amanhã. |
| Fallback de reserva sem procedimento | DEPENDE | Hoje a reserva sem procedimento no Clínica Experts **não vira lembrete** (a equipe é avisada no relatório). O sistema já tenta achar o procedimento em outros campos e no detalhe da reserva, e há botão de diagnóstico. Para confirmar "só data e horário, sem citar procedimento" é preciso **decisão da clínica** (texto próprio) e uma mudança de modelo de dados. Proposta: texto "Olá {nome}! Confirmando seu horário amanhã, dia X às Y…" sem procedimento. |
| Agendamento real de procedimentos no CE | CONCLUÍDO no código · validar em conversa real | Alice agenda o procedimento que a pessoa pediu (avaliação só para quem não sabe), consulta a agenda real, pede nome completo, e **só diz "agendado" depois que o Clínica Experts aceita** (se recusar, desfaz e passa para a equipe). Pendência de catálogo: "Protocolo do Olhar" não existe no CE — para agendar direto, é preciso cadastrar o procedimento ou um apelido. |
| Parar de vender depois de agendar | CONCLUÍDO no código · validar | Quem tem horário só recebe resposta ao que perguntou; "obrigada" fecha com uma frase; etiqueta interna "Agendado: data – procedimento" corta a oferta de horário/avaliação. Vale para agendamento da Alice, da equipe, do painel e do CE. |
| Intenção/procedimento; bloquear não-clientes | CONCLUÍDO (currículo) · **novo hoje:** fornecedor, parceria e cobrança | Currículo/vaga vai para a equipe em silêncio (olha as últimas 12 mensagens, inclusive anexo seguido de "obrigada"). **Hoje** entrou o mesmo tratamento para representante/fornecedor oferecendo produto, proposta de parceria/influenciador e cobrança/boleto de empresa — com frases fortes de propósito, para "tem parceria com convênio?" ou "posso pagar no boleto?" continuarem sendo atendidos como paciente. Trava de relevância já barra procedimento de outra região (labial para sobrancelha). Suporte/outros: dizer quais outros casos a clínica já recebeu. |
| Recontato do dia seguinte às 8h | EM ANDAMENTO | O recurso existe (regra "dia seguinte às 8h", janela 8h–12h), mas **não consegui confirmar a causa da falha de 15/10 sem ver os dados de produção**. Suspeita principal: a migração que liga o horário fixo só atingiu a regra de ordem 2 com exatamente 1440 min; se a regra em produção estiver diferente, ficou em "24 h corridos". **Hoje** o relatório das 20h passou a listar cada recontato ativo e quando dispara ("dia seguinte às 8h" × "N de silêncio") e quantos saíram no dia — isso mostra a configuração real já na próxima noite. Observação: quem escreve à noite recebe primeiro a mensagem de "4 horas" às 8h (ordem da cascata) e a de 1 dia só no dia seguinte; posso ajustar para pular a mensagem atrasada se a clínica preferir. |

## P1

| Entrega | Status | Observação |
|---|---|---|
| Regra Mestra + limpeza | EM ANDAMENTO | Limpeza aprovada parcialmente foi aplicada; faltam as decisões D1–D6 da proposta (docs/regra-mestra-lisboa.md) e aplicar 470/468/486. |
| Valores | CONCLUÍDO no código · validar | Lisboa: Alice informa preço cadastrado vigente (`handoffOnPrice` desligado); anúncio usa a condição do anúncio; dúvida/negociação vai para a equipe. Validar com 1 lead de anúncio e 1 orgânico. |
| Máximo de 3 horários | CONCLUÍDO | Até 3 por rodada, com pergunta de turno. |
| Avaliação sem insistência / "vou pensar" | CONCLUÍDO · validar | Avaliação no máximo 1 vez por contexto; roteiro "vou pensar" reescrito sem empurrar avaliação. |
| Transferência e silêncio | EM ANDAMENTO | Lisboa está em "silêncio ao transferir". O combinado agora é **frase curta antes** do takeover e silêncio depois — preciso do texto da frase e ajusto. |
| Nome completo / cancelamento / remarcação | CONCLUÍDO no código · validar | Cancelar pela Alice remove do Clínica Experts/Google e oferece reagendar. Validar um cancelamento real ponta a ponta. |
| Só a primeira confirmação (vários horários) | CONCLUÍDO | Vale para horários no **mesmo dia**. Horários em dias diferentes recebem uma cada. Confirmar se é isso que a clínica quer. |
| Pré-procedimento 48 h | CONCLUÍDO | Sai 48 h antes; agendamento com menos de 48 h não dispara o pré. |
| Pós ~1 h | CONCLUÍDO · **ajustado hoje** | Conta a partir do fim do atendimento. **Hoje:** avaliação não recebe mais pós-procedimento (a menos que a regra liste a avaliação de propósito). |
| Aniversariantes | DEPENDE | Pipeline e job prontos; regra nasce **desligada** até conferir os contatos. Preciso do texto final com a cortesia válida até o dia 30 e o ok para ligar. |
| Recontatos 4h…180d / filtro de não recontatar | EM ANDAMENTO | Já respeitam opt-out, "sem interesse", horário marcado, pós, reação, retorno combinado ("depois do dia 20" vira data de retorno). Cadência hoje cadastrada: 4h, 1d, 3d, 7d, 15d; 45/60/120/180 d não constam no cadastro padrão (se já foram criadas em produção, me avise) — mandar os textos. |
| Data/dia da semana e agenda real | CONCLUÍDO | Trava de dia/hora (só cita o que a agenda devolveu) e conferência com o que a clínica escreveu. |
| Nota 0–10 | EM ANDAMENTO | Pesquisa pós-atendimento e registro de nota existem; para avaliação o texto da Aline já está aplicado. Falta confirmar o texto "De 0 a 10…" para os demais atendimentos e se a pesquisa está ligada. |
| Avaliação no Google | EM ANDAMENTO | **Link recebido em 16/10** e gravado para a Lisboa (só preenche se estiver vazio). Fluxo já existe: quando a pessoa dá a nota na pesquisa e ela é ≥ a nota mínima (hoje 9, ajustável em Configurações), a Alice agradece e envia o link, e a **indicação vai em mensagem separada**. Falta confirmar: pesquisa de satisfação ligada para os atendimentos que não são avaliação e a nota mínima que a clínica quer. |
| Pedido de indicação | EM ANDAMENTO | Ainda não implementado como fluxo. Preciso do texto e do momento (ex.: 2 dias após o atendimento, separado da confirmação). |
| Reativação mensal dia 20 | EM ANDAMENTO | Job de campanha mensal existe (dia configurável). Falta confirmar o dia 20 na clínica e validar o primeiro disparo. |
| Renovações (Botox 4m, bio 1a, preench. 1a, limpeza 2m) | EM ANDAMENTO | Motor de renovação por procedimento existe; o cadastro padrão só traz a reativação de 6 meses; as 4 regras com os textos precisam ser conferidas em produção, ligadas e testadas. |
| Segunda: avaliações canceladas / realizadas não fechadas | EM ANDAMENTO | Fluxos específicos ainda **não existem**; base de dados (status cancelado/compareceu, proposta aberta) existe. |
| Pacotes/sessões, pacote parado >10 dias, sinal pendente | DEPENDE | Dependem de o Clínica Experts expor saldo de sessões/pagamento pela API; vou confirmar com eles e, se não expuser, propor controle no CRM. |
| Validade de condição comercial | EM ANDAMENTO | Precisa do campo "válida até" por condição; sem data cadastrada, nenhuma urgência é criada. |
| Etiqueta nativa no WhatsApp | DEPENDE | Hoje a origem/data e a situação (Agendado/Não agendado) ficam no CRM como etiqueta interna; etiqueta nativa depende de suporte do provedor — se não houver, assumir o CRM como fonte única. |
| Comprovantes | EM ANDAMENTO | Falta a regra da clínica (reconhecer, encaminhar, quem confirma). |

## P2 — ordem sugerida
1. Recuperar agendamento iniciado e não concluído + lead quente · 2. Objeções com banco de respostas · 3. Lista de encaixe e alerta de agenda fraca · 4. Resumo final do agendamento · 5. Relatórios de dinheiro parado, conversão e dúvidas frequentes · 6. Satisfação no texto, consentimento de imagem, opt-out promocional, auditoria semanal.

## O que preciso da clínica para destravar
1. Decisão: texto de confirmação para reserva sem procedimento.
2. Frase curta antes de a equipe assumir.
3. Link do Google e nota mínima.
4. Texto de indicação e quando enviar.
5. Texto final do aniversário (cortesia até dia 30).
6. Textos das cadências 45/60/120/180 dias e das 4 renovações.
7. Decisões D1–D6 da Regra Mestra.
