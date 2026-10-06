# Briefing de configuração — Alice (secretária virtual da clínica)

Este é o questionário que o cliente novo responde para a Alice ser configurada.
No painel, em **Personalizar Alice → Briefing**, o botão **"Copiar modelo do briefing"** copia exatamente este texto
para você enviar ao cliente. Depois que ele responder, cole a resposta no mesmo lugar e clique em **Analisar briefing** → **Aplicar configuração**.

> Fonte única: `BRIEFING_TEMPLATE` em `src/ai/briefing.ts`. Este arquivo é uma cópia para leitura (com acentos).

---


Este questionário serve para treinar a Alice por completo numa única rodada. Ele é longo
de propósito: quanto mais você responder, menos a Alice vai errar, improvisar ou chamar
a equipe à toa. Pode levar de 40 minutos a 1 hora. Se preferir, responda por áudio e peça
para transcreverem.

Como responder:
- Responda o que souber e deixe em branco o que não se aplica. Pode escrever em texto corrido.
- Dê EXEMPLOS REAIS sempre que puder (frases que vocês falam, conversas que aconteceram). Exemplo vale mais que explicação.
- Onde pedir "como responder", escreva do jeito que VOCÊ responderia ao paciente.
- Se não sabe ou ainda não decidiu algo, escreva "não decidi" — é melhor que chutar.

IMPORTANTE: se vocês já têm qualquer material pronto (manual de atendimento, script de vendas,
mensagens que já usam no WhatsApp, prints de conversas reais, lista de perguntas e respostas,
tabela de preços, apresentação da clínica, textos do site/Instagram, termos de consentimento,
orientações pré e pós procedimento), NÃO reescreva do zero: cole tudo inteiro junto com as
respostas, mesmo fora do formato abaixo. É o material mais valioso para treinar a Alice, e a
IA sabe aproveitar texto solto.

## 1. DADOS DA CLÍNICA
- Nome da clínica (como o paciente conhece):
- Razão social / CNPJ (se quiser que conste):
- WhatsApp de atendimento (com DDD) — se tiver mais de um número, diga QUAL é o oficial que fica conectado à Alice:
- Instagram da clínica:
- Site (se tiver):
- Cidade e estado:
- Fuso horário (se não for o de Brasília):
- Horário de funcionamento (que horas abre / que horas fecha):
- Dias de atendimento (ex.: segunda a sexta, sábado até 13h; se só alguns sábados específicos do mês, explique a regra):
- Tem intervalo de almoço ou pausa? Em que horário (pode ser meia-hora)?
- A clínica fecha em feriados nacionais? E em feriados locais ou datas específicas (recesso, férias coletivas)? Quais:
- Número para receber avisos de agendamento/cancelamento (pode ser o mesmo de atendimento):
- Quais avisos esse número deve receber: novo agendamento / remarcação / cancelamento / confirmação do paciente / pedido de atendimento humano:

## 2. ENDEREÇO(S)
Para cada unidade:
- Nome da unidade (ex.: Matriz, Unidade Centro):
- Rua, número, complemento (sala, andar, bloco):
- Bairro, cidade, estado, CEP:
- Como chegar / ponto de referência:
- Estacionamento (próprio, conveniado, na rua, valor):
- Acessibilidade (rampa, elevador):
- Link do Google Maps:
- Os profissionais atendem em todas as unidades ou cada um em uma? Em quais dias:

## 3. SOBRE A CLÍNICA E O PÚBLICO
- Resuma a clínica em 2 ou 3 frases, como você apresentaria a um paciente novo:
- Área de atuação em uma frase (ex.: harmonização facial, corporal e íntima):
- A clínica é: ( ) só estética  ( ) só médica  ( ) as duas
- Há quanto tempo atua? Quantos pacientes já atendeu (se quiser citar)?
- Quais são os DIFERENCIAIS da clínica que a Alice pode destacar (tecnologia, técnica, formação, estrutura, atendimento, resultado)?
- Por que o paciente escolhe vocês e não a concorrência?
- Quem é o paciente ideal (idade, perfil, o que busca)?
- Existe um perfil de paciente que vocês NÃO atendem ou preferem não atender?
- De onde vêm os pacientes hoje (Instagram, indicação, Google, anúncios)? E como costumam chegar no WhatsApp (clicaram no anúncio, indicação, perfil)?
- Quem são os principais concorrentes e como a Alice deve (ou não) falar deles?
- A clínica tem prêmios, certificações, formações ou parcerias que valem ser citados?
- Pode a Alice citar resultados/casos de pacientes? Em que termos (e o que é proibido por ética/regulamento)?

## 4. COMO A ALICE SE APRESENTA
- A Alice fala como: ( ) parte da equipe da clínica  ( ) secretária da clínica  ( ) secretária de um profissional
- Se for de um profissional, qual o nome (ex.: Dra. Camila Souza):
- Nome pelo qual a secretária se apresenta (padrão: Alice):
- Ela deve se identificar como assistente virtual/IA, ou atender sem dizer isso? Se o paciente perguntar "é robô?", o que ela responde:
- Estilo de atendimento: ( ) mais direto/comercial (oferece horário, conduz para a agenda)  ( ) mais consultivo (avaliação primeiro, sem pressão, no ritmo do paciente)
- O paciente precisa saber qual procedimento quer, ou a clínica prefere que ele passe por avaliação para o profissional indicar? (SIM = pode exigir / NÃO = sempre oferecer avaliação)
- A Alice pode usar emojis? Quais combinam com a clínica e quais nunca usar?
- Tem link de auto-agendamento (o paciente marca sozinho num site)? Qual? A Alice deve mandar esse link ou agendar ela mesma?
- A Alice pode responder áudios, fotos e documentos que o paciente manda? O que ela deve fazer quando chega um áudio (transcrever e responder, pedir que escreva, chamar a equipe):

## 5. TOM DE VOZ E VOCABULÁRIO
- Como vocês gostam de falar com o paciente (formal/cerimonioso, próximo, leve, descontraído, premium...). Se puder, 3 adjetivos:
- Tratam o paciente por "você" e primeiro nome, ou por "Senhor(a)", ou "Dr./Dra."?
- Palavras que a clínica prefere usar no lugar de outras (ex.: "avaliação" em vez de "consulta", "investimento" em vez de "preço", "paciente" em vez de "cliente"). Liste os pares:
- Palavras, gírias ou expressões PROIBIDAS (ex.: "barato", "promoção", "gente", "amiga", "querida"):
- Formato das mensagens: curtas ou completas? No máximo uma pergunta por vez? Pode usar listas e tópicos? Pode usar negrito?
- Como a Alice cumprimenta (bom dia/boa tarde/boa noite conforme o horário)? Algum bordão de abertura ou de despedida:
- Cole 3 a 5 mensagens REAIS que vocês acham que representam bem o jeito da clínica falar:
- Cole 1 ou 2 exemplos de como NÃO falar (mensagens que vocês acham frias, insistentes ou fora do perfil):

## 6. REGRAS DE OURO
- O que a Alice NUNCA deve fazer ou dizer (liste todas, mesmo as que parecem óbvias):
- O que a Alice SEMPRE deve fazer em toda conversa:
- A Alice PODE informar preço pelo WhatsApp, ou só depois de entender o objetivo do paciente / na avaliação? Se pode, como (valor fechado, "a partir de", faixa):
- A Alice pode dar desconto, brinde ou condição especial? Quanto e em que situação? Ou sempre chama a equipe:
- A Alice pode prometer resultado, prazo ou "garantia"? Em que termos:
- A Alice pode dar opinião clínica, indicar procedimento para a queixa do paciente ou comparar procedimentos? Até onde:
- A Alice pode falar de medicamentos, doses, contraindicações e efeitos colaterais? Ou só o profissional:
- Se o paciente perguntar algo que a Alice não sabe, ela deve: ( ) admitir e chamar a equipe  ( ) dizer que vai verificar e retornar  ( ) outro:
- O que fazer com pessoas que só querem informação e somem (insistir? quantas vezes? por quanto tempo?):
- Existem assuntos sensíveis (política, religião, concorrentes, preços de outros lugares, reclamações públicas) e como a Alice deve se comportar:

## 7. TRANSFERÊNCIA PARA A EQUIPE
- Quando a Alice deve chamar uma pessoa? (ex.: pedido de desconto, negociação, reclamação, dúvida clínica que só o profissional responde, risco médico, paciente pede para falar com alguém, envio de exame/laudo/receita/foto para avaliação, pedido de diagnóstico ou prescrição, problema de pagamento, paciente irritado):
- Palavras que devem SEMPRE acionar a transferência (ex.: nomes de exames, "dose", "efeito colateral", "emergência", "dor forte", "inchaço", "alergia", "processo", "advogado", "Procon"):
- Frase que a Alice usa antes de passar para uma pessoa (ex.: "Só um instante que já verifico isso pra você"):
- Quem assume quando a Alice transfere (nome da pessoa) e em que horários essa pessoa responde:
- Se a transferência acontecer fora do horário da equipe, o que a Alice diz ao paciente (ex.: "retornamos amanhã às 9h"):
- Depois que a equipe assume, a Alice deve ficar quieta naquela conversa? Até quando (ex.: voltar a atender após X horas sem resposta da equipe):
- Urgências e emergências (reação alérgica, sangramento, dor intensa, complicação pós-procedimento): qual o passo a passo e qual o telefone de contato:

## 8. PERGUNTAS E OBJEÇÕES MAIS COMUNS
Liste as perguntas e objeções que os pacientes mais fazem e COMO a Alice deve responder
(escreva a resposta do jeito que vocês dariam). Quanto mais exemplos reais, melhor:
- "Achei caro" / "tem desconto?" / "parcela em quantas vezes?":
- "Vou pensar e te aviso" / "preciso falar com meu marido/esposa":
- "Moro longe" / "não tenho tempo" / "não tenho horário":
- "Tem como fazer mais barato em outro lugar" / comparação com concorrente:
- "Dói?" / "tem risco?" / "fica natural?" / "quanto tempo dura?":
- "Qual é o melhor para mim?" / "o que você indica?":
- "Posso fazer grávida / amamentando / tomando X remédio?":
- Pedido de foto de antes e depois:
- Pedido de endereço, estacionamento, como chegar:
- Outras dúvidas ou objeções específicas do público de vocês (medo de agulha, medo de ficar artificial, dúvida sobre resultado, convênio, etc.):

## 9. PROCEDIMENTOS / SERVIÇOS
Para CADA procedimento (copie o bloco quantas vezes precisar):
- Nome:
- Categoria (facial, corporal, íntima, capilar, cirurgia, estética, etc.):
- Quem realiza (profissional):
- Duração aproximada da sessão:
- Valor (ou "depende de avaliação"). Se varia, de que depende:
- Formas de pagamento (dinheiro, pix, crédito, débito, boleto):
- Parcela no cartão? Em até quantas vezes, e a partir de quantas vezes cobra juros?
- Desconto à vista?
- Link de pagamento (se tiver) e chave Pix:
- Exige sinal/entrada? Valor ou %:
- Descrição curta (o que é, como funciona, para quem):
- Queixas/objetivos que atende (ex.: "rosto cansado", "flacidez", "manchas"):
- Benefícios que a Alice pode afirmar (e os que NÃO pode afirmar):
- Outros nomes que o paciente usa (ex.: "botox", "preenchimento labial", "lipo de papada"):
- Quando o resultado começa a aparecer e quanto tempo dura:
- Quantas sessões costuma precisar e com qual intervalo:
- Indicações (para quem é) e contraindicações (para quem NÃO é):
- Preparo antes (jejum, suspender medicamento, não tomar sol, vir sem maquiagem, exames):
- Cuidados depois (o que pode e não pode, por quantos dias):
- Efeitos esperados e o que é normal (vermelhidão, inchaço, roxo) — e quando procurar a clínica:
- Precisa de avaliação/consulta prévia antes de agendar? Ela é paga? Quanto?
- Pode ser feito no mesmo dia da avaliação?
- Tem fotos de antes/depois que a Alice pode enviar? (mande os arquivos separados)
- Tem vídeo ou material explicativo?
- É o carro-chefe da clínica? Algum procedimento que vocês querem vender mais / que querem priorizar?

