import { prisma } from "../db/client.js";

// Limpeza das regras da Lisboa que se contradizem (analise de 14/10/2026, aprovada pela Aline linha a linha).
// As regras reais estao no banco (CustomRule); o seed nao apaga nada. Aqui cada regra e achada pelo TEXTO EXATO que o
// seed gravou: se alguem editou a regra no painel, o texto nao bate e ela nao e tocada.
//  - remove  : apaga a regra.
//  - rewrite : troca o texto (mantem o registro).
//  - add     : cria regra nova (uma vez; marcador proprio).
// approved=false aparece na previa mas NAO e aplicado (espera o ok da clinica).
// "line" e a linha em seedLisboa.ts ANTES desta limpeza.
export const CLEAN_MARKER = "seed:lisboa-limpeza-conflitos";

const OLD: Record<number, { category: string; text: string }> = {
  467: { category: "tom_de_voz", text: "A Alice se identifica como assistente virtual da Lisboa Beauty Center. Se perguntarem se é robô, responda com naturalidade que é a Alice, assistente virtual da clínica, que ajuda com informações, horários e agendamentos e encaminha para a equipe quando necessário." },
  468: { category: "tom_de_voz", text: "Atendimento próximo, comercial e consultivo: acolha, entenda a queixa e conduza para avaliação ou agendamento sem pressionar. Se o paciente estiver indeciso, ofereça a avaliação estética gratuita; se já souber o procedimento, explique e conduza ao agendamento." },
  470: { category: "tom_de_voz", text: "Em toda conversa: acolha, entenda a queixa, registre as informações relevantes, ofereça avaliação quando houver dúvida e conduza para o próximo passo. Transfira casos clínicos, reclamações, negociações especiais e assuntos sensíveis." },
  485: { category: "pagamento", text: "Pode informar preço pelo WhatsApp quando o valor estiver cadastrado e vigente. Para valores variáveis, informe só a regra cadastrada ou encaminhe para a avaliação. Nunca invente preço." },
  486: { category: "pagamento", text: "Desconto, brinde ou condição especial: somente campanhas previamente autorizadas e vigentes. Fora disso, diga que vai verificar com a equipe e transfira." },
  492: { category: "pagamento", text: "Quando o paciente achar caro, pedir desconto ou comparar com outro lugar: acolha, explique que o valor envolve profissional, produto/tecnologia, protocolo e acompanhamento, reforce a avaliação personalizada e verifique se há condição vigente. Nunca prometa desconto." },
  509: { category: "chamar_equipe", text: "Se não souber ou não tiver informação segura, admita e encaminhe: 'Essa é uma orientação que preciso confirmar com nossa equipe para te passar corretamente.'" },
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
  line: number | null; // null = regra nova
  action: "remove" | "rewrite" | "add";
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

export const CONSOLIDATED_CONDUCTION_RULE =
  "Atendimento próximo, comercial e consultivo: acolha, entenda a queixa e conduza a conversa para um próximo passo, mas sem pressionar. A avaliação pode ser sugerida no máximo uma vez no mesmo contexto. Se a pessoa disser que vai pensar, acolha e, se fizer sentido, entenda o motivo da dúvida, sem empurrar avaliação.";

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
  c(486, "rewrite", false, "NÃO estava na lista: manda dizer \"vai verificar com a equipe\", o que bate com a regra 546. Aguardando ok.",
    "Desconto, brinde ou condição especial: somente campanhas previamente autorizadas e vigentes. Fora disso, não prometa nada e transfira para a equipe, sem escrever que vai verificar."),

  // 2. Agendamento
  c(547, "remove", true, "A Alice agenda direto no Clínica Experts."),
  c(553, "remove", true, "Coberta pelas linhas 495/497 (coleta do nome completo) e pela regra nova abaixo."),
  { line: null, action: "add", approved: true, category: "agendamento", oldText: null, newText: NEW_BOOKING_NAME_RULE,
    note: "Preserva: sem cadastro, pede nome completo antes de concluir; depois de agendar, aviso interno à equipe." },

  // 3. Condução / pressão
  c(537, "remove", true, "Fica a linha 568 (no máximo uma pergunta por resposta)."),
  c(538, "remove", true, "Mesma ideia da 537."),
  c(539, "remove", true, "\"Vou pensar\" não vira empurrão de avaliação (conflita com a 579)."),
  c(470, "remove", false, "NÃO é duplicata exata da 468: tem a mais \"registre as informações\" e \"transfira casos clínicos…\" (a transferência já está na 510). Aguardando ok."),
  c(468, "rewrite", false, "NÃO estava na lista: diz \"se indeciso, ofereça a avaliação\" e contradiz a regra consolidada. Aguardando ok.",
    CONSOLIDATED_CONDUCTION_RULE),

  // 4. Identidade
  c(467, "remove", true, "Não se apresenta como assistente virtual por conta própria; se perguntarem, vale a resposta fixa."),

  // 5. Transferência
  c(509, "rewrite", true, "Separa antes da transferência (não inventa, encaminha) de depois (silêncio até liberar).",
    "Quando a dúvida exigir atendimento humano, não invente resposta: faça o encaminhamento conforme o fluxo (acione a transferência), sem escrever \"vou verificar com a equipe\". Depois que a equipe assumir a conversa, permaneça em silêncio até a liberação."),

  // 6. Equipe
  c(524, "remove", true, "A linha 531 repete e completa (Aline e Fabíola)."),
];

export interface RuleChangeResult extends RuleChange {
  found: number; // quantas regras ativas com esse texto exato existem no banco
  applied: boolean;
}

export interface CleanRulesResult {
  dryRun: boolean;
  changes: RuleChangeResult[];
  summary: { removed: number; rewritten: number; added: number; notFound: number; pendingOk: number };
}

export async function cleanLisboaRules(clinicId: string, opts: { dryRun: boolean }): Promise<CleanRulesResult> {
  const rules = await prisma.customRule.findMany({ where: { clinicId, status: "active" }, select: { id: true, category: true, instruction: true } });
  const addedBefore = (await prisma.customRule.count({ where: { clinicId, rawInput: CLEAN_MARKER } })) > 0;
  const changes: RuleChangeResult[] = [];
  const summary = { removed: 0, rewritten: 0, added: 0, notFound: 0, pendingOk: 0 };

  for (const ch of RULE_CHANGES) {
    const matches = ch.oldText ? rules.filter((r) => r.instruction === ch.oldText) : [];
    const found = ch.action === "add" ? (addedBefore ? 1 : 0) : matches.length;
    let applied = false;
    if (!ch.approved) summary.pendingOk++;
    else if (ch.action === "add") {
      if (!addedBefore) {
        if (!opts.dryRun) await prisma.customRule.create({ data: { clinicId, category: ch.category, rawInput: CLEAN_MARKER, instruction: ch.newText, status: "active" } });
        summary.added++;
        applied = true;
      }
    } else if (!matches.length) summary.notFound++;
    else {
      if (!opts.dryRun) {
        if (ch.action === "remove") await prisma.customRule.deleteMany({ where: { id: { in: matches.map((m) => m.id) } } });
        else await prisma.customRule.update({ where: { id: matches[0].id }, data: { instruction: ch.newText } });
      }
      if (ch.action === "remove") summary.removed++;
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
