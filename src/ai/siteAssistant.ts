import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

// Base de conhecimento do assistente de ajuda do painel. Ele responde QUALQUER
// duvida de uso do painel/dashboard com passo a passo. So encaminha pra
// administracao da Alice em casos de conta/cobranca/bug persistente.
const KNOWLEDGE = `
=== O QUE E A ALICE ===
- Secretaria virtual humanizada que atende pelo WhatsApp da propria clinica, 24h por dia.
- Objetivo: nenhuma mensagem de paciente fica sem resposta; ela qualifica, agenda, confirma, lembra e faz follow-up.
- No atendimento ela nunca se apresenta como robo. A clinica escolhe se ela fala como "parte da equipe", "secretaria da clinica" ou "secretaria de um profissional".

=== ORGANIZACAO DO PAINEL ===
O painel fica em /admin. Menu na lateral esquerda:
- Inicio: resumo do dia (indicadores por periodo, grafico de atendimentos, mini calendario).
- Contatos: base de pacientes e leads.
- CRM: funil kanban dos pacientes.
- Chat: conversas em andamento.
- Agenda: calendario de agendamentos.
- Personalizar Alice: todas as configuracoes, em sub-abas.
No rodape da lateral: conta do atendente logado, botao "Guia" (tour do painel) e botao "Tema" (claro/escuro).
Seletor no topo da lateral: troca entre clinicas (quando a conta tem mais de uma).

Sub-abas de "Personalizar Alice": Dados da clinica, Briefing, Produtos, Procedimentos, Profissionais, Canais, Mensagens Programadas, Lembrete de Consulta, Pos-procedimento, Renovacao, Aniversario, Recontato, Funil, Bloqueios de agenda, Lista de espera, Historico, Personalizar Alice (regras), Clinicas, Equipe.

=== TIPOS DE CONTA ===
- Conta de administracao da Alice: opera todas as clinicas, cadastra clinicas, configura a conexao (URL do servidor e token da instancia), cria contas de equipe.
- Conta de clinica (cliente): fica limitada a propria clinica e NAO ve as credenciais tecnicas de conexao (URL/token). Ela ainda gera o QR Code e usa todo o resto do painel normalmente.
Se a pessoa nao encontra uma opcao de conexao/credencial, provavelmente e conta de clinica e essa parte especifica e feita pela administracao da Alice.

=== CONECTAR / ADICIONAR UM NUMERO DE WHATSAPP ===
Cada clinica no painel usa UM numero de WhatsApp. "Adicionar um numero novo" pode ser duas coisas:

A) Conectar (ou reconectar) o WhatsApp de uma clinica que ja existe:
1. No topo da lateral, selecione a clinica.
2. Abra Personalizar Alice > Canais.
3. Se aparecer o bloco "Credenciais de conexao" pedindo URL e token: cole a URL do servidor e o token da instancia (nao o token de administracao) e clique em "Salvar e validar". (Isso normalmente e a administracao que faz.)
4. Clique em "Gerar QR Code".
5. No celular, abra o WhatsApp do numero > Aparelhos conectados > Conectar um aparelho > aponte a camera para o QR na tela.
6. O pareamento vale cerca de 2 minutos. Se expirar, clique em "Gerar novo QR Code".
7. Depois de conectado, o numero da clinica e preenchido sozinho em Dados da clinica. So ajuste ali manualmente se precisar corrigir.

B) Adicionar uma clinica nova (novo numero = nova clinica):
1. Abra Personalizar Alice > Clinicas.
2. Preencha nome da clinica e telefone do WhatsApp (so numeros, ex: 5511999999999) e clique em "Cadastrar clinica".
3. Na linha da clinica nova, clique em "Configurar" e cole a URL do servidor e o token da instancia exclusiva dela (cada clinica tem instancia propria). Clique em "Validar e salvar".
4. Selecione a clinica nova no seletor do topo da lateral.
5. Va em Canais e gere o QR Code (passos 4 a 6 do item A).
Obs: cadastrar clinica e colar credenciais normalmente e feito pela administracao da Alice. Se a conta e de clinica e nao mostra "Clinicas", peca isso a administracao.

=== CONEXAO CAIU / QR NAO APARECE ===
1. Personalizar Alice > Canais: veja o selo de status.
2. Clique em "Gerar QR Code" de novo e escaneie.
3. Se estava conectado e caiu, pode ter deslogado no proprio celular (WhatsApp > Aparelhos conectados). Basta reconectar pelo QR.
4. Se o QR nao aparece de jeito nenhum ou a conexao nao para de cair depois de reconectar, ai sim e caso de a administracao da Alice verificar a instancia.

=== IMPORTAR CONTATOS/CONVERSAS DO WHATSAPP ===
Personalizar Alice > Canais > secao "Importar dados do WhatsApp" > botao "Importar do WhatsApp". Traz contatos e conversas dos ultimos 7 dias. As mensagens antigas entram como lidas e a Alice nao responde a elas (serve so pra ter o contexto).

=== BRIEFING (configuracao inicial) ===
A aba Personalizar Alice > Briefing e uma ferramenta interna da administracao da Alice, usada no onboarding pra configurar tudo de uma vez a partir de um questionario respondido pela clinica. Contas de clinica nao veem essa aba. Se a clinica quer ajustar algo depois, e nas abas normais (Procedimentos, Dados da clinica, Personalizar Alice, automacoes) ou pedindo pra administracao.

=== DADOS DA CLINICA ===
Personalizar Alice > Dados da clinica:
- Nome, WhatsApp, fuso horario, inicio e fim do expediente, dias de atendimento. As automacoes so disparam dentro desse horario, e a Alice nao oferece agendamento com a clinica fechada.
- "Como a Alice se apresenta": parte da equipe / secretaria da clinica / secretaria de um profissional (nesse caso informe o nome).
- "Notificacoes no WhatsApp": numero para receber avisos e quais eventos (novo agendamento, remarcacao, cancelamento, presenca confirmada, transferencia para humano). Em branco = desativado.
- "Endereco": preencha o endereco que a Alice envia ao paciente. "Adicionar outra unidade" para mais de um endereco.
Clique em "Salvar informacoes" ao final.

=== PROCEDIMENTOS ===
Personalizar Alice > Procedimentos > "Adicionar Servico". Campos importantes:
- Nome, duracao, valor (ou marque "Preco variavel (depende de avaliacao)").
- "Oferecer parcelamento no cartao" e em quantas vezes.
- Formas de pagamento aceitas e link de pagamento.
- Descricao do procedimento.
- "Objetivos e queixas atendidas" e "Beneficios que podem ser afirmados": ensinam a Alice a ligar frases como "meu rosto parece cansado" ao servico certo sem inventar.
- "Outros nomes e formas de pedir" (ex: botox, toxina).
A Alice SO oferece, explica e agenda procedimentos cadastrados aqui.

=== PRODUTOS ===
Personalizar Alice > Produtos > "Adicionar Produto": nome, valor, foto e descricao. A Alice usa para responder duvida de preco/indicacao de produto.

=== PROFISSIONAIS ===
Personalizar Alice > Profissionais > "Adicionar Profissional": nome, bio, Instagram, cor na agenda, foto e quais procedimentos ele realiza.
- "Agenda do profissional": inicio/fim do expediente e dias de atendimento proprios. Em branco = herda o da clinica.
- A checagem de conflito de horario e por profissional: com profissionais cadastrados e vinculados aos procedimentos, dois atendem em paralelo. A Alice pergunta a preferencia do paciente quando ha mais de um.

=== RELATORIOS ===
Aba Relatorios (menu Operacao): funil do periodo (leads > agendaram > compareceram), taxa de no-show, conversao, faturamento realizado e o que esta agendado pra frente, ranking por procedimento e por profissional, origem dos agendamentos, quantos pacientes a Alice recuperou pelo recontato, e o NPS. Escolha o periodo no topo (7 dias a 12 meses).

=== REATIVACAO DE BASE ===
Personalizar Alice > Mensagens Programadas > Nova mensagem > destino "Reativacao de base". Escolha os procedimentos e "sem voltar ha pelo menos X meses". Pega quem fez aquilo e nao tem consulta futura, manda a mensagem e a Alice continua a conversa quando o paciente responde. Otimo pra trazer paciente antigo de volta.

=== PESQUISA DE SATISFACAO / AVALIACAO NO GOOGLE ===
Personalizar Alice > Ajustes da Alice > "Pesquisa de satisfacao". Ligue, defina quantas horas depois do atendimento concluido a Alice pergunta a nota (0 a 10), a nota minima pra pedir avaliacao e o link de avaliacao no Google. Nota alta: a Alice agradece e manda o link. Nota baixa: vira aviso pra equipe. Os resultados aparecem em Relatorios.

=== AGENDA ===
Aba Agenda:
- Hoje / Semana / Mes muda a visao. "Hoje" e "Semana" mostram a grade por horario; "Mes" mostra a lista.
- "+ Adicionar atendimento": agende na mao (paciente, telefone, procedimento, data/hora).
- Clique num agendamento para editar procedimento, profissional, data/hora, status (Confirmado, Concluido, Cancelado) e marcar "Presenca confirmada pelo paciente".
- Status "Concluido" alimenta o indicador de atendimentos concluidos no Inicio e libera as automacoes de pos-procedimento e renovacao. "Cancelado" tira o horario da agenda.
- Quando o paciente confirma presenca pelo WhatsApp, aparece um "check" ao lado do horario.

=== BLOQUEIOS DE AGENDA ===
Personalizar Alice > Bloqueios de agenda: feriado, folga, almoco, congresso, manutencao. Escolha profissional (ou "Clinica toda"), inicio, fim e motivo. A Alice nao oferece nem aceita agendamento nos periodos bloqueados.

=== LISTA DE ESPERA ===
Personalizar Alice > Lista de espera. Quando um paciente pede um horario lotado e topa esperar, a Alice o coloca aqui. Se abrir vaga por cancelamento, ela avisa automaticamente o primeiro da fila compativel. Voce pode remover alguem da lista por aqui.

=== CHAT / ASSUMIR A CONVERSA ===
Aba Chat:
- Filtros Todos / Alice / Humano no topo da lista.
- Clique numa conversa para ver as mensagens.
- Botao de assumir o atendimento: enquanto voce esta no controle, a Alice para de responder aquele paciente e voce digita direto. Ao devolver, ela retoma.
- No cabecalho da conversa da pra abrir o cadastro do contato e preencher a data de nascimento (usada na automacao de aniversario).

=== CONTATOS ===
Aba Contatos: todo mundo que falou com o WhatsApp da clinica entra automaticamente. "+ Adicionar contato" para quem chegou por fora (ligou, balcao). Busca por nome ou telefone. O icone de lixeira remove o contato e o historico dele.

=== CRM / FUNIL ===
Aba CRM: cada card e um paciente, cada coluna e uma etapa.
- A Alice move os cards sozinha conforme a conversa: agendou -> "Avaliacao agendada"; concluiu o atendimento -> "Pos-procedimento"; sumiu apos toda a cascata de recontato -> "Perdido"; cancelou sem outro horario -> "Recuperacao". Ela tambem ajusta as etapas abertas ("Qualificando", "Interesse confirmado", etc.) durante o atendimento.
- Voce pode arrastar o card entre colunas ou usar o seletor dentro dele.
- Toda mudanca de etapa (automatica ou manual) fica registrada no Historico.
Personalizar Alice > Funil: criar, renomear, recolorir, reordenar e remover etapas. Cada etapa tem um "tipo" (aberta, avaliacao agendada, ganho, pos-procedimento, perdido) que diz o que ela significa para a Alice e as automacoes.

=== MENSAGENS PROGRAMADAS (campanhas) ===
Personalizar Alice > Mensagens Programadas > "Nova mensagem programada": titulo, texto (com variaveis como {primeiro_nome}), publico (todos os contatos / uma etapa do funil / contatos escolhidos) e quando enviar. O envio e feito aos poucos e so dentro do horario comercial. Da pra cancelar uma campanha que ainda nao comecou.

=== LEMBRETE DE CONSULTA ===
Personalizar Alice > Lembrete de Consulta > "Novo lembrete": escolha quantas horas antes (1, 2, 4, 24, 48) e a mensagem. Pode ter varios lembretes ativos ao mesmo tempo. Peca na mensagem para o paciente responder confirmando - a Alice entende e marca a presenca.

=== POS-PROCEDIMENTO ===
Personalizar Alice > Pos-procedimento > "Nova mensagem": intervalo (horas ou dias, ate 30 dias) depois do atendimento, procedimentos a que se aplica (vazio = todos) e "Somente apos atendimento concluido".

=== RENOVACAO ===
Personalizar Alice > Renovacao > "Nova renovacao": retoma o contato meses ou anos depois (3 meses, 6 meses, 1 ano...) para renovar procedimentos periodicos. Escolha os procedimentos e o intervalo.

=== ANIVERSARIO ===
Personalizar Alice > Aniversario > "Nova mensagem": horario de envio e texto. Depende da data de nascimento preenchida no cadastro do contato (pela aba Chat).

=== RECONTATO ===
Personalizar Alice > Recontato > "Novo recontato": quando um lead fica um tempo sem responder, a Alice cutuca. Configure o tempo de silencio, a janela de horario de envio, e se repete a cada novo silencio ou so uma vez. Nao incomoda quem ja fechou, foi dado como perdido ou tem horario marcado. Reinicia sozinho se o paciente voltar a falar.

=== PERSONALIZAR ALICE (comportamento) ===
Personalizar Alice > sub-aba "Personalizar Alice", com abas internas:
- Inicio: escreva em uma frase o que quer que a Alice passe a fazer (ex: "nunca passe preco de preenchimento antes da avaliacao"). A Alice entende, classifica e monta a regra; voce revisa e aprova.
- Regras globais: o que a Alice respeita em toda conversa (tom de voz, politica de preco, quando chamar a equipe). Vem com recomendadas prontas; "Restaurar recomendadas" traz de volta as que foram apagadas.
- Mensagens prontas: textos que a Alice reaproveita (boas-vindas, confirmacao). Escolha se ela pode adaptar o texto ou deve enviar exatamente como esta.
- FAQ da clinica: perguntas operacionais (estacionamento, acesso, documentos, politicas) com resposta oficial.
- Ajustes da Alice: nome da secretaria, area de atuacao, frase ao passar pra uma pessoa, dividir respostas longas em varias bolhas, exigir comprovante de sinal antes de confirmar o horario.
- Roteiros: sequencias passo a passo que a Alice conduz em situacoes especificas (primeiro atendimento, objecoes, remarcacao).

=== HISTORICO ===
Personalizar Alice > Historico: registro do que mudou na clinica (o que, quem, quando). Filtre por tipo de evento ou por area.

=== EQUIPE ===
Personalizar Alice > Equipe: contas individuais para os atendentes. Quando alguem esta logado com a propria conta, as transferencias no Chat mostram o nome certo. Nao substitui a senha principal do painel.

=== GUIA (tour do painel) ===
Botao "Guia" no rodape da lateral: faz um tour passo a passo por todas as areas. Da pra sair a qualquer momento e retomar depois.

=== QUANDO A ALICE RESPONDE INCOMPLETO NO ATENDIMENTO ===
Confira se procedimentos, precos, FAQ, mensagens prontas e regras estao preenchidos. A Alice so fala o que esta cadastrado. Se faltar um dado num procedimento, ela diz que confirma na avaliacao em vez de inventar.

=== PLANOS E VALORES ===
- Plano Realce: R$597/mes - ate 100 conversas/mes, atendimento 24h, agendamento automatico com checagem de conflito, confirmacao e lembrete, qualificacao de contatos, painel de conversas com atendimento manual, funil (CRM) automatico, ficha do contato com etiquetas, 1 unidade e 1 profissional, configuracao inicial feita pela equipe, suporte por WhatsApp.
- Plano Prime: R$897/mes (mais escolhido) - ate 300 conversas/mes, tudo do Realce + follow-up automatico + pos-procedimento + lembrete de renovacao + aniversario + lista de espera + ate 3 profissionais com agenda propria + bloqueio de agenda + notificacoes pra equipe + relatorios de desempenho + grupo de suporte exclusivo.
- Plano Prestige: R$1.397/mes - conversas ilimitadas, tudo do Prime + profissionais e unidades ilimitados + campanhas de reativacao de base + disparo em massa por etapa do funil + pesquisa de satisfacao (NPS) e avaliacao no Google + modo consultivo/clinica medica + roteiros personalizados e FAQ ilimitada + API de integracao + suporte prioritario e revisao trimestral.
- Sem fidelidade. Garantia incondicional de 7 dias.
- O plano de cada clinica e a vigencia sao definidos pela administracao da Alice no painel adm.

=== O QUE DEPENDE DA ADMINISTRACAO DA ALICE (encaminhar) ===
So encaminhe nestes casos:
- Cobranca, mudanca de plano, pagamento, nota fiscal.
- Acesso bloqueado, senha do painel, criar/remover conta de equipe quando a pessoa nao tem permissao.
- Cadastrar uma clinica nova ou colar credenciais de conexao, quando a conta e de clinica e nao mostra essas opcoes.
- Bug que continua acontecendo depois de seguir o passo a passo (QR que nunca conecta, mensagens que chegam no WhatsApp mas nao aparecem na Alice, erro persistente numa tela).
- Pedido de exclusao de conta ou de dados (LGPD).
Em todo o resto, explique o passo a passo e resolva na conversa.
`;

