// ---------------------------------------------------------------------------
// QUAL PROCEDIMENTO A PESSOA QUER, E QUAL HORARIO ELA JA ESCOLHEU (pedido da Lisboa, 15/10/2026: "ela so agenda avaliacao"; "cliente passou
// o nome e ela continua oferecendo horario de avaliacao"). Regra nova: a Alice agenda o procedimento que a pessoa pediu; a AVALIACAO fica pra
// quem nao sabe o que quer. Aqui a decisao e deterministica (sem modelo): le as mensagens da pessoa e o catalogo e devolve uma ordem clara
// pro prompt. Tudo PURO (testavel).
// ---------------------------------------------------------------------------

import { extractMentions } from "./slotGuard.js";

function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

const STOP = new Set(
  "para com uma que por dos das nao sim quero queria gostaria saber sobre voce voces meu minha como tem tenho fazer valor valores preco quanto custa hoje amanha boa bom dia tarde noite obrigada obrigado ola oi tudo bem aqui esse essa isso mais pode ser ficar fica gostei vou ver pensei podemos agendar marcar horario procedimento tratamento sessao sessoes".split(" "),
);

// "olheiras" e "olheira", "peelings" e "peeling" valem o mesmo.
function stem(w: string): string {
  return w.length > 5 ? w.replace(/(es|s)$/, "") : w.replace(/s$/, "");
}

function wordsOf(text: string): string[] {
  return fold(text)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map(stem);
}

export interface CatalogProc {
  name: string;
  aliases?: string | null;
}

export type Wanted =
  | { kind: "specific"; procedure: string } // ela pediu (ou deixou claro) um procedimento so
  | { kind: "options"; options: string[] } // falou de uma area/familia: 2 a 4 procedimentos servem
  | { kind: "need"; options: string[] } // contou so uma QUEIXA/necessidade ("gordura localizada"): nao escolheu procedimento, a Alice nao escolhe por ela
  | { kind: "none" }; // nao sabe / nao disse: avaliacao

const isEvaluation = (n: string) => /avalia/i.test(n);

// Palavras de QUEIXA/necessidade (nao nome de procedimento). Se o que a pessoa disse bate com um procedimento SO por palavras assim (via apelido),
// ela contou uma necessidade: nao escolheu o procedimento. Caso Jandira, 16/10: "queria um tratamento pra tirar gordura localizada" e a Alice
// ja listou horarios de Enzimas, sem ela ter escolhido nada.
const NEED_WORDS = new Set(
  "gordura localizada flacidez flacida celulite estria estrias papada olheira olheiras mancha manchas ruga rugas acne barriga abdomen abdominal culote coxa coxas braco bracos gluteo gluteos bumbum cicatriz cicatrizes poros melasma vasinho vasinhos cabelo queda emagrecer emagrecimento peso pele rosto facial corporal rejuvenescimento envelhecimento medidas contorno firmeza".split(" ").map((w) => stem(w)),
);
const allNeedWords = (words: string[]) => words.length > 0 && words.every((w) => NEED_WORDS.has(w));

// PURO: `texts` = mensagens da pessoa (e o anuncio de origem), em ordem; as ultimas pesam mais. Ignora avaliacao.
export function identifyWanted(catalog: CatalogProc[], texts: string[]): Wanted {
  const recent = texts.map((t) => t.trim()).filter(Boolean).slice(-8);
  if (!recent.length) return { kind: "none" };
  const said = new Set(recent.flatMap(wordsOf));
  if (!said.size) return { kind: "none" };

  const rows = catalog
    .filter((p) => !isEvaluation(p.name))
    .map((p) => {
      const nameWords = [...new Set(wordsOf(p.name))];
      const aliasWords = (p.aliases ?? "")
        .split(/[,;\n]/)
        .map((a) => [...new Set(wordsOf(a))])
        .filter((w) => w.length);
      const sets = [nameWords, ...aliasWords].filter((w) => w.length);
      let best = { cover: 0, size: 0, needOnly: false };
      for (const set of sets) {
        const hitWords = set.filter((w) => said.has(w));
        const hit = hitWords.length;
        const cover = hit / set.length;
        // veio so do apelido (nao do nome) e so por palavras de queixa = necessidade, nao pedido do procedimento
        const needOnly = set !== nameWords && allNeedWords(hitWords);
        if (hit > 0 && (cover > best.cover || (cover === best.cover && set.length > best.size))) best = { cover, size: set.length, needOnly };
      }
      return { name: p.name, ...best };
    })
    .filter((r) => r.cover > 0);
  if (!rows.length) return { kind: "none" };

  // 0) tudo o que bateu foi so queixa/necessidade (via apelido): ela contou o que quer resolver, nao escolheu o procedimento.
  if (rows.every((r) => r.needOnly)) return { kind: "need", options: rows.slice(0, 4).map((r) => r.name) };

  // 1) o nome inteiro (ou um apelido inteiro) foi dito: o mais especifico (mais palavras) ganha.
  const full = rows.filter((r) => r.cover === 1);
  if (full.length) {
    const top = Math.max(...full.map((r) => r.size));
    const best = full.filter((r) => r.size === top);
    if (best.length === 1) return { kind: "specific", procedure: best[0].name };
    return { kind: "options", options: best.slice(0, 4).map((r) => r.name) };
  }

  // 2) disse so parte do nome ("drenagem", "peeling"): varios procedimentos da mesma familia -> pergunta qual. Um so -> e esse.
  const partial = rows.filter((r) => r.cover >= 0.5).sort((a, b) => b.cover - a.cover || a.size - b.size);
  if (partial.length === 1) return { kind: "specific", procedure: partial[0].name };
  if (partial.length > 1) return { kind: "options", options: partial.slice(0, 4).map((r) => r.name) };
  return { kind: "none" };
}

