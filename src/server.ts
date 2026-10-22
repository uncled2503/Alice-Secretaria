import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import helmet from "helmet";
import compression from "compression";
import { rateLimit } from "express-rate-limit";
import { siteLeadRouter } from "./site/leads.js";
import { startReminderJob } from "./reminders/cron.js";
import { startPostProcedureJob } from "./reminders/postProcedure.js";
import { startConfirmationRecoveryJob } from "./crm/appointmentMessages.js";
import { startPreProcedureJob } from "./reminders/preProcedure.js";
import { startAdsJobs } from "./ads/jobs.js";
import { startPrescriptionReminderJob } from "./reminders/prescription.js";
import { startRenewalJob } from "./reminders/renewal.js";
import { startBirthdayJob } from "./reminders/birthday.js";
import { startDispatchRunJob } from "./dispatch/actions.js";
import { startNpsJob } from "./reminders/nps.js";
import { startPlanExpiryJob } from "./reminders/planExpiry.js";
import { startProfessionalBackfillJob } from "./scheduling/professionalBackfillJob.js";
import { startMetaEventWorker } from "./meta/worker.js";
import { startLearningJob } from "./ai/learning.js";
import { startFollowUpJob } from "./crm/followup.js";
import { startResumeFlowsJob } from "./crm/resumeFlows.js";
import { startReferralJob } from "./reminders/surveyFlow.js";
import { startBriefingJob } from "./ai/leadBriefing.js";
import { startLeadSummaryJob } from "./crm/leadSummary.js";
import { startCeBookingPullJob } from "./clinicaexperts/pull.js";
import { startCeReconcileJob } from "./clinicaexperts/sync.js";
import { startCeBirthdayJob } from "./clinicaexperts/birthdays.js";
import { REVISION } from "./version.js";
import { startUnansweredJob } from "./crm/unanswered.js";
import { startPhoneContactsJob } from "./crm/phoneContacts.js";
import { startBroadcastJob } from "./crm/broadcast.js";
import { startUazapiWebhookWorker, shutdownUazapiWorker } from "./uazapi/client.js";
import { startBackupJob } from "./maintenance/backupJob.js";
import { startAiUsageJob } from "./ai/usageJob.js";
import { openAiHealth } from "./ai/openaiCall.js";
import { flushUsageWithin } from "./ai/usageStats.js";
import { startHotLeadJobs } from "./crm/hotLeads.js";
import { startDailyReportJob } from "./crm/dailyReport.js";
import { startLeadReactivationJob } from "./crm/leadReactivation.js";
import { startHumanReturnJob } from "./crm/humanReturn.js";
import { apiRouter } from "./api/routes.js";
import { externalApiRouter } from "./api/external/router.js";
import { readStaffSession, clearSessionCookie } from "./api/staffSession.js";
import { isFreePlan, freePlanBlocksPath } from "./crm/plan.js";
import { prisma, enableWalMode } from "./db/client.js";
import { releaseMyLocks } from "./jobs/lock.js";
import { drainBackground } from "./jobs/background.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// gzip: o painel (HTML+JS+CSS) tem ~590 KB e o cache esta desligado de proposito;
// sem compressao toda carga baixava tudo cru (tela preta ate o JS chegar).
app.use(compression());

// Em producao a Alice roda atras de um proxy reverso (EasyPanel/Traefik), que
// injeta X-Forwarded-For/Proto. Sem isto o Express ignora esses headers e o
// express-rate-limit reclama (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR) e passa a
// contar todo mundo pelo mesmo IP. "1" = confia so no primeiro hop (o proxy).
// Quantos proxies existem na frente da Alice (EasyPanel/Traefik = 1). Se houver mais um (ex.: Cloudflare), ajuste
// TRUST_PROXY_HOPS=2; com o valor errado todo mundo parece vir do mesmo IP e o limite de login vale pro mundo inteiro.
app.set("trust proxy", Math.max(0, Number(process.env.TRUST_PROXY_HOPS ?? 1)) || 1);

