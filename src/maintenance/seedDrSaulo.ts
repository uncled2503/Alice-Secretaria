import "dotenv/config";
import { fileURLToPath } from "url";
import { prisma } from "../db/client.js";
import { hashPassword } from "../api/passwords.js";
import { seedDefaultRules } from "../ai/rules.js";
import { getFunnelStages } from "../crm/stages.js";

// Configuracao inicial da Clinica Dr. Saulo Silva (medicina de precisao,
// emagrecimento, performance e longevidade) a partir do manual de experiencia
// concierge e diretrizes de IA recebido em 15/09/2026, com as correcoes dadas
// na mesma conversa (valor da consulta, formas de pagamento, endereco novo).
// O seed e idempotente: atualiza apenas os registros que ele gerencia e pode
// ser executado novamente sem criar duplicatas.

// AINDA NAO TEMOS O NUMERO DE WHATSAPP DA CLINICA (cliente disse que manda
// depois). Usamos um placeholder pra poder cadastrar tudo o resto agora; troque
// pelo numero real (formato 55DDDNUMERO) assim que ele chegar e rode o seed de
// novo - a busca abaixo tambem localiza a clinica pelo nome, entao trocar o
// placeholder pelo numero real atualiza o mesmo registro em vez de duplicar.
const WA = process.env.DR_SAULO_WHATSAPP?.trim() || "0000000000000";
const CLINIC_NAME = "Clínica Dr. Saulo Silva";
const LOGIN = "drsaulo@aliceconversa.com";
// Senha inicial da conta de acesso. So e aplicada quando a conta e criada;
// re-rodar o seed nunca sobrescreve uma senha que o cliente ja trocou.
const INITIAL_PASSWORD = process.env.DR_SAULO_INITIAL_PASSWORD?.trim() || "drsaulo1234";
const SEED_MARKER = "seed:dr-saulo";

const HANDOFF_PHRASE =
  "Vou encaminhar sua solicitação para nossa equipe para que possamos oferecer o suporte mais adequado. Em instantes você será atendido(a).";

const CONSULTA_VALOR = 750;
const SINAL_VALOR = 225; // 30% de 750
const SALDO_VALOR = 525; // restante, pago no dia

const CONSULTA_GOALS =
  "emagrecimento\nperformance física e mental\nreposição hormonal\nimplantes hormonais e não hormonais\nlipedema\nganho de massa muscular\nsaúde metabólica\nqualidade de vida\nlongevidade\nmenopausa e transição hormonal feminina\nandropausa";

const PROCEDURES = [
  {
    name: "Experiência Clínica Presencial com Dr. Saulo Silva",
    durationMin: 90,
    price: CONSULTA_VALOR as number | null,
    description:
      "Avaliação integral e individualizada com o Dr. Saulo Silva, incluindo pelo menos duas avaliações de bioimpedância, análise corporal detalhada, exame físico e orientações nutricionais e de exercícios. Ao final, um plano de protocolo totalmente personalizado para o objetivo do paciente.",
    goals: CONSULTA_GOALS,
    benefits:
      "avaliação completa da composição corporal\nplano individualizado conduzido pelo Dr. Saulo Silva\norientação nutricional e de exercícios\nacompanhamento por 30 dias após a consulta",
    aliases: "consulta,consulta presencial,avaliação,avaliação integral,experiência clínica,primeira consulta",
    resultTimeline: null,
  },
  {
    name: "Experiência Clínica Online com Dr. Saulo Silva",
    durationMin: 90,
    price: CONSULTA_VALOR as number | null,
    description:
      "Avaliação integral e individualizada com o Dr. Saulo Silva por telemedicina, com a mesma profundidade da consulta presencial, incluindo orientações nutricionais e de exercícios. Ao final, um plano de protocolo totalmente personalizado para o objetivo do paciente.",
    goals: CONSULTA_GOALS,
    benefits:
      "mesma profundidade da consulta presencial\nplano individualizado conduzido pelo Dr. Saulo Silva\norientação nutricional e de exercícios\nacompanhamento por 30 dias após a consulta\natendimento de qualquer lugar, inclusive fora do Brasil",
    aliases: "consulta online,telemedicina,consulta por vídeo,avaliação online,experiência clínica online",
    resultTimeline: null,
  },
  {
    name: "Aplicação",
    durationMin: 15,
    price: null as number | null,
    description:
      "Aplicação do protocolo definido pelo Dr. Saulo Silva após a Experiência Clínica. Valor ainda não informado pela clínica.",
    goals: null,
    benefits: null,
    aliases: "aplicação do protocolo,aplicação de medicação",
    resultTimeline: null,
  },
  {
    name: "Reavaliação",
    durationMin: 30,
    price: null as number | null,
    description:
      "Consulta de retorno com o Dr. Saulo Silva para avaliar a evolução do protocolo e fazer ajustes. Valor ainda não informado pela clínica.",
    goals: null,
    benefits: null,
    aliases: "retorno,consulta de retorno,revisão do protocolo",
    resultTimeline: null,
  },
] as const;

