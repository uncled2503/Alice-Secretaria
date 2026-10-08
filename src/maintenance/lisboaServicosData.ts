// GERADO a partir de "Cadastro_Servicos_Alice_Lisboa_final.xlsx" (08/10/2026) - catalogo de
// servicos da Lisboa Beauty Center. Textos sao SUGESTOES da planilha (validacao clinica
// pela clinica). Valor, preco variavel e parcelamento NAO vieram preenchidos e nao entram.
export interface LisboaServico {
  category: string;
  name: string;
  duration: string; // texto original ("30 min", "A definir"...) - so informativo, nao altera a duracao do sistema
  description: string;
  goals: string[];
  benefits: string[];
  aliases: string[];
  resultTimeline: string;
  paymentMethods: string[];
  pixKey: string;
}

export const LISBOA_SERVICOS: LisboaServico[] = [
  {
    "category": "Corporal",
    "name": "Clareamento Corporal",
    "duration": "30 min",
    "description": "Protocolo estético voltado à melhora gradual da aparência de áreas corporais com escurecimento ou tom irregular.",
    "goals": [
      "Escurecimento corporal",
      "Tom de pele irregular",
      "Áreas com aspecto manchado"
    ],
    "benefits": [
      "Auxilia na uniformização visual do tom da pele",
      "Contribui para uma aparência mais iluminada e cuidada"
    ],
    "aliases": [
      "Clareamento de pele corporal"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Corporal",
    "name": "Corrente Russa",
    "duration": "40 min",
    "description": "Eletroterapia que utiliza estímulos elétricos para promover contrações musculares controladas na região tratada.",
    "goals": [
      "Tônus muscular",
      "Flacidez muscular",
      "Definição corporal"
    ],
    "benefits": [
      "Auxilia no estímulo muscular",
      "Pode complementar protocolos de definição e tonificação"
    ],
    "aliases": [
      "Eletroestimulação",
      "Estimulação muscular"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Corporal",
    "name": "Criolipólise",
    "duration": "90 min",
    "description": "Tecnologia corporal que utiliza resfriamento controlado em áreas com gordura localizada, conforme avaliação profissional.",
    "goals": [
      "Gordura localizada",
      "Contorno corporal",
      "Medidas localizadas"
    ],
    "benefits": [
      "Pode auxiliar na redução de gordura localizada",
      "Contribui para melhora do contorno corporal"
    ],
    "aliases": [
      "Crio",
      "Criolipólise de placas"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Corporal",
    "name": "Eletrolipólise",
    "duration": "40 min",
    "description": "Técnica de eletroterapia utilizada em protocolos corporais para áreas com gordura localizada, de acordo com avaliação.",
    "goals": [
      "Gordura localizada",
      "Contorno corporal"
    ],
    "benefits": [
      "Pode complementar protocolos para gordura localizada",
      "Auxilia no cuidado do contorno corporal"
    ],
    "aliases": [
      "Eletrolipólise corporal"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Corporal",
    "name": "Eletroterapia",
    "duration": "60 min",
    "description": "Uso de recursos de corrente elétrica em protocolos estéticos, definidos conforme a necessidade da região e objetivo.",
    "goals": [
      "Tônus muscular",
      "Flacidez",
      "Protocolos corporais combinados"
    ],
    "benefits": [
      "Permite combinar diferentes estímulos em protocolos personalizados",
      "Pode auxiliar em objetivos de tonificação"
    ],
    "aliases": [
      "Correntes estéticas"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Corporal",
    "name": "Endermoterapia",
    "duration": "15–20 min",
    "description": "Técnica com sucção e manobras mecânicas utilizada em protocolos corporais personalizados.",
    "goals": [
      "Celulite",
      "Fibrose",
      "Aspecto irregular da pele",
      "Contorno corporal"
    ],
    "benefits": [
      "Auxilia na mobilização dos tecidos",
      "Pode melhorar o aspecto da pele em protocolos combinados"
    ],
    "aliases": [
      "Endermo",
      "Vacuum terapia"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Corporal",
    "name": "Esculpe Detox",
    "duration": "75 min",
    "description": "Protocolo corporal combinado com foco em sensação de leveza, cuidado corporal e melhora visual do contorno.",
    "goals": [
      "Inchaço",
      "Retenção de líquidos",
      "Sensação de peso",
      "Contorno corporal"
    ],
    "benefits": [
      "Pode promover sensação de leveza",
      "Auxilia em protocolos de desinchaço e cuidado corporal"
    ],
    "aliases": [
      "Detox corporal",
      "Detox"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Corporal",
    "name": "Heccus",
    "duration": "30 min",
    "description": "Tecnologia utilizada em protocolos corporais para gordura localizada, celulite e flacidez, conforme avaliação.",
    "goals": [
      "Gordura localizada",
      "Celulite",
      "Flacidez",
      "Contorno corporal"
    ],
    "benefits": [
      "Pode complementar protocolos de redução de medidas",
      "Auxilia na melhora do aspecto da celulite e contorno"
    ],
    "aliases": [
      "Heccus corporal"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Corporal",
    "name": "Hibrius",
    "duration": "90 min",
    "description": "Protocolo corporal realizado com tecnologia de ultrassom e/ou recursos combinados conforme o plano definido na avaliação.",
    "goals": [
      "Gordura localizada",
      "Contorno corporal",
      "Flacidez",
      "Protocolos combinados"
    ],
    "benefits": [
      "Permite personalização por área e objetivo",
      "Pode complementar protocolos de definição corporal"
    ],
    "aliases": [
      "Método Aline Sousa (HIBRIUS)",
      "Hybrius"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Corporal",
    "name": "ILIB",
    "duration": "30 min",
    "description": "Recurso com luz/laser de baixa intensidade utilizado dentro de protocolos estéticos conforme indicação profissional.",
    "goals": [
      "Bem-estar em protocolos combinados",
      "Suporte a cuidados estéticos"
    ],
    "benefits": [
      "Pode ser utilizado como recurso complementar em protocolos definidos pela profissional"
    ],
    "aliases": [
      "ILIB",
      "Laser ILIB"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Corporal",
    "name": "Lipocavitação",
    "duration": "30 min",
    "description": "Tecnologia de ultrassom utilizada em protocolos corporais voltados a áreas com gordura localizada.",
    "goals": [
      "Gordura localizada",
      "Medidas localizadas",
      "Contorno corporal"
    ],
    "benefits": [
      "Pode auxiliar na redução de medidas em áreas selecionadas",
      "Contribui para protocolos de contorno corporal"
    ],
    "aliases": [
      "Ultracavitação",
      "Lipo cavitação"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Corporal",
    "name": "Ondas de Choque",
    "duration": "30 min",
    "description": "Tecnologia utilizada em protocolos corporais para estimular os tecidos e complementar tratamentos de celulite e contorno.",
    "goals": [
      "Celulite",
      "Flacidez",
      "Fibrose",
      "Aspecto irregular da pele"
    ],
    "benefits": [
      "Pode melhorar o aspecto da pele",
      "Auxilia em protocolos para celulite e fibrose"
    ],
    "aliases": [
      "Terapia por ondas de choque"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Corporal",
    "name": "Pump Up",
    "duration": "60 min",
    "description": "Protocolo voltado à região glútea, com recursos estéticos para estímulo muscular e melhora visual do contorno.",
    "goals": [
      "Contorno de glúteos",
      "Tônus muscular",
      "Definição glútea"
    ],
    "benefits": [
      "Auxilia no estímulo muscular",
      "Pode melhorar visualmente a definição e o contorno glúteo"
    ],
    "aliases": [
      "Pump Glúteo",
      "Pump"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Corporal",
    "name": "Radiofrequência",
    "duration": "30 min",
    "description": "Tecnologia que promove aquecimento controlado dos tecidos em protocolos para flacidez e qualidade da pele.",
    "goals": [
      "Flacidez",
      "Qualidade da pele",
      "Contorno corporal"
    ],
    "benefits": [
      "Auxilia na melhora da firmeza e aparência da pele",
      "Pode estimular protocolos voltados à qualidade cutânea"
    ],
    "aliases": [
      "RF corporal",
      "Radiofrequência corporal"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Facial",
    "name": "Drenagem Facial",
    "duration": "A definir",
    "description": "Massagem facial com manobras suaves voltadas ao conforto, desinchaço e cuidado da face.",
    "goals": [
      "Inchaço facial",
      "Sensação de rosto pesado",
      "Pós-procedimento quando liberado"
    ],
    "benefits": [
      "Pode auxiliar na redução do inchaço",
      "Promove sensação de leveza e relaxamento"
    ],
    "aliases": [
      "Drenagem linfática facial"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Facial",
    "name": "Hidratação com Fios de Seda",
    "duration": "60 min",
    "description": "Protocolo facial de hidratação e cuidado da pele utilizando fios de seda e cosméticos específicos.",
    "goals": [
      "Ressecamento",
      "Pele opaca",
      "Falta de viço"
    ],
    "benefits": [
      "Auxilia na hidratação",
      "Contribui para aparência mais viçosa e macia"
    ],
    "aliases": [
      "Fios de seda",
      "Hidratação fios de seda"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Facial",
    "name": "Hidratação Facial",
    "duration": "30 min",
    "description": "Protocolo de hidratação com produtos selecionados conforme as necessidades da pele.",
    "goals": [
      "Ressecamento",
      "Pele opaca",
      "Textura áspera"
    ],
    "benefits": [
      "Auxilia na reposição de hidratação",
      "Melhora o aspecto de viço e maciez"
    ],
    "aliases": [
      "Hidratação de pele"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Facial",
    "name": "Lavieen",
    "duration": "30 min",
    "description": "Laser utilizado em protocolos de renovação da pele, uniformização visual do tom e melhora da textura, conforme avaliação.",
    "goals": [
      "Manchas",
      "Melasma",
      "Poros aparentes",
      "Textura irregular",
      "Falta de viço"
    ],
    "benefits": [
      "Pode melhorar o viço e a textura da pele",
      "Auxilia na uniformização visual do tom",
      "Pode suavizar a aparência de poros e manchas"
    ],
    "aliases": [
      "Laser Lavieen",
      "Lavieen Full Face"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Facial",
    "name": "LED Laser",
    "duration": "20 min",
    "description": "Fototerapia com LED/laser de baixa intensidade usada como recurso complementar em cuidados faciais.",
    "goals": [
      "Pele sensibilizada",
      "Protocolos pós-procedimento",
      "Cuidados faciais combinados"
    ],
    "benefits": [
      "Pode auxiliar no conforto e recuperação da pele conforme protocolo",
      "Complementa tratamentos estéticos"
    ],
    "aliases": [
      "LEDterapia",
      "Fototerapia"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Facial",
    "name": "Limpeza de Pele",
    "duration": "90 min",
    "description": "Procedimento de higienização profunda da pele com etapas destinadas à remoção de impurezas e cuidados personalizados.",
    "goals": [
      "Cravos",
      "Oleosidade",
      "Poros obstruídos",
      "Pele congestionada"
    ],
    "benefits": [
      "Auxilia na remoção de impurezas e comedões",
      "Contribui para pele com aparência mais limpa e cuidada"
    ],
    "aliases": [
      "Limpeza facial",
      "Limpeza profunda"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Facial",
    "name": "Microagulhamento",
    "duration": "30 min",
    "description": "Procedimento com microperfurações controladas utilizado em protocolos de renovação e qualidade da pele.",
    "goals": [
      "Textura irregular",
      "Cicatrizes de acne",
      "Poros aparentes",
      "Linhas finas",
      "Manchas"
    ],
    "benefits": [
      "Pode estimular processos de renovação da pele",
      "Auxilia na melhora da textura e aparência geral"
    ],
    "aliases": [
      "Dermaroller",
      "Microagulhamento facial"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Facial",
    "name": "Peeling de Diamante",
    "duration": "30 min",
    "description": "Esfoliação mecânica superficial realizada com ponteira diamantada para promover renovação da camada superficial da pele.",
    "goals": [
      "Pele opaca",
      "Textura irregular",
      "Oleosidade",
      "Poros aparentes"
    ],
    "benefits": [
      "Auxilia na remoção de células superficiais",
      "Contribui para textura mais uniforme e aparência renovada"
    ],
    "aliases": [
      "Peeling diamante",
      "Microdermoabrasão"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Facial",
    "name": "Peeling Químico",
    "duration": "30 min",
    "description": "Aplicação controlada de ativos químicos para promover renovação da pele, com protocolo definido após avaliação.",
    "goals": [
      "Manchas",
      "Acne",
      "Oleosidade",
      "Textura irregular",
      "Linhas finas"
    ],
    "benefits": [
      "Pode auxiliar na renovação da pele",
      "Contribui para melhora visual de textura, viço e uniformidade do tom"
    ],
    "aliases": [
      "Peeling facial",
      "Peeling de ácidos"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Facial",
    "name": "Black Peel",
    "duration": "15 min",
    "description": "Protocolo facial realizado com ativos e tecnologia específicos para limpeza, renovação e melhora visual da pele.",
    "goals": [
      "Oleosidade",
      "Poros aparentes",
      "Pele opaca",
      "Textura irregular"
    ],
    "benefits": [
      "Auxilia na limpeza e renovação superficial",
      "Pode melhorar o viço e a aparência dos poros"
    ],
    "aliases": [
      "Peeling de carbono",
      "Carbon Peel"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Facial",
    "name": "PIXIE Hi-Fu",
    "duration": "A definir",
    "description": "Tecnologia de ultrassom focalizado utilizada em protocolos faciais para firmeza, contorno e estímulo de colágeno.",
    "goals": [
      "Flacidez facial",
      "Contorno do rosto",
      "Papada",
      "Linha mandibular"
    ],
    "benefits": [
      "Pode auxiliar na melhora da firmeza",
      "Contribui para definição do contorno facial"
    ],
    "aliases": [
      "PIXIE HIFU",
      "HIFU facial"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Facial",
    "name": "Revitalização Facial com Vitamina C",
    "duration": "45 min",
    "description": "Protocolo facial com foco em hidratação, luminosidade e cuidado da pele utilizando vitamina C e etapas complementares.",
    "goals": [
      "Pele opaca",
      "Falta de viço",
      "Ressecamento"
    ],
    "benefits": [
      "Auxilia na luminosidade e hidratação",
      "Contribui para aparência mais revitalizada"
    ],
    "aliases": [
      "Revitalização com vitamina C"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Facial",
    "name": "Ultraformer",
    "duration": "60 min",
    "description": "Ultrassom micro e macrofocado utilizado em protocolos para flacidez e contorno facial, conforme avaliação.",
    "goals": [
      "Flacidez facial",
      "Papada",
      "Contorno mandibular",
      "Pescoço"
    ],
    "benefits": [
      "Pode auxiliar na firmeza da pele",
      "Contribui para melhora do contorno facial"
    ],
    "aliases": [
      "Ultraformer facial",
      "Ultrassom microfocado"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Facial",
    "name": "Ultraformer 3",
    "duration": "60 min",
    "description": "Tecnologia de ultrassom focalizado utilizada para protocolos de firmeza, contorno e estímulo de colágeno.",
    "goals": [
      "Flacidez facial",
      "Papada",
      "Contorno mandibular",
      "Pescoço"
    ],
    "benefits": [
      "Pode auxiliar na firmeza e definição do contorno",
      "Estimula protocolos voltados à qualidade da pele"
    ],
    "aliases": [
      "Ultraformer III",
      "Ultraformer 3"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Facial",
    "name": "Radiofrequência Facial",
    "duration": "30 min",
    "description": "Tecnologia de aquecimento controlado utilizada em protocolos faciais para firmeza e qualidade da pele.",
    "goals": [
      "Flacidez facial",
      "Linhas finas",
      "Qualidade da pele"
    ],
    "benefits": [
      "Auxilia na melhora da firmeza e textura da pele",
      "Pode complementar protocolos de rejuvenescimento"
    ],
    "aliases": [
      "RF facial"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Facial",
    "name": "Remoção de Tatuagem e Micropigmentação",
    "duration": "20–60 min",
    "description": "Procedimento com tecnologia a laser para clareamento progressivo de pigmentos de tatuagem ou micropigmentação.",
    "goals": [
      "Tatuagem indesejada",
      "Micropigmentação indesejada",
      "Pigmento residual"
    ],
    "benefits": [
      "Pode promover clareamento progressivo do pigmento",
      "Plano é definido conforme cor, profundidade e área"
    ],
    "aliases": [
      "Remoção de tattoo",
      "Remoção de micro",
      "Laser para tatuagem"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Injetáveis",
    "name": "Bioestimulador de Colágeno Corporal",
    "duration": "60 min",
    "description": "Procedimento injetável com substâncias bioestimuladoras utilizadas para estimular colágeno em áreas corporais, conforme avaliação.",
    "goals": [
      "Flacidez corporal",
      "Qualidade da pele",
      "Regiões com perda de firmeza"
    ],
    "benefits": [
      "Pode estimular a produção de colágeno",
      "Auxilia na melhora gradual da firmeza e qualidade da pele"
    ],
    "aliases": [
      "Bioestimulador corporal",
      "Colágeno corporal"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Injetáveis",
    "name": "Bioestimulador de Colágeno Facial",
    "duration": "40 min",
    "description": "Procedimento injetável com substâncias bioestimuladoras para estimular colágeno e melhorar gradualmente a qualidade da pele.",
    "goals": [
      "Flacidez facial",
      "Perda de firmeza",
      "Qualidade da pele"
    ],
    "benefits": [
      "Pode estimular colágeno",
      "Auxilia na melhora gradual da firmeza e qualidade da pele"
    ],
    "aliases": [
      "Bioestimulador facial",
      "Estímulo de colágeno"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Injetáveis",
    "name": "Botox",
    "duration": "20 min",
    "description": "Aplicação de toxina botulínica em pontos definidos pela profissional para suavizar linhas de expressão relacionadas à movimentação muscular.",
    "goals": [
      "Linhas de expressão",
      "Testa",
      "Glabela",
      "Pés de galinha",
      "Outras áreas avaliadas pela profissional"
    ],
    "benefits": [
      "Pode suavizar linhas de expressão dinâmicas",
      "Contribui para aparência mais descansada preservando naturalidade conforme planejamento"
    ],
    "aliases": [
      "Toxina botulínica",
      "Botox facial"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Injetáveis",
    "name": "Carboxiterapia",
    "duration": "15 min",
    "description": "Procedimento que utiliza gás carbônico medicinal em protocolos estéticos definidos conforme a região e objetivo.",
    "goals": [
      "Celulite",
      "Flacidez",
      "Estrias",
      "Gordura localizada",
      "Olheiras em protocolos específicos"
    ],
    "benefits": [
      "Pode complementar protocolos para celulite, flacidez e estrias",
      "Objetivo varia conforme a área tratada"
    ],
    "aliases": [
      "Carbox",
      "Carboxterapia"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Injetáveis",
    "name": "Enzimas",
    "duration": "20 min",
    "description": "Procedimento injetável com ativos definidos pela profissional conforme região e objetivo do protocolo.",
    "goals": [
      "Gordura localizada",
      "Celulite",
      "Papada",
      "Outros objetivos avaliados pela profissional"
    ],
    "benefits": [
      "Pode complementar protocolos para gordura localizada e contorno",
      "Benefícios dependem do ativo e plano definido"
    ],
    "aliases": [
      "Aplicação de enzimas",
      "Enzimas para gordura localizada"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Injetáveis",
    "name": "Escleroterapia (Secagem de Vasinhos)",
    "duration": "40 min",
    "description": "Procedimento realizado para tratamento estético de pequenos vasos aparentes, após avaliação profissional.",
    "goals": [
      "Vasinhos aparentes",
      "Microvasos",
      "Telangiectasias"
    ],
    "benefits": [
      "Pode reduzir a aparência de pequenos vasos tratados",
      "Contribui para aparência mais uniforme da região"
    ],
    "aliases": [
      "Secagem de vasinhos",
      "PEIM",
      "Escleroterapia"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Injetáveis",
    "name": "Glúteo Max",
    "duration": "30 min",
    "description": "Protocolo injetável voltado à região glútea, definido conforme avaliação e objetivo estético.",
    "goals": [
      "Contorno glúteo",
      "Qualidade da pele",
      "Flacidez",
      "Celulite conforme protocolo"
    ],
    "benefits": [
      "Pode melhorar visualmente contorno e qualidade da pele",
      "Plano depende da necessidade individual"
    ],
    "aliases": [
      "Gluteo Max",
      "Protocolo Glúteo Max"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Injetáveis",
    "name": "Hidrolipoclasia",
    "duration": "60 min",
    "description": "Procedimento estético utilizado em protocolos para gordura localizada, realizado em áreas selecionadas após avaliação.",
    "goals": [
      "Gordura localizada",
      "Medidas localizadas",
      "Contorno corporal"
    ],
    "benefits": [
      "Pode auxiliar na redução de medidas localizadas",
      "Complementa protocolos de contorno corporal"
    ],
    "aliases": [
      "Hidrolipo",
      "Hidrolipoclasia não aspirativa"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Injetáveis",
    "name": "Ozonoterapia",
    "duration": "15–30 min",
    "description": "Uso de ozônio em protocolos estéticos específicos, conforme avaliação profissional e técnica aplicada.",
    "goals": [
      "Celulite",
      "Estrias",
      "Flacidez",
      "Protocolos corporais combinados"
    ],
    "benefits": [
      "Pode ser utilizada como recurso complementar em protocolos estéticos",
      "Objetivos variam conforme região e técnica"
    ],
    "aliases": [
      "Ozônio",
      "Ozonio"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Injetáveis",
    "name": "PDRN",
    "duration": "30 min",
    "description": "Procedimento injetável voltado à qualidade e revitalização da pele, realizado conforme avaliação profissional.",
    "goals": [
      "Pele opaca",
      "Textura irregular",
      "Sinais de envelhecimento",
      "Qualidade da pele"
    ],
    "benefits": [
      "Pode auxiliar na melhora da qualidade e aparência da pele",
      "Contribui para protocolos de revitalização"
    ],
    "aliases": [
      "Polinucleotídeos",
      "PDRN facial"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Injetáveis",
    "name": "Preenchimento Facial",
    "duration": "30 min",
    "description": "Procedimento injetável realizado para reposição de volume, contorno ou harmonização de áreas faciais, conforme planejamento individual.",
    "goals": [
      "Perda de volume",
      "Assimetria",
      "Contorno facial",
      "Sulcos e áreas específicas"
    ],
    "benefits": [
      "Pode melhorar proporções e contornos faciais",
      "Permite planejamento individualizado de volume e estrutura"
    ],
    "aliases": [
      "Preenchimento com ácido hialurônico",
      "Filler facial"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Injetáveis",
    "name": "Skinbooster",
    "duration": "40 min",
    "description": "Procedimento injetável com foco em hidratação profunda e qualidade da pele, conforme avaliação.",
    "goals": [
      "Ressecamento",
      "Linhas finas",
      "Pele opaca",
      "Qualidade da pele"
    ],
    "benefits": [
      "Pode melhorar hidratação e viço",
      "Auxilia na aparência de linhas finas e textura"
    ],
    "aliases": [
      "Hidratação injetável",
      "Skin booster"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Injetáveis",
    "name": "Harmonização de Glúteo",
    "duration": "90 min",
    "description": "Planejamento estético da região glútea com técnicas combinadas para contorno, proporção e qualidade da pele.",
    "goals": [
      "Contorno glúteo",
      "Projeção",
      "Assimetria",
      "Flacidez",
      "Qualidade da pele"
    ],
    "benefits": [
      "Pode melhorar proporção e contorno da região",
      "Plano é individualizado conforme anatomia e objetivo"
    ],
    "aliases": [
      "Harmonização glútea",
      "Harmonização de bumbum"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Injetáveis",
    "name": "Fios de Sustentação",
    "duration": "60 min",
    "description": "Procedimento minimamente invasivo com fios absorvíveis utilizados conforme técnica e avaliação para suporte e estímulo de colágeno.",
    "goals": [
      "Flacidez facial",
      "Contorno facial",
      "Perda de sustentação"
    ],
    "benefits": [
      "Pode promover efeito de sustentação em casos selecionados",
      "Pode estimular colágeno ao longo do tempo"
    ],
    "aliases": [
      "Fios PDO",
      "Fios faciais"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Injetáveis",
    "name": "Perfiloplastia",
    "duration": "A definir",
    "description": "Planejamento de harmonização do perfil facial que pode combinar preenchimentos em áreas estratégicas, conforme avaliação.",
    "goals": [
      "Perfil facial",
      "Proporção entre nariz, lábios e queixo",
      "Contorno facial"
    ],
    "benefits": [
      "Pode melhorar equilíbrio e proporção do perfil",
      "Planejamento é individualizado"
    ],
    "aliases": [
      "Harmonização de perfil",
      "Perfiloplastia facial"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Injetáveis",
    "name": "Rinomodelação",
    "duration": "A definir",
    "description": "Procedimento injetável para ajustes estéticos no contorno nasal em casos selecionados, após avaliação profissional.",
    "goals": [
      "Contorno nasal",
      "Assimetria visual",
      "Perfil do nariz"
    ],
    "benefits": [
      "Pode melhorar visualmente o contorno e proporção do nariz em casos indicados"
    ],
    "aliases": [
      "Rino com ácido hialurônico",
      "Preenchimento nasal"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Preenchimentos",
    "name": "Preenchimento de Olheiras",
    "duration": "30 min",
    "description": "Preenchimento injetável da região infraorbital em casos selecionados para suavizar depressões e aspecto de sombra.",
    "goals": [
      "Olheira funda",
      "Sulco infraorbital",
      "Aspecto cansado"
    ],
    "benefits": [
      "Pode suavizar depressões da região",
      "Contribui para aparência mais descansada em casos indicados"
    ],
    "aliases": [
      "Preenchimento de olheira"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Preenchimentos",
    "name": "Preenchimento Labial",
    "duration": "30 min",
    "description": "Procedimento injetável para melhorar volume, contorno, hidratação visual e proporção dos lábios.",
    "goals": [
      "Pouco volume labial",
      "Contorno labial",
      "Assimetria",
      "Proporção dos lábios"
    ],
    "benefits": [
      "Pode aumentar ou restaurar volume",
      "Pode definir contorno e melhorar proporção labial"
    ],
    "aliases": [
      "Preenchimento de lábios",
      "Ácido hialurônico labial"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Preenchimentos",
    "name": "Preenchimento Malar",
    "duration": "30 min",
    "description": "Preenchimento injetável da região malar para suporte, projeção e melhora do contorno facial.",
    "goals": [
      "Perda de volume malar",
      "Contorno facial",
      "Aspecto cansado"
    ],
    "benefits": [
      "Pode melhorar suporte e projeção da região",
      "Contribui para equilíbrio do contorno facial"
    ],
    "aliases": [
      "Preenchimento de maçã do rosto",
      "Preenchimento zigomático"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Preenchimentos",
    "name": "Preenchimento de Mandíbula",
    "duration": "30 min",
    "description": "Preenchimento injetável para definição e harmonização do contorno mandibular.",
    "goals": [
      "Mandíbula pouco marcada",
      "Contorno facial",
      "Assimetria"
    ],
    "benefits": [
      "Pode melhorar definição da linha mandibular",
      "Contribui para equilíbrio das proporções faciais"
    ],
    "aliases": [
      "Preenchimento mandibular",
      "Mandíbula"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Preenchimentos",
    "name": "Preenchimento de Mento",
    "duration": "30 min",
    "description": "Preenchimento injetável do queixo para projeção, contorno e equilíbrio do perfil facial.",
    "goals": [
      "Queixo retraído",
      "Perfil facial",
      "Proporção do terço inferior"
    ],
    "benefits": [
      "Pode melhorar projeção e contorno do mento",
      "Contribui para equilíbrio do perfil facial"
    ],
    "aliases": [
      "Preenchimento de queixo",
      "Mento"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Preenchimentos",
    "name": "Preenchimento de Têmporas",
    "duration": "A definir",
    "description": "Preenchimento injetável da região temporal para reposição de volume em casos selecionados.",
    "goals": [
      "Têmporas fundas",
      "Perda de volume lateral da face",
      "Aspecto esqueletizado"
    ],
    "benefits": [
      "Pode repor volume e suavizar depressões da região",
      "Contribui para harmonização do contorno facial"
    ],
    "aliases": [
      "Preenchimento temporal",
      "Têmporas"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Massagens",
    "name": "Drenagem Linfática",
    "duration": "60 min",
    "description": "Massagem com manobras específicas e suaves voltadas ao estímulo do fluxo linfático.",
    "goals": [
      "Inchaço",
      "Retenção de líquidos",
      "Sensação de peso"
    ],
    "benefits": [
      "Pode auxiliar na redução de inchaço e retenção",
      "Promove sensação de leveza"
    ],
    "aliases": [
      "Drenagem corporal",
      "Drenagem linfática manual"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Massagens",
    "name": "Drenagem Pós-Operatório",
    "duration": "90 min",
    "description": "Drenagem realizada dentro de protocolos pós-operatórios, seguindo liberação e orientação adequada para cada fase.",
    "goals": [
      "Inchaço pós-operatório",
      "Retenção de líquidos",
      "Cuidados de recuperação"
    ],
    "benefits": [
      "Pode auxiliar no controle de edema e conforto",
      "Complementa o acompanhamento pós-operatório"
    ],
    "aliases": [
      "Drenagem pós",
      "Pós-operatório"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Massagens",
    "name": "Massagem com Bambu",
    "duration": "60 min",
    "description": "Massagem realizada com hastes de bambu e manobras corporais para relaxamento e cuidado corporal.",
    "goals": [
      "Tensão muscular",
      "Relaxamento",
      "Sensação de cansaço"
    ],
    "benefits": [
      "Promove relaxamento e bem-estar",
      "Pode auxiliar na sensação de leveza corporal"
    ],
    "aliases": [
      "Bambuterapia"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Massagens",
    "name": "Massagem com Pedras Quentes",
    "duration": "60 min",
    "description": "Massagem relaxante que utiliza pedras aquecidas associadas a manobras corporais.",
    "goals": [
      "Tensão muscular",
      "Estresse",
      "Relaxamento"
    ],
    "benefits": [
      "Promove relaxamento e sensação de conforto",
      "Auxilia no bem-estar corporal"
    ],
    "aliases": [
      "Pedras quentes"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Massagens",
    "name": "Massagem com Ventosa",
    "duration": "60 min",
    "description": "Massagem que utiliza ventosas como recurso complementar às manobras corporais.",
    "goals": [
      "Tensão muscular",
      "Sensação de rigidez",
      "Cuidados corporais"
    ],
    "benefits": [
      "Pode promover relaxamento e mobilização dos tecidos",
      "Complementa protocolos de bem-estar"
    ],
    "aliases": [
      "Ventosaterapia"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Massagens",
    "name": "Massagem Modeladora",
    "duration": "60 min",
    "description": "Massagem com manobras mais intensas utilizada em protocolos corporais para contorno e mobilização dos tecidos.",
    "goals": [
      "Contorno corporal",
      "Inchaço",
      "Aspecto de celulite"
    ],
    "benefits": [
      "Pode auxiliar no contorno visual e sensação de desinchaço",
      "Complementa protocolos corporais"
    ],
    "aliases": [
      "Modeladora",
      "Massagem redutora"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Massagens",
    "name": "Massagem Relaxante",
    "duration": "60 min",
    "description": "Massagem com manobras suaves e contínuas voltadas ao relaxamento e bem-estar.",
    "goals": [
      "Estresse",
      "Tensão muscular",
      "Cansaço"
    ],
    "benefits": [
      "Promove relaxamento",
      "Pode aliviar sensação de tensão e cansaço"
    ],
    "aliases": [
      "Relaxante"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Massagens",
    "name": "Quick Massage",
    "duration": "30 min",
    "description": "Massagem de curta duração focada em áreas de maior tensão, com objetivo de proporcionar relaxamento rápido.",
    "goals": [
      "Tensão em costas e pescoço",
      "Cansaço",
      "Pouco tempo disponível"
    ],
    "benefits": [
      "Promove relaxamento em sessão curta",
      "Pode aliviar sensação de tensão muscular"
    ],
    "aliases": [
      "Massagem rápida"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Massagens",
    "name": "Day SPA",
    "duration": "A definir",
    "description": "Experiência de bem-estar que reúne etapas de cuidado corporal e relaxamento, conforme o pacote contratado.",
    "goals": [
      "Relaxamento",
      "Autocuidado",
      "Experiência de bem-estar"
    ],
    "benefits": [
      "Promove uma experiência de cuidado e relaxamento",
      "Etapas variam conforme o pacote"
    ],
    "aliases": [
      "Spa Day",
      "Dia de SPA"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Outros",
    "name": "Harmonização Facial",
    "duration": "A definir",
    "description": "Planejamento estético individualizado que pode combinar procedimentos para melhorar proporções, contornos e equilíbrio facial.",
    "goals": [
      "Assimetria facial",
      "Perda de volume",
      "Contorno facial",
      "Proporções"
    ],
    "benefits": [
      "Pode melhorar equilíbrio e harmonia das proporções faciais",
      "Plano é personalizado para cada rosto"
    ],
    "aliases": [
      "Harmonização",
      "Harmonização facial completa"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Outros",
    "name": "Tratamento para Estrias",
    "duration": "Depende do protocolo",
    "description": "Plano estético personalizado que pode combinar diferentes técnicas conforme tipo, cor, localização e tempo das estrias.",
    "goals": [
      "Estrias claras",
      "Estrias avermelhadas",
      "Textura irregular"
    ],
    "benefits": [
      "Pode melhorar gradualmente a aparência e textura das estrias",
      "Resultado depende do protocolo e resposta individual"
    ],
    "aliases": [
      "Protocolo para estrias"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Outros",
    "name": "Tratamento para Celulite",
    "duration": "Depende do protocolo",
    "description": "Plano corporal personalizado que pode combinar tecnologias e técnicas conforme grau e características da celulite.",
    "goals": [
      "Celulite",
      "Ondulações na pele",
      "Aspecto irregular"
    ],
    "benefits": [
      "Pode melhorar gradualmente o aspecto da celulite e da pele",
      "Permite combinação de recursos conforme avaliação"
    ],
    "aliases": [
      "Protocolo anticelulite",
      "Tratamento anticelulite"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  },
  {
    "category": "Outros",
    "name": "Clareamento de Axilas, Virilhas e Áreas Íntimas",
    "duration": "30 min",
    "description": "Protocolo de clareamento estético para regiões com escurecimento, definido conforme avaliação e sensibilidade local.",
    "goals": [
      "Escurecimento de axilas",
      "Escurecimento de virilha",
      "Tom irregular em áreas íntimas externas"
    ],
    "benefits": [
      "Pode auxiliar na uniformização visual do tom",
      "Contribui para aparência mais cuidada da região"
    ],
    "aliases": [
      "Clareamento íntimo",
      "Clareamento de axila",
      "Clareamento de virilha"
    ],
    "resultTimeline": "A evolução varia conforme o plano definido na avaliação.",
    "paymentMethods": [
      "pix",
      "credito",
      "debito"
    ],
    "pixKey": "44.438.614/0001-25"
  }
];