// O painel ainda usa estilos inline para componentes dinamicos, por isso
// style-src permite unsafe-inline. Scripts continuam restritos aos arquivos
// servidos pela propria aplicacao; a landing nao depende mais de JS inline.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://connect.facebook.net"], // Pixel da Meta (landing)
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      connectSrc: ["'self'", "https://www.facebook.com", "https://connect.facebook.net"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
}));
// O envio de anexo no atendimento humano manda um arquivo em data URI (ate
// ~10MB + base64 infla ~33%) - so essa rota tem o limite maior.
app.use((req, res, next) => {
  if (req.method === "POST" && /^\/api\/conversations\/[^/]+\/send-media$/.test(req.path)) {
    express.json({ limit: "15mb" })(req, res, next);
  } else if (req.method === "POST" && req.path === "/site/lead") {
    express.json({ limit: "16kb" })(req, res, next); // formulario publico da landing: corpo pequeno
  } else if ((req.method === "POST" || req.method === "PUT") && /^\/api\/procedures(\/[^/]+)?$/.test(req.path)) {
    // O cadastro de procedimento leva as FOTOS de resultado (ate 12, em base64) no mesmo JSON: com 4mb nao cabiam nem 3
    // fotos e o salvar falhava com 413 - por isso as fotos de antes/depois "nao vinculavam".
    express.json({ limit: "40mb" })(req, res, next);
  } else {
    next();
  }
});
// 4mb cobre uma foto de ate ~2.5MB em data URI (base64 infla ~33%). Endpoints
// que aceitam foto (produtos/profissionais) sao os unicos que chegam perto.
app.use(express.json({ limit: "4mb" }));

// Versao que esta rodando (gravada no build por scripts/stamp.mjs).
let buildInfo: { commit: string; builtAt: string } = { commit: "dev", builtAt: "" };
try {
  buildInfo = JSON.parse(fs.readFileSync(path.join(__dirname, "build.json"), "utf8"));
} catch {
  /* rodando via tsx/dev: sem build.json */
}

// Saude: responde na hora (sem esperar o banco). Com 1 nucleo de CPU em uso alto, uma consulta
// ao banco aqui demorava, a checagem falhava e a hospedagem DERRUBAVA o servidor. O estado do
// banco e verificado em segundo plano e so informado.
let dbHealthy = true;
let dbCheckedAt = 0;
function refreshDbHealth(): void {
  if (Date.now() - dbCheckedAt < 15_000) return;
  dbCheckedAt = Date.now();
  void prisma.$queryRaw`SELECT 1`.then(() => (dbHealthy = true)).catch((error) => {
    dbHealthy = false;
    console.error("Health check do banco falhou:", error);
  });
}
// Ultima migracao do banco aplicada (prova de que o deploy rodou as migracoes). Consulta no maximo 1x por minuto.
let lastMigration: string | null = null;
let migrationCheckedAt = 0;
function refreshMigration(): void {
  if (Date.now() - migrationCheckedAt < 60_000) return;
  migrationCheckedAt = Date.now();
  void prisma.$queryRaw<{ migration_name: string }[]>`SELECT migration_name FROM _prisma_migrations ORDER BY migration_name DESC LIMIT 1`
    .then((rows) => (lastMigration = rows[0]?.migration_name ?? null))
    .catch(() => undefined);
}
app.get("/health", (_req, res) => {
  res.set("Cache-Control", "no-store");
  refreshDbHealth();
  refreshMigration();
  res.json({ ok: true, database: dbHealthy ? "ok" : "unavailable", uptimeSeconds: Math.floor(process.uptime()), commit: buildInfo.commit, builtAt: buildInfo.builtAt, revision: REVISION, lastMigration, openai: openAiHealth().state });
});

