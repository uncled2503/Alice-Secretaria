import { prisma } from "../db/client.js";
import { logActivity } from "../crm/activity.js";

// ---------------------------------------------------------------------------
// FATOS DA LISBOA (incidentes de 19-20/10/2026): formacao da Sabrina, quantidade da oferta (50 UI) e tecnologia da criolipolise. Restrito a UMA clinica, com PREVIA
// (dryRun, padrao) e idempotente. O que APLICA (so com dryRun:false) mexe apenas em campos ESTRUTURADOS e vazios ou em uma FAQ nova com marcador proprio; texto
// manual que ja existe NUNCA e editado: so e relatado (conflitos) para uma pessoa revisar. Mensagens antigas da Alice nao sao fonte de verdade.
//
// Informado pelo dono: Sabrina e BIOMEDICA (o tratamento "Dra." continua, mas nao significa medica); a oferta de toxina e de 50 UI; a Lisboa usa criolipolise de PLACAS
// (nao de succao). NAO informado (pendente, nada e preenchido por suposicao): numero de sessoes da criolipolise, se inclui radiofrequencia, fonte dos 90 min, preco
// vigente de Carboxiterapia/Skinbooster, e a distincao de flacidez entre tecnologias (so vira afirmacao depois de validada pela responsavel tecnica).
// ---------------------------------------------------------------------------

export const FAQ_CRIO_MARCADOR = "Qual tecnologia de criolipólise a clínica usa?";
export const FAQ_CRIO_RESPOSTA = "Utilizamos criolipólise de placas (não é a de sucção).";
const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

export interface FatosOptions {
  dryRun: boolean;
  ofertaProcedimentoId?: string; // qual procedimento cadastrado e a oferta de 50 UI (a clinica decide; nunca presumido)
  ofertaQuantidade?: string; // padrao "50 UI"
  formacaoSabrina?: string; // padrao "Biomédica"
}

export interface ItemFato { tipo: "formacao" | "quantidade_da_oferta" | "faq_criolipolise"; alvo: string; acao: "aplicar" | "ja_aplicado" | "conflito" | "pendente"; antes: string | null; depois: string | null; motivo: string }
export interface Conflito { onde: string; id: string; trecho: string; sugestao: string }
export interface FatosResult {
  dryRun: boolean;
  clinica: string;
  itens: ItemFato[];
  candidatosDaOferta: { id: string; nome: string; quantidadeNoCadastro: string | null; numerosDeUiNosTextos: number[] }[];
  conflitos: Conflito[];
  pendenciasDaClinica: string[];
  aplicado: { formacao: boolean; quantidade: boolean; faq: boolean };
}

const clip = (t: string, around: number, len = 130) => t.replace(/\s+/g, " ").slice(Math.max(0, around - 40), Math.max(0, around - 40) + len);