const FAQS = [
  {
    question: "Qual é o horário de atendimento?",
    alternates: "horário\nfuncionamento\nabre que horas\nfecha que horas\natende sábado\nsábado",
    answer: "Atendemos de segunda a sexta-feira, das 8h30 às 17h30. Não há atendimento aos sábados.",
  },
  {
    question: "Onde fica a clínica?",
    alternates: "endereço\nonde fica\nlocalização\ncomo chegar",
    answer:
      "Estamos na Rua Itatuba, 201 - Edifício Cosmopolitan Mix, sala 1701, Parque Bela Vista, Salvador/BA.",
  },
  {
    question: "Quanto custa a consulta?",
    alternates: "preço\nvalor\nquanto custa\nquanto fica\nme passa os valores\ninvestimento",
    answer:
      "O investimento na Experiência Clínica com o Dr. Saulo Silva, presencial ou online, é de R$ 750,00. Antes de falar de valores, vale entender o objetivo do paciente para explicar como o protocolo pode ajudar.",
  },
  {
    question: "Quais são as formas de pagamento?",
    alternates: "pagamento\npix\ncartão\ndinheiro\ndébito\nparcela\nparcelamento",
    answer:
      "Aceitamos dinheiro, Pix, cartão de débito e cartão de crédito. No crédito, até 3x sem juros ou até 12x com o acréscimo cobrado pela operadora da máquina.",
  },
  {
    question: "É necessário pagar sinal para confirmar o horário?",
    alternates: "sinal\nentrada\ntaxa de agendamento\nconfirmar horário\ncomprovante",
    answer:
      "Sim. Para reservar o horário, pedimos um sinal de 30% do valor da consulta (R$ 225,00). O saldo restante (R$ 525,00) é pago no dia da consulta.",
  },
  {
    question: "Posso cancelar ou remarcar minha consulta?",
    alternates: "cancelar\nremarcar\nreagendar\nnão vou conseguir ir\nmudar o horário",
    answer: "Sim. Pedimos apenas que o cancelamento ou a remarcação sejam avisados com pelo menos 24 horas de antecedência.",
  },
  {
    question: "A clínica atende por convênio ou plano de saúde?",
    alternates: "convênio\nplano de saúde\naceita plano\natende convênio\nreembolso",
    answer:
      "O atendimento com o Dr. Saulo Silva é exclusivamente particular. Fornecemos nota fiscal e relatório para que você solicite o reembolso junto ao seu plano de saúde, caso ele preveja essa cobertura.",
  },
  {
    question: "Os exames laboratoriais entram pelo convênio?",
    alternates: "exame pelo convênio\nfaço exame pelo plano\nlaboratório",
    answer: "Sim, os exames laboratoriais podem ser realizados pelo seu plano de saúde, em qualquer laboratório de sua preferência.",
  },
  {
    question: "Como funciona a consulta online?",
    alternates: "telemedicina\nconsulta por vídeo\natende outra cidade\nmoro em outro estado\natende fora do brasil",
    answer:
      "A telemedicina do Dr. Saulo Silva está disponível para todo o Brasil e o exterior, por uma plataforma segura e criptografada, com a mesma profundidade da consulta presencial.",
  },
  {
    question: "A clínica atende crianças?",
    alternates: "atende criança\natende menor\npediatria",
    answer: "O foco do Dr. Saulo Silva é a performance e a saúde do adulto. Para o público pediátrico, podemos indicar especialistas parceiros.",
  },
  {
    question: "Posso levar meus exames antigos?",
    alternates: "levar exames\nexames anteriores\njá tenho exame",
    answer: "Com certeza. Eles ajudam o Dr. Saulo Silva a entender seu histórico, embora novos exames de precisão possam ser solicitados.",
  },
  {
    question: "Vocês vendem os medicamentos ou suplementos prescritos?",
    alternates: "vendem remédio\nvendem suplemento\nonde compro o medicamento",
    answer: "Não vendemos medicamentos. O Dr. Saulo Silva prescreve o que há de melhor no mercado ou em farmácias de manipulação de alta confiança.",
  },
] as const;

