import { CONCERN_LABEL, eligibleProcedures, procedureConcerns, readObjective, type ConcernId, type Objective, type ProcedureInfo } from "./concerns.js";
import type { Wanted } from "./bookingIntent.js";
import { isBareRefusal, type SalesFlow } from "./salesFlow.js";
import type { Situation } from "./situation.js";
import { areasIn } from "./relevance.js";

// ---------------------------------------------------------------------------
// CONDUCAO COMERCIAL (pedido da Lisboa, 16/10/2026). Uma decisao so, deterministica, por turno: o que a pessoa QUER TRATAR (queixa/objetivo), se
// ESCOLHEU um procedimento (e se ele agenda direto ou exige avaliacao), se esta em conversa de agenda, se recusou/vai pensar, e o que o cadastro
// aprovado da clinica permite indicar. O resultado alimenta (1) o que o modelo le, (2) quais ferramentas de agenda podem rodar neste turno e (3) o que
// a resposta final pode conter - para a regra nao depender so da obediencia do modelo. Tudo PURO (testavel).
// ---------------------------------------------------------------------------

function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

export type BookingMode = "direct" | "evaluation" | "unknown";
export type ModeSource = "cadastro" | "texto_aprovado" | "nenhuma";

export interface CatalogEntry extends ProcedureInfo {
  bookingMode?: string | null; // direct | evaluation | null (nao informado)
}

// Frases FORTES do texto aprovado pela clinica que dizem que o procedimento so acontece depois de avaliacao. "A evolucao varia conforme o plano
// definido na avaliacao" NAO conta (isso diz onde o plano e definido, nao que a sessao exige avaliacao antes).
const EVALUATION_REQUIRED_RE =
  /\b(somente|apenas|sempre|so|exclusivamente) (e |sao |sera |devem ser )?(realizad|indicad|aplicad|feit|iniciad)\w* (apos|com|mediante) (uma |a )?avaliacao|\b(apos|mediante) (uma |a )?avaliacao (e indicacao|profissional previa|previa|obrigatoria)|\brequer(em)? (uma |a )?avaliacao|\bexige(m)? (uma |a )?avaliacao|\bnecessari[ao] (uma |a )?avaliacao|\bavaliacao (previa|obrigatoria)\b|\bsempre apos avaliacao/;

// PURO: como o procedimento agenda. Ordem: (1) campo explicito do cadastro (direct/evaluation); (2) texto aprovado com exigencia explicita de avaliacao;
// (3) nada declarado = "unknown" (a clinica ainda nao definiu: nao se presume agendamento direto nem se cria avaliacao substituta).
export function bookingModeOf(p: CatalogEntry): { mode: BookingMode; source: ModeSource } {
  const explicit = (p.bookingMode ?? "").trim().toLowerCase();
  if (explicit === "direct") return { mode: "direct", source: "cadastro" };
  if (explicit === "evaluation") return { mode: "evaluation", source: "cadastro" };
  const text = fold([p.goals ?? "", p.benefits ?? "", p.description ?? ""].join(" \n "));
  if (EVALUATION_REQUIRED_RE.test(text)) return { mode: "evaluation", source: "texto_aprovado" };
  return { mode: "unknown", source: "nenhuma" };
}

// ---------- recusa / "vou pensar" / servico que a clinica nao oferece ----------

const OFFER_RE = /avalia|horario|agend|marcar|disponibilidade|vaga|turno|periodo|qual dia|que dia|que horas|manha ou tarde|ver (um )?horario|posso (te )?(ajudar a )?(agendar|marcar)/;
const STALL_RE = /\b(vou pensar|vou me organizar|vou ver (e|com)|te aviso|depois (eu )?(vejo|falo|aviso|entro em contato)|mais pra frente|talvez depois|deixa eu ver|preciso pensar|vou analisar)\b/;
const SCHEDULE_AGAIN_RE = /\b(quero|queria|gostaria|vamos|pode|podemos)\b.{0,25}\b(agendar|marcar|horario|avaliacao|ver horario)|\bhorario\b|\bagendar\b|\bmarcar\b|\bsim\b|\bpode (ser|sim)\b|\bquero\b/;

export type DeclineState = "offer_refused" | "thinking" | null;

