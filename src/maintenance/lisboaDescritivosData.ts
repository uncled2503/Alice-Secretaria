// DESCRITIVOS COMERCIAIS DA LISBOA (material do MKT, 14/10/2026): texto curto e comercial de cada procedimento + a pergunta
// que a Alice faz pra continuar a conversa. Aplicado por applyLisboaDescritivos (so preenche descricao VAZIA, por nome).
// Pequenas correcoes de concordancia em relacao ao documento ("aplicado na braços" -> "nos braços", "região de do sutiã" ->
// "região do sutiã"); o conteudo nao muda.

export interface Descritivo {
  name: string;
  text: string;
  question: string;
}

const S = " Na Lisboa, a indicação e o planejamento são personalizados de acordo com a região e com o objetivo de cada paciente.";

const Q = {
  firm: "O que mais te incomoda hoje: flacidez, perda de firmeza ou qualidade da pele?",
  obj: "Qual é a sua principal queixa ou objetivo com esse tratamento?",
  cel: "A celulite te incomoda mais em qual região?",
  flac: "Em qual região você percebe mais flacidez?",
  gl: "Qual região de gordura localizada você gostaria de tratar?",
  enc: "Posso encaminhar sua dúvida para a nossa equipe responsável para te orientar com segurança?",
  vaso: "Os vasinhos que te incomodam ficam em qual região?",
  glut: "O que você gostaria de melhorar mais na região glútea: contorno, firmeza ou projeção?",
  pele: "O que você mais gostaria de melhorar na pele: manchas, textura, poros, hidratação ou viço?",
  rosto: "O que você gostaria de valorizar mais no seu rosto: contorno, projeção, sustentação ou equilíbrio das proporções?",
  tonus: "Qual região você gostaria de trabalhar em relação a tônus e fortalecimento?",
  estria: "Em qual região as estrias mais te incomodam?",
  tatu: "Você quer remover tatuagem ou micropigmentação? Em qual região e qual o tamanho aproximado?",
  uf: "Você quer cuidar mais de flacidez, contorno ou estímulo de colágeno?",
  labio: "Você busca mais definição, hidratação ou também gostaria de aumentar o volume dos lábios?",
  olho: "O que mais te incomoda na região dos olhos: profundidade, aspecto cansado ou diferença de contorno?",
  pos: "Você está em qual fase do pós-operatório e já possui liberação para realizar os cuidados?",
  relax: "Você busca mais relaxamento, aliviar retenção/inchaço ou um cuidado corporal completo?",
  clar: "Qual região você gostaria de cuidar e o que mais te incomoda no aspecto da pele?",
  olhar: "O que mais te incomoda na região dos olhos hoje: inchaço, ressecamento ou aspecto cansado?",
};

// frases de região
const ANT = "na parte anterior das coxas";
const INT = "na parte interna das coxas";
const LAT = "na lateral das coxas";
const POS = "na parte posterior das coxas";
const GLU = "na região de glúteos";
const ABD = "na região do abdômen";
const BRA = "na região de braços";
const FLA = "na região de flancos";
const COS = "na região de costas";
const CUL = "na região do culote";
const SUT = "na região do sutiã";
const BAN = "na região de bananinha do bumbum";

export const DESCRITIVOS: Descritivo[] = [];
const add = (name: string, text: string, question: string) => DESCRITIVOS.push({ name, text, question });
const many = (prefix: string, items: [string, string][], build: (p: string) => string, question: string) => {
  for (const [suffix, phrase] of items) add(`${prefix} ${suffix}`.trim(), build(phrase), question);
};

// ---------------- INJETAVEIS E PROCEDIMENTOS PROFISSIONAIS ----------------
add("Bioestimulador Corporal", "Procedimento injetável voltado ao estímulo de colágeno em áreas corporais, utilizado principalmente em protocolos para melhorar firmeza, textura e qualidade da pele. A indicação e a quantidade de produto dependem de avaliação profissional.", Q.firm);
add("Bioestimulador de Colágeno", "Procedimento injetável que estimula o próprio organismo a produzir colágeno ao longo do tempo. É utilizado para melhorar firmeza, sustentação e qualidade da pele de forma gradual e natural." + S, Q.firm);
add("Bioestimulador de Colágeno (Nutriex)", "Bioestimulador injetável da linha Nutriex, utilizado em protocolos de estímulo de colágeno e melhora progressiva da firmeza e qualidade da pele. A escolha do produto depende da avaliação.", Q.firm);
add("Bioestimulador de Colágeno (Radiesse)", "Bioestimulador à base de hidroxiapatita de cálcio, utilizado para estimular colágeno e melhorar firmeza, sustentação e qualidade da pele. Em algumas regiões também pode contribuir para contorno, conforme indicação profissional." + S, Q.firm);
add("Bioestimulador de Colágeno (Sculptra)", "Bioestimulador à base de ácido poli-L-láctico, indicado em protocolos de estímulo gradual de colágeno para melhorar firmeza, espessura e qualidade da pele ao longo das semanas e meses." + S, Q.firm);
add("Bioestimulador de colágeno (ELLEVA)", "Bioestimulador à base de ácido poli-L-láctico, utilizado para estimular colágeno de forma progressiva, ajudando na firmeza, sustentação e melhora da qualidade da pele." + S, Q.firm);

add("Enzimas", "Procedimento injetável com ativos definidos de acordo com o objetivo do protocolo. Pode ser utilizado em tratamentos corporais específicos, sempre após avaliação e indicação profissional.", Q.obj);
add("Enzima Capilar", "Aplicação injetável de ativos na região do couro cabeludo em protocolos capilares. A composição e a indicação devem ser definidas por profissional habilitado." + S, Q.obj);
many("Enzima Celulite", [["Frente de Coxas", ANT], ["Glúteos", GLU], ["Interno de Coxas", INT], ["Lateral de Coxas", LAT], ["Posterior de Coxas", POS]],
  (p) => `Aplicação de ativos injetáveis ${p} em protocolos para celulite. A composição, indicação e número de sessões dependem de avaliação profissional.`, Q.cel);
