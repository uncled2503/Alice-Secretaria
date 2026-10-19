import crypto from "node:crypto";
import OpenAI from "openai";
import { safeFetch } from "./wellFormed.js";
import { prisma } from "../db/client.js";
import { logActivity } from "../crm/activity.js";
import { aiExtraEnabled } from "./aiSwitch.js";
import { patientFacts } from "./leadBriefing.js";
import { extractMentions } from "./slotGuard.js";
import { recordUsage } from "./usageStats.js";
import { isFixedReply } from "./fixedReplies.js";

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

import { parseCategory, vetoStands, AUTOMATION_PURPOSE, type VetoCategory } from "../crm/vetoReasons.js";
import { safeSlice } from "./wellFormed.js";
import { REVISION } from "../version.js";

export type OutboundKind =
  | "resposta_alice" | "lembrete" | "recontato" | "retomada" | "indicacao" | "pos" | "pesquisa" | "aniversario" | "renovacao" | "campanha" | "preparo" | "lista_espera" | "agendamento" | "outra" | "interna";

const KIND_LABEL: Record<OutboundKind, string> = {
  resposta_alice: "resposta da Alice a uma mensagem da pessoa",
  lembrete: "lembrete/confirmacao automatica de um agendamento",
  recontato: "recontato automatico (pessoa que parou de responder)",
  indicacao: "convite de indicacao automatico (mensagem separada, depois do agradecimento a nota alta da pesquisa)",
  retomada: "retomada automatica de avaliacao (convite sem compromisso para quem cancelou a avaliacao ou foi avaliada e nao fechou)",
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
  category?: VetoCategory; // por que barrou/reescreveu (so informativo)
  technical?: "timeout" | "api_error" | "invalid_response"; // a revisao NAO funcionou (servico), distinto de "funcionou e barrou"
  held?: boolean; // automacao RETIDA porque o revisor esta indisponivel: nao e veto, nao gasta tentativa; tenta de novo quando o revisor voltar
  heldWhy?: "revisao" | "equipe"; // por que foi retida: revisor fora do ar, ou a equipe esta conversando com a pessoa agora (pausa humana)
  detail?: string; // detalhe tecnico curto (ex.: "HTTP 429 insufficient_quota"), sem dados pessoais
}

// ---------------------------------------------------------------------------
// PAUSA POR ATENDIMENTO HUMANO, POR TIPO DE MENSAGEM (19/10/2026; antes cada tipo ficava a criterio da IA, e preparo e aniversario foram barrados "porque a pessoa estava com a equipe"):
//  - RELACIONAMENTO / COMERCIAL (recontato, retomada, convite, pesquisa, aniversario, renovacao, campanha, outras): se uma pessoa da equipe falou com ela ha menos de 30 min, a automacao ESPERA
//    (retida, NAO e veto e NAO consome a etapa); decide o codigo, sem gastar IA. Volta sozinha quando a equipe para de conversar.
//  - LIGADAS A UMA RESERVA OU A UM ATENDIMENTO (lembrete/confirmacao, preparo, mensagem de agendamento, pos-procedimento, vaga da lista de espera): a conversa com a equipe NAO as pausa, porque
//    o paciente precisa da informacao da reserva. O que se evita e a DUPLICIDADE: se a equipe ja mandou o equivalente (confirmacao do mesmo horario / orientacao de preparo), a automacao nao repete.
// O veto da IA por "equipe conversando" so vale para o primeiro grupo.
// ---------------------------------------------------------------------------
export const RESERVATION_RELATED_KINDS: ReadonlySet<string> = new Set(["lembrete", "preparo", "agendamento", "pos", "lista_espera"]);
export const HUMAN_PAUSE_KINDS: ReadonlySet<string> = new Set(["recontato", "retomada", "indicacao", "pesquisa", "aniversario", "renovacao", "campanha", "outra"]);
export const HUMAN_PAUSE_MS = 30 * 60_000;

const foldGate = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

