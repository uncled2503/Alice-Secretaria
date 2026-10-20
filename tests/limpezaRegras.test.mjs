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
  assert.match(flow.nextMove, /NAO (proponha|ofereca) avaliacao/); // (17/10: o texto da jogada passou a dizer "NAO ofereca avaliacao, NAO liste horarios"; o sentido e o mesmo)
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
  assert.match(src, /!day && clinic\.evalNearestFirst/);
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
  const corpo = src.slice(i, i + 15000); // (o bloco de "outra pessoa/acompanhante" veio antes da escolha de profissional)
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

test("expediente das biomedicas da Lisboa: Sabrina ter/qui 12h-21h, Amanda sabado 8h-15h (so na Lisboa)", async () => {
  const sql = fs.readFileSync(new URL("../prisma/migrations/20261014180000_lisboa_expediente_sabrina_amanda/migration.sql", import.meta.url), "utf8");
  assert.match(sql, /"workDays" = '2,4', "workStartHour" = 12, "workStartMinute" = 0, "workEndHour" = 21/);
  assert.match(sql, /"workDays" = '6', "workStartHour" = 8, "workStartMinute" = 0, "workEndHour" = 15/);
  assert.equal((sql.match(/Lisboa Beauty Center/g) ?? []).length, 2);
  // com esse expediente, terca 09:30 NAO e horario da Sabrina e quinta 12:30 e
  const { resolveHours, evaluateSlot } = await import("../dist/scheduling/slots.js");
  const clinic = { timezone: "America/Sao_Paulo", workStartHour: 8, workEndHour: 21, workDays: "1,2,3,4,5,6" };
  const sabrina = resolveHours(clinic, { workDays: "2,4", workStartHour: 12, workEndHour: 21 });
  const now = new Date("2026-10-14T15:00:00Z");
  const terca0930 = new Date("2026-10-20T12:30:00Z"); // 09:30 em Sao Paulo
  const quinta1230 = new Date("2026-10-15T15:30:00Z"); // 12:30 em Sao Paulo
  assert.equal(evaluateSlot({ startUtc: terca0930, durationMin: 60, hours: sabrina, busy: [], now }).ok, false);
  assert.equal(evaluateSlot({ startUtc: quinta1230, durationMin: 60, hours: sabrina, busy: [], now }).ok, true);
});

test("agendou e agradeceu: 'Obrigadaa' e cortesia, a Alice so fecha com uma frase e nunca volta pra descoberta", async () => {
  const { isCourtesyOnly, closingReply } = await import("../dist/ai/courtesy.js");
  for (const t of ["Obrigadaa", "obrigada!!", "Okkk", "valeuuu", "👍", "Muito obrigada"]) assert.equal(isCourtesyOnly(t), true, t);
  for (const t of ["Só confirmando o valor fica 99,99?", "obrigada, e o endereço?", "[imagem]", "ok mas qual o horário?"]) assert.equal(isCourtesyOnly(t), false, t);
  assert.equal(closingReply("Sthefany Souza", "Perfeito! Está agendado. Estamos te esperando!"), "Por nada, Sthefany! 💗");
  assert.equal(closingReply(null, "Estamos te esperando"), "Por nada! 💗");
  assert.equal(closingReply("Sthefany", "Por nada, Sthefany! 💗"), ""); // ja fechou: nao vira despedida sem fim
  // humanReturn continua exportando a mesma funcao
  const hr = await import("../dist/crm/humanReturn.js");
  assert.equal(hr.isCourtesyOnly("Obrigadaa"), true);
});

test("quem ja tem horario marcado: a jogada e responder so o que perguntou e parar (sem descoberta nem avaliacao)", async () => {
  const { analyzeFlow } = await import("../dist/ai/salesFlow.js");
  for (const [msg, priceAsked] of [["Obrigadaa", false], ["Só confirmando o valor fica 99,99?", true]]) {
    const flow = analyzeFlow({ history: [{ role: "assistant", content: "Está agendado para quarta, 21/10, às 16:00." }, { role: "user", content: msg }], trailing: [msg], priceAsked, hasBooking: true });
    assert.equal(flow.intent, "booked");
    assert.equal(flow.hasBooking, true);
    assert.match(flow.nextMove, /JA TEM HORARIO MARCADO/);
    assert.match(flow.nextMove, /NAO ofereca avaliacao/);
    assert.match(flow.nextMove, /PARE/);
  }
  // quer agendar outra coisa mesmo tendo horario: segue o agendamento
  const outro = analyzeFlow({ history: [], trailing: ["quero marcar outro horário"], priceAsked: false, hasBooking: true });
  assert.equal(outro.intent, "schedule");
});