const TEMPLATES = [
  {
    name: "Boas-vindas",
    body:
      "Olá, {primeiro_nome}! Seja muito bem-vindo(a) à Clínica Dr. Saulo Silva 😊\nSerá um prazer te ajudar. Para começar, qual é o seu principal objetivo neste momento: emagrecimento, performance, reposição hormonal ou outro?",
    whenToUse: "Primeira mensagem de um novo paciente ou quando a pessoa envia apenas uma saudação.",
    mode: "adapt",
  },
  {
    name: "Pedido de valor da consulta",
    body:
      "Será um prazer te ajudar. 😊\n\nAntes de te passar todas as informações, gostaria apenas de entender um pouquinho melhor o que está te trazendo até o Dr. Saulo hoje.\n\nQual é o seu principal objetivo neste momento?",
    whenToUse: "Paciente pergunta o valor da consulta antes de contar qual é o objetivo dele.",
    mode: "exact",
  },
  {
    name: "Apresentação da consulta - presencial",
    body:
      "Excelente escolha. 😊\n\nA consulta presencial proporciona uma avaliação ainda mais completa da sua composição corporal e do seu momento atual.\n\nO atendimento inclui:\n✔️ Consulta médica com duração aproximada de 1h30;\n✔️ Avaliação clínica detalhada;\n✔️ Exame físico;\n✔️ Bioimpedância;\n✔️ Análise completa da composição corporal;\n✔️ Planejamento individualizado;\n✔️ Direcionamento nutricional e de atividade física;\n✔️ Acompanhamento por 30 dias após a consulta.\n\nO investimento é de R$ 750,00.\n\nPosso verificar os horários disponíveis para você?",
    whenToUse: "Paciente já demonstrou interesse em entender a consulta e escolheu (ou está inclinado a) atendimento presencial.",
    mode: "exact",
  },
  {
    name: "Apresentação da consulta - online",
    body:
      "Excelente. 😊\n\nO atendimento online oferece toda a praticidade de ser realizado de onde você estiver, mantendo o mesmo cuidado, atenção e personalização do Dr. Saulo Silva.\n\nO atendimento inclui:\n✔️ Consulta médica com duração aproximada de 1h30;\n✔️ Avaliação clínica detalhada;\n✔️ Planejamento individualizado;\n✔️ Direcionamento nutricional e de atividade física;\n✔️ Acompanhamento por 30 dias após a consulta.\n\nO investimento é de R$ 750,00.\n\nPosso verificar os horários disponíveis para você?",
    whenToUse: "Paciente já demonstrou interesse em entender a consulta e escolheu (ou está inclinado a) atendimento online.",
    mode: "exact",
  },
  {
    name: "Solicitação do sinal",
    body:
      "Perfeito. 😊\n\nSeu pré-cadastro foi realizado com sucesso.\n\nPara garantirmos o horário reservado, trabalhamos com uma confirmação antecipada de 30% do valor da consulta: R$ 225,00.\n\nO saldo restante (R$ 525,00) é pago somente no dia da consulta.\n\nQual a forma de pagamento que você prefere: Pix, cartão de crédito ou débito?",
    whenToUse: "Depois que o paciente escolheu o horário e preencheu o cadastro, antes de confirmar o agendamento.",
    mode: "exact",
  },
  {
    name: "Confirmação de horário",
    body:
      "Olá, {primeiro_nome}. 😊\n\nSeja muito bem-vindo(a) à Clínica Dr. Saulo Silva.\n\n✅ Sua consulta está confirmada.\n📅 Data: {data_hora}\n\n📍 Endereço:\nRua Itatuba, 201 - Edifício Cosmopolitan Mix, sala 1701\nParque Bela Vista, Salvador/BA\n\n⚠️ Pedimos que chegue com cerca de 10 minutos de antecedência para o cadastro e, se for presencial, a avaliação de bioimpedância (sugerimos roupas leves ou de treino).\n\n✅ O sinal de R$ 225,00 já foi recebido.\n\nQualquer dúvida antes do atendimento, estamos à disposição. Até breve! 💛",
    whenToUse: "Somente depois que o comprovante do sinal foi recebido e o horário foi confirmado na agenda.",
    mode: "adapt",
  },
  {
    name: "Não entendi a mensagem",
    body:
      "Peço desculpas, mas não consegui processar sua solicitação com a precisão necessária no momento. Poderia, por gentileza, reformular sua dúvida para que eu possa atendê-lo(a) adequadamente?",
    whenToUse: "Quando a mensagem do paciente não pôde ser compreendida com segurança.",
    mode: "exact",
  },
  {
    name: "Encerramento com satisfação",
    body: "É um privilégio auxiliá-lo(a). Sua solicitação foi processada com êxito. Há algo mais que eu possa fazer por você neste momento?",
    whenToUse: "Antes de encerrar o atendimento, para confirmar se não há mais dúvidas.",
    mode: "exact",
  },
  {
    name: "Despedida",
    body:
      "Compreendo perfeitamente. Caso deseje retomar nossa conversa ou precise de assistência adicional futuramente, estarei à sua inteira disposição. Tenha um ótimo dia.",
    whenToUse: "Quando o paciente encerra a conversa de forma clara e cordial, sem mais dúvidas.",
    mode: "exact",
  },
] as const;