// PURO: a equipe ja mandou, por conta propria, o equivalente a esta mensagem automatica? Heuristica conservadora (so lembrete e preparo):
//  - lembrete: mensagem da equipe nas ultimas 12 h que pede confirmacao E cita o mesmo horario (HH:MM ou HHh) ou a mesma data (dd/mm) do texto;
//  - preparo: mensagem da equipe nas ultimas 24 h com orientacoes de preparo (evitar sol, protetor, jejum, antes do procedimento...).
export function teamAlreadyCovered(kind: string, text: string, humanMessages: { content: string; createdAt: Date }[], now: Date): boolean {
  const t = foldGate(text);
  if (kind === "lembrete") {
    const times = new Set([...t.matchAll(/(\d{1,2})[:h](\d{2})?/g)].map((m) => `${Number(m[1])}:${m[2] ?? "00"}`));
    const dates = new Set([...t.matchAll(/(\d{1,2})\/(\d{1,2})/g)].map((m) => `${Number(m[1])}/${Number(m[2])}`));
    return humanMessages.some((m) => {
      if (now.getTime() - m.createdAt.getTime() > 12 * 3_600_000 || m.createdAt.getTime() > now.getTime()) return false;
      const h = foldGate(m.content);
      if (!/confirm/.test(h)) return false;
      const hTimes = [...h.matchAll(/(\d{1,2})[:h](\d{2})?/g)].map((x) => `${Number(x[1])}:${x[2] ?? "00"}`);
      const hDates = [...h.matchAll(/(\d{1,2})\/(\d{1,2})/g)].map((x) => `${Number(x[1])}/${Number(x[2])}`);
      return hTimes.some((x) => times.has(x)) || hDates.some((x) => dates.has(x));
    });
  }
  if (kind === "preparo") {
    return humanMessages.some((m) => now.getTime() - m.createdAt.getTime() <= 24 * 3_600_000 && m.createdAt.getTime() <= now.getTime() && /preparo|orienta(c|ç)|evite (o )?sol|protetor solar|antes d[eo] (o )?(procedimento|atendimento)|jejum/.test(foldGate(m.content)));
  }
  return false;
}

async function recentHumanMessages(clinicId: string, patientId: string, since: Date): Promise<{ content: string; createdAt: Date }[]> {
  return prisma.message.findMany({
    where: { role: "human", createdAt: { gte: since }, conversation: { patientId, patient: { clinicId } } },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: { content: true, createdAt: true },
  });
}

// Revisor indisponivel (falha tecnica ou disjuntor aberto): o que acontece com cada tipo de mensagem.
//  - resposta da Alice e mensagens ligadas a um agendamento (lembrete, preparo, mensagem de agendamento) e a lista de espera saem SEM a revisao por IA: as validacoes
//    deterministicas delas (validacao da resposta final, conferencia da reserva no Clinica Experts, plano, opt-out, duplicados) seguem ligadas;
//  - AUTOMACOES de relacionamento (recontato, retomada, indicacao, pesquisa, pos, aniversario, renovacao, campanha, outras) ficam RETIDAS: sem o revisor nao ha como
//    saber se a mensagem ainda faz sentido, e nao enviar apenas adia (nao e veto, nao consome a etapa).
export const FAIL_OPEN_KINDS: ReadonlySet<string> = new Set(["resposta_alice", "lembrete", "preparo", "agendamento", "lista_espera", "interna"]);
export class ReviewUnavailableError extends Error {
  readonly code = "review_unavailable";
  constructor(readonly kind: string, readonly why: string, readonly cause: "revisao" | "equipe" = "revisao") {
    super(cause === "equipe" ? `equipe conversando com a pessoa (${why}): automacao "${kind}" aguarda` : `revisao por IA indisponivel (${why}): automacao "${kind}" retida para tentar depois`);
    this.name = "ReviewUnavailableError";
  }
}
export const isReviewUnavailable = (err: unknown): err is ReviewUnavailableError => err instanceof ReviewUnavailableError;
// Texto/camada padrao do adiamento no controle persistente (nao e veto, nao e falha): quem chama usa isto para registrar POR QUE adiou.
export function holdInfo(err: ReviewUnavailableError): { layer: string; reason: string; tag: string } {
  return err.cause === "equipe"
    ? { layer: "equipe_atendendo", reason: "a equipe esta conversando com a pessoa (pausa humana): automacao de relacionamento aguarda, sem consumir a etapa", tag: "equipe_atendendo" }
    : { layer: "revisao_indisponivel", reason: "revisao por IA indisponivel: automacao retida", tag: "revisao_indisponivel" };
}
function unavailableVerdict(kind: OutboundKind, why: string, technical: NonNullable<GateVerdict["technical"]>): GateVerdict {
  if (FAIL_OPEN_KINDS.has(kind)) return { send: true, reason: `revisao indisponivel (${why}): saiu sem a revisao por IA; as validacoes deterministicas seguem ativas`, confidence: "baixa", reviewed: false, technical };
  return { send: false, held: true, reason: `revisao indisponivel (${why}): automacao retida`, confidence: "baixa", reviewed: false, technical };
}

