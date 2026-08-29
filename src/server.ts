import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import helmet from "helmet";
import { startReminderJob } from "./reminders/cron.js";
import { startPostProcedureJob } from "./reminders/postProcedure.js";
import { startRenewalJob } from "./reminders/renewal.js";
import { startBirthdayJob } from "./reminders/birthday.js";
import { startFollowUpJob } from "./crm/followup.js";
import { startBroadcastJob } from "./crm/broadcast.js";
import { startUazapiWebhookWorker } from "./uazapi/client.js";
import { apiRouter } from "./api/routes.js";
import { readStaffSession } from "./api/staffSession.js";
import { prisma } from "./db/client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Em producao a Alice roda atras de um proxy reverso (EasyPanel/Traefik), que
// injeta X-Forwarded-For/Proto. Sem isto o Express ignora esses headers e o
// express-rate-limit reclama (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR) e passa a
// contar todo mundo pelo mesmo IP. "1" = confia so no primeiro hop (o proxy).
app.set("trust proxy", 1);

// O painel ainda usa estilos inline para componentes dinamicos, por isso
// style-src permite unsafe-inline. Scripts continuam restritos aos arquivos
// servidos pela propria aplicacao; a landing nao depende mais de JS inline.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
}));
app.use(express.json({ limit: "8mb" })); // fotos de produto vem como data URI (base64) no body

app.get("/health", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, database: "ok", uptimeSeconds: Math.floor(process.uptime()) });
  } catch (error) {
    console.error("Health check falhou:", error);
    res.status(503).json({ ok: false, database: "unavailable" });
  }
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
app.use(
  "/",
  express.static(path.join(__dirname, "..", "public", "site"), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.set("Cache-Control", "no-store"),
  })
);

// So /staff/login e /staff/me passam sem sessao (o login em si e o "estou
// logado?" do frontend); qualquer outra rota de API exige uma conta valida.
const PUBLIC_API_PATHS = new Set([
  "/staff/login",
  "/staff/me",
  "/staff/bootstrap-admin",
]);

app.use(
  "/api",
  async (req, res, next) => {
    req.staff = readStaffSession(req.headers.cookie);
    const isUazapiWebhook = req.method === "POST" && req.path.startsWith("/uazapi/webhook/");
    if (!req.staff && !PUBLIC_API_PATHS.has(req.path) && !isUazapiWebhook) {
      res.status(401).json({ error: "Login necessario" });
      return;
    }

    // Clinica bloqueada (ex: inadimplencia): conta client dessa clinica para
    // de conseguir usar a API, mesmo com um cookie de sessao ainda valido.
    if (req.staff && req.staff.role !== "admin" && req.staff.clinicId) {
      const clinic = await prisma.clinic.findUnique({ where: { id: req.staff.clinicId }, select: { active: true } });
      if (!clinic || !clinic.active) {
        res.status(403).json({ error: "Conta bloqueada temporariamente. Entre em contato com o suporte." });
        return;
      }
    }

    next();
  },
  apiRouter
);

// Error handler generico: garante que uma falha numa rota (ex: paciente/
// conversa inexistente, WhatsApp desconectado) responda em vez de
// derrubar o processo — sem isso o atendimento de todos os pacientes para junto.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (res.headersSent) return;

  // findUniqueOrThrow/findFirstOrThrow lancam esse codigo quando o registro
  // ja nao existe (ex: conversa/contato apagado enquanto a tela ainda estava
  // aberta) - e um 404 normal, nao uma falha de servidor, entao nao vale
  // logar como erro nem responder 500.
  if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2025") {
    res.status(404).json({ error: "Registro nao encontrado (pode ter sido excluido)" });
    return;
  }

  console.error("Erro na API:", err);
  res.status(500).json({ error: "Erro interno" });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Alice rodando na porta ${port}`);
  startReminderJob();
  startPostProcedureJob();
  startRenewalJob();
  startBirthdayJob();
  startFollowUpJob();
  startBroadcastJob();
  startUazapiWebhookWorker().catch((err) => console.error("Falha ao iniciar fila de webhooks UAZAPI:", err));
});
