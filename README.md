# Alice — secretária virtual para clínicas de estética

MVP enxuto pra manter custo mínimo enquanto não tem volume, e escalar peça por
peça conforme os leads forem aparecendo.

## Stack (barata de propósito)
- **Node.js + TypeScript**, um único processo (servidor HTTP + cron no mesmo processo).
- **SQLite** via Prisma — banco em arquivo, zero custo de hospedagem de DB. Trocar para Postgres depois é só mudar `provider` no `prisma/schema.prisma`.
- **OpenAI** (`gpt-4o-mini` por padrão) como modelo de IA — barato, dá conta de qualificar lead e agendar. Troque via `OPENAI_MODEL` no `.env` se quiser mais qualidade ou não tiver acesso a esse modelo na sua conta.
- **UazAPI** para conectar o WhatsApp via QR Code (sem precisar de aprovação da Meta Business).

Custo variável: você só paga por token de IA e por mensagem no gateway conforme o uso real — não há infraestrutura fixa além de onde hospedar o processo (pode rodar num VPS de ~R$20-25/mês, ou até local pra validar antes de colocar em produção).

## Setup

1. Instalar dependências:
   ```
   npm install
   ```
2. Copiar `.env.example` para `.env` e preencher:
   - `OPENAI_API_KEY` (platform.openai.com)
   - `UAZAPI_BASE_URL`, `UAZAPI_TOKEN` (token da INSTANCIA, obtido em `/instance/create` com o admintoken da sua conta UazAPI — ver nota abaixo)
   - `ADMIN_USER` / `ADMIN_PASSWORD`: login do painel em `/admin` — troque por uma senha forte antes de expor o servidor na internet
3. Criar o banco e rodar as migrações:
   ```
   npx prisma migrate dev --name init
   ```
4. Popular com uma clínica de exemplo:
   ```
   npx tsx prisma/seed.ts
   ```
5. Subir o servidor em modo dev:
   ```
   npm run dev
   ```
6. Configurar na UazAPI o webhook de mensagens recebidas apontando para:
   `https://SEU-DOMINIO-OU-TUNNEL/webhook/uazapi`
   (em dev local, use um túnel tipo `ngrok http 3000` ou `cloudflared tunnel`, ambos gratuitos)
7. Conectar o WhatsApp da clínica escaneando o QR Code (via `POST /instance/connect` da UazAPI, com o token da instância).
8. Acessar o painel administrativo em `http://localhost:3010/admin` (usuário/senha do `.env`) pra ver contatos, conversas e agenda.

**Nota sobre UazAPI**: existem dois tipos de token — o **admintoken** (gerencia todas as instâncias do servidor: criar, listar) e o **token da instância** (usado pra mandar/receber mensagens de UM WhatsApp conectado). Só o segundo vai no `.env`. Endpoints confirmados na prática contra a uazapiGO (motor por trás da UazAPI): `POST /instance/create` (admintoken) cria a instância e devolve o token dela; `POST /instance/connect` (token da instância) gera o QR code; `POST /send/text` envia mensagem; `GET /instance/status` confirma conexão.

## Múltiplas clínicas
O sistema atende quantas clínicas você quiser, cada uma com seu próprio número de WhatsApp:
- Cada mensagem que chega no webhook é roteada pela clínica certa usando o `token` da instância UazAPI que a recebeu (campo no payload do webhook) — não pelo número de telefone, que pode vir mascarado.
- Se nenhuma clínica tiver aquele token cadastrado, cai automaticamente na clínica "legada" (a que tem `uazapiToken` nulo, usando `UAZAPI_BASE_URL`/`UAZAPI_TOKEN` do `.env`) — assim, quem só usa uma clínica não precisa configurar nada extra.
- Pra cadastrar uma segunda clínica: aba **Clínicas** no painel (nome, telefone, token da instância UazAPI dela, URL base se for diferente). Depois disso, o seletor de clínica no topo do painel troca todo o contexto (contatos, CRM, chat, agenda, recontato, mensagens, regras) pra clínica escolhida.
- Cada clínica tem seus próprios procedimentos, funil, regras e mensagens — totalmente isolados. Depois de cadastrar uma clínica nova, adicione os procedimentos dela na aba **Procedimentos** antes de conectar o WhatsApp — sem isso, a Alice não tem o que oferecer.

