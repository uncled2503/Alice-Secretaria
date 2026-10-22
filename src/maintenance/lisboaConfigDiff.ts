import { prisma } from "../db/client.js";
import { effectivePurpose } from "../reminders/policy.js";

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

  // ---- confirmacoes / sabado
  const rules = await prisma.reminderRule.findMany({ where: { clinicId, active: true } });
  const mae = rules.filter((r) => !r.parentRuleId);
  const generica = mae.find((r) => effectivePurpose(r) === "confirmacao" && !r.weekdays && r.dayOffset === 1);
  add(generica
    ? { tema: "Confirmação na véspera (8h–9h, por data local)", estado: generica.sendHour === 8 && generica.sendEndHour === 9 ? "conforme" : "diverge", atual: `${hh(generica.sendHour, generica.sendMinute)}–${hh(generica.sendEndHour)} (1 dia antes)`, desejado: "08:00–09:00 do dia anterior", comoAplicar: generica.sendHour === 8 && generica.sendEndHour === 9 ? null : "conferirConfirmacoesLisboa (prévia + aprovação)" }
    : { tema: "Confirmação na véspera (8h–9h, por data local)", estado: "diverge", atual: "nenhuma regra ativa de confirmação para o dia seguinte", desejado: "08:00–09:00 do dia anterior", comoAplicar: "conferirConfirmacoesLisboa (prévia + aprovação)" });
  const quarta = mae.find((r) => effectivePurpose(r) === "confirmacao" && r.weekdays === "6" && r.dayOffset === 3);
  add({ tema: "Sábado: confirmação na quarta (8h–9h)", estado: quarta ? (quarta.sendHour === 8 && quarta.sendEndHour === 9 ? "conforme" : "diverge") : "diverge", atual: quarta ? `${hh(quarta.sendHour)}–${hh(quarta.sendEndHour)}` : "sem regra ativa", desejado: "quarta 08:00–09:00 para atendimentos de sábado", comoAplicar: quarta && quarta.sendHour === 8 && quarta.sendEndHour === 9 ? null : "conferirConfirmacoesLisboa" });
  const sexta = mae.find((r) => effectivePurpose(r) === "lembrete" && r.weekdays === "6" && r.dayOffset === 1);
  add({ tema: "Sábado: lembrete na sexta para TODOS (inclusive confirmados)", estado: sexta ? "conforme" : "diverge", atual: sexta ? `lembrete 1 dia antes, ${hh(sexta.sendHour)}–${hh(sexta.sendEndHour)} (horário vem do cadastro; o checklist não define)` : "sem regra de lembrete de sexta para sábado", desejado: "lembrete na sexta para todos os agendados de sábado, sem a antiga condição 'só não confirmados'", comoAplicar: sexta ? null : "conferirConfirmacoesLisboa" });
  const sabado = mae.find((r) => effectivePurpose(r) === "lembrete" && r.dayOffset === 0 && (!r.weekdays || r.weekdays.includes("6")));
  add({ tema: "Sábado: lembrete do dia, sem novo pedido de confirmação", estado: sabado ? "conforme" : "diverge", atual: sabado ? `lembrete no dia, ${hh(sabado.sendHour)}–${hh(sabado.sendEndHour)}` : "sem lembrete do dia ativo", desejado: "lembrete no próprio sábado, sem pedir confirmação de novo", comoAplicar: sabado ? null : "conferirConfirmacoesLisboa" });
  add({ tema: "Reposição de agendado/remarcado depois da janela (mesmo dia)", estado: "conforme", atual: "comportamento do código (isLateCatchUp; entre 8h e 20h com antecedência mínima)", desejado: "catch-up no mesmo dia, sem acumular etapas", comoAplicar: null });

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
  const datas = await prisma.specialDate.count({ where: { clinicId } });
  const aprovadas = await prisma.specialDate.count({ where: { clinicId, status: "aprovada" } });
  add({ tema: "Datas especiais e recesso (sem inventar condição/retorno)", estado: "depende_da_clinica", atual: `${datas} cadastrada(s), ${aprovadas} aprovada(s)`, desejado: "datas do checklist cadastradas como rascunho; aprovadas só com condição/validade informadas pela clínica", comoAplicar: "POST /special-dates/prepare; PUT /special-dates/:id" });

  const resumo: Record<DiffState, number> = { conforme: 0, diverge: 0, depende_da_clinica: 0, indeterminado: 0 };
  for (const l of linhas) resumo[l.estado]++;
  return { somenteLeitura: true, clinica: clinic.name, geradoEm: new Date().toISOString(), linhas, resumo };
}