// ---------------------------------------------------------------------------
// Horario que a pessoa JA escolheu numa lista que a Alice ofereceu ("08:30", "o das 15h", "dia 23 a tarde" nao). Depois da escolha a Alice
// pede o nome completo; quando a pessoa responde o nome, o agendamento tem que sair - antes ela oferecia horarios de novo (Rosana, 15/10).
// ---------------------------------------------------------------------------

export interface ChosenSlot {
  date: string; // AAAA-MM-DD
  time: string; // HH:MM
  label: string; // "17/10 as 08:30"
  procedure: string | null; // procedimento citado na oferta
}

export interface BookingMessage {
  role: string; // user | assistant | human
  content: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

// Ano certo de um "DD/MM": a proxima ocorrencia a partir de hoje (fuso da clinica, passada como AAAA-MM-DD).
function yearFor(day: number, month: number, todayIso: string): number {
  const [y, m, d] = todayIso.split("-").map(Number);
  return month < m || (month === m && day < d - 1) ? y + 1 : y;
}

// PURO: os horarios (data+hora) listados numa fala da Alice. Linha a linha quando cada linha traz data e hora; senao, a data unica x as horas.
export function slotsOfferedIn(text: string): { dd: number; mm: number; time: string }[] {
  const out: { dd: number; mm: number; time: string }[] = [];
  for (const line of text.split("\n")) {
    const m = extractMentions(line);
    if (m.dates.length === 1 && m.times.length >= 1) {
      const [dd, mm] = m.dates[0].split("/").map(Number);
      for (const t of m.times) out.push({ dd, mm, time: t });
    }
  }
  if (out.length) return out;
  const all = extractMentions(text);
  if (all.dates.length === 1 && all.times.length) {
    const [dd, mm] = all.dates[0].split("/").map(Number);
    return all.times.map((t) => ({ dd, mm, time: t }));
  }
  return [];
}

// PURO: a pessoa escolheu um dos horarios da ULTIMA lista oferecida? `userAfter` = o que ela escreveu depois da lista (inclui o nome, "ok"...).
export function findChosenSlot(
  history: BookingMessage[],
  trailing: string[],
  todayIso: string,
  catalogNames: string[] = [],
): ChosenSlot | null {
  // ultima fala da Alice (ou da equipe) com horarios
  let offerIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") continue;
    if (slotsOfferedIn(history[i].content).length) { offerIdx = i; break; }
  }
  if (offerIdx < 0) return null;
  const offered = slotsOfferedIn(history[offerIdx].content);
  const userAfter = [...history.slice(offerIdx + 1).filter((m) => m.role === "user").map((m) => m.content), ...trailing.filter((t) => !history.slice(offerIdx + 1).some((m) => m.content === t))];
  if (!userAfter.length) return null;

  // a escolha: uma hora que bate com UMA das ofertas (e, se ela citou dia, esse dia)
  let pick: { dd: number; mm: number; time: string } | null = null;
  for (const text of userAfter) {
    const ment = extractMentions(text);
    const times = ment.times.length ? ment.times : [...fold(text).matchAll(/\b(?:as|a|o das|do)\s+(\d{1,2})\b(?!\/)/g)].map((m) => `${pad(Number(m[1]))}:00`);
    for (const t of times) {
      const cand = offered.filter((o) => o.time === t && (!ment.dates.length || ment.dates.includes(`${pad(o.dd)}/${pad(o.mm)}`)));
      if (cand.length === 1) pick = cand[0];
    }
  }
  if (!pick) return null;
  const year = yearFor(pick.dd, pick.mm, todayIso);
  const offerText = fold(history[offerIdx].content);
  const procedure = [...catalogNames].filter((n) => n.length >= 5 && offerText.includes(fold(n))).sort((a, b) => b.length - a.length)[0] ?? null;
  return { date: `${year}-${pad(pick.mm)}-${pad(pick.dd)}`, time: pick.time, label: `${pad(pick.dd)}/${pad(pick.mm)} as ${pick.time}`, procedure };
}

