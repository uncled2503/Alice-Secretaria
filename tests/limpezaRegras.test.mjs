import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { RULE_CHANGES, EVAL_TODAY_TOMORROW_MARKER } = await import("../dist/maintenance/cleanLisboaRules.js");
const { recontactInstant } = await import("../dist/ai/alice.js");
const { analyzeFlow } = await import("../dist/ai/salesFlow.js");
const seed = fs.readFileSync(new URL("../src/maintenance/seedLisboa.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const seedText = (t) => seed.includes(JSON.stringify(t).slice(1, -1));

test("aprovadas pela Aline (14/10): tudo da lista, incluindo 470, 468, 486 e a 513", () => {
  const ap = RULE_CHANGES.filter((c) => c.approved && c.line);
  const by = (a) => ap.filter((c) => c.action === a).map((c) => c.line).sort((x, y) => x - y);
  assert.deepEqual(by("remove"), [467, 470, 513, 524, 537, 538, 539, 547, 552, 553, 581]);
  assert.deepEqual(by("rewrite"), [468, 485, 486, 492, 509, 540]);
  assert.equal(RULE_CHANGES.filter((c) => !c.approved).length, 0);
});

test("seed novo nasce sem as regras removidas e com os textos reescritos", () => {
  for (const c of RULE_CHANGES) {
    if (!c.approved || !c.line) continue;
    assert.equal(seedText(c.oldText), false, `linha ${c.line} ainda no seed`);
    if (c.action === "rewrite") assert.equal(seedText(c.newText), true, `linha ${c.line} reescrita fora do seed`);
  }
});

test("textos novos nao mandam 'nunca informe valores' nem prometem 'vou verificar com a equipe'", () => {
  for (const c of RULE_CHANGES) {
    if (!c.newText) continue;
    assert.doesNotMatch(c.newText, /nunca informe valores/i);
    assert.doesNotMatch(c.newText, /diga que vai verificar|preciso confirmar com nossa equipe/i);
  }
});

test("avaliacao: regra de hoje/amanha existe, aprovada e com marcador proprio", () => {
  const c = RULE_CHANGES.find((x) => x.marker === EVAL_TODAY_TOMORROW_MARKER);
  assert.ok(c && c.approved && c.action === "add");
  assert.match(c.newText, /hoje/);
  assert.match(c.newText, /amanhã/);
});

test("silencio ao transferir: a regra nao manda escrever encaminhamento nem 'ate a liberacao'", () => {
  const r = RULE_CHANGES.find((x) => x.line === 509);
  assert.match(r.newText, /silêncio/);
  assert.doesNotMatch(r.newText, /liberação/);
});

test("'vou pensar': regra, roteiro e jogada nao empurram avaliacao e combinam o recontato", () => {
  assert.match(RULE_CHANGES.find((x) => x.line === 468).newText, /schedule_recontact/);
  const roteiro = RULE_CHANGES.find((x) => x.target === "roteiro" && x.name.startsWith("Paciente vai pensar"));
  assert.doesNotMatch(roteiro.newText, /Proponha a avaliação/);
  assert.match(roteiro.newText, /schedule_recontact/);
  const flow = analyzeFlow({ history: [{ role: "assistant", content: "Quer ver um horário?" }, { role: "user", content: "vou pensar" }], trailing: ["vou pensar"], priceAsked: false, hasBooking: false });
  assert.equal(flow.intent, "hesitate");
  assert.match(flow.nextMove, /schedule_recontact/);
  assert.match(flow.nextMove, /NAO proponha avaliacao/);
});

test("a regra padrao antiga de 'desconverse' esta aposentada e a nova responde a verdade", async () => {
  const { DEFAULT_RULES, RETIRED_DEFAULT_RULES } = await import("../dist/ai/rules.js");
  assert.ok(RETIRED_DEFAULT_RULES.some((t) => t.includes("desconverse")));
  assert.ok(!DEFAULT_RULES.some((r) => r.instruction.includes("desconverse")));
  assert.ok(DEFAULT_RULES.some((r) => r.instruction.includes("responda com a verdade")));
});

test("recontato agendado: dia e hora no fuso da clinica; passado, hora invalida e muito longe viram null", () => {
  const now = new Date("2026-10-14T15:00:00Z"); // 12h em Sao Paulo
  const at = recontactInstant("2026-10-16", "10:00", "America/Sao_Paulo", now);
  assert.equal(at.toISOString(), "2026-10-16T13:00:00.000Z");
  assert.equal(recontactInstant("2026-10-16", undefined, "America/Sao_Paulo", now).toISOString(), "2026-10-16T13:00:00.000Z"); // sem hora: 10:00
  assert.equal(recontactInstant("2026-10-14", "09:00", "America/Sao_Paulo", now), null); // ja passou
  assert.equal(recontactInstant("2026-10-16", "25:00", "America/Sao_Paulo", now), null);
  assert.equal(recontactInstant("data ruim", "10:00", "America/Sao_Paulo", now), null);
  assert.equal(recontactInstant("2028-01-01", "10:00", "America/Sao_Paulo", now), null);
});

test("configuracao da Lisboa no seed: informa preco, nao manda valor pra equipe, agenda direto, confirma como Alice", () => {
  assert.match(seed, /handoffOnPrice: false/);
  assert.match(seed, /quotePrices: true/);
  assert.match(seed, /aliceCanBook: true/);
  assert.doesNotMatch(seed, /Aqui é a Fabi/);
  assert.doesNotMatch(seed, /nossa equipe verifica o melhor horário|encaminhar para nossa equipe verificar os horários|nossa equipe confirma uma condição vigente/);
});

test("migracao das decisoes da Aline mexe so na Lisboa e so no texto antigo exato", () => {
  const sql = fs.readFileSync(new URL("../prisma/migrations/20261014150000_lisboa_decisoes_aline/migration.sql", import.meta.url), "utf8");
  assert.match(sql, /"handoffOnPrice" = 0, "quotePrices" = 1 WHERE "name" = 'Lisboa Beauty Center'/);
  assert.match(sql, /replace\("message", 'Aqui é a Fabi', 'Aqui é a Alice'\)/);
  assert.equal((sql.match(/UPDATE "FollowUpRule"/g) ?? []).length, 3);
  assert.equal((sql.match(/Lisboa Beauty Center/g) ?? []).length >= 5, true);
});

test("a retomada da Alice nao pede desculpa pela demora", () => {
  const src = fs.readFileSync(new URL("../src/ai/alice.ts", import.meta.url), "utf8");
  const i = src.indexOf("RETOMADA DO ATENDIMENTO");
  assert.ok(i > 0);
  const trecho = src.slice(i, i + 400);
  assert.doesNotMatch(trecho, /pedindo desculpa|Desculpa a demora/);
  assert.match(trecho, /NAO peca desculpa/);
});

test("todo botao ligado no app.js existe no index.html (um id faltando derruba o resto do painel)", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const js = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const ids = [...js.matchAll(/getElementById\("([^"]+)"\)\.addEventListener/g)].map((m) => m[1]);
  assert.deepEqual(ids.filter((id) => !html.includes(`id="${id}"`)), []);
});

test("rotas da Lisboa no admin nao dependem da trava de manutencao (so admin, com previa)", () => {
  const src = fs.readFileSync(new URL("../src/api/routes.ts", import.meta.url), "utf8");
  for (const rota of ["lisboa-descritivos", "lisboa-limpar-regras", "lisboa-servicos"]) {
    const i = src.indexOf(`"/clinics/${rota}"`);
    assert.ok(i > 0, rota);
    const corpo = src.slice(i, i + 400);
    assert.match(corpo, /requireAdmin/);
    assert.doesNotMatch(corpo, /maintenanceEnabled/);
  }
});

test("confirmacao de presenca: so agradece quando a resposta e SO uma confirmacao", async () => {
  const { isConfirmationReply, confirmationThanks } = await import("../dist/ai/confirmation.js");
  for (const t of ["Bom dia. Pode sim.", "Pode sim", "Confirmo", "Sim", "ok", "Estarei aí", "Sim, confirmado!", "Confirmado 😊", "Vou sim, obrigada!", "Combinado"]) {
    assert.equal(isConfirmationReply(t), true, t);
  }
  for (const t of ["Não vou poder", "Preciso remarcar", "pode ser outro horário?", "ok, quero saber o valor", "Sim, mas queria mudar o horário", "Quanto custa?", "obrigada", "Posso levar acompanhante?", "Infelizmente não consigo", "", "ok, quero um desconto"]) {
    assert.equal(isConfirmationReply(t), false, t);
  }
  assert.equal(confirmationThanks("Shirley narciso de oliveira"), "Obrigada pela confirmação, Shirley! 💗");
  assert.equal(confirmationThanks(null), "Obrigada pela confirmação! 💗");
});

test("quem ja tem horario marcado nao recebe as perguntas de descoberta (ja fez o procedimento?)", () => {
  const src = fs.readFileSync(new URL("../src/ai/alice.ts", import.meta.url), "utf8");
  assert.match(src, /!ctx\.flow\?\.hasBooking/);
  assert.match(src, /nunca pergunte se ja fez o procedimento/);
});

test("avaliacao: horarios mais proximos (um por horario, em ordem) e flag so na Lisboa", async () => {
  const { dedupeByStart } = await import("../dist/scheduling/slots.js");
  const a = new Date("2026-10-15T21:00:00Z"), b = new Date("2026-10-16T19:30:00Z");
  const r = dedupeByStart([{ start: a, p: 1 }, { start: a, p: 2 }, { start: b, p: 1 }]);
  assert.equal(r.length, 2);
  assert.equal(r[0].p, 1);
  const sql = fs.readFileSync(new URL("../prisma/migrations/20261014160000_avaliacao_horarios_mais_proximos/migration.sql", import.meta.url), "utf8");
  assert.match(sql, /"evalNearestFirst" = 1 WHERE "name" = 'Lisboa Beauty Center'/);
  const src = fs.readFileSync(new URL("../src/ai/alice.ts", import.meta.url), "utf8");
  assert.match(src, /clinic\.evalNearestFirst && \/avalia\/i\.test\(procedure\.name\)/);
  assert.match(src, /horarios_mais_proximos/);
});

test("diagnostico de horario e so admin e somente leitura", () => {
  const src = fs.readFileSync(new URL("../src/api/routes.ts", import.meta.url), "utf8");
  const i = src.indexOf('"/clinics/lisboa-diagnostico-horario"');
  assert.ok(i > 0);
  const corpo = src.slice(i, i + 900);
  assert.match(corpo, /requireAdmin/);
  assert.doesNotMatch(corpo, /\.(update|create|delete)\(/);
});

test("agendar sem profissional informado escolhe um que esteja livre (nao valida contra a clinica inteira)", () => {
  const src = fs.readFileSync(new URL("../src/ai/alice.ts", import.meta.url), "utf8");
  const i = src.indexOf('if (name === "book_appointment")');
  const corpo = src.slice(i, i + 4500);
  assert.match(corpo, /candidateProIds/);
  assert.match(corpo, /checkSpecificTime\(clinicId, procedure\.id, \{ year: wc\.year/);
  assert.ok(corpo.indexOf("candidateProIds.length > 1") < corpo.indexOf("await createBooking("));
});

test("recontato de 1 dia: vence no dia civil seguinte as 8h (fuso de Sao Paulo), inclusive na virada do mes", async () => {
  const { nextDayAt } = await import("../dist/crm/followup.js");
  assert.equal(nextDayAt(new Date("2026-10-14T18:00:00Z"), "America/Sao_Paulo", 8).toISOString(), "2026-10-15T11:00:00.000Z"); // escreveu 15h -> amanha 8h
  assert.equal(nextDayAt(new Date("2026-10-15T02:30:00Z"), "America/Sao_Paulo", 8).toISOString(), "2026-10-15T11:00:00.000Z"); // 23h30 do dia 14 em SP -> dia 15 8h
  assert.equal(nextDayAt(new Date("2026-10-31T23:00:00Z"), "America/Sao_Paulo", 8).toISOString(), "2026-11-01T11:00:00.000Z"); // virada de mes
});

test("migracao 17: recontato de 1 dia as 8h so na Lisboa + texto da pesquisa pos-avaliacao da Aline", () => {
  const sql = fs.readFileSync(new URL("../prisma/migrations/20261014170000_recontato_dia_seguinte_pos_avaliacao/migration.sql", import.meta.url), "utf8");
  assert.match(sql, /"nextDayHour" = 8, "sendWindowStart" = 8, "sendWindowEnd" = 12/);
  assert.match(sql, /"order" = 2 AND "afterMinutes" = 1440/);
  assert.match(sql, /Gostaríamos de saber como foi sua experiência durante a avaliação conosco/);
  assert.match(sql, /\{primeiro_nome\}/);
  assert.match(sql, /WHERE "name" = 'Lisboa Beauty Center'/);
});

test("pesquisa de satisfacao usa o texto da avaliacao so quando o atendimento e uma avaliacao", () => {
  const src = fs.readFileSync(new URL("../src/reminders/nps.ts", import.meta.url), "utf8");
  assert.match(src, /\/avalia\/i\.test\(appt\.procedure\.name\)/);
  assert.match(src, /isEvaluation && clinic\.npsEvaluationMessage/);
});