const RULES = [
  { category: "tom_de_voz", instruction: "Fale de forma formal, cerimoniosa e elegante. Trate o paciente por \"Senhor\" ou \"Senhora\", a menos que ele peça informalidade. Evite gírias, diminutivos ou intimidades excessivas." },
  { category: "tom_de_voz", instruction: "Use vocabulário premium: \"Experiência Clínica\" ou \"Avaliação Integral\" em vez de \"consulta\"; \"investimento na saúde\" em vez de \"preço/valor\"; \"protocolo de performance\" em vez de \"tratamento\"; \"reservar um horário exclusivo\" em vez de \"marcar/agendar\"." },
  { category: "tom_de_voz", instruction: "Nunca envie parágrafos longos: no máximo 3 a 4 linhas por mensagem. Faça apenas uma pergunta por vez para não sobrecarregar o paciente." },
  { category: "tom_de_voz", instruction: "Equilibre autoridade científica (precisão, clareza, evidências sobre o trabalho do Dr. Saulo Silva) com postura de concierge: antecipe necessidades, seja extremamente educada e discreta, e foque no bem-estar do paciente." },
  { category: "tom_de_voz", instruction: "Nunca seja seca, direta demais ou robótica. Cada resposta deve demonstrar interesse genuíno pela história do paciente antes de avançar para a próxima etapa - respostas curtas que só entregam informação, sem nenhuma pergunta de aprofundamento, quebram a conversão e soam frias para o padrão premium da clínica." },
  { category: "agendamento", instruction: "O horário oficial da clínica é de segunda a sexta-feira, das 8h30 às 17h30, sem atendimento aos sábados. O campo de expediente do sistema só aceita hora cheia, então está configurado como 9h às 17h; considere isso como uma aproximação seca ao oferecer horários." },
  { category: "agendamento", instruction: "Antes de detalhar a consulta, pergunte se o paciente prefere atendimento presencial ou online - o conteúdo e os itens incluídos mudam entre as duas modalidades." },
  { category: "agendamento", instruction: "Cancelamento ou remarcação exigem aviso com pelo menos 24 horas de antecedência." },
  { category: "agendamento", instruction: "A consulta (Experiência Clínica) dura aproximadamente 1h30, presencial ou online." },
  { category: "pagamento", instruction: "ANCORAGEM DE VALOR (regra dura, nunca pule): antes de falar qualquer investimento (preço), faça NO MÍNIMO 3 perguntas de verdade para entender a dor do paciente (ex: o que mais incomoda hoje, há quanto tempo tenta resolver isso, o que já tentou antes, qual seria o objetivo ideal, o que mais dificulta o resultado) e só depois explique brevemente como o Dr. Saulo Silva costuma ajudar casos parecidos, gerando desejo pela transformação. Nunca responda uma pergunta de preço só com o valor - isso soa seco e não converte." },
  { category: "pagamento", instruction: "O investimento na Experiência Clínica, presencial ou online, é de R$ 750,00. Formas de pagamento aceitas: dinheiro, Pix, cartão de débito e cartão de crédito, em até 3x sem juros ou até 12x com acréscimo da operadora da máquina." },
  { category: "pagamento", instruction: "Não ofereça desconto à vista nem negocie valores: os investimentos são tabelados para manter a equidade entre os pacientes. Se pedirem desconto ou negociação, transfira para a equipe." },
  { category: "pagamento", instruction: "Para confirmar o horário é necessário o sinal de 30% do valor da consulta (R$ 225,00 sobre R$ 750,00); o saldo (R$ 525,00) é pago no dia. Só use book_appointment depois do comprovante do sinal na conversa." },
  { category: "procedimentos", instruction: "Nunca diagnostique, prescreva medicamento, oriente ajuste de dose ou garanta resultado. Fale sempre em possibilidades e protocolos individualizados, condicionados à avaliação com o Dr. Saulo Silva." },
  { category: "procedimentos", instruction: "Ao contornar objeções sobre preço, tempo, método, decisão ou resultado, use um tom sofisticado e acolhedor, nunca depreciando outros profissionais ou minimizando a preocupação do paciente." },
  { category: "chamar_equipe", instruction: "Transfira imediatamente quando o paciente: pedir para falar com o Dr. Saulo ou com um atendente humano; demonstrar irritação, insatisfação ou reclamação; enviar exame, laudo, receita ou foto corporal para avaliação; pedir diagnóstico, prescrição ou ajuste de dose de medicamento; relatar sintoma grave ou urgência; pedir desconto ou negociação de valores; ou perguntar algo fora do escopo de emagrecimento, performance, hormônios, lipedema ou dos serviços da clínica." },
  { category: "chamar_equipe", instruction: "Transfira também ao detectar palavras como: exame, laudo, receita, ultrassom, ressonância, \"posso tomar\", \"ajustar dose\", \"aumentar dose\", \"diminuir dose\", emergência, \"dor forte\", \"efeito colateral\"." },
  { category: "chamar_equipe", instruction: "Antes de transferir, escreva exatamente: \"Vou encaminhar sua solicitação para nossa equipe para que possamos oferecer o suporte mais adequado. Em instantes você será atendido(a).\"" },
  { category: "encerramento", instruction: "Antes de encerrar o atendimento, pergunte se existe mais alguma dúvida sobre a consulta, os protocolos ou o acompanhamento." },
  { category: "encerramento", instruction: "Considere o atendimento concluído quando o paciente disser que não tem mais dúvidas, agradecer (\"obrigado\", \"era só isso\", \"entendi\", \"perfeito\", \"ok\", \"beleza\" ou semelhante), concluir o agendamento, receber todas as informações pedidas, ou encerrar a conversa de forma clara e cordial." },
] as const;

