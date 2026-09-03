import "dotenv/config";
import { fileURLToPath } from "url";
import { prisma } from "../db/client.js";
import { hashPassword } from "../api/passwords.js";
import { seedDefaultRules } from "../ai/rules.js";
import { getFunnelStages } from "../crm/stages.js";

// Configuracao inicial da Harmonizze Clinic a partir do briefing recebido em
// 03/09/2026. O seed e idempotente: atualiza apenas os registros que ele
// gerencia e pode ser executado novamente sem criar duplicatas.

const WA = "5511925585764"; // formato canonico 55DDDNUMERO
// Formas sem DDI que um cadastro manual no painel pode ter gravado antes do
// pareamento (o painel so remove os nao-digitos, nao acrescenta o 55). Sem
// isso, o seed nao acharia a clinica e criaria uma duplicada.
const WA_FALLBACKS = ["11925585764"];
const LOGIN = "harmonizze@aliceconversa.com";
// Senha inicial da conta de acesso. So e aplicada quando a conta e criada;
// re-rodar o seed nunca sobrescreve uma senha que o cliente ja trocou.
const INITIAL_PASSWORD = process.env.HARMONIZZE_INITIAL_PASSWORD?.trim() || "harmonizze1234";
const SEED_MARKER = "seed:harmonizze";

const PROCEDURES = [
  {
    name: "Avaliação com a Dra. Hellen Matias",
    durationMin: 60,
    description:
      "Consulta inicial para ouvir a queixa, entender o objetivo do paciente e definir com segurança se existe indicação e qual tratamento faz sentido.",
    goals: "entender qual procedimento pode ser indicado\nesclarecer dúvidas\nplanejar um tratamento individualizado",
    benefits: "avaliação individualizada\nplanejamento conduzido pela Dra. Hellen Matias",
    aliases: "avaliação,consulta,primeira consulta",
    resultTimeline: null,
  },
  {
    name: "Lipo de Papada",
    durationMin: 60,
    description:
      "Procedimento facial indicado após avaliação. O pós-operatório pode incluir faixa, curativos, drenagens e medicação exatamente conforme a prescrição e as orientações da equipe.",
    goals: "papada\ncontorno mandibular pouco definido\nflacidez no pescoço\naparência de bulldog\nsorriso triste\nbochechas caídas",
    benefits:
      "aparência facial mais jovem\nredução da papada\ncontorno da mandíbula mais marcado\nredução da flacidez no pescoço\nmelhora da aparência de bulldog",
    aliases: "lipoaspiração de papada,remoção de papada,lipo cervical",
    resultTimeline: "Mudanças podem ser percebidas logo após o procedimento e evoluem por até 90 dias.",
  },
  { name: "Botox", aliases: "toxina botulínica,toxina" },
  { name: "Preenchimento", aliases: "preenchimento facial" },
  { name: "Preenchimento Full Face", aliases: "full face,preenchimento fullface" },
  { name: "Platismoplastia", aliases: "cirurgia do platisma" },
  { name: "Lifting Facial", aliases: "lifting de face,ritidoplastia" },
  { name: "Deep Plane", aliases: "deep plane facelift,deep planner" },
  { name: "Otoplastia", aliases: "cirurgia de orelha" },
  { name: "Blefaroplastia", aliases: "cirurgia das pálpebras" },
  { name: "Preenchimento Labial", aliases: "preenchimento de lábios" },
  { name: "Lentes de Contato Dental", aliases: "lentes dentais,lentes de contato nos dentes" },
] as const;

