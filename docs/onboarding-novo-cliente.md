# Onboarding de novo cliente — o que precisamos saber

Este documento é **complementar** ao [briefing do cliente](briefing-cliente.md).
O briefing treina a Alice (tom, procedimentos, regras, FAQ, automações). Este aqui
cobre o resto: contrato, acessos, conexões e agenda. Responda o que souber;
o que ficar em branco vira pendência na lista do final.

---

## 1. Contrato e plano
- [ ] Nome do cliente / razão social e quem é o responsável pela conta
- [ ] Tipo de negócio: **clínica** (paciente, procedimento, agenda) ou **geral** (loja, serviço, sem agenda)? Se geral, como descrever o negócio em uma frase?
- [ ] Plano: **Grátis** (só CRM + Meta) / **Realce** / **Prime** / **Prestige**
- [ ] Data de início e data de vencimento do plano (ou sem prazo)
- [ ] Limite mensal de atendimentos da Alice diferente do padrão do plano?
- [ ] Como e quando o cliente paga (para não bloquearmos a conta por engano)

## 2. Acesso ao painel
- [ ] Quem vai usar o painel? Para cada pessoa: nome, e-mail/login e função (dono, recepção, profissional)
- [ ] Alguém que **não** deve ver certas áreas (ex.: financeiro, conversas)?
- [ ] Quem recebe o treinamento de uso e em que data

## 3. WhatsApp
- [ ] Número que ficará conectado à Alice (com DDD) — é um número **novo** ou o que a clínica já usa hoje?
- [ ] Alguém com o celular desse número em mãos para ler o QR Code na conexão?
- [ ] O número tem histórico de conversas que queremos **importar** (contatos e mensagens antigas)?
- [ ] A equipe continuará respondendo pelo celular/WhatsApp Web junto com a Alice? (isso é suportado)
- [ ] Número que recebe os **avisos internos** (novo agendamento, cancelamento, transferência para humano). Pode ser o mesmo número conectado?
- [ ] Quais avisos esse número deve receber: novo agendamento, cancelamento, pedido de atendimento humano, falha de envio?

## 4. Agenda
- [ ] Horário de funcionamento e dias de atendimento (incluindo sábados específicos)
- [ ] Intervalo de almoço? Horário (aceita meia-hora)
- [ ] Fecha nos **feriados nacionais** automaticamente?
- [ ] Cada profissional tem **agenda própria**? Horários diferentes da clínica?
- [ ] Dois profissionais atendem **no mesmo horário** (ex.: médico + enfermagem)? Cada pessoa vira um profissional separado no sistema
- [ ] Algum procedimento atende **por ordem de chegada** (vários pacientes no mesmo horário, ex.: aplicações)?
- [ ] Bloqueios já conhecidos: férias, congressos, dias sem atendimento
- [ ] A recepção pode agendar fora do expediente pelo painel? (a Alice sempre segue o horário à risca)
- [ ] Usam **Google Agenda**? Qual conta Google? (sincronização nos dois sentidos; precisa de autorização do dono da conta)
- [ ] Já tem agenda atual (planilha, outro sistema) com pacientes agendados para migrarmos?

## 5. Pacientes e CRM
- [ ] Tem lista de pacientes/contatos para importar? Em que formato (planilha, outro sistema)?
- [ ] Etapas do funil que a clínica usa hoje (ex.: novo contato → avaliação agendada → fechou). Usamos o padrão ou personalizamos?
- [ ] Quem é o responsável padrão pelos leads?
- [ ] Etiquetas (tags) que já usam para classificar pacientes
- [ ] Controle de **ativo/inativo** e lembrete de **renovação de receita**: faz sentido para o cliente?

## 6. Financeiro do atendimento
- [ ] Cobra **sinal**? Valor ou %, e a chave **Pix** (por procedimento ou única)
- [ ] A Alice só confirma o agendamento depois do **comprovante** do sinal?
- [ ] Link de pagamento por procedimento?
- [ ] Tem **fotos de antes/depois** que a Alice pode enviar por procedimento? (precisamos dos arquivos)

## 7. Meta (Instagram/Facebook Ads) — se o cliente anuncia
- [ ] O cliente roda anúncios? Quer medir resultado real (agendou, fechou, perdeu)?
- [ ] ID do **Pixel/Dataset** da Meta
- [ ] **Token da API de Conversões** (gerado no Gerenciador de Eventos)
- [ ] URL oficial do site
- [ ] Qual etapa do CRM conta como: lead qualificado, desqualificado, **venda fechada**, **perdido**?
- [ ] Alguma etapa que **não** deve enviar evento?
- [ ] Alguém com acesso de administrador à conta de anúncios para validar em "Eventos de teste"

## 8. Pós-atendimento
- [ ] Quer pesquisa de satisfação (NPS)? Quantas horas depois do atendimento? Nota a partir da qual pedimos avaliação no Google?
- [ ] Link de avaliação do **Google Meu Negócio**
- [ ] Mensagem de aniversário: quer? Em que horário?

## 9. Integrações e canais extras
- [ ] Link de auto-agendamento externo que a Alice possa mandar
- [ ] Site: quer o formulário/agendamento do site conectado ao CRM? Endereço do site
- [ ] Outro sistema que precise conversar com a Alice (via API)? Qual?
- [ ] Outros canais além do WhatsApp (Instagram direto, site)?

## 10. Lançamento
- [ ] Data desejada para a Alice entrar no ar
- [ ] Período de **teste acompanhado**? (Alice responde, equipe revisa as conversas antes de soltar de vez)
- [ ] Quem avisa os pacientes/equipe de que a clínica agora tem a Alice
- [ ] Quem é a pessoa de contato para dúvidas na primeira semana
- [ ] Como a clínica quer ser avisada de problemas (WhatsApp, e-mail)

---

## Checklist de pendências (preencher ao final)
| Item | Quem providencia | Prazo |
|------|------------------|-------|
|      |                  |       |
