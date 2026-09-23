import "dotenv/config";
import { fileURLToPath } from "url";
import { prisma } from "../db/client.js";

// Pedido do Dr. Isac Roldão em 22-23/09/2026: a Alice deve tentar resgatar
// conversas paradas depois de alguns dias pra tentar agendar. Ele escolheu
// 3 dias de silêncio e uma mensagem simples pedindo um horário e avisando
// que aguarda a confirmação. Idempotente: rodar de novo não duplica.
const LOGIN = "isacroldao@aliceconversa.com";

const FOLLOWUP = {
  order: 1,
  name: "Resgate de conversa parada - 3 dias",
  afterDays: 3,
  message:
    "Olá, {primeiro_nome}! Passando aqui pra saber se ainda tem interesse em agendar sua consulta. Me diga um horário que seria possível pra você que eu verifico a disponibilidade e te confirmo em seguida. 😊",
} as const;

export async function setupIsacFollowup(): Promise<{ clinicId: string; created: boolean }> {
  const staffUser = await prisma.staffUser.findFirst({ where: { username: LOGIN } });
  if (!staffUser?.clinicId) {
    throw new Error(`Nenhuma clinica encontrada para o login "${LOGIN}" - confirme o username exato no painel.`);
  }
  const clinicId = staffUser.clinicId;

  // Mesma logica de dedupe do FOLLOWUPS em seedDrSaulo.ts: se ja existe uma
  // regra com esse nome, ou ja existe algo ocupando o slot "order", nao
  // duplica - assume que o slot ja e essa regra.
  const current =
    (await prisma.followUpRule.findFirst({ where: { clinicId, name: FOLLOWUP.name } })) ??
    (await prisma.followUpRule.findFirst({ where: { clinicId, order: FOLLOWUP.order } }));
  if (current) {
    return { clinicId, created: false };
  }

  await prisma.followUpRule.create({
    data: {
      clinicId,
      name: FOLLOWUP.name,
      order: FOLLOWUP.order,
      afterDays: FOLLOWUP.afterDays,
      afterMinutes: 0,
      message: FOLLOWUP.message,
      repeatMode: "once",
      skipIfHumanTakeover: true,
      skipIfUpcomingAppt: true,
      sendWindowStart: 9,
      sendWindowEnd: 17,
      active: true,
    },
  });
  return { clinicId, created: true };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  setupIsacFollowup()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
