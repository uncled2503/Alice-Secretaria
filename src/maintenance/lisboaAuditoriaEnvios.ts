import { prisma } from "../db/client.js";
import { diagnoseJobs, STATE_LABEL } from "../crm/automationRuns.js";
import { describeRule } from "../crm/followupSchedule.js";
import { previewFollowUpRound } from "../crm/followupPreview.js";
import { isEligibilityRestatement, parseCategory, LEGITIMATE_VETO } from "../crm/vetoReasons.js";
import { maskPhone } from "../crm/leadPhones.js";
import { wallClockInZone, zonedWallClockToUtc } from "../scheduling/time.js";
import { REVISION } from "../version.js";

// ---------------------------------------------------------------------------
// AUDITORIA DOS ENVIOS POR FLUXO (relatos da Lisboa, 19/10/2026: "nao fez recontato apos 4h e nem os demais", "nao enviou todas as confirmacoes e nem o pos", "nem os aniversariantes").
// SOMENTE LEITURA: nao envia nada, nao grava nada, nao consome tentativa, nao reabre etapa. Cruza as REGRAS cadastradas com os REGISTROS reais (controle persistente dos recontatos e das
// confirmacoes, resumo de cada rodada dos jobs, historico de atividades) e classifica cada candidato em UMA categoria:
//   job_nao_executou | nao_selecionada | bloqueio_correto | bloqueio_indevido | falha_do_provedor | aceito_sem_confirmacao | enviado | aguardando | adiado | a_conferir
// "bloqueio_correto" / "bloqueio_indevido" sao CLASSIFICACAO POR REGRA DO CODIGO (categoria legitima do veto x motivo que so descreve o publico da automacao): o que ficar "a_conferir" precisa
// de uma pessoa. Nada aqui declara que todos os envios falharam nem que todos os bloqueios foram corretos. Pessoas aparecem so com primeiro nome e final do telefone.
// ---------------------------------------------------------------------------

export type Categoria = "job_nao_executou" | "nao_selecionada" | "bloqueio_correto" | "bloqueio_indevido" | "falha_do_provedor" | "aceito_sem_confirmacao" | "enviado" | "aguardando" | "adiado" | "a_conferir";

export interface Candidato {
  pessoa: string; // "Maria (...1234)"
  eventoDeOrigem: string;
  venceEm: string | null; // no fuso da clinica
  elegibilidade: string;
  resultado: string; // tentativa / bloqueio / adiamento / falha / incerto / envio registrado, em uma frase
  categoria: Categoria;
}

export interface FluxoAuditoria {
  fluxo: string;
  regras: string[];
  job: { estado: string; ultimaRodada: string | null; rodadasNoDia: number } | null;
  totais: Partial<Record<Categoria, number>>;
  candidatos: Candidato[];
  observacoes: string[];
}

export interface AuditoriaEnvios {
  somenteLeitura: true;
  clinica: string;
  fuso: string;
  dia: string; // AAAA-MM-DD (fuso da clinica)
  geradoEm: string;
  revisaoDoCodigo: string;
  fluxos: FluxoAuditoria[];
  faltaParaConcluir: string[];
}