## 10. PACOTES, COMBOS, PROMOÇÕES E CONDIÇÕES
- Existem pacotes ou combos (ex.: 3 sessões com desconto)? Descreva cada um com valor:
- Existem promoções ativas ou sazonais? Quais, por quanto tempo e quem pode usar:
- Programa de indicação, fidelidade, cashback ou desconto para retorno:
- Cupons ou condições especiais (aniversariante, primeira vez, convênio com empresa):
- A Alice pode oferecer promoção por conta própria ou só quando o paciente perguntar?
- Existe prazo de validade de pacote/crédito? Pode transferir para outra pessoa?

## 11. PRODUTOS VENDIDOS (se houver)
- Nome / valor / descrição / para que serve / forma de pagamento:
- A Alice pode vender produto sozinha ou só informa e chama a equipe?
- Tem entrega/envio? Prazo e valor do frete:

## 12. PROFISSIONAIS E EQUIPE
Para cada profissional:
- Nome (como a Alice deve chamar: "Dra. Fulana", "Fulana"):
- Especialidade, formação e registro profissional (CRM, CRO etc.):
- Mini biografia que a Alice pode contar (2 ou 3 frases):
- Instagram:
- Quais procedimentos realiza:
- Dias e horários de atendimento (se diferentes da clínica) e intervalo de almoço:
- Atende em qual unidade:
- Atende no mesmo horário de outro profissional (ex.: médico + enfermagem em paralelo)?
- O paciente pode escolher o profissional ou a clínica decide?
- Algum profissional atende só retorno, só avaliação, só um tipo de paciente?
Equipe de apoio (recepção, atendimento, financeiro):
- Nome e função de cada pessoa, e o que cada uma resolve (para a Alice saber a quem passar cada assunto):

## 13. AGENDAMENTO
- Como funciona o agendamento hoje, do pedido até a confirmação:
- Quanto tempo de antecedência mínima para marcar (ex.: não marca para o mesmo dia)? E antecedência máxima:
- Existe tempo de preparo/limpeza entre pacientes? Quantos minutos:
- Quais horários são mais disputados e quais ficam vagos (a Alice deve priorizar encher os vagos)?
- A Alice deve oferecer quantas opções de horário por vez (ex.: 2 ou 3)?
- Algum procedimento atende por ordem de chegada (vários pacientes no mesmo horário)?
- A primeira consulta/avaliação segue regras diferentes (duração, valor, profissional)?
- Precisa de dados do paciente para agendar? Quais (nome completo, CPF, data de nascimento, e-mail, endereço, indicação):
- Menores de idade: precisa de responsável? Como é feito:
- Usam Google Agenda ou outro sistema de agenda? Qual? Já existe agenda com pacientes marcados que precisamos considerar:
- Bloqueios já conhecidos (férias, congressos, dias sem atendimento, horários fixos reservados):
- Lista de espera: quando não há horário, a Alice deve anotar o interesse e avisar se abrir vaga?
- Encaixes: a recepção pode encaixar fora do expediente pelo painel? (a Alice sempre segue o horário à risca)

