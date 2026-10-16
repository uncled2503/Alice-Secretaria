import crypto from "node:crypto";
import OpenAI from "openai";
import { prisma } from "../db/client.js";
import { logActivity } from "../crm/activity.js";
import { aiExtraEnabled } from "./aiSwitch.js";
import { patientFacts } from "./leadBriefing.js";
import { extractMentions } from "./slotGuard.js";

// ---------------------------------------------------------------------------
// REVISAO DE ENVIO POR IA (pedido do dono, 16/10/2026: "qualquer mensagem que for ser enviada, quero que seja enviada pela API do ChatGPT pra ver
// se faz sentido enviar aquela mensagem naquele momento"). Antes de QUALQUER mensagem automatica (lembrete, recontato, pos, pesquisa, aniversario,
// renovacao, campanha, preparo, lista de espera) ou resposta da Alice sair pro WhatsApp de uma pessoa, uma chamada curta a IA le a FICHA dela
// (agenda, cancelamentos, o que ja recebeu, o que a equipe falou, memoria do lead) e decide: enviar, NAO enviar ou (so resposta da Alice) reescrever.
//
// Seguranca contra excesso de zelo (a IA nao pode derrubar confirmacoes validas):
//  - o padrao e ENVIAR; so barra com confianca "alta" e motivo concreto;
//  - IA fora do ar, lenta ou com resposta estranha = envia (a revisao nunca trava o atendimento);
//  - toda mensagem barrada fica no Diario de atividades (com o motivo) e aparece no relatorio das 20h.
// ---------------------------------------------------------------------------

export type OutboundKind =
  | "resposta_alice" | "lembrete" | "recontato" | "pos" | "pesquisa" | "aniversario" | "renovacao" | "campanha" | "preparo" | "lista_espera" | "agendamento" | "outra" | "interna";

const KIND_LABEL: Record<OutboundKind, string> = {
  resposta_alice: "resposta da Alice a uma mensagem da pessoa",
  lembrete: "lembrete/confirmacao automatica de um agendamento",
  recontato: "recontato automatico (pessoa que parou de responder)",
  pos: "acompanhamento automatico depois do procedimento",
  pesquisa: "pesquisa de satisfacao automatica",
  aniversario: "parabens de aniversario automatico",
  renovacao: "convite de renovacao/retorno automatico",
  campanha: "campanha/mensagem programada em massa",
  preparo: "orientacao de preparo antes do procedimento",
  lista_espera: "aviso de vaga da lista de espera",
  agendamento: "mensagem sobre um agendamento criado pela equipe",
  outra: "mensagem automatica",
  interna: "aviso interno da equipe",
};

export interface GateVerdict {
  send: boolean;
  reason: string;
  rewritten?: string;
  confidence: "alta" | "media" | "baixa";
  reviewed: boolean; // false = nao houve revisao (desligada, sem ficha, IA fora do ar)
}

export const GATE_SYSTEM = `Voce e o REVISOR DE ENVIO de uma clinica de estetica. Antes de uma mensagem ir para o WhatsApp de uma pessoa, voce decide se FAZ SENTIDO enviar ESSA mensagem NESTE momento, olhando a FICHA dela (agenda, cancelamentos, o que ja recebeu, o que a equipe falou, memoria do lead).
Responda SO um JSON: {"decisao":"enviar|nao_enviar|reescrever","confianca":"alta|media|baixa","motivo":"uma frase","texto":"so se reescrever"}
O padrao e ENVIAR. Use nao_enviar so com motivo CONCRETO e verificavel na ficha, e confianca "alta" so quando a ficha mostra o problema com clareza. Motivos validos:
1. A mensagem fala de um agendamento que nao existe mais ou diverge da AGENDA da ficha (cancelado, remarcado, outro dia/hora/procedimento, "amanha" quando a data e outra).
2. A pessoa pediu para nao receber mensagens, ou disse que nao tem interesse, e a mensagem e automatica ou promocional.
3. Mensagem igual ou muito parecida ja foi enviada nas ultimas ~20h (ficha: mensagens automaticas ja recebidas), ou repete o que a Alice acabou de dizer.
4. Oferece avaliacao, horarios ou agendamento a quem JA TEM horario marcado, JA foi atendida/avaliada, ou NAO pediu agenda (resposta curta tipo "ok"/"nao", comentario, assunto de amiga/familiar).
5. Contradiz o que a EQUIPE combinou/disse nas ultimas mensagens, ou a equipe esta conversando com ela agora (fala humana ha menos de 30 min) e a mensagem e automatica (recontato, campanha, pesquisa, aniversario).
6. Momento inadequado: pesquisa ou promocao logo apos reclamacao/problema; acompanhamento pos-procedimento para quem relatou problema; recontato/convite para quem acabou de dizer que nao pode, esta doente/no hospital ou combinou retornar em data futura (retorno combinado na ficha).
7. (resposta da Alice) inventa valor, desconto, horario, profissional ou procedimento que nao esta na ficha, ou promete algo que ela nao consegue fazer, ou ignora a pergunta da pessoa.
Se so um trecho esta errado e o resto serve, e a mensagem e RESPOSTA DA ALICE, use "reescrever": devolva o texto corrigido, curto, SEM acrescentar nenhum fato, horario ou valor novo. Para mensagens automaticas nunca reescreva.
Lembretes de confirmacao para agendamentos que ESTAO na agenda e sem ressalva na ficha devem ser enviados. Em duvida, ENVIAR.`;

export function buildGateUser(p: { kind: OutboundKind; text: string; nowLabel: string; facts: string }): string {
  return `TIPO DE MENSAGEM: ${KIND_LABEL[p.kind] ?? KIND_LABEL.outra}\nAGORA: ${p.nowLabel}\n\nFICHA DA PESSOA:\n${p.facts}\n\nMENSAGEM QUE VAI SER ENVIADA:\n"""\n${p.text.slice(0, 1500)}\n"""`;
}

