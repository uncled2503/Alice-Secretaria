// Explora as DECISOES comerciais do turno (fluxo de venda + situacao + conducao) para conversas de varios turnos, SEM banco, SEM OpenAI e sem enviar nada.
//   node scripts/explorar-decisoes.mjs            (usa dist/)
// Serve para reproduzir problemas ("o que o codigo decide para esta fala?") e como roteiro de leitura das decisoes.
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(process.env.ALICE_ROOT ?? process.cwd());
const imp = (rel) => import(pathToFileURL(path.join(ROOT, "dist", rel)).href);
const { analyzeFlow } = await imp("ai/salesFlow.js");
const { identifyWanted, findChosenSlot } = await imp("ai/bookingIntent.js");
const { understandConversation, planConduct } = await imp("ai/conduct.js");
const { resolveSituation } = await imp("ai/situation.js");

const CATALOG = [
  { name: "Hipro", aliases: "hipro", goals: "firmeza,flacidez", benefits: "melhora a firmeza da pele do rosto", description: "Tecnologia para flacidez e firmeza.", bookingMode: "direct" },
  { name: "Enzima GL Abdomen", aliases: "enzima abdomen", goals: "gordura,gordura localizada,barriga", benefits: "reduz gordura localizada no abdomen", description: "Reducao de gordura localizada.", bookingMode: "direct" },
  { name: "Clareamento de Virilha", aliases: "clareamento virilha", goals: "clareamento,manchas", benefits: "clareia a regiao", description: "Clareamento da regiao intima e virilha.", bookingMode: "evaluation" },
  { name: "Limpeza de Pele", aliases: "limpeza", goals: "acne,poros,limpeza", benefits: "limpeza profunda", description: "Limpeza de pele profunda.", bookingMode: null },
  { name: "Avaliação Estética", aliases: "avaliacao", goals: "", benefits: "", description: "Avaliacao gratuita.", bookingMode: "direct" },
];
const now = new Date("2026-10-20T15:00:00Z");
const at = (i) => new Date(now.getTime() - (100 - i) * 60_000);

export function decida({ history, trailing, upcoming = [], unmappedOffers = [], adText = "", strictBooking = true, notOffered = [] }) {
  const full = [...history.map((m, i) => ({ ...m, createdAt: at(i) })), ...trailing.map((t, i) => ({ role: "user", content: t, createdAt: at(90 + i) }))];
  const trailingNow = trailing;
  const hasBooking = upcoming.length > 0;
  const wanted = identifyWanted(CATALOG, [adText, ...full.filter((m) => m.role === "user").map((m) => m.content)].filter(Boolean));
  const understanding = understandConversation({ history: full, now, wanted, catalog: CATALOG, strictBooking, notOffered, unmappedOffers, adText });
  const chosen = findChosenSlot(full, trailingNow, "2026-10-20", CATALOG.map((p) => p.name));
  const lastAsk = [...full.slice(0, full.length - trailing.length)].reverse().find((m) => m.role !== "user")?.content ?? "";
  const flow = analyzeFlow({
    history: full, trailing: trailingNow, priceAsked: /quanto|valor|preco|custa/i.test(trailing.join(" ")), hasBooking, pastVisits: false, wanted, chosen, chosenFullName: null,
    evaluationName: "Avaliação Estética", awaitingName: false, needOptions: understanding.objective.concerns.length ? understanding.families : undefined,
  });
  const situation = resolveSituation({ history: full, trailing: trailingNow, now, todayIso: "2026-10-20", upcoming, pastVisits: 0, schedulingSignal: flow.schedulingSignal });
  const plan = planConduct(understanding, { flow, situation, evaluationName: "Avaliação Estética", hasBooking, clinicIsStore: false, trailing: trailingNow });
  return { flow, situation, understanding, plan, lastAsk };
}

