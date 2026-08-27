import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import { startReminderJob } from "./reminders/cron.js";
import { startFollowUpJob } from "./crm/followup.js";
import { startBroadcastJob } from "./crm/broadcast.js";
import { restoreAllConnections } from "./whatsapp/manager.js";
import { apiRouter } from "./api/routes.js";
import { readStaffSession } from "./api/staffSession.js";
import { prisma } from "./db/client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "5mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

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

// So /staff/login e /staff/me passam sem sessao (o login em si e o "estou
// logado?" do frontend); qualquer outra rota de API exige uma conta valida.
const PUBLIC_API_PATHS = new Set(["/staff/login", "/staff/me", "/staff/bootstrap-admin"]);

app.use(
  "/api",
  async (req, res, next) => {
    req.staff = readStaffSession(req.headers.cookie);
    if (!req.staff && !PUBLIC_API_PATHS.has(req.path)) {
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
// conversa inexistente, WhatsApp desconectado) responda 500 em vez de
// derrubar o processo — sem isso o atendimento de todos os pacientes para junto.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Erro na API:", err);
  if (!res.headersSent) res.status(500).json({ error: "Erro interno" });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Alice rodando na porta ${port}`);
  startReminderJob();
  startFollowUpJob();
  startBroadcastJob();
  restoreAllConnections().catch((err) => console.error("Falha ao restaurar conexoes do WhatsApp:", err));
});