test("rotulo relativo bate com a data: 'Amanha, dia 20/10' numa quarta 14/10 vira 'Terca-feira, dia 20/10'", async () => {
  const { fixRelativeDateLabels } = await import("../dist/ai/relativeDays.js");
  const SP = "America/Sao_Paulo";
  const quarta = new Date("2026-10-14T15:00:00Z"); // quarta, 14/10/2026, 12h em SP
  const fix = (t) => fixRelativeDateLabels(t, quarta, SP);
  assert.equal(fix("*Amanhã, dia 20/10* às *14:30*"), "*Terça-feira, dia 20/10* às *14:30*");
  assert.equal(fix("Amanhã, dia 20/10 às 18:30"), "Terça-feira, dia 20/10 às 18:30");
  assert.equal(fix("*Quinta-feira, dia 22/10* às 12:00"), "*Quinta-feira, dia 22/10* às 12:00"); // sem rotulo relativo: nao mexe
  assert.equal(fix("Amanhã, dia 15/10"), "Amanhã, dia 15/10"); // certo
  assert.equal(fix("Hoje, dia 14/10 às 16h"), "Hoje, dia 14/10 às 16h"); // certo
  assert.equal(fix("Hoje, dia 15/10"), "Amanhã, dia 15/10"); // e amanha
  assert.equal(fix("hoje (20/10)"), "terça-feira (20/10)");
  assert.equal(fix("depois de amanhã, 16/10"), "depois de amanhã, 16/10");
  assert.equal(fix("20/10 (amanhã)"), "20/10");
  assert.equal(fix("15/10 (hoje)"), "15/10 (amanhã)");
  assert.equal(fix("amanhã às 10h"), "amanhã às 10h"); // sem data: nao mexe
  assert.equal(fix("Sábado, dia 24/10"), "Sábado, dia 24/10");
});

test("candidata a vaga de emprego nao e paciente (mas 'tem vaga amanha?' continua sendo pergunta de horario)", async () => {
  const { isJobSeeker } = await import("../dist/ai/jobSeeker.js");
  for (const t of ["Olá! Tenho interesse na vaga de esteticista e gostaria de enviar meu currículo", "Posso mandar meu curriculo?", "Vocês estão com processo seletivo?", "quero me candidatar"]) {
    assert.equal(isJobSeeker(t), true, t);
  }
  assert.equal(isJobSeeker("Tenho interesse na vaga e gostaria de enviar", "Vaga de esteticista - Instagram"), true); // anuncio de vaga
  for (const t of ["Tem vaga amanhã?", "Tem vaga na quinta?", "Queria agendar uma avaliação", "tenho interesse na drenagem"]) {
    assert.equal(isJobSeeker(t), false, t);
  }
  assert.equal(isJobSeeker("tenho interesse na drenagem", "Drenagem R$ 99,99"), false);
});

test("avaliacao ja oferecida e a cliente segue perguntando do tratamento: explica o procedimento, nao insiste na avaliacao", async () => {
  const { analyzeFlow } = await import("../dist/ai/salesFlow.js");
  const hist = [
    { role: "user", content: "Gostaria de saber o valor do clareamento corporal, tratamento para estrias e gordura localizada" },
    { role: "assistant", content: "O clareamento corporal custa R$ 189,90. Você gostaria de agendar uma avaliação gratuita?" },
    { role: "user", content: "Esse valor é por região? Do clareamento corporal" },
  ];
  const preco = analyzeFlow({ history: hist, trailing: [hist[2].content], priceAsked: true, hasBooking: false });
  assert.equal(preco.intent, "price");
  assert.equal(preco.evalOffered, true);
  assert.match(preco.nextMove, /NAO ofereca avaliacao nem horario/);
  assert.match(preco.nextMove, /explique o procedimento/);
  // sem oferta anterior, o comportamento de conduzir continua
  const semOferta = analyzeFlow({ history: [hist[0], hist[2]], trailing: [hist[2].content], priceAsked: true, hasBooking: false });
  assert.match(semOferta.nextMove, /avaliacao ou horario/);
  // caso padrao (so informacao) com avaliacao ja oferecida: tambem explica
  const info = analyzeFlow({ history: [{ role: "user", content: "tenho flacidez no braço" }, { role: "assistant", content: "Posso agendar sua avaliação gratuita." }, { role: "user", content: "e como funciona o tratamento?" }], trailing: ["e como funciona o tratamento?"], priceAsked: false, hasBooking: false });
  assert.match(info.nextMove, /Converse de verdade/);
  assert.doesNotMatch(info.nextMove, /feche com UMA pergunta concreta que leve a avaliacao/);
});

