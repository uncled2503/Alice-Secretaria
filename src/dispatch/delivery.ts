import { prisma } from "../db/client.js";

// ---------------------------------------------------------------------------
// ESTADO DE ENTREGA vindo do provedor (webhook `messages_update`: Delivered / Read / Failed). Principios:
//  - ACEITO pelo provedor != ENTREGUE != LIDO: cada estado e guardado separado (deliveryState) e nunca somado a outro;
//  - os eventos podem repetir e chegar FORA DE ORDEM: o estado so AVANCA (accepted < delivered < read); "failed" depois de entregue/lido e ignorado;
//  - "failed" depois de ACEITO nao autoriza reenvio automatico (o provedor pode ter entregue por outro caminho): apenas fica visivel para a equipe decidir;
//  - o formato exato do payload nao e documentado em detalhe: a leitura e TOLERANTE (varios nomes de campo) e, sem id reconhecivel, o evento e ignorado sem erro.
// ---------------------------------------------------------------------------
export type DeliveryState = "accepted" | "delivered" | "read" | "failed";
const RANK: Record<DeliveryState, number> = { accepted: 1, failed: 1, delivered: 2, read: 3 };

export interface DeliveryUpdate { providerId: string; state: DeliveryState; at: Date }

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null);
const str = (...v: unknown[]): string | undefined => { for (const x of v) if (typeof x === "string" && x.trim()) return x.trim(); return undefined; };

// Normaliza o texto/numero de status do provedor.
export function normalizeDeliveryStatus(raw: unknown): DeliveryState | null {
  if (typeof raw === "number") return raw >= 4 ? "read" : raw === 3 ? "delivered" : raw === 0 ? "failed" : raw >= 1 ? "accepted" : null;
  if (typeof raw !== "string") return null;
  const s = raw.toLowerCase();
  if (/read|played|lid[ao]/.test(s)) return "read";
  if (/deliver|entreg/.test(s)) return "delivered";
  if (/fail|error|erro|falh|undeliver/.test(s)) return "failed";
  if (/sent|server|accept|pending|enviad/.test(s)) return "accepted";
  return null;
}

// Le o corpo do webhook; devolve a atualizacao de entrega ou null (nao e um evento de status ou nao ha id).
export function deliveryUpdateFromPayload(body: unknown): DeliveryUpdate | null {
  const root = rec(body);
  if (!root) return null;
  const kind = (str(root.EventType, root.eventType, root.event, root.type) ?? "").toLowerCase();
  if (!kind.includes("update") && !kind.includes("status") && !kind.includes("ack")) return null;
  const data = rec(root.data) ?? rec(root.message) ?? rec(root.event) ?? root;
  const inner = rec(data.message) ?? data;
  const id = str(inner.id, inner.messageid, inner.messageId, inner.MessageID, data.id, data.messageid, data.messageId, root.id);
  const status = normalizeDeliveryStatus(inner.status ?? inner.state ?? inner.ack ?? inner.Type ?? data.status ?? data.state ?? data.ack ?? root.status ?? root.state);
  if (!id || !status) return null;
  const ts = Number(inner.timestamp ?? data.timestamp ?? root.timestamp);
  const at = Number.isFinite(ts) && ts > 0 ? new Date(ts > 1e12 ? ts : ts * 1000) : new Date();
  return { providerId: id, state: status, at };
}

const tail = (id: string) => id.split(":").pop() ?? id;

// Aplica a atualizacao ao registro de envio dessa clinica (lembrete/confirmacao/cobranca ou aniversario). Devolve quantos registros foram atualizados.
export async function applyDeliveryUpdate(clinicId: string, u: DeliveryUpdate): Promise<number> {
  const key = tail(u.providerId);
  if (key.length < 6) return 0;
  let n = 0;
  const advance = (cur: string | null | undefined): boolean => {
    if (!cur) return true;
    const c = cur as DeliveryState;
    if (!(c in RANK)) return true;
    if (u.state === "failed") return c === "accepted" || c === "failed"; // falha nao desfaz entrega
    return RANK[u.state] > RANK[c] || c === "failed";
  };
  const dispatches = await prisma.reminderDispatch.findMany({ where: { clinicId, providerId: { contains: key } }, select: { id: true, providerId: true, deliveryState: true } });
  for (const d of dispatches) {
    if (!d.providerId || tail(d.providerId) !== key || !advance(d.deliveryState)) continue;
    await prisma.reminderDispatch.update({ where: { id: d.id }, data: { deliveryState: u.state, deliveryAt: u.at } });
    n++;
  }
  const bdays = await prisma.birthdaySent.findMany({ where: { rule: { clinicId }, providerId: { contains: key } }, select: { id: true, providerId: true, deliveryState: true } });
  for (const b of bdays) {
    if (!b.providerId || tail(b.providerId) !== key || !advance(b.deliveryState)) continue;
    await prisma.birthdaySent.update({ where: { id: b.id }, data: { deliveryState: u.state, deliveryAt: u.at } });
    n++;
  }
  return n;
}

// Chamado pelo webhook: nunca lanca (um status que nao casa com nada e normal - mensagens de conversa comum tambem geram status).
export async function ingestDeliveryStatus(clinicId: string, body: unknown): Promise<"applied" | "ignored" | "not_status"> {
  const u = deliveryUpdateFromPayload(body);
  if (!u) return "not_status";
  try {
    return (await applyDeliveryUpdate(clinicId, u)) > 0 ? "applied" : "ignored";
  } catch (err) {
    console.error("[UAZAPI] status de entrega nao aplicado:", err instanceof Error ? err.message : err);
    return "ignored";
  }
}
