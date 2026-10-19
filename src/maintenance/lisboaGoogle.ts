import { prisma } from "../db/client.js";
import { logActivity } from "../crm/activity.js";
import { reviewLinkState, validateReviewUrl, validateReferralText, DEFAULT_REFERRAL_TEXT } from "../reminders/reviewLink.js";

// ---------------------------------------------------------------------------
// LINK DO GOOGLE E CONVITE DE INDICACAO DA LISBOA (pedido de 18/10/2026). Mecanismo restrito a UMA clinica, com PREVIA (dryRun) e idempotente.
// O link correto NAO foi informado: este mecanismo NAO inventa URL, nao usa link de outra clinica e nao confirma nada sozinho. Ele
//   - mostra o que existe hoje (valor cadastrado, se tem formato de link de avaliacao, se alguem confirmou o destino);
//   - procura outros links do Google espalhados em FAQs, mensagens prontas, regras e roteiros (conflitos com o cadastrado);
//   - recebe o link CONFIRMADO (com quem conferiu e o nome do estabelecimento de destino) e so entao libera o envio;
//   - prepara (desligado) o convite de indicacao: texto proposto, intervalo SEM valor (a clinica ainda nao definiu).
// ---------------------------------------------------------------------------

const GOOGLE_URL = /https?:\/\/(?:g\.page|search\.google\.com|maps\.app\.goo\.gl|goo\.gl|g\.co|(?:www\.)?google\.com|maps\.google\.com)\/[^\s)"'<>]*/gi;

export interface GoogleResult {
  dryRun: boolean;
  clinicId: string;
  clinica: string;
  atual: { url: string | null; valida: boolean; problema: string | null; confirmadoEm: Date | null; confirmadoPor: string | null; estabelecimento: string | null; origem: string };
  situacao: string; // em linguagem direta: o que a Alice faz hoje com nota alta
  outrosLinksNoCadastro: { onde: string; id: string; link: string; igualAoCadastrado: boolean }[];
  convite: { existe: boolean; ligado: boolean; temTexto: boolean; intervaloMinutos: number | null; textoProposto: string; pendencias: string[] };
  perguntasPendentes: string[];
  aplicado: { linkConfirmado: boolean; conviteCriado: boolean; conviteLigado: boolean };
}

export interface GoogleOptions {
  dryRun: boolean;
  confirmar?: { url: string; confirmadoPor: string; estabelecimento: string };
  convite?: { ligar?: boolean; mensagem?: string; intervaloMinutos?: number | null; horaInicio?: number | null; horaFim?: number | null; aprovadoPor?: string };
  actorName?: string | null;
}