many("Enzima Flacidez", [["Abdomen", ABD], ["Braços", BRA], ["Coxas", "na região de coxas"], ["Flancos", FLA], ["Frente de Coxas", ANT], ["GL Sutiã", SUT], ["Interno de Coxas", INT], ["Lateral de Coxas", LAT]],
  (p) => `Aplicação de ativos injetáveis ${p} em protocolos voltados à melhora da qualidade e firmeza da pele. A formulação utilizada depende da avaliação profissional.`, Q.flac);
many("Enzima GL", [["Abdomen", ABD], ["Bananinha Glúteos", "na região de bananinha dos glúteos"], ["Braços", BRA], ["Culote", CUL], ["Flancos", FLA], ["Sutiã", SUT]],
  (p) => `Aplicação de ativos injetáveis em protocolo para gordura localizada ${p}. A composição e indicação são definidas após avaliação.`, Q.gl);
add("Enzima Intramuscular", "Aplicação intramuscular de substância ou combinação de ativos somente quando houver indicação e prescrição/protocolo definido pelo profissional habilitado. A Alice deve encaminhar dúvidas clínicas para a equipe." + S, Q.enc);
add("Enzima de Papada", "Aplicação de ativos injetáveis na região da papada em protocolos para gordura localizada. A indicação depende da quantidade de gordura, anatomia e avaliação profissional.", Q.gl);
add("Escleroterapia", "Procedimento injetável utilizado para tratamento de pequenos vasos aparentes, conhecido na estética como secagem de vasinhos. Requer avaliação para definir se os vasos são adequados ao procedimento.", Q.vaso);
add("Fios de PDO Lisos", "Fios absorvíveis de PDO inseridos na pele com objetivo principal de estimular colágeno e melhorar a qualidade e firmeza da região tratada. O efeito é progressivo." + S, Q.firm);
add("Fios de Sustentação", "Procedimento minimamente invasivo com fios absorvíveis posicionados para promover sustentação e estímulo de colágeno. A indicação depende da anatomia e grau de flacidez." + S, Q.firm);
add("Harmonização Glútea", "Planejamento estético da região glútea que pode combinar técnicas injetáveis e/ou bioestímulo para melhorar contorno, proporção e qualidade da pele. O plano é individualizado após avaliação.", Q.obj);
add("Hidrolipoclasia", "Procedimento corporal em que uma solução é infiltrada no tecido adiposo e associada a ultrassom em protocolos para gordura localizada. É um procedimento que exige avaliação e execução por profissional habilitado.", Q.gl);
add("Lavieen Full Face PDRN", "Protocolo que combina Lavieen em toda a face com PDRN, buscando associar renovação fracionada da pele a um cuidado de reparação e qualidade cutânea. A sequência e indicação devem seguir o protocolo da clínica." + S, Q.pele);
add("Lavieen Full Face, Colo e Pescoço c PDRN", "Protocolo que combina Lavieen em face, colo e pescoço com PDRN, associando renovação da pele a cuidados voltados à hidratação e qualidade cutânea." + S, Q.pele);
add("Microtox", "Técnica com microinjeções superficiais de toxina botulínica em protocolos selecionados para qualidade da pele, poros e linhas finas. A indicação e técnica dependem da avaliação profissional.", Q.obj);
many("Ozonio Celulite", [["Glúteos", GLU], ["Interno de Coxas", INT], ["Lateral do Coxas", LAT], ["Posterior de Coxas", POS]],
  (p) => `Aplicação de ozônio medicinal ${p} em protocolo para celulite. A técnica e indicação devem ser definidas por profissional habilitado.${S}`, Q.cel);
many("Ozonio Estrias", [["Abdomen", ABD], ["Frente de Coxas", ANT], ["Glúteos", GLU], ["Interno de Coxas", INT], ["Lateral de Coxas", LAT], ["Posterior de Coxas", POS]],
  (p) => `Aplicação de ozônio medicinal ${p} em protocolo para estrias e qualidade do tecido, conforme avaliação profissional.`, Q.estria);
many("Ozonio Flacidez", [["Abdomen", ABD], ["Frente de Coxas", ANT], ["Lateral de Coxas", LAT], ["Posterior de Coxas", POS]],
  (p) => `Aplicação de ozônio medicinal ${p} em protocolo para qualidade da pele e flacidez, conforme avaliação.`, Q.flac);
many("Ozonio GL", [["Abdomen", ABD], ["do Culote", CUL], ["do Sutiã", SUT], ["dos Flancos", FLA]],
  (p) => `Aplicação de ozônio medicinal ${p} em protocolo para gordura localizada. A indicação e técnica dependem de avaliação profissional.`, Q.gl);