const FAQS = [
  {
    question: "Qual é o horário de atendimento?",
    alternates: "horário\nfuncionamento\nabre que horas\nfecha que horas\natende sábado\nsábado",
    answer: "Atendemos de segunda a sexta-feira, das 8h30 às 18h. Não há atendimento aos sábados.",
  },
  {
    question: "Como funciona a primeira consulta ou avaliação?",
    alternates: "como é a avaliação\nprimeira consulta\nconsulta inicial\ncomo funciona a consulta",
    answer:
      "Na avaliação, a Dra. Hellen Matias ouve sua queixa, entende o resultado que você busca e avalia o que pode ser indicado com segurança. Você pode chegar com um procedimento em mente ou simplesmente contar o que gostaria de melhorar.",
  },
  {
    question: "Quanto custam os procedimentos?",
    alternates: "preço\nvalor\nquanto custa\nquanto fica\nme passa os valores",
    answer:
      "Os valores são informados após a avaliação, porque dependem do caso e do planejamento indicado pela Dra. Hellen Matias. A avaliação é o primeiro passo para receber uma proposta individualizada.",
  },
  {
    question: "Quais são as formas de pagamento?",
    alternates: "pagamento\npix\ncartão\ndinheiro\ndébito\nparcela\nparcelamento",
    answer:
      "Aceitamos dinheiro, Pix, cartão de débito e cartão de crédito. No crédito, é possível parcelar em até 12 vezes, com o acréscimo cobrado pela máquina.",
  },
  {
    question: "É necessário pagar sinal para confirmar o horário?",
    alternates: "sinal\nentrada\ntaxa de agendamento\nconfirmar horário\ncomprovante",
    answer:
      "Sim. A confirmação do horário acontece após o envio do comprovante do sinal. Esse valor é abatido do tratamento e não é devolvido em caso de desistência. Os dados e o valor do sinal são informados pela equipe.",
  },
  {
    question: "A clínica aceita convênio ou plano de saúde?",
    alternates: "convênio\nplano de saúde\naceita plano\natende convênio",
    answer: "Não atendemos por convênio ou plano de saúde.",
  },
  {
    question: "Preciso levar exames ou documentos?",
    alternates: "levar exames\nquais documentos\nprecisa de exame\no que levar",
    answer: "Leve os exames que tiverem sido solicitados pela equipe. Se nada foi solicitado, confirme antes da consulta se é necessário levar algum documento específico.",
  },
  {
    question: "A clínica atende crianças ou gestantes?",
    alternates: "atende criança\natende menor\ngestante\ngrávida\ngravidez",
    answer: "A clínica não atende crianças nem gestantes.",
  },
  {
    question: "A clínica tem estacionamento?",
    alternates: "estacionamento\nonde estacionar\ntem vaga\nvalet",
    answer: "Não há estacionamento próprio informado. A equipe confirma as opções próximas quando o endereço da unidade escolhida for enviado.",
  },
  {
    question: "Onde ficam as unidades?",
    alternates: "endereço\nonde fica\nlocalização\nunidade de São Paulo\nunidade de Brasília",
    answer:
      "A Harmonizze Clinic atende em São Paulo e em Brasília. Os endereços completos ainda estão sendo definidos; antes de confirmar o agendamento, a equipe informa a localização da unidade escolhida.",
  },
] as const;

const TEMPLATES = [
  {
    name: "Boas-vindas",
    body:
      "Olá, {primeiro_nome}! Eu sou a Alice, secretária da Harmonizze Clinic 😊\nAtendemos em São Paulo e Brasília. Você já tem algum procedimento em mente ou prefere uma avaliação com a Dra. Hellen Matias?",
    whenToUse: "Primeira mensagem de um novo paciente ou quando a pessoa envia apenas uma saudação.",
  },
  {
    name: "Solicitação do sinal",
    body:
      "Para confirmar seu horário, precisamos do sinal e do comprovante de pagamento. O valor é abatido do tratamento e não é devolvido em caso de desistência. Estou transferindo para o responsável por essa parte enviar os dados.",
    whenToUse: "Depois que o paciente escolheu um horário e antes de confirmar o agendamento.",
  },
  {
    name: "Confirmação de horário",
    body:
      "Horário confirmado, {primeiro_nome}! Ficou para {procedimento}, com {profissional}, em {data_hora}. O sinal será abatido do tratamento e não é devolvido em caso de desistência. Se precisar remarcar, avise com antecedência.",
    whenToUse: "Somente depois que o comprovante do sinal foi recebido e o horário foi confirmado na agenda.",
  },
] as const;

