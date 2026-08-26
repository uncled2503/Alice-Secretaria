import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import { startReminderJob } from "./reminders/cron.js";
import { startFollowUpJob } from "./crm/followup.js";
import { startBroadcastJob } from "./crm/broadcast.js";
import { restoreAllConnections } from "./whatsapp/manager.js";
import { apiRouter } from "./api/routes.js";
import { basicAuth } from "./api/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "5mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// Painel administrativo: protegido por usuario/senha (ADMIN_USER/ADMIN_PASSWORD no .env)
// Cache desativado de proposito: o painel ainda muda a cada sessao de trabalho
// e cache de navegador servindo JS/CSS velho ja causou confusao mais de uma vez.
app.use(
  "/admin",
  basicAuth,
  express.static(path.join(__dirname, "..", "public"), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.set("Cache-Control", "no-store"),
  })
);
app.use("/api", basicAuth, apiRouter);

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