export async function prepararGoogleLisboa(clinicId: string, opts: GoogleOptions): Promise<GoogleResult> {
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId } });
  const check = validateReviewUrl(clinic.googleReviewUrl);
  const state = reviewLinkState(clinic);

  // links do Google em outros textos
  const found: GoogleResult["outrosLinksNoCadastro"] = [];
  const scan = (onde: string, id: string, text: string | null | undefined) => {
    for (const m of (text ?? "").matchAll(GOOGLE_URL)) found.push({ onde, id, link: m[0], igualAoCadastrado: !!clinic.googleReviewUrl && m[0].replace(/[.,;]+$/, "") === clinic.googleReviewUrl.trim() });
  };
  const [faqs, templates, rules, playbooks] = await Promise.all([
    prisma.clinicFaq.findMany({ where: { clinicId }, select: { id: true, question: true, answer: true } }),
    prisma.messageTemplate.findMany({ where: { clinicId }, select: { id: true, name: true, body: true } }),
    prisma.customRule.findMany({ where: { clinicId, status: "active" }, select: { id: true, instruction: true } }),
    prisma.playbook.findMany({ where: { clinicId }, select: { id: true, name: true, steps: true } }),
  ]);
  for (const x of faqs) scan("FAQ", x.id, `${x.question} ${x.answer}`);
  for (const x of templates) scan("mensagem pronta", x.id, x.body);
  for (const x of rules) scan("regra ativa", x.id, x.instruction);
  for (const x of playbooks) scan("roteiro", x.id, x.steps);
  scan("mensagem da pesquisa", clinic.id, `${clinic.npsMessage ?? ""} ${clinic.npsEvaluationMessage ?? ""}`);

  const cfg = await prisma.resumeFlowConfig.findUnique({ where: { clinicId_flow: { clinicId, flow: "indicacao" } } });
  const pendencias: string[] = [];
  if (cfg?.delayMinutes == null) pendencias.push("intervalo entre o agradecimento e o convite (a clínica ainda não definiu)");
  if (!cfg?.message?.trim()) pendencias.push("texto aprovado do convite");
  pendencias.push("confirmar que a clínica quer o convite de indicação (hoje fica desligado)");

  const aplicado: GoogleResult["aplicado"] = { linkConfirmado: false, conviteCriado: false, conviteLigado: false };
  if (!opts.dryRun) {
    if (opts.confirmar) {
      const c = opts.confirmar;
      const v = validateReviewUrl(c.url);
      if (!v.ok) throw new Error(`Link recusado: ${v.detail}.`);
      if (!c.confirmadoPor?.trim()) throw new Error("Informe quem conferiu o link (confirmadoPor).");
      if (!c.estabelecimento?.trim()) throw new Error("Informe o nome do estabelecimento que o link abre (estabelecimento): validar a URL não prova que ela é da clínica.");
      const same = clinic.googleReviewUrl?.trim() === v.url && !!clinic.googleReviewConfirmedAt && clinic.googleReviewPlace === c.estabelecimento.trim();
      if (!same) {
        await prisma.clinic.update({ where: { id: clinicId }, data: { googleReviewUrl: v.url, googleReviewConfirmedAt: new Date(), googleReviewConfirmedBy: c.confirmadoPor.trim().slice(0, 80), googleReviewPlace: c.estabelecimento.trim().slice(0, 120) } });
        aplicado.linkConfirmado = true;
      }
    }
    // o convite so e criado (desligado) com o texto de exemplo se nao existe; ligar exige texto, intervalo e quem aprovou
    if (!cfg) {
      await prisma.resumeFlowConfig.create({ data: { clinicId, flow: "indicacao", enabled: false, message: null, delayMinutes: null, updatedBy: "preparo automatico (nao aprovado)" } });
      aplicado.conviteCriado = true;
    }
    const inv = opts.convite;
    if (inv?.ligar) {
      const texto = (inv.mensagem ?? cfg?.message ?? "").trim();
      const intervalo = inv.intervaloMinutos ?? cfg?.delayMinutes ?? null;
      if (!inv.aprovadoPor?.trim()) throw new Error("Para ligar o convite informe quem aprovou (aprovadoPor).");
      if (!texto) throw new Error(`Para ligar o convite informe o texto aprovado (sugestão: "${DEFAULT_REFERRAL_TEXT}").`);
      const t = validateReferralText(texto);
      if (!t.ok) throw new Error(`Texto do convite recusado: ${t.problem}.`);
      if (intervalo == null || !Number.isInteger(intervalo) || intervalo < 5 || intervalo > 7 * 24 * 60) throw new Error("Informe o intervalo em minutos (entre 5 e 10080): a clínica ainda não definiu esse tempo.");
      await prisma.resumeFlowConfig.update({
        where: { clinicId_flow: { clinicId, flow: "indicacao" } },
        data: { enabled: true, enabledAt: new Date(), message: texto, delayMinutes: intervalo, ...(inv.horaInicio !== undefined ? { startHour: inv.horaInicio } : {}), ...(inv.horaFim !== undefined ? { endHour: inv.horaFim } : {}), updatedBy: `aprovado por ${inv.aprovadoPor.trim()}` },
      });
      aplicado.conviteLigado = true;
    }
    if (aplicado.linkConfirmado || aplicado.conviteCriado || aplicado.conviteLigado) {
      await logActivity({
        clinicId, type: "briefing_applied", area: "automacoes", title: "Link do Google e convite de indicação preparados",
        description: `Link confirmado: ${aplicado.linkConfirmado ? "sim" : "não alterado"}; convite criado (desligado): ${aplicado.conviteCriado ? "sim" : "não"}; convite ligado: ${aplicado.conviteLigado ? "sim" : "não"}.`,
        actorName: opts.actorName ?? null,
      });
    }
  }

  const fresh = opts.dryRun ? clinic : await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId } });
  const freshState = reviewLinkState(fresh);
  return {
    dryRun: opts.dryRun,
    clinicId,
    clinica: clinic.name,
    atual: {
      url: fresh.googleReviewUrl?.trim() || null,
      valida: validateReviewUrl(fresh.googleReviewUrl).ok,
      problema: fresh.googleReviewUrl?.trim() ? (validateReviewUrl(fresh.googleReviewUrl).detail ?? null) : "nenhum link cadastrado",
      confirmadoEm: fresh.googleReviewConfirmedAt,
      confirmadoPor: fresh.googleReviewConfirmedBy,
      estabelecimento: fresh.googleReviewPlace,
      origem: fresh.googleReviewConfirmedAt ? `confirmado por ${fresh.googleReviewConfirmedBy ?? "?"}${fresh.googleReviewPlace?.trim() ? "" : " (estabelecimento de destino NAO conferido)"}` : fresh.googleReviewLegacyAllowed ? "enviado por compatibilidade com o comportamento anterior; o destino NUNCA foi conferido" : fresh.googleReviewUrl?.trim() ? "valor vindo de migração/seed de 16/10/2026, SEM conferência" : "sem valor",
    },
    situacao: freshState.send ? "Nota alta: a Alice agradece e envia o link confirmado." : `Nota alta: a Alice agradece normalmente e NÃO envia link (${freshState.reason}: ${freshState.detail}). A pendência é registrada para a equipe.`,
    outrosLinksNoCadastro: found,
    convite: { existe: !!cfg || aplicado.conviteCriado, ligado: !!(opts.dryRun ? cfg?.enabled : (await prisma.resumeFlowConfig.findUnique({ where: { clinicId_flow: { clinicId, flow: "indicacao" } } }))?.enabled), temTexto: !!cfg?.message?.trim(), intervaloMinutos: cfg?.delayMinutes ?? null, textoProposto: DEFAULT_REFERRAL_TEXT, pendencias },
    perguntasPendentes: [
      "Qual é o link de avaliação da Lisboa no Google (o que abre a janela de escrever a avaliação do estabelecimento)? Informe também o nome do estabelecimento que ele abre, para conferência.",
      "A clínica quer o convite de indicação depois da nota alta? Com qual texto aprovado e quanto tempo depois do agradecimento?",
      ...(check.ok && !fresh.googleReviewConfirmedAt ? ["O link hoje cadastrado (de 16/10) abre o estabelecimento certo? Se sim, confirme com quem conferiu e o nome do estabelecimento."] : []),
      ...(found.some((f) => !f.igualAoCadastrado) ? ["Há link do Google diferente do cadastrado em textos da clínica (veja outrosLinksNoCadastro): qual vale?"] : []),
    ],
    aplicado,
  };
}
