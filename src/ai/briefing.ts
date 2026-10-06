import OpenAI from "openai";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { z } from "zod";
import { prisma } from "../db/client.js";
import { reseedRulesForProfile } from "./rules.js";
import { logActivity } from "../crm/activity.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// Briefing e uma chamada rara (uma por cliente novo) e vale um modelo melhor:
// nao cai no OPENAI_MODEL (que costuma ser o mini) - usa gpt-4o por padrao.
const MODEL = process.env.OPENAI_BRIEFING_MODEL ?? "gpt-4o";

// ---------------------------------------------------------------------------
// Questionario que o cliente responde. Fonte unica: o painel serve este texto
// no botao "copiar modelo" e docs/briefing-cliente.md e uma copia pra leitura.
// ---------------------------------------------------------------------------
export const BRIEFING_TEMPLATE = `BRIEFING DE CONFIGURACAO — ALICE (secretaria virtual da clinica)

Este questionario serve para treinar a Alice por completo numa unica rodada. Ele e longo
de proposito: quanto mais voce responder, menos a Alice vai errar, improvisar ou chamar
a equipe a toa. Pode levar de 40 minutos a 1 hora. Se preferir, responda por audio e peca
para transcreverem.

Como responder:
- Responda o que souber e deixe em branco o que nao se aplica. Pode escrever em texto corrido.
- De EXEMPLOS REAIS sempre que puder (frases que voces falam, conversas que aconteceram). Exemplo vale mais que explicacao.
- Onde pedir "como responder", escreva do jeito que VOCE responderia ao paciente.
- Se nao sabe ou ainda nao decidiu algo, escreva "nao decidi" — e melhor que chutar.

IMPORTANTE: se voces ja tem qualquer material pronto (manual de atendimento, script de vendas,
mensagens que ja usam no WhatsApp, prints de conversas reais, lista de perguntas e respostas,
tabela de precos, apresentacao da clinica, textos do site/Instagram, termos de consentimento,
orientacoes pre e pos procedimento), NAO reescreva do zero: cole tudo inteiro junto com as
respostas, mesmo fora do formato abaixo. E o material mais valioso para treinar a Alice, e a
IA sabe aproveitar texto solto.

== 1. DADOS DA CLINICA ==
- Nome da clinica (como o paciente conhece):
- Razao social / CNPJ (se quiser que conste):
- WhatsApp de atendimento (com DDD) — se tiver mais de um numero, diga QUAL e o oficial que fica conectado a Alice:
- Instagram da clinica:
- Site (se tiver):
- Cidade e estado:
- Fuso horario (se nao for o de Brasilia):
- Horario de funcionamento (que horas abre / que horas fecha):
- Dias de atendimento (ex.: segunda a sexta, sabado ate 13h; se so alguns sabados especificos do mes, explique a regra):
- Tem intervalo de almoco ou pausa? Em que horario (pode ser meia-hora)?
- A clinica fecha em feriados nacionais? E em feriados locais ou datas especificas (recesso, ferias coletivas)? Quais:
- Numero para receber avisos de agendamento/cancelamento (pode ser o mesmo de atendimento):
- Quais avisos esse numero deve receber: novo agendamento / remarcacao / cancelamento / confirmacao do paciente / pedido de atendimento humano:

== 2. ENDERECO(S) ==
Para cada unidade:
- Nome da unidade (ex.: Matriz, Unidade Centro):
- Rua, numero, complemento (sala, andar, bloco):
- Bairro, cidade, estado, CEP:
- Como chegar / ponto de referencia:
- Estacionamento (proprio, conveniado, na rua, valor):
- Acessibilidade (rampa, elevador):
- Link do Google Maps:
- Os profissionais atendem em todas as unidades ou cada um em uma? Em quais dias:

== 3. SOBRE A CLINICA E O PUBLICO ==
- Resuma a clinica em 2 ou 3 frases, como voce apresentaria a um paciente novo:
- Area de atuacao em uma frase (ex.: harmonizacao facial, corporal e intima):
- A clinica e: ( ) so estetica  ( ) so medica  ( ) as duas
- Ha quanto tempo atua? Quantos pacientes ja atendeu (se quiser citar)?
- Quais sao os DIFERENCIAIS da clinica que a Alice pode destacar (tecnologia, tecnica, formacao, estrutura, atendimento, resultado)?
- Por que o paciente escolhe voces e nao a concorrencia?
- Quem e o paciente ideal (idade, perfil, o que busca)?
- Existe um perfil de paciente que voces NAO atendem ou preferem nao atender?
- De onde vem os pacientes hoje (Instagram, indicacao, Google, anuncios)? E como costumam chegar no WhatsApp (clicaram no anuncio, indicacao, perfil)?
- Quem sao os principais concorrentes e como a Alice deve (ou nao) falar deles?
- A clinica tem premios, certificacoes, formacoes ou parcerias que valem ser citados?
- Pode a Alice citar resultados/casos de pacientes? Em que termos (e o que e proibido por etica/regulamento)?

== 4. COMO A ALICE SE APRESENTA ==
- A Alice fala como: ( ) parte da equipe da clinica  ( ) secretaria da clinica  ( ) secretaria de um profissional
- Se for de um profissional, qual o nome (ex.: Dra. Camila Souza):
- Nome pelo qual a secretaria se apresenta (padrao: Alice):
- Ela deve se identificar como assistente virtual/IA, ou atender sem dizer isso? Se o paciente perguntar "e robo?", o que ela responde:
- Estilo de atendimento: ( ) mais direto/comercial (oferece horario, conduz para a agenda)  ( ) mais consultivo (avaliacao primeiro, sem pressao, no ritmo do paciente)
- O paciente precisa saber qual procedimento quer, ou a clinica prefere que ele passe por avaliacao para o profissional indicar? (SIM = pode exigir / NAO = sempre oferecer avaliacao)
- A Alice pode usar emojis? Quais combinam com a clinica e quais nunca usar?
- Tem link de auto-agendamento (o paciente marca sozinho num site)? Qual? A Alice deve mandar esse link ou agendar ela mesma?
- A Alice pode responder audios, fotos e documentos que o paciente manda? O que ela deve fazer quando chega um audio (transcrever e responder, pedir que escreva, chamar a equipe):

== 5. TOM DE VOZ E VOCABULARIO ==
- Como voces gostam de falar com o paciente (formal/cerimonioso, proximo, leve, descontraido, premium...). Se puder, 3 adjetivos:
- Tratam o paciente por "voce" e primeiro nome, ou por "Senhor(a)", ou "Dr./Dra."?
- Palavras que a clinica prefere usar no lugar de outras (ex.: "avaliacao" em vez de "consulta", "investimento" em vez de "preco", "paciente" em vez de "cliente"). Liste os pares:
- Palavras, girias ou expressoes PROIBIDAS (ex.: "barato", "promocao", "gente", "amiga", "querida"):
- Formato das mensagens: curtas ou completas? No maximo uma pergunta por vez? Pode usar listas e topicos? Pode usar negrito?
- Como a Alice cumprimenta (bom dia/boa tarde/boa noite conforme o horario)? Algum bordao de abertura ou de despedida:
- Cole 3 a 5 mensagens REAIS que voces acham que representam bem o jeito da clinica falar:
- Cole 1 ou 2 exemplos de como NAO falar (mensagens que voces acham frias, insistentes ou fora do perfil):

== 6. REGRAS DE OURO ==
- O que a Alice NUNCA deve fazer ou dizer (liste todas, mesmo as que parecem obvias):
- O que a Alice SEMPRE deve fazer em toda conversa:
- A Alice PODE informar preco pelo WhatsApp, ou so depois de entender o objetivo do paciente / na avaliacao? Se pode, como (valor fechado, "a partir de", faixa):
- A Alice pode dar desconto, brinde ou condicao especial? Quanto e em que situacao? Ou sempre chama a equipe:
- A Alice pode prometer resultado, prazo ou "garantia"? Em que termos:
- A Alice pode dar opiniao clinica, indicar procedimento para a queixa do paciente ou comparar procedimentos? Ate onde:
- A Alice pode falar de medicamentos, doses, contraindicacoes e efeitos colaterais? Ou so o profissional:
- Se o paciente perguntar algo que a Alice nao sabe, ela deve: ( ) admitir e chamar a equipe  ( ) dizer que vai verificar e retornar  ( ) outro:
- O que fazer com pessoas que so querem informacao e somem (insistir? quantas vezes? por quanto tempo?):
- Existem assuntos sensiveis (politica, religiao, concorrentes, precos de outros lugares, reclamacoes publicas) e como a Alice deve se comportar:

== 7. TRANSFERENCIA PARA A EQUIPE ==
- Quando a Alice deve chamar uma pessoa? (ex.: pedido de desconto, negociacao, reclamacao, duvida clinica que so o profissional responde, risco medico, paciente pede para falar com alguem, envio de exame/laudo/receita/foto para avaliacao, pedido de diagnostico ou prescricao, problema de pagamento, paciente irritado):
- Palavras que devem SEMPRE acionar a transferencia (ex.: nomes de exames, "dose", "efeito colateral", "emergencia", "dor forte", "inchaco", "alergia", "processo", "advogado", "Procon"):
- Frase que a Alice usa antes de passar para uma pessoa (ex.: "So um instante que ja verifico isso pra voce"):
- Quem assume quando a Alice transfere (nome da pessoa) e em que horarios essa pessoa responde:
- Se a transferencia acontecer fora do horario da equipe, o que a Alice diz ao paciente (ex.: "retornamos amanha as 9h"):
- Depois que a equipe assume, a Alice deve ficar quieta naquela conversa? Ate quando (ex.: voltar a atender apos X horas sem resposta da equipe):
- Urgencias e emergencias (reacao alergica, sangramento, dor intensa, complicacao pos-procedimento): qual o passo a passo e qual o telefone de contato:

== 8. PERGUNTAS E OBJECOES MAIS COMUNS ==
Liste as perguntas e objecoes que os pacientes mais fazem e COMO a Alice deve responder
(escreva a resposta do jeito que voces dariam). Quanto mais exemplos reais, melhor:
- "Achei caro" / "tem desconto?" / "parcela em quantas vezes?":
- "Vou pensar e te aviso" / "preciso falar com meu marido/esposa":
- "Moro longe" / "nao tenho tempo" / "nao tenho horario":
- "Tem como fazer mais barato em outro lugar" / comparacao com concorrente:
- "Doi?" / "tem risco?" / "fica natural?" / "quanto tempo dura?":
- "Qual e o melhor para mim?" / "o que voce indica?":
- "Posso fazer gravida / amamentando / tomando X remedio?":
- Pedido de foto de antes e depois:
- Pedido de endereco, estacionamento, como chegar:
- Outras duvidas ou objecoes especificas do publico de voces (medo de agulha, medo de ficar artificial, duvida sobre resultado, convenio, etc.):

== 9. PROCEDIMENTOS / SERVICOS ==
Para CADA procedimento (copie o bloco quantas vezes precisar):
- Nome:
- Categoria (facial, corporal, intima, capilar, cirurgia, estetica, etc.):
- Quem realiza (profissional):
- Duracao aproximada da sessao:
- Valor (ou "depende de avaliacao"). Se varia, de que depende:
- Formas de pagamento (dinheiro, pix, credito, debito, boleto):
- Parcela no cartao? Em ate quantas vezes, e a partir de quantas vezes cobra juros?
- Desconto a vista?
- Link de pagamento (se tiver) e chave Pix:
- Exige sinal/entrada? Valor ou %:
- Descricao curta (o que e, como funciona, para quem):
- Queixas/objetivos que atende (ex.: "rosto cansado", "flacidez", "manchas"):
- Beneficios que a Alice pode afirmar (e os que NAO pode afirmar):
- Outros nomes que o paciente usa (ex.: "botox", "preenchimento labial", "lipo de papada"):
- Quando o resultado comeca a aparecer e quanto tempo dura:
- Quantas sessoes costuma precisar e com qual intervalo:
- Indicacoes (para quem e) e contraindicacoes (para quem NAO e):
- Preparo antes (jejum, suspender medicamento, nao tomar sol, vir sem maquiagem, exames):
- Cuidados depois (o que pode e nao pode, por quantos dias):
- Efeitos esperados e o que e normal (vermelhidao, inchaco, roxo) — e quando procurar a clinica:
- Precisa de avaliacao/consulta previa antes de agendar? Ela e paga? Quanto?
- Pode ser feito no mesmo dia da avaliacao?
- Tem fotos de antes/depois que a Alice pode enviar? (mande os arquivos separados)
- Tem video ou material explicativo?
- E o carro-chefe da clinica? Algum procedimento que voces querem vender mais / que querem priorizar?

== 10. PACOTES, COMBOS, PROMOCOES E CONDICOES ==
- Existem pacotes ou combos (ex.: 3 sessoes com desconto)? Descreva cada um com valor:
- Existem promocoes ativas ou sazonais? Quais, por quanto tempo e quem pode usar:
- Programa de indicacao, fidelidade, cashback ou desconto para retorno:
- Cupons ou condicoes especiais (aniversariante, primeira vez, convenio com empresa):
- A Alice pode oferecer promocao por conta propria ou so quando o paciente perguntar?
- Existe prazo de validade de pacote/credito? Pode transferir para outra pessoa?

== 11. PRODUTOS VENDIDOS (se houver) ==
- Nome / valor / descricao / para que serve / forma de pagamento:
- A Alice pode vender produto sozinha ou so informa e chama a equipe?
- Tem entrega/envio? Prazo e valor do frete:

== 12. PROFISSIONAIS E EQUIPE ==
Para cada profissional:
- Nome (como a Alice deve chamar: "Dra. Fulana", "Fulana"):
- Especialidade, formacao e registro profissional (CRM, CRO etc.):
- Mini biografia que a Alice pode contar (2 ou 3 frases):
- Instagram:
- Quais procedimentos realiza:
- Dias e horarios de atendimento (se diferentes da clinica) e intervalo de almoco:
- Atende em qual unidade:
- Atende no mesmo horario de outro profissional (ex.: medico + enfermagem em paralelo)?
- O paciente pode escolher o profissional ou a clinica decide?
- Algum profissional atende so retorno, so avaliacao, so um tipo de paciente?
Equipe de apoio (recepcao, atendimento, financeiro):
- Nome e funcao de cada pessoa, e o que cada uma resolve (para a Alice saber a quem passar cada assunto):

== 13. AGENDAMENTO ==
- Como funciona o agendamento hoje, do pedido ate a confirmacao:
- Quanto tempo de antecedencia minima para marcar (ex.: nao marca para o mesmo dia)? E antecedencia maxima:
- Existe tempo de preparo/limpeza entre pacientes? Quantos minutos:
- Quais horarios sao mais disputados e quais ficam vagos (a Alice deve priorizar encher os vagos)?
- A Alice deve oferecer quantas opcoes de horario por vez (ex.: 2 ou 3)?
- Algum procedimento atende por ordem de chegada (varios pacientes no mesmo horario)?
- A primeira consulta/avaliacao segue regras diferentes (duracao, valor, profissional)?
- Precisa de dados do paciente para agendar? Quais (nome completo, CPF, data de nascimento, e-mail, endereco, indicacao):
- Menores de idade: precisa de responsavel? Como e feito:
- Usam Google Agenda ou outro sistema de agenda? Qual? Ja existe agenda com pacientes marcados que precisamos considerar:
- Bloqueios ja conhecidos (ferias, congressos, dias sem atendimento, horarios fixos reservados):
- Lista de espera: quando nao ha horario, a Alice deve anotar o interesse e avisar se abrir vaga?
- Encaixes: a recepcao pode encaixar fora do expediente pelo painel? (a Alice sempre segue o horario a risca)

== 14. SINAL, PAGAMENTO E FINANCEIRO ==
- Exigem sinal/entrada para confirmar o agendamento? Para quais procedimentos? Valor fixo ou %?
- Como o paciente paga o sinal (Pix, link, transferencia)? Chave Pix e nome do titular:
- A Alice so confirma o horario depois do comprovante? Quem confere o comprovante:
- O sinal abate do valor final? O saldo e pago quando e como?
- O sinal e devolvido em caso de desistencia ou falta? Em que prazo e condicoes:
- Quanto tempo o paciente tem para pagar o sinal antes de a Alice liberar o horario:
- Politica de cancelamento e remarcacao: com quanto tempo de antecedencia precisa avisar? Tem multa? Quantas remarcacoes sao permitidas:
- Politica de atraso (tolerancia de quantos minutos) e de falta (no-show):
- Aceitam convenio/plano de saude? Emitem nota fiscal e recibo para reembolso:
- Como lidar com inadimplencia ou pagamento pendente:
- Reembolso: em que casos e como:

== 15. PERGUNTAS FREQUENTES (operacionais) ==
Responda as que fizerem sentido e acrescente as suas:
- Como e a primeira consulta/avaliacao (o que inclui, quanto tempo dura, quanto custa):
- O paciente precisa levar algo (exames, documentos, acompanhante)?
- Pode vir acompanhado? Pode levar crianca?
- Atende criancas, gestantes, idosos?
- Tem estacionamento? Como funciona?
- Aceita convenio? Emite nota fiscal?
- Qual a politica de privacidade das fotos e dos dados do paciente?
- Existe termo de consentimento? O paciente assina antes ou no dia?
- Da para fazer a distancia/telemedicina/consulta online?
- Tem Wi-Fi, cafe, espaco de espera? Algo que diferencia a experiencia:
- Outras duvidas comuns dos pacientes de voces (escreva a pergunta e a resposta):

== 16. MENSAGENS PRONTAS ==
Cole o TEXTO EXATO de qualquer mensagem que voces ja usam hoje (mesmo informalmente). Se a Alice
deve usa-la palavra por palavra, escreva "usar exatamente". Se for so referencia de tom, escreva "adaptar":
- Boas-vindas / primeiro contato:
- Resposta a quem pergunta so "quanto custa?":
- Apresentacao da clinica:
- Apresentacao de cada procedimento ou consulta:
- Convite para avaliacao:
- Pedido de sinal/pagamento (com Pix):
- Confirmacao de horario agendado:
- Orientacoes antes do procedimento:
- Orientacoes depois do procedimento:
- Lembrete de consulta:
- Mensagem quando o paciente falta:
- Mensagem quando o paciente cancela ou remarca:
- Mensagem para quem sumiu da conversa (recontato):
- Mensagem quando nao entende o que o paciente escreveu:
- Mensagem fora do horario de atendimento:
- Mensagem de agradecimento/encerramento/despedida:
- Pedido de avaliacao no Google ou indicacao:

== 17. AUTOMACOES (a Alice envia sozinha) ==
- Lembrete de consulta: quer? Quantas horas/dias antes (pode ser mais de um, ex.: 48h e 3h)? Pede confirmacao de presenca? O que fazer se o paciente nao confirmar:
- Recontato de quem sumiu na conversa: quer? Depois de quanto tempo sem responder? Quantas tentativas e com que intervalo? Em que horarios NAO pode mandar (ex.: noite, domingo):
- Confirmacao do agendamento logo apos marcar: quer mandar mensagem ao paciente? Qual texto:
- Pos-procedimento (cuidados/acompanhamento): quer? Para quais procedimentos, quantos dias depois, e qual mensagem para cada um:
- Pesquisa de satisfacao (NPS): quer? Quantas horas depois do atendimento? A partir de que nota pedir avaliacao no Google? Link do Google Meu Negocio:
- Renovacao (retomar contato meses depois para refazer): quais procedimentos e de quanto em quanto tempo (ex.: toxina a cada 6 meses):
- Recuperacao de paciente inativo ha muito tempo (ex.: 6 meses sem contato): quer? Qual mensagem:
- Lembrete de renovacao de receita/retorno:
- Mensagem de aniversario: quer? Em que horario? Com algum mimo:
- Datas comemorativas (Dia das Maes, Black Friday etc.): quer disparos? Quais:
- Disparos em massa (campanhas/promocoes): quer usar? Quem aprova o texto:
- Em quais horarios e dias NUNCA enviar mensagem automatica:

== 18. ROTEIROS ESPECIFICOS ==
Descreva o passo a passo que a Alice deve seguir (quando ja existe um jeito certo de conduzir)
em cada situacao. Quanto mais detalhado, melhor — pode escrever como dialogo:
- Primeiro atendimento / qualificacao do paciente (o que perguntar, em que ordem):
- Pedido de preco antes de entender o que o paciente quer:
- Paciente indeciso sobre qual procedimento fazer:
- Agendamento (do interesse ate a confirmacao, incluindo sinal se houver):
- Paciente que ja e cliente e quer marcar retorno:
- Remarcacao ou cancelamento:
- Paciente que faltou:
- Contorno de objecoes (preco, tempo, medo, indecisao):
- Paciente que mandou foto, exame ou receita:
- Intercorrencia, urgencia ou duvida clinica fora do que a Alice pode responder:
- Reclamacao ou paciente insatisfeito:
- Paciente que pede desconto:
- Indicacao de amigo/familiar:
- Fechamento da conversa quando o paciente agradece ou diz que vai pensar:

== 19. TRIAGEM E QUALIFICACAO ==
- Quais perguntas a Alice deve fazer para entender o paciente antes de oferecer o horario:
- Que informacoes ela deve registrar sobre o paciente (queixa principal, objetivo, orcamento, urgencia, como conheceu a clinica, ja fez algo parecido):
- O que torna um paciente "quente" (pronto para agendar) e o que e "frio" (so curiosidade):
- Quando um paciente deve ser considerado desqualificado (fora da regiao, fora do perfil, so pesquisando preco) e como a Alice encerra com educacao:
- O que a Alice faz com pacientes que ja foram atendidos (reconhece, agradece, oferece retorno):
- Etapas do funil de vendas que a clinica usa (ex.: novo contato → em conversa → avaliacao agendada → compareceu → fechou → perdido):
- Em que momento cada etapa muda (ex.: marcou avaliacao = "avaliacao agendada"):

== 20. ANUNCIOS E MARKETING (se houver) ==
- A clinica anuncia (Instagram/Facebook/Google)? Qual o investimento e a meta:
- Mensagens que chegam de anuncio: a Alice deve tratar de forma diferente? Como (ex.: "vi seu anuncio de X"):
- Quais campanhas estao rodando e que oferta cada uma promete (para a Alice nao contradizer o anuncio):
- Quer medir resultado real dos anuncios (agendamento, comparecimento, venda)? Tem Pixel/Dataset da Meta e quem administra:
- URL do site e das paginas de destino dos anuncios:
- Quais etapas contam como venda fechada, lead qualificado e perdido:

== 21. LGPD, ETICA E LIMITES LEGAIS ==
- Regras do conselho profissional que a Alice precisa respeitar (ex.: CFM, CRO, CRBM — proibicao de divulgar preco, promessa de resultado, antes e depois):
- A Alice pode enviar fotos de antes e depois? So com autorizacao do paciente?
- Como tratar dados sensiveis (fotos, exames, historico de saude) enviados pelo WhatsApp:
- Como o paciente pede para ser removido de mensagens automaticas e o que a Alice responde:
- Termos de uso, consentimento ou aviso de privacidade que a Alice deve citar:
- Existe algo que a Alice jamais pode fazer por determinacao legal ou do conselho:

== 22. OBSERVACOES LIVRES E MATERIAIS EXTRAS ==
- Qualquer coisa importante que nao coube acima (casos dificeis que ja aconteceram, erros que quer evitar, manias dos pacientes):
- Como e um atendimento PERFEITO para voces? Descreva ou cole um exemplo real:
- Como e um atendimento RUIM? O que mais incomoda quando acontece:
- O que a clinica espera da Alice nos primeiros 30 dias (metas: mais agendamentos, menos falta, menos trabalho da recepcao):
- Cole aqui qualquer manual, script, tabela de precos, historico de conversas, textos do site/Instagram ou documentos que ajudem a treinar a Alice:
`;

