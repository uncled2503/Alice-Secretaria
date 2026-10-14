import { prisma } from "../db/client.js";
import { DEFAULT_RULES, RETIRED_DEFAULT_RULES } from "../ai/rules.js";

// Limpeza das regras da Lisboa que se contradizem (analise de 14/10/2026, aprovada pela Aline linha a linha).
// As regras reais estao no banco (CustomRule); o seed nao apaga nada. Aqui cada regra e achada pelo TEXTO EXATO que o
// seed gravou: se alguem editou a regra no painel, o texto nao bate e ela nao e tocada.
//  - remove  : apaga a regra.
//  - rewrite : troca o texto (mantem o registro).
//  - add     : cria regra nova (uma vez; marcador proprio).
// approved=false aparece na previa mas NAO e aplicado (espera o ok da clinica).
// "line" e a linha em seedLisboa.ts ANTES desta limpeza.
export const CLEAN_MARKER = "seed:lisboa-limpeza-conflitos";

// A regra padrao de identidade NOVA e a que esta em DEFAULT_RULES (a antiga fica em RETIRED_DEFAULT_RULES).
const NEW_IDENTITY_DEFAULT = DEFAULT_RULES.find((r) => r.instruction.startsWith("Nunca se apresente por conta propria como IA"))!.instruction;

const OLD: Record<number, { category: string; text: string }> = {
  467: { category: "tom_de_voz", text: "A Alice se identifica como assistente virtual da Lisboa Beauty Center. Se perguntarem se é robô, responda com naturalidade que é a Alice, assistente virtual da clínica, que ajuda com informações, horários e agendamentos e encaminha para a equipe quando necessário." },
  468: { category: "tom_de_voz", text: "Atendimento próximo, comercial e consultivo: acolha, entenda a queixa e conduza para avaliação ou agendamento sem pressionar. Se o paciente estiver indeciso, ofereça a avaliação estética gratuita; se já souber o procedimento, explique e conduza ao agendamento." },
  470: { category: "tom_de_voz", text: "Em toda conversa: acolha, entenda a queixa, registre as informações relevantes, ofereça avaliação quando houver dúvida e conduza para o próximo passo. Transfira casos clínicos, reclamações, negociações especiais e assuntos sensíveis." },
  485: { category: "pagamento", text: "Pode informar preço pelo WhatsApp quando o valor estiver cadastrado e vigente. Para valores variáveis, informe só a regra cadastrada ou encaminhe para a avaliação. Nunca invente preço." },
  486: { category: "pagamento", text: "Desconto, brinde ou condição especial: somente campanhas previamente autorizadas e vigentes. Fora disso, diga que vai verificar com a equipe e transfira." },
  492: { category: "pagamento", text: "Quando o paciente achar caro, pedir desconto ou comparar com outro lugar: acolha, explique que o valor envolve profissional, produto/tecnologia, protocolo e acompanhamento, reforce a avaliação personalizada e verifique se há condição vigente. Nunca prometa desconto." },
  509: { category: "chamar_equipe", text: "Se não souber ou não tiver informação segura, admita e encaminhe: 'Essa é uma orientação que preciso confirmar com nossa equipe para te passar corretamente.'" },
  513: { category: "chamar_equipe", text: "Depois da transferência, fique em silêncio enquanto a equipe conduz o caso e só retome quando a conversa for encerrada ou liberada." },
  524: { category: "tom_de_voz", text: "Equipe da Lisboa: SÓ Sabrina e Amanda são 'Dra.' (biomédicas). Talita, Adriana e Suelen são esteticistas: chame apenas pelo primeiro nome, SEM 'Dra.'. Nunca chame ninguém de 'Dra.' por conta própria." },
  537: { category: "tom_de_voz", text: "Toda resposta termina com UMA pergunta que avança a conversa (qual a dúvida, qual a queixa, qual dia e turno), até o paciente chegar ao agendamento. Nunca termine só com 'qualquer dúvida estou aqui' ou 'é só me chamar'." },
  538: { category: "tom_de_voz", text: "Seja comercial de verdade, não apenas receptiva: entenda o PORQUÊ do paciente (a queixa, o que ele quer mudar) e qual é a DÚVIDA dele, responda e continue conduzindo até o agendamento. Aceitar passivamente o que o paciente diz é erro." },
  539: { category: "tom_de_voz", text: "Se o paciente disser 'vou pensar', 'entendi', 'ok' ou 'depois eu vejo', NÃO aceite nem se despeça. Acolha em uma frase, pergunte o que ficou pesando (valor, dúvida, resultado, tempo, medo), responda e proponha a avaliação gratuita perguntando o melhor dia e turno. Só encerre se ele recusar com clareza repetidamente ou pedir para parar." },
  540: { category: "pagamento", text: "Depois de informar valores, não pare: pergunte qual região ou resultado o paciente quer e conduza para a avaliação gratuita, perguntando o melhor dia e turno." },
  547: { category: "agendamento", text: "Como a equipe é quem agenda, siga perguntando até obter o procedimento de interesse e o melhor dia e turno; com isso em mãos, escreva a frase de transferência e passe para a equipe marcar. Não deixe a conversa esfriar antes disso." },
  552: { category: "pagamento", text: "NUNCA informe valores, faixas de preço, parcelas ou formas de pagamento de procedimentos, nem diga que 'vai verificar a condição vigente'. Diga que o investimento é apresentado pela equipe na avaliação gratuita (personalizada), reforce que a avaliação não tem custo e pergunte o melhor dia e turno. A chave Pix só é enviada quando houver sinal a pagar." },
  553: { category: "agendamento", text: "Antes de passar para a equipe agendar, confirme o NOME COMPLETO do paciente: se você não tiver o nome completo (só o primeiro nome, ou nome desconhecido), pergunte 'Pode me informar seu nome completo para o agendamento?'. Só transfira depois de ter nome completo, procedimento de interesse e dia/turno de preferência." },
  581: { category: "pagamento", text: "NUNCA informe valores, faixas de preço, parcelas ou formas de pagamento de procedimentos. Se perguntarem 'quanto custa' ou 'a partir de quanto', diga com naturalidade que o valor depende do protocolo de cada pessoa e que a equipe apresenta o investimento. NÃO use a avaliação como resposta padrão: pergunte o que ela quer melhorar ou saber e responda as dúvidas sobre o procedimento." },
};

