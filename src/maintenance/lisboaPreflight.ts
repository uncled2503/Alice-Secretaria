import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../db/client.js";
import { REVISION } from "../version.js";
import { aiExtraEnabled } from "../ai/aiSwitch.js";
import { LISBOA_JORNADAS } from "./lisboaJornadas.js";
import { LISBOA_NAO_OFERECIDOS, LISBOA_OFERTAS_SEM_CADASTRO } from "./lisboaConduta.js";
import { conferirRecontatosLisboa } from "./lisboaRecontatos.js";
import { reviewLinkState } from "../reminders/reviewLink.js";
import { parseNotOffered, bookingModeOf } from "../ai/conduct.js";
import { diagnoseJobs, STATE_LABEL } from "../crm/automationRuns.js";
import { SURVEY_MIN_DAYS } from "../reminders/surveyFlow.js";

// ---------------------------------------------------------------------------
// CONFERENCIA DE PRONTIDAO DA LISBOA (SO LEITURA). Responde, com a evidencia lida AGORA do banco e do ambiente, o que ja esta aplicado, o que e so codigo,
// o que esta preparado mas NAO aplicado e o que depende de decisao ou informacao da clinica. Existe porque "codigo publicado" nao e "configuracao aplicada" nem
// "versao implantada": rodar depois de cada implantacao mostra de forma verificavel o que realmente esta valendo. NUNCA grava nada.
//   ok          - confere com o que o codigo espera
//   pendente    - falta informacao/decisao da clinica, ou a configuracao foi preparada mas nao aplicada
//   divergente  - o banco/ambiente contradiz o que o codigo espera (precisa de atencao)
//   info        - apenas o valor encontrado
// ---------------------------------------------------------------------------

export type PreflightStatus = "ok" | "pendente" | "divergente" | "info";

export interface PreflightItem {
  id: string;
  area: string;
  status: PreflightStatus;
  evidencia: string;
  acao?: string; // o que fazer (e quem decide)
}

export interface PreflightResult {
  geradoEm: Date;
  versaoDoCodigo: string;
  clinicaId: string;
  clinica: string;
  resumo: Record<PreflightStatus, number>;
  itens: PreflightItem[];
}

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ").trim();

// As pastas de migracao que esta versao do codigo traz (a producao roda a partir do diretorio do app, onde `prisma/migrations` existe).
function repoMigrations(): string[] {
  const candidates = [path.join(process.cwd(), "prisma", "migrations"), path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "prisma", "migrations")];
  for (const dir of candidates) {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    } catch { /* tenta a proxima */ }
  }
  return [];
}

