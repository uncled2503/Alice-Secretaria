// RELATORIO SOMENTE LEITURA dos disparos de uma clinica (padrao: Lisboa Beauty Center): cobertura por tipo, motivos e a PREVIA do que seria recuperavel hoje.
//   node scripts/disparos-lisboa.mjs [AAAA-MM-DD inicio] [AAAA-MM-DD fim] ["Nome da clinica"]     (rodar na pasta do app, depois do build, com o DATABASE_URL desejado)
// NAO envia nada, NAO reserva, NAO grava, NAO reabre historico, NAO apaga controle de envio: so chama as funcoes de leitura da aba Disparos. Telefones saem mascarados.
import { prisma } from "../dist/db/client.js";
import { buildDispatchView, listFilteredIds } from "../dist/dispatch/model.js";

const args = process.argv.slice(2);
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? "");
const from = isDay(args[0]) ? args[0] : undefined;
const to = isDay(args[1]) ? args[1] : from;
const nome = args.find((a) => a && !isDay(a)) ?? "Lisboa Beauty Center";

const clinic = await prisma.clinic.findFirst({ where: { name: nome }, select: { id: true, name: true, timezone: true } });
if (!clinic) { console.log(JSON.stringify({ somenteLeitura: true, erro: `clinica "${nome}" nao encontrada` }, null, 2)); process.exit(1); }

const filtros = from ? { from, to } : { view: "atencao" };
const v = await buildDispatchView(clinic.id, filtros);
const recuperaveis = (await listFilteredIds(clinic.id, { ...filtros, recoverableToday: true }, undefined, true)).filter((i) => i.recoverable);

console.log(JSON.stringify({
  somenteLeitura: true,
  geradoEm: v.geradoEm,
  clinica: clinic.name,
  fuso: v.fuso,
  periodo: v.periodo,
  avisos: v.avisos,
  contadores: v.counters,
  cobertura: v.cobertura.map((k) => ({ tipo: k.kind, contadores: k.counters, cobertura: k.cobertura, fonteCompleta: k.fonteCompleta, nota: k.fonteNota, principaisMotivos: k.porMotivo })),
  recuperaveisHoje: recuperaveis.map((i) => ({ tipo: i.kind, pessoa: i.patientName.split(/\s+/)[0], telefone: i.phone, referencia: i.referenceAt, estado: i.statusLabel, motivo: i.reasonLabel })),
  observacoes: [
    "Previa: nenhum envio foi feito e nenhum registro foi alterado.",
    "Aceito pelo WhatsApp nao e entregue; sem id do provedor nao ha como conferir a entrega.",
    "Itens de dias anteriores nao sao reabertos: so o que e do dia de hoje pode ser recuperado (e cada um e revalidado no momento do envio).",
    "A causa dos itens 'sem evidencia suficiente' nao pode ser afirmada por este relatorio.",
  ],
}, null, 2));
await prisma.$disconnect();
