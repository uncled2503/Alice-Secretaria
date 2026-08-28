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
   - `SESSION_SECRET`: chave aleatória forte usada para assinar os cookies de login; o servidor não sobe sem ela
   - `ADMIN_BOOTSTRAP_TOKEN`: outro valor aleatório, usado uma única vez para autorizar a criação do primeiro administrador
   - `BACKUP_DIR`: destino dos backups do SQLite e das sessões do WhatsApp
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
7. Acessar `http://localhost:3010/admin`, entrar com a conta criada, ir em **Personalizar Alice → Canais** e clicar em "Gerar QR Code".
8. Escanear o QR Code pelo WhatsApp do celular (Aparelhos conectados → Conectar um aparelho). Não precisa de túnel/webhook — a conexão é direta, o próprio processo da Alice fala com os servidores do WhatsApp.

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
  - **Produtos e Profissionais**: catálogo de produtos com imagem e dados comerciais; diretório de profissionais vinculados aos procedimentos e agendamentos.
  - **Mensagens Programadas**: campanhas para todos, uma etapa do funil ou contatos escolhidos, com variáveis de personalização. Roda a cada 5 minutos, envia em lotes de 20 e só dentro do horário comercial.
  - **Recontato**: sequência configurável disparada quando o paciente fica sem responder. Reinicia se ele voltar, pausa com agendamento confirmado e pode mover o lead para Recuperação.
  - **Lembrete de Consulta e Pós-procedimento**: regras configuráveis por clínica, executadas automaticamente a cada 15 minutos.
  - **Renovação e Aniversário**: mensagens automáticas por ciclo do procedimento ou data de nascimento.
  - **Histórico**: registro pesquisável das atividades importantes da clínica e de quem realizou cada ação.
  - **Funil**: adicionar, renomear, recolorir, reordenar ou remover etapas do CRM — remover realoca os pacientes daquela etapa pra primeira restante.
  - **Canais**: conexão do WhatsApp da clínica — mostra status (conectado/conectando/desconectado), gera o QR Code e permite desconectar.
  - **Clínicas**: cadastra clínicas novas (nome, WhatsApp). O seletor no topo da sidebar troca qual clínica as outras abas mostram.
  - **Personalizar Alice**: regras recomendadas, mensagens prontas, FAQ, identidade, ajustes de comportamento e roteiros de conversa que entram no contexto da IA.
  - **API Externa**: reservada para uma integração futura; é a única dessas abas que ainda não possui implementação funcional.

O painel usa contas individuais. `admin` pode operar todas as clínicas; `client` fica isolado na própria clínica. As senhas usam `scrypt` com salt e a sessão fica em cookie assinado, `HttpOnly`, `SameSite=Lax` e `Secure` em produção.

Mensagens de voz também funcionam: a Alice manda o áudio direto pro Whisper da OpenAI (mesma `OPENAI_API_KEY`) pra transcrever — só paga quando alguém realmente manda áudio, custo zero em silêncio. Imagem/vídeo/documento ainda são ignorados (não tem transcrição pra eles).

## Conexão com o WhatsApp (Baileys) e risco de banimento
A conexão roda direto no processo da Alice via `@whiskeysockets/baileys`, sem gateway pago no meio. Medidas tomadas pra manter o número estável e reduzir risco de ban:
- **Fingerprint de dispositivo real** (`Browsers.macOS("Desktop")`) em vez do identificador padrão da biblioteca.
- **Simulação de digitação** antes de cada resposta (tempo proporcional ao tamanho da mensagem) — evita respostas instantâneas, que são o padrão mais fácil de detectar como bot.
- **Não fica "online" o tempo todo** (`markOnlineOnConnect: false`) e não sincroniza o histórico antigo de conversas (`syncFullHistory: false`) — menos tráfego, menos coisa fora do padrão de uso humano.
- **Envio em massa (mensagens programadas) em lotes de 20**, só dentro do horário comercial da clínica — nunca dispara centenas de mensagens de uma vez.
- **Reconexão automática com backoff** quando a conexão cai por instabilidade; se o WhatsApp encerrar a sessão de propósito (logout), a sessão salva é apagada e pede um novo QR Code — não fica tentando reconectar uma sessão inválida.

Mesmo assim, qualquer automação de WhatsApp não-oficial carrega algum risco. Recomendado: usar um número que já tenha histórico de uso normal (não um chip novo), evitar mandar mensagem pra quem nunca conversou com a clínica, e não reduzir os intervalos/lotes acima sem necessidade.

### QR Code não aparece no EasyPanel

Algumas faixas de IP de datacenter são recusadas pelo WhatsApp antes mesmo da geração do QR (`statusCode=428`). A mesma versão do código pode funcionar normalmente em uma rede residencial e falhar na VPS. Nesse caso:

1. Configure `WHATSAPP_PROXY_URL` no EasyPanel com uma proxy residencial ou móvel estável (`http://`, `https://` ou `socks5://`).
2. Não use proxy rotativa: uma mesma clínica precisa manter o mesmo IP. Quando houver várias proxies, o sistema fixa cada clínica em uma delas.
3. Reinicie o serviço e clique em **Gerar QR Code** novamente.
4. Confira os logs: eles informam se a tentativa saiu por IP direto ou proxy e mostram claramente os erros `428`, `408`, `401` e `515`.

O painel encerra tentativas sem QR após 30 segundos, em vez de permanecer para sempre em “Conectando”. Um erro 428 não é repetido automaticamente para evitar aumentar o bloqueio temporário.

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
5. **Backup persistente**: adicione um terceiro volume em `/app/backups` e configure `BACKUP_DIR=/app/backups`. O comando `npm run backup` cria uma cópia consistente do SQLite junto das sessões do WhatsApp.
6. **Variáveis de ambiente**: aba Environment, cole o conteúdo do `.env` (com os valores reais, não os de exemplo) — incluindo `DATABASE_URL`, `WHATSAPP_AUTH_DIR`, `BACKUP_DIR`, `SESSION_SECRET`, `ADMIN_BOOTSTRAP_TOKEN` e `NODE_ENV=production`.
7. **Domínio**: aba Domains, adicione o domínio/subdomínio (DNS já apontando pro IP da VPS antes disso), ative HTTPS — o EasyPanel emite o certificado Let's Encrypt sozinho.
8. **Réplicas**: deixe em **1** na aba Advanced — SQLite não aguenta mais de um processo escrevendo ao mesmo tempo, e cada clínica só pode ter uma sessão do WhatsApp ativa por vez.
9. Deploy. O `npm start` já roda `prisma migrate deploy` antes de subir o servidor, então o banco no volume é migrado automaticamente a cada deploy.
10. Crie a primeira conta admin pela rota de bootstrap descrita no Setup e depois escaneie o QR Code de cada clínica.

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
- `npm run backup`: cria em `BACKUP_DIR` uma cópia consistente do SQLite e uma cópia de `WHATSAPP_AUTH_DIR`, com manifesto e data.
- Agende `npm run backup` diariamente no host/EasyPanel e copie os arquivos para outro servidor ou armazenamento de objetos. O projeto não apaga backups antigos automaticamente; configure retenção fora da aplicação.
- Configure um monitor externo para consultar `https://SEU-DOMINIO/health` e avisar quando houver respostas diferentes de `200`. O health check do Docker detecta falhas, mas não envia alertas para pessoas.
- Faça periodicamente um teste de restauração. Um backup que nunca foi restaurado ainda não é uma garantia operacional.
- `.env`, `whatsapp-auth/`, `.relay-sessions/` e `backups/` são sensíveis e estão excluídos do Git e da imagem Docker.

## Estrutura
```
src/
  server.ts             # Express: monta painel e API, restaura conexoes do WhatsApp ao subir
  ai/alice.ts           # Prompt da Alice + function calling (OpenAI) pra consultar agenda e agendar
  scheduling/slots.ts   # Calcula horários livres a partir dos agendamentos existentes
  whatsapp/manager.ts   # Conexao direta com o WhatsApp via Baileys (QR, envio/recebimento, transcricao de audio, reconexao, anti-ban)
  reminders/cron.ts     # Regras configuráveis de lembrete de agendamento
  crm/stages.ts         # Etapas do funil kanban por clinica (auto-cria as 10 padrao na 1a vez)
  crm/followup.ts       # Sequência de recontato por silêncio (roda a cada 15 min)
  crm/broadcast.ts      # Mensagens programadas em massa (roda a cada 5 min, em lotes)
  ai/rules.ts           # Transforma texto livre em regra estruturada (Personalizar Alice)
  api/routes.ts         # REST usado pelo painel (/api/clinics, /api/whatsapp/*, /dashboard/stats, /procedures, /contacts, /conversations, /appointments, /crm/board, /funnel-stages, /followup-rules, /broadcasts, /rules)
  api/staffSession.ts   # Cookie assinado e identidade da conta logada
  api/passwords.ts      # Hash e validação de senhas com scrypt
  db/client.ts          # Prisma client
  maintenance/backup.ts # Backup consistente do SQLite e das sessões
public/                 # Painel administrativo (HTML/CSS/JS puro, sem build)
prisma/schema.prisma    # Modelo de dados (Clinic, Procedure, Patient, Conversation, Appointment, FunnelStage)
whatsapp-auth/          # Sessao do WhatsApp de cada clinica (gerado em runtime — NUNCA commitar, equivale a login/senha da conta)
tests/                  # Testes automatizados executados sobre o build de produção
```

## Projeto em ESM
O `package.json` tem `"type": "module"` — necessário porque o Baileys (a partir da v7) é publicado como ESM puro e uma de suas dependências não tem build CommonJS. Por isso todo import relativo dentro de `src/` usa extensão `.js` explícita (ex: `from "../db/client.js"`, mesmo o arquivo sendo `client.ts`) — é assim que o Node resolve módulos ESM. Ao criar um arquivo novo, siga o mesmo padrão.
