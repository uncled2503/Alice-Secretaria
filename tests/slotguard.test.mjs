import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { newSlotState, absorbToolResult, extractMentions, checkSlotMentions, knownFrom, renderOffer, renderBooked } = await import("../dist/ai/slotGuard.js");

const TZ = "America/Sao_Paulo";
const NOW = new Date("2026-10-14T15:00:00Z"); // quarta, 14/10/2026, 12h em Sao Paulo
const EMPTY = knownFrom([], [], TZ);

function stateWithOffer() {
  const st = newSlotState();
  absorbToolResult(
    st,
    "check_availability",
    JSON.stringify({
      procedimento: "Avaliação Estética",
      horarios_mais_proximos: [
        { iso: "2026-10-16T11:00:00.000Z", quando: "sexta-feira, 16/10 às 08:00", profissional: "Fabíola" },
        { iso: "2026-10-16T12:00:00.000Z", quando: "sexta-feira, 16/10 às 09:00", profissional: "Fabíola" },
        { iso: "2026-10-16T13:30:00.000Z", quando: "sexta-feira, 16/10 às 10:30", profissional: "Fabíola" },
      ],
    }),
    TZ,
  );
  return st;
}

test("extrai horarios e datas, ignorando expediente, duracao e antecedencia", () => {
  const m = extractMentions("Atendemos das 8h às 21h. A sessão dura 1h30 e cancelar com 24h de antecedência. Terça, 20/10 às 14:30 ou 18h.");
  assert.deepEqual(m.times.sort(), ["14:30", "18:00"]);
  assert.deepEqual(m.dates, ["20/10"]);
  assert.deepEqual(extractMentions("Posso ver amanhã, hoje ou depois de amanhã?").relative.sort(), ["amanha", "depois", "hoje"]);
});

test("caso Devini: 'conseguimos agendar para amanha' com a lista em 16/10 (depois de amanha) e barrado", () => {
  const st = stateWithOffer();
  const errada =
    "Ótimo saber que você gostou! 😍\n\nConseguimos agendar a avaliação para amanhã. Tenho estas opções:\n\n• Depois de amanhã, 16/10, às 08:00 com a Fabíola.\n• Depois de amanhã, 16/10, às 09:00 com a Fabíola.\n• Depois de amanhã, 16/10, às 10:30 com a Fabíola.";
  const v = checkSlotMentions({ text: errada, state: st, known: EMPTY, toolUsed: true, now: NOW, tz: TZ });
  assert.equal(v.ok, false);
  assert.match(v.problems.join(" "), /amanha/);
  const certa = "Tenho estas opções:\n\n• Depois de amanhã, 16/10, às 08:00 com a Fabíola.\n• Depois de amanhã, 16/10, às 09:00 com a Fabíola.\n• Depois de amanhã, 16/10, às 10:30 com a Fabíola.\n\nQual fica melhor?";
  assert.equal(checkSlotMentions({ text: certa, state: st, known: EMPTY, toolUsed: true, now: NOW, tz: TZ }).ok, true);
});

test("horario ou data que a agenda nao devolveu e barrado (com ferramenta)", () => {
  const st = stateWithOffer();
  const chk = (text) => checkSlotMentions({ text, state: st, known: EMPTY, toolUsed: true, now: NOW, tz: TZ });
  assert.equal(chk("Tenho sexta, 16/10 às 11:00").ok, false); // 11:00 inventado
  assert.equal(chk("Tenho terça, 20/10 às 09:00").ok, false); // 20/10 inventado
  assert.equal(chk("Tenho sexta, 16/10 às 9h").ok, true); // 9h = 09:00 devolvido
  assert.equal(chk("Qual desses horários fica melhor?").ok, true); // sem dia nem hora
});

test("o que a propria pessoa citou e o que ela ja tem agendado pode ser repetido", () => {
  const st = stateWithOffer();
  const known = knownFrom(["pode ser sexta às 16:30?"], [new Date("2026-10-21T19:00:00Z")], TZ); // 21/10 16:00 em SP
  const r = checkSlotMentions({ text: "Esse horário (16:30) não está disponível. Você já tem 21/10 às 16:00 marcado. Tenho 16/10 às 08:00.", state: st, known, toolUsed: true, now: NOW, tz: TZ });
  assert.equal(r.ok, true, r.problems.join("; "));
});

test("sem ferramenta: so confere quando parece oferta (dia E hora) e aceita o que ja foi oferecido antes", () => {
  const chk = (text, known = EMPTY) => checkSlotMentions({ text, state: newSlotState(), known, toolUsed: false, now: NOW, tz: TZ });
  assert.equal(chk("Atendemos de segunda a sexta, das 8h às 21h, e aos sábados até as 15h.").ok, true);
  assert.equal(chk("Esse procedimento tem duração de 1h30.").ok, true);
  assert.equal(chk("Que tal terça, 20/10 às 14:30?").ok, false); // inventou sem consultar a agenda
  const loose = knownFrom(["Tenho terça, 20/10 às 14:30 ou 18:30."], [], TZ);
  assert.equal(chk("Então fica terça, 20/10 às 14:30, combinado?", loose).ok, true); // repetindo oferta anterior
});

test("book_appointment ok: a resposta so pode citar o horario agendado; e monta confirmacao pelos dados", () => {
  const st = newSlotState();
  absorbToolResult(st, "book_appointment", JSON.stringify({ agendado: true, quando: "quarta-feira, 21/10 às 16:00", profissional: "Adriana" }), TZ);
  assert.deepEqual(st.booked, { label: "quarta-feira, 21/10 às 16:00", professional: "Adriana" });
  assert.equal(checkSlotMentions({ text: "Perfeito! Está agendado para quarta-feira, 21/10, às 16:00 com a Adriana.", state: st, known: EMPTY, toolUsed: true, now: NOW, tz: TZ }).ok, true);
  assert.equal(checkSlotMentions({ text: "Está agendado para quarta-feira, 21/10, às 15:00.", state: st, known: EMPTY, toolUsed: true, now: NOW, tz: TZ }).ok, false);
  assert.match(renderBooked(st.booked), /quarta-feira, 21\/10 às 16:00 com Adriana/);
});

test("resposta montada direto da agenda: ate 3 horarios, dia da semana e data calculados pelo codigo", () => {
  const st = stateWithOffer();
  const t = renderOffer(st.offer, TZ);
  assert.match(t, /• sexta-feira, 16\/10 às 08:00 com Fabíola/);
  assert.match(t, /• sexta-feira, 16\/10 às 10:30 com Fabíola/);
  assert.equal((t.match(/•/g) ?? []).length, 3);
  // o texto montado passa na propria trava
  assert.equal(checkSlotMentions({ text: t, state: st, known: EMPTY, toolUsed: true, now: NOW, tz: TZ }).ok, true);
});

test("a trava esta ligada no motor da Alice (nudge + montagem final) e so em clinica com agenda", () => {
  const src = fs.readFileSync(new URL("../src/ai/alice.ts", import.meta.url), "utf8");
  assert.match(src, /const guardOn = canBook && usageClinic\?\.businessType !== "geral"/);
  assert.match(src, /absorbToolResult\(slotState, toolCall\.function\.name, result, guardTz\)/);
  assert.match(src, /messages\.push\(\{ role: "system", content: SLOT_NUDGE \}\)/);
  assert.match(src, /renderBooked\(slotState\.booked\)/);
});