add("Ozonioterapia Sistêmica", "Uso de ozônio medicinal em protocolo sistêmico específico, somente quando houver indicação e execução por profissional habilitado. A Alice deve encaminhar dúvidas sobre benefícios, contraindicações e forma de aplicação para a equipe." + S, Q.enc);
add("PDRN", "Procedimento com polidesoxirribonucleotídeos/polinucleotídeos utilizados em protocolos de qualidade da pele, hidratação e revitalização. A forma de aplicação e indicação dependem da avaliação.", Q.pele);
add("Preenchimento Bigode Chinês", "Preenchimento injetável do sulco nasogeniano, conhecido como bigode chinês, realizado para suavizar a depressão e melhorar a transição entre as regiões da face. A quantidade depende da anatomia." + S, Q.rosto);
add("Preenchimento Código de Barras", "Preenchimento realizado na região ao redor dos lábios para suavizar linhas verticais finas, preservando a naturalidade e a movimentação da região." + S, Q.rosto);
add("Preenchimento Facial", "Procedimento injetável, geralmente com ácido hialurônico, utilizado para reposição de volume, contorno ou correção de sulcos em áreas selecionadas da face. O planejamento é individualizado." + S, Q.rosto);
add("Preenchimento Labial", "Procedimento injetável para melhorar hidratação, contorno, definição e/ou volume dos lábios, respeitando a anatomia e o objetivo da paciente." + S, Q.labio);
add("Preenchimento Mandíbula", "Preenchimento injetável na região mandibular para melhorar definição, contorno e proporção do terço inferior da face. A quantidade e os pontos dependem da avaliação.", Q.rosto);
add("Preenchimento Marionete", "Preenchimento injetável das linhas que descem dos cantos da boca em direção ao queixo, conhecidas como linhas de marionete. O objetivo é suavizar a depressão e melhorar a transição dessa região, respeitando a anatomia facial." + S, Q.rosto);
add("Preenchimento de Glúteo", "Procedimento injetável realizado na região glútea para melhorar contorno, projeção, simetria ou proporção, conforme o produto e a técnica indicados. O planejamento e a quantidade utilizada dependem de avaliação profissional.", Q.glut);
add("Preenchimento de Malar", "Preenchimento injetável da região das maçãs do rosto, utilizado para melhorar projeção, sustentação e proporção facial. O objetivo é valorizar o contorno mantendo naturalidade." + S, Q.rosto);
add("Preenchimento de Olheiras", "Preenchimento injetável da região infraorbital em casos selecionados, utilizado para suavizar sulcos e a aparência de profundidade das olheiras. A indicação exige avaliação cuidadosa da anatomia e do tipo de olheira.", Q.olho);
add("Skinbooster", "Procedimento injetável com ácido hialurônico de baixa reticulação, voltado principalmente à hidratação profunda e melhora da qualidade, viço e textura da pele. Não tem o mesmo objetivo de volumização de um preenchimento." + S, Q.pele);
add("Skinbooster Área dos Olhos", "Skinbooster aplicado na região periocular em casos selecionados, com foco em hidratação e qualidade da pele fina ao redor dos olhos. A indicação depende da avaliação da região.", Q.pele);
add("Tirzepatida 2,5 mg / 5 mg", "Medicamento injetável de prescrição médica utilizado em indicações específicas. A Alice não deve orientar dose, frequência, indicar para emagrecimento, avaliar contraindicações ou afirmar que a paciente pode utilizar. Como envolve medicamento de prescrição, indicação, dose e acompanhamento precisam ser definidos pelo profissional responsável. A Alice deve apenas orientar o próximo passo e encaminhar para avaliação.", Q.enc);
add("Retatrutida", "Item cadastrado como tratamento medicamentoso/injetável. A Alice não deve oferecer, indicar, orientar dose ou explicar uso clínico sem protocolo médico validado. Como envolve medicamento de prescrição, indicação, dose e acompanhamento precisam ser definidos pelo profissional responsável. A Alice deve apenas orientar o próximo passo e encaminhar para avaliação.", Q.enc);

// ---------------- TECNOLOGIAS ----------------
add("Corrente Russa", "Eletroterapia que utiliza estímulos elétricos para provocar contrações musculares controladas. É utilizada em protocolos de fortalecimento, tônus e melhora da firmeza muscular.", Q.tonus);
many("Corrente Russa", [["Abdomen", ABD], ["Braços", BRA], ["Frente de Coxas", ANT], ["Interno de Coxas", INT], ["Lateral de Coxas", LAT], ["Posterior de Coxas", POS]],
  (p) => `Aplicação de Corrente Russa ${p}, utilizando estímulos elétricos para contrações musculares controladas, com foco em tônus e fortalecimento da musculatura.`, Q.tonus);
add("Corrente Russa Glúteos", `Aplicação de Corrente Russa ${GLU}, utilizando estímulos elétricos para contrações musculares controladas, com foco em tônus e fortalecimento da musculatura.`, Q.glut);
add("Corrente Russa Analgesia", "Uso de eletroterapia com parâmetros voltados ao conforto e analgesia em protocolos específicos. A indicação depende da avaliação profissional e do objetivo do atendimento.", Q.tonus);
add("Criofrequência", "Tecnologia que associa radiofrequência a resfriamento da superfície da pele. É utilizada em protocolos para flacidez, qualidade da pele e contorno corporal ou facial, conforme a região tratada.", Q.obj);
const crioF = (p: string) => `Criofrequência aplicada ${p}, combinando aquecimento profundo por radiofrequência com resfriamento da superfície. É usada em protocolos para firmeza e melhora da qualidade da pele, conforme avaliação.`;
many("Criofrequência", [["Abdômen", ABD], ["Braços", BRA], ["Costas", COS], ["Facial", "na face"], ["Interno de Coxas", INT], ["Posterior de Coxas", POS]], crioF, Q.obj);
add("Criofrequência Glúteos", crioF(GLU), Q.glut);
add("Criofrequência Papada", crioF("na região da papada"), Q.gl);
add("Eletroestimulação Abdomen", "Uso de corrente elétrica para estimular contrações musculares controladas no abdômen, auxiliando em protocolos de tônus e fortalecimento muscular.", Q.tonus);
add("Eletrolipolise", "Técnica de eletroterapia utilizada em protocolos para gordura localizada, com aplicação de corrente elétrica de baixa intensidade na região tratada. A forma de aplicação e indicação dependem da avaliação.", Q.obj);
add("Eletrolipolise Flancos", "Eletrolipólise direcionada aos flancos, utilizada em protocolos para gordura localizada nessa região.", Q.obj);
add("Eletrolipolise GL Sutiã", "Eletrolipólise direcionada à gordura localizada na região do sutiã, conforme avaliação.", Q.gl);
add("Eletroterapia", "Uso de correntes elétricas terapêuticas com parâmetros diferentes conforme o objetivo, podendo ser empregadas em protocolos de tônus, circulação, analgesia ou cuidados corporais.", Q.obj);

