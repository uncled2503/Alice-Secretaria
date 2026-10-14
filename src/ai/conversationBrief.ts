// ---------------------------------------------------------------------------
// LEITURA DA CONVERSA (pedido da Lisboa, 14/10/2026: "ela nao parece ler a conversa do lead antes de responder"). A Alice recebia as ultimas
// mensagens como chat solto e o modelo pequeno nao as usava bem: perguntava o que a pessoa ja tinha contado, repetia avaliacao, esquecia a
// pergunta do endereco. Agora, ANTES de responder, o codigo le as ultimas 50 mensagens e monta uma FICHA (fatos) deterministica: quem e,
// o que quer, o que ja foi dito, o que ficou sem resposta, em que pe esta. Depois uma segunda leitura (conversationAnalysis.ts) define o
// melhor caminho. As duas vao junto da "JOGADA AGORA". Tudo aqui e PURO (testavel).
// ---------------------------------------------------------------------------

import { areaLabelsIn } from "./relevance.js";
import { extractMentions } from "./slotGuard.js";
import { formatInZone } from "../scheduling/time.js";

function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

export interface BriefMessage {
  role: string; // user | assistant | human
  content: string;
  authorName?: string | null;
  createdAt: Date;
}

export interface BriefInput {
  history: BriefMessage[]; // ordem cronologica (as ultimas 50)
  trailing: string[]; // mensagens novas da pessoa, ainda sem resposta
  now: Date;
  tz: string;
  patient: {
    name: string | null;
    adName?: string | null;
    objections?: string | null;
    refusedProcedures?: string | null;
    preferredPeriod?: string | null;
    preferredDays?: string | null;
    preferredProfessional?: string | null;
    urgency?: string | null;
    callbackAt?: Date | null;
  };
  upcoming: { when: Date; procedure: string; professional?: string | null }[];
  pastVisits: number;
  catalog: { name: string; aliases?: string | null }[];
}

const PRICE_ASK = /\b(valor|valores|preco|precos|quanto|custa|custam|investimento|parcela\w*)\b/;
const QUESTION_WORD = /\b(qual|quais|quando|onde|como|quanto|quantos|quem|porque|por que|tem |teria|poderia|pode |da pra|dá pra|aceita|fazem|vocês|voces)\b/;
const STALL = /\b(vou pensar|vou me organizar|depois eu vejo|te aviso|mais pra frente|talvez depois|agora nao|no momento nao)\b/;
const ADDRESS_TOLD = /\b(avenida|av\.|rua |cep \d|estacionamento|jardim do mar|indico)\b/;

function ago(from: Date, now: Date): string {
  const min = Math.max(0, Math.round((now.getTime() - from.getTime()) / 60_000));
  if (min < 2) return "agora ha pouco";
  if (min < 90) return `ha ${min} min`;
  const h = Math.round(min / 60);
  if (h < 36) return `ha ${h}h`;
  return `ha ${Math.round(h / 24)} dias`;
}

const clip = (s: string, n = 90) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

