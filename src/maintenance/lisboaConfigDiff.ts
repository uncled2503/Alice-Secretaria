import { prisma } from "../db/client.js";
import { planejarPolitica } from "../reminders/confirmationPolicy.js";
import { prepararDatasEspeciais } from "../crm/specialDates.js";
import { LISBOA_POLITICA_CONFIRMACOES } from "./lisboaPoliticaConfirmacoes.js";

// ---------------------------------------------------------------------------
// PREVIA SOMENTE LEITURA: configuracao ATUAL x DESEJADA da Lisboa (checklist mestre, 22/10). Nao altera nada, nao envia nada, nao reimplementa o que ja existe: cada linha diz o estado
// (conforme | diverge | depende_da_clinica | indeterminado), o que esta cadastrado e o que o checklist pede. "Desejado" vem EXCLUSIVAMENTE das regras escritas no checklist; onde o checklist nao
// define (ex.: texto/validade de campanha, link do Google), a linha e "depende_da_clinica" - nunca se presume. Aplicar cada ajuste continua nas rotas com previa/aprovacao ja existentes.
// ---------------------------------------------------------------------------
export type DiffState = "conforme" | "diverge" | "depende_da_clinica" | "indeterminado";
export interface DiffLine { tema: string; estado: DiffState; atual: string; desejado: string; comoAplicar: string | null }