// ---------------------------------------------------------------------------
// As ordens que vao no "JOGADA AGORA" (ver salesFlow.ts).
// ---------------------------------------------------------------------------

export function wantedDirective(w: Wanted, evaluationName: string | null): string {
  const evalPart = evaluationName ? `a avaliacao gratuita ("${evaluationName}")` : "a avaliacao gratuita";
  if (w.kind === "need") {
    return `PROCEDIMENTO: ela contou so uma NECESSIDADE/QUEIXA (o catalogo tem opcoes como ${w.options.map((o) => `"${o}"`).join(", ")}), mas NAO escolheu procedimento. NAO escolha um por ela e NAO liste horarios de procedimento. Se ela quer agendar mesmo assim, ofereca ${evalPart} (a profissional indica o caminho certo); so agende um procedimento especifico depois que ELA o escolher pelo nome. `;
  }
  if (w.kind === "specific") {
    return `PROCEDIMENTO IDENTIFICADO: a pessoa quer "${w.procedure}". Agende ESSE procedimento (procedure_name exatamente "${w.procedure}"; check_availability / check_specific_time / book_appointment com esse nome). NAO ofereca nem mencione avaliacao: ela ja sabe o que quer. So ofereca ${evalPart} se ela disser que nao tem certeza. `;
  }
  if (w.kind === "options") {
    return `PROCEDIMENTO: a pessoa falou de algo que o catalogo cobre com mais de um procedimento: ${w.options.map((o) => `"${o}"`).join(", ")}. Se ela ja deixou claro qual (ou escolher agora), agende ESSE. Se nao, pergunte UMA vez, em uma frase, qual desses ela quer (so os nomes; nada de explicar todos). So proponha ${evalPart} se ela disser que nao sabe qual escolher. `;
  }
  return `PROCEDIMENTO: ela ainda nao disse qual procedimento quer. Entenda em UMA pergunta curta o que ela busca; se ela nao souber o que precisa, ai sim agende ${evalPart}. `;
}

export function chosenSlotDirective(c: ChosenSlot, fullName: string | null): string {
  return `HORARIO JA ESCOLHIDO PELA PESSOA: ${c.label}${c.procedure ? ` (${c.procedure})` : ""}. Chame book_appointment AGORA com date="${c.date}" e time="${c.time}"${c.procedure ? ` e procedure_name="${c.procedure}"` : ""}${fullName ? ` e patient_full_name="${fullName}"` : ""}. NAO ofereca outros horarios, NAO diga "seu nome ja esta registrado", NAO volte a oferecer avaliacao: agende e confirme o resultado real. Se book_appointment recusar esse horario, diga so isso e ofereca os mais proximos. `;
}

// PURO: a resposta oferece horarios (lista de dia/hora com pergunta)? Usado pra barrar oferta quando a pessoa ja esta agendada.
export function offersSlots(text: string): boolean {
  const m = extractMentions(text);
  return m.times.length >= 1 && (m.dates.length >= 1 || m.relative.length >= 1) && /\?/.test(text);
}

// PURO: a EQUIPE (mensagem humana, do celular ou do painel) acabou de dizer que o horario esta marcado ("o agendamento foi concluido para sabado")?
// O agendamento feito na mao (ou so no Clinica Experts) pode nao estar na agenda da Alice ainda: a pessoa nao pode voltar a receber oferta de
// horario (Adriana, 15/10: a equipe fechou o horario e a Alice, ao ver "obrigada", ofereceu drenagem de novo).
const STAFF_BOOKED_RE = /\b(agendamento|horario)\b.{0,40}\b(concluid|confirmad|realizad|marcad|agendad|garantid)|\b(esta|ficou|foi|fica)\s+(agendad|marcad|confirmad|garantid)|\bagendei\b|\bmarquei\b/;
export function staffConfirmedBooking(history: BookingMessage[], lookback = 20): boolean {
  return history
    .slice(-lookback)
    .some((m) => m.role === "human" && STAFF_BOOKED_RE.test(fold(m.content)));
}