// ---------------------------------------------------------------------------
// Schema do plano estruturado que a IA extrai do briefing respondido.
// Tudo opcional: o applyBriefing preenche defaults e ignora o que faltar.
// ---------------------------------------------------------------------------
const PERSONA = ["team", "clinic_secretary", "professional_secretary"] as const;
const RULE_CATS = ["agendamento", "pagamento", "tom_de_voz", "chamar_equipe", "procedimentos"] as const;
const SCRIPT_TYPES = [
  "primeiro_atendimento", "agendamento", "procedimento", "preco", "objecoes",
  "remarcacao", "pos_procedimento", "transferir", "livre",
] as const;

// --- Tolerancia ao ruido do modelo ---------------------------------------
// A IA (via tool call) as vezes manda "campo": null nos opcionais, string no
// lugar de array, enum fora da lista ou numero como texto. Nada disso pode
// derrubar o briefing inteiro: o que nao der pra mapear e ignorado e o
// applyBriefing preenche defaults. pruneEmpty roda ANTES do parse.
export function pruneEmpty(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(pruneEmpty).filter((v) => v !== undefined && v !== null && v !== "");
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = pruneEmpty(v);
      if (cleaned !== undefined && cleaned !== null && cleaned !== "") out[k] = cleaned;
    }
    return out;
  }
  return value;
}