const U = (c) => ({ role: "user", content: c });
const A = (c) => ({ role: "assistant", content: c });
const resumo = (nome, r) => console.log(`\n### ${nome}\n  intencao=${r.flow.intent} agendaPedida=${r.flow.schedulingSignal} situacao=${r.situation.kind}${r.situation.closeWith ? `/${r.situation.closeWith}` : ""} agendaAberta=${r.plan.gate.schedulingOpen} travado=${r.plan.gate.lockedProcedure ?? "-"} proibeAvaliacao=${r.situation.forbidEvaluationOffer} proibeHorarios=${r.situation.forbidSlotOffer} transfere=${r.situation.forceTransfer ? "sim" : r.plan.handoffForced ? "sim(conducao)" : "nao"}\n  trace=${JSON.stringify(r.plan.trace)}\n  jogada: ${r.flow.nextMove.slice(0, 260)}`);

if (process.argv[1] && /explorar-decisoes\.mjs$/.test(process.argv[1].replace(/\\/g, "/"))) {
  resumo("P1 'nao' depois de 'ja fez antes?'", decida({ history: [U("Oi, queria saber do Hipro"), A("Oi! O Hipro é para firmeza do rosto. Você já fez algum procedimento parecido antes?")], trailing: ["Não"] }));
  resumo("P2 'sim' depois de 'quer entender como funciona?'", decida({ history: [U("Queria saber do Hipro"), A("O Hipro trata flacidez. Quer que eu te explique como funciona?")], trailing: ["Sim"] }));
  resumo("P4 'amanha nao, quinta pode' depois de oferta de horarios", decida({ history: [U("Quero fazer o Hipro"), A("Tenho amanhã às 10h ou 14h. Qual prefere?")], trailing: ["Amanhã não, quinta pode"] }));
  resumo("P5 'obrigada, mas qual e o endereco?'", decida({ history: [U("Quero o Hipro"), A("Perfeito, ficou agendado para quinta às 10h!"), U("ok")], trailing: ["Obrigada, mas qual é o endereço?"], upcoming: [{ id: "1", dateIso: "2026-10-22", time: "10:00", label: "quinta, 22/10 às 10:00", procedure: "Hipro", professional: null, isEvaluation: false, patientConfirmed: false }] }));
  resumo("P6 'ja tenho horario, quero marcar outro procedimento'", decida({ history: [U("Oi"), A("Oi! Como posso ajudar?")], trailing: ["Já tenho horário, mas quero marcar outro procedimento: a enzima da barriga"], upcoming: [{ id: "1", dateIso: "2026-10-22", time: "10:00", label: "quinta, 22/10 às 10:00", procedure: "Hipro", professional: null, isEvaluation: false, patientConfirmed: false }] }));
  resumo("P7a 'interno de coxa' sozinho", decida({ history: [U("Oi"), A("Oi! Sobre o que gostaria de saber?")], trailing: ["Interno de coxa"] }));
  resumo("P7b 'sou morena e quero tratar gordura'", decida({ history: [U("Oi"), A("Oi! O que gostaria de tratar?")], trailing: ["Sou morena e quero tratar gordura"] }));
  resumo("P7c 'nao quero tratar gordura, quero clarear'", decida({ history: [U("Quero tratar gordura na virilha"), A("Entendi!")], trailing: ["Não quero tratar gordura, quero clarear"] }));
  resumo("P8 'vou pensar, mas quanto tempo dura?'", decida({ history: [U("Queria saber do Hipro"), A("O Hipro trata flacidez. Quer ver um horário para a avaliação?")], trailing: ["Vou pensar, mas quanto tempo dura?"] }));
  resumo("P9 oferta sem cadastro + dia/hora combinados", decida({ history: [U("Vi o anuncio do Protocolo do Olhar"), A("Que legal! Quer que eu veja um horário?"), U("Quero sim, amanhã às 10h")], trailing: ["Pode ser amanhã às 10h"], unmappedOffers: ["Protocolo do Olhar"] }));
  resumo("P10 'achei caro'", decida({ history: [U("Quanto custa a enzima?"), A("A enzima tem o valor apresentado na avaliação.")], trailing: ["Achei caro"] }));
}