const PLAYBOOKS = [
  {
    name: "Primeiro atendimento consultivo",
    scriptType: "primeiro_atendimento",
    triggerText: "Primeiro contato, saudação sem contexto ou paciente que ainda não contou o que busca.",
    goal: "Acolher com elegância, entender a dor do paciente e conduzir para a consulta sem pressão comercial precoce.",
    steps: [
      "Cumprimente o paciente de forma breve, elegante e acolhedora.",
      "Pergunte qual é o principal objetivo dele hoje (emagrecimento, performance, reposição hormonal, saúde metabólica, longevidade, etc.).",
      "Faça NO MÍNIMO 3 perguntas para aprofundar a dor, uma de cada vez, antes de falar em consulta ou valor. Exemplos: o que mais incomoda você hoje, há quanto tempo tenta resolver isso, qual seria o objetivo ideal, o que já tentou anteriormente, o que sente que mais dificulta seus resultados.",
      "Demonstre entendimento genuíno da situação antes de seguir adiante - nunca pule direto pra informação sem antes comentar algo sobre o que o paciente contou.",
      "Explique brevemente como o Dr. Saulo Silva costuma ajudar pacientes com essa mesma queixa, gerando desejo pela transformação, sem citar valores ainda.",
      "Pergunte se o paciente prefere atendimento presencial ou online.",
      "Apresente os detalhes da consulta (o que inclui) e só então o investimento de R$ 750,00.",
      "Convide para verificar horários disponíveis e conduza para o agendamento.",
    ],
  },
  {
    name: "Pedido de valor da consulta",
    scriptType: "preco",
    triggerText: "Paciente pergunta preço, valor ou investimento da consulta logo de início, sem ter contado o objetivo.",
    goal: "Nunca ancorar em preço antes de demonstrar valor; qualificar e conduzir para a apresentação da consulta.",
    steps: [
      "Não informe valor. Responda com acolhimento e pergunte qual é o principal objetivo do paciente.",
      "Faça NO MÍNIMO mais 2 perguntas de aprofundamento (totalizando pelo menos 3 com a do objetivo) antes de falar em consulta ou valor: há quanto tempo tenta resolver isso, o que já tentou antes, o que mais incomoda, qual seria o resultado ideal.",
      "Conforme as respostas (emagrecimento, menopausa/transição hormonal, performance, etc.), explique brevemente como o Dr. Saulo Silva trabalha esse tipo de caso, com uma avaliação completa e individualizada - gere desejo pela transformação antes de qualquer número.",
      "Pergunte se pode explicar como funciona a consulta.",
      "Pergunte se o paciente prefere presencial ou online antes de detalhar o conteúdo e o valor.",
      "Use as mensagens prontas de apresentação da consulta (presencial ou online) para informar o que está incluso e o investimento de R$ 750,00.",
      "Se houver interesse real, ofereça verificar os horários disponíveis.",
    ],
  },
  {
    name: "Agendamento com sinal",
    scriptType: "agendamento",
    triggerText: "Paciente quer marcar a consulta e já sabe presencial ou online.",
    goal: "Agendar corretamente e confirmar apenas após o sinal, coletando o cadastro completo.",
    steps: [
      "Ofereça no máximo duas opções reais de horário.",
      "Após a escolha, informe que é a primeira consulta e colete o cadastro: nome completo, data de nascimento, CPF, altura, telefone com DDD, e-mail, profissão, estado civil, filhos (se sim, quantos), endereço completo com CEP e como conheceu o Dr. Saulo Silva.",
      "Depois do cadastro, explique o sinal de 30% (R$ 225,00) para reservar o horário e o saldo de R$ 525,00 no dia da consulta.",
      "Pergunte a forma de pagamento (Pix, débito ou crédito) e envie a chave Pix ou gere o link de pagamento conforme a escolha.",
      "Ao receber o comprovante, confirme o recebimento e avise que a reserva está sendo confirmada no sistema.",
      "Envie a mensagem de confirmação final com data, horário, endereço novo e orientação de chegar com 10 minutos de antecedência.",
    ],
  },
  {
    name: "Contorno de objeções premium",
    scriptType: "objecao",
    triggerText: "Paciente questiona preço, tempo/logística, o método, a decisão de fechar agora ou os resultados esperados.",
    goal: "Contornar a resistência com sofisticação, sem descontos nem promessas, reforçando a exclusividade do acompanhamento.",
    steps: [
      "Objeção de investimento (\"achei caro\", \"outro cobra menos\", \"tem desconto\"): reforce que o valor reflete a precisão dos protocolos e o acompanhamento individualizado do Dr. Saulo Silva, sem oferecer desconto.",
      "Objeção de tempo/logística (\"não tenho tempo\", \"moro em outra cidade\", \"a agenda está longe\"): ofereça a modalidade online e reforce a exclusividade dos horários limitados.",
      "Objeção sobre o método (\"tenho medo de hormônio\", \"já tentei de tudo\"): explique que o protocolo é baseado em exames e feito sob medida para o perfil do paciente, sem generalizar promessas.",
      "Objeção de decisão (\"vou pensar\", \"vou falar com meu marido/esposa\", \"só mês que vem\"): acolha sem pressionar, ofereça enviar um resumo dos benefícios e mencione que as vagas para novos protocolos são limitadas mensalmente.",
      "Objeção sobre resultados (\"e se eu não emagrecer\", \"vou ter efeito colateral\"): explique que o protocolo é individualizado e monitorado, sem prometer resultado garantido.",
      "Se a objeção não for coberta com segurança pela base de conhecimento, transfira para a equipe em vez de inventar uma resposta.",
    ],
  },
  {
    name: "Intercorrência e urgência",
    scriptType: "urgencia",
    triggerText: "Paciente relata sintoma grave, dor, efeito colateral, ou envia exame/laudo/receita pedindo diagnóstico ou ajuste de medicação.",
    goal: "Priorizar a segurança do paciente e acionar a equipe humana rapidamente, sem opinar clinicamente.",
    steps: [
      "Acolha o relato sem minimizar, sem diagnosticar e sem opinar sobre exame, laudo ou receita.",
      "Não prescreva, não ajuste dose e não dê orientação clínica nova por conta própria.",
      "Escreva a frase de transferência configurada e acione transfer_to_human com um resumo do que o paciente relatou.",
      "Pare de responder após a transferência.",
    ],
  },
] as const;

const REMINDERS = [
  { hoursBefore: 24, message: "Olá, {primeiro_nome}! Passando para confirmar sua Experiência Clínica com o Dr. Saulo Silva amanhã, {data_hora}. Podemos contar com sua presença?" },
  { hoursBefore: 4, message: "Olá, {primeiro_nome}! Sua Experiência Clínica com o Dr. Saulo Silva é hoje, {data_hora}. Estamos te esperando no horário combinado." },
] as const;

const FOLLOWUPS = [
  {
    order: 1,
    name: "Recontato Dr. Saulo - 2 dias",
    afterDays: 2,
    message:
      "Olá, {primeiro_nome}! 😊 Percebi que nossa conversa ficou pausada. Muitas pessoas chegam até nós após meses ou anos tentando resolver sozinhas questões de peso, hormônios, disposição ou composição corporal. Se ainda fizer sentido para você, estou à disposição para retomar.",
  },
  {
    order: 2,
    name: "Recontato Dr. Saulo - 5 dias",
    afterDays: 5,
    message: "Olá, {primeiro_nome}! Só passando para deixar o canal aberto. Quando fizer sentido retomar seus objetivos de saúde com o Dr. Saulo Silva, estamos por aqui.",
  },
] as const;

const BIRTHDAY = {
  name: "Aniversário do paciente",
  message: "Feliz aniversário, {primeiro_nome}! O Dr. Saulo Silva e toda a equipe da Clínica desejam a você um ano repleto de saúde, performance e longevidade. 🎂",
  sendHour: 9,
};

export interface SeedDrSauloResult {
  clinicId: string;
  login: string;
  created: boolean;
  password: string | null; // senha inicial - so quando a conta de acesso foi criada agora
  counts: Record<string, number>;
  pending: string[];
}