export interface RuleChange {
  line: number | null; // null = nao tem linha no seedLisboa (regra nova, regra padrao ou roteiro)
  marker?: string; // so em action=add: marcador proprio da regra nova (padrao CLEAN_MARKER)
  target?: "regra" | "regra padrão" | "roteiro"; // o que e (padrao: regra)
  name?: string; // roteiro: nome
  newTrigger?: string; // roteiro: novo "quando usar"
  action: "remove" | "rewrite" | "add" | "disable";
  approved: boolean;
  category: string;
  oldText: string | null;
  newText: string | null;
  note: string;
}

const c = (line: number, action: "remove" | "rewrite", approved: boolean, note: string, newText: string | null = null): RuleChange => ({
  line, action, approved, category: OLD[line].category, oldText: OLD[line].text, newText, note,
});

export const NEW_BOOKING_NAME_RULE =
  "Se não localizar o cadastro do paciente, peça o nome completo antes de concluir o agendamento. Depois de agendar, a equipe recebe um aviso interno com nome, procedimento, data e horário para conferir.";

export const EVAL_TODAY_TOMORROW_MARKER = "seed:lisboa-avaliacao-hoje-amanha";
export const EVAL_TODAY_TOMORROW_RULE =
  "Agendamento de avaliação: sempre ofereça a possibilidade de a pessoa vir hoje (se ainda houver horário no expediente) ou amanhã. Consulte esses dois dias antes de qualquer outro e ofereça de 2 a 3 horários entre eles; só ofereça outros dias se não houver vaga ou se a pessoa preferir.";

