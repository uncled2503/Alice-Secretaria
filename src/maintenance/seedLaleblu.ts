import "dotenv/config";
import { fileURLToPath } from "url";
import { prisma } from "../db/client.js";
import { hashPassword } from "../api/passwords.js";
import { seedDefaultRules } from "../ai/rules.js";
import { DEFAULT_FUNNEL_STAGES } from "../crm/stages.js";

// ---------------------------------------------------------------------------
// Configura a conta da Laleblu (loja de roupas e enxoval para bebes e criancas)
// como negocio generico (businessType = geral) e treina a Alice a partir dos
// documentos da loja (respostas automaticas + guia de links do site).
//
// A Alice atende PELO proprio WhatsApp oficial da Laleblu. Ela NUNCA manda link
// de WhatsApp nem numero pra "chamar o atendimento" - quando precisa de uma
// pessoa, usa transfer_to_human e alguem da equipe assume ESTA conversa.
//
// Rodar: npm run seed:laleblu   (ou: node dist/maintenance/seedLaleblu.js)
//
// Idempotente: pode rodar de novo. Reaplica FAQ, mensagens prontas, roteiros e
// as regras marcadas como "seed:laleblu" (regras escritas a mao no painel e o
// catalogo/contatos/conversas NAO sao tocados). NAO sobrescreve o numero de
// avisos (notifyPhone) - esse fica configurado no painel.
// ---------------------------------------------------------------------------

const WA = "5511942540549"; // numero conectado da Laleblu (chave do tenant)

