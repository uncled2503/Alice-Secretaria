# Alice — Secretária Virtual Humanizada para clínicas de estética

MVP enxuto pra manter custo mínimo enquanto não tem volume, e escalar peça por
peça conforme os leads forem aparecendo.

## Stack (barata de propósito)
- **Node.js + TypeScript**, um único processo (servidor HTTP + cron no mesmo processo).
- **SQLite** via Prisma — banco em arquivo, zero custo de hospedagem de DB. Trocar para Postgres depois é só mudar `provider` no `prisma/schema.prisma`.
- **OpenAI** (`gpt-4o-mini` por padrão) como modelo de IA — barato, dá conta de qualificar lead e agendar. Troque via `OPENAI_MODEL` no `.env` se quiser mais qualidade ou não tiver acesso a esse modelo na sua conta.
- **Baileys** (`@whiskeysockets/baileys`) para conectar o WhatsApp direto via QR Code — biblioteca open-source que fala o mesmo protocolo do WhatsApp Web, rodando dentro do próprio processo da Alice. Sem gateway pago (UazAPI/Z-API) no meio: zero custo por mensagem, zero dependência de um serviço terceiro pra ficar no ar.

Custo variável: você só paga por token de IA conforme o uso real — não há infraestrutura fixa além de onde hospedar o processo (pode rodar num VPS de ~R$20-25/mês, ou até local pra validar antes de colocar em produção).

## Setup

1. Instalar dependências:
   ```
   npm install
   ```
2. Copiar `.env.example` para `.env` e preencher:
   - `OPENAI_API_KEY` (platform.openai.com)
   - `WHATSAPP_AUTH_DIR`: pasta onde fica a sessão (credenciais do "aparelho conectado") de cada clínica — em produção **precisa** estar num volume persistente, senão perde a conexão a cada deploy
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
6. Acessar o painel administrativo em `http://localhost:3010/admin` (usuário/senha do `.env`), ir em **Personalizar Alice → Canais** e clicar em "Gerar QR Code".
7. Escanear o QR Code pelo WhatsApp do celular (Aparelhos conectados → Conectar um aparelho). Não precisa de túnel/webhook — a conexão é direta, o próprio processo da Alice fala com os servidores do WhatsApp.

## Múltiplas clínicas
O sistema atende quantas clínicas você quiser, cada uma com seu próprio número de WhatsApp:
- Cada clínica tem sua própria sessão do WhatsApp (pasta separada dentro de `WHATSAPP_AUTH_DIR`), conectada individualmente pela aba **Canais** depois de selecionar a clínica no seletor do topo do painel.
- Mensagens recebidas são roteadas em memória (cada clínica tem seu próprio socket Baileys) — não depende de token de gateway nem de número de telefone mascarado.
- Pra cadastrar uma segunda clínica: aba **Clínicas** no painel (nome e telefone — o telefone é atualizado sozinho assim que o QR é escaneado). Depois disso, o seletor de clínica no topo do painel troca todo o contexto (contatos, CRM, chat, agenda, recontato, mensagens, regras) pra clínica escolhida.
- Cada clínica tem seus próprios procedimentos, funil, regras e mensagens — totalmente isolados. Depois de cadastrar uma clínica nova, adicione os procedimentos dela na aba **Procedimentos** antes de conectar o WhatsApp — sem isso, a Alice não tem o que oferecer.

## Painel administrativo (`/admin`)
Layout em sidebar lateral (Início / Clientes / Operação / Conta), paleta laranja/âmbar, tema claro/escuro (botão no rodapé da sidebar, lembrado por navegador), e um **tour guiado** (botão "Guia" na sidebar) que destaca cada área do painel com um passo a passo — útil pra quem nunca usou.