// "Vou pensar" (Aline, 14/10/2026): acolhe, entende o motivo se fizer sentido, NAO empurra avaliacao e combina QUANDO retomar o contato.
export const CONSOLIDATED_CONDUCTION_RULE =
  "Atendimento próximo, comercial e consultivo: acolha, entenda a queixa e conduza a conversa para um próximo passo, mas sem pressionar. A avaliação pode ser sugerida no máximo uma vez no mesmo contexto. Se a pessoa disser que vai pensar, acolha e, se fizer sentido, entenda o motivo da dúvida, sem empurrar avaliação. Proponha um momento para retomar o contato e, quando ela disser a data e o horário, registre com schedule_recontact para a Alice retomar exatamente nesse momento.";

export const TRANSFER_RULE =
  "Quando a dúvida exigir atendimento humano, não invente resposta: acione a transferência e fique em silêncio, sem escrever \"vou verificar com a equipe\". Quem retoma a conversa é a equipe.";

const OLD_THINK_STEPS = [
  "NÃO se despeça nem diga 'fique à vontade'. Acolha em uma frase curta.",
  "Pergunte com interesse o que ficou pesando (valor, dúvida sobre o procedimento, resultado, tempo, medo) e qual é a dúvida dela.",
  "Responda à dúvida com o que está cadastrado e conecte com a queixa que ela contou.",
  "Proponha a avaliação estética gratuita como forma sem compromisso de tirar as dúvidas.",
  "Termine perguntando qual dia e turno ficam melhores para a equipe agendar.",
  "Só encerre se ela recusar com clareza mais de uma vez ou pedir para parar.",
].join("\n");

export const NEW_THINK_STEPS = [
  "NÃO se despeça nem responda só 'ok' ou 'fique à vontade'. Acolha em uma frase curta.",
  "Se fizer sentido, entenda com UMA pergunta o que ficou pesando (valor, dúvida sobre o procedimento, resultado, tempo, medo), sem pressionar.",
  "Responda à dúvida com o que está cadastrado.",
  "NÃO proponha avaliação nem peça dia e turno agora.",
  "Proponha um momento para retomar o contato (ex.: 'posso te chamar amanhã?'). Quando ela disser a data e o horário, use schedule_recontact para a Alice retomar exatamente nesse momento.",
  "Só encerre se ela recusar com clareza mais de uma vez ou pedir para parar.",
].join("\n");

const OLD_OBJECTION_TRIGGER = "Paciente diz que está caro, vai pensar, mora longe, não tem tempo ou compara com outro lugar.";

const DEFAULT_TWO_OPTIONS = "Ao oferecer horarios, ofereca no maximo DUAS opcoes concretas por vez. Se nenhuma servir, ofereca mais duas. Nunca liste todos os horarios de uma vez.";

