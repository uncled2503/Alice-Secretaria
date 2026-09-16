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
    question: "Quais protocolos o Dr. Saulo Silva oferece?",
    alternates: "métodos silva\nprotocolo\nquais tratamentos\nprotocolo de emagrecimento\nprotocolo hormonal\nprotocolo de performance\nprotocolo de sono\nprotocolo de hipertrofia",
    answer:
      "O Dr. Saulo Silva trabalha com protocolos individualizados dentro de seis frentes: Silva Metabolic Reset & Sculpt (emagrecimento com preservação da massa magra), Silva Hormonal Prime & Longevity (transição hormonal feminina/menopausa), Silva Vitality & Testosterone Optimization (andropausa e testosterona), Silva Elite Performance & Biohacking (performance física e mental), Silva Hypertrophy & Muscle Architecture (ganho de massa muscular) e Silva Deep Sleep & Neuro-Recovery (qualidade do sono). O protocolo exato é definido na Experiência Clínica, conforme o objetivo do paciente.",
  },
  {
    question: "Quais são as formas de pagamento?",
    alternates: "pagamento\npix\ncartão\ndinheiro\ndébito\nparcela\nparcelamento",
    answer:
      "O sinal de R$ 225,00, que reserva o horário, é somente por Pix (chave CNPJ 52.716.955/0001-43). O saldo de R$ 525,00, pago no dia da consulta, aceita dinheiro, Pix, cartão de débito e cartão de crédito - no crédito, até 3x sem juros ou até 12x com o acréscimo cobrado pela operadora da máquina.",
  },
  {
    question: "É necessário pagar sinal para confirmar o horário?",
    alternates: "sinal\nentrada\ntaxa de agendamento\nconfirmar horário\ncomprovante\nchave pix\ncnpj",
    answer:
      "Sim. Para reservar o horário, pedimos um sinal de 30% do valor da consulta (R$ 225,00), somente por Pix na chave CNPJ 52.716.955/0001-43. Depois é só enviar o comprovante por aqui. O saldo restante (R$ 525,00) é pago no dia da consulta, na forma que o paciente preferir.",
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
    name: "Apresentação da consulta",
    body:
      "Na consulta com o Dr. Saulo Silva, você terá um acompanhamento completo para alcançar seu emagrecimento com saúde e segurança 😊\n\nO atendimento pode ser realizado on-line ou presencial, com toda a praticidade e o mesmo cuidado em ambas as modalidades.\n\nO atendimento inclui:\n\n✔️ Consulta com duração aproximada de 1h30;\n✔️ No mínimo 2 avaliações de bioimpedância;\n✔️ Análise corporal detalhada;\n✔️ Exame físico;\n✔️ Orientações nutricionais e de exercícios;\n✔️ Acompanhamento por 30 dias;\n✔️ Plano individualizado, totalmente personalizado para suas necessidades.\n\nO valor do investimento é R$ 750,00.\n\n✨ Vai ser um prazer te acompanhar nesse processo!\nVocê prefere atendimento on-line ou presencial? Já posso verificar os melhores horários pra você e garantir sua vaga 😊",
    whenToUse:
      "Depois de entender a dor do paciente, para apresentar o que a consulta inclui e o investimento. É esta mensagem que pergunta se ele prefere on-line ou presencial.",
    mode: "exact",
  },
  {
    name: "Ajuste do que inclui - online",
    body:
      "Perfeito, então fica on-line 😊\n\nÉ a mesma consulta de 1h30 com o Dr. Saulo Silva, com avaliação clínica detalhada, plano individualizado, orientações nutricionais e de exercícios e acompanhamento por 30 dias.\n\nA bioimpedância e o exame físico são os únicos itens que só acontecem no presencial, por precisarem do equipamento aqui na clínica.",
    whenToUse:
      "Somente quando o paciente escolher on-line, logo depois da apresentação da consulta - para ele não ficar esperando bioimpedância e exame físico, que só existem no presencial.",
    mode: "exact",
  },
  {
    name: "Solicitação do sinal",
    body:
      "Perfeito. 😊\n\nSeu pré-cadastro foi realizado com sucesso.\n\nPara garantirmos o horário reservado, trabalhamos com uma confirmação antecipada de 30% do valor da consulta: R$ 225,00.\n\nA reserva é feita somente por Pix, na chave CNPJ *52.716.955/0001-43*.\n\nAssim que fizer, me envie o comprovante por aqui que eu confirmo seu horário. O saldo restante (R$ 525,00) é pago no dia da consulta, aí sim na forma que você preferir.",
    whenToUse: "Depois que o paciente escolheu o horário e preencheu o cadastro, antes de confirmar o agendamento.",
    mode: "exact",
  },
  {
    name: "Confirmação de horário",
    body:
      "Olá, {primeiro_nome}, tudo bem? 😊\n\nSeja muito bem-vindo(a) ao consultório do Dr. Saulo Silva!\n\nEstamos felizes em ter você conosco e ansiosos para ajudar você a alcançar seus objetivos de emagrecimento e performance.\n\n🗒️ Confirmamos sua consulta para {data_hora}.\n\n📍 Nosso endereço:\n\nRua Itatuba, nº 201\nEd. Cosmopolitan Mix – Sala 1701\nParque Bela Vista – Salvador/BA\n(Em frente ao Shopping da Bahia)\n\n⚠️ Por favor, chegue com 10 minutos de antecedência para conclusão do cadastro e realização da bioimpedância (sugerimos trajar ou trazer roupa leve de treino).\n\nEstamos à disposição para qualquer necessidade.\nAté breve! 👋👋👋",
    whenToUse:
      "Consulta PRESENCIAL, somente depois que o comprovante do sinal foi recebido e o book_appointment confirmou o horário na agenda. Escreva a data no formato \"Quarta-feira, 16/09/26, às 14:00hrs\".",
    mode: "exact",
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

// Mensagens que este seed ja criou no passado e que foram substituidas. O seed
// so cria/atualiza por nome, entao sem desativar aqui elas continuariam no
// prompt da Alice junto com as novas - duas versoes da mesma coisa se
// contradizendo. Desativa em vez de apagar, pra nao sumir do historico.
const RETIRED_TEMPLATES = [
  "Apresentação da consulta - presencial", // virou "Apresentação da consulta" (formato da Andreza)
  "Apresentação da consulta - online", // virou "Ajuste do que inclui - online"
] as const;

const RULES = [
  { category: "tom_de_voz", instruction: "Fale de forma formal, cerimoniosa e elegante. Trate o paciente por \"Senhor\" ou \"Senhora\", a menos que ele peça informalidade. Evite gírias, diminutivos ou intimidades excessivas." },
  { category: "tom_de_voz", instruction: "Use vocabulário premium: \"Experiência Clínica\" ou \"Avaliação Integral\" em vez de \"consulta\"; \"investimento na saúde\" em vez de \"preço/valor\"; \"protocolo de performance\" em vez de \"tratamento\"; \"reservar um horário exclusivo\" em vez de \"marcar/agendar\"." },
  { category: "tom_de_voz", instruction: "Nunca envie parágrafos longos: no máximo 3 a 4 linhas por mensagem. Faça apenas uma pergunta por vez para não sobrecarregar o paciente." },
  { category: "tom_de_voz", instruction: "Equilibre autoridade científica (precisão, clareza, evidências sobre o trabalho do Dr. Saulo Silva) com postura de concierge: antecipe necessidades, seja extremamente educada e discreta, e foque no bem-estar do paciente." },
  { category: "tom_de_voz", instruction: "Nunca seja seca, direta demais ou robótica. Cada resposta deve demonstrar interesse genuíno pela história do paciente antes de avançar para a próxima etapa - respostas curtas que só entregam informação, sem nenhuma pergunta de aprofundamento, quebram a conversão e soam frias para o padrão premium da clínica." },
  { category: "tom_de_voz", instruction: "Valide a emoção do paciente antes de seguir adiante, com frases genuínas e variadas (ex: \"é muito comum se sentir frustrado(a) depois de tantas tentativas\", \"faz todo sentido isso incomodar você\") - nunca repita sempre a mesma fórmula de validação." },
  { category: "tom_de_voz", instruction: "Antes de explicar um protocolo em detalhes, peça uma pequena permissão (ex: \"posso te explicar como funciona esse protocolo?\") em vez de já despejar a explicação inteira - isso faz o paciente convidar a informação em vez de recebê-la de forma empurrada." },
  { category: "tom_de_voz", instruction: "Pode usar *negrito* (asterisco, formatação do WhatsApp) com moderação pra destacar o valor do investimento ou o nome de um protocolo Silva, sem exagerar no restante da mensagem." },
  { category: "agendamento", instruction: "O horário oficial da clínica é de segunda a sexta-feira, das 8h30 às 17h30, sem atendimento aos sábados. O campo de expediente do sistema só aceita hora cheia, então está configurado como 9h às 17h; considere isso como uma aproximação seca ao oferecer horários." },
  { category: "agendamento", instruction: "Antes de detalhar a consulta, pergunte se o paciente prefere atendimento presencial ou online - o conteúdo e os itens incluídos mudam entre as duas modalidades." },
  { category: "agendamento", instruction: "Cancelamento ou remarcação exigem aviso com pelo menos 24 horas de antecedência." },
  { category: "agendamento", instruction: "A consulta (Experiência Clínica) dura aproximadamente 1h30, presencial ou online." },
  { category: "pagamento", instruction: "ANCORAGEM DE VALOR (regra dura, nunca pule): antes de falar qualquer investimento (preço), faça NO MÍNIMO 3 perguntas de verdade para entender a dor do paciente (ex: o que mais incomoda hoje, há quanto tempo tenta resolver isso, o que já tentou antes, qual seria o objetivo ideal, o que mais dificulta o resultado) e só depois explique brevemente como o Dr. Saulo Silva costuma ajudar casos parecidos, gerando desejo pela transformação. Nunca responda uma pergunta de preço só com o valor - isso soa seco e não converte." },
  { category: "pagamento", instruction: "O investimento na Experiência Clínica, presencial ou online, é de R$ 750,00. No SALDO (os R$ 525,00 pagos no dia da consulta) valem todas as formas: dinheiro, Pix, cartão de débito e cartão de crédito, em até 3x sem juros ou até 12x com acréscimo da operadora da máquina." },
  { category: "pagamento", instruction: "O SINAL de R$ 225,00 é aceito SOMENTE por Pix, na chave CNPJ 52.716.955/0001-43. Nunca ofereça cartão, dinheiro ou link de pagamento para o sinal - só o Pix nessa chave. Cartão e dinheiro valem apenas para o saldo, no dia da consulta." },
  { category: "pagamento", instruction: "Não ofereça desconto à vista nem negocie valores: os investimentos são tabelados para manter a equidade entre os pacientes. Se pedirem desconto ou negociação, transfira para a equipe." },
  { category: "pagamento", instruction: "Para confirmar o horário é necessário o sinal de 30% do valor da consulta (R$ 225,00 sobre R$ 750,00); o saldo (R$ 525,00) é pago no dia. Só use book_appointment depois do comprovante do sinal na conversa." },
  { category: "procedimentos", instruction: "Nunca diagnostique, prescreva medicamento, oriente ajuste de dose ou garanta resultado. Fale sempre em possibilidades e protocolos individualizados, condicionados à avaliação com o Dr. Saulo Silva." },
  { category: "procedimentos", instruction: "Ao contornar objeções sobre preço, tempo, método, decisão ou resultado, use um tom sofisticado e acolhedor, nunca depreciando outros profissionais ou minimizando a preocupação do paciente." },
  { category: "procedimentos", instruction: "Assim que identificar o objetivo do paciente, cite pelo nome o protocolo Silva correspondente (consulte a FAQ \"Quais protocolos o Dr. Saulo Silva oferece?\") para gerar autoridade e curiosidade - em vez de falar genericamente em \"tratamento\" ou \"protocolo\", diga o nome (ex: \"o Dr. Saulo trabalha com o Silva Metabolic Reset & Sculpt para esse tipo de caso\"). O protocolo final e o valor só são definidos na Experiência Clínica." },
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
      "A cada resposta do paciente, valide a emoção genuinamente antes de seguir (ex: reconhecer que é comum sentir frustração depois de tantas tentativas) - nunca pule direto pra próxima pergunta ou informação sem comentar o que ele disse.",
      "Cite pelo nome o protocolo Silva correspondente ao objetivo do paciente (ver FAQ dos protocolos) e pergunte se pode explicar melhor como ele funciona - peça essa pequena permissão antes de detalhar, não empurre a explicação.",
      "Se o paciente topar, explique o protocolo com uma lista curta do que ele inclui (ex: avaliação completa, direcionamento nutricional, acompanhamento contínuo), gerando desejo pela transformação, sem citar valores ainda.",
      "Envie a mensagem pronta \"Apresentação da consulta\": ela já traz o que o atendimento inclui, o investimento de R$ 750,00 e termina perguntando se ele prefere on-line ou presencial.",
      "Se ele escolher on-line, envie o \"Ajuste do que inclui - online\", pra ele não ficar esperando bioimpedância e exame físico.",
      "Conduza para o agendamento: ofereça primeiro os dias com vaga e, depois que ele escolher o dia, os horários daquele dia.",
    ],
  },
  {
    name: "Pedido de valor da consulta",
    scriptType: "preco",
    triggerText: "Paciente pergunta preço, valor ou investimento da consulta logo de início, sem ter contado o objetivo.",
    goal: "Nunca ancorar em preço antes de demonstrar valor; qualificar e conduzir para a apresentação da consulta.",
    steps: [
      "Não informe valor. Responda com acolhimento e pergunte qual é o principal objetivo do paciente.",
      "Faça NO MÍNIMO mais 2 perguntas de aprofundamento (totalizando pelo menos 3 com a do objetivo) antes de falar em consulta ou valor: há quanto tempo tenta resolver isso, o que já tentou antes, o que mais incomoda, qual seria o resultado ideal. Valide a emoção a cada resposta antes de seguir.",
      "Cite pelo nome o protocolo Silva que combina com o objetivo do paciente (ver FAQ dos protocolos) - gera autoridade e curiosidade em vez de falar genericamente em \"tratamento\".",
      "Pergunte se pode explicar melhor como funciona esse protocolo e a consulta - peça essa permissão antes de detalhar.",
      "Envie a mensagem pronta \"Apresentação da consulta\", que traz o que está incluso, o investimento de R$ 750,00 e já pergunta se ele prefere on-line ou presencial.",
      "Se ele escolher on-line, envie o \"Ajuste do que inclui - online\".",
      "Se houver interesse real, ofereça os dias com vaga e siga para o agendamento.",
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
      "Informe que o sinal é somente por Pix e passe a chave CNPJ 52.716.955/0001-43 - não pergunte a forma de pagamento do sinal, ela é única. Só o saldo, no dia, aceita cartão ou dinheiro.",
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

  // "Aplicação" e feita pela enfermagem, nao pelo Dr. Saulo - por isso fica
  // com um profissional PROPRIO em vez de ficar junto com o dele. Pedido do
  // cliente (16/09/2026): a aplicação acontece no MESMO horario da consulta
  // (o enfermeiro atende enquanto o Dr. Saulo esta com outro paciente), entao
  // as duas agendas precisam ser independentes - se ficassem no mesmo
  // profissional, o sistema recusaria por conflito de horario.
  const APLICACAO_NAME = "Aplicação";
  const aplicacaoId = procedureIds.get(APLICACAO_NAME);
  const doctorProcedureIds = [...procedureIds.entries()].filter(([name]) => name !== APLICACAO_NAME).map(([, id]) => id);

  const professional = await prisma.professional.findFirst({ where: { clinicId: clinic.id, name: "Dr. Saulo Silva" } });
  const professionalData = {
    bio: "Médico especialista em medicina de precisão, emagrecimento, performance e longevidade.",
    instagram: null,
    active: true,
    workDays: null,
    workStartHour: null,
    workEndHour: null,
    procedures: { set: doctorProcedureIds.map((id) => ({ id })) },
  };
  if (professional) await prisma.professional.update({ where: { id: professional.id }, data: professionalData });
  else await prisma.professional.create({
    data: {
      clinic: { connect: { id: clinic.id } },
      name: "Dr. Saulo Silva",
      bio: professionalData.bio,
      active: true,
      procedures: { connect: doctorProcedureIds.map((id) => ({ id })) },
    },
  });

  if (aplicacaoId) {
    const nurse = await prisma.professional.findFirst({ where: { clinicId: clinic.id, name: "Enfermagem (Aplicações)" } });
    const nurseData = {
      bio: "Responsável pelas aplicações do protocolo, em paralelo ao atendimento do Dr. Saulo Silva.",
      instagram: null,
      active: true,
      workDays: null,
      workStartHour: null,
      workEndHour: null,
      procedures: { set: [{ id: aplicacaoId }] },
    };
    if (nurse) await prisma.professional.update({ where: { id: nurse.id }, data: nurseData });
    else await prisma.professional.create({
      data: {
        clinic: { connect: { id: clinic.id } },
        name: "Enfermagem (Aplicações)",
        bio: nurseData.bio,
        active: true,
        procedures: { connect: [{ id: aplicacaoId }] },
      },
    });
  }

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

  await prisma.messageTemplate.updateMany({
    where: { clinicId: clinic.id, name: { in: [...RETIRED_TEMPLATES] } },
    data: { active: false },
  });

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
      // RenewalRule.intervalUnit so entende "months"/"years" (schema.prisma:838;
      // "days"/"hours" e do PostProcedureRule, campo diferente). Com "days" o
      // cron de renovacao (src/reminders/renewal.ts) tratava como se fosse
      // "months" e multiplicava por 30 -> 90*30 = 2700 dias, cortado pelo teto
      // de 2 anos: a mensagem so sairia daqui a ~2 anos em vez de 3 meses.
      intervalValue: 3,
      intervalUnit: "months",
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
      "nome real de quem faz a Aplicação (cadastrado como \"Enfermagem (Aplicações)\" - é só um nome-placeholder no profissional novo criado pra separar a agenda dela da do Dr. Saulo; pode renomear em Configurações → Equipe a qualquer hora)",
      "política de cancelamento/reembolso do sinal em caso de desistência (o manual não especifica se o valor é devolvido)",
      "estacionamento ou manobrista no endereço novo",
      "texto da confirmação para consulta ONLINE (a mensagem de confirmação atual é a presencial: fala de endereço e bioimpedância)",
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