// Frase que a Alice manda logo antes de transferir pra uma pessoa da equipe.
const HANDOFF_PHRASE = "Já vou pedir pra uma pessoa da equipe continuar com você por aqui 💙";

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
      "Nossos tamanhos vão do Prematuro ao 2:\n• Prematuro (até 47 cm) • PP/RN 0 a 1 mês (até 55 cm) • P 1 a 3 meses (até 61 cm) • M 3 a 6 meses (até 67 cm) • G 6 a 9 meses (até 72 cm) • GG/1 9 meses a 1 ano (até 76 cm) • 2 1 a 2 anos (até 88 cm)\nNa dúvida entre dois tamanhos, vale escolher o maior. Toque em \"Guia de Tamanhos\" na página do produto pra ver a tabela de medidas e o \"Como Medir\". Me diga a idade ou a altura do bebê que eu ajudo a escolher.",
  },
  {
    question: "Como funciona o frete? Qual o prazo de entrega?",
    alternates: "frete\nentrega\nprazo\nmotoboy\ncorreios\nchega quando\nquanto tempo\nfrete grátis",
    answer:
      "Frete grátis para compras com preço regular:\n• Cidade de SP: a partir de R$ 399 • Estado de SP: a partir de R$ 599 • Sul, Sudeste e Centro-Oeste: a partir de R$ 699 • Norte e Nordeste: a partir de R$ 799\nO prazo e o valor aparecem no carrinho quando você coloca o CEP. Entrega expressa em São Paulo e região (próximo dia útil): R$ 29,90. Em SP capital, Grande SP e ABC também tem motoboy no mesmo dia, para pedidos pagos até as 14h. Regras completas: https://laleblu.com.br/policies/shipping-policy",
  },
  {
    question: "Onde ficam as lojas? Qual o horário?",
    alternates:
      "loja\nlojas\nendereço\nhorário\nshopping\nmoema\nbertioga\nriviera\njardins\ncidade jardim\nonde fica\nvocês têm loja física\nloja perto\ntem loja em sp\nquantas lojas",
    answer:
      "Temos 4 lojas físicas (e a loja online, que entrega pro Brasil todo) 💙\n📍 Moema — Av. Bem-te-vi, 177 (CEP 04524-030), loja de rua · seg a sáb 10h–19h, fechada dom e feriados · WhatsApp (11) 95965-5533\n📍 Shopping Cidade Jardim — Av. Magalhães de Castro, 12.000, 3º piso · seg a sáb 10h–22h, dom e feriados 14h–20h · WhatsApp (11) 94535-7349\n📍 Shops Jardins — Rua Haddock Lobo, 1626, 1º piso · seg a sáb 10h–22h, dom e feriados 14h–20h · WhatsApp (11) 91497-8851\n📍 Shopping Riviera de São Lourenço — Av. da Riviera, 1256, Bertioga (CEP 11250-000), quiosque · todos os dias 10h–22h · (fala pelo WhatsApp de Moema)\nVer todas no mapa: https://laleblu.com.br/pages/nossas-lojas",
  },
  {
    question: "Quero criar meu chá de bebê / encontrar uma lista",
    alternates:
      "chá\ncha de bebe\nchá de bebê\nlista\npresentear\nlista de presentes\nquero criar\nencontrar lista\ngerenciar lista\nquem presenteou\nlista de desejos\nwishlist",
    answer:
      "Que fase linda 🍼 Você cria sua lista de chá de bebê em poucos minutos e compartilha o link com quem vai presentear.\n• Página do chá de bebê: https://laleblu.com.br/pages/cha-de-bebe\n• Criar a lista: https://laleblu.com.br/pages/cadastro-cha-de-bebe\n• Encontrar uma lista: https://laleblu.com.br/pages/encontre-seu-cha-de-bebe\n• Gerenciar a minha lista: https://laleblu.com.br/pages/cha-de-bebe-gerenciar-lista\n• Ver quem presenteou: https://laleblu.com.br/pages/cha-de-bebe-quem-presenteou\n• Lista de desejos: https://laleblu.com.br/pages/wish-list",
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
      "Presentear um bebê é sempre especial 💙 Temos kits prontos com as peças que mais combinam. Ver kits: https://laleblu.com.br/collections/presentes\nSe for para um chá de bebê, você também pode buscar a lista da família: https://laleblu.com.br/pages/encontre-seu-cha-de-bebe\nEmbalagem para presente (caixa, sacola e cartão): R$ 15,90, é só adicionar https://laleblu.com.br/products/caixa-sacola-e-cartao-para-presente",
  },
  {
    question: "Como funciona troca e devolução?",
    alternates: "troca\ntrocar\ndevolver\ndevolução\ndefeito\nestorno\narrependimento\nquero trocar",
    answer:
      "Nossa política é simples:\n• Troca: até 30 dias, peça sem uso e com etiqueta\n• Devolução (arrependimento): até 7 dias corridos após o recebimento\n• Peça com defeito: resolvemos com frete por nossa conta\nEm Sale e Black Friday há apenas devolução e defeito, não há troca. Me diz o número do pedido (começa com #) ou o e-mail da compra que eu já passo pra uma pessoa da equipe cuidar da sua troca por aqui 🤍\nPolítica completa: https://laleblu.com.br/policies/refund-policy",
  },
  {
    question: "Cadê meu pedido? Quero rastrear",
    alternates:
      "pedido\nrastreio\nrastrear\ncódigo\nstatus\nnão chegou\natrasou\ncadê meu pedido\nnota fiscal\nmeu pedido",
    answer:
      "Vamos verificar pra você 🤍 Me manda o número do pedido (começa com #) ou o e-mail da compra que eu já peço pra uma pessoa da equipe consultar e te responder aqui mesmo.",
  },
  {
    question: "Tem cupom de desconto? Como faço pra parcelar?",
    alternates:
      "cupom\ncoupom\ndesconto\npromoção\nprimeira compra\ncódigo de desconto\ntem desconto\nvip10\nparcelar\nparcelamento\nquantas vezes\nsem juros\n6x",
    answer:
      "Cupons que você pode usar:\n• PRIMEIRACOMPRA — 5% na primeira compra (cupom da newsletter, sem valor mínimo)\n• VIP10 — 10% em compras acima de R$ 299, válido até 30/11/2026 (Clube VIP: https://laleblu.com.br/pages/clube-vip)\nÉ um cupom por pedido e eles não acumulam entre si. O parcelamento é em até 6x sem juros no cartão. Formas de pagamento: https://laleblu.com.br/pages/formas-de-pagamento",
  },
  {
    question: "Vocês têm moda praia para bebê?",
    alternates: "praia\nmaiô\nbiquíni\nsunga\npiscina\nUV\nmoda praia\nproteção solar\nfps",
    answer:
      "Nossa linha Moda Praia para Bebê tem maiôs, biquínis, sungas, camisetas e chapéus com proteção UV FPS 50+ ☀️ Do Prematuro ao GG/1: https://laleblu.com.br/collections/moda-praia",
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
      "Poxa, vamos resolver isso 💙 Duas coisas que costumam funcionar na hora:\n• Se foi cartão, tente o Pix, a aprovação é imediata\n• Confira se o CEP e o endereço estão completos\nTentar de novo: https://laleblu.com.br/cart\nSe ainda assim não der, me conta o que apareceu na tela que eu chamo uma pessoa da equipe pra finalizar a compra com você por aqui.",
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
      "Quando uma cor ou tamanho está esgotado, o jeito mais fácil é tocar em \"Notifique-me\" no tamanho desejado, na página do produto: assim que voltar ao estoque, você recebe o aviso 🤍 Se quiser uma previsão de quando volta, me diga qual peça e qual cor que eu peço pra uma pessoa da equipe confirmar por aqui.",
  },
  {
    question: "Qual o contato / WhatsApp de vocês?",
    alternates: "contato\ntelefone\nwhatsapp\nnúmero\nzap\nfalar com vocês\nfalar com atendente\nfalar com uma pessoa",
    answer:
      "Você já está no nosso WhatsApp oficial, é aqui mesmo que a gente te atende 💙 Se quiser, eu chamo uma pessoa da equipe pra continuar com você.\nPra falar direto com uma loja: Moema (11) 95965-5533 · Cidade Jardim (11) 94535-7349 · Shops Jardins (11) 91497-8851. A loja da Riviera (Bertioga) atende pelo WhatsApp de Moema. Ver as lojas: https://laleblu.com.br/pages/nossas-lojas",
  },
  {
    question: "Qual o WhatsApp de uma loja específica?",
    alternates:
      "whatsapp da loja\ncontato da loja\nfalar com a loja\nnúmero da moema\nzap da moema\nnúmero de jardins\nnúmero de cidade jardim\ntelefone da loja\nligar na loja",
    answer:
      "Os contatos por loja:\n• Moema: (11) 95965-5533 — https://wa.me/5511959655533\n• Shopping Cidade Jardim: (11) 94535-7349 — https://wa.me/5511945357349\n• Shops Jardins: (11) 91497-8851 — https://wa.me/5511914978851\n• Riviera de São Lourenço (Bertioga): ainda sem WhatsApp próprio — fale com Moema (11) 95965-5533\nMe diz qual loja que eu te passo o link certo.",
  },
  {
    question: "As lojas abrem domingo e feriado?",
    alternates: "domingo\nferiado\nfim de semana\nsábado\nabre hoje\naberto agora\nhorário de domingo\nfunciona no feriado",
    answer:
      "Domingos e feriados abrem: Shopping Cidade Jardim e Shops Jardins (14h às 20h) e o quiosque da Riviera de São Lourenço, em Bertioga (10h às 22h). A loja de Moema NÃO abre aos domingos e feriados. De segunda a sábado, todas abrem.",
  },
  {
    question: "Vocês têm essa peça na loja física? Dá pra reservar?",
    alternates:
      "tem na loja\ntem em estoque na loja\nreservar\nseparar\ndisponível na loja\nretirar na loja\nir buscar na loja\ntem no shopping",
    answer:
      "Pra confirmar se uma peça está na loja e reservar, o melhor é falar direto com a unidade: Moema (11) 95965-5533 · Cidade Jardim (11) 94535-7349 · Shops Jardins (11) 91497-8851 (a Riviera, em Bertioga, atende pelo WhatsApp de Moema). Me diz qual loja que eu te passo o link.",
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

  // --- Guia de links do site (doc "LALEBLU - Guia de Links para o Atendimento", 01/09/2026) ---
  {
    question: "Quero ver as novidades, os mais vendidos ou a loja toda",
    alternates:
      "novidade\nnovidades\nlançamento\nlançamentos\nnovo\ntem de novo\no que chegou\nmais vendidos\nmais vendido\nmais procurado\nver tudo\ntoda a loja\nloja inteira\ncatálogo\nvitrine",
    answer:
      "Direto pra você 🤍\n• Novidades: https://laleblu.com.br/collections/novidades\n• Mais vendidos: https://laleblu.com.br/collections/toda-a-loja?sort_by=best-selling\n• Ver a loja toda: https://laleblu.com.br/collections/toda-a-loja\n• Sale (com desconto): https://laleblu.com.br/collections/sale",
  },
  {
    question: "Quero ver roupas de menina, de menino ou neutras",
    alternates:
      "menina\nmenino\nneutro\nneutra\nunissex\nnão sei o sexo\nnão sei o sexo ainda\npra menina\npra menino\nsem saber o sexo\npeças neutras",
    answer:
      "• Menina: https://laleblu.com.br/collections/meninas\n• Menino: https://laleblu.com.br/collections/meninos\n• Neutro / unissex: https://laleblu.com.br/collections/unissex\nSe quiser já filtrado por tamanho, me diz o tamanho (Prematuro, PP/RN, P, M, G, GG/1 ou 2) que eu monto o link.",
  },
  {
    question: "Quais tipos de roupa vocês têm? (macacão, body, casaco, conjunto...)",
    alternates:
      "macacão\nmacacao\nbody\nbodies\nbody com gola\nmacacão curto\ncalça\nculote\nmijão\ncasaco\nconjunto\nconjuntos\nsaco de dormir\nbásico\nbasicos\ntipo de peça\ncategoria\nque roupas tem",
    answer:
      "Nossas categorias de roupa:\n• Todas as roupas: https://laleblu.com.br/collections/roupas\n• Macacões e vestidos: https://laleblu.com.br/collections/macacoes-e-vestidos\n• Macacão curto (verão): https://laleblu.com.br/collections/macacao-curto\n• Bodies, calças e culotes: https://laleblu.com.br/collections/bodies\n• Body com gola: https://laleblu.com.br/collections/body-com-gola\n• Calça, culote ou mijão: https://laleblu.com.br/collections/calca-culote-ou-mijao\n• Casacos: https://laleblu.com.br/collections/casaco\n• Conjuntos: https://laleblu.com.br/collections/conjuntos\n• Básicos (dia a dia): https://laleblu.com.br/collections/basicos\n• Saco de dormir: https://laleblu.com.br/collections/saco-de-dormir\n• Moda praia (UV FPS 50+): https://laleblu.com.br/collections/moda-praia",
  },
  {
    question: "Quero ver por tipo de tecido (pima, suedine, tricô, plush, soft, linho)",
    alternates:
      "tecido\nmaterial\npima\nalgodão pima\nsuedine\negípcio\negipcio\ntricô\ntricot\ntricotil\nplush\nsoft\nmalha\nmalha uv\nlinho\nquentinho\nfresquinho\ninverno\nverão\nquente\nleve",
    answer:
      "Dá pra ver por tecido:\n• Coleção PIMA: https://laleblu.com.br/collections/pima\n• Macacões Algodão Pima: https://laleblu.com.br/collections/macacoes-algodao-pima\n• Macacões Egípcio, Suedine e Tricotil: https://laleblu.com.br/collections/macacoes-egipcio-suedine-e-tricotil\n• Macacões Soft e Plush (inverno): https://laleblu.com.br/collections/macacoes-soft-e-plush\nEm qualquer coleção dá pra filtrar pelo tecido acrescentando ?filter.p.m.custom.material=Tricot no fim do link (troque o tecido; \"Algodão Pima\" vira Algod%C3%A3o+Pima, \"Malha UV\" vira Malha+UV).",
  },
  {
    question: "Tem em rosa, azul, branco ou outra cor?",
    alternates:
      "cor\ncores\nrosa\nazul\nbranco\nbege\namarelo\nverde\nvermelho\ncinza\nroxo\nlavanda\nem qual cor\nque cores tem\ntem em outra cor",
    answer:
      "Pra ver por cor, é só acrescentar ?filter.p.m.custom.cor_para_filtro=Rosa no fim de qualquer link (troque a cor: Rosa, Azul, Branco, Bege, Amarelo, Verde, Vermelho, Cinza, Roxo).\nExemplo — tudo em azul: https://laleblu.com.br/collections/toda-a-loja?filter.p.m.custom.cor_para_filtro=Azul",
  },
  {
    question: "Quero uma saída de maternidade",
    alternates:
      "saída de maternidade\nsaida de maternidade\nsair da maternidade\nprimeira roupinha\nprimeira roupa\nroupa do parto\nlook da maternidade\nmacacão de sair da maternidade",
    answer:
      "Nossas saídas de maternidade (macacões e vestidos): https://laleblu.com.br/collections/macacoes-e-vestidos-saidas-maternidade\n• Menina: https://laleblu.com.br/collections/macacoes-e-vestidos-saidas-maternidade?filter.p.m.custom.genero=Menina\n• Menino: https://laleblu.com.br/collections/macacoes-e-vestidos-saidas-maternidade?filter.p.m.custom.genero=Menino\n• Unissex: https://laleblu.com.br/collections/macacoes-e-vestidos-saidas-maternidade?filter.p.m.custom.genero=Unissex\nSugestões de looks: https://laleblu.com.br/pages/saida-maternidade-looks\nO tricô em linha é o queridinho: mantém a temperatura do bebê sem esquentar demais.",
  },
  {
    question: "Tem roupa para bebê prematuro?",
    alternates:
      "prematuro\nprematura\nbebê prematuro\nnasceu antes\nbaixo peso\nrn pequeno\n34 semanas\n35 semanas\nmenor que rn",
    answer:
      "Temos uma seleção pro tamanho Prematuro: https://laleblu.com.br/collections/prematuro 🤍 Me diz se é menina, menino ou neutro que eu ajudo a escolher.",
  },
  {
    question: "Vocês têm mantas, cueiros e cobertores?",
    alternates:
      "manta\nmantas\ncueiro\ncueiros\ncobertor\ncobertores\nedredom\nxale\nvira manta\nmanta de berço\nmanta de tricot\nmanta de malha",
    answer:
      "Temos sim:\n• Todas as mantas: https://laleblu.com.br/collections/mantas\n• Mantas de tricot: https://laleblu.com.br/collections/mantas-tricot\n• Mantas de malha: https://laleblu.com.br/collections/mantas-malha\n• Manta de berço: https://laleblu.com.br/collections/manta-de-berco\n• Cueiros: https://laleblu.com.br/collections/cueiros\n• Mantas e cueiros básicos: https://laleblu.com.br/collections/mantas-e-cueiros\n• Vira manta: https://laleblu.com.br/collections/vira-manta\n• Cobertores: https://laleblu.com.br/collections/cobertores-mantas\n• Edredom: https://laleblu.com.br/collections/edredom\n• Xale: https://laleblu.com.br/collections/xale\nMantas e cueiros são tamanho único, então não aparecem em links filtrados por tamanho.",
  },
  {
    question: "Quais itens de enxoval vocês têm? (lençol, toalha, fralda, bolsa...)",
    alternates:
      "enxoval\nberço\nbanho\nlençol\njogo de lençol\ntoalha\ntoalha de banho\nprotetor de colchão\nalmofada redutora\nfralda de boca\nfralda de ombro\nnécessaire\norganizador\nbolsa\nmochila\nbolsa térmica\nmala maternidade\nporta documentos",
    answer:
      "Nosso enxoval por categoria:\n• Enxoval completo: https://laleblu.com.br/collections/enxoval\n• Berço e banho: https://laleblu.com.br/collections/berco-e-banho\n• Jogos de lençol: https://laleblu.com.br/collections/jogos-de-lencol\n• Toalha de banho: https://laleblu.com.br/collections/toalha-de-banho\n• Protetor para colchão: https://laleblu.com.br/collections/protetor-para-colchao\n• Almofada redutora: https://laleblu.com.br/collections/almofada-redutora\n• Fralda de boca: https://laleblu.com.br/collections/fralda-de-boca-enxoval\n• Fralda de ombro: https://laleblu.com.br/collections/fralda-de-ombro-enxoval\n• Para organizar: https://laleblu.com.br/collections/para-organizar\n• Bolsas e mochilas: https://laleblu.com.br/collections/bolsas-e-mochilas\n• Bolsa térmica: https://laleblu.com.br/collections/bolsa-termica\nChecklist interativo do enxoval: https://laleblu.com.br/pages/checklist-enxoval",
  },
  {
    question: "Vocês têm acessórios? (naninha, sapatinho, touca, meia, laço, babador)",
    alternates:
      "acessório\nacessórios\nnaninha\nsapatinho\nsapatinhos\ntouca\nluva\ntoucas e luvas\nmeia\nmeias\nfaixa\nlaço\nfaixas e laços\nprendedor de chupeta\nbabador\nbabadores\ncuidados\nhigiene\nescova\npente\nhome spray",
    answer:
      "Temos:\n• Todos os acessórios: https://laleblu.com.br/collections/acessorios\n• Naninhas: https://laleblu.com.br/collections/naninhas\n• Sapatinhos: https://laleblu.com.br/collections/sapatinhos\n• Toucas e luvas: https://laleblu.com.br/collections/toucas-e-luvas\n• Meias: https://laleblu.com.br/collections/meias\n• Faixas e laços: https://laleblu.com.br/collections/faixas-e-lacos\n• Prendedor de chupeta: https://laleblu.com.br/collections/prendedor-de-chupetas\n• Babadores: https://laleblu.com.br/collections/babadores\n• Cuidados (higiene): https://laleblu.com.br/collections/cuidados\n• Escova e pente: https://laleblu.com.br/collections/escova-e-pente\n• Home spray: https://laleblu.com.br/collections/home-spray\nAcessórios são tamanho único, não aparecem em links filtrados por tamanho.",
  },
  {
    question: "Vocês fazem peças com o nome bordado?",
    alternates:
      "personalizado\npersonalizados\nnome bordado\nbordar o nome\ncom o nome\nmonograma\nbordado\niniciais\ncom o nome do bebê",
    answer:
      "Fazemos sim 💙\n• Todos os personalizados: https://laleblu.com.br/collections/personalizados\n• Fralda de boca e ombro personalizada: https://laleblu.com.br/collections/fralda-de-boca-e-ombro-personalizada\n• Touca personalizada: https://laleblu.com.br/collections/touca-para-bebe-personalizada\n• Faixa de cabelo personalizada: https://laleblu.com.br/collections/faixa-de-cabelo-para-bebe-personalizada\nO prazo de produção da peça personalizada aparece na página do produto.",
  },
  {
    question: "Tem roupa para batizado, Natal, Páscoa ou de coleção temática?",
    alternates:
      "batizado\ntoalha de batizado\nnatal\npáscoa\npascoa\nfutebol\nbrasil\nchá revelação\ncha revelacao\ndata especial\ncoleção\nbonequinha\ncachorrinho\nleãozinho\nsuper heróis\nurso petit\nsafari\ncolors\nsoninho\nmimos\ntemática",
    answer:
      "Datas especiais:\n• Geral: https://laleblu.com.br/collections/datas-especiais\n• Batizado: https://laleblu.com.br/collections/batizado · Toalha de batizado: https://laleblu.com.br/collections/toalha-de-batizado\n• Natal: https://laleblu.com.br/collections/natal · Páscoa: https://laleblu.com.br/collections/pascoa\n• Futebol: https://laleblu.com.br/collections/futebol · Brasil: https://laleblu.com.br/collections/brasil\n• Chá revelação: https://laleblu.com.br/collections/cha-revelacao\nColeções temáticas: Bonequinha https://laleblu.com.br/collections/colecao-bonequinha · Cachorrinho https://laleblu.com.br/collections/colecao-cachorrinho · Leãozinho https://laleblu.com.br/collections/colecao-leaozinho · Super Heróis https://laleblu.com.br/collections/colecao-super-herois · Urso Petit https://laleblu.com.br/collections/urso-petit · Safari https://laleblu.com.br/collections/safari · Soninho https://laleblu.com.br/collections/colecao-soninho · Colors https://laleblu.com.br/collections/colecao-colors · Mimos https://laleblu.com.br/collections/colecao-mimos · Zíper estampado https://laleblu.com.br/collections/colecao-ziper-estampado · Histórias Laleblu https://laleblu.com.br/collections/historias-laleblu\nTodas as coleções: https://laleblu.com.br/collections",
  },
  {
    question: "Quero um presente dentro de um valor",
    alternates:
      "presente até\npresente de\nquanto gastar\nfaixa de preço\npresente barato\npresente até 150\npresente 200\npresente 300\nvalor do presente\nembalagem de presente\ncaixa de presente",
    answer:
      "A vitrine de presentes filtra por valor:\n• Até R$ 150: https://laleblu.com.br/collections/presentes?filter.v.price.lte=150\n• De R$ 150 a R$ 300: https://laleblu.com.br/collections/presentes?filter.v.price.gte=150&filter.v.price.lte=300\n• Acima de R$ 300: https://laleblu.com.br/collections/presentes?filter.v.price.gte=300\n• Para menina: https://laleblu.com.br/collections/presentes?filter.p.m.custom.genero=Menina\n• Para menino: https://laleblu.com.br/collections/presentes?filter.p.m.custom.genero=Menino\nEmbalagem (caixa, sacola e cartão) por R$ 15,90: https://laleblu.com.br/products/caixa-sacola-e-cartao-para-presente",
  },
  {
    question: "Como funcionam os kits de presente? Tem desconto no kit?",
    alternates:
      "kit\nkits\nkit presente\nkit de presente\ndesconto no kit\ncomo compro o kit\ncombo\ndesconto de kit",
    answer:
      "O kit é uma sugestão de combinação 🤍 A compra é feita pelas peças individuais: você abre o kit, toca em cada peça e adiciona ao carrinho. O preço que aparece no kit é a soma das peças — não há desconto de kit. Ver os kits: https://laleblu.com.br/collections/presentes",
  },
  {
    question: "Onde vejo a central de ajuda, quem somos, minha conta?",
    alternates:
      "central de ajuda\najuda\nquem somos\nsobre a loja\nsobre vocês\nminha conta\nmeus pedidos\ncriar conta\nlogin\nfale conosco\ncontato\nlink da bio\ntodos os links\npolítica\nformas de pagamento",
    answer:
      "• Central de ajuda: https://laleblu.com.br/pages/central-de-ajuda\n• Perguntas frequentes: https://laleblu.com.br/pages/perguntas-frequentes\n• Trocas e devoluções: https://laleblu.com.br/policies/refund-policy\n• Entrega e frete: https://laleblu.com.br/policies/shipping-policy\n• Formas de pagamento: https://laleblu.com.br/pages/formas-de-pagamento\n• Quem somos: https://laleblu.com.br/pages/quem-somos\n• Clube VIP: https://laleblu.com.br/pages/clube-vip\n• Minha conta / meus pedidos: https://laleblu.com.br/account/login\n• Criar conta: https://laleblu.com.br/account/register\n• Fale conosco: https://laleblu.com.br/pages/contact\n• Todos os links (bio): https://laleblu.com.br/pages/links",
  },
  {
    question: "Como monto um link do site já filtrado pelo que a cliente pediu?",
    alternates:
      "montar link\nlink filtrado\nfiltro\nfiltrar\nurl com filtro\nlink por tamanho\nlink por cor\nlink por preço\ncomo filtro o site",
    answer:
      "Comece pela URL da categoria e junte os filtros depois de \"?\", separando com \"&\":\n• tamanho: filter.v.option.tamanho=P (Prematuro, PP%2FRN, P, M, G, GG%2F1, 2)\n• gênero: filter.p.m.custom.genero=Menina (Menina · Menino · Unissex)\n• tecido: filter.p.m.custom.material=Tricot\n• cor: filter.p.m.custom.cor_para_filtro=Rosa\n• preço: filter.v.price.gte=150&filter.v.price.lte=300\n• ordenar: sort_by=best-selling · price-ascending · created-descending\nExemplo — bodies de menina tamanho M por menor preço: https://laleblu.com.br/collections/bodies?filter.p.m.custom.genero=Menina&filter.v.option.tamanho=M&sort_by=price-ascending\nBarra \"/\" vira %2F, espaço vira \"+\", acento vira código (Algod%C3%A3o+Pima). Na dúvida, mande o link da categoria sem filtro.",
  },
];