export const RULE_CHANGES: RuleChange[] = [
  // 1. Valores
  c(485, "rewrite", true, "Alice pode informar preço cadastrado (regra atual da Lisboa).",
    "Valores: se o lead veio de anúncio, informe o valor ou a condição vigente daquele anúncio. Para os demais contatos, informe apenas valores cadastrados e vigentes. Nunca invente preço, desconto ou condição. Em caso de dúvida, negociação fora do cadastrado ou condição indisponível, encaminhe para a equipe."),
  c(492, "rewrite", true, "Achou caro: só forma de pagamento ou condição já cadastrada; nunca criar desconto.",
    "Quando o paciente achar caro, pedir desconto ou comparar com outro lugar: acolha e explique que o valor envolve profissional, produto/tecnologia, protocolo e acompanhamento. Se houver, ofereça apenas as formas de pagamento ou a condição vigente já cadastrada. Nunca crie nem prometa desconto; negociação fora do cadastrado vai para a equipe."),
  c(540, "rewrite", true, "Depois do valor, continua a conversa (uma pergunta), sem encerrar passivo nem empurrar avaliação.",
    "Depois de informar o valor, continue a conversa naturalmente com UMA pergunta sobre o interesse da pessoa (qual região ou resultado ela quer, ou se ficou alguma dúvida). Não encerre de forma passiva, e não peça dia e turno nem repita a oferta de avaliação a cada resposta."),
  c(552, "remove", true, "Duplicata de 581 (\"nunca informe valores\", desatualizada)."),
  c(581, "remove", true, "\"Nunca informe valores\" está desatualizado."),
  c(486, "rewrite", true, "Aprovada pela Aline (14/10): mandava dizer \"vai verificar com a equipe\", que conflita com o silêncio ao transferir.",
    "Desconto, brinde ou condição especial: somente campanhas previamente autorizadas e vigentes. Fora disso, não prometa nada e transfira para a equipe, sem escrever que vai verificar."),

  // 2. Agendamento
  c(547, "remove", true, "A Alice agenda direto no Clínica Experts."),
  c(553, "remove", true, "Coberta pelas linhas 495/497 (coleta do nome completo) e pela regra nova abaixo."),
  { line: null, action: "add", approved: true, category: "agendamento", oldText: null, newText: NEW_BOOKING_NAME_RULE,
    note: "Preserva: sem cadastro, pede nome completo antes de concluir; depois de agendar, aviso interno à equipe." },
  { line: null, action: "add", approved: true, category: "agendamento", marker: EVAL_TODAY_TOMORROW_MARKER, oldText: null, newText: EVAL_TODAY_TOMORROW_RULE,
    note: "Pedido da Aline (14/10): avaliação sempre oferece vir hoje ou amanhã." },
  { line: null, target: "regra padrão", action: "disable", approved: true, category: "agendamento", oldText: DEFAULT_TWO_OPTIONS, newText: null,
    note: "Aline (14/10): pode ser 3 horários por vez. Desativada (não apagada, para o sistema não recriar)." },

  // 3. Condução / pressão / "vou pensar"
  c(537, "remove", true, "Fica a linha 568 (no máximo uma pergunta por resposta)."),
  c(538, "remove", true, "Mesma ideia da 537."),
  c(539, "remove", true, "\"Vou pensar\" não vira empurrão de avaliação (conflita com a 579)."),
  c(470, "remove", true, "Aprovada pela Aline (14/10). Não era cópia exata da 468; a transferência já está na 510."),
  c(468, "rewrite", true, "Aprovada pela Aline (14/10): sem oferecer avaliação a quem está indecisa; combina o recontato.", CONSOLIDATED_CONDUCTION_RULE),
  { line: null, target: "roteiro", name: "Paciente vai pensar ou responde só 'ok'", action: "rewrite", approved: true, category: "objecoes",
    oldText: OLD_THINK_STEPS, newText: NEW_THINK_STEPS, newTrigger: "Paciente diz 'vou pensar', 'entendi', 'ok', 'depois eu vejo' ou agradece sem agendar.",
    note: "O roteiro mandava propor avaliação e pedir dia e turno; agora acolhe, entende o motivo e combina o recontato." },
  { line: null, target: "roteiro", name: "Contorno de objeções", action: "rewrite", approved: true, category: "objecoes",
    oldText: OLD_OBJECTION_TRIGGER, newText: "Paciente diz que está caro, mora longe, não tem tempo ou compara com outro lugar.",
    note: "\"Vai pensar\" sai deste gatilho: tem roteiro próprio." },

  // 4. Identidade
  c(467, "remove", true, "Não se apresenta como assistente virtual por conta própria; se perguntarem, vale a resposta fixa."),
  { line: null, target: "regra padrão", action: "rewrite", approved: true, category: "tom_de_voz", oldText: RETIRED_DEFAULT_RULES[0], newText: NEW_IDENTITY_DEFAULT,
    note: "A regra padrão mandava \"desconverse\" sobre ser IA; o sistema responde a verdade." },

  // 5. Transferência e silêncio
  c(509, "rewrite", true, "Silêncio ao transferir (decisão da Aline, 14/10); sem frase de encaminhamento.", TRANSFER_RULE),
  c(513, "remove", true, "O silêncio depois da tomada é feito pelo sistema; a regra dizia \"só retome quando liberada\", o que conflita com a volta após 15 min da equipe."),

  // 6. Equipe
  c(524, "remove", true, "A linha 531 repete e completa (Aline e Fabíola)."),
];