// string que tambem aceita numero/boolean (a IA manda "numero": 177 as vezes).
const str = z.preprocess(
  (v) => (typeof v === "number" || typeof v === "boolean" ? String(v) : v),
  z.string().trim(),
);
// numero que aceita "30" (texto). Lixo ("depende") -> erro, tratado com .catch.
const num = z.coerce.number().finite();
const bool = z.preprocess(
  (v) => (typeof v === "string" ? ["true", "sim", "yes", "1"].includes(v.trim().toLowerCase()) : v),
  z.boolean(),
);
const optBool = bool.optional().catch(undefined);
const optHour = num.int().min(0).max(23).optional().catch(undefined);
const optPosInt = num.int().positive().optional().catch(undefined);
// array de strings que aceita uma string solta no lugar do array.
const strArray = z
  .preprocess((v) => (typeof v === "string" ? [v] : v), z.array(str))
  .optional()
  .catch(undefined);
const canBeNum = (v: unknown) => v != null && v !== "" && Number.isFinite(Number(v));

// enum opcional: valor fora da lista vira undefined em vez de falhar o plano.
function softEnum<T extends readonly [string, ...string[]]>(values: T) {
  const set = new Set<string>(values);
  return z.preprocess((v) => (typeof v === "string" && set.has(v) ? v : undefined), z.enum(values).optional());
}
// enum com fallback: valor fora da lista vira o padrao.
function softEnumDefault<T extends readonly [string, ...string[]]>(values: T, fallback: T[number]) {
  const set = new Set<string>(values);
  return z.preprocess((v) => (typeof v === "string" && set.has(v) ? v : fallback), z.enum(values));
}
// array que descarta itens invalidos em vez de invalidar o array inteiro.
function lenientArray<T extends z.ZodTypeAny>(item: T, keep: (v: Record<string, unknown>) => boolean) {
  return z.preprocess(
    (v) => (Array.isArray(v) ? v.filter((x) => !!x && typeof x === "object" && !Array.isArray(x) && keep(x as Record<string, unknown>)) : v),
    z.array(item).default([]).catch(() => []),
  );
}
const hasName = (v: Record<string, unknown>) => typeof v.name === "string" && v.name.trim().length > 0;

