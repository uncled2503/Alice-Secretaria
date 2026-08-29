# Alice — Secretária Virtual Humanizada para clínicas de estética

MVP enxuto pra manter custo mínimo enquanto não tem volume, e escalar peça por
peça conforme os leads forem aparecendo.

## Stack (barata de propósito)
- **Node.js + TypeScript**, um único processo (servidor HTTP + cron no mesmo processo).
- **SQLite** via Prisma — banco em arquivo, zero custo de hospedagem de DB. Trocar para Postgres depois é só mudar `provider` no `prisma/schema.prisma`.
- **OpenAI** (`gpt-4o-mini` por padrão) como modelo de IA — barato, dá conta de qualificar lead e agendar. Troque via `OPENAI_MODEL` no `.env` se quiser mais qualidade ou não tiver acesso a esse modelo na sua conta.
- **UAZAPI** como gateway do WhatsApp — uma instância por clínica, com QR Code, status, envio e webhook gerenciados pelo provedor.

Custo variável: uso da OpenAI + plano/instâncias da UAZAPI, além da hospedagem da Alice.

## Setup

1. Instalar dependências:
   ```
   npm install
   ```
2. Copiar `.env.example` para `.env` e preencher:
   - `OPENAI_API_KEY` (platform.openai.com)
   - `PUBLIC_BASE_URL`: URL HTTPS pública da Alice, usada pela UAZAPI para entregar webhooks
   - `UAZAPI_WEBHOOK_SECRET`: segredo aleatório com pelo menos 32 caracteres, diferente das outras chaves
   - `SESSION_SECRET`: chave aleatória forte usada para assinar os cookies de login; o servidor não sobe sem ela
   - `ADMIN_BOOTSTRAP_TOKEN`: outro valor aleatório, usado uma única vez para autorizar a criação do primeiro administrador
   - `BACKUP_DIR`: destino dos backups do SQLite
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
6. Com o servidor rodando e antes de existir qualquer admin, criar a primeira conta (essa rota se desativa sozinha depois do primeiro cadastro):
   ```
   curl.exe -X POST http://localhost:3010/api/staff/bootstrap-admin -H "Content-Type: application/json" -H "X-Bootstrap-Token: VALOR-DE-ADMIN_BOOTSTRAP_TOKEN" -d "{\"name\":\"Administrador\",\"username\":\"admin\",\"password\":\"USE-UMA-SENHA-FORTE\"}"
   ```
   Depois da criação, remova `ADMIN_BOOTSTRAP_TOKEN` do ambiente; a rota também se desativa automaticamente porque já existe um admin.
7. Acessar `http://localhost:3010/admin`, entrar como admin e ir em **Personalizar Alice → Clínicas**.
8. Na clínica desejada, clicar em **Configurar**, informar a URL do servidor UAZAPI e o **token da instância**. Depois, selecionar a clínica e abrir **Canais → Gerar QR Code**.
9. Escanear o QR Code pelo WhatsApp do celular (Aparelhos conectados → Conectar um aparelho). A Alice configura o webhook da instância automaticamente.

## Múltiplas clínicas
O sistema atende quantas clínicas você quiser, cada uma com seu próprio número de WhatsApp:
- Cada clínica precisa de uma instância UAZAPI própria e de um token de instância diferente.
- A URL/token são salvos por clínica no SQLite. O token nunca é retornado pela API do painel nem enviado ao navegador depois de salvo.
- A URL de webhook inclui uma assinatura HMAC específica da clínica; eventos recebidos entram numa fila durável e idempotente antes de serem processados.
- Pra cadastrar uma segunda clínica: aba **Clínicas** no painel (nome e telefone — o telefone é atualizado sozinho assim que o QR é escaneado). Na mesma lista, **Configurar/Trocar token** permite administrar a instância UAZAPI daquela clínica sem trocar o contexto do painel. Depois disso, o seletor de clínica no topo troca todo o contexto (contatos, CRM, chat, agenda, recontato, mensagens, regras) pra clínica escolhida.
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
  - **Produtos e Profissionais**: catálogo de produtos com imagem e dados comerciais; diretório de profissionais vinculados aos procedimentos e agendamentos.
  - **Mensagens Programadas**: campanhas para todos, uma etapa do funil ou contatos escolhidos, com variáveis de personalização. Roda a cada 5 minutos, envia em lotes de 20 e só dentro do horário comercial.
  - **Recontato**: sequência configurável disparada quando o paciente fica sem responder. Reinicia se ele voltar, pausa com agendamento confirmado e pode mover o lead para Recuperação.
  - **Lembrete de Consulta e Pós-procedimento**: regras configuráveis por clínica, executadas automaticamente a cada 15 minutos.
  - **Renovação e Aniversário**: mensagens automáticas por ciclo do procedimento ou data de nascimento.
  - **Histórico**: registro pesquisável das atividades importantes da clínica e de quem realizou cada ação.
  - **Funil**: adicionar, renomear, recolorir, reordenar ou remover etapas do CRM — remover realoca os pacientes daquela etapa pra primeira restante.
  - **Canais**: conexão do WhatsApp da clínica — mostra status (conectado/conectando/desconectado), gera o QR Code e permite desconectar.
  - **Clínicas**: cadastra clínicas novas (nome, WhatsApp) e permite configurar ou trocar o token UAZAPI individual de cada uma. O seletor no topo da sidebar troca qual clínica as outras abas mostram.
  - **Personalizar Alice**: regras recomendadas, mensagens prontas, FAQ, identidade, ajustes de comportamento e roteiros de conversa que entram no contexto da IA.
  - **API Externa**: reservada para uma integração futura; é a única dessas abas que ainda não possui implementação funcional.