export interface RuleChangeResult extends RuleChange {
  found: number; // quantas existem no banco com esse texto exato
  applied: boolean;
}

export interface CleanRulesResult {
  dryRun: boolean;
  changes: RuleChangeResult[];
  summary: { removed: number; rewritten: number; added: number; disabled: number; notFound: number; pendingOk: number };
}

export async function cleanLisboaRules(clinicId: string, opts: { dryRun: boolean }): Promise<CleanRulesResult> {
  const rules = await prisma.customRule.findMany({ where: { clinicId, status: "active" }, select: { id: true, category: true, instruction: true } });
  const playbooks = await prisma.playbook.findMany({ where: { clinicId }, select: { id: true, name: true, steps: true, triggerText: true } });
  const addedMarkers = new Set(
    (await prisma.customRule.findMany({ where: { clinicId, rawInput: { in: [CLEAN_MARKER, EVAL_TODAY_TOMORROW_MARKER] } }, select: { rawInput: true } })).map((r) => r.rawInput),
  );
  const changes: RuleChangeResult[] = [];
  const summary = { removed: 0, rewritten: 0, added: 0, disabled: 0, notFound: 0, pendingOk: 0 };

  for (const ch of RULE_CHANGES) {
    const isPlaybook = ch.target === "roteiro";
    // roteiro: casa por nome + texto exato (os passos, ou o "quando usar" do roteiro de objecoes)
    const pbMatches = isPlaybook ? playbooks.filter((p) => p.name === ch.name && (p.steps === ch.oldText || p.triggerText === ch.oldText)) : [];
    const matches = isPlaybook ? [] : ch.oldText ? rules.filter((r) => r.instruction === ch.oldText) : [];
    const addedBefore = ch.action === "add" && addedMarkers.has(ch.marker ?? CLEAN_MARKER);
    const found = ch.action === "add" ? (addedBefore ? 1 : 0) : isPlaybook ? pbMatches.length : matches.length;
    let applied = false;
    if (!ch.approved) summary.pendingOk++;
    else if (ch.action === "add") {
      if (!addedBefore) {
        if (!opts.dryRun) await prisma.customRule.create({ data: { clinicId, category: ch.category, rawInput: ch.marker ?? CLEAN_MARKER, instruction: ch.newText, status: "active" } });
        summary.added++;
        applied = true;
      }
    } else if (isPlaybook) {
      if (!pbMatches.length) summary.notFound++;
      else {
        if (!opts.dryRun) {
          const p = pbMatches[0];
          await prisma.playbook.update({
            where: { id: p.id },
            data: p.steps === ch.oldText ? { steps: ch.newText ?? p.steps, ...(ch.newTrigger ? { triggerText: ch.newTrigger } : {}) } : { triggerText: ch.newText },
          });
        }
        summary.rewritten++;
        applied = true;
      }
    } else if (!matches.length) summary.notFound++;
    else {
      if (!opts.dryRun) {
        if (ch.action === "remove") await prisma.customRule.deleteMany({ where: { id: { in: matches.map((m) => m.id) } } });
        else if (ch.action === "disable") await prisma.customRule.updateMany({ where: { id: { in: matches.map((m) => m.id) } }, data: { status: "inactive" } });
        else await prisma.customRule.update({ where: { id: matches[0].id }, data: { instruction: ch.newText } });
      }
      if (ch.action === "remove") summary.removed++;
      else if (ch.action === "disable") summary.disabled++;
      else summary.rewritten++;
      applied = true;
    }
    changes.push({ ...ch, found, applied });
  }
  return { dryRun: opts.dryRun, changes, summary };
}