export async function seedDrSaulo(): Promise<SeedDrSauloResult> {
  const existingClinic =
    (await prisma.clinic.findUnique({ where: { whatsappPhone: WA } })) ??
    (await prisma.clinic.findFirst({ where: { name: CLINIC_NAME } }));
  const created = !existingClinic;

  // Campos que o seed controla a partir do briefing. active e plan ficam de
  // fora do update: sao definidos no painel adm e re-rodar o seed nao deve
  // reverte-los (so os define ao criar a conta).
  const config = {
    name: CLINIC_NAME,
    timezone: "America/Sao_Paulo",
    workStartHour: 9,
    workEndHour: 17,
    workDays: "1,2,3,4,5",
    notifyPhone: WA,
    notifyEvents: "new_appointment,reschedule,cancel,confirmed,human_handoff",
    assistantPersona: "professional_secretary",
    assistantPersonaName: "Dr. Saulo Silva",
    assistantName: "Alice",
    activityArea: "medicina de precisão, emagrecimento, performance, reposição hormonal e longevidade",
    handoffPhrase: HANDOFF_PHRASE,
    requireDepositProof: true,
    businessType: "clinica",
    servicePosture: "comercial",
    clinicKind: "medica",
    evaluationFirst: true,
    allowEmojis: true,
    schedulingLink: null,
    replyDelaySeconds: 10,
  };

  const clinic = existingClinic
    ? await prisma.clinic.update({ where: { id: existingClinic.id }, data: { ...config, whatsappPhone: WA } })
    : await prisma.clinic.create({ data: { ...config, whatsappPhone: WA, active: true, plan: "prime" } });

  const existingStaff = await prisma.staffUser.findUnique({ where: { username: LOGIN } });
  if (INITIAL_PASSWORD.length < 10) {
    throw new Error("A senha inicial da Clínica Dr. Saulo precisa ter pelo menos 10 caracteres.");
  }
  if (existingStaff) {
    // Nao mexe na senha: pode ter sido trocada pelo cliente.
    await prisma.staffUser.update({
      where: { username: LOGIN },
      data: { name: CLINIC_NAME, role: "client", clinicId: clinic.id },
    });
  } else {
    await prisma.staffUser.create({
      data: {
        name: CLINIC_NAME,
        username: LOGIN,
        passwordHash: hashPassword(INITIAL_PASSWORD),
        role: "client",
        clinicId: clinic.id,
      },
    });
  }

  const procedureIds = new Map<string, string>();
  for (const item of PROCEDURES) {
    const current = await prisma.procedure.findFirst({ where: { clinicId: clinic.id, name: item.name } });
    const data = {
      durationMin: item.durationMin,
      description: item.description,
      price: item.price,
      priceVariable: item.price === null,
      offerInstallments: true,
      maxInstallments: 12,
      paymentMethods: "dinheiro,pix,credito,debito",
      paymentLink: null,
      goals: item.goals,
      benefits: item.benefits,
      aliases: item.aliases,
      resultTimeline: item.resultTimeline,
    };
    const procedure = current
      ? await prisma.procedure.update({ where: { id: current.id }, data })
      : await prisma.procedure.create({ data: { clinicId: clinic.id, name: item.name, ...data } });
    procedureIds.set(item.name, procedure.id);
  }

  const professional = await prisma.professional.findFirst({ where: { clinicId: clinic.id, name: "Dr. Saulo Silva" } });
  const professionalData = {
    bio: "Médico especialista em medicina de precisão, emagrecimento, performance e longevidade.",
    instagram: null,
    active: true,
    workDays: null,
    workStartHour: null,
    workEndHour: null,
    procedures: { set: [...procedureIds.values()].map((id) => ({ id })) },
  };
  if (professional) await prisma.professional.update({ where: { id: professional.id }, data: professionalData });
  else await prisma.professional.create({
    data: {
      clinic: { connect: { id: clinic.id } },
      name: "Dr. Saulo Silva",
      bio: professionalData.bio,
      active: true,
      procedures: { connect: [...procedureIds.values()].map((id) => ({ id })) },
    },
  });

  for (const faq of FAQS) {
    const current = await prisma.clinicFaq.findFirst({ where: { clinicId: clinic.id, question: faq.question } });
    const data = { answer: faq.answer, alternates: faq.alternates, exactAnswer: false, active: true };
    if (current) await prisma.clinicFaq.update({ where: { id: current.id }, data });
    else await prisma.clinicFaq.create({ data: { clinicId: clinic.id, question: faq.question, ...data } });
  }

  for (const template of TEMPLATES) {
    const current = await prisma.messageTemplate.findFirst({ where: { clinicId: clinic.id, name: template.name } });
    const data = { body: template.body, mode: template.mode, whenToUse: template.whenToUse, active: true };
    if (current) await prisma.messageTemplate.update({ where: { id: current.id }, data });
    else await prisma.messageTemplate.create({ data: { clinicId: clinic.id, name: template.name, ...data } });
  }

  await seedDefaultRules(clinic.id);
  await prisma.customRule.deleteMany({ where: { clinicId: clinic.id, rawInput: SEED_MARKER } });
  await prisma.customRule.createMany({
    data: RULES.map((rule) => ({ clinicId: clinic.id, category: rule.category, rawInput: SEED_MARKER, instruction: rule.instruction, status: "active" })),
  });

  for (const playbook of PLAYBOOKS) {
    const current = await prisma.playbook.findFirst({ where: { clinicId: clinic.id, name: playbook.name } });
    const data = {
      scriptType: playbook.scriptType,
      triggerText: playbook.triggerText,
      goal: playbook.goal,
      steps: playbook.steps.join("\n"),
      active: true,
    };
    if (current) await prisma.playbook.update({ where: { id: current.id }, data });
    else await prisma.playbook.create({ data: { clinicId: clinic.id, name: playbook.name, ...data } });
  }

  for (const reminder of REMINDERS) {
    const current = await prisma.reminderRule.findFirst({ where: { clinicId: clinic.id, hoursBefore: reminder.hoursBefore } });
    const data = { message: reminder.message, active: true };
    if (current) await prisma.reminderRule.update({ where: { id: current.id }, data });
    else await prisma.reminderRule.create({ data: { clinicId: clinic.id, hoursBefore: reminder.hoursBefore, ...data } });
  }

  for (const followup of FOLLOWUPS) {
    // (clinicId, order) e unico: se ja existe uma regra ocupando o slot, o seed
    // assume esse slot em vez de estourar a constraint ao criar.
    const current =
      (await prisma.followUpRule.findFirst({ where: { clinicId: clinic.id, name: followup.name } })) ??
      (await prisma.followUpRule.findFirst({ where: { clinicId: clinic.id, order: followup.order } }));
    const data = {
      name: followup.name,
      order: followup.order,
      afterDays: followup.afterDays,
      afterMinutes: 0,
      message: followup.message,
      repeatMode: "once",
      skipIfHumanTakeover: true,
      skipIfUpcomingAppt: true,
      sendWindowStart: 9,
      sendWindowEnd: 17,
      active: true,
    };
    if (current) await prisma.followUpRule.update({ where: { id: current.id }, data });
    else await prisma.followUpRule.create({ data: { clinicId: clinic.id, ...data } });
  }

  const allProcedureIds = [...procedureIds.values()].join(",");
  const RENEWALS = [
    {
      name: "Renovação trimestral - 90 dias",
      message:
        "Olá, {primeiro_nome}. Estamos nos aproximando da conclusão do seu primeiro ciclo de 90 dias. O Dr. Saulo Silva gostaria de avaliar sua evolução para ajustarmos o protocolo para o próximo nível de performance. Podemos reservar seu horário de retorno?",
      intervalValue: 90,
      intervalUnit: "days",
    },
    {
      name: "Recuperação de paciente inativo - 6 meses",
      message:
        "Olá, {primeiro_nome}. Sentimos sua ausência na Clínica Dr. Saulo Silva. Prezamos muito pela continuidade da sua saúde e longevidade. Gostaria de agendar uma breve conversa para retomarmos seus objetivos?",
      intervalValue: 6,
      intervalUnit: "months",
    },
  ] as const;
  for (const renewal of RENEWALS) {
    const current = await prisma.renewalRule.findFirst({ where: { clinicId: clinic.id, name: renewal.name } });
    const data = {
      message: renewal.message,
      intervalValue: renewal.intervalValue,
      intervalUnit: renewal.intervalUnit,
      onlyIfCompleted: true,
      procedureIds: allProcedureIds,
      active: true,
    };
    if (current) await prisma.renewalRule.update({ where: { id: current.id }, data });
    else await prisma.renewalRule.create({ data: { clinicId: clinic.id, name: renewal.name, ...data } });
  }

  const birthday = await prisma.birthdayRule.findFirst({ where: { clinicId: clinic.id, name: BIRTHDAY.name } });
  const birthdayData = { message: BIRTHDAY.message, sendHour: BIRTHDAY.sendHour, active: true };
  if (birthday) await prisma.birthdayRule.update({ where: { id: birthday.id }, data: birthdayData });
  else await prisma.birthdayRule.create({ data: { clinicId: clinic.id, name: BIRTHDAY.name, ...birthdayData } });

  await getFunnelStages(clinic.id);

  const [procedureCount, professionalCount, faqCount, templateCount, ruleCount, playbookCount, reminderCount, followupCount, renewalCount, birthdayCount] = await Promise.all([
    prisma.procedure.count({ where: { clinicId: clinic.id } }),
    prisma.professional.count({ where: { clinicId: clinic.id } }),
    prisma.clinicFaq.count({ where: { clinicId: clinic.id } }),
    prisma.messageTemplate.count({ where: { clinicId: clinic.id } }),
    prisma.customRule.count({ where: { clinicId: clinic.id, status: "active" } }),
    prisma.playbook.count({ where: { clinicId: clinic.id, active: true } }),
    prisma.reminderRule.count({ where: { clinicId: clinic.id, active: true } }),
    prisma.followUpRule.count({ where: { clinicId: clinic.id, active: true } }),
    prisma.renewalRule.count({ where: { clinicId: clinic.id, active: true } }),
    prisma.birthdayRule.count({ where: { clinicId: clinic.id, active: true } }),
  ]);

  return {
    clinicId: clinic.id,
    login: LOGIN,
    created,
    password: created ? INITIAL_PASSWORD : null,
    counts: {
      procedures: procedureCount,
      professionals: professionalCount,
      faqs: faqCount,
      templates: templateCount,
      activeRules: ruleCount,
      playbooks: playbookCount,
      reminders: reminderCount,
      followups: followupCount,
      renewals: renewalCount,
      birthdays: birthdayCount,
    },
    pending: [
      "número de WhatsApp real da clínica (está com um placeholder; assim que tiver, defina DR_SAULO_WHATSAPP e rode o seed de novo, ou edite direto no painel)",
      "valor da Aplicação e da Reavaliação (cadastradas com duração certa - 15min e 30min - mas sem preço; a Alice vai dizer que confirma com a equipe até chegar o valor)",
      "script antigo de atendimento que o Dr. Saulo disse que ia mandar (respostas que convertiam melhor) - quando chegar, revisar playbooks/regras de qualificação com esse material",
      "política de cancelamento/reembolso do sinal em caso de desistência (o manual não especifica se o valor é devolvido)",
      "estacionamento ou manobrista no endereço novo",
      "preparo para exames (jejum etc.)",
      "bio completa do Dr. Saulo Silva (formação, CRM, especialidades) e Instagram",
      "suporte a início de expediente às 08:30 e fim às 17:30 (o campo atual aceita apenas hora cheia; foi usado 9h–17h)",
      "confirmação do login/senha de acesso do cliente (usado drsaulo@aliceconversa.com por padrão)",
    ],
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  seedDrSaulo()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
