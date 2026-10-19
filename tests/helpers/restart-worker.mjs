// PROCESSO DE TESTE DE REINICIO (nao e um teste: e chamado por tests/reinicio-contexto.test.mjs). Cada execucao e um processo Node NOVO, com memoria vazia, sobre o MESMO
// banco SQLite: e a unica forma fiel de provar o que um reinicio perde. OpenAI e UAZAPI sao simuladas; a morte do processo e injetada num ponto exato (process.exit).
// Uso: node restart-worker.mjs <spec.json>
// spec: { op: "enqueue"|"boot"|"maintain", clinicId, payload, model: [...], review, crash: {...}, log, nowOffsetMs }
//   model[i]: { content } | { tool: { name, args } } | { crash: true }  (consumido a cada chamada do modelo da conversa; { crash } mata o processo ANTES de responder)
//   review: objeto devolvido pela revisao por IA (padrao: enviar); crash.review = true mata o processo quando a revisao e chamada
//   (op maintain: recoverStuckReplies + manutencao da fila, como o servidor faz a cada minuto)
//   exitAfterIdle: true  -> (op enqueue) o processo MORRE assim que o evento termina, com o timer de agrupamento ainda em memoria
//   duringModel: { enqueue: payload } -> na 1a chamada ao modelo, chega outro webhook (a pessoa escreve durante a geracao)
//   waitMs: espera tantos ms antes de encerrar (para timers rearmados dispararem)
//   crash.send = "before" | "after": mata o processo no envio ao WhatsApp, antes de o texto ser registrado ("before") ou depois ("after")
import fs from "node:fs";

const spec = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.env.META_ENCRYPTION_KEY = "ab".repeat(32);
process.env.SESSION_SECRET ??= "y".repeat(40);
process.env.OPENAI_API_KEY = "test-key";
process.env.AI_SEND_REVIEW = spec.review || spec.crash?.review ? "on" : "off";

const log = (o) => fs.appendFileSync(spec.log, JSON.stringify({ pid: process.pid, ...o }) + "\n");
const model = [...(spec.model ?? [])];
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const plain = (content) => ({ id: "c", object: "chat.completion", created: 1, model: "gpt-4o-mini", choices: [{ index: 0, message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
const completion = ({ content = null, tool = null }) => ({
  id: "c", object: "chat.completion", created: 1, model: "gpt-4o-mini",
  choices: [{ index: 0, message: { role: "assistant", content, ...(tool ? { tool_calls: [{ id: `call_${Math.random().toString(36).slice(2)}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : {}) }, finish_reason: tool ? "tool_calls" : "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});
const die = (why) => { log({ t: "crash", why }); process.exit(137); };

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname.includes("openai.com")) {
    const body = JSON.parse(init.body);
    const system = String(body.messages?.[0]?.content ?? "");
    if (/REVISOR (DE ENVIO|das respostas)/.test(system)) {
      if (spec.crash?.review) die("revisao");
      log({ t: "review" });
      return jsonRes(200, plain(spec.review ?? { decisao: "enviar", confianca: "alta", motivo: "ok" }));
    }
    if (!body.tools) return jsonRes(200, plain("{}"));
    const lastTool = body.messages.filter((m) => m.role === "tool").at(-1)?.content ?? null;
    log({ t: "model", lastTool, users: body.messages.filter((m) => m.role === "user").map((m) => m.content) });
    if (spec.duringModel?.enqueue && !globalThis.__duringModelDone) {
      globalThis.__duringModelDone = true;
      void client.enqueueWebhook(spec.clinicId, spec.duringModel.enqueue).catch(() => undefined); // a pessoa escreve de novo enquanto a Alice gera
    }
    if (spec.duringModel?.enqueue) await new Promise((r) => setTimeout(r, 4000)); // a mensagem nova precisa terminar de ser gravada ANTES de a geracao devolver (senao nao e "durante")
    const next = model.shift();
    if (!next) throw new Error("o roteiro do modelo acabou (chamada a mais do que o esperado)");
    if (next.crash) die("modelo");
    return jsonRes(200, completion(next));
  }
  if (u.hostname.endsWith("uazapi.com") && u.pathname === "/send/text") {
    const b = JSON.parse(init.body);
    if (spec.crash?.send === "before") die("envio_antes");
    log({ t: "send", number: b.number, text: b.text });
    if (spec.crash?.send === "after") die("envio_depois");
  }
  return jsonRes(200, { id: "msg" });
};

const { prisma } = await import("../../dist/db/client.js");
const client = await import("../../dist/uazapi/client.js");

const waitIdle = async (ms = 90_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const open = await prisma.uazapiWebhookEvent.count({ where: { clinicId: spec.clinicId, status: { in: ["pending", "processing"] } } });
    if (open === 0) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  log({ t: "timeout_aguardando_fila" });
};

try {
  if (spec.op === "enqueue") {
    log({ t: "enqueue", result: await client.enqueueWebhook(spec.clinicId, spec.payload) });
    await waitIdle();
    if (spec.exitAfterIdle) die("queda_com_timer_em_memoria"); // o evento foi aceito e concluido; o timer de agrupamento morre com o processo
  } else if (spec.op === "boot") {
    await client.startUazapiWebhookWorker(); // o mesmo que o servidor faz ao subir
    await waitIdle();
    if (spec.waitMs) await new Promise((r) => setTimeout(r, spec.waitMs));
  } else if (spec.op === "maintain") {
    // a manutencao de cada minuto (o teste envelhece as linhas no banco: a resposta parada precisa passar de 4 min para ser retomada)
    log({ t: "recover", result: await client.recoverStuckReplies() });
    await client.maintainUazapiQueue();
    await waitIdle();
  }
} catch (err) {
  log({ t: "erro", message: String(err?.message ?? err).slice(0, 300) });
} finally {
  await prisma.$disconnect();
}
log({ t: "fim" });
process.exit(0);