Seções principais na sidebar:
- **Início**: indicadores do período (atendidos pela Alice, agendamentos, concluídos), gráfico de atendimentos por dia e um mini calendário do mês com os dias que têm agendamento destacados.
- **Contatos**: lista de pacientes/leads capturados pela Alice, com busca e opção de adicionar contato manualmente (ex: alguém que ligou ou apareceu na clínica).
- **CRM**: funil kanban, com 10 etapas padrão (Novo lead → Qualificando → ... → Fechou procedimento/Pós-procedimento/Recuperação/Perdido) criadas automaticamente na primeira vez que uma clínica é usada. Quando a Alice agenda uma avaliação, o lead avança automaticamente para a etapa marcada com o tipo "Avaliação agendada" (funciona mesmo se você renomeou essa etapa); o resto do funil se move arrastando o card entre colunas (drag-and-drop nativo) ou pelo dropdown de cada card. Busca por nome/telefone no topo; botão "Configurar funil" leva pra aba de configuração.
- **Chat**: conversas em andamento, com abas de filtro (Todos/Alice/Humano) e cabeçalho mostrando quem está atendendo. Dá pra "assumir" uma conversa manualmente (a Alice para de responder ali) e devolver o controle depois.
- **Agenda**: grid de calendário de verdade (horários de 7h-20h em colunas por dia) nas visões Hoje/Semana; Mês cai pra lista por tabela (grid de mês inteiro ainda não existe). Opção de agendar manualmente (nome, telefone, procedimento, data/hora) sem precisar passar pela conversa com a Alice.
- **Personalizar Alice**: página única com abas horizontais que concentram toda a configuração (igual ao painel que inspirou o projeto):
  - **Dados da clínica**: nome e horário de funcionamento (usado pelas mensagens automáticas e recontato) — antes só dava pra ver, agora dá pra editar.
  - **Procedimentos**: cadastro do que a Alice pode oferecer/agendar.
  - **Mensagens Programadas**: campanha avulsa (título + mensagem + data/hora + destino: todos ou um estágio do funil). Roda a cada 5 minutos, envia em lotes de 20 e só dentro do horário comercial.
  - **Recontato**: cascata de 5 mensagens automáticas (`FollowUpRule`) disparadas quando o paciente fica X dias sem responder. Reinicia se ele voltar a responder, pausa sozinho se já tem agendamento confirmado. No primeiro disparo, o lead vai pra etapa "Recuperação" no CRM.
  - **Funil**: adicionar, renomear, recolorir, reordenar ou remover etapas do CRM — remover realoca os pacientes daquela etapa pra primeira restante.
  - **Canais**: conexão do WhatsApp da clínica — mostra status (conectado/conectando/desconectado), gera o QR Code e permite desconectar.
  - **Clínicas**: cadastra clínicas novas (nome, WhatsApp). O seletor no topo da sidebar troca qual clínica as outras abas mostram.
  - **Produtos, Profissionais, Lembrete de Consulta, Pós-procedimento, Renovação, Aniversário, Histórico, API Externa**: abas presentes na navegação (pra bater com a estrutura do painel de referência) mas ainda **não implementadas** — mostram um aviso "em breve" em vez de fingir uma funcionalidade que não existe.

Protegido por HTTP Basic Auth (`ADMIN_USER`/`ADMIN_PASSWORD`) — suficiente pra uso interno de uma clínica só; se mais de uma pessoa da equipe for acessar com senhas próprias, vale evoluir para login por usuário.

Mensagens de voz também funcionam: a Alice manda o áudio direto pro Whisper da OpenAI (mesma `OPENAI_API_KEY`) pra transcrever — só paga quando alguém realmente manda áudio, custo zero em silêncio. Imagem/vídeo/documento ainda são ignorados (não tem transcrição pra eles).

## Conexão com o WhatsApp (Baileys) e risco de banimento
A conexão roda direto no processo da Alice via `@whiskeysockets/baileys`, sem gateway pago no meio. Medidas tomadas pra manter o número estável e reduzir risco de ban:
- **Fingerprint de dispositivo real** (`Browsers.macOS("Desktop")`) em vez do identificador padrão da biblioteca.
- **Simulação de digitação** antes de cada resposta (tempo proporcional ao tamanho da mensagem) — evita respostas instantâneas, que são o padrão mais fácil de detectar como bot.
- **Não fica "online" o tempo todo** (`markOnlineOnConnect: false`) e não sincroniza o histórico antigo de conversas (`syncFullHistory: false`) — menos tráfego, menos coisa fora do padrão de uso humano.
- **Envio em massa (mensagens programadas) em lotes de 20**, só dentro do horário comercial da clínica — nunca dispara centenas de mensagens de uma vez.
- **Reconexão automática com backoff** quando a conexão cai por instabilidade; se o WhatsApp encerrar a sessão de propósito (logout), a sessão salva é apagada e pede um novo QR Code — não fica tentando reconectar uma sessão inválida.

Mesmo assim, qualquer automação de WhatsApp não-oficial carrega algum risco. Recomendado: usar um número que já tenha histórico de uso normal (não um chip novo), evitar mandar mensagem pra quem nunca conversou com a clínica, e não reduzir os intervalos/lotes acima sem necessidade.

## Rodando em produção

### Opção A — VPS com EasyPanel (recomendado se você já tem uma)
1. **Código no GitHub**: o projeto já é um repo git local. Crie um repositório vazio no GitHub e rode:
   ```
   git remote add origin https://github.com/SEU-USUARIO/SEU-REPO.git
   git push -u origin master
   ```