export const GATE_SYSTEM = `Voce e o REVISOR DE ENVIO de uma clinica de estetica. Antes de uma mensagem ir para o WhatsApp de uma pessoa, voce decide se FAZ SENTIDO enviar ESSA mensagem NESTE momento, olhando a FICHA dela (agenda, cancelamentos, o que ja recebeu, o que a equipe falou, memoria do lead).
Responda SO um JSON: {"decisao":"enviar|nao_enviar|reescrever","confianca":"alta|media|baixa","categoria":"opt_out|sem_interesse|atendimento_humano|retorno_combinado|reclamacao|assunto_sensivel|nao_comercial|ja_tem_horario|ja_atendida|repeticao|conteudo_incorreto|momento_inadequado|outro","motivo":"uma frase","texto":"so se reescrever"}
O padrao e ENVIAR. Informe SEMPRE a "categoria" do motivo.
PUBLICO DAS AUTOMACOES (recontato, retomada, convite, campanha): quem recebe e justamente a pessoa que NAO tem horario marcado, que NAO respondeu a mensagem anterior, que e um lead novo ou que sumiu depois de pedir agendamento. Esses fatos NUNCA sao motivo para nao enviar: sao o motivo do envio. Barre uma automacao so por: pedido para nao receber/sem interesse, equipe conversando, retorno combinado, reclamacao/assunto sensivel/doenca, contato nao comercial (curriculo, fornecedor), mensagem repetida, ou conteudo que contradiz a ficha. Use nao_enviar so com motivo CONCRETO e verificavel na ficha, e confianca "alta" so quando a ficha mostra o problema com clareza. Motivos validos:
1. A mensagem fala de um agendamento que nao existe mais ou diverge da AGENDA da ficha (cancelado, remarcado, outro dia/hora/procedimento, "amanha" quando a data e outra).
2. A pessoa pediu para nao receber mensagens, ou disse que nao tem interesse, e a mensagem e automatica ou promocional.
3. Mensagem igual ou muito parecida ja foi enviada nas ultimas ~20h (ficha: mensagens automaticas ja recebidas), ou repete o que a Alice acabou de dizer.
4. (so RESPOSTA DA ALICE e lembretes) Oferece avaliacao, horarios ou agendamento a quem JA TEM horario marcado, JA foi atendida/avaliada, ou NAO pediu agenda (resposta curta tipo "ok"/"nao", comentario, assunto de amiga/familiar). Em recontato/retomada/convite oferecer o proximo passo e a FINALIDADE da mensagem: so barre se ela JA TEM horario ou ja foi atendida.
5. Contradiz o que a EQUIPE combinou/disse nas ultimas mensagens, ou a equipe esta conversando com ela agora (fala humana ha menos de 30 min) e a mensagem e automatica (recontato, campanha, pesquisa, aniversario).
6. Momento inadequado: pesquisa ou promocao logo apos reclamacao/problema; acompanhamento pos-procedimento para quem relatou problema; recontato/convite para quem acabou de dizer que nao pode, esta doente/no hospital ou combinou retornar em data futura (retorno combinado na ficha).
7. (resposta da Alice) inventa valor, desconto, horario, profissional ou procedimento que nao esta na ficha, ou promete algo que ela nao consegue fazer, ou ignora a pergunta da pessoa.
Se so um trecho esta errado e o resto serve, e a mensagem e RESPOSTA DA ALICE, use "reescrever": devolva o texto corrigido, curto, SEM acrescentar nenhum fato, horario ou valor novo. Para mensagens automaticas nunca reescreva.
A AGENDA e os cancelamentos da ficha valem mais que a MEMORIA DO LEAD (notas antigas escritas pela IA): se a memoria diz uma coisa e a agenda outra, vale a agenda.
Lembretes de confirmacao para agendamentos que ESTAO na agenda e sem ressalva na ficha devem ser enviados. Em duvida, ENVIAR.`;