// Painel administrativo: so a "casca" HTML/CSS/JS, sem dado nenhum - fica
// publica de proposito pra qualquer cliente (ex: Isac) conseguir carregar a
// pagina e ver a tela de login. Quem protege os dados de verdade e a conta
// de atendente (StaffUser), exigida em toda chamada de API abaixo.
// Cache desativado: o painel ainda muda a cada sessao de trabalho e cache de
// navegador servindo JS/CSS velho ja causou confusao mais de uma vez.
app.use(
  "/admin",
  express.static(path.join(__dirname, "..", "public"), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.set("Cache-Control", "no-store"),
  })
);

// Site institucional (landing page) servido na raiz. Imagens da marca ficam
// em public/assets e sao expostas em /assets pra landing e painel usarem.
app.use("/assets", express.static(path.join(__dirname, "..", "public", "assets"), { maxAge: "7d" }));

// ---------------------------------------------------------------------------
// SEO: canonical, Open Graph, sitemap e robots dependem do endereco publico
// real. Em producao ele vem de PUBLIC_BASE_URL; sem essa variavel, deduzimos
// do proprio request (o proxy reverso manda X-Forwarded-Proto/Host). O
// index.html da landing tem o token %%BASE_URL%%, trocado aqui na entrega.
// ---------------------------------------------------------------------------
const CONFIGURED_BASE_URL = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
const SITE_INDEX_PATH = path.join(__dirname, "..", "public", "site", "index.html");

function siteBaseUrl(req: express.Request): string {
  if (CONFIGURED_BASE_URL) return CONFIGURED_BASE_URL;
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  const proto = forwardedProto || req.protocol || "https";
  const host = req.get("host") ?? "localhost";
  return `${proto}://${host}`;
}

let siteIndexTemplate: string | null = null;
function renderSiteIndex(req: express.Request): string {
  if (siteIndexTemplate === null || process.env.NODE_ENV !== "production") {
    siteIndexTemplate = fs.readFileSync(SITE_INDEX_PATH, "utf8");
  }
  return siteIndexTemplate.split("%%BASE_URL%%").join(siteBaseUrl(req));
}

app.get(["/", "/index.html"], (req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.type("html").send(renderSiteIndex(req));
});

app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send(
    ["User-agent: *", "Disallow: /admin", "Disallow: /api/", "", `Sitemap: ${siteBaseUrl(req)}/sitemap.xml`, ""].join("\n"),
  );
});

app.get("/sitemap.xml", (req, res) => {
  const base = siteBaseUrl(req);
  const lastmod = new Date().toISOString().slice(0, 10);
  res.type("application/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      `  <url>\n` +
      `    <loc>${base}/</loc>\n` +
      `    <lastmod>${lastmod}</lastmod>\n` +
      `    <changefreq>weekly</changefreq>\n` +
      `    <priority>1.0</priority>\n` +
      `  </url>\n` +
      `</urlset>\n`,
  );
});

app.use(
  "/",
  express.static(path.join(__dirname, "..", "public", "site"), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.set("Cache-Control", "no-store"),
  })
);

// API Externa (integracao server-to-server por API key). Fica fora do gate de
// sessao do painel - a autenticacao e a propria chave. Ver src/api/external/.
app.use("/external/v1", externalApiRouter);

// Captacao de leads da landing (publico, sem sessao; ver src/site/leads.ts).
app.use("/site", siteLeadRouter);

// So /staff/login e /staff/me passam sem sessao (o login em si e o "estou
// logado?" do frontend); qualquer outra rota de API exige uma conta valida.
const PUBLIC_API_PATHS = new Set([
  "/staff/login",
  "/staff/me",
  "/staff/bootstrap-admin",
]);

// Teto por IP em toda a API do painel: generoso o bastante pro painel (que
// faz ~1 requisicao/segundo de background) e varios atendentes na mesma
// clinica, mas fecha a porta pra um bot ou uma sessao comprometida martelando.
const apiRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas requisicoes em pouco tempo. Aguarde um instante." },
  // Webhook da UAZAPI tem alta cadencia legitima e ja e protegido por HMAC.
  skip: (req) => req.method === "POST" && req.path.startsWith("/uazapi/webhook/"),
});