// PURO: a pessoa recusou uma oferta ou disse que vai pensar, e NAO voltou a falar de agenda depois? Enquanto isso valer, a Alice nao oferece avaliacao nem
// horarios de novo. Uma nova solicitacao explicita da pessoa retoma o assunto. (Persistido pela propria conversa: nao depende de memoria em processo.)
export function declineStateOf(history: { role: string; content: string }[]): DeclineState {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== "user") continue;
    const t = fold(m.content).replace(/\s+/g, " ").trim();
    const prevOut = [...history.slice(0, i)].reverse().find((x) => x.role !== "user")?.content ?? "";
    const offered = OFFER_RE.test(fold(prevOut)) && /\?/.test(prevOut);
    if (STALL_RE.test(t)) return "thinking";
    if (offered && isBareRefusal(t)) return "offer_refused";
    // qualquer outra mensagem da pessoa depois da recusa que volte a falar de agenda reabre o assunto
    if (SCHEDULE_AGAIN_RE.test(t)) return null;
  }
  return null;
}

// PURO: servicos que a clinica diz que NAO oferece, citados no texto.
export function parseNotOffered(raw: string | null | undefined): string[] {
  return (raw ?? "").split(/[,\n;]+/).map((s) => s.trim()).filter((s) => s.length >= 3);
}

// PURO: tira da fala os TRECHOS que falam de um servico que a clinica nao oferece ("queria endolaser no abdomen" em "queria endolaser no abdomen e tambem tenho olheiras"): o que sobra e o OUTRO
// interesse dela, que continua valendo sem herdar a regiao do servico que nao existe. So recorta quando ha termo; sem termo devolve o texto como esta.
export function withoutNotOffered(text: string, terms: string[]): string {
  if (!terms.length || !notOfferedIn(text, terms)) return text;
  const parts = text.split(/(?<=[,;.!?])\s+|\s+(?:e tambem|e ainda|alem disso|tambem|mas|e)\s+/i);
  const keep = parts.filter((p) => !notOfferedIn(p, terms));
  return keep.join(". ").trim();
}

export function notOfferedIn(text: string, terms: string[]): string | null {
  const t = fold(text);
  for (const term of terms) {
    const f = fold(term).trim();
    if (f && new RegExp(`(^|[^a-z0-9])${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}([^a-z0-9]|$)`).test(t)) return term;
  }
  return null;
}

// TROCAS PROIBIDAS (configuracao da empresa): "Lavieen > carboxiterapia; LEDterapia > luz pulsada" = quando a pessoa fala do primeiro, o segundo NAO e oferecido no lugar.
export interface ForbiddenSwap { asked: string; forbidden: string }
export function parseForbiddenSwaps(raw: string | null | undefined): ForbiddenSwap[] {
  return (raw ?? "").split(/[;\n]+/).map((p) => p.split(">").map((s) => s.trim())).filter((p) => p.length === 2 && p[0].length >= 3 && p[1].length >= 3).map(([asked, forbidden]) => ({ asked, forbidden }));
}
// PURO: os termos que NAO podem aparecer como oferta nesta resposta (a pessoa falou do servico pedido nas mensagens dela).
export function swapTermsFor(userTexts: string[], swaps: ForbiddenSwap[]): string[] {
  const all = userTexts.join(" \n ");
  return [...new Set(swaps.filter((s) => notOfferedIn(all, [s.asked]) && !notOfferedIn(all, [s.forbidden])).map((s) => s.forbidden))];
}

// Frase que NEGA o servico ("nao trabalhamos com luz pulsada") nao e oferta: fica.
const NEGATES_RE = /\bnao (trabalh|temos|tem|oferec|fazemos|faz|realiz|disponibiliz)\w*|\bnao e (um )?(servico|procedimento|tratamento) (que|da)|\bnao faz parte\b|\bnao (utiliz|usamos|usa)\w*/;

// PURO: tira da resposta as frases que OFERECEM/descrevem um servico que a clinica nao tem. null = nada a tirar.
export function stripNotOffered(text: string, terms: string[], splitSentences: (t: string) => string[], removeSentences: (t: string, s: string[]) => string): string | null {
  const bad = splitSentences(text).filter((s) => notOfferedIn(s, terms) && !NEGATES_RE.test(fold(s)));
  if (!bad.length) return null;
  return removeSentences(text, bad).trim();
}

// ---------- entendimento do turno ----------

export interface UnderstandInput {
  history: { role: string; content: string; createdAt?: Date }[];
  now: Date;
  wanted: Wanted;
  catalog: CatalogEntry[];
  strictBooking: boolean; // clinica sem regra de agendamento NAO presume agendamento direto
  notOffered: string[];
  unmappedOffers?: string[]; // ofertas anunciadas SEM cadastro/mapeamento autorizado (ex.: "Protocolo do Olhar")
  adText?: string; // nome do anuncio de origem da pessoa
}