// Resposta da ALICE a uma pessoa: a revisao NUNCA barra (lead sem resposta e o pior erro). Se a resposta tem problema, a propria revisao escreve uma MELHOR.
export const REPLY_REVIEW_SYSTEM = `Voce e o REVISOR das respostas da Alice, atendente de uma clinica de estetica no WhatsApp. Antes de a resposta ir para a pessoa, voce olha a FICHA dela (agenda, cancelamentos, atendimentos, o que a equipe falou, memoria do lead, ultimas mensagens: a ultima linha PESSOA e o que ela acabou de escrever) e a RESPOSTA QUE VAI SER ENVIADA (que ainda NAO aparece nas ultimas mensagens: nao a considere repetida).
Responda SO um JSON: {"decisao":"enviar|reescrever","confianca":"alta|media|baixa","motivo":"uma frase","texto":"a resposta melhor, so se reescrever"}
Use "enviar" quando a resposta serve: responde ao que a pessoa escreveu e nao contradiz a ficha. Em duvida, ENVIAR.
Use "reescrever" so quando ha um problema CONCRETO e verificavel na ficha:
1. Fala de agendamento que nao existe/diverge da AGENDA (cancelado, outro dia/hora/procedimento).
2. Oferece avaliacao, horarios ou agendamento a quem JA TEM horario, JA foi atendida/avaliada, ou NAO pediu agenda (a pessoa so disse "ok", "nao", comentou ou falou de outro assunto).
3. Contradiz o que a EQUIPE combinou/disse, ou repete o que a Alice acabou de dizer na mensagem anterior.
4. Ignora a pergunta que a pessoa fez, ou inventa valor, desconto, horario livre, profissional ou procedimento que nao esta na ficha, ou promete algo que ela nao consegue fazer.
Ao reescrever, escreva a resposta COMPLETA e melhor: natural, curta (ate 3 frases), no tom caloroso da Alice, que responde ao que a pessoa escreveu por ultimo. Use SO fatos da ficha ou da resposta original (agenda, datas, horarios, nomes que ja estao la). NAO invente preco, horario livre, desconto nem procedimento; se faltar informacao, peca o que falta ou diga que vai confirmar com a equipe. Se a pessoa so agradeceu ou fez um comentario, acolha em uma frase, sem oferta. NUNCA devolva texto vazio: a pessoa nao pode ficar sem resposta.`;

export function buildGateUser(p: { kind: OutboundKind; text: string; nowLabel: string; facts: string }): string {
  const purpose = AUTOMATION_PURPOSE[p.kind];
  return `TIPO DE MENSAGEM: ${KIND_LABEL[p.kind] ?? KIND_LABEL.outra}${purpose ? `\nFINALIDADE DESTA AUTOMACAO: ${purpose}` : ""}\nAGORA: ${p.nowLabel}\n\nFICHA DA PESSOA:\n${p.facts}\n\nMENSAGEM QUE VAI SER ENVIADA:\n"""\n${safeSlice(p.text, 1500)}\n"""`;
}

// PURO: o texto reescrito nao pode trazer fato novo (numero, data, horario, valor) que o original nao tinha, nem ficar maior.
export function acceptsRewrite(original: string, rewritten: string, ground = ""): boolean {
  const r = rewritten.trim();
  if (r.length < 8 || r.length > Math.max(400, original.length * 1.3)) return false;
  // fatos (hora, data, numero, valor) so valem se ja estavam na resposta original OU na ficha da pessoa (agenda, mensagens): nada inventado
  const base = original + "\n" + ground;
  const a = extractMentions(base);
  const b = extractMentions(r);
  if (b.times.some((t) => !a.times.includes(t)) || b.dates.some((d) => !a.dates.includes(d))) return false;
  const nums = (t: string) => new Set(t.match(/R\$\s?[\d.,]+|\d{2,}/g) ?? []);
  const na = nums(base);
  for (const n of nums(r)) if (!na.has(n)) return false;
  return true;
}

