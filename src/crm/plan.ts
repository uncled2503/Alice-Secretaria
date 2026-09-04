// ---------------------------------------------------------------------------
// Plano "Grátis": só CRM (funil + contatos) + integração com a Meta. Serve pra
// clínica usar o painel como ferramenta de campanha - capta o lead do anúncio
// (com atribuição), trabalha ele no kanban na mão, e cada movimento vira evento
// de conversão pra Meta. Todo o resto fica bloqueado, inclusive a resposta
// automática da Alice.
//
// Os outros planos (realce/prime/prestige) continuam com tudo liberado; a
// única diferença entre eles é o limite de atendimentos/mês (ver usage.ts).
// ---------------------------------------------------------------------------

export const FREE_PLAN = "free";

export function isFreePlan(plan: string | null | undefined): boolean {
  return plan === FREE_PLAN;
}

// Fragmento de `where` do Prisma pra pular clínicas do plano grátis nos crons
// de automação: prisma.x.findMany({ where: { clinic: PAID_CLINIC_WHERE } }).
export const PAID_CLINIC_WHERE = { plan: { not: FREE_PLAN } } as const;

// Áreas que o plano grátis não acessa. `req.path` aqui é relativo ao mount
// "/api" (ex: "/procedures", "/conversations/abc/send").
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Bloqueadas em QUALQUER método (a aba Chat some do painel do plano grátis).
const BLOCKED_ALL_METHODS = ["/conversations"];

// Bloqueadas só nos métodos de escrita - GET fica liberado porque devolve lista
// vazia e não quebra nenhum componente compartilhado do painel.
const BLOCKED_WRITE_ONLY = [
  "/procedures",
  "/professionals",
  "/appointments",
  "/schedule-blocks",
  "/waitlist",
  "/reminder-rules",
  "/post-procedure-rules",
  "/renewal-rules",
  "/birthday-rules",
  "/followup-rules",
  "/broadcasts",
  "/message-templates",
  "/playbooks",
  "/rules",
  "/faqs",
  "/briefing",
  "/learning-insights",
  "/nps",
  "/api-keys",
];

function matchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

// true = essa requisição não pode passar numa conta client do plano grátis.
// Só decide o bloqueio; quem chama já garantiu que a conta é client e o plano
// é o grátis.
export function freePlanBlocksPath(method: string, path: string): boolean {
  if (BLOCKED_ALL_METHODS.some((p) => matchesPrefix(path, p))) return true;
  if (WRITE_METHODS.has(method) && BLOCKED_WRITE_ONLY.some((p) => matchesPrefix(path, p))) return true;
  return false;
}