// PURO: a ficha da conversa (texto para o prompt).
export function buildConversationBrief(i: BriefInput): string {
  const h = i.history.filter((m) => ["user", "assistant", "human"].includes(m.role));
  const users = h.filter((m) => m.role === "user");
  const alice = h.filter((m) => m.role === "assistant");
  const staff = h.filter((m) => m.role === "human");
  const userText = users.map((m) => m.content).join(" \n ");
  const aliceText = alice.map((m) => m.content).join(" \n ");
  const userFold = fold(userText);
  const aliceFold = fold(aliceText);

  const lines: string[] = [];

  // --- quem ---
  const who: string[] = [];
  const first = i.patient.name?.trim().split(/\s+/)[0];
  who.push(first ? `${first}${/\s/.test(i.patient.name!.trim()) ? " (nome completo conhecido)" : " (so o primeiro nome)"}` : "nome desconhecido");
  if (i.pastVisits > 0) who.push(`PACIENTE JA ATENDIDA (${i.pastVisits} visita(s)): nao e lead novo`);
  else who.push("lead (nunca foi atendida)");
  if (i.patient.adName) who.push(`veio do anuncio "${clip(i.patient.adName, 50)}"`);
  const firstMsg = h[0];
  const lastUser = users.at(-1);
  who.push(`${h.length} mensagens na conversa${firstMsg ? `, comecou ${ago(firstMsg.createdAt, i.now)}` : ""}${lastUser ? `, ultima dela ${ago(lastUser.createdAt, i.now)}` : ""}`);
  lines.push(`- QUEM: ${who.join(" | ")}`);

  // --- o que quer ---
  const want: string[] = [];
  const areas = [...new Set(users.flatMap((m) => areaLabelsIn(m.content)))];
  if (areas.length) want.push(`regiao/queixa que ela citou: ${areas.join(", ")}`);
  const procsAsked = i.catalog.filter((p) => p.name.length >= 5 && userFold.includes(fold(p.name)));
  if (procsAsked.length) want.push(`procedimento(s) que ELA citou: ${procsAsked.slice(0, 4).map((p) => p.name).join(", ")}`);
  if (i.patient.urgency) want.push(`prazo: ${i.patient.urgency.replace("_", " ")}`);
  if (i.patient.objections) want.push(`objecoes: ${clip(i.patient.objections, 60)}`);
  if (i.patient.refusedProcedures) want.push(`JA RECUSOU: ${clip(i.patient.refusedProcedures, 60)} (nao ofereca)`);
  lines.push(`- QUER: ${want.length ? want.join(" | ") : "ainda nao disse (descubra com UMA pergunta especifica)"}`);

  // --- o que a Alice ja fez ---
  const done: string[] = [];
  const evalOffers = alice.filter((m) => /avalia/.test(fold(m.content))).length;
  if (evalOffers) done.push(`avaliacao gratuita citada ${evalOffers}x${evalOffers >= 2 ? " (NAO ofereca de novo)" : ""}`);
  const priceMsg = alice.find((m) => /R\$\s?\d/.test(m.content));
  if (priceMsg) done.push(`valor ja informado (${clip((priceMsg.content.match(/R\$\s?[\d.,]+/)?.[0] ?? "R$").replace(/[.,]+$/, ""), 20)})`);
  const procsTold = i.catalog.filter((p) => p.name.length >= 5 && aliceFold.includes(fold(p.name)));
  if (procsTold.length) done.push(`ja falou de: ${procsTold.slice(0, 4).map((p) => p.name).join(", ")}`);
  if (ADDRESS_TOLD.test(aliceFold)) done.push("endereco ja informado");
  const lastOfferMsg = [...alice].reverse().find((m) => {
    const x = extractMentions(m.content);
    return x.times.length > 0;
  });
  if (lastOfferMsg) {
    const x = extractMentions(lastOfferMsg.content);
    const stillOpen = h.indexOf(lastOfferMsg) === h.length - 1 || users.every((u) => u.createdAt <= lastOfferMsg.createdAt);
    done.push(`horarios oferecidos ${ago(lastOfferMsg.createdAt, i.now)}: ${[...x.dates, ...x.times].slice(0, 6).join(", ")}${stillOpen ? " (SEM resposta ainda)" : ""}`);
  }
  lines.push(`- JA FEZ/DISSE: ${done.length ? done.join(" | ") : "nada relevante ainda"}`);

  // --- pendente ---
  const pend: string[] = [];
  const qs = i.trailing.filter((t) => t.includes("?") || QUESTION_WORD.test(fold(t)));
  if (qs.length) pend.push(`perguntas dela AGORA (responda TODAS): ${qs.slice(0, 3).map((q) => `"${clip(q, 70)}"`).join(" ; ")}`);
  if (i.trailing.some((t) => PRICE_ASK.test(fold(t)))) pend.push("perguntou valor agora");
  const earlierQs = users.filter((m) => m.content.includes("?")).slice(-4).filter((m) => !i.trailing.includes(m.content));
  if (earlierQs.length) pend.push(`perguntas anteriores dela (confira se foram respondidas): ${earlierQs.slice(-2).map((m) => `"${clip(m.content, 60)}"`).join(" ; ")}`);
  lines.push(`- PENDENTE: ${pend.length ? pend.join(" | ") : "nenhuma pergunta em aberto"}`);

  // --- estado ---
  const state: string[] = [];
  if (i.upcoming.length) {
    const u = i.upcoming[0];
    state.push(`TEM HORARIO MARCADO: ${u.procedure} em ${formatInZone(u.when, i.tz)}${u.professional ? ` com ${u.professional}` : ""}${i.upcoming.length > 1 ? ` (+${i.upcoming.length - 1})` : ""} -> nao ofereca avaliacao nem outro horario`);
  } else state.push("sem horario marcado");
  if (STALL.test(userFold)) state.push("ja disse que vai pensar/se organizar");
  if (i.patient.callbackAt && i.patient.callbackAt > i.now) state.push(`retorno combinado para ${formatInZone(i.patient.callbackAt, i.tz)}`);
  const prefs = [i.patient.preferredPeriod && `turno ${i.patient.preferredPeriod}`, i.patient.preferredDays && `dias ${i.patient.preferredDays}`, i.patient.preferredProfessional && `profissional ${i.patient.preferredProfessional}`].filter(Boolean);
  if (prefs.length) state.push(`preferencias conhecidas: ${prefs.join(", ")} (nao pergunte de novo)`);
  lines.push(`- ESTADO: ${state.join(" | ")}`);

  // --- equipe ---
  if (staff.length) {
    const lastStaff = staff.at(-1)!;
    lines.push(`- EQUIPE: uma pessoa da equipe falou nesta conversa (${staff.length} msg), ultima ${ago(lastStaff.createdAt, i.now)}: "${clip(lastStaff.content, 80)}" -> continue de onde ela parou, sem contradizer`);
  }

  // --- nao repetir ---
  const avoid: string[] = [];
  if (priceMsg && !i.trailing.some((t) => PRICE_ASK.test(fold(t)))) avoid.push("o valor");
  if (evalOffers >= 1) avoid.push("a oferta de avaliacao");
  if (ADDRESS_TOLD.test(aliceFold)) avoid.push("o endereco");
  if (procsTold.length) avoid.push(`a explicacao de ${procsTold.slice(0, 2).map((p) => p.name).join(" / ")}`);
  const lastAlice = alice.at(-1);
  if (lastAlice) avoid.push(`a mesma pergunta/fechamento da sua ultima mensagem ("${clip(lastAlice.content.trim().split(/(?<=[.!?])\s+/).at(-1) ?? "", 70)}")`);
  lines.push(`- NAO REPITA (a menos que ela peca de novo): ${avoid.join(", ")}`);

  return `LEITURA DA CONVERSA (o sistema leu as ultimas ${h.length} mensagens antes de voce responder; USE estes fatos, nao pergunte de novo o que ja esta aqui):\n${lines.join("\n")}`;
}
