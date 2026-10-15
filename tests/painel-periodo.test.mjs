// "Meu dia": cada periodo mostra os SEUS numeros ("Hoje" mostrava os de 30 dias) e trocar de aba nao espera a base inteira.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

const { periodWindow } = await import("../dist/crm/period.js");
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const TZ = "America/Sao_Paulo";
const iso = (d) => d.toISOString();

test("Hoje: da meia-noite ate o fim do dia, no fuso da clinica", () => {
  const w = periodWindow(0, TZ, new Date("2026-10-15T12:00:00Z")); // 09:00 em Sao Paulo
  assert.equal(iso(w.start), "2026-10-15T03:00:00.000Z");
  assert.equal(iso(w.end), "2026-10-16T02:59:59.999Z");
});

test("Hoje continua sendo hoje depois das 21h (o UTC ja virou o dia, a clinica nao)", () => {
  const w = periodWindow(0, TZ, new Date("2026-10-16T02:30:00Z")); // 23:30 de 15/10 em Sao Paulo
  assert.equal(iso(w.start), "2026-10-15T03:00:00.000Z");
  assert.equal(iso(w.end), "2026-10-16T02:59:59.999Z");
});

test("Ontem: o dia inteiro de ontem (nao 'as ultimas 24 h')", () => {
  const w = periodWindow(1, TZ, new Date("2026-10-15T12:00:00Z"));
  assert.equal(iso(w.start), "2026-10-14T03:00:00.000Z");
  assert.equal(iso(w.end), "2026-10-15T02:59:59.999Z");
});

test("7, 30 e 90 dias: os ultimos N dias CONTANDO hoje, comecando na meia-noite", () => {
  const now = new Date("2026-10-15T12:00:00Z");
  assert.equal(iso(periodWindow(7, TZ, now).start), "2026-10-09T03:00:00.000Z");
  assert.equal(iso(periodWindow(30, TZ, now).start), "2026-09-16T03:00:00.000Z");
  assert.equal(iso(periodWindow(90, TZ, now).start), "2026-07-18T03:00:00.000Z");
  for (const n of [7, 30, 90]) assert.equal(iso(periodWindow(n, TZ, now).end), "2026-10-16T02:59:59.999Z");
});

test("periodos diferentes dao janelas diferentes (o bug: Hoje == 30 dias)", () => {
  const now = new Date("2026-10-15T12:00:00Z");
  const starts = [0, 1, 7, 30, 90].map((n) => iso(periodWindow(n, TZ, now).start));
  assert.equal(new Set(starts).size, 5);
});

test("o botao Hoje (data-days=0) nao cai no '|| 30'", () => {
  const html = read("public/index.html");
  assert.match(html, /data-days="0">Hoje</);
  const js = read("public/app.js");
  assert.ok(!/state\.periodDays = Number\(btn\.dataset\.days\) \|\| 30/.test(js), "0 e falso: '|| 30' trocava Hoje por 30 dias");
  assert.match(js, /Number\.isFinite\(days\) \? days : 30/);
  assert.match(js, /\/dashboard\/stats\?period=\$\{state\.periodDays\}/, "o servidor calcula a janela no fuso da clinica");
});

test("resposta velha de outro periodo e descartada e o grafico usa o total do periodo", () => {
  const js = read("public/app.js");
  assert.match(js, /if \(seq !== state\._dashSeq\) return;/);
  assert.match(js, /stats\.appointmentsTotal\} no período/);
  assert.match(js, /renderMiniCalendar\(stats\.monthDays \|\| \{\}\)/, "calendario do mes nao depende do periodo");
});

test("servidor: dias no fuso da clinica, sem cortar em 60 dias, cache curto", () => {
  const src = read("src/api/routes.ts");
  const i = src.indexOf('"/dashboard/stats"');
  const trecho = src.slice(i, i + 9000);
  assert.match(trecho, /isoDateInZone\(stamp\(a\), tz\)/);
  assert.ok(!/daily\.length < 60/.test(trecho), "o periodo de 90 dias mostrava so os 60 primeiros dias");
  assert.match(trecho, /dashboardCache/);
});

test("trocar de aba nao recarrega a base inteira: so a aba aberta, e so se o dado estiver velho", () => {
  const js = read("public/app.js");
  const a = js.indexOf("async function refreshAll(");
  const corpo = js.slice(a, a + 900);
  assert.ok(!/need\("contacts"\)|need\("crm"\)/.test(corpo), "o ciclo de 30 s recarregava Pessoas e Jornada em segundo plano");
  assert.match(js, /const TAB_TTL_MS = \{ dashboard: 60_000, contacts: 60_000, crm: 20_000, agenda: 15_000 \}/);
  assert.match(js, /Date\.now\(\) - \(state\._loadedAt\[tab\] \|\| 0\) < TAB_TTL_MS\[tab\]/);
});

test("Pessoas e Jornada desenham so uma parte por vez e nao refazem a tela quando nada mudou", () => {
  const js = read("public/app.js");
  assert.match(js, /const CONTACTS_PAGE = 100;/);
  assert.match(js, /contacts\.slice\(0, state\.contactsShown\)/);
  assert.match(js, /const CRM_COL_PAGE = 40;/);
  assert.match(js, /patients\.slice\(0, crmLimit\)/);
  assert.match(js, /if \(changed\) renderContactsTable/);
  assert.match(js, /if \(changed\) renderCrmBoard/);
  assert.match(js, /if \(sig === state\._convSig && state\.conversations\) return;/);
});