export interface Understanding {
  objective: Objective;
  chosen: { name: string; mode: BookingMode; source: ModeSource } | null;
  options: string[]; // citou uma familia (varios procedimentos servem)
  alsoMentioned: string[]; // outros procedimentos CITADOS sem escolher (pergunta/comparacao): mencionar nao e escolher
  eligible: string[]; // procedimentos aprovados no cadastro para o objetivo
  uninformedCount: number; // sem queixa declarada no cadastro
  families: string[]; // eligible agrupados por nome-base (para falar de forma geral)
  complaintOnly: boolean; // contou uma queixa, nao escolheu procedimento
  regionOnly: boolean; // citou so a regiao
  evaluationRequested: boolean; // ela mesma pediu avaliacao (nas ultimas mensagens)
  declineState: DeclineState;
  notOfferedAsked: string | null;
  unmappedAsked: string | null; // citou (ou veio do anuncio de) uma oferta SEM cadastro: nao vira avaliacao nem outro procedimento
  strictBooking: boolean;
}

// "Enzima GL Abdomen", "Enzima GL Braços" -> "Enzima": familia pelo primeiro nome.
function familyOf(name: string): string {
  const first = name.replace(/\([^)]*\)/g, " ").trim().split(/\s+/)[0] ?? name;
  return first.replace(/s$/i, "") === "Enzima" || /^enzima/i.test(first) ? "Enzimas" : first;
}

// Agrupa por nome-base. Um procedimento so no grupo = nome completo; varios = prefixo comum das palavras (ex.: "Enzima GL Abdomen" + "Enzima GL Bracos" -> Enzimas).
function familiesOf(names: string[]): string[] {
  const groups = new Map<string, string[]>();
  for (const n of names) {
    const k = familyOf(n);
    groups.set(k, [...(groups.get(k) ?? []), n]);
  }
  return [...groups.entries()].map(([k, list]) => {
    if (list.length === 1) return list[0];
    if (k === "Enzimas") return k;
    const words = list.map((n) => n.split(/\s+/));
    const common: string[] = [];
    for (let j = 0; j < words[0].length; j++) {
      const w = words[0][j];
      if (words.every((x) => x[j]?.toLowerCase() === w.toLowerCase())) common.push(w);
      else break;
    }
    return common.length >= 1 ? common.join(" ") : k;
  });
}

export function understandConversation(i: UnderstandInput): Understanding {
  const userMsgs = i.history.filter((m) => m.role === "user");
  const objective = readObjective(userMsgs.map((m) => ({ text: withoutNotOffered(m.content, i.notOffered), createdAt: m.createdAt })), i.now);
  const last3 = userMsgs.slice(-3).map((m) => fold(m.content)).join(" \n ");
  const evaluationRequested = /\bavalia(cao|coes)\b/.test(last3) && !/\bnao (quero|preciso) (de )?(uma )?avalia/.test(last3);

  let chosen: Understanding["chosen"] = null;
  let options: string[] = [];
  if (i.wanted.kind === "specific") {
    const entry = i.catalog.find((p) => p.name === (i.wanted as { procedure: string }).procedure);
    if (entry) chosen = { name: entry.name, ...bookingModeOf(entry) };
  } else if (i.wanted.kind === "options") {
    options = i.wanted.options;
  }
  const el = eligibleProcedures(objective, i.catalog);
  const families = familiesOf(el.eligible).slice(0, 8);
  const complaintOnly = !chosen && objective.concerns.length > 0;
  // Oferta anunciada sem cadastro: so vale se NAO existe procedimento/apelido com esse nome (o cadastro, quando existe, manda). O nome do ANUNCIO so conta enquanto ela
  // nao escolheu procedimento nem contou outra queixa (senao o anuncio de dias atras contaminaria a conversa inteira).
  const catalogKeys = i.catalog.flatMap((p) => [p.name, ...(p.aliases ?? "").split(/[,;\n]/)]).map((x) => fold(x).trim()).filter(Boolean);
  const terms = (i.unmappedOffers ?? []).filter((t) => { const f = fold(t).trim(); return f && !catalogKeys.some((k) => k === f || k.includes(f)); });
  const userText = userMsgs.slice(-3).map((m) => m.content).join(" \n ");
  const unmappedAsked = terms.length ? notOfferedIn(userText, terms) ?? (!chosen && !complaintOnly && i.adText ? notOfferedIn(i.adText, terms) : null) : null;
  const regionOnly = !chosen && !options.length && objective.regionOnly && i.wanted.kind === "none";
  return {
    objective,
    chosen,
    options,
    alsoMentioned: i.wanted.kind === "specific" ? i.wanted.mentioned ?? [] : [],
    eligible: el.eligible,
    uninformedCount: el.uninformed.length,
    families,
    complaintOnly,
    regionOnly,
    evaluationRequested,
    declineState: declineStateOf(i.history),
    notOfferedAsked: notOfferedIn(userMsgs.slice(-3).map((m) => m.content).join(" \n "), i.notOffered),
    unmappedAsked,
    strictBooking: i.strictBooking,
  };
}