const BriefingPlanObject = z.object({
  clinic: z
    .object({
      name: str.optional(),
      whatsappPhone: str.optional(),
      timezone: str.optional(),
      workStartHour: optHour,
      workEndHour: optHour,
      workDays: str.optional(), // "1,2,3,4,5" (0=dom..6=sab)
      assistantName: str.optional(),
      assistantPersona: softEnum(PERSONA),
      assistantPersonaName: str.optional(),
      activityArea: str.optional(),
      handoffPhrase: str.optional(),
      requireDepositProof: optBool,
      notifyPhone: str.optional(),
      notifyEvents: str.optional(), // csv de new_appointment,reschedule,cancel,confirmed,human_handoff
      servicePosture: softEnum(["comercial", "consultivo"] as const),
      clinicKind: softEnum(["estetica", "medica", "ambas"] as const),
      evaluationFirst: optBool,
      allowEmojis: optBool,
      schedulingLink: str.optional(),
    })
    .default({}),
  locations: lenientArray(
    z.object({
      name: str.default("Unidade principal"),
      street: str.optional(),
      number: str.optional(),
      complement: str.optional(),
      neighborhood: str.optional(),
      city: str.optional(),
      state: str.optional(),
      zipCode: str.optional(),
      arrivalInstructions: str.optional(),
    }),
    () => true,
  ),
  procedures: lenientArray(
    z.object({
      name: str,
      durationMin: optPosInt,
      price: num.nonnegative().nullable().optional().catch(undefined),
      priceVariable: optBool,
      paymentMethods: str.optional(), // csv de dinheiro,pix,credito,debito
      offerInstallments: optBool,
      maxInstallments: num.int().min(2).max(24).optional().catch(undefined),
      paymentLink: str.optional(),
      description: str.optional(),
      goals: strArray,
      benefits: strArray,
      aliases: str.optional(), // csv
      resultTimeline: str.optional(),
    }),
    hasName,
  ),
  products: lenientArray(
    z.object({ name: str, price: num.nonnegative().nullable().optional().catch(undefined), description: str.optional() }),
    hasName,
  ),
  professionals: lenientArray(
    z.object({
      name: str,
      bio: str.optional(),
      instagram: str.optional(),
      procedureNames: strArray,
      workDays: str.optional(),
      workStartHour: optHour,
      workEndHour: optHour,
    }),
    hasName,
  ),
  faqs: lenientArray(
    z.object({
      question: str,
      answer: str,
      alternates: strArray,
      exactAnswer: optBool,
    }),
    (v) => typeof v.question === "string" && !!v.question.trim() && typeof v.answer === "string" && !!v.answer.trim(),
  ),
  templates: lenientArray(
    z.object({
      name: str,
      body: str,
      mode: softEnum(["adapt", "exact"] as const),
      whenToUse: str.optional(),
    }),
    (v) => typeof v.name === "string" && !!v.name.trim() && typeof v.body === "string" && !!v.body.trim(),
  ),
  rules: lenientArray(
    z.object({ category: z.enum(RULE_CATS), instruction: str }),
    (v) => (RULE_CATS as readonly string[]).includes(v.category as string) && typeof v.instruction === "string" && !!v.instruction.trim(),
  ),
  playbooks: lenientArray(
    z.object({
      name: str,
      scriptType: softEnum(SCRIPT_TYPES),
      triggerText: str.optional(),
      goal: str.optional(),
      steps: strArray,
    }),
    hasName,
  ),
  automations: z
    .object({
      reminders: lenientArray(
        z.object({ hoursBefore: num.int().positive(), message: str.optional() }),
        (v) => canBeNum(v.hoursBefore) && Number(v.hoursBefore) > 0,
      ),
      followups: lenientArray(
        z.object({
          afterDays: num.int().positive(),
          message: str.optional(),
          repeatMode: softEnum(["every_silence", "once"] as const),
        }),
        (v) => canBeNum(v.afterDays) && Number(v.afterDays) > 0,
      ),
      postProcedure: lenientArray(
        z.object({
          name: str.default("Pos-procedimento"),
          intervalValue: num.int().positive().catch(2).default(2),
          intervalUnit: softEnumDefault(["hours", "days"] as const, "days"),
          procedureNames: strArray,
          message: str.optional(),
        }),
        () => true,
      ),
      renewals: lenientArray(
        z.object({
          name: str.default("Renovacao"),
          intervalValue: num.int().positive().catch(6).default(6),
          intervalUnit: softEnumDefault(["months", "years"] as const, "months"),
          procedureNames: strArray,
          message: str.optional(),
        }),
        () => true,
      ),
      birthday: z
        .object({ enabled: bool.catch(false).default(false), sendHour: optHour, message: str.optional() })
        .default({ enabled: false }),
    })
    .default({}),
  warnings: z
    .preprocess((v) => (Array.isArray(v) ? v : v == null ? [] : [v]), z.array(str))
    .default([])
    .catch(() => []),
});