// Limite dedicado pro webhook publico. A UAZAPI manda tudo do mesmo IP, entao
// contamos por clinica (o id vem no path /:clinicId/:signature) - 300/min por
// clinica e MUITA conversa; acima disso e flood.
const webhookRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: false,
  legacyHeaders: false,
  message: { error: "rate limited" },
  keyGenerator: (req) => req.path.split("/")[1] || req.ip || "anon",
  validate: { keyGeneratorIpFallback: false },
});
app.use("/api/uazapi/webhook", webhookRateLimit);

app.use(
  "/api",
  apiRateLimit,
  async (req, res, next) => {
    try {
    req.staff = readStaffSession(req.headers.cookie);
    const isUazapiWebhook = req.method === "POST" && req.path.startsWith("/uazapi/webhook/");
    const isPublicPath = PUBLIC_API_PATHS.has(req.path) || isUazapiWebhook;

    if (req.staff) {
      // Uma consulta so resolve tres coisas: (1) a conta ainda existe, (2) o
      // cookie nao foi invalidado por troca de senha / "desconectar acessos"
      // (sessionEpoch), (3) estado da clinica pro cliente.
      const user = await prisma.staffUser.findUnique({
        where: { id: req.staff.id },
        select: { sessionEpoch: true, clinic: { select: { active: true, plan: true } } },
      });
      if (!user || user.sessionEpoch !== req.staff.epoch) {
        // Cookie invalidado (troca de senha / "desconectar acessos") ou conta
        // apagada. Limpa o cookie velho e trata como deslogado. Numa rota
        // publica (ex: POST /staff/login) NAO pode responder 401 aqui: o
        // navegador segue mandando o cookie velho e a pessoa nunca conseguiria
        // logar de novo - o proprio login ficaria barrado pela sessao morta.
        req.staff = null;
        res.setHeader("Set-Cookie", clearSessionCookie());
        if (!isPublicPath) {
          res.status(401).json({ error: "Sessão encerrada. Entre novamente." });
          return;
        }
      } else if (req.staff.role !== "admin" && req.staff.clinicId) {
        // Clinica bloqueada (ex: inadimplencia): conta client dessa clinica para
        // de conseguir usar a API, mesmo com um cookie de sessao ainda valido.
        // Plano gratis: bloqueia as areas que ele nao tem (atendimento, agenda,
        // automacoes) - so CRM + Meta passam.
        if (!user.clinic || !user.clinic.active) {
          res.status(403).json({ error: "Conta bloqueada temporariamente. Entre em contato com o suporte." });
          return;
        }
        if (isFreePlan(user.clinic.plan) && freePlanBlocksPath(req.method, req.path)) {
          res.status(403).json({ error: "Recurso não disponível no plano Grátis." });
          return;
        }
      }
    }

    if (!req.staff && !isPublicPath) {
      res.status(401).json({ error: "Login necessario" });
      return;
    }

    next();
    } catch (err) {
      // Express 4 nao captura rejeicao de middleware async: sem isto, banco indisponivel = requisicao pendurada ate o timeout.
      next(err);
    }
  },
  apiRouter
);

// Error handler generico: garante que uma falha numa rota (ex: paciente/
// conversa inexistente, WhatsApp desconectado) responda em vez de
// derrubar o processo — sem isso o atendimento de todos os pacientes para junto.
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (res.headersSent) return;

  // findUniqueOrThrow/findFirstOrThrow lancam esse codigo quando o registro
  // ja nao existe (ex: conversa/contato apagado enquanto a tela ainda estava
  // aberta) - e um 404 normal, nao uma falha de servidor, entao nao vale
  // logar como erro nem responder 500.
  if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2025") {
    res.status(404).json({ error: "Registro nao encontrado (pode ter sido excluido)" });
    return;
  }

  console.error(`Erro na API (${req.method} ${req.originalUrl.split("?")[0]}):`, err);
  res.status(500).json({ error: "Erro interno" });
});