const first = (n: string | null | undefined) => (n ?? "").trim().split(/\s+/)[0] || "(sem nome)";
const who = (n: string | null | undefined, phone: string | null | undefined) => `${first(n)} (${maskPhone(phone)})`;
const dayOf = (d: Date, tz: string) => { const w = wallClockInZone(d, tz); return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`; };
const stamp = (d: Date | null | undefined, tz: string) => { if (!d) return null; const w = wallClockInZone(d, tz); return `${String(w.day).padStart(2, "0")}/${String(w.month).padStart(2, "0")} ${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`; };

// PURO: um registro do controle persistente -> categoria. `reason` e o motivo gravado (sem conteudo de conversa).
export function classificarRegistro(r: { state: string; layer?: string | null; reason?: string | null; temporary?: boolean }): { categoria: Categoria; frase: string } {
  const reason = r.reason ?? "";
  switch (r.state) {
    case "sent": return { categoria: "enviado", frase: "envio registrado" };
    case "unconfirmed": return { categoria: "aceito_sem_confirmacao", frase: "o provedor nao confirmou a entrega (nao reenviado de proposito)" };
    case "failed": case "failed_permanent": return { categoria: "falha_do_provedor", frase: `falha de envio: ${reason || "sem detalhe"}` };
    case "deferred": return { categoria: "adiado", frase: `adiado (${r.layer ?? "?"}): ${reason || "sem detalhe"}` };
    case "reserved": return { categoria: "a_conferir", frase: "reservado sem desfecho (processo interrompido no envio?)" };
    case "expired": return { categoria: "nao_selecionada", frase: `janela de envio passou sem sair: ${reason}` };
    case "duplicate": return { categoria: "bloqueio_correto", frase: "mensagem identica ja enviada" };
    case "blocked": return { categoria: "bloqueio_correto", frase: `bloqueio de politica: ${reason}` };
    case "skipped": return { categoria: "nao_selecionada", frase: `nao elegivel: ${reason}` };
    case "vetoed": {
      const m = /\[([a-z_]+)\]/.exec(reason);
      const cat = parseCategory(m?.[1] ?? null);
      if (cat && LEGITIMATE_VETO.has(cat) && !isEligibilityRestatement(reason)) return { categoria: "bloqueio_correto", frase: `barrado (${cat}): ${reason}` };
      if (isEligibilityRestatement(reason)) return { categoria: "bloqueio_indevido", frase: `barrado so porque o motivo descreve o publico da automacao: ${reason}` };
      return { categoria: "a_conferir", frase: `barrado, motivo sem categoria reconhecida: ${reason || "(sem motivo)"}` };
    }
    default: return { categoria: "a_conferir", frase: `estado ${r.state}` };
  }
}

function somar(candidatos: Candidato[]): Partial<Record<Categoria, number>> {
  const t: Partial<Record<Categoria, number>> = {};
  for (const c of candidatos) t[c.categoria] = (t[c.categoria] ?? 0) + 1;
  return t;
}

export async function auditarEnviosLisboa(clinicId: string, opts: { dia?: string; agora?: Date } = {}): Promise<AuditoriaEnvios> {
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId } });
  const tz = clinic.timezone || "America/Sao_Paulo";
  const agora = opts.agora ?? new Date();
  const dia = opts.dia ?? dayOf(agora, tz);
  const [y, m, d] = dia.split("-").map(Number);
  const from = zonedWallClockToUtc(tz, y, m, d, 0, 0);
  const to = new Date(from.getTime() + 24 * 3_600_000);
  const jobs = await diagnoseJobs(clinicId, from, to, agora);
  const jobDe = (nome: string) => {
    const j = jobs.find((x) => x.job === nome);
    return j ? { estado: STATE_LABEL[j.state], ultimaRodada: stamp(j.lastRunAt, tz), rodadasNoDia: 0 } : null;
  };
  const rodadas = async (job: string) => prisma.automationRun.count({ where: { job, clinicId, startedAt: { gte: from, lt: to } } });
  const fluxos: FluxoAuditoria[] = [];
  const falta: string[] = [];

  // ---------------------------------------------------------------- RECONTATOS (4 horas e demais etapas)
  {
    const regras = await prisma.followUpRule.findMany({ where: { clinicId }, orderBy: { order: "asc" } });
    const registros = await prisma.followUpDispatch.findMany({ where: { clinicId, flow: "recontato", decidedAt: { gte: from, lt: to } }, orderBy: { decidedAt: "asc" }, take: 400 });
    const pacientes = new Map((await prisma.patient.findMany({ where: { id: { in: [...new Set(registros.map((r) => r.patientId))] } }, select: { id: true, name: true, phone: true } })).map((p) => [p.id, p]));
    const nomeRegra = new Map(regras.map((r) => [r.id, r]));
    const candidatos: Candidato[] = registros.map((r) => {
      const p = pacientes.get(r.patientId);
      const c = classificarRegistro(r);
      const regra = r.ruleId ? nomeRegra.get(r.ruleId) : undefined;
      return {
        pessoa: who(p?.name, p?.phone),
        eventoDeOrigem: `ultima mensagem da pessoa em ${stamp(new Date(Number(r.cycleKey.split(":").pop()) || r.createdAt.getTime()), tz) ?? "?"} (etapa ${r.step}${regra ? ` - ${regra.name}` : ""})`,
        venceEm: stamp(r.dueAt, tz),
        elegibilidade: r.layer === "elegibilidade" || r.layer === "janela" || r.layer === "expediente" ? `${r.layer}: ${r.reason ?? ""}` : "passou pelas travas de elegibilidade",
        resultado: c.frase,
        categoria: c.categoria,
      };
    });
    // quem seria selecionado AGORA (previa somente leitura): separa "ainda nao venceu" de "excluida" e mostra o motivo por pessoa
    const previa = await previewFollowUpRound(clinicId, agora);
    for (const row of previa.pessoas.filter((x) => x.decisao !== "enviaria")) {
      candidatos.push({
        pessoa: row.nome, eventoDeOrigem: `ultima mensagem da pessoa: ${row.ultimaMensagemDaPessoa}`, venceEm: row.vence, elegibilidade: `${row.decisao}: ${row.motivo}`,
        resultado: row.controleExistente ? `controle existente: ${row.controleExistente}` : "sem tentativa registrada (agora)",
        categoria: row.decisao === "aguardando" ? "aguardando" : "nao_selecionada",
      });
    }
    const obs: string[] = [];
    const quatroH = regras.find((r) => r.afterMinutes === 240 && r.nextDayHour == null);
    if (!quatroH) obs.push("NAO existe regra de 4 horas cadastrada (afterMinutes=240) nesta clinica.");
    else if (!quatroH.active) obs.push(`A regra de 4 horas ("${quatroH.name}", etapa ${quatroH.order}) esta DESLIGADA no cadastro: enquanto estiver desligada, a cascata pula a etapa e NADA sai as 4 horas. Ligar e decisao da clinica.`);
    else obs.push(`A regra de 4 horas ("${quatroH.name}", etapa ${quatroH.order}) esta LIGADA. Conta a partir da ULTIMA MENSAGEM DA PESSOA (silencio corrido de 4 h); janela comercial do cadastro: ${quatroH.sendWindowStart != null ? `${quatroH.sendWindowStart}h-${quatroH.sendWindowEnd}h` : "expediente da clinica"}.`);
    const desligadas = regras.filter((r) => !r.active).map((r) => `${r.order} (${r.name})`);
    if (desligadas.length) obs.push(`Etapas desligadas no cadastro: ${desligadas.join(", ")}.`);
    obs.push("Uma nova mensagem da pessoa REINICIA a contagem (o gatilho e sempre a ultima mensagem dela); enquanto ela falou por ultimo, nada sai (a bola esta com a clinica).");
    obs.push("Nao recebe recontato: conversa com atendimento humano, retorno combinado futuro, reserva vigente, pediu para sair, contato nao comercial, assunto encerrado ('ok', 'obrigada').");
    obs.push("Ambiguidade: a regra de 1 dia e 'dia seguinte as 8h (janela 8h-12h)', diferente de 24 h corridas; nao confundir com a de 4 h. Os horarios 8h/12h/segunda-feira citados nos relatos nao pertencem a etapa de 4 h.");
    fluxos.push({
      fluxo: "Recontato (4 horas e demais etapas)",
      regras: regras.map((r) => `etapa ${r.order} - ${r.name}: ${r.active ? "LIGADA" : "DESLIGADA"} - ${describeRule(r)}`),
      job: { ...(jobDe("recontato") ?? { estado: "sem registro", ultimaRodada: null, rodadasNoDia: 0 }), rodadasNoDia: await rodadas("recontato") },
      totais: somar(candidatos), candidatos, observacoes: obs,
    });
  }

  // ---------------------------------------------------------------- CONFIRMACOES E LEMBRETES
  {
    const regras = await prisma.reminderRule.findMany({ where: { clinicId }, orderBy: { createdAt: "asc" } });
    const registros = await prisma.reminderDispatch.findMany({ where: { clinicId, OR: [{ sendDay: dia }, { updatedAt: { gte: from, lt: to } }] }, orderBy: { updatedAt: "asc" }, take: 400 });
    const pacientes = new Map((await prisma.patient.findMany({ where: { id: { in: [...new Set(registros.map((r) => r.patientId))] } }, select: { id: true, name: true, phone: true } })).map((p) => [p.id, p]));
    const candidatos: Candidato[] = registros.map((r) => {
      const p = pacientes.get(r.patientId);
      const c = classificarRegistro({ state: r.state, reason: r.detail });
      return { pessoa: who(p?.name, p?.phone), eventoDeOrigem: `reserva ${r.bookingKey.startsWith("ce:") ? "do Clinica Experts" : "local"} para ${stamp(r.startsAt, tz)}`, venceEm: null, elegibilidade: `tipo ${r.kind}`, resultado: c.frase, categoria: c.categoria };
    });
    // reservas confirmadas do dia seguinte SEM nenhum registro de controle: nao foram selecionadas (ou o job nao rodou)
    const amanhaDe = new Date(to.getTime()); const amanhaAte = new Date(amanhaDe.getTime() + 24 * 3_600_000);
    const reservas = await prisma.appointment.findMany({ where: { clinicId, status: "confirmed", scheduledAt: { gte: amanhaDe, lt: amanhaAte } }, include: { patient: { select: { name: true, phone: true, optedOut: true } }, reminders: { select: { id: true } } }, take: 200 });
    const comRegistro = new Set(registros.map((r) => r.appointmentId));
    for (const a of reservas) {
      if (comRegistro.has(a.id) || a.reminders.length > 0) continue;
      candidatos.push({
        pessoa: who(a.patient.name, a.patient.phone), eventoDeOrigem: `reserva confirmada para ${stamp(a.scheduledAt, tz)}`, venceEm: null,
        elegibilidade: a.patient.optedOut ? "pediu para nao receber mensagens" : "elegivel pela agenda",
        resultado: "sem nenhum registro de lembrete/confirmacao para esta reserva",
        categoria: a.patient.optedOut ? "bloqueio_correto" : (jobs.find((j) => j.job === "lembretes")?.state === "nunca_rodou" || jobs.find((j) => j.job === "lembretes")?.state === "nao_rodou_no_prazo") ? "job_nao_executou" : "a_conferir",
      });
    }
    fluxos.push({
      fluxo: "Confirmacoes e lembretes",
      regras: regras.map((r) => `${r.active ? "LIGADA" : "DESLIGADA"}: ${r.hoursBefore}h antes${r.dayOffset ? ` / dia -${r.dayOffset}` : ""}${r.parentRuleId ? " (cobranca de quem nao confirmou)" : ""}`),
      job: { ...(jobDe("lembretes") ?? { estado: "sem registro", ultimaRodada: null, rodadasNoDia: 0 }), rodadasNoDia: await rodadas("lembretes") },
      totais: somar(candidatos), candidatos,
      observacoes: [
        "Uma confirmacao por pessoa por dia (a do primeiro horario); reserva cancelada/remarcada no Clinica Experts nao recebe o lembrete do horario velho; CE inconclusivo adia sem cancelar.",
        "Mensagem ligada a reserva NAO e pausada pela conversa com a equipe (ver politica de pausa humana); so nao repete o que a equipe ja mandou.",
        "Antes de 19/10 este job nao gravava resumo de rodada: dias anteriores sem 'rodadas' NAO provam que o job nao rodou.",
      ],
    });
  }

  // ---------------------------------------------------------------- POS-PROCEDIMENTO (acompanhamento depois de atendimento concluido)
  {
    const regras = await prisma.postProcedureRule.findMany({ where: { clinicId } });
    const candidatos: Candidato[] = [];
    for (const regra of regras) {
      const horas = regra.intervalUnit === "hours" ? regra.intervalValue : regra.intervalValue * 24;
      const filtro = regra.procedureIds.split(",").filter(Boolean);
      const desde = new Date(agora.getTime() - (horas + 72) * 3_600_000);
      const atend = await prisma.appointment.findMany({
        where: { clinicId, scheduledAt: { gte: desde, lte: agora }, ...(filtro.length ? { procedureId: { in: filtro } } : {}) },
        include: { patient: { select: { name: true, phone: true, optedOut: true } }, procedure: { select: { name: true, durationMin: true } }, postProcedureSent: { where: { ruleId: regra.id }, select: { sentAt: true } } },
        orderBy: { scheduledAt: "desc" }, take: 150,
      });
      for (const a of atend) {
        const vence = new Date(a.scheduledAt.getTime() + (regra.intervalUnit === "hours" ? a.procedure.durationMin * 60_000 : 0) + horas * 3_600_000);
        const base = { pessoa: who(a.patient.name, a.patient.phone), eventoDeOrigem: `${a.procedure.name} em ${stamp(a.scheduledAt, tz)} (status ${a.status})`, venceEm: stamp(vence, tz) };
        if (a.postProcedureSent.length) { candidatos.push({ ...base, elegibilidade: "elegivel", resultado: `reserva/registro de pos em ${stamp(a.postProcedureSent[0].sentAt, tz)} (a reserva e gravada ANTES do envio: nao prova entrega; confira o chat)`, categoria: "enviado" }); continue; }
        let motivo: string | null = null; let cat: Categoria = "nao_selecionada";
        if (!regra.active) motivo = "regra de pos DESLIGADA";
        else if (a.status === "cancelled" || a.status === "no_show") { motivo = `atendimento ${a.status}: nao houve atendimento`; cat = "bloqueio_correto"; }
        else if (regra.onlyIfCompleted && a.status !== "completed") motivo = `o atendimento NAO esta marcado como concluido (status=${a.status}) e a regra so vale depois de concluido: enquanto ninguem marcar/sincronizar como concluido, o pos nunca e selecionado`;
        else if (/avalia/i.test(a.procedure.name) && !filtro.includes(a.procedureId)) { motivo = "avaliacao nao recebe pos-procedimento (decisao da clinica)"; cat = "bloqueio_correto"; }
        else if (a.patient.optedOut) { motivo = "pediu para nao receber mensagens"; cat = "bloqueio_correto"; }
        else if (vence.getTime() > agora.getTime()) { motivo = "ainda nao venceu"; cat = "aguardando"; }
        else if (agora.getTime() - vence.getTime() > 72 * 3_600_000) motivo = "venceu ha mais de 3 dias (limite contra disparo retroativo em massa)";
        candidatos.push({ ...base, elegibilidade: motivo ?? "elegivel", resultado: motivo ? "nao selecionada" : "elegivel e SEM registro de pos: job nao rodou, ou ainda nao chegou a vez (teto por rodada)", categoria: motivo ? cat : (jobs.find((j) => j.job === "pos-procedimento")?.state === "nao_rodou_no_prazo" ? "job_nao_executou" : "a_conferir") });
      }
    }
    fluxos.push({
      fluxo: "Pos-procedimento (acompanhamento depois do atendimento concluido)",
      regras: regras.map((r) => `${r.active ? "LIGADA" : "DESLIGADA"} - ${r.intervalValue} ${r.intervalUnit === "hours" ? "hora(s)" : "dia(s)"} depois${r.onlyIfCompleted ? ", SO se o atendimento estiver concluido" : ""}`),
      job: { ...(jobDe("pos-procedimento") ?? { estado: "sem registro", ultimaRodada: null, rodadasNoDia: 0 }), rodadasNoDia: await rodadas("pos-procedimento") },
      totais: somar(candidatos), candidatos,
      observacoes: [
        "'Pos' pode significar tres fluxos DIFERENTES: (1) acompanhamento pos-procedimento (este), (2) pesquisa de satisfacao (NPS, job proprio, 1 a cada 15 dias por pessoa), (3) preparo PRE-procedimento (nao e pos). Confirme com a clinica qual deles ela esperava.",
        "A linha de controle do pos e criada ANTES do envio e nao tem estado: barrado pela revisao / plano / identica tambem fica gravado (o resumo da rodada, a partir de 19/10, diz qual foi o desfecho).",
      ],
    });
  }

  // ---------------------------------------------------------------- ANIVERSARIOS
  {
    const regras = await prisma.birthdayRule.findMany({ where: { clinicId } });
    const w = wallClockInZone(agora, tz);
    const pacientes = await prisma.patient.findMany({ where: { clinicId, birthDate: { not: null } }, select: { id: true, name: true, phone: true, birthDate: true, optedOut: true, birthdaySent: { select: { ruleId: true, year: true, sentAt: true } } } });
    const hoje = pacientes.filter((p) => p.birthDate!.getUTCMonth() + 1 === m && p.birthDate!.getUTCDate() === d);
    const barradas = await prisma.activityLog.findMany({ where: { clinicId, type: "message_blocked_ai", createdAt: { gte: from, lt: to }, description: { contains: "aniversario" } }, select: { patientId: true, description: true } });
    const candidatos: Candidato[] = hoje.map((p) => {
      const enviado = p.birthdaySent.find((b) => b.year === y);
      const barr = barradas.find((b) => b.patientId === p.id);
      const base = { pessoa: who(p.name, p.phone), eventoDeOrigem: `aniversario em ${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")} (data cadastrada, dia da clinica)`, venceEm: regras[0] ? `${regras[0].sendHour}h` : null };
      if (p.optedOut) return { ...base, elegibilidade: "pediu para nao receber mensagens", resultado: "nao enviar", categoria: "bloqueio_correto" as Categoria };
      if (enviado) return { ...base, elegibilidade: "elegivel", resultado: `registro de aniversario em ${stamp(enviado.sentAt, tz)}${barr ? " (ATENCAO: houve veto da revisao no mesmo dia e o registro antigo era gravado mesmo sem envio)" : ""}`, categoria: barr ? ("a_conferir" as Categoria) : ("enviado" as Categoria) };
      if (barr) { const c = classificarRegistro({ state: "vetoed", reason: barr.description ?? "" }); return { ...base, elegibilidade: "elegivel", resultado: c.frase, categoria: c.categoria }; }
      const ativa = regras.some((r) => r.active);
      return { ...base, elegibilidade: ativa ? "elegivel" : "regra de aniversario DESLIGADA", resultado: "sem registro de envio nem de bloqueio", categoria: !ativa ? "nao_selecionada" : jobs.find((j) => j.job === "aniversario")?.state === "nunca_rodou" ? "job_nao_executou" : "a_conferir" };
    });
    fluxos.push({
      fluxo: "Aniversarios",
      regras: regras.map((r) => `${r.active ? "LIGADA" : "DESLIGADA"} - a partir das ${r.sendHour}h (ate ${20}h do mesmo dia, fuso ${tz})`),
      job: { ...(jobDe("aniversario") ?? { estado: "sem registro", ultimaRodada: null, rodadasNoDia: 0 }), rodadasNoDia: await rodadas("aniversario") },
      totais: somar(candidatos), candidatos,
      observacoes: [
        `Pacientes com data de nascimento cadastrada: ${pacientes.length}. Hoje (${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}) fazem aniversario: ${hoje.length}. Quem nao tem data cadastrada nunca entra: nao ha como o job saber.`,
        "Antes de 19/10 o job so agia na hora exata do cadastro e gravava 'ja enviado' mesmo quando a mensagem foi barrada ou falhou; dias anteriores nao se recuperam (parabens atrasado perde a pertinencia).",
        `Hora local da clinica agora: ${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}.`,
      ],
    });
  }

  falta.push(
    "Esta auditoria precisa rodar contra o banco de PRODUCAO (somente leitura): sem isso, as categorias acima descrevem as regras e o que o codigo faria, nao o que aconteceu em 19/10.",
    "Dias anteriores a 19/10 nao tem resumo de rodada para lembretes, pos e aniversarios (esses jobs nao gravavam): 'job nao executou' so pode ser afirmado a partir de agora; para o passado use os registros de controle e os logs do servidor (EasyPanel).",
    "Prova de entrega no WhatsApp so existe no proprio aparelho/provedor: 'enviado' aqui significa aceito pelo provedor e registrado.",
  );
  return { somenteLeitura: true, clinica: clinic.name, fuso: tz, dia, geradoEm: stamp(agora, tz) ?? "", revisaoDoCodigo: REVISION.split(":")[0], fluxos, faltaParaConcluir: falta };
}

// CLI (somente leitura):  node dist/maintenance/lisboaAuditoriaEnvios.js [AAAA-MM-DD] [nome da clinica]
if (process.argv[1] && /lisboaAuditoriaEnvios\.js$/.test(process.argv[1].replace(/\\/g, "/"))) {
  const dia = /^\d{4}-\d{2}-\d{2}$/.test(process.argv[2] ?? "") ? process.argv[2] : undefined;
  const nome = process.argv[dia ? 3 : 2] ?? "Lisboa Beauty Center";
  prisma.clinic.findFirst({ where: { name: nome } })
    .then(async (c) => {
      if (!c) throw new Error(`Clinica "${nome}" nao encontrada.`);
      console.log(JSON.stringify(await auditarEnviosLisboa(c.id, { dia }), null, 2));
    })
    .catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