const TEMPLATES: { name: string; body: string; mode: string; whenToUse: string }[] = [
  {
    name: "Boas-vindas",
    mode: "adapt",
    whenToUse: "primeira mensagem de alguém novo, ou quando a pessoa só manda um oi",
    body: "Oi! Que bom ter você por aqui 💙 Posso te ajudar com enxoval, presentes, chá de bebê, tamanhos e frete, e chamo uma pessoa da equipe se for sobre um pedido já feito. Por onde quer começar?",
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
    whenToUse: "logo antes de chamar transfer_to_human, de segunda a sexta entre 9h e 17h",
    body: "Perfeito, já vou pedir pra uma pessoa da equipe continuar com você por aqui 🤍 É rapidinho.",
  },
  {
    name: "Transferir fora do horário",
    mode: "exact",
    whenToUse: "logo antes de chamar transfer_to_human fora de seg a sex, 9h às 17h",
    body: "Nossa equipe atende de segunda a sexta, das 9h às 17h. Já deixei sua mensagem registrada aqui e uma pessoa te responde no próximo horário de atendimento 💙",
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
    triggerText: "pergunta sobre um pedido já feito: rastreio, atraso, status, nota fiscal, cadê meu pedido",
    goal: "levar o caso pra uma pessoa da equipe resolver nesta mesma conversa",
    steps: [
      "Diga com acolhimento que vai pedir pra uma pessoa da equipe verificar o pedido.",
      "Peça o número do pedido (começa com #) ou o e-mail da compra.",
      "Assim que tiver esse dado (ou se a pessoa não tiver em mãos), chame transfer_to_human com o resumo: nome, o que ela quer e o número/e-mail do pedido.",
      "Nunca tente rastrear ou dar status por conta própria. Nunca mande link de WhatsApp nem número: esta conversa já é o WhatsApp da loja.",
    ],
  },
  {
    name: "Troca ou devolução",
    scriptType: "transferir",
    triggerText: "quer trocar, devolver, falar de defeito ou estorno",
    goal: "dar a política resumida e passar pra uma pessoa da equipe nesta conversa",
    steps: [
      "Resuma a política: troca em até 30 dias (sem uso, com etiqueta), devolução em até 7 dias corridos, defeito com frete por nossa conta. Em Sale/Black Friday só devolução e defeito.",
      "Mande o link da política: https://laleblu.com.br/policies/refund-policy",
      "Peça o número do pedido (#) ou o e-mail da compra e chame transfer_to_human com esse resumo pra uma pessoa da equipe cuidar da troca aqui.",
    ],
  },
  {
    name: "Não conseguiu finalizar a compra",
    scriptType: "transferir",
    triggerText: "tentou comprar e não conseguiu, erro no pagamento, cartão recusado",
    goal: "dar as duas soluções rápidas e, se não resolver, passar pra uma pessoa da equipe",
    steps: [
      "Reconheça com leveza e um toque de urgência (a pessoa está com o cartão na mão).",
      "Dê as duas soluções: tentar pagar com Pix (aprovação imediata) e conferir se CEP e endereço estão completos.",
      "Ofereça o link do carrinho pra tentar de novo: https://laleblu.com.br/cart",
      "Se não resolver, peça o que apareceu na tela e chame transfer_to_human pra uma pessoa da equipe finalizar a compra com a cliente aqui. Nunca mande link de WhatsApp.",
    ],
  },
  {
    name: "Montar link do site com filtro",
    scriptType: "livre",
    triggerText: "a cliente pede algo específico: gênero + tamanho, uma cor, um tecido ou uma faixa de preço",
    goal: "enviar um link da vitrine já filtrado com o que a cliente pediu, sem ela precisar mexer em nada",
    steps: [
      "Identifique o que ela pediu: categoria (macacão, body, saída de maternidade...), gênero, tamanho, cor, tecido, faixa de preço.",
      "Comece pela URL da categoria (ex: https://laleblu.com.br/collections/bodies). Sem categoria específica, use toda-a-loja, meninas, meninos ou unissex.",
      "Junte os filtros depois de '?', separando com '&': tamanho = filter.v.option.tamanho=P · gênero = filter.p.m.custom.genero=Menina (Menina/Menino/Unissex) · tecido = filter.p.m.custom.material=Tricot · cor = filter.p.m.custom.cor_para_filtro=Rosa · preço = filter.v.price.gte=150&filter.v.price.lte=300 · ordenar = sort_by=best-selling (ou price-ascending, created-descending).",
      "Codifique os caracteres especiais: '/' vira %2F (PP%2FRN, GG%2F1), espaço vira '+' (Malha+UV), acento vira código (Algod%C3%A3o+Pima).",
      "Exemplo: bodies de menina tamanho M por menor preço = https://laleblu.com.br/collections/bodies?filter.p.m.custom.genero=Menina&filter.v.option.tamanho=M&sort_by=price-ascending",
      "Na dúvida sobre a URL da categoria, mande o link da categoria sem filtro e diga que dá pra filtrar na própria página. Nunca invente um endereço.",
      "Mantas, naninhas e acessórios são tamanho único: mande o link da categoria, sem o filtro de tamanho.",
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
  { category: "tom_de_voz", instruction: "Logo antes de chamar transfer_to_human, mande uma frase curta e acolhedora dizendo que uma pessoa da equipe vai continuar por ali. Não diga 'vou te transferir para um atendente' de forma robótica." },
  // catalogo / informacao
  { category: "procedimentos", instruction: "Nunca prometa nem afirme estoque, disponibilidade de cor ou tamanho, prazo exato de entrega ou status de um pedido. Esses dados mudam e não estão com você: mande o link da peça ou da coleção no site e o botão 'Notifique-me' na página. Se a pessoa insistir numa confirmação agora, use transfer_to_human — nunca mande link de WhatsApp." },
  { category: "procedimentos", instruction: "Preço é sempre pelo site, que tem valor e estoque em tempo real. Se a pessoa mandar print ou nome de peça pedindo valor, mande o link da peça ou da coleção. Se ela insistir, use transfer_to_human." },
  { category: "procedimentos", instruction: "Tecidos: Suedine, Tricotil, Algodão Pima e Algodão Egípcio são 100% algodão. Peças em Soft, Napa Soft e Plush NÃO são 100% algodão: se a pergunta citar esses materiais, não afirme a composição; diga que confirma e, se a pessoa quiser essa confirmação na hora, use transfer_to_human." },
  { category: "procedimentos", instruction: "A tabela de tamanhos vai do Prematuro ao 2. Na dúvida entre dois tamanhos, oriente escolher o maior. As medidas em centímetros de cada peça estão na página do produto." },
  { category: "procedimentos", instruction: "Frete grátis vale só para compras com preço regular, não vale em Sale nem Black Friday." },
  { category: "procedimentos", instruction: "Em Sale e Black Friday não há troca, apenas devolução e peça com defeito." },
  // pagamento / cupom
  { category: "pagamento", instruction: "Cupons que podem ser informados: PRIMEIRACOMPRA (5% na primeira compra, cupom da newsletter, sem valor mínimo) e VIP10 (10% em compras acima de R$ 299, válido até 30/11/2026, do Clube VIP). Um cupom por pedido, não acumulam entre si. Nenhum outro código de promoção deve ser informado: convide para o Clube VIP. Se pedirem outro código específico, use transfer_to_human." },
  { category: "pagamento", instruction: "O parcelamento é em até 6x sem juros no cartão. O Pix tem aprovação imediata. Formas de pagamento: https://laleblu.com.br/pages/formas-de-pagamento" },
  { category: "procedimentos", instruction: "Entrega expressa (São Paulo e região, próximo dia útil) custa R$ 29,90. Motoboy no mesmo dia para capital, Grande SP e ABC, pedidos até as 14h. O valor e o prazo do frete aparecem no carrinho quando a cliente coloca o CEP." },
  { category: "procedimentos", instruction: "Quando a cliente pedir algo específico (gênero, tamanho, cor, tecido ou faixa de preço), monte o link da coleção já filtrado seguindo o roteiro 'Montar link do site com filtro' e mande pronto. Se não tiver certeza da URL exata da categoria, mande o link da categoria sem filtro (ou toda-a-loja com o filtro). Nunca invente um endereço de coleção: use só os que estão nas FAQ e nos roteiros." },
  { category: "procedimentos", instruction: "Mantas, cueiros, naninhas e acessórios são tamanho único e não aparecem em links filtrados por tamanho: nesses casos mande o link da categoria, sem o filtro de tamanho." },
  // chamar a equipe
  { category: "chamar_equipe", instruction: "A Alice atende PELO próprio WhatsApp oficial da Laleblu. É proibido, em qualquer resposta: mandar link de WhatsApp (wa.me) ou número pra 'falar com a equipe' de forma genérica, ou mandar a pessoa procurar o atendimento em outro canal. Esta conversa já é o atendimento. Quando precisa de uma pessoa, é sempre transfer_to_human. EXCEÇÃO: os números/links das LOJAS FÍSICAS podem ser enviados quando a pessoa pede o contato de uma loja, quer confirmar/reservar uma peça numa loja, ou é do litoral/Bertioga — são números das lojas, diferentes deste atendimento central." },
  { category: "procedimentos", instruction: "Lojas físicas (endereço · horário · WhatsApp): Moema — Av. Bem-te-vi, 177, loja de rua · seg-sáb 10h-19h, fechada dom e feriados · (11) 95965-5533 (wa.me/5511959655533). Shopping Cidade Jardim — Av. Magalhães de Castro, 12.000, 3º piso · seg-sáb 10h-22h, dom e feriados 14h-20h · (11) 94535-7349 (wa.me/5511945357349). Shops Jardins — Rua Haddock Lobo, 1626, 1º piso · mesmos horários de Cidade Jardim · (11) 91497-8851 (wa.me/5511914978851). Riviera de São Lourenço — Av. da Riviera, 1256, Bertioga, quiosque · todos os dias 10h-22h · ainda sem WhatsApp próprio, usar o de Moema. Página: https://laleblu.com.br/pages/nossas-lojas" },
  { category: "procedimentos", instruction: "Domingo e feriado: abrem só Shopping Cidade Jardim e Shops Jardins (14h-20h) e a Riviera de São Lourenço, em Bertioga (10h-22h). Moema não abre. Cliente do litoral / Bertioga / Riviera: indicar a unidade Riviera de São Lourenço." },
  { category: "chamar_equipe", instruction: "Pedido, troca, devolução, rastreio e problema de pagamento: peça o número do pedido (começa com #) ou o e-mail da compra e chame transfer_to_human com esse resumo. Não tente consultar nem resolver o pedido sozinha." },
  { category: "chamar_equipe", instruction: "O atendimento humano é de segunda a sexta, das 9h às 17h. Ao usar transfer_to_human nesse horário, diga que uma pessoa da equipe já continua por aqui. Fora do horário, diga que a mensagem ficou registrada e uma pessoa responde no próximo horário de atendimento." },
  { category: "chamar_equipe", instruction: "Se a pessoa marcar a loja num story (foto do bebê com a peça), agradeça e pergunte se pode repostar. Se ela autorizar, use transfer_to_human com o motivo 'autorização de repost'." },
  { category: "chamar_equipe", instruction: "Você enxerga as fotos que o cliente envia. Se for foto de um produto, do bebê com uma peça, ou print de tela do site, ajude normalmente. Se for spam (print de investimento, corrente, propaganda de terceiro), não responda." },
  { category: "procedimentos", instruction: "Quando o cliente mandar foto de uma peça ou print pedindo cor, modelo ou 'o que tem disponível': diga o que dá pra ver (tipo de peça, cor, estampa) e MANDE O LINK do site — a busca pelo nome da peça, ou a coleção com o filtro de cor. NUNCA diga pra ela 'falar com a equipe' pra ver cores ou modelos: isso você resolve com o link do site. Só se ela não conseguir achar e insistir muito é que você usa transfer_to_human." },
  { category: "chamar_equipe", instruction: "Pedido de previsão de chegada de uma cor ou tamanho esgotado: peça qual peça e qual cor e use transfer_to_human, que a equipe dá a previsão real." },
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
      replyDelaySeconds: 10,
      // notifyPhone NAO entra aqui de proposito: e configurado no painel e nao
      // pode ser o proprio numero conectado (WhatsApp nao manda mensagem pra si).
      notifyEvents: "human_handoff",
      handoffPhrase: HANDOFF_PHRASE,
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
      replyDelaySeconds: 10,
      notifyPhone: "",
      notifyEvents: "human_handoff",
      handoffPhrase: HANDOFF_PHRASE,
      plan: "prime",
    },
  });
  console.log(`Clinica: ${clinic.name} (${clinic.id}) — businessType=${clinic.businessType}`);

  // O numero de avisos nao pode ser o proprio numero conectado (WhatsApp nao
  // envia pra si mesmo). Se ficou assim de um seed antigo, limpa - sem mexer
  // num numero de verdade que a Laleblu tenha configurado no painel.
  if (clinic.notifyPhone && clinic.notifyPhone.replace(/\D/g, "") === WA) {
    await prisma.clinic.update({ where: { id: clinic.id }, data: { notifyPhone: "" } });
    console.log("notifyPhone: limpo (era o proprio numero conectado) — configure um numero da equipe no painel");
  }

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
