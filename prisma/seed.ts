import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const clinic = await prisma.clinic.create({
    data: {
      name: "Clinica Exemplo",
      whatsappPhone: "5511999999999",
      procedures: {
        create: [
          { name: "Limpeza de pele", durationMin: 60, description: "Limpeza de pele profunda" },
          { name: "Botox", durationMin: 30, description: "Aplicacao de toxina botulinica" },
          { name: "Preenchimento labial", durationMin: 45 },
        ],
      },
      followUpRules: {
        create: [
          { order: 1, afterDays: 1, message: "Oi {nome}, tudo bem? Ficou alguma dúvida sobre o que conversamos? Fico à disposição para te ajudar." },
          { order: 2, afterDays: 6, message: "Oi {nome}! Passando pra saber se você ainda tem interesse em agendar sua avaliação. Consigo te encaixar essa semana." },
          { order: 3, afterDays: 15, message: "Oi {nome}, tudo certo? Se ainda fizer sentido pra você, é só me avisar que já deixo um horário reservado." },
          { order: 4, afterDays: 21, message: "{nome}, temos algumas condições especiais abertas esse mês — se quiser aproveitar, me chama por aqui." },
          { order: 5, afterDays: 45, message: "Oi {nome}, como não tivemos retorno, vou pausar nosso contato por aqui. Se quiser retomar depois, é só me chamar quando fizer sentido." },
        ],
      },
    },
  });

  console.log("Clinica criada:", clinic.id);
}

main().finally(() => prisma.$disconnect());