export async function preflightLisboa(clinicId: string, now = new Date()): Promise<PreflightResult> {
  const itens: PreflightItem[] = [];
  const add = (id: string, area: string, status: PreflightStatus, evidencia: string, acao?: string) => itens.push({ id, area, status, evidencia, ...(acao ? { acao } : {}) });

  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId } });
  const same = await prisma.clinic.count({ where: { name: clinic.name } });
  add("clinica.unica", "Identidade", same === 1 ? "ok" : "divergente", `${same} clinica(s) com o nome "${clinic.name}"`, same === 1 ? undefined : "As rotinas da Lisboa recusam agir com nome duplicado: resolva a duplicidade.");

  // ---- versao e migracoes
  add("versao.codigo", "Versao", "info", `codigo em execucao: ${REVISION.split(":")[0]} (confira com o /health depois de implantar)`);
  try {
    const rows = (await prisma.$queryRawUnsafe('SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')) as { migration_name: string }[];
    const applied = new Set(rows.map((r) => r.migration_name));
    const dirs = repoMigrations();
    const missing = dirs.filter((d) => !applied.has(d));
    add("versao.migracoes", "Versao", dirs.length === 0 ? "info" : missing.length ? "divergente" : "ok", dirs.length === 0 ? "nao achei a pasta prisma/migrations para comparar" : missing.length ? `faltam aplicar: ${missing.join(", ")}` : `${dirs.length} migracoes do codigo, todas aplicadas`, missing.length ? "Reinicie pelo `npm start` (aplica as pendentes) e confira o /health." : undefined);
  } catch (err) {
    add("versao.migracoes", "Versao", "divergente", `nao consegui ler as migracoes aplicadas: ${String(err).slice(0, 100)}`);
  }

  // ---- jornadas das profissionais
  const pros = await prisma.professional.findMany({ where: { clinicId }, select: { id: true, name: true, active: true, workStartHour: true, workStartMinute: true, workEndHour: true, workEndMinute: true } });
  for (const alvo of LISBOA_JORNADAS) {
    const first = (n: string) => fold(n).replace(/^(dra|dr|doutora|doutor)\s+/, "").split(" ")[0];
    const achadas = pros.filter((p) => p.active && first(p.name) === alvo.primeiroNome);
    const esperado = `${String(alvo.inicio[0]).padStart(2, "0")}:00-${String(alvo.fim[0]).padStart(2, "0")}:00`;
    if (achadas.length !== 1) {
      add(`jornada.${alvo.primeiroNome}`, "Jornadas", "pendente", achadas.length === 0 ? `nenhuma profissional ativa com o primeiro nome ${alvo.primeiroNome}` : `${achadas.length} profissionais ativas com esse primeiro nome (identidade ambigua)`, "Rodar a previa do ajuste de jornadas e escolher a profissional.");
      continue;
    }
    const p = achadas[0];
    const atual = p.workStartHour == null || p.workEndHour == null ? "herda da clinica" : `${String(p.workStartHour).padStart(2, "0")}:${String(p.workStartMinute ?? 0).padStart(2, "0")}-${String(p.workEndHour).padStart(2, "0")}:${String(p.workEndMinute ?? 0).padStart(2, "0")}`;
    const ok = p.workStartHour === alvo.inicio[0] && (p.workStartMinute ?? 0) === alvo.inicio[1] && p.workEndHour === alvo.fim[0] && (p.workEndMinute ?? 0) === alvo.fim[1];
    add(`jornada.${alvo.primeiroNome}`, "Jornadas", ok ? "ok" : "pendente", `${p.name}: ${atual} (esperado ${esperado})`, ok ? undefined : "Preparado, NAO aplicado: rodar o ajuste de jornadas (previa primeiro).");
  }

  // ---- vinculos procedimento x profissional (sem vinculo = sem oferta, quando a agenda e a do Clinica Experts)
  const ce = await prisma.clinicaExpertsAccount.findUnique({ where: { clinicId }, select: { id: true } });
  const procs = await prisma.procedure.findMany({ where: { clinicId, internalOnly: false }, include: { professionals: { select: { id: true, active: true } } } });
  const vendaveis = procs.filter((p) => !/avalia/i.test(p.name));
  const semPro = vendaveis.filter((p) => !p.professionals.some((x) => x.active));
  add("agenda.ce", "Agenda", ce ? "ok" : "pendente", ce ? "Clinica Experts conectado" : "Clinica Experts NAO conectado: a agenda e so a local", ce ? undefined : "Sem CE nao ha conferencia ao vivo nem espelho de reservas.");
  add("agenda.procedimentosSemProfissional", "Agenda", semPro.length === 0 ? "ok" : ce ? "pendente" : "info", `${semPro.length} de ${vendaveis.length} procedimentos sem profissional habilitada${semPro.length ? `: ${semPro.slice(0, 12).map((p) => p.name).join(", ")}${semPro.length > 12 ? "…" : ""}` : ""}`, semPro.length && ce ? "Com a agenda do CE, procedimento sem profissional habilitada NAO recebe oferta de horario (vai para a equipe): vincular quem realiza." : undefined);

  // ---- conduta comercial
  const naoOf = parseNotOffered(clinic.notOfferedServices);
  const faltam = LISBOA_NAO_OFERECIDOS.filter((t) => !naoOf.map(fold).includes(fold(t)));
  add("conduta.naoOferecidos", "Conduta", faltam.length === 0 ? "ok" : "pendente", `servicos nao oferecidos gravados: ${naoOf.join(", ") || "(nenhum)"}`, faltam.length ? "Preparado, NAO aplicado: botao/rota de ajuste de conduta (previa primeiro)." : undefined);
  const aliasLuz = procs.filter((p) => /luz\s+(intensa\s+)?pulsada|\bipl\b/i.test(fold(`${p.aliases ?? ""}`)));
  add("conduta.apelidoLuzPulsada", "Conduta", aliasLuz.length === 0 ? "ok" : "divergente", aliasLuz.length ? `apelido de luz pulsada em: ${aliasLuz.map((p) => p.name).join(", ")}` : "nenhum procedimento tem 'luz pulsada' como apelido", aliasLuz.length ? "O ajuste de conduta limpa o apelido (so ele)." : undefined);
  const ofertas = parseNotOffered(clinic.unmappedOffers);
  const ofertasFaltam = LISBOA_OFERTAS_SEM_CADASTRO.filter((t) => !ofertas.map(fold).includes(fold(t)));
  const jaCadastrada = LISBOA_OFERTAS_SEM_CADASTRO.filter((t) => procs.some((p) => fold(p.name).includes(fold(t))));
  add("conduta.ofertasSemCadastro", "Conduta", jaCadastrada.length ? "info" : ofertasFaltam.length === 0 ? "ok" : "pendente",
    jaCadastrada.length ? `"${jaCadastrada.join(", ")}" JA tem procedimento cadastrado: o cadastro manda e a lista nao tem efeito` : `ofertas anunciadas sem cadastro (vao para a equipe): ${ofertas.join(", ") || "(nenhuma)"}`,
    jaCadastrada.length ? undefined : ofertasFaltam.length ? "Preparado, NAO aplicado: ate la o 'Protocolo do Olhar' pode cair na regra antiga (avaliacao). Aplicar o ajuste de conduta. Depende ainda do cadastro/mapeamento autorizado no CE." : "Depende do cadastro/mapeamento autorizado do procedimento no CE (decisao da clinica).");
  const modos = vendaveis.map((p) => bookingModeOf(p));
  const semRegra = modos.filter((m) => m.mode === "unknown").length;
  add("conduta.modoDeAgendamento", "Conduta", semRegra === 0 ? "ok" : "pendente", `${vendaveis.length - semRegra} de ${vendaveis.length} procedimentos com regra (direto/avaliacao); ${semRegra} SEM regra`, semRegra ? "Decisao da clinica: quais agendam direto e quais exigem avaliacao (campo 'Como este servico agenda')." : undefined);
  add("conduta.modoEstrito", "Conduta", "info", `modo estrito (sem regra vai para a equipe): ${clinic.strictBookingRules ? "LIGADO" : "desligado"}`, clinic.strictBookingRules ? undefined : "Decisao da clinica; nao liga sozinho.");

  // ---- pesquisa, Google, indicacao
  add("pesquisa.ligada", "Pesquisa", "info", `pesquisa ${clinic.npsEnabled ? "LIGADA" : "desligada"}; ${clinic.npsHoursAfter}h depois do atendimento; nota de corte ${clinic.npsThreshold}; no maximo 1 a cada ${SURVEY_MIN_DAYS} dias por pessoa (regra do codigo)`);
  const link = reviewLinkState(clinic);
  add("google.link", "Google", link.send && link.basis === "confirmado" ? "ok" : "pendente", link.send ? (link.basis === "confirmado" ? `link confirmado por ${clinic.googleReviewConfirmedBy ?? "?"} em ${clinic.googleReviewConfirmedAt?.toISOString().slice(0, 10)}; estabelecimento conferido: ${clinic.googleReviewPlace ?? "(nao informado)"}` : "link enviado SO por compatibilidade; o destino nunca foi conferido") : `NAO sera enviado (${link.reason}): ${link.detail}`, link.send && link.basis === "confirmado" ? undefined : "Depende do link correto e da confirmacao do estabelecimento de destino (rota lisboa-google).");
  const ind = await prisma.resumeFlowConfig.findUnique({ where: { clinicId_flow: { clinicId, flow: "indicacao" } } });
  const indOk = !!ind?.enabled && !!ind.message?.trim() && ind.delayMinutes != null;
  add("indicacao.politica", "Indicacao", indOk ? "ok" : "pendente", ind ? `convite ${ind.enabled ? "ligado" : "desligado"}; texto ${ind.message?.trim() ? "definido" : "ausente"}; intervalo ${ind.delayMinutes ?? "nao definido"} min` : "convite nao configurado (desligado)", indOk ? undefined : "Decisao da clinica: se quer o convite, texto aprovado e intervalo. Sem isso nada e enviado.");

  // ---- recontatos e retomadas
  const rec = await conferirRecontatosLisboa(clinicId, { dryRun: true });
  add("recontato.regras", "Recontatos", rec.regras.some((r) => r.ativa) ? "info" : "pendente", rec.regras.length ? rec.regras.map((r) => `${r.ordem}. ${r.nome} [${r.ativa ? "ativa" : "desligada"}] ${r.quando}`).join(" | ") : "nenhuma regra de recontato cadastrada");
  add("recontato.conflitos", "Recontatos", rec.conflitos.length ? "divergente" : "ok", rec.conflitos.length ? rec.conflitos.join(" // ") : "sem colisao entre etapas");
  add("recontato.horarios", "Recontatos", "pendente", "8h do dia seguinte (janela 8h-12h, migracao de 14/10) x 'a partir das 12h': a clinica nao definiu qual vale; nada foi presumido", "Resposta da clinica.");
  add("recontato.recuperacao", "Recontatos", rec.recuperacao.pendente ? "pendente" : "ok", `${rec.recuperacao.descricao} Origem: ${rec.recuperacao.origem}. Primeira rodada: ${rec.previaRecontato.resumo.enviaria} pessoa(s) passariam nas regras de elegibilidade, ${rec.previaRecontato.resumo.aguardando} aguardando, ${rec.previaRecontato.resumo.expira} com etapa expirada (de ${rec.previaRecontato.conversasAvaliadas} conversas avaliadas).`, rec.recuperacao.pendente ? "Decisao da clinica: recuperar ou nao um recontato que venceu e nao saiu (e por quanto tempo). Aplicar com 'recuperacao' na rota lisboa-recontatos, depois de conferir a previa." : undefined);
  for (const [flow, label] of [["avaliacao_cancelada", "avaliacoes canceladas"], ["avaliacao_sem_fechamento", "avaliacoes sem fechamento"]] as const) {
    const c = await prisma.resumeFlowConfig.findUnique({ where: { clinicId_flow: { clinicId, flow } } });
    const pronto = !!c?.enabled && !!c.message?.trim();
    add(`retomada.${flow}`, "Retomadas", pronto ? "ok" : "pendente", c ? `retomada de ${label}: ${c.enabled ? "ligada" : "desligada"}; modo ${c.runMode === "normal" ? "NORMAL (todo o publico elegivel)" : "RESTRITO (contatos de teste)"}; texto ${c.message?.trim() ? "definido" : "ausente"}; dia ${c.weekday ?? "qualquer"}; janela ${c.startHour != null ? `${c.startHour}h-${c.endHour}h` : "horario de atendimento"}` : `retomada de ${label}: sem configuracao`, pronto ? undefined : "Nasce desligada. Dia (a clinica citou as segundas), horario, publico e texto sao decisao da clinica.");
  }
  const cancelsSemOrigem = await prisma.appointment.count({ where: { clinicId, status: "cancelled", cancelledAt: null } });
  add("retomada.cancelamentosAntigos", "Retomadas", "info", `${cancelsSemOrigem} agendamento(s) cancelado(s) ANTES do registro de origem: nao entram em retomada (nao ha como provar quando nem por quem)`);

  // ---- atendimento e ambiente
  add("atendimento.config", "Atendimento", "info", `Alice ${clinic.aliceActive ? "ativa" : "PAUSADA"}; transferencia silenciosa ${clinic.silentHandoff ? "ligada" : "desligada"}; volta se a equipe demorar: ${clinic.humanReturnMinutes} min; aviso interno ${clinic.notifyPhone ? "configurado" : "SEM numero (avisos da equipe nao saem)"}`);
  if (!clinic.notifyPhone) add("atendimento.avisoInterno", "Atendimento", "pendente", "sem numero para os avisos internos (nota baixa, pendencia do Google, retorno nao enviado...)", "Informar o numero interno em Configuracoes.");
  add("ambiente.openai", "Ambiente", process.env.OPENAI_API_KEY?.trim() ? "ok" : "divergente", process.env.OPENAI_API_KEY?.trim() ? "OPENAI_API_KEY presente" : "OPENAI_API_KEY ausente: a Alice nao responde");
  add("ambiente.ia", "Ambiente", "info", `revisao de envio por IA: ${aiExtraEnabled("AI_SEND_REVIEW") ? "ligada" : "desligada"}; memoria do lead: ${aiExtraEnabled("AI_BRIEFING") ? "ligada" : "desligada"}; juiz de recontato: ${process.env.RECONTACT_AI_GATE === "off" ? "DESLIGADO" : "ligado"}; segunda leitura: ${process.env.AI_SECOND_READING === "off" ? "desligada" : "ligada"}; CE falha-aberto: ${process.env.CE_GATE_FAIL_OPEN ? "SIM (escape antigo ligado)" : "nao"}`);

  // ---- execucao dos jobs nas ultimas 24h
  const jobs = await diagnoseJobs(clinicId, new Date(now.getTime() - 24 * 3_600_000), now, now);
  for (const j of jobs) {
    const problema = j.state === "nao_rodou_no_prazo" || j.state === "erro";
    add(`job.${j.job}`, "Jobs", problema ? "divergente" : j.state === "nunca_rodou" ? "info" : "ok", `${j.label}: ${STATE_LABEL[j.state]}; candidatas ${j.candidates}, enviadas ${j.sent}, adiadas ${j.deferred}, barradas ${j.vetoed}, falhas ${j.failed}`, problema ? "Conferir se o servidor esta no ar e se a copia nova assumiu as tarefas." : undefined);
  }

  const resumo: Record<PreflightStatus, number> = { ok: 0, pendente: 0, divergente: 0, info: 0 };
  for (const i of itens) resumo[i.status]++;
  return { geradoEm: now, versaoDoCodigo: REVISION.split(":")[0], clinicaId: clinicId, clinica: clinic.name, resumo, itens };
}

// CLI (somente leitura): `node dist/maintenance/lisboaPreflight.js` imprime a conferencia da clinica "Lisboa Beauty Center".
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  (async () => {
    const clinics = await prisma.clinic.findMany({ where: { name: "Lisboa Beauty Center" }, select: { id: true } });
    if (clinics.length !== 1) throw new Error(clinics.length === 0 ? "Clinica Lisboa nao encontrada." : "Ha mais de uma clinica com o nome da Lisboa.");
    const r = await preflightLisboa(clinics[0].id);
    console.log(`Conferencia da ${r.clinica} - codigo ${r.versaoDoCodigo} - ${r.geradoEm.toISOString()}`);
    console.log(`ok ${r.resumo.ok} | pendente ${r.resumo.pendente} | divergente ${r.resumo.divergente} | info ${r.resumo.info}\n`);
    for (const i of r.itens) console.log(`[${i.status.toUpperCase()}] ${i.area} / ${i.id}\n    ${i.evidencia}${i.acao ? `\n    -> ${i.acao}` : ""}`);
  })()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