// PURO: o texto reescrito nao pode trazer fato novo (numero, data, horario, valor) que o original nao tinha, nem ficar maior.
export function acceptsRewrite(original: string, rewritten: string): boolean {
  const r = rewritten.trim();
  if (r.length < 8 || r.length > Math.max(160, original.length * 1.2)) return false;
  const a = extractMentions(original);
  const b = extractMentions(r);
  if (b.times.some((t) => !a.times.includes(t)) || b.dates.some((d) => !a.dates.includes(d))) return false;
  const nums = (t: string) => new Set(t.match(/R\$\s?[\d.,]+|\d{2,}/g) ?? []);
  const na = nums(original);
  for (const n of nums(r)) if (!na.has(n)) return false;
  return true;
}

// PURO: interpreta a resposta da IA e aplica a politica (so barra com confianca alta; so reescreve resposta da Alice e se o texto for aceitavel).
export function decide(raw: string | null | undefined, kind: OutboundKind, original: string): GateVerdict {
  const open: GateVerdict = { send: true, reason: "sem resposta valida da revisao", confidence: "baixa", reviewed: false };
  if (!raw) return open;
  let data: { decisao?: unknown; confianca?: unknown; motivo?: unknown; texto?: unknown } | null = null;
  try {
    data = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
  } catch {
    return open;
  }
  if (!data || typeof data !== "object") return open;
  const conf = data.confianca === "alta" || data.confianca === "media" ? data.confianca : "baixa";
  const reason = typeof data.motivo === "string" && data.motivo.trim() ? data.motivo.trim().slice(0, 240) : "sem motivo informado";
  if (data.decisao === "nao_enviar" && conf === "alta") return { send: false, reason, confidence: conf, reviewed: true };
  if (data.decisao === "reescrever" && kind === "resposta_alice" && conf !== "baixa" && typeof data.texto === "string" && acceptsRewrite(original, data.texto)) {
    return { send: true, reason, rewritten: data.texto.trim(), confidence: conf, reviewed: true };
  }
  return { send: true, reason: data.decisao === "enviar" ? reason : `ressalva sem confianca suficiente: ${reason}`, confidence: conf, reviewed: true };
}

export type GateCall = (system: string, user: string) => Promise<string | null>;
let client: OpenAI | null = null;
const defaultCall: GateCall = async (system, user) => {
  client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
  const res = await client.chat.completions.create(
    {
      model: process.env.OPENAI_GATE_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      temperature: 0, max_tokens: 220, response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    },
    { timeout: 12_000 },
  );
  return res.choices[0]?.message?.content ?? null;
};

// Mesma mensagem para a mesma pessoa: nao pergunta de novo (reenvios/tentativas do job). Enviar vale 10 min; barrar vale 3 h.
const cache = new Map<string, { at: number; verdict: GateVerdict }>();
const hash = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

export async function reviewOutbound(
  p: { clinicId: string; phone: string; text: string; kind: OutboundKind },
  deps: { call?: GateCall; now?: Date } = {},
): Promise<GateVerdict> {
  const skip = (reason: string): GateVerdict => ({ send: true, reason, confidence: "baixa", reviewed: false });
  if (p.kind === "interna" || !aiExtraEnabled("AI_SEND_REVIEW")) return skip("revisao desligada");
  try {
    const facts = await patientFacts({ clinicId: p.clinicId, phone: p.phone }, deps.now);
    if (!facts) return skip("numero sem ficha (nao e paciente)");

    const key = `${facts.patientId}|${p.kind}|${hash(p.text)}`;
    const hit = cache.get(key);
    const ttl = hit && !hit.verdict.send ? 3 * 3_600_000 : 10 * 60_000;
    if (hit && Date.now() - hit.at < ttl) return hit.verdict;

    const clinic = await prisma.clinic.findUnique({ where: { id: p.clinicId }, select: { timezone: true } });
    const tz = clinic?.timezone || "America/Sao_Paulo";
    const now = deps.now ?? new Date();
    const nowLabel = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, dateStyle: "full", timeStyle: "short" }).format(now);
    const raw = await (deps.call ?? defaultCall)(GATE_SYSTEM, buildGateUser({ kind: p.kind, text: p.text, nowLabel, facts: facts.text }));
    const verdict = decide(raw, p.kind, p.text);
    cache.set(key, { at: Date.now(), verdict });
    if (cache.size > 2000) for (const [k, v] of cache) if (Date.now() - v.at > 3 * 3_600_000) cache.delete(k);

    if (!verdict.send) {
      console.warn(`[revisao-envio] BARROU ${p.kind} para ${p.phone.slice(-4)}: ${verdict.reason} | "${p.text.replace(/\s+/g, " ").slice(0, 80)}"`);
      await logActivity({
        clinicId: p.clinicId, patientId: facts.patientId, type: "message_blocked_ai", area: "automacoes",
        title: "Mensagem barrada pela revisão da IA",
        description: `${KIND_LABEL[p.kind]}: ${verdict.reason} — "${p.text.replace(/\s+/g, " ").slice(0, 140)}"`, actorName: null,
      }).catch(() => undefined);
    } else if (verdict.rewritten) {
      console.warn(`[revisao-envio] REESCREVEU ${p.kind} para ${p.phone.slice(-4)}: ${verdict.reason}`);
    }
    return verdict;
  } catch (err) {
    console.error("[revisao-envio] revisao falhou, enviando como estava:", err instanceof Error ? err.message : err);
    return skip("revisao indisponivel");
  }
}
