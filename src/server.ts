import "dotenv/config";
import path from "path";
import express from "express";
import { parseWebhookPayload, sendText, transcribeAudio, creds } from "./uazapi/client";
import { handleIncomingMessage } from "./ai/alice";
import { prisma } from "./db/client";
import { startReminderJob } from "./reminders/cron";
import { startFollowUpJob } from "./crm/followup";
import { startBroadcastJob } from "./crm/broadcast";
import { apiRouter } from "./api/routes";
import { basicAuth } from "./api/auth";

const app = express();
app.use(express.json({ limit: "5mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// Painel administrativo: protegido por usuario/senha (ADMIN_USER/ADMIN_PASSWORD no .env)
app.use("/admin", basicAuth, express.static(path.join(__dirname, "..", "public")));
app.use("/api", basicAuth, apiRouter);

// Webhook chamado pela UazAPI a cada mensagem recebida no WhatsApp conectado.
app.post("/webhook/uazapi", async (req, res) => {
  // responde rapido pra UazAPI nao re-tentar por timeout; processa async depois
  res.sendStatus(200);

  try {
    const incoming = parseWebhookPayload(req.body);
    if (!incoming) return;

    // Identifica a clinica pelo token da instancia que recebeu a mensagem
    // (cada clinica com WhatsApp proprio tem o seu). Se nenhuma clinica tiver
    // esse token cadastrado, cai na clinica "legada" sem token (modo de
    // clinica unica, usando UAZAPI_TOKEN do .env).
    const clinic = incoming.instanceToken
      ? (await prisma.clinic.findFirst({ where: { uazapiToken: incoming.instanceToken } })) ??
        (await prisma.clinic.findFirst({ where: { uazapiToken: null } }))
      : await prisma.clinic.findFirst({ where: { uazapiToken: null } });

    if (!clinic) {
      console.error("Nenhuma clinica cadastrada para o token recebido — rode o seed ou cadastre a clinica.");
      return;
    }

    const clinicCreds = creds(clinic);

    if (!incoming.text && incoming.mediaMessageId) {
      incoming.text = (await transcribeAudio(incoming.mediaMessageId, clinicCreds)) ?? undefined;
    }
    if (!incoming.text) return; // midia sem transcricao (imagem/video/documento) - ignorado por ora

    const reply = await handleIncomingMessage({
      clinicId: clinic.id,
      patientPhone: incoming.phone,
      patientName: incoming.pushName,
      text: incoming.text,
    });

    if (reply) await sendText(incoming.phone, reply, clinicCreds);
  } catch (err) {
    console.error("Erro processando webhook:", err);
  }
});

// Error handler generico: garante que uma falha numa rota (ex: paciente/
// conversa inexistente, UazAPI fora do ar) responda 500 em vez de derrubar
// o processo — sem isso o atendimento de todos os pacientes para junto.
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
});