test("quer agendar algo que nao esta no catalogo (oferta de anuncio): vai para a equipe, SEM avaliacao no lugar e sem 'nao localizei' (a avaliacao no lugar contradizia a conducao de oferta sem cadastro)", async () => {
  const { analyzeFlow } = await import("../dist/ai/salesFlow.js");
  const f = analyzeFlow({ history: [{ role: "user", content: "Sim, quero agendar um horário o Protocolo do Olhar!" }], trailing: ["Sim, quero agendar um horário o Protocolo do Olhar!"], priceAsked: false, hasBooking: false });
  assert.equal(f.intent, "schedule");
  assert.match(f.nextMove, /NAO estiver no catalogo/);
  assert.match(f.nextMove, /NAO agende avaliacao no lugar/);
  assert.match(f.nextMove, /transfer_to_human/);
  assert.match(f.nextMove, /NAO diga que 'nao encontrou'/);
  assert.doesNotMatch(f.nextMove, /NESSE MESMO dia e hora/);
  const src = fs.readFileSync(new URL("../src/ai/alice.ts", import.meta.url), "utf8");
  assert.match(src, /RESPONDA essa pergunta primeiro e nunca repita a mensagem anterior/);
});

test("relevancia: nunca indicar procedimento de OUTRA regiao (preenchimento labial para sobrancelha)", async () => {
  const { findRelevanceMismatch, safeReplyForMismatch, procedureFitsComplaint, areasIn } = await import("../dist/ai/relevance.js");
  const catalogo = [{ name: "Preenchimento Labial" }, { name: "Botox Facial" }, { name: "Criolipólise Abdômen" }, { name: "Peeling Químico" }, { name: "Drenagem Corporal" }];
  const resposta = 'Entendi! Para melhorar a aparência da sobrancelha, podemos considerar um procedimento chamado "Preenchimento Labial" que utiliza técnicas injetáveis.';
  const m = findRelevanceMismatch({ complaintTexts: ["melhorar a aparência da sobrancelha"], reply: resposta, procedures: catalogo });
  assert.ok(m, "deveria barrar");
  assert.equal(m.procedure, "Preenchimento Labial");
  assert.equal(m.complaintLabel, "as sobrancelhas");
  const segura = safeReplyForMismatch(m, false);
  assert.doesNotMatch(segura, /Preenchimento|labial/i);
  assert.match(segura, /sobrancelhas/);
  assert.match(safeReplyForMismatch(m, true), /o que mais te incomoda/); // avaliacao ja oferecida: conversa, sem insistir

  // casos que NAO devem ser barrados
  const ok = (queixa, citado) => findRelevanceMismatch({ complaintTexts: [queixa], reply: `Posso indicar o ${citado}.`, procedures: catalogo });
  assert.equal(ok("quero melhorar a sobrancelha", "Botox Facial"), null); // facial serve a qualquer regiao do rosto
  assert.equal(ok("gordura na barriga", "Criolipólise Abdômen"), null);
  assert.equal(ok("manchas na pele", "Peeling Químico"), null); // sem regiao no nome
  assert.equal(ok("quero um rosto mais jovem", "Botox Facial"), null);
  assert.equal(ok("estou animada", "Preenchimento Labial"), null); // queixa sem regiao
  assert.equal(findRelevanceMismatch({ complaintTexts: ["quero aumentar o lábio e arrumar a sobrancelha"], reply: "Preenchimento Labial", procedures: catalogo }), null); // ela citou os dois
  // barra de verdade
  assert.ok(ok("rugas no rosto", "Criolipólise Abdômen"));
  assert.ok(ok("gordura na barriga", "Preenchimento Labial"));
  assert.ok(ok("flacidez no rosto", "Drenagem Corporal"));
  assert.equal(procedureFitsComplaint(areasIn("Preenchimento Labial"), areasIn("sobrancelha")), false);
});

test("aviso do Clinica Experts: 'reserva sem procedimento' em vez de '?', e reserva que ja existe na Alice e ligada antes de desistir", async () => {
  const { skipReasonText } = await import("../dist/clinicaexperts/pull.js");
  assert.equal(skipReasonText({ reason: "sem_telefone", procedureNames: [] }), "sem telefone");
  assert.equal(skipReasonText({ reason: "procedimento_sem_vinculo", procedureNames: ["Peeling"] }), "procedimento sem vínculo: Peeling");
  assert.equal(skipReasonText({ reason: "procedimento_sem_vinculo", procedureNames: ["#12"] }), "procedimento sem vínculo: #12");
  assert.match(skipReasonText({ reason: "procedimento_sem_vinculo", procedureNames: [] }), /reserva sem procedimento no Clínica Experts/);
  const src = fs.readFileSync(new URL("../src/clinicaexperts/pull.ts", import.meta.url), "utf8");
  // (a ligacao com o agendamento que ja existe agora e o comparador estrito, e continua vindo ANTES de criar a reserva sem procedimento)
  const casar = src.indexOf("const match = pickUniqueMatch(locals");
  const semProcedimento = src.indexOf("ensurePlaceholderProcedure(clinicId)", casar);
  assert.ok(casar > 0 && semProcedimento > casar, "o casamento com o agendamento existente tem que vir ANTES de criar a reserva sem procedimento");
  assert.ok(src.includes('reason: "sem_telefone"'), "sem telefone e sem cadastro identificavel continua sendo descartado e avisado");
});