add("Etherea", "Plataforma de laser utilizada em diferentes protocolos dermatofuncionais, como rejuvenescimento, manchas, vasos e remoção de pigmentos. O aplicador e o parâmetro dependem da indicação.", Q.obj);
add("Etherea Full Face", "Tratamento com a plataforma Etherea em toda a face, com parâmetros definidos conforme a queixa, podendo ser usado em protocolos de qualidade da pele, manchas ou rejuvenescimento.", Q.obj);
add("Etherea Melasma", "Protocolo com a plataforma Etherea voltado ao tratamento de melasma em casos selecionados. Exige avaliação, fotoproteção e plano individualizado.", Q.obj);
add("Etherea Rejuvenescimento Colo", "Uso da plataforma Etherea na região do colo em protocolos para textura, manchas e sinais de envelhecimento, conforme avaliação.", Q.obj);
add("Etherea Rejuvenescimento Facial", "Uso da plataforma Etherea em protocolos faciais para melhora de textura, uniformidade e sinais de envelhecimento, com parâmetros personalizados.", Q.obj);
add("Etherea Rejuvenescimento Mãos", "Uso da plataforma Etherea no dorso das mãos em protocolos para manchas e qualidade da pele, conforme avaliação.", Q.obj);
add("Etherea Remoção de Micropigmentação", "Laser utilizado para fragmentar pigmentos de micropigmentação ao longo de sessões. A quantidade de sessões depende da cor, profundidade, tempo e resposta individual.", Q.tatu);
add("Etherea Remoção de Tatuagem Grande", "Laser para remoção gradual de tatuagem de maior área, fragmentando o pigmento para que o organismo elimine progressivamente. Exige várias sessões e avaliação do tipo de tinta.", Q.tatu);
add("Etherea Remoção de Tatuagem Pequena", "Laser para remoção gradual de tatuagem de pequena área, com número de sessões variável conforme cor, profundidade e resposta da pele.", Q.tatu);
add("Etherea Vasinhos", "Uso de laser em pequenos vasos superficiais selecionados, com parâmetros ajustados conforme o tipo e a região do vaso.", Q.vaso);

add("Heccus", "Tecnologia de ultrassom associada a correntes terapêuticas, utilizada em protocolos corporais para gordura localizada, celulite, circulação e recuperação, conforme a configuração e a região tratada.", Q.obj);
many("Heccus Celulite", [["Frente de Coxas", ANT], ["Glúteos", GLU], ["Interno de Coxas", INT], ["Lateral de Coxas", LAT], ["Posterior de Coxas", POS]],
  (p) => `Aplicação do Heccus ${p} em protocolo para celulite, utilizando ultrassom e correntes terapêuticas conforme os parâmetros definidos pela profissional.`, Q.cel);
many("Heccus Flacidez", [["Abdomen", ABD], ["Braços", BRA], ["Flancos", FLA], ["Frente de Coxas", ANT], ["GL Sutiã", SUT], ["Interno de Coxas", INT], ["Lateral de Coxas", LAT], ["Posterior de Coxas", POS]],
  (p) => `Aplicação do Heccus ${p} em protocolo voltado à qualidade do tecido e flacidez, conforme avaliação e parâmetros selecionados.`, Q.flac);
many("Heccus GL", [["Abdomen", ABD], ["Braços", BRA], ["Costas", COS], ["Culote", CUL], ["Flancos", FLA], ["Interno de Coxa", INT], ["Sutiã", SUT]],
  (p) => `Aplicação do Heccus ${p} em protocolo para gordura localizada, combinando ultrassom e correntes terapêuticas conforme avaliação.`, Q.gl);
add("Heccus Pós Operatório", "Uso do Heccus em protocolos pós-operatórios quando houver liberação e indicação, com parâmetros específicos para auxiliar o cuidado do tecido e a recuperação.", Q.pos);
add("Hipro", "Tecnologia de ultrassom micro e/ou macrofocado utilizada em protocolos de firmeza, estímulo de colágeno e contorno facial ou corporal. A profundidade e a região são definidas após avaliação.", Q.uf);

add("Lavieen", "Laser fracionado utilizado em protocolos de renovação da pele, textura, poros, manchas e viço. O tratamento provoca microzonas de estímulo e a indicação depende da queixa e avaliação.", Q.pele);
const lav = (p: string, obj: string) => `Aplicação do laser Lavieen ${p}, em protocolo ${obj}. A intensidade e o número de sessões dependem da avaliação e resposta da pele.`;
add("Lavieen Axilas", lav("na região das axilas", "voltado à uniformidade do tom e à qualidade da pele"), Q.pele);
add("Lavieen Braços", lav("na região dos braços", "voltado a textura, manchas e qualidade da pele"), Q.pele);
add("Lavieen Capilar", lav("no couro cabeludo", "capilar, associado a estímulo e permeação de ativos, conforme indicação"), Q.pele);
add("Lavieen Clareamento Corporal (áreas pequenas)", lav("em pequenas áreas corporais", "voltado a clareamento e uniformização do tom"), Q.pele);
add("Lavieen Clareamento Corporal áreas grandes", lav("em áreas corporais maiores", "voltado a clareamento e uniformização do tom"), Q.pele);
add("Lavieen Colo e Pescoço", lav("na região do colo e pescoço", "voltado a textura, manchas e sinais de envelhecimento"), Q.pele);
add("Lavieen Full Face", lav("em toda a face", "voltado a textura, poros, manchas e viço"), Q.pele);
add("Lavieen Manchas de Acne", lav("na face e em outras regiões com marcas de acne", "voltado a manchas residuais e textura"), Q.pele);
add("Lavieen Melasma", lav("na face com melasma", "voltado ao controle de manchas, de forma individualizada"), Q.pele);
add("Lavieen Mãos", lav("no dorso das mãos", "voltado a manchas e qualidade da pele"), Q.pele);
add("Lavieen Olheiras", lav("na região periocular", "voltado a qualidade da pele e pigmentação em casos selecionados"), Q.pele);
add("Lavieen Virilha", lav("na região da virilha", "voltado à uniformidade do tom e qualidade da pele"), Q.pele);
add("Lavieen Full Face, Colo e Pescoço", "Aplicação do Lavieen na face, colo e pescoço no mesmo protocolo, voltada à renovação, textura, manchas e qualidade da pele dessas regiões." + S, Q.pele);

