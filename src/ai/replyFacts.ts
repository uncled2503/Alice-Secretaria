// ---------------------------------------------------------------------------
// FATOS DA RESPOSTA FINAL (incidentes da Lisboa, 19-20/10/2026). Funcoes PURAS, sem IA e sem banco, usadas pela validacao da resposta final (replyGuard) e pelo
// preparo da resposta (alice.ts). Principio: o texto do modelo so afirma o que tem ORIGEM:
//  - conclusao de reserva ("agendado", "confirmado", "te esperamos as 14h", "voces estao marcados") so se uma reserva foi CRIADA agora pela ferramenta ou ja existe na agenda
//    (e bate com o dia/hora citados); proposta no chat, aceite do cliente ou anotacao antiga NAO sao reserva;
//  - quantidade (UI), formacao profissional ("medica") e envio de fotos so se o cadastro / a ferramenta sustentam.
// ---------------------------------------------------------------------------
import { extractMentions } from "./slotGuard.js";
import { splitSentences } from "./repetition.js";

export function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

// ---------- conclusao de reserva ----------

// Frase hipotetica / pergunta / condicional: nao afirma nada ("posso confirmar?", "assim que eu confirmar", "se der certo ficamos combinados").
const HYPOTHETICAL_RE = /\?|\b(se|caso|quando|assim que|para eu|pra eu|posso|podemos|poderia|gostaria|quer que|vou|irei|vamos|preciso|precisamos|depois de|antes de|so falta|falta)\b/;

const STATE_RE = /\b(esta|estao|ficou|ficaram|fica|ficam|foi|foram|ja esta|ja ficou|tudo|esta tudo)\s+(certo\s+|tudo\s+)?(confirmad|agendad|marcad|reservad|combinad|garantid|anotad|fechad)\w*/;
const ACTION_RE = /\b(confirmei|confirmamos|anotei|anotamos|agendei|agendamos|marquei|marcamos|reservei|reservamos|garanti|garantimos|deixei (agendad|marcad|reservad|confirmad)\w*|ja deixei)\b/;
const WAIT_RE = /\b(te|lhe|vos)\s+(esperamos|aguardamos|espero|aguardo)\b|\bvamos te (esperar|receber)\b|\bate (la|amanha|logo)\b.{0,30}\b(esperamos|aguardamos)\b/;
const HORARIO_RE = /\b(seu|o seu|esse|este|o)\s+horario\s+(ficou|esta|fica|foi)\b/;
const BOOKED_WORD_RE = /agend|marcad|reserv/;

export interface ConclusionClaim { sentence: string; mentionsTimeOrDate: boolean; times: string[]; dates: string[]; group: boolean; bookingWord: boolean }

export const GROUP_RE = /\b(os dois|as duas|ambos|ambas|voces dois|voces duas|nos dois|nos duas|casal|voces (estao|ficaram|ficam|vao)|voces\b.{0,25}\b(agendad|marcad|confirmad))\b/;

// As frases da resposta que AFIRMAM uma reserva/horario como feito (nao pergunta, nao condicional).
export function conclusionClaims(text: string): ConclusionClaim[] {
  const out: ConclusionClaim[] = [];
  for (const raw of splitSentences(text)) {
    const f = fold(raw);
    if (HYPOTHETICAL_RE.test(f) && !ACTION_RE.test(f)) continue;
    const m = extractMentions(raw);
    const hasMention = m.times.length > 0 || m.dates.length > 0 || m.relative.length > 0;
    const state = STATE_RE.test(f);
    const action = ACTION_RE.test(f);
    const wait = WAIT_RE.test(f) && hasMention;
    const horario = HORARIO_RE.test(f);
    if (!(state || action || wait || horario)) continue;
    // "confirmado"/"combinado" sem nenhum dia/hora e sem palavra de reserva e so cortesia ("ta combinado!"): nao e afirmacao de reserva
    if (!hasMention && !BOOKED_WORD_RE.test(f) && !horario) continue;
    out.push({ sentence: raw, mentionsTimeOrDate: hasMention, times: m.times, dates: m.dates, group: GROUP_RE.test(f), bookingWord: BOOKED_WORD_RE.test(f) });
  }
  return out;
}

export interface ExistingSlot { ddmm: string; time: string }

// A afirmacao e sobre uma reserva que EXISTE (agenda verificada) ou foi criada nesta rodada? Proposta/aceite no chat nao conta.
export function claimIsSupported(c: ConclusionClaim, existing: ExistingSlot[], bookedNow: boolean): boolean {
  if (bookedNow && !c.group) return true;
  if (!existing.length) return false;
  if (c.times.length > 0 || c.dates.length > 0) {
    const times = new Set(existing.map((e) => e.time));
    const dates = new Set(existing.map((e) => e.ddmm));
    return c.times.every((t) => times.has(t)) && c.dates.every((d) => dates.has(d));
  }
  // sem dia/hora: so serve para quem tem reserva e esta apenas confirmando/lembrando (nao "agendei" agora)
  return !ACTION_RE.test(fold(c.sentence)) || !/agendei|marquei|reservei|agendamos|marcamos|reservamos/.test(fold(c.sentence));
}