// PURO: interpreta a resposta da IA e aplica a politica (so barra com confianca alta; so reescreve resposta da Alice e se o texto for aceitavel).
export function decide(raw: string | null | undefined, kind: OutboundKind, original: string, ground = ""): GateVerdict {
  const open: GateVerdict = { send: true, reason: "sem resposta valida da revisao", confidence: "baixa", reviewed: false, technical: "invalid_response" };
  if (!raw) return open;
  let data: { decisao?: unknown; confianca?: unknown; motivo?: unknown; texto?: unknown } | null = null;
  try {
    data = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
  } catch {
    return open;
  }
  if (!data || typeof data !== "object") return open;
  const conf = data.confianca === "alta" || data.confianca === "media" ? data.confianca : "baixa";
  const reason = typeof data.motivo === "string" && data.motivo.trim() ? safeSlice(data.motivo.trim(), 240) : "sem motivo informado";
  if (kind === "resposta_alice") {
    // Resposta da Alice: NUNCA barra. Se a revisao achou problema (reescrever, ou ate "nao_enviar"), vale a resposta MELHOR que ela escreveu; sem texto
    // aceitavel (vazio, ou com fato inventado) a resposta original sai do mesmo jeito: a pessoa nunca fica sem resposta.
    if ((data.decisao === "reescrever" || data.decisao === "nao_enviar") && conf !== "baixa" && typeof data.texto === "string" && acceptsRewrite(original, data.texto, ground)) {
      return { send: true, reason, rewritten: data.texto.trim(), confidence: conf, reviewed: true };
    }
    return { send: true, reason: data.decisao === "enviar" ? reason : `revisao sem resposta melhor aceitavel, enviada a original: ${reason}`, confidence: conf, reviewed: true };
  }
  const category = parseCategory((data as { categoria?: unknown }).categoria) ?? undefined;
  if (data.decisao === "nao_enviar" && conf === "alta") {
    // o veto so vale com motivo REAL: se o motivo e apenas descrever o publico da automacao ("nao tem horario", "nao respondeu", "novo lead"), nao barra
    const v = vetoStands(category ?? null, reason);
    if (!v.stands) return { send: true, reason: `veto ignorado (${v.why}): ${reason}`, confidence: conf, reviewed: true, category };
    return { send: false, reason, confidence: conf, reviewed: true, category };
  }
  return { send: true, reason: data.decisao === "enviar" ? reason : `ressalva sem confianca suficiente: ${reason}`, confidence: conf, reviewed: true, category };
}

export type GateCall = (system: string, user: string) => Promise<string | null>;
let client: OpenAI | null = null;
const defaultCall: GateCall = async (system, user) => {
  client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY, fetch: safeFetch, maxRetries: 0 });
  const res = await client.chat.completions.create(
    {
      model: process.env.OPENAI_GATE_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      temperature: 0, max_tokens: 140, response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    },
    { timeout: 12_000 },
  );
  recordUsage("revisao_envio", res.usage);
  return res.choices[0]?.message?.content ?? null;
};

// DISJUNTOR (POR CLINICA) = SAUDE DO SERVICO DE REVISAO, nao qualidade das mensagens (revisado em 21/10/2026). Antes ele contava todo veto/reescrita como "defeito" e, com 5 de 6
// barradas (muitas vezes CORRETAMENTE, p.ex. varios recontatos de quem pediu para nao receber), desligava a revisao da clinica por 30 min: justamente o que barrava as mensagens
// inadequadas. Agora:
//  - SAUDE: so falha TECNICA conta (timeout, erro da API, resposta ilegivel). 3 falhas seguidas, ou >= 60% de >= 6 chamadas em 15 min, abrem o disjuntor DESTA clinica por 30 min:
//    a chamada a IA e suspensa (nao adianta bater num servico com defeito). Com ele aberto: resposta da Alice e mensagens de agendamento saem sem a revisao por IA (validacoes
//    deterministicas seguem), e as AUTOMACOES de relacionamento ficam RETIDAS (nao saem nem viram veto). Estado separado por clinica.
//  - QUALIDADE: vetos e reescritas altos NAO desligam nada. Viram um ALERTA no Diario (1 a cada 30 min por clinica, com as categorias) para a equipe conferir.
// O disjuntor so afeta a chamada a IA: validacao da resposta final (replyGuard), conferencia da reserva no Clinica Experts, plano, opt-out, duplicados, exclusoes de contato nao
// comercial e de atendimento humano NAO passam por aqui e seguem sempre ligadas.
export const BREAKER_WINDOW_MS = 15 * 60_000;
export const BREAKER_OPEN_MS = 30 * 60_000;
export const BREAKER_CONSECUTIVE = 3;
export const QUALITY_ALERT_EVERY_MS = 30 * 60_000;
interface BreakerState { calls: { at: number; technical: boolean }[]; quality: { at: number; blocked: boolean; category: string }[]; until: number; lastQualityAlert: number; lastDetail?: string }
const breakers = new Map<string, BreakerState>();