// Avisa cedo se algo essencial de producao esta faltando - sem isso o admin
// so descobre quando tenta conectar um WhatsApp e leva um erro sem contexto.
for (const [name, hint] of [
  ["PUBLIC_BASE_URL", "endereco HTTPS publico da Alice (usado no webhook e na doc da API)"],
  ["UAZAPI_WEBHOOK_SECRET", "segredo do webhook da UAZAPI (min. 32 caracteres)"],
  ["OPENAI_API_KEY", "chave da OpenAI - a Alice nao responde pacientes sem ela"],
] as const) {
  if (!process.env[name]?.trim()) console.warn(`[config] ${name} nao configurada: ${hint}`);
}
if (process.env.NODE_ENV !== "production") console.warn("[config] NODE_ENV != production - cookies sem Secure, cache do site desligado");

// Uma promessa rejeitada sem tratamento (ex.: tarefa em segundo plano com
// "void") derrubava o processo inteiro e o painel todo dava 502 ate o restart.
// Loga e segue: uma falha isolada nao pode tirar a clinica do ar.
process.on("unhandledRejection", (reason) => console.error("[process] unhandledRejection:", reason));
process.on("uncaughtException", (err) => console.error("[process] uncaughtException:", err));

const port = Number(process.env.PORT ?? 3000);
await enableWalMode(); // antes de abrir o servidor e iniciar os jobs: o banco esta livre
const httpServer = app.listen(port, () => {
  console.log(`Alice rodando na porta ${port}`);
  startReminderJob();
  startPostProcedureJob();
  startConfirmationRecoveryJob();
  startAdsJobs();
  startPreProcedureJob();
  startPrescriptionReminderJob();
  startRenewalJob();
  startBirthdayJob();
  startDispatchRunJob(); // fila persistida de recuperacao de disparos (aba Disparos)
  startFollowUpJob();
  startResumeFlowsJob(); // retomada de avaliacao cancelada / sem fechamento: nascem DESLIGADAS (ResumeFlowConfig)
  startBriefingJob(); // memoria do lead: atualiza quem teve conversa nova
  startBroadcastJob();
  startNpsJob();
  startReferralJob(); // convite de indicacao (mensagem separada, depois da nota alta): so envia se a clinica configurou texto e intervalo
  startPlanExpiryJob();
  startProfessionalBackfillJob();
  startMetaEventWorker();
  startLearningJob();
  startLeadSummaryJob();
  startCeBookingPullJob();
  startCeReconcileJob();
  startCeBirthdayJob();
  startUnansweredJob();
  startPhoneContactsJob();
  startUazapiWebhookWorker().catch((err) => console.error("Falha ao iniciar fila de webhooks UAZAPI:", err));
  startBackupJob();
  startAiUsageJob();
  startHotLeadJobs();
  startDailyReportJob();
  startLeadReactivationJob();
  startHumanReturnJob();
});

// Deploy/restart (SIGTERM): para de aceitar conexao, deixa os eventos de WhatsApp em andamento terminarem (ate 20 s) e
// devolve pra fila o que nao deu tempo. Sem isto o container era morto no meio de uma resposta e a mensagem ficava presa.
let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} recebido: finalizando com calma...`);
  httpServer.close();
  try {
    await shutdownUazapiWorker(20_000);
  } catch (err) {
    console.error("[shutdown] falha ao finalizar a fila:", err);
  }
  await releaseMyLocks().then((n) => n && console.log(`[shutdown] ${n} concessao(oes) de tarefa devolvida(s) para a copia nova assumir sem esperar`)).catch(() => undefined);
  await flushUsageWithin(5_000).catch(() => undefined); // grava a medicao pendente em ate 5 s; o que sobrar fica contado e no log
  await drainBackground(10_000).catch(() => undefined); // tarefas disparadas e esquecidas terminam antes de o banco ser solto
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
}
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