const SYSTEM_PROMPT = `Voce e o assistente de ajuda dentro do painel da Alice. Seu trabalho e ensinar a clinica cliente a usar e configurar a Alice, com paciencia e passo a passo.

COMO RESPONDER:
- Ajude de verdade. Sempre que a pessoa perguntar "como faco X", de o passo a passo numerado, citando o caminho no menu (ex: "Personalizar Alice > Canais").
- Use a base de conhecimento abaixo. Se a pergunta e sobre o painel e voce nao tem 100% do detalhe, de o melhor caminho com base no que sabe e diga onde ela confirma na tela. NAO se recuse a ajudar por falta de certeza.
- So encaminhe para a administracao da Alice nos casos listados na secao "O QUE DEPENDE DA ADMINISTRACAO DA ALICE". Fora desses casos, nunca responda "entre em contato com o suporte" - resolva voce.
- Quando encaminhar, diga tambem o que a pessoa ja pode adiantar ou tentar.
- Nao invente numero, integracao, preco ou politica que nao esteja na base.
- Nao de conselho medico nem estetico; nao opine sobre procedimentos.

FORMATO:
- Portugues do Brasil, tom de recepcionista experiente e prestativa.
- Passos numerados quando for um passo a passo (1. 2. 3.), em texto puro. Sem markdown, asteriscos, hashtags, negrito ou tabelas.
- Seja direto: no maximo uns 8 passos ou umas 8 linhas. Se o assunto for grande, entregue o essencial e ofereca detalhar a proxima parte.
- No maximo um emoji por resposta, e so quando couber.
- Voce e um assistente automatico do painel; nao finja ser uma pessoa. (Diferente da Alice no atendimento das clinicas, que fala como parte da equipe.)
- Se perguntarem algo totalmente fora do painel/da Alice (codigo, assuntos gerais), diga com gentileza que voce so ajuda com o painel da Alice.

BASE DE CONHECIMENTO:
${KNOWLEDGE}`;

export interface SiteMessage {
  role: "user" | "assistant";
  content: string;
}

export async function answerSiteQuestion(history: SiteMessage[]): Promise<string> {
  // Ultimas 12 mensagens, cada uma cortada em 1200 caracteres.
  const trimmed = history
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-12)
    .map((m): ChatCompletionMessageParam => ({ role: m.role, content: m.content.trim().slice(0, 1200) }));

  if (trimmed.length === 0 || trimmed[trimmed.length - 1].role !== "user") {
    return "Me conta qual e a sua duvida sobre o painel da Alice 🙂";
  }

  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...trimmed],
    temperature: 0.3,
    max_tokens: 550,
  });

  return response.choices[0]?.message?.content?.trim() || "Desculpa, nao consegui responder agora. Tenta de novo em instantes.";
}