// ---------- pessoas (cliente + acompanhante) ----------

const COMPANION_RE = /\b(meu|minha)\s+(marido|esposa|mulher|namorad[oa]|noiv[oa]|companheir[oa]|esposo|filh[oa]|mae|pai|irma[o]?|amig[oa]|prim[oa]|sobrinh[oa]|genro|nora|sogr[oa])\b|\b(eu e (ele|ela|meu|minha)|nos dois|nos duas|a gente (vai|quer)|para nos|pra nos|duas pessoas|2 pessoas|para os dois|pros dois|pras duas|tambem para (ele|ela)|e (para|pra) (ele|ela)|ele tambem|ela tambem)\b/;

// A pessoa fala de agendar/atender MAIS DE UMA pessoa (ela e outra)? So frase clara; sem sinal = false.
export function mentionsCompanion(text: string): boolean {
  return COMPANION_RE.test(fold(text));
}

export const GROUP_BOOKING_DIRECTIVE =
  "AGENDAMENTO PARA MAIS DE UMA PESSOA (ela e outra pessoa): cada pessoa e um atendimento e um cadastro SEPARADOS, cada um com a sua chamada de book_appointment. " +
  "(1) A pessoa que conversa: book_appointment normal (patient_full_name = o nome DELA; NUNCA o nome do acompanhante, senao o cadastro dela e sobrescrito). " +
  "(2) A OUTRA pessoa: peca o NOME COMPLETO dela e como falar com ela ('o contato dele(a) e este mesmo WhatsApp ou ele(a) tem outro numero?'); depois chame book_appointment com attendee_full_name (+ attendee_relation) e attendee_shares_phone=true OU attendee_phone. Nao presuma que o telefone e dos dois. " +
  "(3) NAO presuma que a mesma profissional atende duas pessoas ao mesmo tempo: consulte a agenda (check_availability) e ofereca horarios INDIVIDUAIS e sequenciais (um depois do outro) ou de outra profissional habilitada; cada chamada revalida a agenda na hora. " +
  "(4) NUNCA escreva 'os dois/voces estao agendados/confirmados' antes de book_appointment devolver agendado:true PARA CADA pessoa. Se so uma ficou, diga exatamente quem ficou (dia, hora, profissional) e quem NAO ficou; a reserva que deu certo continua valendo. Se o resultado de uma ficou incerto, a equipe confirma.";

// ---------- datas ----------
const WD_NAMES = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
export function weekdayLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const idx = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return WD_NAMES[idx] + (idx >= 1 && idx <= 5 ? "-feira" : "");
}

// ---------- quantidade (UI) ----------

// Numeros de "UI/unidades" citados na frase (faixas viram os dois extremos).
export function unitNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of fold(text).matchAll(/\b(\d{1,4})(?:\s*(?:a|-|ate)\s*(\d{1,4}))?\s*(?:ui|u\.i\.|unidades?)\b/g)) {
    out.push(Number(m[1]));
    if (m[2]) out.push(Number(m[2]));
  }
  return out;
}

// Frases com quantidade que o cadastro NAO sustenta (ex.: "20 a 50 UI" quando a oferta e de 50 UI; "40 UI" quando nada foi cadastrado).
export function unprovenUnitSentences(text: string, approved: number[]): string[] {
  const ok = new Set(approved);
  return splitSentences(text).filter((s) => {
    const nums = unitNumbers(s);
    if (!nums.length) return false;
    // faixa ("20 a 50 UI") quando o aprovado e uma quantidade unica = inventou a faixa
    const range = /\b\d{1,4}\s*(?:a|-|ate)\s*\d{1,4}\s*(?:ui|u\.i\.|unidades?)\b/.test(fold(s));
    if (range) return true;
    return nums.some((n) => !ok.has(n));
  });
}

// ---------- formacao profissional ----------

export interface ProRef { name: string; qualification: string | null }
const MEDIC_RE = /\b(medic[oa]s?|doutor(?:a|es|as)?|dr\.?|dra\.?)\b/;
const MEDIC_ONLY_RE = /\bmedic[oa]s?\b/;
const NEGATED_RE = /\bnao (e|sao|eh|somos|ha|existe|temos|tem)\b|\bnao sou\b|\bsem (medic)/;