const hh = (h: number | null | undefined, m = 0) => (h == null ? "—" : `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
const first = (n: string) => n.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/^dra?\.?\s+/, "").trim().split(/\s+/)[0] ?? "";
const CADENCE_MIN = [240, 1440 * 1, 1440 * 3, 1440 * 7, 1440 * 15, 1440 * 45, 1440 * 60, 1440 * 120, 1440 * 180];

export async function conferirRegrasLisboa(clinicId: string): Promise<{ somenteLeitura: true; clinica: string; geradoEm: string; linhas: DiffLine[]; resumo: Record<DiffState, number> }> {
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { name: true, googleReviewUrl: true } });
  const linhas: DiffLine[] = [];
  const add = (l: DiffLine) => linhas.push(l);

  // ---- confirmacoes / sabado: a REGRA FINAL (22/10) pelo planejador geral, em modo previa (nada muda)
  const plano = await planejarPolitica(clinicId, LISBOA_POLITICA_CONFIRMACOES, { dryRun: true });
  for (const i of plano.itens) {
    const estado: DiffState = i.acao === "manter" ? "conforme" : i.acao === "pendencia" ? "depende_da_clinica" : "diverge";
    add({
      tema: i.etapa ? `Confirmações: ${i.descricao.split(": falta ")[0].slice(0, 140)}` : "Confirmações: regra fora da política",
      estado,
      atual: i.de ? JSON.stringify(i.de).slice(0, 220) : i.acao === "criar" ? "não cadastrada" : i.acao === "manter" ? "conforme" : i.descricao.slice(0, 220),
      desejado: i.para ? JSON.stringify(i.para).slice(0, 220) : i.descricao.slice(0, 220),
      comoAplicar: estado === "conforme" ? null : estado === "depende_da_clinica" ? "informação da clínica (ver pendências)" : "POST /clinics/lisboa-politica-confirmacoes { aprovado: true } (prévia em GET)",
    });
  }
  add({ tema: "Reposição de agendado/remarcado depois da janela (mesmo dia)", estado: plano.limites.pendente.length ? "depende_da_clinica" : "conforme", atual: `reposição ${plano.limites.atual.lateStartHour}h–${plano.limites.atual.lateEndHour}h, antecedência mínima ${plano.limites.atual.minLeadMin} min, intervalo entre etapas ${plano.limites.atual.stepMinGapMin} min (atendimento de hoje não recebe pedido de "amanhã")`, desejado: "limites aprovados pela clínica (limite noturno e 'muito próximo' não informados)", comoAplicar: plano.limites.pendente.length ? "PUT /dispatches/policy/:kind (lateStartHour, lateEndHour, minLeadMin, stepMinGapMin)" : null });

  // ---- pre 48h
  const pre = await prisma.preProcedureRule.findMany({ where: { clinicId, active: true } });
  const pre48 = pre.filter((r) => r.sendHoursBefore === 48);
  add({ tema: "Pré-procedimento: regra mais recente de 48 horas", estado: pre48.length ? "conforme" : pre.length ? "diverge" : "diverge", atual: pre.length ? `${pre.length} regra(s) ativa(s); ${pre48.length} com 48h` : "nenhuma regra de pré ativa", desejado: "orientação de preparo 48h antes (sem mensagem atrasada para agendamento com menos de 48h)", comoAplicar: pre48.length ? null : "cadastro das regras de pré-procedimento (texto por procedimento depende da clínica)" });

  // ---- pos
  const pos = await prisma.postProcedureRule.findMany({ where: { clinicId, active: true } });
  const semNoturno = pos.filter((r) => !r.lateSendUntilHour);
  add({ tema: "Pós-procedimento após o fechamento, para TODOS os procedimentos", estado: !pos.length ? "diverge" : semNoturno.length ? "diverge" : "conforme", atual: pos.length ? `${pos.length - semNoturno.length}/${pos.length} regra(s) com envio após o fechamento` : "nenhuma regra de pós ativa", desejado: "todas as regras ativas com lateSendUntilHour (até 21–24h; só quem venceu há ≤6h; nada de lote antigo na madrugada)", comoAplicar: semNoturno.length ? "configurarPosDepoisDoFechamento({ todosProcedimentos: true }) (prévia + aprovação)" : null });

  // ---- recontatos
  const fu = await prisma.followUpRule.findMany({ where: { clinicId, active: true }, orderBy: { order: "asc" } });
  const mins = fu.map((r) => (r.nextDayHour != null ? 1440 : r.afterMinutes > 0 ? r.afterMinutes : r.afterDays * 1440));
  const faltam = CADENCE_MIN.filter((m) => !mins.includes(m));
  const umDia = fu.find((r) => r.nextDayHour != null);
  add({ tema: "Recontatos: 4h, próximo dia de manhã, 3, 7, 15, 45, 60, 120 e 180 dias", estado: !fu.length ? "diverge" : faltam.length ? "diverge" : "conforme", atual: fu.length ? `etapas ativas (em minutos): ${mins.join(", ")}` : "nenhuma regra ativa", desejado: `etapas: ${CADENCE_MIN.join(", ")} (minutos)`, comoAplicar: faltam.length ? "conferirRecontatosLisboa (prévia)" : null });
  add({ tema: "Recontato de 1 dia: manhã seguinte, 8h–10h (não 24h corridas)", estado: umDia && umDia.nextDayHour === 8 && umDia.sendWindowStart === 8 && umDia.sendWindowEnd === 10 ? "conforme" : umDia ? "diverge" : "diverge", atual: umDia ? `dia seguinte às ${hh(umDia.nextDayHour)}, janela ${hh(umDia.sendWindowStart)}–${hh(umDia.sendWindowEnd)}` : "sem regra de dia seguinte", desejado: "dia seguinte 08:00, janela 08:00–10:00", comoAplicar: "conferirRecontatosLisboa" });
  const velhas = fu.filter((r) => r.nextDayHour == null && r.afterMinutes === 0 && r.afterDays === 1);
  add({ tema: "Regras antigas de recontato ainda ativas (24h corridas) / sobreposição", estado: velhas.length ? "diverge" : "conforme", atual: velhas.length ? `${velhas.length} regra(s) de 1 dia por 24h corridas ativa(s)` : "nenhuma", desejado: "nenhuma regra antiga sobreposta", comoAplicar: velhas.length ? "conferirRecontatosLisboa (conflitos)" : null });

  // ---- jornadas
  const pros = await prisma.professional.findMany({ where: { clinicId, active: true }, select: { name: true, workStartHour: true, workEndHour: true } });
  const alvo: [string, number, number][] = [["suelen", 12, 21], ["adriana", 12, 21], ["talita", 8, 17]];
  for (const [nome, ini, fim] of alvo) {
    const achadas = pros.filter((p) => first(p.name) === nome);
    if (achadas.length !== 1) { add({ tema: `Jornada de ${nome[0].toUpperCase()}${nome.slice(1)}`, estado: "indeterminado", atual: achadas.length ? `${achadas.length} cadastros com esse nome (ambíguo)` : "profissional não encontrada", desejado: `${hh(ini)}–${hh(fim)} (dias/intervalos: não inventados)`, comoAplicar: "ajustarJornadasLisboa com escolha explícita" }); continue; }
    const p = achadas[0];
    const ok = p.workStartHour === ini && p.workEndHour === fim;
    add({ tema: `Jornada de ${nome[0].toUpperCase()}${nome.slice(1)}`, estado: ok ? "conforme" : "diverge", atual: p.workStartHour == null ? "herda o expediente da clínica (jornada própria NÃO cadastrada)" : `${hh(p.workStartHour)}–${hh(p.workEndHour)}`, desejado: `${hh(ini)}–${hh(fim)}`, comoAplicar: ok ? null : "ajustarJornadasLisboa (prévia: só as horas; dias e intervalos intactos)" });
  }

  // ---- pesquisa / google / indicacao / retomadas
  add({ tema: "Pesquisa: no máximo uma a cada 15 dias por pessoa", estado: "conforme", atual: "trava no código (reminders/nps.ts, janela móvel por pessoa)", desejado: "1 pesquisa / 15 dias / pessoa", comoAplicar: null });
  add({ tema: "Link do Google (nota positiva)", estado: clinic.googleReviewUrl ? "depende_da_clinica" : "depende_da_clinica", atual: clinic.googleReviewUrl ? "link cadastrado (a confirmação de que é o link correto da Lisboa é da clínica)" : "sem link cadastrado: o fluxo NÃO envia link", desejado: "somente o link correto confirmado pela clínica", comoAplicar: "configuração da clínica" });
  const flows = await prisma.resumeFlowConfig.findMany({ where: { clinicId } });
  add({ tema: "Retomadas (avaliação cancelada / sem fechamento) e convite de indicação", estado: "depende_da_clinica", atual: flows.length ? flows.map((f) => `${f.flow}: ${f.enabled ? "ligada" : "desligada"}${f.message ? "" : " (sem texto aprovado)"}`).join("; ") : "sem configuração", desejado: "conforme configuração aprovada pela clínica (texto, janela, modo)", comoAplicar: "painel/rotas de retomada (nascem desligadas)" });
  const parc = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { installmentMax: true, installmentMinCents: true, forbiddenSwaps: true } });
  const trocasOk = /lavieen\s*>\s*carboxi/i.test(parc?.forbiddenSwaps ?? "");
  add({ tema: "Não trocar Lavieen por carboxiterapia (nem LEDterapia por luz pulsada)", estado: trocasOk ? "conforme" : "diverge", atual: parc?.forbiddenSwaps ?? "nenhuma troca proibida cadastrada", desejado: "Lavieen > carboxiterapia; LEDterapia > luz pulsada", comoAplicar: trocasOk ? null : "POST /clinics/lisboa-trocas-proibidas { aprovado: true }" });
  const parcOk = parc?.installmentMax === 10 && parc?.installmentMinCents === 10000;
  add({ tema: "Parcelamento: até 10x sem juros, parcela mínima R$ 100 (limite da oferta só reduz)", estado: parcOk ? "conforme" : "diverge", atual: parc?.installmentMax ? `até ${parc.installmentMax}x, mínimo ${(parc.installmentMinCents ?? 0) / 100}` : "sem política (vale o cadastro de cada procedimento, divisão simples)", desejado: "10x, mínimo R$ 100", comoAplicar: parcOk ? null : "POST /clinics/lisboa-parcelamento { aprovado: true } (prévia em GET)" });
  const cal = await prepararDatasEspeciais(clinicId, { dryRun: true });
  const mudar = cal.linhas.filter((l) => l.acao !== "manter");
  add({ tema: "Calendário 2026 (substitui o anterior; Lavieen 24/11, Remoção 26/11)", estado: mudar.length ? "diverge" : "depende_da_clinica", atual: mudar.length ? mudar.map((l) => `${l.acao}: ${l.name} ${l.startsOn}`).join("; ").slice(0, 400) : "calendário preparado", desejado: "datas do calendário 2026 como rascunho; aprovação só com cadastro completo (validade, condições)", comoAplicar: mudar.length ? "POST /special-dates/prepare { dryRun: false }" : "aprovar cada data em PUT /special-dates/:id" });
  const datas = await prisma.specialDate.count({ where: { clinicId } });
  const aprovadas = await prisma.specialDate.count({ where: { clinicId, status: "aprovada" } });
  add({ tema: "Datas especiais e recesso (sem inventar condição/retorno)", estado: "depende_da_clinica", atual: `${datas} cadastrada(s), ${aprovadas} aprovada(s)`, desejado: "datas do checklist cadastradas como rascunho; aprovadas só com condição/validade informadas pela clínica", comoAplicar: "POST /special-dates/prepare; PUT /special-dates/:id" });

  const resumo: Record<DiffState, number> = { conforme: 0, diverge: 0, depende_da_clinica: 0, indeterminado: 0 };
  for (const l of linhas) resumo[l.estado]++;
  return { somenteLeitura: true, clinica: clinic.name, geradoEm: new Date().toISOString(), linhas, resumo };
}