O painel usa contas individuais. `admin` pode operar todas as clínicas; `client` fica isolado na própria clínica. As senhas usam `scrypt` com salt e a sessão fica em cookie assinado, `HttpOnly`, `SameSite=Lax` e `Secure` em produção.

Mensagens de voz também funcionam: a Alice manda o áudio direto pro Whisper da OpenAI (mesma `OPENAI_API_KEY`) pra transcrever — só paga quando alguém realmente manda áudio, custo zero em silêncio. Imagem/vídeo/documento ainda são ignorados (não tem transcrição pra eles).

## Conexão com o WhatsApp pela UAZAPI

A integração segue a [documentação oficial uazapiGO](https://docs.uazapi.com/) v2.1.1:

- `GET /instance/status`: consulta conexão, telefone, perfil e QR atual.
- `POST /instance/connect`: inicia o pareamento por QR Code.
- `POST /instance/disconnect`: encerra a sessão e exige novo QR.
- `POST /send/text`: envia mensagens; o campo `delay` mostra “digitando…” durante o atraso humanizado.
- `POST /chat/details`: consulta a foto de perfil usada na lista de conversas.
- `POST /chat/find` e `POST /message/find`: importam os chats/mensagens retidos pela UAZAPI (até 7 dias).
- `POST /message/download`: baixa áudio em base64; a transcrição continua sendo feita diretamente pela Alice, sem entregar a chave OpenAI à UAZAPI.
- `POST /webhook`: a Alice configura automaticamente eventos `messages` e `connection`, excluindo mensagens da própria API, mensagens enviadas pelo número e grupos.

### Criar e cadastrar uma instância

1. No painel da UAZAPI, crie uma instância para a clínica.
2. Copie a URL do servidor, por exemplo `https://seusubdominio.uazapi.com`.
3. Copie o **token da instância**. Não use `admintoken`: ele serve para administração do servidor e é mais sensível.
4. Na Alice, abra **Personalizar Alice → Clínicas** e clique em **Configurar** na clínica correspondente.
5. Cole URL e token e clique em **Validar e salvar**. A Alice consulta `/instance/status` antes de aceitar as credenciais. Para trocar apenas a URL mantendo o token atual, deixe o campo de token vazio.
6. Selecione a clínica no topo, abra **Canais**, clique em **Gerar QR Code** e escaneie pelo celular.
7. O painel passa a consultar o status remoto. Não existe mais pasta de sessão nem proxy no servidor da Alice; a sessão fica na UAZAPI.

### Webhook e segurança

Defina no ambiente da Alice:

```env
PUBLIC_BASE_URL=https://alice.seudominio.com.br
UAZAPI_WEBHOOK_SECRET=gere-um-segredo-aleatorio-de-pelo-menos-32-caracteres
```

Ao salvar as credenciais, a Alice registra na UAZAPI uma URL no formato:

```text
https://alice.seudominio.com.br/api/uazapi/webhook/{clinicId}/{assinatura-hmac}
```

A rota é pública porque precisa ser chamada pela UAZAPI, mas exige assinatura HMAC. Se o payload trouxer o token da instância, ele também é comparado de forma segura. O evento é gravado no SQLite antes da resposta `200`; duplicatas são ignoradas e falhas têm até três tentativas internas.

### Diagnóstico

- **“UAZAPI não configurada”**: salve URL e token em **Clínicas → Configurar** ou na aba Canais da clínica selecionada.
- **UAZAPI recusou o token (401)**: a URL do servidor e o token precisam ser da **mesma** instância. Cada conta fica num subdomínio próprio (`https://seusubdominio.uazapi.com`); um token válido em um servidor responde `401 Invalid token.` em outro. Use o token da instância (não o de administrador) e sem espaços.
- **Credenciais salvas, mas webhook pendente**: confira `PUBLIC_BASE_URL` e `UAZAPI_WEBHOOK_SECRET`, faça novo deploy e salve novamente.
- **QR não aparece**: consulte a própria instância no painel UAZAPI; a Alice apenas exibe o `qrcode` retornado por `/instance/status`.
- **Mensagens chegam na UAZAPI, mas não na Alice**: veja `GET /webhook/errors` na UAZAPI e confirme que a URL pública responde HTTPS.
- **HTTP 429/503**: limite/capacidade da UAZAPI; aguarde e consulte seu plano ou suporte.

A UAZAPI continua sendo uma integração não oficial do WhatsApp. Use preferencialmente WhatsApp Business, números com histórico normal, consentimento dos destinatários e volumes moderados.

## Rodando em produção

### Opção A — VPS com EasyPanel (recomendado se você já tem uma)
1. **Código no GitHub**: o projeto já é um repo git local. Crie um repositório vazio no GitHub e rode:
   ```
   git remote add origin https://github.com/SEU-USUARIO/SEU-REPO.git
   git push -u origin master
   ```
2. **Criar o App no EasyPanel**: Novo serviço → App → Source = GitHub (aponte pro repo/branch) → Builder = Railpack (detecta Node.js sozinho, não precisa de Dockerfile).
3. **Banco persistente (importante!)**: na aba **Storage/Mounts**, adicione um **Volume** montado em `/app/data`. Sem isso, o SQLite é apagado a cada deploy. Aponte `DATABASE_URL` pra dentro dele: `file:/app/data/prod.db`.
4. **Backup persistente**: adicione outro volume em `/app/backups` e configure `BACKUP_DIR=/app/backups`.
5. **Variáveis de ambiente**: inclua `DATABASE_URL`, `BACKUP_DIR`, `PUBLIC_BASE_URL`, `UAZAPI_WEBHOOK_SECRET`, `SESSION_SECRET` e `NODE_ENV=production`. `ADMIN_BOOTSTRAP_TOKEN` só é necessário até criar o primeiro admin.
6. **Domínio**: adicione o domínio/subdomínio, ative HTTPS e use exatamente essa origem em `PUBLIC_BASE_URL`.
7. **Réplicas**: deixe em **1** — SQLite e o worker da fila de webhook pressupõem um único processo.
8. Deploy. O `npm start` roda `prisma migrate deploy` antes de iniciar a aplicação.
9. Entre como admin e, em **Clínicas**, cadastre a URL/token da instância de cada clínica.
10. Gere e leia o QR. A UAZAPI preserva a sessão; deploys da Alice não exigem novo pareamento.

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
Testado matando o processo Node manualmente: o pm2 detectou a queda e subiu de novo sozinho em poucos segundos. O `/health` agora verifica também o acesso ao banco e responde `503` quando o SQLite não está disponível. No Docker, esse endpoint é consultado automaticamente a cada 30 segundos.

## Operação, testes e backup

- `npm run check`: compila o TypeScript e executa os testes automatizados.
- `npm run backup`: cria em `BACKUP_DIR` uma cópia consistente do SQLite, com manifesto e data. O banco contém tokens UAZAPI; proteja e criptografe as cópias fora do servidor.
- Agende `npm run backup` diariamente no host/EasyPanel e copie os arquivos para outro servidor ou armazenamento de objetos. O projeto não apaga backups antigos automaticamente; configure retenção fora da aplicação.
- Configure um monitor externo para consultar `https://SEU-DOMINIO/health` e avisar quando houver respostas diferentes de `200`. O health check do Docker detecta falhas, mas não envia alertas para pessoas.
- Faça periodicamente um teste de restauração. Um backup que nunca foi restaurado ainda não é uma garantia operacional.
- `.env` e `backups/` são sensíveis e estão excluídos do Git e da imagem Docker.

## Estrutura
```
src/
  server.ts             # Express: monta painel/API e inicia a fila de webhooks
  ai/alice.ts           # Prompt da Alice + function calling (OpenAI) pra consultar agenda e agendar
  scheduling/slots.ts   # Calcula horários livres a partir dos agendamentos existentes
  uazapi/client.ts      # Cliente UAZAPI, status/QR, envio, webhook, fila, áudio e importação
  reminders/cron.ts     # Regras configuráveis de lembrete de agendamento
  crm/stages.ts         # Etapas do funil kanban por clinica (auto-cria as 10 padrao na 1a vez)
  crm/followup.ts       # Sequência de recontato por silêncio (roda a cada 15 min)
  crm/broadcast.ts      # Mensagens programadas em massa (roda a cada 5 min, em lotes)
  ai/rules.ts           # Transforma texto livre em regra estruturada (Personalizar Alice)
  api/routes.ts         # REST usado pelo painel (/api/clinics, /api/whatsapp/*, /dashboard/stats, /procedures, /contacts, /conversations, /appointments, /crm/board, /funnel-stages, /followup-rules, /broadcasts, /rules)
  api/staffSession.ts   # Cookie assinado e identidade da conta logada
  api/passwords.ts      # Hash e validação de senhas com scrypt
  db/client.ts          # Prisma client
  maintenance/backup.ts # Backup consistente do SQLite
public/                 # Painel administrativo (HTML/CSS/JS puro, sem build)
prisma/schema.prisma    # Modelo de dados (Clinic, Procedure, Patient, Conversation, Appointment, FunnelStage)
tests/                  # Testes automatizados executados sobre o build de produção
```

## Projeto em ESM
O `package.json` tem `"type": "module"`. Todo import relativo dentro de `src/` usa extensão `.js` (ex.: `from "../db/client.js"`, mesmo o arquivo-fonte sendo `.ts`) para seguir a resolução `NodeNext`.