// Tira da memoria o estado de clinica sem evento recente e sem disjuntor aberto (nao cresce sem limite).
function pruneBreakers(now: number): void {
  for (const [id, st] of breakers) {
    const lastAt = Math.max(st.calls.at(-1)?.at ?? 0, st.quality.at(-1)?.at ?? 0);
    if (now >= st.until && now - lastAt > BREAKER_WINDOW_MS) breakers.delete(id);
  }
}

export function breakerOpen(clinicId: string, now = Date.now()): boolean {
  const st = breakers.get(clinicId);
  return !!st && now < st.until;
}

export function noteVerdict(clinicId: string, v: GateVerdict, now = Date.now()): void {
  if (!v.reviewed && !v.technical) return; // revisao desligada / sem ficha: nada a medir
  let st = breakers.get(clinicId);
  if (!st) {
    if (breakers.size >= 500) pruneBreakers(now);
    st = { calls: [], quality: [], until: 0, lastQualityAlert: 0 };
    breakers.set(clinicId, st);
  }
  st.calls.push({ at: now, technical: !!v.technical });
  if (v.technical && v.detail) st.lastDetail = v.detail;
  if (v.reviewed && !v.technical) st.quality.push({ at: now, blocked: !v.send || !!v.rewritten, category: v.category ?? "sem_categoria" });
  while (st.calls.length && now - st.calls[0].at > BREAKER_WINDOW_MS) st.calls.shift();
  while (st.quality.length && now - st.quality[0].at > BREAKER_WINDOW_MS) st.quality.shift();

  // SAUDE do servico
  const tail = st.calls.slice(-BREAKER_CONSECUTIVE);
  const consecutive = tail.length === BREAKER_CONSECUTIVE && tail.every((c) => c.technical);
  const failed = st.calls.filter((c) => c.technical).length;
  if (now >= st.until && (consecutive || (st.calls.length >= 6 && failed / st.calls.length >= 0.6))) {
    st.until = now + BREAKER_OPEN_MS;
    const total = st.calls.length;
    st.calls.length = 0;
    const detail = st.lastDetail ? ` Último erro: ${st.lastDetail}.` : "";
    console.error(`[revisao-envio] DISJUNTOR ABERTO (saude do servico) clinica=${clinicId} revisao=${REVISION.split(":")[0]}: ${failed} de ${total} chamadas falharam tecnicamente (timeout/erro da API/resposta ilegivel) - a chamada a IA fica suspensa nessa clinica por 30 min; respostas e mensagens de agendamento saem sem a revisao por IA, as automacoes ficam retidas`);
    void logActivity({
      clinicId, type: "message_blocked_ai", area: "automacoes", title: "Revisão da IA suspensa por 30 min (serviço com falha)",
      description: "O serviço de revisão por IA falhou várias vezes seguidas. Por 30 minutos as respostas da Alice e as mensagens ligadas a agendamento saem sem a revisão por IA (as demais proteções continuam), e as automações de relacionamento (recontato, retomada, convite, campanha) ficam retidas até o serviço voltar." + detail, actorName: null,
    }).catch(() => undefined);
  }

  // QUALIDADE (so alerta)
  const q = st.quality;
  const blockedQ = q.filter((r) => r.blocked);
  if (q.length >= 6 && blockedQ.length / q.length >= 0.6 && now - st.lastQualityAlert >= QUALITY_ALERT_EVERY_MS) {
    st.lastQualityAlert = now;
    const byCat: Record<string, number> = {};
    for (const r of blockedQ) byCat[r.category] = (byCat[r.category] ?? 0) + 1;
    console.warn(`[revisao-envio] ALERTA DE QUALIDADE clinica=${clinicId} revisao=${REVISION.split(":")[0]}: ${blockedQ.length} de ${q.length} mensagens barradas/reescritas em 15 min (categorias: ${JSON.stringify(byCat)}). A revisao NAO foi desligada.`);
    void logActivity({
      clinicId, type: "review_quality_alert", area: "automacoes", title: "Revisão barrando muitas mensagens",
      description: `${blockedQ.length} de ${q.length} mensagens barradas ou reescritas em 15 min (categorias: ${Object.entries(byCat).map(([k, v]) => `${k} ${v}`).join(", ")}). A proteção continua ligada; vale conferir se o motivo é real (por exemplo, quem pediu para não receber) ou um erro de cadastro.`, actorName: null,
    }).catch(() => undefined);
  }
  if (breakers.size > 200) pruneBreakers(now);
}