add("Led Laser", "Fototerapia com LED/laser de baixa intensidade utilizada em protocolos para modulação da pele, conforto, recuperação e suporte a outros tratamentos. A cor/comprimento de onda varia conforme o objetivo.", Q.obj);
add("Lipocavitação", "Tecnologia de ultrassom utilizada em protocolos corporais para gordura localizada e melhora do contorno. A aplicação é externa e a região é definida após avaliação.", Q.gl);
many("Lipocavitação Celulite", [["Frente de Coxas", ANT], ["Glúteos", GLU], ["Interno de Coxas", INT], ["Lateral de Coxas", LAT], ["Posterior de Coxas", POS]],
  (p) => `Lipocavitação aplicada ${p} como parte de protocolo corporal para celulite e qualidade do tecido, conforme avaliação.`, Q.cel);
many("Lipocavitação GL", [["Abdomen", "à região do abdômen"], ["Bananinha do Bumbum", "à região de bananinha do bumbum"], ["Braços", "à região de braços"], ["Flancos", "à região de flancos"], ["Frente de Coxas", "à parte anterior das coxas"], ["Interno de Coxas", "à parte interna das coxas"], ["Lateral de Coxas", "à lateral das coxas"], ["Posterior de Coxas", "à parte posterior das coxas"], ["do Sutiã", "à região do sutiã"]],
  (p) => `Lipocavitação direcionada ${p} em protocolo para gordura localizada e contorno corporal.`, Q.gl);
add("Pixie Hi-fu", "Tecnologia de ultrassom focalizado de alta intensidade utilizada em protocolos de firmeza, estímulo de colágeno e contorno facial ou corporal. A profundidade e os disparos são definidos após avaliação.", Q.uf);
add("Pump + Corrente Russa", "Protocolo corporal que combina o efeito de sucção/estimulação do Pump com Corrente Russa para estimular a musculatura. É utilizado especialmente em protocolos de glúteos e contorno corporal, conforme avaliação.", Q.glut);

add("Radiofrequência", "Tecnologia que promove aquecimento controlado das camadas da pele e do tecido, estimulando processos relacionados à firmeza e qualidade da pele. Pode ser usada em protocolos faciais e corporais conforme avaliação.", Q.obj);
many("Radiofrequência Celulite", [["Frente de Coxas", ANT], ["Glúteos", GLU], ["Interno de Coxas", INT], ["Lateral de Coxas", LAT], ["Posterior de Coxas", POS]],
  (p) => `Radiofrequência aplicada ${p} como parte de protocolos para celulite e qualidade do tecido, com aquecimento controlado conforme os parâmetros definidos pela profissional.${S}`, Q.cel);
add("Radiofrequência Facial", "Radiofrequência aplicada na face com aquecimento controlado, utilizada em protocolos para firmeza, textura e estímulo de colágeno, respeitando a região e a avaliação individual.", Q.uf);
many("Radiofrequência Flacidez", [["Abdômen", ABD], ["Braços", BRA], ["Flancos", FLA], ["Frente de Coxas", ANT], ["GL Sutiã", SUT], ["Interno de Coxa", INT], ["Interno de Coxas", INT], ["Lateral de Coxas", LAT], ["Posterior de Coxas", POS]],
  (p) => `Radiofrequência aplicada ${p} em protocolo para flacidez e melhora da qualidade da pele, por meio de aquecimento controlado do tecido.${S}`, Q.flac);
many("Radiofrequência GL", [["Abdomen", ABD], ["Bananinha do Bumbum", BAN], ["Braços", BRA], ["Costas", COS], ["Culote", CUL], ["Flancos", FLA], ["Interno de Coxas", INT], ["Sutiã", SUT]],
  (p) => `Radiofrequência aplicada ${p} como parte de protocolo para contorno corporal e gordura localizada, normalmente associada à melhora da firmeza e qualidade da pele.${S}`, Q.gl);
add("Radiofrequência de Papada", "Radiofrequência aplicada na região abaixo do queixo em protocolos para firmeza e melhora do contorno da papada, conforme características individuais." + S, Q.gl);
add("Radiofrequência Íntima", "Radiofrequência aplicada em região íntima externa em protocolos de qualidade da pele e flacidez, com parâmetros específicos e avaliação profissional prévia.", Q.obj);

add("US Alta Potência GL", "Ultrassom de alta potência utilizado em protocolos corporais para gordura localizada e melhora do contorno, com parâmetros definidos conforme a região e avaliação.", Q.obj);
many("US Alta Potência GL", [["Abdomen", ABD], ["Bananinha do Bumbum", BAN], ["Braços", BRA], ["Culote", CUL], ["Flancos", FLA], ["Sutiã", SUT]],
  (p) => `Aplicação de ultrassom de alta potência ${p} em protocolo para gordura localizada e contorno corporal, conforme avaliação.`, Q.gl);
add("US Alta Potência para Cicatrizes/Fibrose", "Ultrassom terapêutico de alta potência utilizado em protocolos selecionados para mobilização de tecido, fibroses e cicatrizes, especialmente quando há indicação profissional ou no acompanhamento pós-operatório.", Q.obj);