## Painel administrativo (`/admin`)
Layout em sidebar lateral (Início / Clientes / Operação / Conta), paleta laranja/âmbar, tema claro/escuro (botão no rodapé da sidebar, lembrado por navegador). Nove seções:
- **Início**: indicadores do período (atendidos pela Alice, agendamentos, concluídos), gráfico de atendimentos por dia e um mini calendário do mês com os dias que têm agendamento destacados.
- **Contatos**: lista de pacientes/leads capturados pela Alice, com busca e opção de adicionar contato manualmente (ex: alguém que ligou ou apareceu na clínica).
- **CRM**: funil kanban, com 10 etapas padrão (Novo lead → Qualificando → ... → Fechou procedimento/Pós-procedimento/Recuperação/Perdido) criadas automaticamente na primeira vez que uma clínica é usada. Totalmente customizável por clínica em "Configurar etapas do funil" (dentro da própria aba): adicionar, renomear, recolorir, reordenar ou remover etapas — remover realoca os pacientes daquela etapa pra primeira restante, sem deixar ninguém órfão. Quando a Alice agenda uma avaliação, o lead avança automaticamente para a etapa marcada com o tipo "Avaliação agendada" (funciona mesmo se você renomeou essa etapa); o resto do funil se move manualmente pelo dropdown de cada card. Tem busca por nome/telefone no topo.
- **Chat**: conversas em andamento, com abas de filtro (Todos/Alice/Humano) e cabeçalho mostrando quem está atendendo. Dá pra "assumir" uma conversa manualmente (a Alice para de responder ali) e devolver o controle depois.
- **Agenda**: grid de calendário de verdade (horários de 7h-20h em colunas por dia) nas visões Hoje/Semana; Mês cai pra lista por tabela (grid de mês inteiro ainda não existe). Opção de agendar manualmente (nome, telefone, procedimento, data/hora) sem precisar passar pela conversa com a Alice.
- **Recontato**: cascata de 5 mensagens automáticas (`FollowUpRule`) disparadas quando o paciente fica X dias sem responder. Edite texto/prazo/ativo por etapa direto na tela. O gatilho é o "silêncio" do paciente (não conta mensagens nossas), reinicia se ele responder, e pausa sozinho se já existe agendamento confirmado. No primeiro disparo, o lead vai automaticamente pra etapa "Recuperação" no CRM.
- **Mensagens**: campanha avulsa (título + mensagem + data/hora + destino: todos ou um estágio do funil). Roda a cada 5 minutos, envia em lotes de 20 e só dentro do horário comercial da clínica. Dá pra cancelar enquanto ainda não começou a enviar.
- **Personalizar Alice**: descreva em texto livre o que quer mudar no atendimento; a IA classifica numa categoria (Agendamento, Pagamento e sinal, Tom de voz, Chamar a equipe, Procedimentos) e escreve a regra, ou pergunta o que falta se a informação for insuficiente. Só entra em vigor depois que você aprova — regras ativas são injetadas automaticamente no prompt da Alice (`src/ai/rules.ts`).
- **Procedimentos**: lista, adiciona, edita e remove os procedimentos que a Alice pode oferecer/agendar para a clínica selecionada.
- **Clínicas**: cadastra clínicas novas (nome, WhatsApp, credenciais UazAPI próprias) e lista as existentes. O seletor no topo do painel troca qual clínica as outras abas mostram.

Protegido por HTTP Basic Auth (`ADMIN_USER`/`ADMIN_PASSWORD`) — suficiente pra uso interno de uma clínica só; se mais de uma pessoa da equipe for acessar com senhas próprias, vale evoluir para login por usuário.

Mensagens de voz também funcionam: a Alice usa a transcrição embutida da UazAPI (que chama o Whisper da OpenAI com a mesma `OPENAI_API_KEY`) — só paga quando alguém realmente manda áudio, custo zero em silêncio. Imagem/vídeo/documento ainda são ignorados (não tem transcrição pra eles).

## Rodando em produção (pm2)
Pra não depender do terminal aberto (`npm run dev`), o projeto já vem com `pm2` como dependência de desenvolvimento e um `ecosystem.config.js` configurado:
```
npm run pm2:start    # builda e sobe com reinicio automatico se cair
npm run pm2:status   # ve se esta rodando, quantos restarts, uso de memoria
npm run pm2:logs     # acompanha os logs
npm run pm2:restart  # rebuilda e reinicia (depois de mudar codigo/env)
npm run pm2:stop     # para o processo
```
Testado matando o processo Node manualmente: o pm2 detectou a queda e subiu de novo sozinho em poucos segundos. Isso resolve o "processo caiu e ninguém percebeu" — mas não substitui monitoramento de verdade (ex: um alerta se o `/health` parar de responder por muito tempo, o que ainda não existe aqui).

## O que falta pra virar produto de verdade
- **Monitoramento/alerta**: o pm2 reinicia sozinho, mas ninguém é avisado se isso acontecer repetidamente ou se o serviço UazAPI/OpenAI cair.
- **Servidor UazAPI de produção**: a integração foi validada contra o servidor demo público (`free.uazapi.com`), que desconecta e apaga instâncias de teste depois de 1h — bom só pra validar, não pra uso real. Pra colocar a clínica em produção, criar uma instância paga/dedicada (própria conta ou self-host) e trocar `UAZAPI_BASE_URL`/`UAZAPI_TOKEN`.

## Estrutura
```
src/
  server.ts           # Express: recebe webhook, monta painel e API, dispara resposta
  ai/alice.ts         # Prompt da Alice + function calling (OpenAI) pra consultar agenda e agendar
  scheduling/slots.ts # Calcula horários livres a partir dos agendamentos existentes
  uazapi/client.ts    # Cliente HTTP do gateway de WhatsApp (envio, status, transcricao de audio)
  reminders/cron.ts   # Lembrete automático 24h antes do agendamento
  crm/stages.ts       # Etapas do funil kanban por clinica (auto-cria as 10 padrao na 1a vez)
  crm/followup.ts     # Cascata de recontato por silêncio (roda a cada hora)
  crm/broadcast.ts    # Mensagens programadas em massa (roda a cada 5 min, em lotes)
  ai/rules.ts         # Transforma texto livre em regra estruturada (Personalizar Alice)
  api/routes.ts       # REST usado pelo painel (/api/clinics, /dashboard/stats, /procedures, /contacts, /conversations, /appointments, /crm/board, /funnel-stages, /followup-rules, /broadcasts, /rules)
  api/auth.ts         # HTTP Basic Auth do painel/API
  db/client.ts        # Prisma client
public/               # Painel administrativo (HTML/CSS/JS puro, sem build)
prisma/schema.prisma  # Modelo de dados (Clinic, Procedure, Patient, Conversation, Appointment)
```