// Tira null / "" / undefined recursivamente ANTES de validar, pra "campo": null
// (que a IA adora mandar nos opcionais) nao derrubar o plano.
export const BriefingPlanSchema = z.preprocess((v) => pruneEmpty(v == null ? {} : v), BriefingPlanObject);

export type BriefingPlan = z.infer<typeof BriefingPlanSchema>;

const DEFAULT_MESSAGES = {
  reminder:
    "Oi {primeiro_nome}! Passando pra lembrar do seu horario de {procedimento} em {data_hora}. Consegue me confirmar sua presenca por aqui?",
  followup:
    "Oi {primeiro_nome}, tudo bem? Vi que nossa conversa ficou pela metade. Quer que eu te ajude a seguir daqui?",
  postProcedure:
    "Oi {primeiro_nome}! Como voce esta se sentindo depois do seu {procedimento}? Qualquer duvida sobre os cuidados, e so me chamar.",
  renewal:
    "Oi {primeiro_nome}! Ja faz um tempinho do seu {procedimento} e costuma ser uma boa hora de renovar. Quer que eu veja um horario pra avaliacao?",
  birthday: "Feliz aniversario, {primeiro_nome}! A equipe da {unidade} te deseja um dia otimo.",
};

const SYSTEM_PROMPT = `Voce configura a Alice, secretaria virtual de WhatsApp de uma clinica de estetica, a partir de um briefing respondido pelo dono da clinica.

Extraia TUDO que der do briefing e chame a ferramenta save_briefing com o plano estruturado.

Regras:
- whatsappPhone/notifyPhone: se o cliente citar mais de um numero, use o que ele indicar como oficial/conectado a Alice (procure por palavras como "oficial", "conectado", "confirmado"); nao invente nem combine numeros.
- workDays: string com os dias 0=domingo..6=sabado separados por virgula. "segunda a sexta" = "1,2,3,4,5". "segunda a sabado" = "1,2,3,4,5,6".
- workStartHour/workEndHour: hora inteira (ex: "das 9h as 19h" -> 9 e 19).
- assistantPersona: "team" (parte da equipe), "clinic_secretary" (secretaria da clinica) ou "professional_secretary" (secretaria de um profissional; preencha assistantPersonaName).
- servicePosture: "consultivo" se a clinica quer atendimento sem pressao, avaliacao primeiro, no ritmo do paciente (tipico de consultorio medico/cirurgico); "comercial" se quer atendimento proativo que conduz pra agenda. Na duvida, "comercial".
- clinicKind: "medica" ou "ambas" ativa travas de seguranca medica (nao diagnosticar etc). Use "estetica" so se for exclusivamente estetica nao invasiva.
- evaluationFirst: true se a clinica NAO quer que o paciente precise saber o procedimento antes da consulta.
- allowEmojis: false se a clinica pediu para nao usar emojis.
- schedulingLink: so preencha se houver um link real de auto-agendamento.
- procedures.price: numero em reais, ou null se "depende de avaliacao" (nesse caso priceVariable=true).
- paymentMethods: csv com os valores exatos dinheiro,pix,credito,debito.
- rules: transforme cada instrucao de tom de voz / politica de preco / "nunca fazer" / "quando chamar a equipe" em uma regra objetiva. Instrucoes claras e acionaveis, na 3a pessoa.
- rules.category: use EXATAMENTE uma destas cinco: agendamento, pagamento, tom_de_voz, chamar_equipe, procedimentos. Se a instrucao nao se encaixa perfeitamente, escolha a mais proxima (ex: "nao prometer resultado" -> procedimentos; "ser sempre educada, sem girias" -> tom_de_voz; "nao dar desconto, chamar o responsavel" -> chamar_equipe; "confirmar horario manualmente" -> agendamento; "nao passar valor de cirurgia" -> pagamento). Nunca invente outra categoria.
- Use apenas os valores exatos de enum pedidos em cada campo. Quando nao souber um campo, omita-o (nao mande null nem texto livre).
- automations: so inclua o que o cliente pediu. Se ele nao especificou a mensagem, deixe message vazio (o sistema usa um padrao). Para pos-procedimento/renovacao, mapeie procedureNames pelos nomes exatos dos procedimentos do briefing (vazio = todos). "Recuperacao de paciente inativo" tambem e uma renewal (intervalUnit months/years, procedureNames vazio pra valer de qualquer procedimento).
- Secao "perguntas e objecoes mais comuns": cada objecao com resposta vira uma regra (rules, category "procedimentos" ou "pagamento" conforme o assunto) OU um playbook com scriptType "objecoes" contendo os pares pergunta/resposta como passos — escolha o que ficar mais claro pro caso. Nunca ignore essa secao.
- Secao "mensagens prontas": cada mensagem colada pelo cliente vira um template com mode "exact" (o cliente deu o texto literal) e o whenToUse explicando quando usar. Mensagens de boas-vindas, sinal, confirmacao, "nao entendi" e despedida sao itens tipicos.
- Secao "roteiros especificos": cada resposta vira um playbook, com scriptType o mais proximo da lista (primeiro_atendimento, preco, agendamento, remarcacao, objecoes, transferir). Transforme a descricao em passos curtos e acionaveis.
- Politica de cancelamento, devolucao do sinal e palavras-gatilho de transferencia viram rules de categoria "agendamento" (cancelamento/sinal) ou "chamar_equipe" (palavras-gatilho e criterios de transferencia).
- Secoes "sobre a clinica e o publico", "regras de ouro", "transferencia", "agendamento", "sinal/pagamento/financeiro", "triagem e qualificacao" e "LGPD/etica": cada instrucao objetiva vira uma rule (agendamento, pagamento, tom_de_voz, chamar_equipe ou procedimentos conforme o assunto); diferenciais, historia da clinica, equipe de apoio, politicas e informacoes factuais viram faqs (com a pergunta que o paciente faria); passo a passo de conduta vira playbook. Palavras proibidas e vocabulario preferido viram rule de tom_de_voz.
- Secao "procedimentos": indicacoes, contraindicacoes, preparo, cuidados pos, efeitos esperados e numero de sessoes que nao tem campo proprio entram na description do procedimento (curto) e/ou viram faqs ("Quais os cuidados depois de X?"). Nunca afirme beneficio ou contraindicacao que o cliente nao escreveu.
- Secao "pacotes, combos, promocoes": cada pacote/promocao com valor vira uma faq e, se houver regra de quem pode oferecer, uma rule de pagamento.
- Secao "anuncios e marketing": ofertas de campanha e tratamento de lead de anuncio viram rules/faqs; dados de Pixel/token/etapas NAO sao configurados aqui - registre em warnings para configuracao manual.
- Itens que o painel configura a parte (intervalo de almoco, feriados, bloqueios de agenda, Google Agenda, importacao de contatos, etapas do funil, fotos de procedimento, chave Pix): registre-os em warnings de forma curta e objetiva ("Configurar manualmente: intervalo de almoco 12h-13h30") para a equipe aplicar depois.
- Se o cliente colar um manual, script ou historico de conversa fora do formato do questionario (secao de observacoes/materiais extras ou em qualquer lugar do texto), extraia dele TUDO que der pras categorias acima (procedimentos, precos, tom de voz, mensagens exatas, objecoes, roteiros) em vez de jogar so em "warnings". So use warnings pro que realmente nao deu pra aproveitar.
- warnings: liste o que ficou ambiguo, incompleto ou que voce nao conseguiu mapear, pra pessoa revisar depois.
- Nao invente valor, prazo, beneficio ou politica que nao esteja no briefing.`;