// Frases que atribuem "medica/medico" a quem a clinica cadastrou com OUTRA formacao, ou falam de "nossas medicas" quando a equipe cadastrada nao tem nenhuma.
export function qualificationProblems(text: string, pros: ProRef[]): { sentence: string; why: string }[] {
  const known = pros.filter((p) => p.qualification && p.qualification.trim());
  if (!known.length) return []; // sem formacao cadastrada nesta clinica: nada a contrariar (nem se impoe a outras clinicas)
  const isMedic = (p: ProRef) => /\bmedic[oa]s?\b/.test(fold(p.qualification ?? "")); // "biomedica" NAO e medica (palavra inteira)
  const out: { sentence: string; why: string }[] = [];
  for (const s of splitSentences(text)) {
    const f = fold(s);
    if (!MEDIC_ONLY_RE.test(f) || NEGATED_RE.test(f)) continue;
    for (const p of known) {
      const first = fold(p.name.trim().split(/\s+/)[0] ?? "");
      if (first.length >= 3 && new RegExp(`\\b${first}\\b`).test(f) && !isMedic(p)) {
        out.push({ sentence: s, why: `${p.name} esta cadastrada como ${p.qualification}, nao como medica` });
        break;
      }
    }
    if (out.at(-1)?.sentence === s) continue;
    // generico: "nossas medicas", "equipe medica", "um medico" quando ninguem cadastrado e medico
    if (/\b(nossas?|nossos|a equipe|as|os|uma|um)\b.{0,12}\bmedic[oa]s?\b/.test(f) && !known.some(isMedic)) out.push({ sentence: s, why: "a equipe cadastrada nao tem medica/medico" });
  }
  return out;
}

// ---------- fotos ----------
export const PHOTO_CLAIM_RE = /\b(te enviei|enviei|mandei|te mandei|ja te enviei|ja enviei|estou enviando|estou te enviando|segue(m)?(\s+(as|algumas|umas))?\s+fotos?)\b.{0,50}\b(fotos?|imagens?|resultados?)\b|\b(fotos?|imagens?)\b.{0,30}\b(enviad[ao]s?|em anexo|acima)\b/;
export function claimsPhotosSent(text: string): boolean {
  return PHOTO_CLAIM_RE.test(fold(text));
}

// ---------- fecho generico e saudacao repetida ----------
const FAREWELL_RE = /^(se|caso|qualquer)\b.{0,80}\b(precisar|duvida|quiser|mudar de ideia|coisa|algo)\b.{0,60}\b(estou|fico|estamos|e so|so me|me chama|a disposicao)\b|\b(estou|fico|estamos) a (sua )?disposicao\b|^qualquer coisa,? e so (me )?chamar/;

// Tira o "se precisar, estou a disposicao" do FIM da resposta (e so dele). Nao mexe se sobrar pouco texto.
export function stripGenericFarewell(text: string): string {
  const sentences = splitSentences(text);
  if (sentences.length < 2) return text;
  let end = sentences.length;
  while (end > 1 && FAREWELL_RE.test(fold(sentences[end - 1]).replace(/[^\p{L}\p{N}\s.,]/gu, " ").replace(/\s+/g, " ").trim().replace(/[.!?…,]+$/, ""))) end--;
  if (end === sentences.length) return text;
  const kept = sentences.slice(0, end).join(" ").trim();
  return kept.length >= 20 ? kept : text;
}

const GREETING_RE = /^\s*(oi|ola|olá|bom dia|boa tarde|boa noite|e ai)\b[^.!?\n]{0,40}[!,.]\s*/i;
// Cumprimento no meio de uma conversa em andamento ("Oi, Maria!" de novo): tira so o cumprimento.
export function stripRedundantGreeting(text: string): string {
  const m = GREETING_RE.exec(text);
  if (!m) return text;
  const rest = text.slice(m[0].length).trim();
  return rest.length >= 15 ? rest.charAt(0).toUpperCase() + rest.slice(1) : text;
}

// ---------- pergunta de expediente (nao e pedido de vagas) ----------
const HOURS_Q_RE = /\b(dias? e horarios? de atendimento|horarios? de atendimento|horario de funcionamento|dias? de funcionamento|que horas (voces )?(abrem|fecham|atendem|funcionam)|ate que horas|abrem (aos|no|nos|de)|fecham (aos|no|nos)|funcionam? (aos|no|nos|de)|atendem (aos|no|nos|de)|em quais dias|quais (os )?dias)\b/;
const SLOT_WORDS_RE = /\b(marcar|agendar|agenda|vaga|vagas|disponibilidade|tem horario|horario livre|horario disponivel|encaixe|me encaixa|reservar)\b/;
export function asksOpeningHours(text: string): boolean {
  const f = fold(text);
  return HOURS_Q_RE.test(f) && !SLOT_WORDS_RE.test(f);
}

// ---------- precos ----------
// Valores em R$ citados no texto ("R$ 1.200,00", "R$150", "R$ 99,90"). Parcelas ("10x de R$ 120") entram como o valor da parcela.
export function priceValues(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/R\$\s*(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:,\d{1,2})?)/g)) {
    const n = Number(m[1].replace(/\./g, "").replace(",", "."));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}
// Frases com valor em R$ que o cadastro NAO sustenta (preco do procedimento, parcela calculada ou numero escrito nas regras/FAQ/mensagens da clinica).
export function unprovenPriceSentences(text: string, approved: number[]): string[] {
  const ok = approved.map((n) => Math.round(n * 100));
  return splitSentences(text).filter((s) => priceValues(s).some((n) => !ok.includes(Math.round(n * 100))));
}