const RULES = [
  { category: "tom_de_voz", instruction: "Fale com proximidade, leveza e acolhimento, sem pressão comercial. Use no máximo um emoji por mensagem e evite emoji em mensagens clínicas, de preço, pagamento ou confirmação." },
  { category: "tom_de_voz", instruction: "Apresente-se como Alice, secretária da Harmonizze Clinic, e informe naturalmente que os atendimentos são realizados pela Dra. Hellen Matias." },
  { category: "agendamento", instruction: "O horário oficial da clínica é de segunda a sexta-feira, das 8h30 às 18h, sem atendimento aos sábados. A agenda automática deve oferecer horários a partir das 9h enquanto o sistema não suportar início em meia hora." },
  { category: "pagamento", instruction: "Nunca informe preço de procedimento pelo WhatsApp, mesmo que o paciente insista. Explique que o valor depende da avaliação e do planejamento individual e ofereça a avaliação." },
  { category: "pagamento", instruction: "As formas aceitas são dinheiro, Pix, débito e crédito. O cartão de crédito pode ser parcelado em até 12 vezes com acréscimo da máquina. Não calcule juros nem parcela sem a informação oficial da equipe." },
  { category: "agendamento", instruction: "Antes de oferecer horários, confirme se o paciente prefere a unidade de São Paulo ou a de Brasília. As duas unidades usam a mesma agenda da Dra. Hellen Matias, para evitar conflito de horários." },
  { category: "agendamento", instruction: "O agendamento só fica confirmado depois do recebimento do comprovante do sinal. O sinal é abatido do tratamento e não é devolvido em caso de desistência. Como o valor e os dados de pagamento ainda não estão cadastrados, transfira essa etapa para a equipe." },
  { category: "procedimentos", instruction: "Nunca diga ou insinue 'vai ficar perfeito', 'temos a solução', 'isso resolve' ou qualquer garantia de resultado. Fale em possibilidades e benefícios esperados, sempre condicionados à avaliação individual." },
  { category: "procedimentos", instruction: "Para lipo de papada, platismoplastia, lifting facial, Deep Plane, otoplastia ou blefaroplastia, não confirme a cirurgia diretamente. Agende primeiro uma avaliação com a Dra. Hellen Matias." },
  { category: "procedimentos", instruction: "Cuidados pós-operatórios só podem ser reforçados conforme a orientação já dada pela equipe. Para lipo de papada, podem ser lembrados faixa, curativos, drenagens e uso correto da medicação prescrita, sem inventar frequência, dose ou técnica." },
  { category: "chamar_equipe", instruction: "Transfira imediatamente em caso de dor, intercorrência, complicação, piora, reclamação, dúvida clínica sem resposta cadastrada, pedido para falar com uma pessoa, problema de pagamento ou exceção de agendamento." },
  { category: "chamar_equipe", instruction: "Antes da transferência, escreva: 'Estou transferindo para o responsável por essa parte.'" },
  { category: "chamar_equipe", instruction: "Não bloqueie alguém apenas por parecer curioso. Depois dos recontatos previstos, encerre a abordagem sem insistência. Bloqueio ou interrupção definitiva de mensagens só deve ocorrer por spam, abuso ou pedido explícito para não receber contato." },
] as const;