add("Ultraformer", "Tecnologia de ultrassom micro e macrofocado que entrega energia em profundidades específicas para estimular colágeno, melhorar firmeza e trabalhar contorno facial ou corporal. A quantidade de disparos e ponteiras varia conforme a região." + S, Q.uf);
const ult = (name: string, onde: string, obj: string, q = Q.uf) =>
  add(name, `Protocolo com Ultraformer aplicado ${onde}, com quantidade de disparos indicada no nome do cadastro. É voltado ${obj}; a indicação final, profundidade e distribuição dos disparos dependem da avaliação profissional.`, q);
ult("Ultraformer Abdômen Completo 1250", "no abdômen completo", "a firmeza, contorno e protocolos corporais");
ult("Ultraformer Banco de Colágeno 200", "na área facial definida pela avaliação", "a estímulo de colágeno e manutenção da qualidade da pele");
ult("Ultraformer Bolsa Ocular 230", "na região abaixo dos olhos", "a firmeza e melhora do aspecto da região periocular em casos selecionados");
ult("Ultraformer Braço 600", "nos braços", "a firmeza e contorno");
ult("Ultraformer C Lifting 410", "na face em vetor de lifting", "a estímulo de colágeno e efeito de sustentação gradual");
ult("Ultraformer Colo 450", "no colo", "a firmeza e qualidade da pele");
ult("Ultraformer Coxas 1200", "nas coxas", "a firmeza e contorno corporal");
ult("Ultraformer Full Face 880", "em toda a face", "a firmeza, sustentação e estímulo de colágeno");
ult("Ultraformer Glow Skin 200", "na face", "a qualidade da pele e estímulo superficial de colágeno");
ult("Ultraformer Glúteo com Bananinha 1200", "nos glúteos e na região da bananinha", "a firmeza e contorno corporal");
ult("Ultraformer Papada Completo 200", "na papada", "a contorno e firmeza da região submentoniana", Q.gl);
ult("Ultraformer Perna 1200", "nas pernas", "a firmeza e contorno corporal");
ult("Ultraformer Pescoço/Papada 340", "no pescoço e na papada", "a firmeza e contorno do terço inferior", Q.gl);
ult("Ultraformer Pálpebra Inferior 200", "na pálpebra inferior", "a firmeza da região periocular em casos selecionados");
ult("Ultraformer Pálpebra Superior 160", "na pálpebra superior", "a firmeza da região periocular em casos selecionados");
ult("Ultraformer Redução de Gordura Terço Inferior 200", "no terço inferior da face", "a contorno e redução de pequenas áreas de gordura, quando houver indicação", Q.gl);
ult("Ultraformer Rugas Perioral 160", "na região ao redor da boca", "a firmeza e melhora gradual de linhas finas");
ult("Ultraformer Rugas na Região da Testa 110", "na testa", "a firmeza e melhora gradual da qualidade da pele");
ult("Ultraformer Terço Inferior 200", "no terço inferior da face", "a sustentação, firmeza e contorno");
ult("Ultraformer Terço Superior 100", "no terço superior da face", "a firmeza e estímulo de colágeno");
ult("Ultraformer Ultra Lips 80", "na região ao redor dos lábios", "a estímulo de colágeno e melhora da qualidade da pele perioral");

// ---------------- CUIDADOS FACIAIS E CLAREAMENTO ----------------
add("Clareamento axilas", "Protocolo estético para melhorar o aspecto de escurecimento das axilas, combinando ativos e/ou tecnologias conforme avaliação. O tratamento é personalizado de acordo com a causa e sensibilidade da pele.", Q.clar);
add("Clareamento corporal", "Protocolo voltado à melhora do tom e uniformidade de áreas corporais com hiperpigmentação. Pode combinar diferentes recursos conforme avaliação profissional.", Q.clar);
add("Clareamento íntimo", "Protocolo estético para melhora do aspecto de escurecimento em áreas íntimas externas, realizado com técnicas e ativos adequados à sensibilidade da região. Requer avaliação individual.", Q.clar);
add("Hidratação Facial", "Protocolo facial voltado à reposição de água e conforto da pele, utilizando produtos hidratantes e etapas selecionadas conforme o tipo de pele.", Q.pele);
add("Limpeza de Pele", "Procedimento de higienização profunda que inclui etapas como limpeza, esfoliação, emoliência e extração quando indicada, finalizando com cuidados calmantes e proteção da pele.", Q.pele);
add("Mascara Colageno (Olhos)", "Máscara para a região dos olhos com foco em hidratação, conforto e melhora temporária do aspecto de ressecamento e cansaço.", Q.obj);
add("Microagulhamento", "Procedimento que utiliza microperfurações controladas na pele para estimular renovação e colágeno, podendo ser indicado para textura, poros, cicatrizes e algumas manchas conforme avaliação.", Q.pele);
add("Microagulhamento com Peeling", "Protocolo combinado de microagulhamento com peeling, associando estímulo mecânico e renovação química da pele. Requer avaliação cuidadosa para definir ativos e intensidade.", Q.pele);
add("Peeling Diamante", "Esfoliação mecânica superficial realizada com ponteira diamantada, que auxilia na remoção de células mortas e melhora temporária da textura e maciez da pele.", Q.pele);
add("Peeling Químico", "Aplicação controlada de ácidos ou outros ativos químicos para promover renovação da pele. Pode ser utilizado em protocolos para manchas, acne, textura e sinais de envelhecimento, conforme o tipo de pele.", Q.pele);
add("Revitalização Facial com Vitamina C", "Protocolo facial com foco em hidratação, luminosidade e cuidado antioxidante, utilizando produtos com vitamina C e etapas de revitalização adequadas ao tipo de pele.", Q.pele);
add("Protocolo Olhar Lisboa", "Protocolo facial exclusivo da Lisboa voltado à região dos olhos, combinando higienização, drenagem facial terapêutica, patch oclusivo e LED. O objetivo é proporcionar hidratação, conforto e revitalização da região periocular, ajudando no aspecto de cansaço e inchaço de forma delicada. Apresentar como protocolo de cuidado da região dos olhos, sem prometer tratamento definitivo de olheiras.", Q.olhar);