const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "save_briefing",
      description: "Salva o plano de configuracao extraido do briefing.",
      parameters: {
        type: "object",
        properties: {
          clinic: {
            type: "object",
            properties: {
              name: { type: "string" },
              whatsappPhone: { type: "string" },
              timezone: { type: "string" },
              workStartHour: { type: "integer" },
              workEndHour: { type: "integer" },
              workDays: { type: "string" },
              assistantName: { type: "string" },
              assistantPersona: { type: "string", enum: PERSONA as unknown as string[] },
              assistantPersonaName: { type: "string" },
              activityArea: { type: "string" },
              handoffPhrase: { type: "string" },
              requireDepositProof: { type: "boolean" },
              notifyPhone: { type: "string" },
              notifyEvents: { type: "string" },
              servicePosture: { type: "string", enum: ["comercial", "consultivo"] },
              clinicKind: { type: "string", enum: ["estetica", "medica", "ambas"] },
              evaluationFirst: { type: "boolean" },
              allowEmojis: { type: "boolean" },
              schedulingLink: { type: "string" },
            },
          },
          locations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                street: { type: "string" },
                number: { type: "string" },
                complement: { type: "string" },
                neighborhood: { type: "string" },
                city: { type: "string" },
                state: { type: "string" },
                zipCode: { type: "string" },
                arrivalInstructions: { type: "string" },
              },
              required: ["name"],
            },
          },
          procedures: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                durationMin: { type: "integer" },
                price: { type: ["number", "null"] },
                priceVariable: { type: "boolean" },
                paymentMethods: { type: "string" },
                offerInstallments: { type: "boolean" },
                maxInstallments: { type: "integer" },
                paymentLink: { type: "string" },
                description: { type: "string" },
                goals: { type: "array", items: { type: "string" } },
                benefits: { type: "array", items: { type: "string" } },
                aliases: { type: "string" },
                resultTimeline: { type: "string" },
              },
              required: ["name"],
            },
          },
          products: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" }, price: { type: ["number", "null"] }, description: { type: "string" } },
              required: ["name"],
            },
          },
          professionals: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                bio: { type: "string" },
                instagram: { type: "string" },
                procedureNames: { type: "array", items: { type: "string" } },
                workDays: { type: "string" },
                workStartHour: { type: "integer" },
                workEndHour: { type: "integer" },
              },
              required: ["name"],
            },
          },
          faqs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                question: { type: "string" },
                answer: { type: "string" },
                alternates: { type: "array", items: { type: "string" } },
                exactAnswer: { type: "boolean" },
              },
              required: ["question", "answer"],
            },
          },
          templates: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                body: { type: "string" },
                mode: { type: "string", enum: ["adapt", "exact"] },
                whenToUse: { type: "string" },
              },
              required: ["name", "body"],
            },
          },
          rules: {
            type: "array",
            items: {
              type: "object",
              properties: { category: { type: "string", enum: RULE_CATS as unknown as string[] }, instruction: { type: "string" } },
              required: ["category", "instruction"],
            },
          },
          playbooks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                scriptType: { type: "string", enum: SCRIPT_TYPES as unknown as string[] },
                triggerText: { type: "string" },
                goal: { type: "string" },
                steps: { type: "array", items: { type: "string" } },
              },
              required: ["name"],
            },
          },
          automations: {
            type: "object",
            properties: {
              reminders: {
                type: "array",
                items: { type: "object", properties: { hoursBefore: { type: "integer" }, message: { type: "string" } }, required: ["hoursBefore"] },
              },
              followups: {
                type: "array",
                items: {
                  type: "object",
                  properties: { afterDays: { type: "integer" }, message: { type: "string" }, repeatMode: { type: "string", enum: ["every_silence", "once"] } },
                  required: ["afterDays"],
                },
              },
              postProcedure: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    intervalValue: { type: "integer" },
                    intervalUnit: { type: "string", enum: ["hours", "days"] },
                    procedureNames: { type: "array", items: { type: "string" } },
                    message: { type: "string" },
                  },
                },
              },
              renewals: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    intervalValue: { type: "integer" },
                    intervalUnit: { type: "string", enum: ["months", "years"] },
                    procedureNames: { type: "array", items: { type: "string" } },
                    message: { type: "string" },
                  },
                },
              },
              birthday: {
                type: "object",
                properties: { enabled: { type: "boolean" }, sendHour: { type: "integer" }, message: { type: "string" } },
              },
            },
          },
          warnings: { type: "array", items: { type: "string" } },
        },
        required: [],
      },
    },
  },
];

export interface ParseResult {
  ok: boolean;
  plan?: BriefingPlan;
  error?: string;
}