// ---------- plano do turno ----------

export interface ConductGate {
  schedulingOpen: boolean;
  schedulingReason: string;
  lockedProcedure: string | null; // escolha explicita que agenda direto: nao se troca por avaliacao nem por outro procedimento
  evaluationName: string | null;
  evaluationAllowed: boolean; // a avaliacao pode ser agendada neste turno (pediu, ainda nao sabe, ou e exigencia)
  blocked: { procedure: string; motivo: string; instrucao: string } | null; // procedimento escolhido que NAO pode ser agendado agora
}

export interface ConductPlan {
  gate: ConductGate;
  forbidEvaluationOffer: boolean;
  forbidSlotOffer: boolean;
  handoff: { reason: string; summary: string } | null; // quando o certo e a equipe decidir (o chamador usa o mecanismo real)
  handoffForced: boolean; // true = o codigo faz a transferencia (nao depende do modelo): escolheu procedimento SEM regra cadastrada e quer agendar
  replacesFlowMove: boolean; // true = a "jogada" generica do fluxo de venda conflita e e substituida por esta condução
  safety: string; // regras de seguranca que valem em qualquer situacao (ex.: servico que a clinica nao oferece)
  directive: string; // vai antes da "jogada" do turno
  trace: Record<string, string>; // para o log tecnico (sem conteudo sensivel)
}

const labels = (ids: ConcernId[]) => ids.map((c) => CONCERN_LABEL[c]).join(" + ");