const PLAYBOOKS = [
  {
    name: "Primeiro atendimento consultivo",
    scriptType: "primeiro_atendimento",
    triggerText: "Primeiro contato, saudação sem contexto ou pessoa que ainda não sabe qual procedimento procura.",
    goal: "Entender a queixa sem pressão e conduzir para a informação ou avaliação adequada.",
    steps: [
      "Cumprimente de forma breve e apresente-se como Alice, secretária da Harmonizze Clinic.",
      "Pergunte se a pessoa já tem um procedimento em mente ou se prefere contar o que gostaria de melhorar.",
      "Se ela não souber o procedimento, não escolha por ela e ofereça avaliação com a Dra. Hellen Matias.",
      "Quando houver intenção de agendar, confirme primeiro a cidade: São Paulo ou Brasília.",
      "Ofereça no máximo duas opções reais de horário e siga o fluxo de sinal antes de confirmar.",
    ],
  },
  {
    name: "Pedido de preço",
    scriptType: "preco",
    triggerText: "Paciente pergunta preço, valor, promoção ou quanto custa um procedimento.",
    goal: "Explicar a política de valores sem ser evasiva e facilitar a avaliação.",
    steps: [
      "Responda diretamente que os valores são definidos após a avaliação porque o planejamento é individual.",
      "Não revele a faixa interna de preço nem invente orçamento.",
      "Se perguntarem sobre pagamento, informe dinheiro, Pix, débito e crédito em até 12 vezes com acréscimo da máquina.",
      "Se houver interesse real, ofereça a avaliação sem pressão e confirme a unidade desejada.",
    ],
  },
  {
    name: "Agendamento com sinal",
    scriptType: "agendamento",
    triggerText: "Paciente quer marcar avaliação ou procedimento.",
    goal: "Agendar sem conflito entre as cidades e confirmar somente após o sinal.",
    steps: [
      "Confirme se o atendimento será em São Paulo ou Brasília.",
      "Confirme avaliação ou procedimento e ofereça no máximo dois horários reais.",
      "Depois da escolha, explique que o sinal é abatido do tratamento e não é devolvido em caso de desistência.",
      "Transfira para a equipe enviar o valor e os dados de pagamento, pois eles ainda não estão cadastrados.",
      "Só depois do comprovante, registre ou mantenha o agendamento como confirmado e envie a mensagem de confirmação.",
    ],
  },
  {
    name: "Remarcação ou cancelamento",
    scriptType: "remarcacao",
    triggerText: "Paciente quer remarcar, cancelar ou informa que não poderá comparecer.",
    goal: "Atualizar a agenda com acolhimento e aplicar a política do sinal sem negociação indevida.",
    steps: [
      "Identifique o agendamento e confirme se a pessoa quer remarcar ou cancelar.",
      "Na remarcação, confira a unidade e ofereça no máximo dois novos horários disponíveis.",
      "Em desistência, informe com respeito que o sinal não é devolvido.",
      "Se houver discordância, pedido de exceção ou reclamação, transfira para a equipe sem discutir.",
    ],
  },
  {
    name: "Intercorrência e pós-procedimento",
    scriptType: "pos_procedimento",
    triggerText: "Paciente relata dor, piora, complicação, intercorrência ou preocupação após procedimento.",
    goal: "Priorizar a segurança e colocar a equipe responsável na conversa rapidamente.",
    steps: [
      "Acolha o relato sem minimizar, diagnosticar ou prometer que é normal.",
      "Peça apenas as informações essenciais para a equipe: procedimento, quando foi realizado e o que está sentindo.",
      "Escreva a frase de transferência e acione uma pessoa da equipe imediatamente.",
      "Não prescreva, não altere medicação e não dê orientação clínica nova por conta própria.",
    ],
  },
] as const;

const REMINDERS = [
  { hoursBefore: 36, message: "Oi, {primeiro_nome}! Passando para lembrar do seu horário de {procedimento}, com {profissional}, em {data_hora}. Consegue confirmar sua presença por aqui?" },
  { hoursBefore: 24, message: "Oi, {primeiro_nome}! Seu atendimento de {procedimento} é amanhã, em {data_hora}. Se ainda não confirmou, responda esta mensagem, por favor." },
  { hoursBefore: 12, message: "Oi, {primeiro_nome}! Faltam 12 horas para o seu atendimento de {procedimento}, em {data_hora}. Estamos te esperando no horário combinado." },
  { hoursBefore: 8, message: "Oi, {primeiro_nome}! Seu horário de {procedimento} é hoje, em {data_hora}. Se surgir algum imprevisto, avise a gente por aqui." },
] as const;

const FOLLOWUPS = [
  { order: 1, name: "Recontato Harmonizze - 2 dias", afterDays: 2, message: "Oi, {primeiro_nome}! Nossa conversa ficou em aberto. Se ainda quiser entender qual cuidado faz sentido para você, posso retomar daqui e organizar uma avaliação com a Dra. Hellen Matias." },
  { order: 2, name: "Recontato Harmonizze - 5 dias", afterDays: 5, message: "Oi, {primeiro_nome}! Passando só para deixar o canal aberto. Quando fizer sentido retomar sua avaliação na Harmonizze Clinic, estamos por aqui." },
] as const;

