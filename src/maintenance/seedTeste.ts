import "dotenv/config";
import { fileURLToPath } from "url";
import { prisma } from "../db/client.js";
import { hashPassword } from "../api/passwords.js";
import { seedDefaultRules } from "../ai/rules.js";
import { getFunnelStages } from "../crm/stages.js";

// Clinica INTERNA, sem cliente de verdade por tras: existe so pra testar
// atualizacoes da agenda/Alice (agendamento simultaneo, ordem de chegada,
// feriados, bloqueio, remarcacao) direto no painel antes de aplicar em
// clinica de cliente real. Pedido explicito do Tio Diza (17/09/2026). O seed
// e idempotente: pode rodar de novo a qualquer hora pra resetar o cenario de
// teste sem acumular lixo.
const WA = "9999999999999"; // placeholder claramente falso, nunca sera um numero real
const CLINIC_NAME = "Clínica Teste (Alice)";
const LOGIN = "teste@aliceconversa.com";
const INITIAL_PASSWORD = process.env.TESTE_INITIAL_PASSWORD?.trim() || "testealice1234";

const PROCEDURE_NORMAL = "Consulta Teste";
const PROCEDURE_CONCURRENT = "Aplicação Teste";
const PROFESSIONAL_NORMAL = "Profissional A (Consulta)";
const PROFESSIONAL_CONCURRENT = "Profissional B (Aplicação)";

export interface SeedTesteResult {
  clinicId: string;
  login: string;
  created: boolean;
  password: string | null;
  notes: string[];
}