export function planConduct(u: Understanding, ctx: { flow: SalesFlow; situation: Situation; evaluationName: string | null; hasBooking: boolean; clinicIsStore: boolean; trailing: string[] }): ConductPlan {
  const { flow, situation } = ctx;
  const parts: string[] = [];
  let safety = "";
  const trace: Record<string, string> = {
    queixa: u.objective.concerns.join("+") || "nenhuma",
    negada: u.objective.negated.join("+") || "-",
    regiao: u.objective.regions.join("+") || "-",
    escolhido: u.chosen ? `${u.chosen.name}(${u.chosen.mode}/${u.chosen.source})` : u.options.length ? "familia" : "nenhum",
    agenda_pedida: String(flow.schedulingSignal),
    intencao: flow.intent,
    situacao: situation.kind,
  };

  let handoff: ConductPlan["handoff"] = null;
  let blocked: ConductGate["blocked"] = null;
  const evalName = ctx.evaluationName;
  const decline = u.declineState;
  const thinking = flow.intent === "hesitate" || decline === "thinking";
  const refused = flow.intent === "refuse" || decline === "offer_refused";

  // 1) servico que a clinica NAO oferece (honestidade; nada de substituicao automatica)
  if (u.notOfferedAsked) {
    safety = (
      `SERVICO QUE A CLINICA NAO OFERECE: ela citou "${u.notOfferedAsked}", que a clinica NAO realiza. Diga isso com honestidade e naturalidade, em 1 frase. NAO ofereca outro procedimento como se fosse equivalente (nem troque por outra tecnologia por conta propria). So fale de uma alternativa se ELA perguntar por ela e o cadastro aprovado confirmar; se ela quiser entender as opcoes, chame transfer_to_human para a equipe orientar. Os OUTROS interesses dela na mesma conversa (ex.: olheiras) continuam valendo: nao os misture com a regiao do servico que a clinica nao faz. NUNCA diga que a clinica faz "${u.notOfferedAsked}".`
    );
    trace.nao_oferecido = u.notOfferedAsked;
  }

  // 1b) oferta ANUNCIADA sem cadastro (ex.: "Protocolo do Olhar"): sem procedimento e sem agenda no sistema. NAO vira avaliacao, NAO se associa a outro procedimento.
  let unmappedHandoff = false;
  if (u.unmappedAsked && !u.evaluationRequested && !u.chosen) {
    unmappedHandoff = true;
    trace.oferta_sem_cadastro = u.unmappedAsked;
    handoff = {
      reason: `Oferta sem cadastro: ${u.unmappedAsked}`,
      summary: `A pessoa falou de "${u.unmappedAsked}" (oferta/anuncio da clinica que AINDA NAO esta cadastrada no sistema, sem procedimento nem agenda). A Alice nao agendou avaliacao no lugar, nao associou a outro procedimento e nao prometeu valor ou condicao: confirme a oferta com a pessoa.`,
    };
    parts.push(
      `OFERTA SEM CADASTRO: ela citou "${u.unmappedAsked}", que a clinica anuncia mas que AINDA NAO esta cadastrada no sistema (sem procedimento e sem agenda). NAO agende avaliacao no lugar, NAO associe a nenhum outro procedimento (nem parecido), NAO invente valor, condicao, duracao ou horario. Diga em UMA frase, com naturalidade, que vai confirmar os detalhes com a equipe e chame transfer_to_human com o que ela pediu.`,
    );
  }

  // 2) estado de recusa / vou pensar: respeitar
  if (thinking || refused) {
    trace.decisao = thinking ? "vou_pensar" : "recusou_oferta";
    parts.push(
      thinking
        ? "ELA DISSE QUE VAI PENSAR: acolha em UMA frase, sem pressao e sem insistir. NAO ofereca avaliacao, NAO liste horarios, NAO volte a vender nesta conversa. Pode dizer que fica a disposicao; so se ela mesma disser quando quer ser chamada, registre com schedule_recontact. Nao e desinteresse definitivo: se ela voltar a falar de agenda, atenda normalmente."
        : "ELA RECUSOU A OFERTA ('nao'): respeite em UMA frase curta e acolhedora. NAO insista, NAO ofereca avaliacao nem horarios de novo, NAO pergunte o motivo. Recusar essa oferta nao e recusar o atendimento: se ela fizer outra pergunta ou voltar a falar de agenda, atenda normalmente.",
    );
  }

  // 3) escolha explicita de procedimento
  let lockedProcedure: string | null = null;
  let evaluationAllowed = true;
  // (quem ja tem horario e so esta perguntando algo NAO recebe de novo a ordem de "ofereca a avaliacao": a venda terminou; a jogada "booked" do fluxo manda)
  if (u.chosen && !ctx.clinicIsStore && flow.intent !== "booked") {
    const c = u.chosen;
    if (u.evaluationRequested) {
      evaluationAllowed = true; // ela mesma pediu a avaliacao
      trace.avaliacao = "pedida_por_ela";
    } else if (c.mode === "evaluation") {
      evaluationAllowed = true;
      parts.push(
        `PROCEDIMENTO ESCOLHIDO: "${c.name}". O cadastro aprovado da clinica diz que ele ${c.source === "cadastro" ? "exige" : "e feito"} avaliacao previa com a profissional. Explique isso em UMA frase curta e natural (e a regra da clinica, nao uma insistencia comercial) e ofereca a avaliacao${evalName ? ` ("${evalName}")` : ""} como o proximo passo. NAO agende "${c.name}" diretamente.`,
      );
      blocked = { procedure: c.name, motivo: `${c.name} exige avaliacao previa (regra da clinica)`, instrucao: `NAO agende "${c.name}". Explique em uma frase que ele exige avaliacao previa com a profissional e ofereca a avaliacao${evalName ? ` ("${evalName}")` : ""}.` };
    } else if (c.mode === "unknown" && u.strictBooking) {
      evaluationAllowed = false;
      handoff = { reason: "Procedimento escolhido sem regra de agendamento cadastrada", summary: `A pessoa escolheu "${c.name}", mas o cadastro nao diz se esse procedimento agenda direto ou exige avaliacao previa. A Alice nao agendou nem criou avaliacao no lugar: confirme com a pessoa o melhor caminho.` };
      blocked = { procedure: c.name, motivo: `nao ha regra cadastrada dizendo se ${c.name} agenda direto ou exige avaliacao`, instrucao: `NAO agende "${c.name}" e NAO crie avaliacao no lugar. Chame transfer_to_human com o procedimento escolhido e fique em silencio.` };
      parts.push(`PROCEDIMENTO ESCOLHIDO: "${c.name}". Esta clinica ainda NAO cadastrou se ele agenda direto ou exige avaliacao: NAO presuma. NAO agende, NAO ofereca avaliacao no lugar e NAO liste horarios. Chame transfer_to_human com o procedimento escolhido para a equipe validar o caminho.`);
    } else {
      // direto (explicito) ou desconhecido em clinica que ainda nao ativou a regra estrita (comportamento anterior preservado)
      lockedProcedure = c.name;
      evaluationAllowed = false;
      parts.push(
        `PROCEDIMENTO ESCOLHIDO: "${c.name}" (agenda direto). Continue com ESSE procedimento: consulte a disponibilidade dele quando ela quiser agendar e colete so os dados que faltam. NAO ofereca nem mencione avaliacao e NAO troque por outro procedimento.`,
      );
    }
    trace.modo = `${c.mode}/${c.source}`;
  }

  // 3b) citou OUTRO procedimento sem escolher (pergunta/comparacao): o escolhido continua; so uma escolha explicita troca
  if (u.chosen && u.alsoMentioned.length) {
    trace.citou_tambem = u.alsoMentioned.join("+");
    parts.push(`ELA CITOU TAMBEM ${u.alsoMentioned.map((m) => `"${m}"`).join(", ")}, mas MENCIONAR NAO E ESCOLHER: o procedimento em discussao continua sendo "${u.chosen.name}". Responda o que ela perguntou sobre o outro (so com o cadastro aprovado) SEM trocar o assunto; se ela estiver comparando ou nao der para saber qual quer fazer, pergunte UMA vez, de forma curta, qual deles ela quer. So troque se ela disser claramente que quer o outro.`);
  }

  // 4) so a regiao: esclarecer
  if (u.regionOnly && !u.chosen) {
    trace.passo = "esclarecer_queixa";
    const reg = u.objective.regions.join(", ");
    parts.push(
      `ELA CITOU SO A REGIAO (${reg}) E NAO DISSE O QUE QUER TRATAR. A regiao sozinha nao define o tratamento (a mesma regiao pode ter escurecimento, flacidez, gordura, celulite, estrias...). NAO sugira procedimento, NAO liste horarios e NAO ofereca avaliacao ainda. Faca UMA pergunta curta e natural: o que ela gostaria de tratar ou melhorar nessa regiao.`,
    );
  }

  // 5) queixa sem procedimento escolhido: so o que o cadastro aprovado permite indicar
  if (u.complaintOnly && !u.regionOnly) {
    const lab = labels(u.objective.concerns);
    trace.passo = "indicar_so_aprovado";
    const others = u.objective.negated.length ? ` Ela disse que NAO e/NAO quer: ${labels(u.objective.negated)} - NAO sugira nada para isso.` : "";
    const toneNote = u.objective.toneMentioned ? " O tom de pele que ela citou e so informacao: nao e a queixa." : "";
    if (u.families.length) {
      parts.push(
        `OBJETIVO ATUAL DELA: ${lab}${u.objective.regions.length ? ` (${u.objective.regions.join(", ")})` : ""}.${toneNote}${others} Ela contou uma QUEIXA, NAO escolheu procedimento: NAO escolha por ela, NAO agende e NAO liste horarios agora. Procedimentos com indicacao APROVADA no cadastro para esse objetivo: ${u.families.join(", ")}${u.eligible.length > u.families.length ? " (e variacoes por regiao)" : ""}. Indique SO entre estes, sem inventar indicacao, e sem despejar tudo: ${u.families.length === 1 && u.objective.regions.length ? "ha UMA opcao aprovada e ela ja disse a regiao: apresente-a em 1 frase e pergunte se ela quer saber mais ou ver um horario (uma pergunta; so liste horarios depois que ela aceitar). " : "em 1 ou 2 frases explique de forma geral que a clinica tem opcoes para isso e pergunte UMA coisa (qual regiao mais incomoda, ou se ja conhece algum). "}${evalName ? `Se ela nao souber qual escolher, a avaliacao ("${evalName}") e o caminho para a profissional decidir. ` : ""}NAO sugira procedimentos para queixas que ela NAO citou (outras queixas: gordura, celulite, flacidez etc. so se ELA falar).`,
      );
    } else {
      handoff = { reason: "Queixa sem procedimento com indicacao aprovada no cadastro", summary: `A pessoa quer tratar ${lab}${u.objective.regions.length ? ` (${u.objective.regions.join(", ")})` : ""}, mas nenhum procedimento do cadastro traz essa indicacao aprovada. A Alice nao sugeriu procedimento: oriente a pessoa.` };
      parts.push(
        `OBJETIVO ATUAL DELA: ${lab}.${toneNote}${others} Nenhum procedimento do cadastro traz indicacao aprovada para isso. NAO sugira procedimento, NAO complete por adivinhacao e NAO liste horarios. Explique com naturalidade, em 1 frase, que vai confirmar com a equipe quais opcoes a clinica tem para isso e chame transfer_to_human com o objetivo dela.`,
      );
    }
  }

  // 6) familia citada (varios procedimentos servem)
  if (u.options.length && !u.chosen) {
    trace.passo = trace.passo ?? "escolher_dentro_da_familia";
  }

  // gate das ferramentas de agenda
  const hasDirective = situation.directive != null;
  let schedulingOpen = flow.schedulingSignal || hasDirective;
  let reason = "ela pediu/aceitou horario ou a conversa esta em negociacao de agenda";
  if (thinking || refused) { schedulingOpen = hasDirective ? schedulingOpen : false; reason = "ela recusou a oferta ou disse que vai pensar"; }
  if (flow.intent === "booked" && !hasDirective) { schedulingOpen = false; reason = "ela ja tem horario marcado e nao pediu outro"; }
  if (!schedulingOpen && reason.startsWith("ela pediu")) reason = "ela nao pediu horario nem agendamento nesta mensagem";
  if (u.regionOnly && !hasDirective) { schedulingOpen = false; reason = "ainda nao se sabe o que ela quer tratar"; }
  if (u.complaintOnly && !u.regionOnly && !flow.schedulingSignal && !hasDirective) { schedulingOpen = false; reason = "ela contou uma queixa e ainda nao pediu horario"; }
  trace.agenda = schedulingOpen ? "aberta" : `fechada: ${reason}`;

  const forbidSlotOffer = !schedulingOpen || unmappedHandoff;
  const handoffForced = (!!handoff && !!u.chosen && u.chosen.mode === "unknown" && u.strictBooking && flow.schedulingSignal && !u.evaluationRequested) || (unmappedHandoff && flow.schedulingSignal);
  const replacesFlowMove = (u.regionOnly && !u.chosen) || (u.complaintOnly && flow.intent !== "schedule") || thinking || refused || !!blocked || !!handoff;
  const forbidEvaluationOffer =
    situation.forbidEvaluationOffer ||
    thinking ||
    refused ||
    flow.intent === "booked" ||
    (!!lockedProcedure && !u.evaluationRequested) ||
    (u.regionOnly && !u.evaluationRequested) ||
    unmappedHandoff ||
    (!!handoff && !u.evaluationRequested);

  // 7) CONTINUIDADE COMERCIAL. O convite depende da ETAPA e do MODO CADASTRADO do procedimento (nao ha regra universal "sempre convide para avaliacao"): so quando ela GOSTOU do que viu ou
  // deu uma expectativa de resultado, ainda nao tem horario, nao recusou/pensa, nao e servico que a clinica nao faz e a conducao nao esta encaminhando para a equipe. O convite e uma
  // PERGUNTA simples, sem presumir aceite; avaliacao e sessao nunca se confundem.
  const rd = flow.reading;
  const canInvite = !thinking && !refused && flow.intent !== "booked" && flow.intent !== "returning" && !ctx.hasBooking && !handoff && !u.notOfferedAsked && !u.unmappedAsked && !situation.directive && situation.closeWith == null && !u.regionOnly;
  if (canInvite && (rd.positiveReaction || rd.resultExpectation)) {
    const direct = !!u.chosen && u.chosen.mode === "direct";
    const evalOk = !forbidEvaluationOffer || u.evaluationRequested;
    if (direct) {
      parts.push(`CONTINUIDADE: ela demonstrou interesse em "${u.chosen!.name}" (${rd.positiveReaction ? "gostou dos resultados" : "falou do que espera"}). O proximo passo e VER UM HORARIO para esse procedimento: convide com UMA pergunta simples ("quer que eu veja um horario?"), sem presumir aceite e sem listar horarios antes de ela dizer que quer.`);
      trace.continuidade = "convite_horario_direto";
    } else if (evalOk) {
      const mode = u.chosen ? (u.chosen.mode === "evaluation" ? "exige avaliacao previa (cadastro)" : "ainda sem regra de agendamento cadastrada") : "ela ainda nao escolheu procedimento";
      parts.push(`CONTINUIDADE: ela demonstrou interesse (${rd.positiveReaction ? "gostou dos resultados" : "falou do que espera"}) e o proximo passo adequado e a AVALIACAO${evalName ? ` ("${evalName}")` : ""} (${mode}). Diga em UMA frase para que serve: a profissional avalia o caso dela e orienta o plano e a previsao do tratamento. Escreva a palavra AVALIACAO (o horario que voce vai oferecer e da avaliacao, NAO da sessao do procedimento) e feche com UMA pergunta simples para avancar (ex.: "quer que eu veja um horario para a sua avaliacao?"), sem presumir aceite.`);
      trace.continuidade = "convite_avaliacao";
    }
  }

  return {
    gate: {
      schedulingOpen,
      schedulingReason: reason,
      lockedProcedure,
      evaluationName: evalName,
      evaluationAllowed: evaluationAllowed && !(thinking || refused || unmappedHandoff),
      blocked,
    },
    forbidEvaluationOffer,
    forbidSlotOffer,
    handoff,
    handoffForced,
    replacesFlowMove,
    safety,
    directive: parts.join("\n"),
    trace,
  };
}