const POST_PROCEDURE_MESSAGES = [
  { name: "Pós-procedimento - mesmo dia", intervalValue: 4, intervalUnit: "hours", message: "Oi, {primeiro_nome}! Como você está se sentindo depois do seu {procedimento}? Se tiver dor, piora ou qualquer preocupação, me avise agora para eu chamar a equipe." },
  { name: "Pós-procedimento - dia 1", intervalValue: 1, intervalUnit: "days", message: "Oi, {primeiro_nome}! Como foi sua primeira noite depois do {procedimento}? Siga as orientações recebidas e me conte se apareceu qualquer desconforto ou dúvida para eu acionar a equipe." },
  { name: "Pós-cirúrgico - dia 2", intervalValue: 2, intervalUnit: "days", message: "Oi, {primeiro_nome}! Passando para acompanhar seu segundo dia de recuperação. Está tudo correndo bem? Se houver dor, piora ou preocupação, chamo a equipe para você." },
  { name: "Pós-cirúrgico - dia 3", intervalValue: 3, intervalUnit: "days", message: "Oi, {primeiro_nome}! Como você está hoje? Continue seguindo exatamente as orientações da Dra. Hellen e avise por aqui se precisar falar com a equipe." },
  { name: "Pós-cirúrgico - dia 4", intervalValue: 4, intervalUnit: "days", message: "Oi, {primeiro_nome}! Seguimos acompanhando sua recuperação. Como você está se sentindo hoje?" },
  { name: "Pós-cirúrgico - dia 5", intervalValue: 5, intervalUnit: "days", message: "Oi, {primeiro_nome}! Passando para saber como está sua recuperação hoje. Qualquer dúvida ou mudança, pode contar por aqui para a equipe acompanhar." },
  { name: "Pós-cirúrgico - dia 6", intervalValue: 6, intervalUnit: "days", message: "Oi, {primeiro_nome}! Como você está neste sexto dia de recuperação? Se precisar rever alguma orientação, eu chamo a equipe responsável." },
  { name: "Pós-cirúrgico - dia 7", intervalValue: 7, intervalUnit: "days", message: "Oi, {primeiro_nome}! Completamos uma semana de acompanhamento. Como está sua recuperação? Se houver qualquer preocupação, me conte para eu acionar a equipe." },
] as const;

const SURGICAL_PROCEDURES = [
  "Lipo de Papada",
  "Platismoplastia",
  "Lifting Facial",
  "Deep Plane",
  "Otoplastia",
  "Blefaroplastia",
];

export interface SeedHarmonizzeResult {
  clinicId: string;
  login: string;
  created: boolean;
  password: string | null; // senha inicial - so quando a conta de acesso foi criada agora
  counts: Record<string, number>;
  pending: string[];
}