2. **Criar o App no EasyPanel**: Novo serviço → App → Source = GitHub (aponte pro repo/branch) → Builder = Railpack (detecta Node.js sozinho, não precisa de Dockerfile).
3. **Banco persistente (importante!)**: na aba **Storage/Mounts**, adicione um **Volume** montado em `/app/data`. Sem isso, o SQLite é apagado a cada deploy. Aponte `DATABASE_URL` pra dentro dele: `file:/app/data/prod.db`.
4. **Sessão do WhatsApp persistente (importante!)**: adicione um **segundo Volume** montado em `/app/whatsapp-auth`, e aponte `WHATSAPP_AUTH_DIR=/app/whatsapp-auth`. Sem isso, cada deploy derruba a conexão de todas as clínicas e exige escanear o QR Code de novo.
5. **Variáveis de ambiente**: aba Environment, cole o conteúdo do `.env` (com os valores reais, não os de exemplo) — incluindo `DATABASE_URL` e `WHATSAPP_AUTH_DIR` dos passos anteriores.
6. **Domínio**: aba Domains, adicione o domínio/subdomínio (DNS já apontando pro IP da VPS antes disso), ative HTTPS — o EasyPanel emite o certificado Let's Encrypt sozinho.
7. **Réplicas**: deixe em **1** na aba Advanced — SQLite não aguenta mais de um processo escrevendo ao mesmo tempo, e cada clínica só pode ter uma sessão do WhatsApp ativa por vez.
8. Deploy. O `npm start` já roda `prisma migrate deploy` antes de subir o servidor, então o banco no volume é migrado automaticamente a cada deploy.
9. Acesse `/admin` → **Personalizar Alice → Canais** e escaneie o QR Code de cada clínica.

Dentro do EasyPanel **não precisa do pm2** — o próprio Docker/EasyPanel reinicia o container se o processo cair.

### Opção B — VPS "crua" (sem painel), com pm2
Pra um servidor Ubuntu simples sem EasyPanel/Docker, o projeto já vem com `pm2` como dependência de desenvolvimento e um `ecosystem.config.cjs` configurado:
```
npm run pm2:start    # builda e sobe com reinicio automatico se cair
npm run pm2:status   # ve se esta rodando, quantos restarts, uso de memoria
npm run pm2:logs     # acompanha os logs
npm run pm2:restart  # rebuilda e reinicia (depois de mudar codigo/env)
npm run pm2:stop     # para o processo
```
Testado matando o processo Node manualmente: o pm2 detectou a queda e subiu de novo sozinho em poucos segundos. Isso resolve o "processo caiu e ninguém percebeu" — mas não substitui monitoramento de verdade (ex: um alerta se o `/health` parar de responder por muito tempo, o que ainda não existe aqui).

## O que falta pra virar produto de verdade
- **Monitoramento/alerta**: o pm2 (ou o próprio EasyPanel) reinicia sozinho, mas ninguém é avisado se isso acontecer repetidamente ou se a sessão do WhatsApp cair e não reconectar.
- **Backup do volume de sessão**: se o volume com `WHATSAPP_AUTH_DIR` for perdido, é preciso escanear o QR Code de novo pra cada clínica — vale incluir esse volume na rotina de backup junto com o do banco.

## Estrutura
```
src/
  server.ts             # Express: monta painel e API, restaura conexoes do WhatsApp ao subir
  ai/alice.ts           # Prompt da Alice + function calling (OpenAI) pra consultar agenda e agendar
  scheduling/slots.ts   # Calcula horários livres a partir dos agendamentos existentes
  whatsapp/manager.ts   # Conexao direta com o WhatsApp via Baileys (QR, envio/recebimento, transcricao de audio, reconexao, anti-ban)
  reminders/cron.ts     # Lembrete automático 24h antes do agendamento
  crm/stages.ts         # Etapas do funil kanban por clinica (auto-cria as 10 padrao na 1a vez)
  crm/followup.ts       # Cascata de recontato por silêncio (roda a cada hora)
  crm/broadcast.ts      # Mensagens programadas em massa (roda a cada 5 min, em lotes)
  ai/rules.ts           # Transforma texto livre em regra estruturada (Personalizar Alice)
  api/routes.ts         # REST usado pelo painel (/api/clinics, /api/whatsapp/*, /dashboard/stats, /procedures, /contacts, /conversations, /appointments, /crm/board, /funnel-stages, /followup-rules, /broadcasts, /rules)
  api/auth.ts           # HTTP Basic Auth do painel/API
  db/client.ts          # Prisma client
public/                 # Painel administrativo (HTML/CSS/JS puro, sem build)
prisma/schema.prisma    # Modelo de dados (Clinic, Procedure, Patient, Conversation, Appointment, FunnelStage)
whatsapp-auth/          # Sessao do WhatsApp de cada clinica (gerado em runtime — NUNCA commitar, equivale a login/senha da conta)
```

## Projeto em ESM
O `package.json` tem `"type": "module"` — necessário porque o Baileys (a partir da v7) é publicado como ESM puro e uma de suas dependências não tem build CommonJS. Por isso todo import relativo dentro de `src/` usa extensão `.js` explícita (ex: `from "../db/client.js"`, mesmo o arquivo sendo `client.ts`) — é assim que o Node resolve módulos ESM. Ao criar um arquivo novo, siga o mesmo padrão.