// ---------- decisao de ferramenta ----------

export type GateVerdict = { allow: true } | { allow: false; motivo: string; instrucao: string };

const isEval = (n: string) => /avalia/i.test(n);

// PURO: a ferramenta de agenda pode rodar com ESTE procedimento neste turno?
export function gateDecision(gate: ConductGate, tool: "check_availability" | "check_specific_time" | "book_appointment", procedureName: string, canonicalName?: string): GateVerdict {
  const proc = canonicalName ?? procedureName;
  if (!gate.schedulingOpen) {
    return {
      allow: false,
      motivo: `nao e momento de oferecer horario: ${gate.schedulingReason}`,
      instrucao: "Responda so ao que ela escreveu, sem listar horarios e sem tentar agendar. Se fizer sentido, pergunte (uma vez, de forma leve) se ela quer ver horarios; so consulte a agenda quando ela pedir.",
    };
  }
  if (gate.blocked && gate.blocked.procedure.toLowerCase() === proc.toLowerCase() && !isEval(proc)) {
    return { allow: false, motivo: gate.blocked.motivo, instrucao: gate.blocked.instrucao };
  }
  if (gate.lockedProcedure && isEval(proc) && !gate.evaluationAllowed) {
    return {
      allow: false,
      motivo: `ela escolheu "${gate.lockedProcedure}" (agenda direto): nao se agenda avaliacao no lugar`,
      instrucao: `Use procedure_name="${gate.lockedProcedure}" (nome exato). So agende avaliacao se ELA pedir.`,
    };
  }
  if (gate.lockedProcedure && !isEval(proc) && proc.toLowerCase() !== gate.lockedProcedure.toLowerCase()) {
    return {
      allow: false,
      motivo: `ela escolheu "${gate.lockedProcedure}": nao se troca por outro procedimento`,
      instrucao: `Use procedure_name="${gate.lockedProcedure}" (nome exato) ou pergunte a ela se quer trocar de procedimento.`,
    };
  }
  void tool;
  return { allow: true };
}

export { areasIn, procedureConcerns };

// Resposta curta quando a resposta inteira era so a oferta de um servico que a clinica nao tem.
export const NOT_OFFERED_REPLY = "Esse serviço não faz parte do que a gente oferece por aqui. Me conta o que você gostaria de tratar que eu vejo as opções que temos? 💗";

// PURO: a resposta oferece/agenda um horario PARA O PROCEDIMENTO escolhido (ex.: "vamos agendar um horario para a remocao da sua tatuagem") sem a palavra AVALIACAO, quando o cadastro diz que
// o procedimento exige avaliacao previa? Isso faz parecer que a SESSAO sera feita (caso Kelly). So olha frases que convidam/agendam e citam o procedimento.
export function evaluationWordingViolation(text: string, procedureName: string): boolean {
  const f = fold(text);
  if (/avalia(cao|coes)\b/.test(f)) return false;
  const words = fold(procedureName).split(/[^a-z0-9]+/).filter((w) => w.length >= 5);
  if (!words.length) return false;
  return f.split(/(?<=[.!?])\s+|\n+/).some((s) => /\b(agend\w*|marc\w*|horario|vamos (ver|marcar|agendar))\b/.test(s) && words.some((w) => s.includes(w)));
}
export const EVAL_WORDING_NUDGE = "ATENCAO: este procedimento EXIGE avaliacao previa (cadastro da clinica). O horario que voce esta oferecendo/agendando e da AVALIACAO com a profissional, NAO da sessao do procedimento. Reescreva deixando isso explicito com a palavra AVALIACAO (ex.: 'agendar a sua avaliacao'), sem dar a entender que a sessao ja sera feita, sem validar expectativa de numero de sessoes e terminando com UMA pergunta simples para avancar.";