## 14. SINAL, PAGAMENTO E FINANCEIRO
- Exigem sinal/entrada para confirmar o agendamento? Para quais procedimentos? Valor fixo ou %?
- Como o paciente paga o sinal (Pix, link, transferência)? Chave Pix e nome do titular:
- A Alice só confirma o horário depois do comprovante? Quem confere o comprovante:
- O sinal abate do valor final? O saldo é pago quando e como?
- O sinal é devolvido em caso de desistência ou falta? Em que prazo e condições:
- Quanto tempo o paciente tem para pagar o sinal antes de a Alice liberar o horário:
- Política de cancelamento e remarcação: com quanto tempo de antecedência precisa avisar? Tem multa? Quantas remarcações são permitidas:
- Política de atraso (tolerância de quantos minutos) e de falta (no-show):
- Aceitam convênio/plano de saúde? Emitem nota fiscal e recibo para reembolso:
- Como lidar com inadimplência ou pagamento pendente:
- Reembolso: em que casos e como:

## 15. PERGUNTAS FREQUENTES (operacionais)
Responda as que fizerem sentido e acrescente as suas:
- Como é a primeira consulta/avaliação (o que inclui, quanto tempo dura, quanto custa):
- O paciente precisa levar algo (exames, documentos, acompanhante)?
- Pode vir acompanhado? Pode levar criança?
- Atende crianças, gestantes, idosos?
- Tem estacionamento? Como funciona?
- Aceita convênio? Emite nota fiscal?
- Qual a política de privacidade das fotos e dos dados do paciente?
- Existe termo de consentimento? O paciente assina antes ou no dia?
- Dá para fazer à distância/telemedicina/consulta online?
- Tem Wi-Fi, café, espaço de espera? Algo que diferencia a experiência:
- Outras dúvidas comuns dos pacientes de vocês (escreva a pergunta e a resposta):

## 16. MENSAGENS PRONTAS
Cole o TEXTO EXATO de qualquer mensagem que vocês já usam hoje (mesmo informalmente). Se a Alice
deve usá-la palavra por palavra, escreva "usar exatamente". Se for só referência de tom, escreva "adaptar":
- Boas-vindas / primeiro contato:
- Resposta a quem pergunta só "quanto custa?":
- Apresentação da clínica:
- Apresentação de cada procedimento ou consulta:
- Convite para avaliação:
- Pedido de sinal/pagamento (com Pix):
- Confirmação de horário agendado:
- Orientações antes do procedimento:
- Orientações depois do procedimento:
- Lembrete de consulta:
- Mensagem quando o paciente falta:
- Mensagem quando o paciente cancela ou remarca:
- Mensagem para quem sumiu da conversa (recontato):
- Mensagem quando não entende o que o paciente escreveu:
- Mensagem fora do horário de atendimento:
- Mensagem de agradecimento/encerramento/despedida:
- Pedido de avaliação no Google ou indicação:

## 17. AUTOMAÇÕES (a Alice envia sozinha)
- Lembrete de consulta: quer? Quantas horas/dias antes (pode ser mais de um, ex.: 48h e 3h)? Pede confirmação de presença? O que fazer se o paciente não confirmar:
- Recontato de quem sumiu na conversa: quer? Depois de quanto tempo sem responder? Quantas tentativas e com que intervalo? Em que horários NÃO pode mandar (ex.: noite, domingo):
- Confirmação do agendamento logo após marcar: quer mandar mensagem ao paciente? Qual texto:
- Pós-procedimento (cuidados/acompanhamento): quer? Para quais procedimentos, quantos dias depois, e qual mensagem para cada um:
- Pesquisa de satisfação (NPS): quer? Quantas horas depois do atendimento? A partir de que nota pedir avaliação no Google? Link do Google Meu Negócio:
- Renovação (retomar contato meses depois para refazer): quais procedimentos e de quanto em quanto tempo (ex.: toxina a cada 6 meses):
- Recuperação de paciente inativo há muito tempo (ex.: 6 meses sem contato): quer? Qual mensagem:
- Lembrete de renovação de receita/retorno:
- Mensagem de aniversário: quer? Em que horário? Com algum mimo:
- Datas comemorativas (Dia das Mães, Black Friday etc.): quer disparos? Quais:
- Disparos em massa (campanhas/promoções): quer usar? Quem aprova o texto:
- Em quais horários e dias NUNCA enviar mensagem automática:

## 18. ROTEIROS ESPECÍFICOS
Descreva o passo a passo que a Alice deve seguir (quando já existe um jeito certo de conduzir)
em cada situação. Quanto mais detalhado, melhor — pode escrever como diálogo:
- Primeiro atendimento / qualificação do paciente (o que perguntar, em que ordem):
- Pedido de preço antes de entender o que o paciente quer:
- Paciente indeciso sobre qual procedimento fazer:
- Agendamento (do interesse até a confirmação, incluindo sinal se houver):
- Paciente que já é cliente e quer marcar retorno:
- Remarcação ou cancelamento:
- Paciente que faltou:
- Contorno de objeções (preço, tempo, medo, indecisão):
- Paciente que mandou foto, exame ou receita:
- Intercorrência, urgência ou dúvida clínica fora do que a Alice pode responder:
- Reclamação ou paciente insatisfeito:
- Paciente que pede desconto:
- Indicação de amigo/familiar:
- Fechamento da conversa quando o paciente agradece ou diz que vai pensar:

## 19. TRIAGEM E QUALIFICAÇÃO
- Quais perguntas a Alice deve fazer para entender o paciente antes de oferecer o horário:
- Que informações ela deve registrar sobre o paciente (queixa principal, objetivo, orçamento, urgência, como conheceu a clínica, já fez algo parecido):
- O que torna um paciente "quente" (pronto para agendar) e o que é "frio" (só curiosidade):
- Quando um paciente deve ser considerado desqualificado (fora da região, fora do perfil, só pesquisando preço) e como a Alice encerra com educação:
- O que a Alice faz com pacientes que já foram atendidos (reconhece, agradece, oferece retorno):
- Etapas do funil de vendas que a clínica usa (ex.: novo contato → em conversa → avaliação agendada → compareceu → fechou → perdido):
- Em que momento cada etapa muda (ex.: marcou avaliação = "avaliação agendada"):

## 20. ANÚNCIOS E MARKETING (se houver)
- A clínica anuncia (Instagram/Facebook/Google)? Qual o investimento e a meta:
- Mensagens que chegam de anúncio: a Alice deve tratar de forma diferente? Como (ex.: "vi seu anúncio de X"):
- Quais campanhas estão rodando e que oferta cada uma promete (para a Alice não contradizer o anúncio):
- Quer medir resultado real dos anúncios (agendamento, comparecimento, venda)? Tem Pixel/Dataset da Meta e quem administra:
- URL do site e das páginas de destino dos anúncios:
- Quais etapas contam como venda fechada, lead qualificado e perdido:

## 21. LGPD, ÉTICA E LIMITES LEGAIS
- Regras do conselho profissional que a Alice precisa respeitar (ex.: CFM, CRO, CRBM — proibição de divulgar preço, promessa de resultado, antes e depois):
- A Alice pode enviar fotos de antes e depois? Só com autorização do paciente?
- Como tratar dados sensíveis (fotos, exames, histórico de saúde) enviados pelo WhatsApp:
- Como o paciente pede para ser removido de mensagens automáticas e o que a Alice responde:
- Termos de uso, consentimento ou aviso de privacidade que a Alice deve citar:
- Existe algo que a Alice jamais pode fazer por determinação legal ou do conselho:

## 22. OBSERVAÇÕES LIVRES E MATERIAIS EXTRAS
- Qualquer coisa importante que não coube acima (casos difíceis que já aconteceram, erros que quer evitar, manias dos pacientes):
- Como é um atendimento PERFEITO para vocês? Descreva ou cole um exemplo real:
- Como é um atendimento RUIM? O que mais incomoda quando acontece:
- O que a clínica espera da Alice nos primeiros 30 dias (metas: mais agendamentos, menos falta, menos trabalho da recepção):
- Cole aqui qualquer manual, script, tabela de preços, histórico de conversas, textos do site/Instagram ou documentos que ajudem a treinar a Alice:
