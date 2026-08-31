import "dotenv/config";
import { fileURLToPath } from "url";
import { prisma } from "../db/client.js";
import { hashPassword } from "../api/passwords.js";
import { seedDefaultRules } from "../ai/rules.js";
import { DEFAULT_FUNNEL_STAGES } from "../crm/stages.js";

// ---------------------------------------------------------------------------
// Configura a conta da Laleblu (loja de roupas e enxoval para bebes e criancas)
// como negocio generico (businessType = geral) e treina a Alice a partir do
// documento "LALEBLU - Configuracao de respostas automaticas" (ManyChat).
//
// Rodar: npm run seed:laleblu   (ou: node dist/maintenance/seedLaleblu.js)
//
// Idempotente: pode rodar de novo. Reaplica FAQ, mensagens prontas, roteiros e
// as regras marcadas como "seed:laleblu" (regras escritas a mao no painel e o
// catalogo/contatos/conversas NAO sao tocados).
// ---------------------------------------------------------------------------

const WA = "5511942540549"; // WhatsApp de atendimento: (11) 94254-0549
const WA_LINK = `https://wa.me/${WA}`;
const waText = (msg: string) => `${WA_LINK}?text=${encodeURIComponent(msg)}`;

const LOGIN = "laleblu@aliceconversa.com";
const PASSWORD = "laleblu1234";

const FUNNEL = [
  { id: "novo_contato", label: "Novo contato", color: "#0ea5e9", kind: "aberta" },
  { id: "conversando", label: "Conversando", color: "#6366f1", kind: "aberta" },
  { id: "interessado", label: "Interessado", color: "#8b5cf6", kind: "aberta" },
  { id: "comprou", label: "Comprou", color: "#10b981", kind: "ganho" },
  { id: "sem_resposta", label: "Sem resposta", color: "#f59e0b", kind: "aberta" },
  { id: "perdido", label: "Perdido", color: "#64748b", kind: "perdido" },
];

const FAQS: { question: string; alternates: string; answer: string }[] = [
  {
    question: "Quanto custa? Qual o preço de uma peça?",
    alternates: "preço\nvalor\nquanto custa\nquanto é\nquanto tá\nquanto fica\npreços",
    answer:
      "Todos os preços ficam no site, com o estoque em tempo real 🤍 Se me mandar um print ou o nome da peça, eu te passo o link direto. Novidades: https://laleblu.com.br/collections/novidades · Sale: https://laleblu.com.br/collections/sale",
  },
  {
    question: "Qual tamanho comprar?",
    alternates: "tamanho\nmedida\ntabela\nRN\nprematuro\nveste\nnumeração\nque tamanho\nqual tamanho",
    answer:
      "Nossos tamanhos vão do Prematuro ao 2:\n• Prematuro (até 47 cm) • PP/RN 0 a 1 mês (até 55 cm) • P 1 a 3 meses (até 61 cm) • M 3 a 6 meses (até 67 cm) • G 6 a 9 meses (até 72 cm) • GG/1 9 meses a 1 ano (até 76 cm) • 2 1 a 2 anos (até 88 cm)\nNa dúvida entre dois tamanhos, vale escolher o maior. Cada peça tem as medidas em cm na página. Me diga a idade ou a altura do bebê que eu ajudo a escolher.",
  },
  {
    question: "Como funciona o frete? Qual o prazo de entrega?",
    alternates: "frete\nentrega\nprazo\nmotoboy\ncorreios\nchega quando\nquanto tempo\nfrete grátis",
    answer:
      "Frete grátis para compras com preço regular:\n• Cidade de SP: acima de R$ 399 • Estado de SP: acima de R$ 599 • Sul, Sudeste e Centro-Oeste: acima de R$ 699 • Norte e Nordeste: acima de R$ 799\nO prazo aparece no carrinho quando você coloca o CEP. Em SP capital, Grande SP e ABC também tem motoboy, com entrega no mesmo dia para pedidos pagos até as 14h. Regras completas: https://laleblu.com.br/policies/shipping-policy",
  },
  {
    question: "Onde ficam as lojas? Qual o horário?",
    alternates: "loja\nlojas\nendereço\nhorário\nshopping\nmoema\nbertioga\nriviera\njardins\ncidade jardim\nonde fica\nvocês têm loja física",
    answer:
      "Você pode nos visitar em 4 lojas:\n📍 Moema — Av. Bem-te-vi, 177 (estacionamento grátis) · seg a sáb, 10h às 19h\n📍 Shops Jardins — Rua Haddock Lobo, 1626 · seg a sáb, 10h às 22h · dom e feriados, 14h às 20h\n📍 Shopping Cidade Jardim — Av. Magalhães de Castro, 12.000 · seg a sáb, 10h às 22h · dom e feriados, 14h às 20h\n📍 Shopping Riviera de São Lourenço, Bertioga · todos os dias, 10h às 22h\nWhatsApp das lojas: Moema (11) 95965-5533 · Jardins (11) 91497-8851 · Cidade Jardim (11) 94535-7349. Ver no mapa: https://laleblu.com.br/pages/nossas-lojas",
  },
  {
    question: "Quero criar meu chá de bebê / encontrar uma lista",
    alternates: "chá\ncha de bebe\nchá de bebê\nlista\npresentear\nlista de presentes\nquero criar\nencontrar lista",
    answer:
      "Que fase linda 🍼 Na Laleblu você cria sua lista de chá de bebê em poucos minutos e compartilha o link com quem vai presentear. Os convidados escolhem os itens pelo site e você acompanha tudo pela sua conta.\nCriar minha lista: https://laleblu.com.br/pages/cha-de-bebe\nEncontrar uma lista: https://laleblu.com.br/pages/encontre-seu-cha-de-bebe",
  },
  {
    question: "Como monto o enxoval? Tem checklist?",
    alternates: "enxoval\nchecklist\no que comprar\nlista do enxoval\nmaternidade\nsaída de maternidade",
    answer:
      "Montar o enxoval fica muito mais fácil com a nossa lista interativa ✨ São 145 itens organizados por categoria: você marca o que já tem e vê o que falta, direto no celular.\nAbrir o checklist: https://laleblu.com.br/pages/checklist-enxoval\nEntrar no Clube VIP: https://laleblu.com.br/pages/clube-vip",
  },
  {
    question: "Quero dar um presente para um bebê",
    alternates: "presente\nkit\npresentear\nnascimento\nrecém-nascido\nrecem nascido\nsugestão de presente\nvou ser madrinha",
    answer:
      "Presentear um bebê é sempre especial 💙 Temos kits prontos com as peças que mais combinam. Ver kits: https://laleblu.com.br/collections/presentes\nSe for para um chá de bebê, você também pode buscar a lista da família: https://laleblu.com.br/pages/encontre-seu-cha-de-bebe\nSe quiser embalagem para presente, me avisa que eu confirmo com a equipe.",
  },
  {
    question: "Como funciona troca e devolução?",
    alternates: "troca\ntrocar\ndevolver\ndevolução\ndefeito\nestorno\narrependimento\nquero trocar",
    answer:
      "Nossa política é simples:\n• Troca: até 30 dias, peça sem uso e com etiqueta\n• Devolução (arrependimento): até 7 dias corridos após o recebimento\n• Peça com defeito: resolvemos com frete por nossa conta\nEm Sale e Black Friday há apenas devolução e defeito, não há troca. Trocas e devoluções são feitas pela nossa equipe no WhatsApp, que acessa o seu pedido: " +
      waText("Olá! Vim pelo Instagram e quero falar sobre uma troca ou devolução.") +
      "\nPolítica completa: https://laleblu.com.br/policies/refund-policy",
  },
  {
    question: "Cadê meu pedido? Quero rastrear",
    alternates:
      "pedido\nrastreio\nrastrear\ncódigo\nstatus\nnão chegou\natrasou\ncadê meu pedido\nnota fiscal\nmeu pedido",
    answer:
      "Vamos verificar pra você 🤍 Dúvidas sobre um pedido já feito são atendidas pelo nosso WhatsApp, onde a equipe consulta a compra na hora. Toque aqui e, se puder, já manda o número do pedido (começa com #) ou o e-mail da compra: " +
      waText("Olá! Vim pelo Instagram e quero saber sobre o meu pedido nº "),
  },
  {
    question: "Tem cupom de desconto?",
    alternates: "cupom\ncoupom\ndesconto\npromoção\nprimeira compra\ncódigo de desconto\ntem desconto",
    answer:
      "Temos sim 💙 Na sua primeira compra, use o cupom PRIMEIRACOMPRA e ganhe 5% de desconto (sem valor mínimo, uma vez por cliente).\nE no Clube VIP você recebe novidades antes de todo mundo e cupons exclusivos ao longo do ano: https://laleblu.com.br/pages/clube-vip",
  },
  {
    question: "Vocês têm moda praia para bebê?",
    alternates: "praia\nmaiô\nbiquíni\nsunga\npiscina\nUV\nmoda praia\nproteção solar\nfps",
    answer:
      "Nossa linha Moda Praia para Bebê tem maiôs, biquínis, sungas, camisetas e chapéus com proteção UV FPS 50+ ☀️ Feita em parceria com a Banho Maria, do Prematuro ao GG/1: https://laleblu.com.br/collections/moda-praia-para-bebe",
  },
  {
    question: "Quero fazer uma parceria / publi",
    alternates: "parceria\npubli\ninflu\ndivulgação\nmídia kit\ncolab\npermuta\nsou influencer",
    answer:
      "Que legal! Propostas de parceria e divulgação são avaliadas pela equipe de marketing. Envie um e-mail para contato@laleblu.com.br com o assunto \"Parceria\" e o seu perfil, que retornamos por lá 🤍",
  },
  {
    question: "Vocês vendem no atacado / para revenda?",
    alternates: "atacado\nrevenda\nrevender\nlojista\nrepresentante\ncomprar pra revender",
    answer:
      "Obrigada pelo interesse! Hoje a Laleblu não trabalha com atacado ou revenda: nossas peças são vendidas apenas ao consumidor final, nas lojas e no site 🤍 https://laleblu.com.br",
  },
  {
    question: "Tentei comprar e não consegui finalizar",
    alternates:
      "não deu certo\nfinalização\nfinalizar\npagamento\nerro\ncartão\npix\nnão consegui comprar\nrecusado\nnão passou\nnão consigo pagar",
    answer:
      "Poxa, vamos resolver isso 💙 Duas coisas que costumam funcionar na hora:\n• Se foi cartão, tente o Pix, a aprovação é imediata\n• Confira se o CEP e o endereço estão completos\nSe não der certo, chame a equipe no WhatsApp com um print da tela que ela finaliza a compra com você: " +
      waText("Olá! Vim pelo Instagram. Tentei finalizar uma compra no site e não deu certo.") +
      "\nOu tente de novo: https://laleblu.com.br/cart",
  },
  {
    question: "As peças são 100% algodão? Qual tecido é mais fresquinho?",
    alternates:
      "tecido\nsuedine\ntricotil\ntricô\ntricot\npima\negípcio\n100% algodão\nfresquinho\nquente\nverão\ncalor\ncomposição",
    answer:
      "Suedine, Tricotil, Algodão Pima e Algodão Egípcio são 100% algodão: macios, respiráveis e ótimos para a pele delicada do bebê 🤍 Para dias mais quentes, são os mais leves.\nJá o nosso tricô é feito em linha: mantém a temperatura do bebê sem superaquecer, ideal para saída de maternidade e ambientes com ar-condicionado. A composição de cada peça está na descrição do produto no site.",
  },
  {
    question: "Uma cor ou tamanho está esgotado, quando volta?",
    alternates:
      "reposição\nrepor\nvai chegar\nesgotado\nsem estoque\nprevisão\noutra cor\nsó tem\nquando volta\navise-me\nesgotou",
    answer:
      "Quando uma cor ou tamanho está esgotado, o jeito mais fácil é tocar em \"Avise-me\" na página do produto: assim que chegar, você recebe um aviso na hora 🤍 Se quiser uma previsão, me diga qual peça e qual cor que eu verifico com a equipe.",
  },
  {
    question: "Qual o contato / WhatsApp de vocês?",
    alternates: "contato\ntelefone\nwhatsapp\nnúmero\nzap\nfalar com vocês",
    answer:
      "Nosso WhatsApp de atendimento é (11) 94254-0549 💙 " +
      WA_LINK +
      "\nSe preferir falar direto com uma loja (Moema, Jardins, Cidade Jardim ou Bertioga), é só me dizer qual.",
  },
  {
    question: "O que é o Clube VIP?",
    alternates: "clube vip\nvip\nfidelidade\nbenefícios\nprograma de pontos\nclube",
    answer:
      "No Clube VIP você recebe novidades antes de todo mundo, cupons exclusivos ao longo do ano e condições especiais 💙 https://laleblu.com.br/pages/clube-vip",
  },
  {
    question: "Vocês atendem por agendamento / hora marcada?",
    alternates: "agendar\nagendamento\nhora marcada\nmarcar horário\nreserva",
    answer:
      "A Laleblu não trabalha com agendamento nem hora marcada 🤍 Nas lojas é só chegar dentro do horário de funcionamento. Quer os endereços?",
  },
  {
    question: "Que fofura, amei a experiência!",
    alternates:
      "amei\nadorei\napaixonada\nperfeita\nexperiência\nparabéns\nvim agradecer\nmaravilhoso\nlindo demais\nrecebi e amei",
    answer:
      "Que alegria ler isso 🥹💙 Tudo é preparado com muito carinho e saber que chegou assim até você faz o nosso dia. Se puder, deixe sua avaliação na página do produto, ajuda muito outras famílias na escolha. E se postar o bebê com a peça, marca a gente que a gente reposta 🤍",
  },
];

const TEMPLATES: { name: string; body: string; mode: string; whenToUse: string }[] = [
  {
    name: "Boas-vindas",
    mode: "adapt",
    whenToUse: "primeira mensagem de alguém novo, ou quando a pessoa só manda um oi",
    body: "Oi! Que bom ter você por aqui 💙 Posso te ajudar com enxoval, presentes, chá de bebê, tamanhos e frete, e te levo ao WhatsApp se for sobre um pedido. Por onde quer começar?",
  },
  {
    name: "Não entendi o pedido",
    mode: "adapt",
    whenToUse: "quando a mensagem não bate com nenhum assunto conhecido",
    body: "Pra eu te ajudar direitinho, me conta com mais detalhes o que você precisa 🤍 Posso ajudar com tamanhos, frete, trocas, chá de bebê e enxoval.",
  },
  {
    name: "Transferir no horário de atendimento",
    mode: "exact",
    whenToUse: "ao passar para a equipe de segunda a sexta, entre 9h e 17h",
    body: "Perfeito, vou te passar para a nossa equipe 🤍 Em instantes alguém responde por aqui. Se preferir, também estamos no WhatsApp: (11) 94254-0549",
  },
  {
    name: "Transferir fora do horário",
    mode: "exact",
    whenToUse: "ao passar para a equipe fora de seg a sex, 9h às 17h",
    body: "Nossa equipe atende de segunda a sexta, das 9h às 17h. Sua mensagem já ficou registrada e será respondida logo no próximo horário de atendimento 💙 Se for urgente, chame no WhatsApp: (11) 94254-0549",
  },
  {
    name: "Assinatura da equipe",
    mode: "exact",
    whenToUse: "encerramento quando a conversa foi transferida para a equipe",
    body: "Qualquer dúvida, é só chamar. Equipe Laleblu 💙",
  },
  {
    name: "Menção em story",
    mode: "adapt",
    whenToUse: "quando a cliente marca a Laleblu num story (foto do bebê com a peça)",
    body: "Que fofura! 🤍 Obrigada por compartilhar. Podemos repostar nos nossos stories?",
  },
];

const PLAYBOOKS: {
  name: string;
  scriptType: string;
  triggerText: string;
  goal: string;
  steps: string[];
}[] = [
  {
    name: "Primeiro contato",
    scriptType: "primeiro_atendimento",
    triggerText: "primeira mensagem de alguém novo ou um oi sem contexto",
    goal: "entender o que a pessoa procura e direcionar para o assunto certo",
    steps: [
      "Cumprimente de forma calorosa e curta.",
      "Diga em uma linha que pode ajudar com enxoval, presentes, chá de bebê, tamanhos e frete.",
      "Pergunte por onde ela quer começar ou o que precisa.",
      "A partir da resposta, siga o assunto (tamanho, frete, chá de bebê, etc.) usando a FAQ.",
    ],
  },
  {
    name: "Chá de bebê",
    scriptType: "livre",
    triggerText: "quer criar ou encontrar uma lista de chá de bebê",
    goal: "levar a pessoa ao link certo (criar ou encontrar) e tirar dúvidas",
    steps: [
      "Reconheça a fase com leveza.",
      "Explique em uma linha que a lista é criada em poucos minutos e o link é compartilhável.",
      "Envie o link de criar (https://laleblu.com.br/pages/cha-de-bebe) ou de encontrar (https://laleblu.com.br/pages/encontre-seu-cha-de-bebe), conforme o caso.",
      "Ofereça ajuda se ela travar em alguma etapa.",
    ],
  },
  {
    name: "Pedido, rastreio ou status",
    scriptType: "transferir",
    triggerText: "pergunta sobre um pedido já feito: rastreio, atraso, status, nota fiscal",
    goal: "encaminhar para o WhatsApp com a mensagem pronta, sem tentar consultar aqui",
    steps: [
      "Diga que dúvidas de pedido são atendidas no WhatsApp, onde a equipe consulta a compra na hora.",
      `Envie o link ${WA_LINK} com a mensagem pronta sobre o pedido.`,
      "Peça que já mande o número do pedido (começa com #) ou o e-mail da compra.",
      "Não tente rastrear nem dar status por aqui. Não use transfer_to_human, a menos que a pessoa insista.",
    ],
  },
  {
    name: "Troca ou devolução",
    scriptType: "transferir",
    triggerText: "quer trocar, devolver, falar de defeito ou estorno",
    goal: "dar a política resumida e encaminhar para o WhatsApp",
    steps: [
      "Resuma a política: troca em até 30 dias (sem uso, com etiqueta), devolução em até 7 dias corridos, defeito com frete por nossa conta.",
      `Envie o link do WhatsApp com a mensagem pronta de troca e o link da política (https://laleblu.com.br/policies/refund-policy).`,
      "Não transfira no Direct. Se a pessoa insistir em resolver por aqui, aplique a etiqueta de troca e a equipe responde.",
    ],
  },
  {
    name: "Não conseguiu finalizar a compra",
    scriptType: "transferir",
    triggerText: "tentou comprar e não conseguiu, erro no pagamento, cartão recusado",
    goal: "dar as duas soluções rápidas e, se não resolver, mandar para o WhatsApp",
    steps: [
      "Reconheça com leveza e um toque de urgência (a pessoa está com o cartão na mão).",
      "Dê as duas soluções: tentar pagar com Pix (aprovação imediata) e conferir se CEP e endereço estão completos.",
      `Se não resolver, envie o link do WhatsApp com a mensagem pronta pedindo um print da tela.`,
      "Ofereça o link do carrinho para tentar de novo: https://laleblu.com.br/cart",
    ],
  },
  {
    name: "Elogio ou agradecimento",
    scriptType: "livre",
    triggerText: "mensagem de agradecimento ou elogio após a entrega",
    goal: "agradecer e convidar para avaliar / marcar a loja",
    steps: [
      "Agradeça com calor e brevidade.",
      "Peça, se puder, uma avaliação na página do produto (ajuda outras famílias).",
      "Convide a marcar a loja numa foto do bebê com a peça para repost.",
      "Não transfira automaticamente.",
    ],
  },
];

const RULES: { category: string; instruction: string }[] = [
  // tom de voz
  { category: "tom_de_voz", instruction: "Trate a pessoa por 'você'. Nunca use 'senhora' nem 'mamãe' de forma genérica: pode ser avó, pai, padrinho ou quem vai presentear." },
  { category: "tom_de_voz", instruction: "No máximo 3 linhas por mensagem. Se precisar de mais, divida em duas mensagens." },
  { category: "tom_de_voz", instruction: "Emojis com moderação, no máximo um por mensagem, preferindo 💙 🤍 🍼 ✨. Nada de emojis de risada ou fogo. Nenhum emoji em mensagem sobre preço, pagamento ou política de troca." },
  { category: "tom_de_voz", instruction: "Sempre termine com um próximo passo: um link, uma opção ou uma pergunta. A pessoa nunca deve ficar sem saber o que fazer." },
  { category: "tom_de_voz", instruction: "Use com naturalidade, quando couber, as palavras da marca: enxoval, chá de bebê, macacão, body, naninha, kit presente, algodão pima, Clube VIP." },
  { category: "tom_de_voz", instruction: "Quando o atendimento for transferido para a equipe, encerre com: 'Qualquer dúvida, é só chamar. Equipe Laleblu 💙'." },
  // catalogo / informacao
  { category: "procedimentos", instruction: "Nunca prometa nem afirme estoque, disponibilidade de cor ou tamanho, prazo exato de entrega ou status de um pedido. Esses dados mudam e não estão com você: direcione para o site ('Avise-me' na página do produto) ou para o WhatsApp da equipe." },
  { category: "procedimentos", instruction: "Preço é sempre pelo site, que tem valor e estoque em tempo real. Se a pessoa mandar print ou nome de peça pedindo valor, oriente ver no site ou passe para a equipe." },
  { category: "procedimentos", instruction: "Tecidos: Suedine, Tricotil, Algodão Pima e Algodão Egípcio são 100% algodão. Peças em Soft, Napa Soft e Plush NÃO são 100% algodão: se a pergunta citar esses materiais, não afirme composição, confirme com a equipe." },
  { category: "procedimentos", instruction: "A tabela de tamanhos vai do Prematuro ao 2. Na dúvida entre dois tamanhos, oriente escolher o maior. As medidas em centímetros de cada peça estão na página do produto." },
  { category: "procedimentos", instruction: "Frete grátis vale só para compras com preço regular, não vale em Sale nem Black Friday." },
  { category: "procedimentos", instruction: "Em Sale e Black Friday não há troca, apenas devolução e peça com defeito." },
  // pagamento / cupom
  { category: "pagamento", instruction: "O único cupom que pode ser divulgado é o PRIMEIRACOMPRA (5% na primeira compra, sem valor mínimo, uma vez por cliente). Nenhum outro cupom ou código de promoção deve ser informado: convide para o Clube VIP. Se a pessoa perguntar por um código específico de promoção, transfira para a equipe." },
  // chamar a equipe
  { category: "chamar_equipe", instruction: "Pedido, troca, devolução, rastreio e problema de pagamento não se resolvem na conversa: envie o link do WhatsApp (11) 94254-0549 com a mensagem pronta. Só use transfer_to_human se a pessoa insistir em resolver por ali." },
  { category: "chamar_equipe", instruction: "O atendimento humano funciona de segunda a sexta, das 9h às 17h. Ao transferir dentro desse horário, diga que a equipe já responde por aqui. Fora do horário, avise que a mensagem ficou registrada e será respondida no próximo horário útil, e ofereça o WhatsApp para urgências." },
  { category: "chamar_equipe", instruction: "Se a pessoa marcar a loja num story (foto do bebê com a peça), agradeça e pergunte se pode repostar. Se ela autorizar, transfira para a equipe com a etiqueta de repost." },
  { category: "chamar_equipe", instruction: "Mensagem só com imagem e sem texto (print, corrente, spam) não deve receber resposta." },
  { category: "chamar_equipe", instruction: "Pedido de previsão de chegada de uma cor ou tamanho esgotado: peça qual peça e qual cor e transfira para a equipe, que dá a previsão real." },
  // agendamento (loja nao agenda)
  { category: "agendamento", instruction: "A Laleblu não trabalha com agendamento nem hora marcada. Se perguntarem, informe os horários das lojas físicas e que é só chegar." },
];