export async function ajustarFatosLisboa(clinicId: string, opts: FatosOptions): Promise<FatosResult> {
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { name: true } });
  const quantidade = (opts.ofertaQuantidade ?? "50 UI").trim();
  const formacao = (opts.formacaoSabrina ?? "Biomédica").trim();
  const itens: ItemFato[] = [];
  const out: FatosResult = { dryRun: opts.dryRun, clinica: clinic.name, itens, candidatosDaOferta: [], conflitos: [], pendenciasDaClinica: [], aplicado: { formacao: false, quantidade: false, faq: false } };

  // 1) FORMACAO da Sabrina: so se houver EXATAMENTE uma profissional ativa com esse primeiro nome e o campo estiver vazio
  const pros = await prisma.professional.findMany({ where: { clinicId, active: true } });
  const sabrinas = pros.filter((p) => fold(p.name.trim().split(/\s+/)[0] ?? "") === "sabrina");
  if (sabrinas.length === 0) itens.push({ tipo: "formacao", alvo: "Sabrina", acao: "pendente", antes: null, depois: null, motivo: "nenhuma profissional ativa chamada Sabrina neste cadastro" });
  else if (sabrinas.length > 1) itens.push({ tipo: "formacao", alvo: "Sabrina", acao: "pendente", antes: null, depois: null, motivo: `${sabrinas.length} profissionais ativas com esse primeiro nome (${sabrinas.map((p) => p.id).join(", ")}): indique qual` });
  else {
    const s = sabrinas[0];
    if (s.qualification && fold(s.qualification) === fold(formacao)) itens.push({ tipo: "formacao", alvo: s.name, acao: "ja_aplicado", antes: s.qualification, depois: formacao, motivo: "ja cadastrada" });
    else if (s.qualification) itens.push({ tipo: "formacao", alvo: s.name, acao: "conflito", antes: s.qualification, depois: formacao, motivo: "ja existe outra formacao cadastrada: nao sobrescrevo (confirme com a clinica)" });
    else {
      itens.push({ tipo: "formacao", alvo: s.name, acao: "aplicar", antes: null, depois: formacao, motivo: `o tratamento "${s.title ?? "-"}" nao muda; so a formacao e cadastrada` });
      if (!opts.dryRun) { await prisma.professional.updateMany({ where: { id: s.id, qualification: null }, data: { qualification: formacao } }); out.aplicado.formacao = true; }
    }
  }

  // 2) QUANTIDADE da oferta: candidatos para a clinica escolher; aplica so no procedimento INDICADO e so se o campo estiver vazio
  const procs = await prisma.procedure.findMany({ where: { clinicId, internalOnly: false } });
  const uiNums = (t: string) => [...fold(t).matchAll(/\b(\d{1,4})(?:\s*(?:a|-|ate)\s*(\d{1,4}))?\s*(?:ui|u\.i\.|unidades?)\b/g)].flatMap((m) => [Number(m[1]), ...(m[2] ? [Number(m[2])] : [])]);
  for (const p of procs) {
    const texto = [p.name, p.aliases, p.description, p.benefits].filter(Boolean).join(" ");
    const nums = uiNums(texto);
    if (/toxina|botox|botul|dysport|xeomin|\bui\b/.test(fold(texto)) || nums.length || p.includedQuantity) {
      out.candidatosDaOferta.push({ id: p.id, nome: p.name, quantidadeNoCadastro: p.includedQuantity, numerosDeUiNosTextos: [...new Set(nums)] });
    }
  }
  if (!opts.ofertaProcedimentoId) {
    itens.push({ tipo: "quantidade_da_oferta", alvo: "(oferta de toxina)", acao: "pendente", antes: null, depois: quantidade, motivo: out.candidatosDaOferta.length ? "indique qual dos procedimentos candidatos e a oferta de 50 UI (ofertaProcedimentoId); nada e presumido nem estendido a outras ofertas/marcas" : "nenhum procedimento cadastrado parece ser a oferta de toxina: informe o id" });
  } else {
    const alvo = procs.find((p) => p.id === opts.ofertaProcedimentoId);
    if (!alvo) itens.push({ tipo: "quantidade_da_oferta", alvo: opts.ofertaProcedimentoId, acao: "pendente", antes: null, depois: quantidade, motivo: "procedimento nao encontrado nesta clinica" });
    else if (alvo.includedQuantity && fold(alvo.includedQuantity) === fold(quantidade)) itens.push({ tipo: "quantidade_da_oferta", alvo: alvo.name, acao: "ja_aplicado", antes: alvo.includedQuantity, depois: quantidade, motivo: "ja cadastrada" });
    else if (alvo.includedQuantity) itens.push({ tipo: "quantidade_da_oferta", alvo: alvo.name, acao: "conflito", antes: alvo.includedQuantity, depois: quantidade, motivo: "ja existe outra quantidade cadastrada: nao sobrescrevo" });
    else {
      itens.push({ tipo: "quantidade_da_oferta", alvo: alvo.name, acao: "aplicar", antes: null, depois: quantidade, motivo: "quantidade INCLUIDA na oferta (nao e recomendacao individual); vale so para este procedimento" });
      if (!opts.dryRun) { await prisma.procedure.updateMany({ where: { id: alvo.id, includedQuantity: null }, data: { includedQuantity: quantidade } }); out.aplicado.quantidade = true; }
    }
  }

  // 3) TECNOLOGIA da criolipolise: FAQ nova (marcador proprio), sem tocar em texto existente
  const faqs = await prisma.clinicFaq.findMany({ where: { clinicId } });
  const jaTem = faqs.find((f) => fold(f.question).trim() === fold(FAQ_CRIO_MARCADOR).trim());
  if (jaTem) itens.push({ tipo: "faq_criolipolise", alvo: "FAQ", acao: "ja_aplicado", antes: jaTem.answer, depois: FAQ_CRIO_RESPOSTA, motivo: "FAQ ja existe (nao e alterada)" });
  else {
    itens.push({ tipo: "faq_criolipolise", alvo: "FAQ", acao: "aplicar", antes: null, depois: FAQ_CRIO_RESPOSTA, motivo: "informado pelo dono; a distincao de flacidez entre tecnologias NAO foi incluida (aguarda validacao da responsavel tecnica)" });
    if (!opts.dryRun) { await prisma.clinicFaq.create({ data: { clinicId, question: FAQ_CRIO_MARCADOR, answer: FAQ_CRIO_RESPOSTA, alternates: "criolipólise é de sucção?\nqual a máquina de criolipólise?\ncriolipólise de placas" } }); out.aplicado.faq = true; }
  }

  // 4) CONFLITOS em texto manual (so relata)
  const varrer = (onde: string, id: string, texto: string | null | undefined) => {
    if (!texto) return;
    const f = fold(texto);
    const sab = /sabrina/.exec(f);
    if (sab && /\bmedic[oa]s?\b/.test(f.slice(Math.max(0, sab.index - 120), sab.index + 160))) out.conflitos.push({ onde, id, trecho: clip(texto, sab.index), sugestao: "a Sabrina e biomedica: revisar o trecho que a chama de medica" });
    const faixa = /\b(\d{1,3})\s*(?:a|-|ate)\s*(\d{1,3})\s*(?:ui|unidades?)\b/.exec(f);
    if (faixa) out.conflitos.push({ onde, id, trecho: clip(texto, faixa.index), sugestao: `faixa de UI no texto; a oferta e de ${quantidade}: revisar` });
    if (/crio/.test(f)) { const suc = /suc[cç][aã]o/.exec(f); if (suc) out.conflitos.push({ onde, id, trecho: clip(texto, suc.index), sugestao: "a Lisboa usa criolipolise de PLACAS: revisar o trecho sobre succao" }); }
  };
  for (const p of procs) { varrer(`Procedimento "${p.name}" (descricao)`, p.id, p.description); varrer(`Procedimento "${p.name}" (beneficios)`, p.id, p.benefits); }
  for (const f of faqs) varrer(`FAQ "${f.question.slice(0, 50)}"`, f.id, `${f.question} ${f.answer}`);
  for (const m of await prisma.messageTemplate.findMany({ where: { clinicId } })) varrer(`Mensagem pronta "${m.name}"`, m.id, m.body);
  for (const pb of await prisma.playbook.findMany({ where: { clinicId } })) varrer(`Roteiro "${pb.name}"`, pb.id, `${pb.goal ?? ""} ${pb.steps}`);
  for (const pr of pros) varrer(`Profissional "${pr.name}" (bio)`, pr.id, pr.bio);

  out.pendenciasDaClinica = [
    "Criolipólise: quantas sessões (e intervalo) — nada foi preenchido por suposição.",
    "Criolipólise: a oferta inclui radiofrequência? (só se constar na oferta; sem isso a Alice não inclui nem monta pacote).",
    "Criolipólise: de onde vêm os 90 minutos (tempo de aplicação x tempo de reserva na agenda) — o cadastro hoje mostra só a duração da reserva.",
    "Criolipólise x flacidez: a distinção entre as tecnologias precisa ser validada pela responsável técnica antes de virar afirmação (nunca como garantia de ausência de risco).",
    "Carboxiterapia / Skinbooster: indicação para bolsas e olheiras, e preços vigentes e sua vigência (os valores do print NÃO são cadastro aprovado).",
    "Toxina: confirmar a marca e a qual procedimento cadastrado a oferta de 50 UI corresponde (informar ofertaProcedimentoId); outras ofertas/marcas não herdam 50 UI.",
    "Fotos aprovadas por procedimento/queixa (ex.: peeling para cicatriz de acne): cadastrar na galeria do procedimento; sem foto a conversa segue sem prometer imagem.",
    "Profissional médica: se a clínica tiver, cadastrar nome e formação; hoje a Alice não afirma que existe outra médica.",
  ];

  if (!opts.dryRun && (out.aplicado.formacao || out.aplicado.quantidade || out.aplicado.faq)) {
    await logActivity({ clinicId, type: "lisboa_fatos_ajustados", area: "atendimento", title: "Fatos da Lisboa ajustados (formação, quantidade da oferta, criolipólise)", description: `formação: ${out.aplicado.formacao ? "sim" : "não"}; quantidade: ${out.aplicado.quantidade ? "sim" : "não"}; FAQ criolipólise: ${out.aplicado.faq ? "sim" : "não"}.`, actorName: null }).catch(() => undefined);
  }
  return out;
}

// CLI (PREVIA por padrao):  node dist/maintenance/lisboaFatos.js [--clinica="Lisboa Beauty Center"] [--oferta=<idDoProcedimento>] [--aplicar]
if (process.argv[1] && /lisboaFatos\.js$/.test(process.argv[1].replace(/\\/g, "/"))) {
  const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const nome = arg("clinica") ?? "Lisboa Beauty Center";
  prisma.clinic.findFirst({ where: { name: nome } })
    .then(async (c) => {
      if (!c) throw new Error(`Clinica "${nome}" nao encontrada.`);
      console.log(JSON.stringify(await ajustarFatosLisboa(c.id, { dryRun: !process.argv.includes("--aplicar"), ofertaProcedimentoId: arg("oferta") }), null, 2));
    })
    .catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