// ---------------- CORPORAIS, MASSAGENS E BEM-ESTAR ----------------
many("Carbox Celulite", [["Frente de Coxas", ANT], ["Glúteos", GLU], ["Interno de Coxas", INT], ["Lateral de Coxas", LAT], ["Posterior de Coxas", POS]],
  (p) => `Carboxiterapia aplicada ${p}, com uso controlado de gás carbônico medicinal. É utilizada em protocolos para celulite e melhora da circulação e qualidade do tecido, conforme avaliação.`, Q.cel);
many("Carbox Estria", [["Abdomen", "à região do abdômen"], ["Frente de Coxas", "à parte anterior das coxas"], ["Glúteo", "à região de glúteo"], ["Interno de Coxas", "à parte interna das coxas"], ["Lateral de Coxas", "à lateral das coxas"], ["Posterior de Coxas", "à parte posterior das coxas"]],
  (p) => `Carboxiterapia direcionada ${p}, utilizada em protocolos para estrias com o objetivo de estimular circulação local e remodelação do tecido. O resultado e o número de sessões variam de acordo com cada caso.${S}`, Q.estria);
add("Carbox Facial", "Carboxiterapia facial com aplicação controlada de gás carbônico medicinal em protocolos voltados à melhora da circulação, qualidade da pele e revitalização. A indicação depende da região e da avaliação profissional.", Q.obj);
add("Carbox Flacidez Abdômen", "Carboxiterapia aplicada no abdômen em protocolos para flacidez, com objetivo de estimular circulação local e melhorar a qualidade do tecido." + S, Q.flac);
add("Carbox Flacidez Lateral de Coxas", "Carboxiterapia aplicada na lateral das coxas em protocolos para flacidez e melhora da qualidade da pele." + S, Q.flac);
add("Carbox Flacidez Posterior de Coxas", "Carboxiterapia aplicada na parte posterior das coxas em protocolos para flacidez e melhora da qualidade do tecido." + S, Q.flac);
add("Carbox GL Abdômen", "Carboxiterapia voltada à gordura localizada no abdômen, utilizada como parte de protocolos corporais. A indicação depende da avaliação e das características da região.", Q.gl);
add("Carbox GL Braços", "Carboxiterapia para protocolos de gordura localizada na região dos braços, podendo ser associada a outras técnicas conforme avaliação.", Q.gl);
add("Carbox GL Costa", "Carboxiterapia voltada à gordura localizada na região das costas. A indicação e o plano de sessões são definidos após avaliação.", Q.gl);
add("Carbox GL Interno de Coxas", "Carboxiterapia utilizada em protocolos para gordura localizada na região interna das coxas." + S, Q.gl);
add("Carbox GL Posterior de Coxas", "Carboxiterapia utilizada em protocolos para gordura localizada na parte posterior das coxas." + S, Q.gl);
add("Carbox Olheira", "Carboxiterapia aplicada na região das olheiras em casos selecionados, com objetivo de melhorar circulação e aspecto da pele. Por ser uma área delicada, exige avaliação profissional.", Q.obj);
add("Carboxiterapia", "Procedimento que utiliza aplicação controlada de gás carbônico medicinal no tecido. Pode fazer parte de protocolos para gordura localizada, celulite, flacidez, estrias ou qualidade da pele, dependendo da região e da indicação." + S, Q.obj);

add("Criolipolise", "Tecnologia corporal que utiliza resfriamento controlado para tratar gordura localizada em áreas selecionadas. A quantidade de placas e a região são definidas após avaliação.", Q.gl);
add("Criolipolise (6 placas)", "Sessão de criolipólise com 6 placas, indicada para tratar múltiplas áreas ou áreas maiores de gordura localizada no mesmo atendimento, conforme avaliação e posicionamento seguro das placas.", Q.gl);
add("Criolipolise (8 placas)", "Sessão de criolipólise com 8 placas, indicada para tratar múltiplas áreas ou áreas maiores de gordura localizada no mesmo atendimento, conforme avaliação e posicionamento seguro das placas.", Q.gl);
const crio = (name: string, onde: string, n: number) =>
  add(name, `Criolipólise direcionada ${onde}, utilizando ${n} placa${n > 1 ? "s" : ""} para realizar resfriamento controlado do tecido adiposo. A indicação depende da quantidade de gordura, formato da região e avaliação profissional.`, Q.gl);
crio("Criolipolise Abdomen (1 Placa)", "ao abdômen", 1);
crio("Criolipolise Abdomen (2 placas)", "ao abdômen", 2);
crio("Criolipolise Abdomen (3 placas)", "ao abdômen", 3);
crio("Criolipolise Abdomen (4 placas)", "ao abdômen", 4);
crio("Criolipolise Braços (2 placa)", "aos braços", 2);
crio("Criolipolise Costas (4 placas)", "às costas", 4);
crio("Criolipolise GL Sutiã (2 placas)", "à gordura localizada na região do sutiã", 2);
crio("Criolipolise GL Sutiã (4 placas)", "à gordura localizada na região do sutiã", 4);
crio("Criolipolise Interno de Coxas (2 placas)", "à região interna das coxas", 2);
crio("Criolipolise Interno de Coxas (4 placas)", "à região interna das coxas", 4);
crio("Criolipolise Lateral de Coxas (2 placas)", "à lateral das coxas", 2);
crio("Criolipolise Lateral de Coxas (4 placas)", "à lateral das coxas", 4);
crio("Criolipolise Papada (1 placa)", "à papada", 1);
crio("Criolipolise Posterior de Coxas (2 placas)", "à parte posterior das coxas", 2);
crio("Criolipolise Posterior de Coxas (4 placas)", "à parte posterior das coxas", 4);

