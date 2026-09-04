// ---------------------------------------------------------------------------
// Plano "Grátis": CRM (funil + contatos) + integração com a Meta + atendimento
// HUMANO no chat. Serve pra clínica usar o painel como ferramenta de campanha -
// capta o lead do anúncio (com atribuição), responde na mão, trabalha o lead no
// kanban, e cada movimento vira evento de conversão pra Meta.
//
// O que NAO tem: a Alice respondendo sozinha, agenda e todas as automações.
// É de proposito: o plano grátis existe pra mostrar o trabalho manual que a
// Alice tiraria da frente. O painel puxa esse contraste o tempo todo (ver os
// blocos [data-plan-free] em index.html).
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

// O chat FICA aberto no plano grátis (atendimento humano). Só não existe a
// opção de devolver a conversa pra Alice - ela não atende nesse plano.
const BLOCKED_ALL_METHODS: RegExp[] = [/^\/conversations\/[^/]+\/resume$/];

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
  if (BLOCKED_ALL_METHODS.some((re) => re.test(path))) return true;
  if (WRITE_METHODS.has(method) && BLOCKED_WRITE_ONLY.some((p) => matchesPrefix(path, p))) return true;
  return false;
}
