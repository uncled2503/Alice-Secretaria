import { PrismaClient } from "@prisma/client";

// SQLite com varios jobs gravando (importacao, lembretes, recontato, webhooks)
// e o painel lendo ao mesmo tempo: o padrao do Prisma espera so ~5s por um lock
// e depois devolve erro (vira "HTTP 500 Erro interno" no painel). Aumenta a espera
// por lock (socket_timeout) se a URL ainda nao definiu um valor.
function withLockTimeout(url: string | undefined): string | undefined {
  if (!url || !url.startsWith("file:")) return url;
  const [base, query = ""] = url.split("?");
  const params = new URLSearchParams(query);
  if (!params.has("socket_timeout")) params.set("socket_timeout", "30");
  return `${base}?${params.toString()}`;
}

const url = withLockTimeout(process.env.DATABASE_URL);
const baseClient = url ? new PrismaClient({ datasources: { db: { url } } }) : new PrismaClient();

// REGISTRO DE REMARCACAO E DE CONCLUSAO, em UM lugar so. O horario de um agendamento muda por varios caminhos (Alice, painel, API externa, importacao e conferencia do Clinica
// Experts); a conclusao tambem. Cada um deles precisava lembrar de anotar "quando mudou" - e quem esquecia deixava a remarcacao sem cobertura de confirmacao e o pos sem
// evidencia de quando o atendimento foi dado como concluido. Aqui o banco anota sozinho, SEM escrita extra (o carimbo vai na MESMA gravacao):
//   - scheduleChangedAt: o horario realmente mudou (regravar o mesmo horario nao conta);
//   - completedAt: o status passou a "completed" agora (regravar "completed" nao muda a data);
//   - horario mudou = nova versao: a confirmacao de presenca e o pedido de remarcacao do horario antigo deixam de valer (salvo valor explicito na mesma gravacao).
// A leitura do estado anterior usa a conexao base (fora de eventual transacao): nunca grava por ela, entao nao trava a transacao em andamento.
type Writable = Record<string, unknown>;
const unwrap = (v: unknown): unknown => (v && typeof v === "object" && !(v instanceof Date) && "set" in (v as Writable) ? (v as Writable).set : v);

async function stamp(args: { where?: unknown; data?: unknown }, mode: "one" | "many"): Promise<void> {
  const data = args.data as Writable | undefined;
  if (!data) return;
  const newStart = unwrap(data.scheduledAt);
  const newStatus = unwrap(data.status);
  const wantsStart = newStart instanceof Date && data.scheduleChangedAt === undefined;
  const wantsDone = newStatus === "completed" && data.completedAt === undefined;
  if (!wantsStart && !wantsDone) return;
  try {
    const where = args.where as never;
    const rows = mode === "one"
      ? [await baseClient.appointment.findUnique({ where, select: { scheduledAt: true, status: true } })].filter((r): r is NonNullable<typeof r> => r !== null)
      : await baseClient.appointment.findMany({ where, select: { scheduledAt: true, status: true }, take: 500 });
    if (rows.length === 0) return;
    if (wantsStart && rows.every((r) => r.scheduledAt.getTime() !== (newStart as Date).getTime())) {
      data.scheduleChangedAt = new Date();
      // NOVA VERSAO da reserva: a confirmacao e o pedido de remarcacao valiam para o horario antigo. Quem gravou explicitamente outro valor prevalece.
      if (data.patientConfirmed === undefined) { data.patientConfirmed = false; if (data.confirmedAt === undefined) data.confirmedAt = null; }
      if (data.rescheduleRequestedAt === undefined) data.rescheduleRequestedAt = null;
    }
    if (wantsDone && rows.every((r) => r.status !== "completed")) data.completedAt = new Date();
  } catch {
    /* o registro e auxiliar: nunca derruba a gravacao principal */
  }
}

export const prisma = baseClient.$extends({
  name: "registro-de-remarcacao-e-conclusao",
  query: {
    appointment: {
      async create({ args, query }) {
        const d = args.data as Writable;
        if (d && unwrap(d.status) === "completed" && d.completedAt === undefined) d.completedAt = new Date();
        return query(args);
      },
      async update({ args, query }) {
        await stamp(args as { where?: unknown; data?: unknown }, "one");
        return query(args);
      },
      async updateMany({ args, query }) {
        await stamp(args as { where?: unknown; data?: unknown }, "many");
        return query(args);
      },
    },
  },
}) as unknown as PrismaClient;

// Modo WAL: leituras nao travam enquanto alguem grava (e vice-versa). E uma
// propriedade do ARQUIVO do banco - basta ligar uma vez; o backup (VACUUM INTO)
// continua consistente. Melhor esforco: se falhar, segue no modo anterior.
export async function enableWalMode(): Promise<void> {
  if (!process.env.DATABASE_URL?.startsWith("file:")) return;
  // Trocar o modo do diario exige o banco livre por um instante: tenta algumas
  // vezes antes de desistir (na subida pode haver outra conexao usando o arquivo).
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL");
      return;
    } catch (err) {
      if (attempt === 6) console.error("[db] nao consegui ligar o modo WAL:", err);
      else await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}