export interface SeedLalebluResult {
  clinicId: string;
  login: string;
  password: string;
  created: boolean;
  faqs: number;
  templates: number;
  playbooks: number;
  rules: number;
}

// Idempotente. Chamado pelo CLI (npm run seed:laleblu) e pela rota admin
// POST /clinics/seed-laleblu. NAO fecha a conexao do Prisma (quem chama decide).
export async function seedLaleblu(): Promise<SeedLalebluResult> {
  // 1. Conta/tenant Laleblu (chaveada pelo WhatsApp de atendimento)
  const clinic = await prisma.clinic.upsert({
    where: { whatsappPhone: WA },
    update: {
      name: "Laleblu",
      businessType: "geral",
      businessLabel: "loja de roupas e enxoval para bebês e crianças",
      activityArea: "moda infantil, enxoval de bebê, chá de bebê e presentes",
      assistantPersona: "team",
      assistantName: "Alice",
      allowEmojis: true,
      timezone: "America/Sao_Paulo",
      workDays: "1,2,3,4,5",
      workStartHour: 9,
      workEndHour: 17,
      notifyPhone: WA,
      notifyEvents: "human_handoff",
      handoffPhrase: "",
      npsEnabled: false,
    },
    create: {
      name: "Laleblu",
      whatsappPhone: WA,
      businessType: "geral",
      businessLabel: "loja de roupas e enxoval para bebês e crianças",
      activityArea: "moda infantil, enxoval de bebê, chá de bebê e presentes",
      assistantPersona: "team",
      assistantName: "Alice",
      allowEmojis: true,
      timezone: "America/Sao_Paulo",
      workDays: "1,2,3,4,5",
      workStartHour: 9,
      workEndHour: 17,
      notifyPhone: WA,
      notifyEvents: "human_handoff",
      plan: "prime",
    },
  });
  console.log(`Clinica: ${clinic.name} (${clinic.id}) — businessType=${clinic.businessType}`);

  // 2. Conta de acesso ao painel
  const passwordHash = hashPassword(PASSWORD);
  const existingUser = await prisma.staffUser.findUnique({ where: { username: LOGIN } });
  const created = !existingUser;
  if (existingUser) {
    await prisma.staffUser.update({
      where: { username: LOGIN },
      data: { name: "Laleblu", passwordHash, role: "client", clinicId: clinic.id },
    });
    console.log(`Conta atualizada: ${LOGIN}`);
  } else {
    await prisma.staffUser.create({
      data: { name: "Laleblu", username: LOGIN, passwordHash, role: "client", clinicId: clinic.id },
    });
    console.log(`Conta criada: ${LOGIN} / senha ${PASSWORD}`);
  }

  // 3. Funil enxuto (só se ainda estiver com as etapas padrão de clínica ou vazio)
  const stages = await prisma.funnelStage.findMany({ where: { clinicId: clinic.id } });
  const defaultIds = new Set(DEFAULT_FUNNEL_STAGES.map((s) => s.id));
  const untouched = stages.length === 0 || stages.every((s) => defaultIds.has(s.stageId));
  if (untouched) {
    await prisma.$transaction([
      prisma.funnelStage.deleteMany({ where: { clinicId: clinic.id } }),
      prisma.funnelStage.createMany({
        data: FUNNEL.map((s, i) => ({ clinicId: clinic.id, stageId: s.id, label: s.label, color: s.color, kind: s.kind, order: i })),
      }),
    ]);
    console.log(`Funil: ${FUNNEL.length} etapas`);
  } else {
    console.log("Funil: mantido (já foi editado no painel)");
  }

  // 4. FAQ / mensagens prontas / roteiros — reaplicados do zero
  await prisma.$transaction([
    prisma.clinicFaq.deleteMany({ where: { clinicId: clinic.id } }),
    prisma.messageTemplate.deleteMany({ where: { clinicId: clinic.id } }),
    prisma.playbook.deleteMany({ where: { clinicId: clinic.id } }),
    prisma.clinicFaq.createMany({
      data: FAQS.map((f) => ({ clinicId: clinic.id, question: f.question, answer: f.answer, alternates: f.alternates, exactAnswer: false, active: true })),
    }),
    prisma.messageTemplate.createMany({
      data: TEMPLATES.map((t) => ({ clinicId: clinic.id, name: t.name, body: t.body, mode: t.mode, whenToUse: t.whenToUse, active: true })),
    }),
    prisma.playbook.createMany({
      data: PLAYBOOKS.map((p) => ({ clinicId: clinic.id, name: p.name, scriptType: p.scriptType, triggerText: p.triggerText, goal: p.goal, steps: p.steps.join("\n"), active: true })),
    }),
  ]);
  console.log(`FAQ: ${FAQS.length} · Mensagens prontas: ${TEMPLATES.length} · Roteiros: ${PLAYBOOKS.length}`);

  // 5. Regras — defaults do balde "varejo" + as específicas da Laleblu
  const seeded = await seedDefaultRules(clinic.id);
  await prisma.customRule.deleteMany({ where: { clinicId: clinic.id, rawInput: "seed:laleblu" } });
  await prisma.customRule.createMany({
    data: RULES.map((r) => ({ clinicId: clinic.id, category: r.category, rawInput: "seed:laleblu", instruction: r.instruction, clarifyingQuestion: null, status: "active" })),
  });
  console.log(`Regras: ${seeded} padrão (varejo) + ${RULES.length} da Laleblu`);
  console.log("\nPronto. Login: " + LOGIN + " · Senha: " + PASSWORD);

  return {
    clinicId: clinic.id,
    login: LOGIN,
    password: PASSWORD,
    created,
    faqs: FAQS.length,
    templates: TEMPLATES.length,
    playbooks: PLAYBOOKS.length,
    rules: seeded + RULES.length,
  };
}

// Entrypoint de linha de comando (npm run seed:laleblu).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  seedLaleblu()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
