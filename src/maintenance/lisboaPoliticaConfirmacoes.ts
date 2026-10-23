import { prisma } from "../db/client.js";
import { logActivity } from "../crm/activity.js";
import { planejarPolitica, type AplicarOpcoes, type PlanoPolitica, type PoliticaConfirmacoes } from "../reminders/confirmationPolicy.js";

// ---------------------------------------------------------------------------
// REGRA FINAL DE CONFIRMACOES DA LISBOA (pedido de 22/10/2026), como CONFIGURACAO do motor geral (reminders/confirmationPolicy.ts). Fuso America/Sao_Paulo (o da clinica).
// Textos copiados do pedido ([Nome] -> {primeiro_nome}, [HORARIO] -> {hora}). Valores que a clinica NAO informou ficam null e viram PENDENCIA (nada e inventado):
//   - limite noturno / antecedencia minima / intervalo entre etapas (vale o padrao vigente ate a clinica aprovar).
// O fim das janelas de 7h e 17h nao foi informado: reaproveita a DURACAO da janela cadastrada hoje (ex.: 7h-8h, 16h-17h -> 17h-18h) e aparece na previa para aprovacao.
// O texto da confirmacao do dia anterior e o JA aprovado (mantido). O da quarta e o mesmo com "(amanhã)" trocado por "(sábado)"; sem essa marca exata, vira pendencia.
// ---------------------------------------------------------------------------
export const LISBOA_POLITICA_CONFIRMACOES: PoliticaConfirmacoes = {
  nome: "Lisboa — regra final de confirmações",
  versao: "2026-10-22",
  etapas: [
    {
      chave: "lembrete_do_dia", descricao: "Lembrete das 7h dos atendimentos do mesmo dia (sem pedir confirmação; confirmados também recebem)",
      finalidade: "lembrete", diasAntes: 0, diasDaSemana: null, inicio: { h: 7, m: 0 }, fim: "duracao_cadastrada",
      texto: "Bom dia, {primeiro_nome}! 💗 Passando para lembrar do seu atendimento hoje, às {hora}, aqui na Lisboa Beauty Center. ✨ Estamos te esperando!",
    },
    {
      chave: "confirmacao_vespera", descricao: "Confirmação dos atendimentos do dia seguinte, 8h–10h do dia anterior",
      finalidade: "confirmacao", diasAntes: 1, diasDaSemana: null, inicio: { h: 8, m: 0 }, fim: 10, texto: "manter",
    },
    {
      chave: "cobranca_vespera", descricao: "Nova solicitação às 17h só para quem recebeu a confirmação e ainda não confirmou (atendimento do dia seguinte)",
      finalidade: "cobranca", diasAntes: 1, diasDaSemana: null, inicio: { h: 17, m: 0 }, fim: "duracao_cadastrada", depende: "confirmacao_vespera",
      texto: "Oi, {primeiro_nome}! 💗 Ainda não conseguimos confirmar seu atendimento de amanhã, às {hora}. Você consegue me confirmar sua presença, por favor? ✨",
    },
    {
      chave: "sabado_confirmacao_quarta", descricao: "Sábado: confirmação antecipada na quarta, 8h–10h (substitui a confirmação de sexta)",
      finalidade: "confirmacao", diasAntes: 3, diasDaSemana: "6", inicio: { h: 8, m: 0 }, fim: 10,
      texto: { derivarDe: "confirmacao_vespera", trocar: [/\(\s*amanh[ãa]\s*\)/i, "(sábado)"] },
    },
    {
      chave: "sabado_cobranca_sexta", descricao: "Sábado: nova solicitação na sexta às 17h só para quem não confirmou o pedido de quarta",
      finalidade: "cobranca", diasAntes: 1, diasDaSemana: "6", inicio: { h: 17, m: 0 }, fim: "duracao_cadastrada", depende: "sabado_confirmacao_quarta", substituiEtapa: "cobranca_vespera",
      texto: "Oi, {primeiro_nome}! 💗 Ainda não conseguimos confirmar seu atendimento de amanhã, às {hora}. Você consegue me confirmar sua presença, por favor? ✨",
    },
    {
      chave: "sabado_lembrete_sexta", descricao: "Sábado: lembrete na sexta para TODOS os atendimentos ativos de sábado (inclusive confirmados), sem pedir confirmação",
      finalidade: "lembrete", diasAntes: 1, diasDaSemana: "6", inicio: { h: 7, m: 0 }, fim: "duracao_cadastrada", substituiEtapa: "lembrete_do_dia", // 7h da sexta (informado pela clinica em 23/10)
      texto: "Oi, {primeiro_nome}! 💗 Passando para lembrar que amanhã te esperamos na Lisboa, às {hora}. ✨ Até amanhã! 🤎",
    },
    {
      chave: "sabado_lembrete_do_dia", descricao: "Sábado: lembrete das 7h no próprio dia (substitui o lembrete genérico das 7h)",
      finalidade: "lembrete", diasAntes: 0, diasDaSemana: "6", inicio: { h: 7, m: 0 }, fim: "duracao_cadastrada", substituiEtapa: "lembrete_do_dia",
      texto: "Bom dia, {primeiro_nome}! 💗 Hoje é dia do seu atendimento na Lisboa! ✨ Te esperamos às {hora}. 🤎",
    },
  ],
  limites: { lateStartHour: null, lateEndHour: null, minLeadMin: null, stepMinGapMin: null },
};

