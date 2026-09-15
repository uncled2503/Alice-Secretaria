# Integração com o Google Agenda

Liga a agenda da Alice ao Google Agenda da clínica, **nos dois sentidos**:

- **Saída** (`syncOut`): toda consulta que a Alice marca vira um evento no
  Google Agenda, com nome do paciente, telefone e procedimento.
- **Entrada** (`blockBusy`): o que já está no Google Agenda (compromisso
  pessoal, cirurgia, viagem) passa a ocupar a agenda da Alice — ela não
  oferece nem aceita um horário que, na vida real, já está tomado.

Cancelou no painel ou pelo WhatsApp? O evento sai do Google. Remarcou? O evento
anda junto.

Enquanto as credenciais não forem configuradas, a integração fica simplesmente
desligada: a tela do painel explica o que falta e o resto do sistema funciona
exatamente como antes.

---

## 1. Criar as credenciais no Google (uma vez só, para todas as clínicas)

No [Google Cloud Console](https://console.cloud.google.com):

1. Crie um projeto (ou use um existente).
2. **APIs e serviços → Biblioteca** → ative a **Google Calendar API**.
3. **APIs e serviços → Tela de permissão OAuth**:
   - Tipo **Externo**.
   - Preencha nome do app, e-mail de suporte e e-mail do desenvolvedor.
   - Em **Escopos**, adicione:
     - `.../auth/calendar.events`
     - `.../auth/calendar.readonly`
     - `.../auth/userinfo.email`
   - Enquanto o app estiver em modo **Teste**, adicione o e-mail de cada
     clínica em **Usuários de teste** (senão o Google recusa a conexão).
     Para uso aberto, é preciso publicar o app — o Google pode pedir
     verificação, que costuma levar alguns dias.
4. **APIs e serviços → Credenciais → Criar credenciais → ID do cliente OAuth**:
   - Tipo: **Aplicativo da Web**.
   - Em **URIs de redirecionamento autorizados**, coloque exatamente:
     `https://SEU-DOMINIO/api/google/callback`
   - Guarde o **Client ID** e o **Client Secret**.

## 2. Configurar o servidor

No `.env` da VPS:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...

# Já deve existir; é daqui que sai a URI de retorno.
PUBLIC_BASE_URL=https://SEU-DOMINIO

# Opcional: só se a URI de retorno for diferente de PUBLIC_BASE_URL + /api/google/callback
# GOOGLE_REDIRECT_URI=https://SEU-DOMINIO/api/google/callback

# Já deve existir (a mesma da Meta). Os tokens do Google são guardados
# criptografados com ela — sem essa chave a integração não liga.
META_ENCRYPTION_KEY=...
```

Reinicie a aplicação depois de alterar o `.env`.

> **Atenção**: se a `META_ENCRYPTION_KEY` mudar, os tokens salvos deixam de ser
> legíveis e cada clínica precisa conectar o Google Agenda de novo. A tela
> avisa quando isso acontece.

## 3. Conectar cada clínica

No painel: **Configurações → Google Agenda → Conectar Google Agenda**. O cliente
escolhe a conta Google da clínica, autoriza, e volta para o painel já conectado.

Na mesma tela dá para ligar/desligar cada sentido da sincronização
separadamente e desconectar a qualquer momento.

---

## Detalhes de funcionamento

- **Agenda usada**: a principal (`primary`) da conta conectada.
- **Token**: guardamos o *refresh token* criptografado (AES-256-GCM) e
  renovamos o acesso sozinhos. Nada disso volta para o navegador.
- **Falhas nunca derrubam um agendamento**: se o Google estiver fora do ar, a
  consulta é marcada normalmente no painel e o erro aparece na tela da
  integração. Um horário só deixa de ser oferecido por causa do Google quando
  a consulta ao Google funciona — na dúvida, o sistema não bloqueia nada.
- **Cache**: a lista de horários ocupados no Google é consultada no máximo uma
  vez por minuto por clínica, para não estourar a cota da API enquanto a Alice
  monta as opções de horário.
- **Segurança**: o retorno do Google carrega um `state` assinado (HMAC) que
  amarra a autorização à clínica que iniciou o processo — não dá para plugar a
  agenda de uma conta na clínica de outra pessoa.