export async function parseBriefing(text: string): Promise<ParseResult> {
  const clean = text.trim();
  if (clean.length < 40) return { ok: false, error: "O briefing está muito curto. Cole o questionário respondido." };

  let raw: unknown;
  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: clean.slice(0, 150_000) },
      ],
      tools,
      tool_choice: { type: "function", function: { name: "save_briefing" } },
    });
    const call = response.choices[0]?.message?.tool_calls?.[0];
    if (!call || call.type !== "function") return { ok: false, error: "A IA não conseguiu interpretar o briefing. Tente reescrever de forma mais estruturada." };
    try {
      raw = JSON.parse(call.function.arguments || "{}");
    } catch {
      return { ok: false, error: "A IA devolveu um JSON inválido. Tente de novo em instantes." };
    }
  } catch (err) {
    console.error("Falha ao interpretar briefing:", err);
    return { ok: false, error: "Erro ao chamar a IA para interpretar o briefing. Tente de novo em instantes." };
  }

  const parsed = BriefingPlanSchema.safeParse(raw);
  if (!parsed.success) {
    const spots = [...new Set(parsed.error.issues.map((i) => i.path.slice(0, 2).join(".")).filter(Boolean))].slice(0, 6);
    console.error("Plano de briefing invalido:", JSON.stringify(parsed.error.issues.slice(0, 15)));
    return {
      ok: false,
      error:
        "A IA devolveu dados fora do formato esperado" +
        (spots.length ? ` (em: ${spots.join(", ")})` : "") +
        ". Tente de novo; se continuar, ajuste essas partes do briefing.",
    };
  }

  // Avisa sobre itens que a IA mandou mas nao deram pra interpretar (categoria
  // de regra invalida, item sem nome, etc): entram nos warnings pra revisao.
  const plan = parsed.data;
  const pruned = pruneEmpty(raw ?? {}) as Record<string, unknown>;
  const dropped: string[] = [];
  const LABELS: Record<string, string> = {
    procedures: "procedimento(s)", professionals: "profissional(is)", faqs: "FAQ",
    templates: "mensagem(ns) pronta(s)", rules: "regra(s)", playbooks: "roteiro(s)",
    locations: "endereço(s)", products: "produto(s)",
  };
  for (const k of Object.keys(LABELS)) {
    const sent = Array.isArray(pruned[k]) ? (pruned[k] as unknown[]).length : 0;
    const kept = Array.isArray((plan as Record<string, unknown>)[k]) ? ((plan as Record<string, unknown>)[k] as unknown[]).length : 0;
    if (sent - kept > 0) dropped.push(`${sent - kept} ${LABELS[k]} não puderam ser interpretados e foram ignorados — confira no briefing.`);
  }
  if (dropped.length) plan.warnings = [...plan.warnings, ...dropped];
  return { ok: true, plan };
}

export interface ApplyResult {
  created: Record<string, number>;
  skipped: Record<string, number>;
  clinicFields: string[];
  warnings: string[];
}

const norm = (s: string) => s.trim().toLowerCase();

// A IA extrai o telefone como o cliente escreveu no briefing, que quase
// sempre omite o DDI (ex: "81 99110-1868"). O numero conectado no resto do
// sistema e sempre 55DDDNUMERO - sem o "55" a Alice fica com um numero que
// nao bate com nada (pareamento, avisos). So DDD+numero (10 ou 11 digitos)
// ganha o prefixo; qualquer outro tamanho (ja tem 55, ou e algo fora do
// padrao) passa direto pro cliente revisar.
function normalizeBrPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.length === 10 || digits.length === 11 ? `55${digits}` : digits;
}

