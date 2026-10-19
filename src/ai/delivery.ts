// ---------------------------------------------------------------------------
// ESTADO DE ENTREGA DAS RESPOSTAS DA ALICE (Message.deliveryStatus, texto livre no banco; sem migration).
//   pending      gravada, ainda nao enviada (a entrega esta em andamento, ou vai ser retomada)
//   sending      o envio foi INICIADO (a UAZAPI pode ter recebido) e ainda nao terminou. Se ficar assim, o desfecho e desconhecido:
//                nunca e reenviada sozinha (vira "unconfirmed")
//   sent         a UAZAPI ACEITOU o envio (resposta 2xx de /send/text). NAO e recibo de leitura/entrega no aparelho: a Alice nao recebe esse recibo.
//   unconfirmed  o envio deu timeout/queda DEPOIS de submetido, ou ficou sem desfecho: pode ter chegado. NAO e entrega confirmada e NAO e reenviada sozinha.
//   failed       falhou antes de sair; o sistema tenta de novo por alguns minutos
//   failed_permanent  falhou de vez (ex.: numero sem WhatsApp)
//   blocked      o plano da clinica nao permite envio automatico: nada saiu
//   vetoed       a revisao barrou e nada saiu (so mensagens automaticas; resposta da Alice nunca e barrada)
//   expired      ficou parada/falhando alem do prazo de retomada (30 min): nada saiu e nao vai sair sozinha; a conversa fica sinalizada pra equipe
//   null         superada (outra fala, resposta repetida descartada ou silencio): nao conta como falha
// ---------------------------------------------------------------------------

// Estados em que NADA chegou na pessoa: a Alice nao pode tratar essa fala como "ja dita" (historico, ficha, memoria, "ultima fala e minha").
export const UNDELIVERED_STATUSES = ["failed_permanent", "blocked", "vetoed", "expired"] as const;

// Estados que contam como "a resposta foi dada" para saber se a pessoa ficou sem resposta (aceita pela UAZAPI, ou pode ter chegado).
// Legado (null) conta: respostas antigas anteriores ao controle de entrega.
export const ANSWERED_STATUSES = ["sent", "sending", "unconfirmed"] as const;

// Filtro Prisma: tira das mensagens as falas da Alice que nunca foram entregues. (OR explicito: "NOT" do Prisma descarta linhas com status nulo.)
export const deliveredOnly = {
  OR: [{ role: { not: "assistant" } }, { deliveryStatus: null }, { deliveryStatus: { notIn: [...UNDELIVERED_STATUSES] } }],
};

export type DeliveryStatus = "pending" | "sending" | "sent" | "unconfirmed" | "failed" | "failed_permanent" | "blocked" | "vetoed" | "expired" | null;

// Tempos da entrega (compartilhados pela entrega, pela retomada e pelos testes).
export const STALE_PENDING_MS = 4 * 60_000; // "pending"/"sending" parado alem disto nao esta mais sendo processado por ninguem
export const REPLY_RESUME_WINDOW_MS = 30 * 60_000; // so respostas recentes sao retomadas; mais velhas expiram e vao pra equipe

// Rotulo para o painel (mensagem da Alice que nao esta confirmada como entregue).
export function deliveryProblemLabel(status: string | null | undefined): string | null {
  switch (status) {
    case "failed": return "⚠ Não foi enviada — tentando de novo";
    case "failed_permanent": return "⚠ Não foi enviada (número sem WhatsApp?)";
    case "blocked": return "⚠ Não foi enviada (envio automático bloqueado pelo plano)";
    case "vetoed": return "⚠ Não foi enviada (barrada pela revisão)";
    case "expired": return "⚠ Não foi enviada (expirou) — a equipe foi sinalizada";
    case "unconfirmed": return "⚠ Envio sem confirmação — pode ter chegado (não será reenviada)";
    default: return null;
  }
}