// Somente leitura: as regras ATIVAS da clinica agrupadas por origem (marcador do seed), pra conferir o que realmente esta no banco.
export async function listActiveRules(clinicId: string): Promise<{ origem: string; category: string; instruction: string }[]> {
  const rules = await prisma.customRule.findMany({ where: { clinicId, status: "active" }, orderBy: { createdAt: "asc" }, select: { rawInput: true, category: true, instruction: true } });
  return rules.map((r) => ({ origem: r.rawInput.startsWith("seed:") || r.rawInput.startsWith("(regra") ? r.rawInput : "manual (painel / Ensinar a Alice)", category: r.category, instruction: r.instruction ?? "" }));
}

// Somente leitura: as AUTOMACOES da clinica (o que sai sozinho pro paciente), pra conferir qual mensagem esta ativa de verdade.
export async function listAutomations(clinicId: string): Promise<string[]> {
  const out: string[] = [];
  const cut = (t: string | null | undefined) => (t ?? "").replace(/\s+/g, " ").trim().slice(0, 220);
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { npsEnabled: true, npsHoursAfter: true, npsMessage: true, npsEvaluationMessage: true, humanReturnMinutes: true } });
  out.push(`PESQUISA DE SATISFAÇÃO (NPS): ${clinic.npsEnabled ? "LIGADA" : "desligada"} · ${clinic.npsHoursAfter}h depois do atendimento concluído\n  mensagem geral: ${cut(clinic.npsMessage) || "(padrão do sistema)"}\n  mensagem da avaliação: ${cut(clinic.npsEvaluationMessage) || "(usa a geral)"}`);
  const procs = new Map((await prisma.procedure.findMany({ where: { clinicId }, select: { id: true, name: true } })).map((p) => [p.id, p.name]));
  for (const r of await prisma.postProcedureRule.findMany({ where: { clinicId }, orderBy: { createdAt: "asc" } })) {
    const ids = r.procedureIds.split(",").filter(Boolean);
    out.push(`PÓS-PROCEDIMENTO "${r.name}": ${r.active ? "ATIVA" : "desligada"} · ${r.intervalValue} ${r.intervalUnit} depois · ${r.onlyIfCompleted ? "só concluídos" : "todos"} · procedimentos: ${ids.length ? ids.map((i) => procs.get(i) ?? i).join(", ") : "TODOS"}\n  mensagem: ${cut(r.message)}`);
  }
  for (const r of await prisma.reminderRule.findMany({ where: { clinicId }, orderBy: { createdAt: "asc" } })) {
    out.push(`LEMBRETE ${r.hoursBefore}h (dia ${r.dayOffset}): ${r.active ? "ATIVO" : "desligado"}\n  mensagem: ${cut(r.message)}`);
  }
  for (const r of await prisma.followUpRule.findMany({ where: { clinicId }, orderBy: { order: "asc" } })) {
    out.push(`RECONTATO ${r.order} "${r.name}": ${r.active ? "ATIVO" : "desligado"} · ${r.nextDayHour != null ? `dia seguinte às ${r.nextDayHour}h` : `${r.afterMinutes} min de silêncio`}${r.sendWindowStart != null ? ` · janela ${r.sendWindowStart}h-${r.sendWindowEnd}h` : ""}\n  mensagem: ${cut(r.message)}`);
  }
  for (const r of await prisma.renewalRule.findMany({ where: { clinicId } })) out.push(`REATIVAÇÃO "${r.name}": ${r.active ? "ATIVA" : "desligada"} · ${r.intervalValue} ${r.intervalUnit}\n  mensagem: ${cut(r.message)}`);
  for (const r of await prisma.birthdayRule.findMany({ where: { clinicId } })) out.push(`ANIVERSÁRIO "${r.name}": ${r.active ? "ATIVO" : "desligado"}\n  mensagem: ${cut(r.message)}`);
  out.push(`ALICE VOLTA SE A EQUIPE DEMORAR: ${clinic.humanReturnMinutes > 0 ? `${clinic.humanReturnMinutes} min` : "desligado"}`);
  return out;
}