// Aplica o plano na clinica. Aditivo e idempotente: cria o que ainda nao existe
// (casa por nome), atualiza so os campos escalares que o plano trouxe, e nunca
// apaga nada. Seguro re-rodar.
export async function applyBriefing(clinicId: string, plan: BriefingPlan, actorName: string | null): Promise<ApplyResult> {
  const created: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);

  // 1. Campos da clinica
  const c = plan.clinic;
  const clinicData: Record<string, unknown> = {};
  const setIf = (key: string, val: unknown) => {
    if (val !== undefined && val !== "" && val !== null) clinicData[key] = val;
  };
  setIf("name", c.name);
  setIf("whatsappPhone", c.whatsappPhone && normalizeBrPhone(c.whatsappPhone));
  setIf("timezone", c.timezone);
  setIf("workStartHour", c.workStartHour);
  setIf("workEndHour", c.workEndHour);
  setIf("workDays", c.workDays);
  setIf("assistantName", c.assistantName);
  setIf("assistantPersona", c.assistantPersona);
  setIf("assistantPersonaName", c.assistantPersonaName);
  setIf("activityArea", c.activityArea);
  setIf("handoffPhrase", c.handoffPhrase);
  if (c.requireDepositProof !== undefined) clinicData.requireDepositProof = c.requireDepositProof;
  setIf("notifyPhone", c.notifyPhone && normalizeBrPhone(c.notifyPhone));
  setIf("notifyEvents", c.notifyEvents);
  setIf("servicePosture", c.servicePosture);
  setIf("clinicKind", c.clinicKind);
  if (c.evaluationFirst !== undefined) clinicData.evaluationFirst = c.evaluationFirst;
  if (c.allowEmojis !== undefined) clinicData.allowEmojis = c.allowEmojis;
  setIf("schedulingLink", c.schedulingLink);

  // O numero de avisos pode ser o proprio numero conectado (cai na conversa
  // "Mensagem pra mim"; o eco e ignorado no webhook, sem loop).

  const clinicFields = Object.keys(clinicData);
  if (clinicFields.length) await prisma.clinic.update({ where: { id: clinicId }, data: clinicData });

  // 2. Enderecos
  const existingLocs = await prisma.clinicLocation.findMany({ where: { clinicId } });
  const locNames = new Set(existingLocs.map((l) => norm(l.name)));
  for (const [i, loc] of plan.locations.entries()) {
    if (locNames.has(norm(loc.name))) { bump(skipped, "enderecos"); continue; }
    await prisma.clinicLocation.create({
      data: {
        clinicId, name: loc.name, order: existingLocs.length + i,
        street: loc.street || null, number: loc.number || null, complement: loc.complement || null,
        neighborhood: loc.neighborhood || null, city: loc.city || null, state: loc.state || null,
        zipCode: loc.zipCode || null, arrivalInstructions: loc.arrivalInstructions || null,
      },
    });
    bump(created, "enderecos");
  }

  // 3. Procedimentos
  const existingProcs = await prisma.procedure.findMany({ where: { clinicId } });
  const procByName = new Map(existingProcs.map((p) => [norm(p.name), p.id]));
  for (const p of plan.procedures) {
    if (procByName.has(norm(p.name))) { bump(skipped, "procedimentos"); continue; }
    const proc = await prisma.procedure.create({
      data: {
        clinicId, name: p.name,
        durationMin: p.durationMin ?? 60,
        price: p.priceVariable ? null : p.price ?? null,
        priceVariable: p.priceVariable ?? false,
        offerInstallments: p.offerInstallments ?? false,
        maxInstallments: p.maxInstallments ?? null,
        paymentMethods: p.paymentMethods ?? "",
        paymentLink: p.paymentLink || null,
        description: p.description || null,
        goals: p.goals?.length ? p.goals.join("\n") : null,
        benefits: p.benefits?.length ? p.benefits.join("\n") : null,
        aliases: p.aliases || null,
        resultTimeline: p.resultTimeline || null,
      },
    });
    procByName.set(norm(p.name), proc.id);
    bump(created, "procedimentos");
  }

  // 4. Produtos
  const existingProducts = await prisma.product.findMany({ where: { clinicId } });
  const productNames = new Set(existingProducts.map((p) => norm(p.name)));
  for (const p of plan.products) {
    if (productNames.has(norm(p.name))) { bump(skipped, "produtos"); continue; }
    await prisma.product.create({ data: { clinicId, name: p.name, price: p.price ?? null, description: p.description || null } });
    bump(created, "produtos");
  }

  // 5. Profissionais
  const existingPros = await prisma.professional.findMany({ where: { clinicId } });
  const proNames = new Set(existingPros.map((p) => norm(p.name)));
  for (const pro of plan.professionals) {
    if (proNames.has(norm(pro.name))) { bump(skipped, "profissionais"); continue; }
    const procIds = (pro.procedureNames ?? [])
      .map((n) => procByName.get(norm(n)))
      .filter((id): id is string => !!id);
    await prisma.professional.create({
      data: {
        clinicId, name: pro.name, bio: pro.bio || null, instagram: pro.instagram || null,
        workDays: pro.workDays || null, workStartHour: pro.workStartHour ?? null, workEndHour: pro.workEndHour ?? null,
        ...(procIds.length ? { procedures: { connect: procIds.map((id) => ({ id })) } } : {}),
      },
    });
    bump(created, "profissionais");
  }

  // 6. FAQ
  const existingFaqs = await prisma.clinicFaq.findMany({ where: { clinicId } });
  const faqQ = new Set(existingFaqs.map((f) => norm(f.question)));
  for (const f of plan.faqs) {
    if (faqQ.has(norm(f.question))) { bump(skipped, "faq"); continue; }
    await prisma.clinicFaq.create({
      data: {
        clinicId, question: f.question, answer: f.answer,
        alternates: f.alternates?.length ? f.alternates.join("\n") : "",
        exactAnswer: f.exactAnswer ?? false,
      },
    });
    bump(created, "faq");
  }

  // 7. Mensagens prontas
  const existingTpls = await prisma.messageTemplate.findMany({ where: { clinicId } });
  const tplNames = new Set(existingTpls.map((t) => norm(t.name)));
  for (const t of plan.templates) {
    if (tplNames.has(norm(t.name))) { bump(skipped, "mensagens_prontas"); continue; }
    await prisma.messageTemplate.create({
      data: { clinicId, name: t.name, body: t.body, mode: t.mode ?? "adapt", whenToUse: t.whenToUse || null },
    });
    bump(created, "mensagens_prontas");
  }

  // 8. Regras — recomendadas do perfil atual + as do briefing
  const { added: seeded } = await reseedRulesForProfile(clinicId);
  if (seeded) created.regras_recomendadas = seeded;
  const existingRules = await prisma.customRule.findMany({ where: { clinicId }, select: { instruction: true } });
  const ruleSet = new Set(existingRules.map((r) => norm(r.instruction ?? "")));
  for (const r of plan.rules) {
    if (!r.instruction || ruleSet.has(norm(r.instruction))) { bump(skipped, "regras"); continue; }
    await prisma.customRule.create({
      data: { clinicId, category: r.category, rawInput: "(via briefing)", instruction: r.instruction, status: "active" },
    });
    ruleSet.add(norm(r.instruction));
    bump(created, "regras");
  }

  // 9. Roteiros
  const existingPbs = await prisma.playbook.findMany({ where: { clinicId } });
  const pbNames = new Set(existingPbs.map((p) => norm(p.name)));
  for (const pb of plan.playbooks) {
    if (pbNames.has(norm(pb.name))) { bump(skipped, "roteiros"); continue; }
    await prisma.playbook.create({
      data: {
        clinicId, name: pb.name, scriptType: pb.scriptType ?? "livre",
        triggerText: pb.triggerText || null, goal: pb.goal || null,
        steps: pb.steps?.length ? pb.steps.join("\n") : "",
      },
    });
    bump(created, "roteiros");
  }

  // 10. Automacoes
  const a = plan.automations;
  const existingReminders = await prisma.reminderRule.findMany({ where: { clinicId } });
  for (const r of a.reminders) {
    if (existingReminders.some((x) => x.hoursBefore === r.hoursBefore)) { bump(skipped, "lembretes"); continue; }
    await prisma.reminderRule.create({ data: { clinicId, hoursBefore: r.hoursBefore, message: r.message || DEFAULT_MESSAGES.reminder } });
    bump(created, "lembretes");
  }

  const existingFups = await prisma.followUpRule.findMany({ where: { clinicId }, orderBy: { order: "asc" } });
  let nextOrder = (existingFups.at(-1)?.order ?? 0) + 1;
  for (const f of a.followups) {
    await prisma.followUpRule.create({
      data: {
        clinicId, order: nextOrder++, name: `Recontato ${f.afterDays}d`,
        afterDays: f.afterDays, afterMinutes: 0,
        message: f.message || DEFAULT_MESSAGES.followup,
        repeatMode: f.repeatMode ?? "every_silence",
      },
    });
    bump(created, "recontatos");
  }

  const existingPP = await prisma.postProcedureRule.findMany({ where: { clinicId } });
  const ppNames = new Set(existingPP.map((x) => norm(x.name)));
  for (const pp of a.postProcedure) {
    if (ppNames.has(norm(pp.name))) { bump(skipped, "pos_procedimento"); continue; }
    const ids = (pp.procedureNames ?? []).map((n) => procByName.get(norm(n))).filter((x): x is string => !!x);
    await prisma.postProcedureRule.create({
      data: {
        clinicId, name: pp.name, message: pp.message || DEFAULT_MESSAGES.postProcedure,
        intervalValue: pp.intervalValue, intervalUnit: pp.intervalUnit, procedureIds: ids.join(","),
      },
    });
    bump(created, "pos_procedimento");
  }

  const existingRn = await prisma.renewalRule.findMany({ where: { clinicId } });
  const rnNames = new Set(existingRn.map((x) => norm(x.name)));
  for (const rn of a.renewals) {
    if (rnNames.has(norm(rn.name))) { bump(skipped, "renovacoes"); continue; }
    const ids = (rn.procedureNames ?? []).map((n) => procByName.get(norm(n))).filter((x): x is string => !!x);
    await prisma.renewalRule.create({
      data: {
        clinicId, name: rn.name, message: rn.message || DEFAULT_MESSAGES.renewal,
        intervalValue: rn.intervalValue, intervalUnit: rn.intervalUnit, procedureIds: ids.join(","),
      },
    });
    bump(created, "renovacoes");
  }

  if (a.birthday.enabled) {
    const existingBd = await prisma.birthdayRule.count({ where: { clinicId } });
    if (existingBd === 0) {
      await prisma.birthdayRule.create({
        data: { clinicId, name: "Aniversario do paciente", message: a.birthday.message || DEFAULT_MESSAGES.birthday, sendHour: a.birthday.sendHour ?? 9 },
      });
      bump(created, "aniversario");
    } else {
      bump(skipped, "aniversario");
    }
  }

  await logActivity({
    clinicId, type: "briefing_applied", area: "clinica",
    title: "Configuração aplicada via briefing",
    description: Object.entries(created).map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(", ") || "sem novidades",
    actorName,
  });

  return { created, skipped, clinicFields, warnings: plan.warnings };
}