export async function seedTeste(): Promise<SeedTesteResult> {
  const existingClinic = await prisma.clinic.findFirst({ where: { name: CLINIC_NAME } });
  const created = !existingClinic;

  const config = {
    name: CLINIC_NAME,
    timezone: "America/Sao_Paulo",
    workStartHour: 8,
    workEndHour: 18,
    workDays: "1,2,3,4,5,6", // seg-sab, de proposito diferente das clinicas reais (testa variedade)
    closedOnHolidays: true, // liga de proposito, pra testar o bloqueio de feriado sem precisar mexer em nada
    notifyPhone: WA,
    notifyEvents: "new_appointment,reschedule,cancel,confirmed,human_handoff",
    assistantPersona: "clinic_secretary",
    assistantPersonaName: null,
    assistantName: "Alice",
    activityArea: "clínica de testes internos - sem paciente real",
    handoffPhrase: "Vou chamar a equipe pra continuar com você por aqui.",
    requireDepositProof: false,
    businessType: "clinica",
    servicePosture: "consultivo",
    clinicKind: "estetica",
    evaluationFirst: false,
    allowEmojis: true,
    schedulingLink: null,
    replyDelaySeconds: 5,
  };

  const clinic = existingClinic
    ? await prisma.clinic.update({ where: { id: existingClinic.id }, data: { ...config, whatsappPhone: WA } })
    : await prisma.clinic.create({ data: { ...config, whatsappPhone: WA, active: true, plan: "prime" } });

  const existingStaff = await prisma.staffUser.findUnique({ where: { username: LOGIN } });
  if (existingStaff) {
    await prisma.staffUser.update({ where: { username: LOGIN }, data: { name: CLINIC_NAME, role: "client", clinicId: clinic.id } });
  } else {
    await prisma.staffUser.create({
      data: { name: CLINIC_NAME, username: LOGIN, passwordHash: hashPassword(INITIAL_PASSWORD), role: "client", clinicId: clinic.id },
    });
  }

  // Dois procedimentos com naturezas OPOSTAS de proposito: um exclusivo
  // (normal) e um "por ordem de chegada" (allowConcurrentBooking), cada um
  // com seu proprio profissional - o mesmo padrao usado na clinica do Dr.
  // Saulo (consulta + aplicação), pra validar que a engine generica funciona
  // sem depender de nada especifico daquele cliente.
  const procedures = [
    { name: PROCEDURE_NORMAL, durationMin: 60, allowConcurrentBooking: false, description: "Procedimento normal, de horario exclusivo - usa pra testar conflito/remarcação/feriado/bloqueio." },
    { name: PROCEDURE_CONCURRENT, durationMin: 15, allowConcurrentBooking: true, description: "Procedimento por ordem de chegada - usa pra testar vários pacientes no mesmo horário." },
  ];
  const procedureIds = new Map<string, string>();
  for (const item of procedures) {
    const current = await prisma.procedure.findFirst({ where: { clinicId: clinic.id, name: item.name } });
    const data = {
      durationMin: item.durationMin,
      allowConcurrentBooking: item.allowConcurrentBooking,
      description: item.description,
      price: null,
      priceVariable: true,
      offerInstallments: false,
      maxInstallments: null,
      paymentMethods: "dinheiro,pix,credito,debito",
      paymentLink: null,
      goals: null,
      benefits: null,
      aliases: null,
      resultTimeline: null,
    };
    const procedure = current
      ? await prisma.procedure.update({ where: { id: current.id }, data })
      : await prisma.procedure.create({ data: { clinicId: clinic.id, name: item.name, ...data } });
    procedureIds.set(item.name, procedure.id);
  }

  const professionals = [
    { name: PROFESSIONAL_NORMAL, procedureName: PROCEDURE_NORMAL },
    { name: PROFESSIONAL_CONCURRENT, procedureName: PROCEDURE_CONCURRENT },
  ];
  for (const item of professionals) {
    const current = await prisma.professional.findFirst({ where: { clinicId: clinic.id, name: item.name } });
    const procedureId = procedureIds.get(item.procedureName)!;
    const data = {
      bio: "Profissional fictício, usado só pra testes internos de agenda.",
      instagram: null,
      active: true,
      workDays: null,
      workStartHour: null,
      workEndHour: null,
    };
    if (current) {
      await prisma.professional.update({ where: { id: current.id }, data: { ...data, procedures: { set: [{ id: procedureId }] } } });
    } else {
      await prisma.professional.create({
        data: { clinic: { connect: { id: clinic.id } }, name: item.name, ...data, procedures: { connect: [{ id: procedureId }] } },
      });
    }
  }

  const faqs = [
    { question: "Isso é uma clínica de teste?", answer: "Sim, essa é uma clínica interna usada só pra testar atualizações antes de aplicar em clínicas de clientes reais." },
  ];
  for (const item of faqs) {
    const current = await prisma.clinicFaq.findFirst({ where: { clinicId: clinic.id, question: item.question } });
    const data = { answer: item.answer, alternates: "" };
    if (current) await prisma.clinicFaq.update({ where: { id: current.id }, data });
    else await prisma.clinicFaq.create({ data: { clinicId: clinic.id, question: item.question, ...data } });
  }

  const templates = [
    {
      name: "Boas-vindas",
      body: "Oi, {primeiro_nome}! Aqui é a Alice, da Clínica Teste. Isso é um ambiente interno de testes.",
      whenToUse: "Primeira mensagem de um contato novo.",
      mode: "adapt" as const,
    },
  ];
  for (const item of templates) {
    const current = await prisma.messageTemplate.findFirst({ where: { clinicId: clinic.id, name: item.name } });
    const data = { body: item.body, whenToUse: item.whenToUse, mode: item.mode, active: true };
    if (current) await prisma.messageTemplate.update({ where: { id: current.id }, data });
    else await prisma.messageTemplate.create({ data: { clinicId: clinic.id, name: item.name, ...data } });
  }

  await seedDefaultRules(clinic.id);
  await getFunnelStages(clinic.id);

  return {
    clinicId: clinic.id,
    login: LOGIN,
    created,
    password: created ? INITIAL_PASSWORD : null,
    notes: [
      `Procedimento "${PROCEDURE_NORMAL}" (60min, exclusivo) com "${PROFESSIONAL_NORMAL}" - testa conflito normal, remarcação, feriado, bloqueio de horário.`,
      `Procedimento "${PROCEDURE_CONCURRENT}" (15min, ordem de chegada) com "${PROFESSIONAL_CONCURRENT}" - testa vários pacientes no mesmo horário e agendamento simultâneo com o procedimento normal.`,
      "Expediente: seg-sáb, 8h-18h, fechado em feriado nacional (closedOnHolidays ligado de propósito).",
      "Sem WhatsApp real conectado (número placeholder) - dá pra testar Agenda/CRM pelo painel; pra testar a Alice por WhatsApp, conecte um canal de teste em Configurações → Canais.",
    ],
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  seedTeste()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