export async function seedHarmonizze(): Promise<SeedHarmonizzeResult> {
  const existingClinic =
    (await prisma.clinic.findUnique({ where: { whatsappPhone: WA } })) ??
    (await prisma.clinic.findFirst({ where: { whatsappPhone: { in: WA_FALLBACKS } } }));
  const created = !existingClinic;

  // Campos que o seed controla a partir do briefing. active e plan ficam de
  // fora do update: sao definidos no painel adm e re-rodar o seed nao deve
  // reverte-los (so os define ao criar a conta).
  const config = {
    name: "Harmonizze Clinic Medicina e Odontologia",
    timezone: "America/Sao_Paulo",
    workStartHour: 9,
    workEndHour: 18,
    workDays: "1,2,3,4,5",
    // Briefing: avisos vao pro proprio numero de atendimento (conversa
    // "Mensagem pra mim"). A equipe troca por um celular dedicado no painel
    // quando tiver um.
    notifyPhone: WA,
    notifyEvents: "new_appointment,reschedule,cancel,confirmed,human_handoff",
    assistantPersona: "clinic_secretary",
    assistantPersonaName: null,
    assistantName: "Alice",
    activityArea: "harmonização facial, cirurgias faciais, medicina e odontologia",
    handoffPhrase: "Estou transferindo para o responsável por essa parte.",
    requireDepositProof: true,
    businessType: "clinica",
    servicePosture: "consultivo",
    clinicKind: "ambas",
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
    throw new Error("A senha inicial da Harmonizze precisa ter pelo menos 10 caracteres.");
  }
  if (existingStaff) {
    // Nao mexe na senha: pode ter sido trocada pelo cliente.
    await prisma.staffUser.update({
      where: { username: LOGIN },
      data: { name: "Harmonizze Clinic", role: "client", clinicId: clinic.id },
    });
  } else {
    await prisma.staffUser.create({
      data: {
        name: "Harmonizze Clinic",
        username: LOGIN,
        passwordHash: hashPassword(INITIAL_PASSWORD),
        role: "client",
        clinicId: clinic.id,
      },
    });
  }

  const locations = [
    { name: "Unidade São Paulo", city: "São Paulo", state: "SP", order: 0 },
    { name: "Unidade Brasília", city: "Brasília", state: "DF", order: 1 },
  ];
  for (const loc of locations) {
    const current = await prisma.clinicLocation.findFirst({ where: { clinicId: clinic.id, name: loc.name } });
    const data = { city: loc.city, state: loc.state, country: "Brasil", timezone: "America/Sao_Paulo", order: loc.order, active: true };
    if (current) await prisma.clinicLocation.update({ where: { id: current.id }, data });
    else await prisma.clinicLocation.create({ data: { clinicId: clinic.id, name: loc.name, ...data } });
  }

  const procedureIds = new Map<string, string>();
  for (const item of PROCEDURES) {
    const current = await prisma.procedure.findFirst({ where: { clinicId: clinic.id, name: item.name } });
    const detailed = "description" in item;
    const data = {
      durationMin: "durationMin" in item ? item.durationMin : 60,
      description: detailed ? item.description : "Procedimento realizado pela Dra. Hellen Matias após avaliação individual.",
      price: null,
      priceVariable: true,
      offerInstallments: true,
      maxInstallments: 12,
      paymentMethods: "dinheiro,pix,credito,debito",
      paymentLink: null,
      goals: detailed ? item.goals : null,
      benefits: detailed ? item.benefits : null,
      aliases: item.aliases,
      resultTimeline: detailed ? item.resultTimeline : null,
    };
    const procedure = current
      ? await prisma.procedure.update({ where: { id: current.id }, data })
      : await prisma.procedure.create({ data: { clinicId: clinic.id, name: item.name, ...data } });
    procedureIds.set(item.name, procedure.id);
  }

  const professional = await prisma.professional.findFirst({ where: { clinicId: clinic.id, name: "Dra. Hellen Matias" } });
  const professionalData = {
    bio: "Professora e cirurgiã bucomaxilofacial, especialista em harmonização facial.",
    instagram: "@drahellenmatias",
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
      name: "Dra. Hellen Matias",
      bio: professionalData.bio,
      instagram: professionalData.instagram,
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
    const data = { body: template.body, mode: "adapt", whenToUse: template.whenToUse, active: true };
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
      sendWindowEnd: 18,
      active: true,
    };
    if (current) await prisma.followUpRule.update({ where: { id: current.id }, data });
    else await prisma.followUpRule.create({ data: { clinicId: clinic.id, ...data } });
  }

  // Pos-procedimento nunca vale pra "Avaliação" (e uma consulta, nao um
  // tratamento): so pros procedimentos de verdade, e a trilha cirurgica so
  // pras cirurgias.
  const EVALUATION_NAME = "Avaliação com a Dra. Hellen Matias";
  const treatmentIds = [...procedureIds.entries()]
    .filter(([name]) => name !== EVALUATION_NAME)
    .map(([, id]) => id)
    .join(",");
  const surgicalIds = SURGICAL_PROCEDURES.map((name) => procedureIds.get(name)).filter((id): id is string => !!id).join(",");
  for (const post of POST_PROCEDURE_MESSAGES) {
    const current = await prisma.postProcedureRule.findFirst({ where: { clinicId: clinic.id, name: post.name } });
    const data = {
      message: post.message,
      intervalValue: post.intervalValue,
      intervalUnit: post.intervalUnit,
      onlyIfCompleted: true,
      procedureIds: post.name.startsWith("Pós-cirúrgico") ? surgicalIds : treatmentIds,
      active: true,
    };
    if (current) await prisma.postProcedureRule.update({ where: { id: current.id }, data });
    else await prisma.postProcedureRule.create({ data: { clinicId: clinic.id, name: post.name, ...data } });
  }

  const botoxId = procedureIds.get("Botox")!;
  const renewalName = "Renovação de toxina - 6 meses";
  const renewal = await prisma.renewalRule.findFirst({ where: { clinicId: clinic.id, name: renewalName } });
  const renewalData = {
    message: "Oi, {primeiro_nome}! Já faz um tempo desde o seu {procedimento}. Se quiser reavaliar o resultado com a Dra. Hellen Matias, posso verificar um horário para você.",
    intervalValue: 6,
    intervalUnit: "months",
    onlyIfCompleted: true,
    procedureIds: botoxId,
    active: true,
  };
  if (renewal) await prisma.renewalRule.update({ where: { id: renewal.id }, data: renewalData });
  else await prisma.renewalRule.create({ data: { clinicId: clinic.id, name: renewalName, ...renewalData } });

  const birthdayName = "Aniversário do paciente";
  const birthday = await prisma.birthdayRule.findFirst({ where: { clinicId: clinic.id, name: birthdayName } });
  const birthdayData = {
    message: "Feliz aniversário, {primeiro_nome}! A equipe da Harmonizze Clinic deseja um dia muito especial, com saúde e bons momentos 😊",
    sendHour: 9,
    active: true,
  };
  if (birthday) await prisma.birthdayRule.update({ where: { id: birthday.id }, data: birthdayData });
  else await prisma.birthdayRule.create({ data: { clinicId: clinic.id, name: birthdayName, ...birthdayData } });

  await getFunnelStages(clinic.id);

  const [procedureCount, professionalCount, locationCount, faqCount, templateCount, ruleCount, playbookCount, reminderCount, followupCount, postProcedureCount, renewalCount, birthdayCount] = await Promise.all([
    prisma.procedure.count({ where: { clinicId: clinic.id } }),
    prisma.professional.count({ where: { clinicId: clinic.id } }),
    prisma.clinicLocation.count({ where: { clinicId: clinic.id } }),
    prisma.clinicFaq.count({ where: { clinicId: clinic.id } }),
    prisma.messageTemplate.count({ where: { clinicId: clinic.id } }),
    prisma.customRule.count({ where: { clinicId: clinic.id, status: "active" } }),
    prisma.playbook.count({ where: { clinicId: clinic.id, active: true } }),
    prisma.reminderRule.count({ where: { clinicId: clinic.id, active: true } }),
    prisma.followUpRule.count({ where: { clinicId: clinic.id, active: true } }),
    prisma.postProcedureRule.count({ where: { clinicId: clinic.id, active: true } }),
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
      locations: locationCount,
      faqs: faqCount,
      templates: templateCount,
      activeRules: ruleCount,
      playbooks: playbookCount,
      reminders: reminderCount,
      followups: followupCount,
      postProcedure: postProcedureCount,
      renewals: renewalCount,
      birthdays: birthdayCount,
    },
    pending: [
      "endereços completos e informação definitiva de estacionamento das duas unidades",
      "quem assume quando a Alice transfere (pessoa/perfil); os avisos estão indo pro próprio número de atendimento, trocar por um celular dedicado da equipe se quiser separar",
      "valor do sinal e dados/link de pagamento",
      "duração real da avaliação e dos procedimentos que não foram detalhados",
      "periodicidade dos retornos dos planos anuais",
      "confirmação do plano comercial contratado",
      "suporte a início de expediente às 08:30 (o campo atual aceita apenas hora cheia; foi usado 09:00)",
    ],
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  seedHarmonizze()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