// Testes: sem argumento zera tudo; com clinicId zera so aquela clinica.
export function resetBreakerForTests(clinicId?: string): void {
  if (clinicId) breakers.delete(clinicId);
  else breakers.clear();
}

export function breakerStateSize(): number {
  return breakers.size;
}

// Mesma mensagem para a mesma pessoa: nao pergunta de novo (reenvios/tentativas do job). Enviar vale 10 min; barrar vale 3 h.
const cache = new Map<string, { at: number; verdict: GateVerdict }>();
const hash = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

export async function reviewOutbound(
  p: { clinicId: string; phone: string; text: string; kind: OutboundKind },
  deps: { call?: GateCall; now?: Date } = {},
): Promise<GateVerdict> {
  const skip = (reason: string): GateVerdict => ({ send: true, reason, confidence: "baixa", reviewed: false });
  if (p.kind === "interna") return skip("aviso interno");
  // PAUSA HUMANA das automacoes de relacionamento: decisao do CODIGO (vale mesmo com a revisao por IA desligada e nao gasta IA). Ver HUMAN_PAUSE_KINDS.
  if (HUMAN_PAUSE_KINDS.has(p.kind)) {
    try {
      const at = deps.now ?? new Date();
      const pat = await prisma.patient.findFirst({ where: { clinicId: p.clinicId, phone: p.phone.replace(/\D/g, "") }, select: { id: true } });
      if (pat) {
        const recent = await recentHumanMessages(p.clinicId, pat.id, new Date(at.getTime() - HUMAN_PAUSE_MS));
        if (recent.some((m) => m.createdAt.getTime() <= at.getTime())) {
          return { send: false, held: true, heldWhy: "equipe", reason: "a equipe falou com a pessoa ha menos de 30 min: automacao de relacionamento aguarda", confidence: "alta", reviewed: false };
        }
      }
    } catch { /* sem a consulta, segue o fluxo normal (a IA ainda pode barrar) */ }
  }
  if (!aiExtraEnabled("AI_SEND_REVIEW")) return skip("revisao desligada");
  // Resposta fixa que o proprio codigo escreve ("Por nada!", aviso de urgencia...): nao gasta IA, e as de seguranca nunca podem ser barradas.
  if (p.kind === "resposta_alice" && isFixedReply(p.text)) return skip("resposta fixa do sistema");
  try {
    const facts = await patientFacts({ clinicId: p.clinicId, phone: p.phone }, deps.now, { messages: 8, clip: 100, ...(p.kind === "resposta_alice" ? { excludePendingText: p.text } : {}) });
    if (!facts) return skip("numero sem ficha (nao e paciente)");

    // Mensagem ligada a uma reserva/atendimento: a conversa com a equipe NAO a pausa, mas ela nao repete o que a equipe JA mandou (confirmacao do mesmo horario, orientacao de preparo).
    if (p.kind === "lembrete" || p.kind === "preparo") {
      const at = deps.now ?? new Date();
      const humans = await recentHumanMessages(p.clinicId, facts.patientId, new Date(at.getTime() - 24 * 3_600_000));
      if (teamAlreadyCovered(p.kind, p.text, humans, at)) {
        const v: GateVerdict = { send: false, reason: "a equipe ja enviou o equivalente a esta mensagem (evita duplicidade com a equipe)", confidence: "alta", reviewed: false, category: "repeticao" };
        console.warn(`[revisao-envio] NAO ENVIOU ${p.kind} para ${p.phone.slice(-4)}: ${v.reason}`);
        await logActivity({ clinicId: p.clinicId, patientId: facts.patientId, type: "message_blocked_ai", area: "automacoes", title: "Mensagem não enviada: a equipe já enviou o equivalente", description: `${KIND_LABEL[p.kind]}: ${v.reason}`, actorName: null }).catch(() => undefined);
        return v;
      }
    }

    // O veredito em cache so vale para o MESMO contexto: se a pessoa escreveu, a equipe falou, a agenda mudou ou ela pediu para parar desde a ultima
    // revisao, a mesma mensagem e revisada de novo (antes um "nao enviar" valia por 3 h mesmo com tudo diferente).
    const key = `${facts.patientId}|${p.kind}|${hash(p.text)}|${hash(facts.fingerprint)}`;
    const hit = cache.get(key);
    const ttl = hit && !hit.verdict.send ? 3 * 3_600_000 : 10 * 60_000;
    if (hit && Date.now() - hit.at < ttl) return hit.verdict;

    const clinic = await prisma.clinic.findUnique({ where: { id: p.clinicId }, select: { timezone: true } });
    const tz = clinic?.timezone || "America/Sao_Paulo";
    const now = deps.now ?? new Date();
    const nowLabel = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, dateStyle: "full", timeStyle: "short" }).format(now);
    if (breakerOpen(p.clinicId)) return unavailableVerdict(p.kind, "disjuntor da clinica aberto: o servico de revisao falhou varias vezes", "api_error");
    let raw: string | null;
    try {
      raw = await (deps.call ?? defaultCall)(p.kind === "resposta_alice" ? REPLY_REVIEW_SYSTEM : GATE_SYSTEM, buildGateUser({ kind: p.kind, text: p.text, nowLabel, facts: facts.text }));
    } catch (err) {
      // FALHA TECNICA do servico (timeout, erro da API): conta para a saude do servico, nao e veto. Resposta da Alice sai sem revisao; automacao fica retida.
      const technical = /timeout|timed out|aborted/i.test(err instanceof Error ? `${err.name} ${err.message}` : String(err)) ? "timeout" : "api_error";
      const status = (err as { status?: number } | null)?.status;
      const apiCode = (err as { code?: string } | null)?.code;
      // 401 = chave invalida; 429/insufficient_quota = SEM SALDO. Causa de producao de 19/10: "Alice parou de responder" por falta de credito da OpenAI.
      const detail = `HTTP ${status ?? "?"}${apiCode ? ` ${apiCode}` : ""}${status === 401 || apiCode === "insufficient_quota" || (status === 429 && /quota|billing|credit/i.test(err instanceof Error ? err.message : "")) ? " (chave da OpenAI invalida ou SEM SALDO)" : ""}`;
      console.error(`[revisao-envio] revisao FALHOU (${technical}) clinica=${p.clinicId} tipo=${p.kind} status=${status ?? "-"} revisao=${REVISION.split(":")[0]}: ${err instanceof Error ? err.message.slice(0, 120) : "erro"}`);
      const v = { ...unavailableVerdict(p.kind, technical === "timeout" ? "tempo esgotado" : "erro da API", technical), detail };
      noteVerdict(p.clinicId, v);
      return v;
    }
    let verdict = decide(raw, p.kind, p.text, facts.grounding);
    // Mensagem ligada a reserva/atendimento: veto por "equipe conversando" nao vale (a pausa humana e so das automacoes de relacionamento).
    if (!verdict.send && RESERVATION_RELATED_KINDS.has(p.kind) && (verdict.category === "atendimento_humano" || (!verdict.category && /conversando|falando com|atendendo|atendimento humano/.test(foldGate(verdict.reason))))) {
      verdict = { ...verdict, send: true, reason: `veto ignorado (conversa com a equipe nao pausa mensagem ligada a reserva/atendimento): ${verdict.reason}` };
    }
    if (verdict.technical) {
      // resposta ilegivel: tambem e falha do servico (nao do conteudo)
      const v = unavailableVerdict(p.kind, "resposta ilegivel do revisor", "invalid_response");
      noteVerdict(p.clinicId, v);
      return v;
    }
    noteVerdict(p.clinicId, verdict);
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
    // falha ANTES de chamar o revisor (ficha, banco): nao e do servico de IA; a revisao nao foi feita. Mesma politica de indisponibilidade.
    console.error(`[revisao-envio] revisao nao pode ser preparada clinica=${p.clinicId} tipo=${p.kind} revisao=${REVISION.split(":")[0]}:`, err instanceof Error ? err.message : err);
    return unavailableVerdict(p.kind, "preparo da revisao falhou", "api_error");
  }
}
