// Agente de pareamento pela rede local - roda aqui no PC (nao na VPS) quando
// a VPS estiver sendo recusada pelo WhatsApp na hora de gerar QR Code.
// Uso: RELAY_SECRET=<mesmo valor da VPS> node scripts/relay-agent.mjs
//
// Fica esperando (heartbeat) por um pedido de pareamento criado quando
// alguem clica em "Gerar QR Code" no painel; ao receber um, pareia
// localmente (QR aparece no painel normalmente) e, assim que conectar,
// entrega a sessao pronta pra VPS assumir o atendimento e encerra a conexao
// local - esse agente nao fica no meio das conversas do dia a dia.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import makeWASocket, { useMultiFileAuthState, Browsers } from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import pino from "pino";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SERVER_URL = (process.env.RELAY_SERVER_URL || "https://aliceconversa.com.br/api").replace(/\/$/, "");
const SECRET = process.env.RELAY_SECRET;
const POLL_INTERVAL_MS = 2000;
const JOB_TIMEOUT_MS = 3 * 60_000;

if (!SECRET) {
  console.error("Defina RELAY_SECRET (o mesmo valor configurado na VPS) antes de rodar este script.");
  process.exit(1);
}

async function api(pathSuffix, body) {
  const res = await fetch(`${SERVER_URL}${pathSuffix}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${pathSuffix} -> HTTP ${res.status}`);
  return res.json();
}

async function runJob(clinicId, jobToken) {
  console.log(`[${clinicId}] job recebido - iniciando pareamento pela rede local...`);
  const authFolder = path.join(__dirname, "..", ".relay-sessions", `${clinicId}-${Date.now()}`);
  fs.mkdirSync(authFolder, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  return new Promise((resolve) => {
    const logger = pino({ level: "error" });

    const sock = makeWASocket({
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: Browsers.macOS("Desktop"),
      syncFullHistory: false,
    });

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutHandle);
      try {
        sock.end(undefined);
      } catch {
        // ja vamos descartar essa conexao de qualquer forma
      }
      fs.rmSync(authFolder, { recursive: true, force: true });
      resolve();
    };

    const timeoutHandle = setTimeout(() => {
      console.log(`[${clinicId}] job expirou sem parear.`);
      finish();
    }, JOB_TIMEOUT_MS);

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      if (update.qr) {
        console.log(`[${clinicId}] QR gerado - escaneie pelo painel.`);
        const dataUrl = await QRCode.toDataURL(update.qr);
        await api("/relay/report", { secret: SECRET, clinicId, jobToken, event: "qr", qr: dataUrl }).catch((err) =>
          console.error(`[${clinicId}] falha ao reportar QR:`, err.message)
        );
      }

      if (update.connection === "open") {
        console.log(`[${clinicId}] pareado com sucesso pela rede local - enviando sessao pra VPS...`);
        const files = {};
        for (const name of fs.readdirSync(authFolder)) {
          files[name] = fs.readFileSync(path.join(authFolder, name)).toString("base64");
        }
        try {
          await api("/relay/session", { secret: SECRET, clinicId, jobToken, files });
          console.log(`[${clinicId}] sessao entregue pra VPS - encerrando conexao local.`);
        } catch (err) {
          console.error(`[${clinicId}] falha ao enviar sessao pra VPS:`, err.message);
        }
        finish();
      }

      if (update.connection === "close") {
        const statusCode = update.lastDisconnect?.error?.output?.statusCode;
        const message = `Conexao local encerrada (statusCode=${statusCode ?? "?"}).`;
        console.log(`[${clinicId}] ${message}`);
        await api("/relay/report", { secret: SECRET, clinicId, jobToken, event: "close", message }).catch(() => {});
        finish();
      }
    });
  });
}

async function main() {
  console.log(`Agente de rede local pronto - falando com ${SERVER_URL}`);
  console.log("Deixe essa janela aberta enquanto quiser que a rede local fique disponivel pra gerar QR Code.");

  for (;;) {
    try {
      const { job } = await api("/relay/heartbeat", { secret: SECRET });
      if (job) await runJob(job.clinicId, job.jobToken);
    } catch (err) {
      console.error("Erro no heartbeat:", err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main();