// PARCELAMENTO DA LISBOA (pedido de 22/10): ate 10x sem juros, parcela minima R$ 100. Previa por padrao; aplicar exige aprovado=true.
export const LISBOA_PARCELAMENTO = { installmentMax: 10, installmentMinCents: 10000 };
export async function parcelamentoLisboa(opts: { dryRun?: boolean; aprovado?: boolean; actorName?: string | null } = {}) {
  const c = await prisma.clinic.findFirst({ where: { name: "Lisboa Beauty Center" }, select: { id: true, installmentMax: true, installmentMinCents: true } });
  if (!c) throw new Error("Clínica Lisboa não encontrada.");
  const atual = { installmentMax: c.installmentMax, installmentMinCents: c.installmentMinCents };
  const conforme = atual.installmentMax === LISBOA_PARCELAMENTO.installmentMax && atual.installmentMinCents === LISBOA_PARCELAMENTO.installmentMinCents;
  if (opts.dryRun === false && !conforme) {
    if (opts.aprovado !== true) throw new Error("Aplicar exige aprovado=true. Nada foi alterado.");
    await prisma.clinic.update({ where: { id: c.id }, data: LISBOA_PARCELAMENTO });
    await logActivity({ clinicId: c.id, type: "automation_updated", area: "automacoes", title: "Política de parcelamento aplicada", description: "Até 10x sem juros, parcela mínima R$ 100 (limite de cada oferta só reduz).", actorName: opts.actorName ?? null }).catch(() => undefined);
    return { atual, proposto: LISBOA_PARCELAMENTO, aplicado: true };
  }
  return { atual, proposto: LISBOA_PARCELAMENTO, aplicado: false, conforme };
}

// TROCAS PROIBIDAS DA LISBOA (pedido de 22/10): Lavieen nao vira carboxiterapia; LEDterapia nao vira luz pulsada (a luz pulsada tambem segue como servico nao oferecido).
export const LISBOA_TROCAS_PROIBIDAS = "Lavieen > carboxiterapia; LEDterapia > luz pulsada";
export async function trocasProibidasLisboa(opts: { dryRun?: boolean; aprovado?: boolean; actorName?: string | null } = {}) {
  const c = await prisma.clinic.findFirst({ where: { name: "Lisboa Beauty Center" }, select: { id: true, forbiddenSwaps: true } });
  if (!c) throw new Error("Clínica Lisboa não encontrada.");
  const conforme = (c.forbiddenSwaps ?? "").trim() === LISBOA_TROCAS_PROIBIDAS;
  if (opts.dryRun === false && !conforme) {
    if (opts.aprovado !== true) throw new Error("Aplicar exige aprovado=true. Nada foi alterado.");
    await prisma.clinic.update({ where: { id: c.id }, data: { forbiddenSwaps: LISBOA_TROCAS_PROIBIDAS } });
    await logActivity({ clinicId: c.id, type: "automation_updated", area: "automacoes", title: "Trocas proibidas aplicadas", description: LISBOA_TROCAS_PROIBIDAS, actorName: opts.actorName ?? null }).catch(() => undefined);
    return { atual: c.forbiddenSwaps, proposto: LISBOA_TROCAS_PROIBIDAS, aplicado: true };
  }
  return { atual: c.forbiddenSwaps, proposto: LISBOA_TROCAS_PROIBIDAS, aplicado: false, conforme };
}

export async function planejarPoliticaLisboa(opts: AplicarOpcoes = {}): Promise<PlanoPolitica> {
  const c = await prisma.clinic.findFirst({ where: { name: "Lisboa Beauty Center" }, select: { id: true } });
  if (!c) throw new Error("Clínica Lisboa não encontrada.");
  return planejarPolitica(c.id, LISBOA_POLITICA_CONFIRMACOES, opts);
}