add("Day Spa", "Experiência de autocuidado e relaxamento que pode combinar massagens, hidratação e outros cuidados de bem-estar. O conteúdo varia conforme o pacote escolhido.", Q.relax);
add("Detox", "Protocolo corporal voltado a sensação de leveza, redução de retenção e cuidado corporal, podendo combinar drenagem, manta, massagem e outros recursos conforme o plano definido.", Q.relax);
add("Drenagem linfática", "Massagem com manobras suaves e direcionadas que auxiliam o fluxo linfático e a redução de retenção de líquidos, promovendo sensação de leveza.", Q.relax);
add("Drenagem linfática facial", "Drenagem com manobras suaves no rosto e pescoço, utilizada para auxiliar na redução de inchaço e promover sensação de leveza facial.", Q.relax);
add("Drenagem linfática pós operatório", "Drenagem adaptada ao período pós-operatório, realizada conforme liberação e orientação da equipe responsável, com manobras específicas para auxiliar edema e recuperação.", Q.relax);
add("Drenomodeladora", "Massagem que combina manobras de drenagem e modelagem corporal, com objetivo de auxiliar retenção, circulação e contorno corporal.", Q.obj);
add("Modeladora Corpo Todo", "Massagem modeladora realizada em várias regiões do corpo, com manobras mais intensas voltadas a contorno corporal e circulação.", Q.obj);
add("Endermoterapia Celulite Posterior de Coxas", "Técnica com sucção e manobras mecânicas aplicada na parte posterior das coxas, utilizada em protocolos para celulite, circulação e qualidade do tecido.", Q.cel);
add("Endermoterapia Flacidez Frente de Coxa", "Endermoterapia na parte anterior das coxas, utilizando sucção e mobilização do tecido em protocolos para qualidade da pele e flacidez.", Q.flac);
add("Endermoterapia GL Abdomen", "Endermoterapia aplicada no abdômen como parte de protocolos para gordura localizada, circulação e mobilização do tecido.", Q.gl);
add("Endermoterapia GL Flancos", "Endermoterapia direcionada aos flancos em protocolos para gordura localizada e melhora da mobilização do tecido.", Q.gl);
add("Endermoterapia GL Sutiã", "Endermoterapia aplicada na região do sutiã em protocolos para gordura localizada e melhora da circulação local.", Q.gl);
add("Esfoliação corporal", "Procedimento de renovação superficial da pele que remove células mortas e ajuda a deixar a textura mais macia e uniforme, podendo preparar a pele para outros cuidados corporais.", Q.obj);
add("MASSAGEM RELAXANTE COSTAS 30MIN", "Massagem de 30 minutos focada nas costas, com manobras suaves a moderadas para promover relaxamento e aliviar tensões musculares do dia a dia.", Q.relax);
add("Massagem Relaxante", "Massagem com manobras suaves e ritmadas voltada a relaxamento, conforto e redução de tensões.", Q.relax);
add("Massagem Relaxante Facial", "Massagem facial com manobras suaves para relaxamento, conforto e estímulo da circulação local.", Q.relax);
add("Massagem com Bambu", "Massagem realizada com hastes de bambu associadas a manobras manuais, utilizada para relaxamento e/ou modelagem corporal conforme o protocolo.", Q.relax);
add("Massagem com Pedras Quentes", "Massagem relaxante que utiliza pedras aquecidas para proporcionar conforto térmico, relaxamento muscular e sensação de bem-estar.", Q.relax);
add("Massagem com Ventosa", "Técnica que utiliza ventosas para mobilização do tecido e estímulo da circulação local, podendo fazer parte de protocolos de relaxamento ou corporais.", Q.relax);
add("Massagem modeladora", "Massagem com manobras mais intensas e direcionadas, utilizada em protocolos para contorno corporal, circulação e mobilização do tecido.", Q.relax);
add("Pump Glúteo", "Protocolo direcionado à região glútea que utiliza sucção controlada e estímulos definidos pela clínica para melhorar temporariamente circulação, aparência e ativação da região. Pode ser associado a outros recursos.", Q.glut);
add("Pump up", "Técnica com sucção controlada voltada principalmente à região glútea, usada em protocolos de estímulo local, circulação e melhora temporária do aspecto do contorno.", Q.glut);
add("Tapping", "Aplicação de bandagem funcional/elástica sobre a pele em protocolos específicos, podendo ser utilizada como suporte em edema, pós-operatório ou outras finalidades definidas pela profissional.", Q.obj);

// ---------------- OUTROS PROTOCOLOS ----------------
add("Ilibi", "Fotobiomodulação com luz vermelha aplicada de forma não invasiva sobre região vascular superficial, utilizada em alguns protocolos de bem-estar e suporte terapêutico. A indicação deve ser definida pela equipe.", Q.obj);
add("Quick Massage", "Massagem de curta duração, geralmente focada em costas, ombros e pescoço, com manobras para relaxamento e alívio de tensões do dia a dia.", Q.obj);
add("Subcisão", "Procedimento minimamente invasivo em que o profissional utiliza uma cânula ou agulha específica para liberar traves fibrosas abaixo da pele. É muito usado em protocolos para cicatrizes deprimidas e celulite selecionada." + S, Q.obj);

// NAO carregados: o proprio documento pede validacao da composicao/etapas pela equipe antes de a Alice explicar.
export const PENDENTES_VALIDACAO = [
  "Glúteo Max",
  "Day SPA Aquamarine",
  "Day SPA Lazuli",
  "Day SPA Turmalina",
  "Detox - N.U",
  "Diástase PH",
  "ESFERAS SHOT CRYO GLOW",
  "Labial Sweet Cherry Lips",
  "Metodo Aline Sousa (HIBRIUS)",
];

// Texto que fica no cadastro do procedimento: o descritivo + a pergunta de continuacao (a Alice usa a pergunta pra seguir a conversa).
export const QUESTION_LABEL = "Pergunta para continuar a conversa:";
export const descricaoFinal = (d: Descritivo): string => `${d.text}\n${QUESTION_LABEL} ${d.question}`;
