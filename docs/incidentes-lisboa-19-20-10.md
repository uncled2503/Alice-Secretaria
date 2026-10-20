# Incidentes da Lisboa (19 e 20/10/2026): matriz, correções, validação e implantação

Revisão do código: `2026-10-20-a`. **Nada daqui está em produção**: não houve commit, push, deploy nem envio real nesta etapa. Testes com OpenAI, WhatsApp e Clínica Experts (CE) **simulados**, modelo **roteirizado**: provam o que o código envia, libera, barra e entrega, não como o modelo real redige.

## 0. Estado inspecionado

- HEAD: `d818fd5` (master = origin/master; contém `50de2c8`, lote de vendas/custo, e `d818fd5`, ferramentas do incidente de lembretes). Branch local/remota `hotfix/lisboa-recuperacao-20-10` = `e405310` + só o comando de recuperação.
- **Versão em produção: não verificada** (sem URL nem credencial neste ambiente). Falta o JSON do `/health` (campos `revision`, `lastMigration`). O push não reinicia o servidor (é preciso "Implantar" no EasyPanel).
- Os prints comprovam **o conteúdo** das mensagens; que as reservas não existem na agenda foi informado pelo dono e **precisa ser conferido no CE e no banco de produção** (`scripts/incidente-lembretes.mjs` e a trilha `ReminderDispatch`/`Appointment`). Mensagens apagadas (caso Eliana) não têm conteúdo presumido.

## 1. Matriz: incidente → evidência → causa → correção → teste → dependência

| # | Incidente | Evidência | Causa **encontrada no código** (comprovada por leitura + reprodução) | Correção | Teste | Dependência / o que NÃO está provado |
|---|---|---|---|---|---|---|
| 1 | **Veruska**: confirmou "os dois às 18h30 com a Adriana" sem agendar | print + dono: sem reserva, sem nome/contato do marido | (a) a trava da resposta final só reconhecia poucas palavras (`agendei`, `está agendado`…): "confirmado", "seu horário ficou", "vocês estão marcados", "te esperamos às…" passavam; (b) não havia noção de **segunda pessoa**: `book_appointment` agenda sempre quem conversa e, com CE conectado, `patient_full_name` **sobrescrevia o nome do cadastro** da cliente | conclusão por **significado e origem** (`replyFacts.ts` + `replyGuard.ts`): só vale reserva criada agora pela ferramenta ou existente na agenda (e batendo dia/hora); regra de **pessoas separadas** injetada quando há acompanhante (reserva só de quem conversa; a outra vai para a equipe como "RESERVA PENDENTE"; nunca "os dois agendados" sem duas reservas); nome de outra pessoa **não** sobrescreve o cadastro; saída segura pede nome completo e telefone de cada uma e **executa a transferência** | `incidentes-lisboa-fatos` (DOIS PACIENTES, SUCESSO PARCIAL, identidade), `incidentes-lisboa-e2e` (VERUSKA) | Agendar terceiro com segurança exige cadastro próprio + telefone: **não implementado** (vai para a equipe). Capacidade para duas pessoas simultâneas depende de profissional/duração cadastradas |
| 2 | **Veruska**: "terça-feira, 29/10" (29/10/2026 é quinta) | print | já existia correção de dia da semana na geração, mas a **reescrita da revisão por IA na entrega** não passava por ela | as correções de dia/rótulo rodam em `chooseFinalReply` sobre a original **e** a reescrita, **antes** de validar (o texto validado é o que sai) | `incidentes-lisboa-fatos` (DIA DA SEMANA) | Não está provado se o erro do print veio do modelo ou da reescrita |
| 3 | **Mariana**: "pode ser sim" tratado como reserva feita | print + dono: sem reserva | (a) "confirmado"/"fica confirmado" não eram detectados (item 1a); (b) a fala da **equipe** no chat podia virar "este lead já está agendado" (etiqueta) por frase de **pergunta/proposta** (`posso agendar amanhã às 12h?`); (c) "amanhã" da equipe/cliente era resolvido pelo dia em que a Alice **processa** | (a) idem; (b) só frase afirmativa conta e, sem reserva na agenda, a etiqueta manda **efetivar pela agenda** (`check_specific_time` → `book_appointment`) ou transferir, nunca afirmar; (c) `refIso`: datas relativas ancoradas na data em que a fala foi **escrita**, fuso da clínica (virada da meia-noite); briefing explícito quando as datas diferem; (d) o aviso `CLAIM_NUDGE` devolve ao modelo a afirmação sem reserva | `incidentes-lisboa-fatos` (MEIA-NOITE, staff), `incidentes-lisboa-e2e` (MARIANA ×2, RETOMADA) | Por que a Alice retomou naquele caso: a regra de retorno (15 min, só se uma pessoa já agiu) **não foi alterada**; sem os dados da conversa original não dá para provar qual caminho foi usado |
| 4 | Ponto final de envio | — | trava só em palavras isoladas; fotos/quantidade/valor/formação sem origem | `replyGuard`: conclusão, fotos (`enviei` exige envio confirmado), UI, R$, formação; texto bloqueado vira saída útil, nunca silêncio; resposta segura factual **encaminha** à equipe; roda com revisor ligado, desligado ou fora do ar | `resposta-final`, `incidentes-lisboa-*` (REVISOR INDISPONIVEL) | — |
| 5 | **Robelia**: Sabrina "médica" | print + dono: é **biomédica** | `Professional` só tinha `title` ("Dra."); o prompt lista `Dra. Sabrina` e o modelo infere a formação | campo **`qualification`** (formação) separado do tratamento; prompt `[formacao: …]` + regra de não deduzir; trava de resposta; `lisboaFatos` | `incidentes-lisboa-*` (FORMACAO), `lisboa-fatos` | Cadastro **precisa ser aplicado em produção**. Não inventa outra médica; se exigirem médica sem dado confirmado → equipe |
| 6 | **Robelia/Orzy**: UI | prints; dono: oferta de **50 UI** | não havia campo estruturado: o modelo inventou a faixa "20 a 50 UI" ou respondeu "varia" | campo **`Procedure.includedQuantity`** ("quantidade INCLUÍDA na oferta", distinta de dose individual); trava: número de UI só se cadastrado; faixa nunca | `incidentes-lisboa-*` (QUANTIDADE), `lisboa-fatos` | Clínica indicar **qual procedimento** é a oferta (`--oferta=<id>`); marca não presumida; outras ofertas não herdam 50 UI |
| 7 | **Eliana**: criolipólise | print (resposta seguinte apagada: conteúdo desconhecido) | (a) conversa de agenda recente transformava pergunta **informativa** em agenda ("vou verificar horários"); (b) "vou verificar e já te aviso" sem ação; (c) o prompt mostrava `(90min)` como se fosse duração do procedimento | pergunta informativa responde com o cadastro e **fecha a agenda no turno**; sem dado → `transfer_to_human` (promessa sem ação é devolvida ao modelo); duração agora é "reserva de Nmin na agenda"; FAQ **criolipólise de placas** | `incidentes-lisboa-*` (ELIANA, MENSAGENS AGRUPADAS) | **Pendentes da clínica** (nada foi presumido): nº de sessões, se inclui radiofrequência, fonte dos 90 min (aplicação x reserva); a distinção de flacidez entre tecnologias aguarda validação da responsável técnica |
| 8 | **Paula**: Carboxiterapia/Skinbooster + preços + "estou à disposição" | print | indicação e valores sem trava de origem; fecho genérico sem convite | trava de R$ (só preço/parcela do cadastro ou escritos nas regras/FAQ/mensagens); lead interessado recebe convite concreto; "estou à disposição" final é removido | `incidentes-lisboa-e2e` (PAULA) | Fonte e vigência dos preços/indicações do print **não comprovadas**: não usar como cadastro; pendente da clínica |
| 9 | **Lívia**: peeling + cicatriz de acne | print | sem passo para fotos/convite depois da necessidade dita | fotos aprovadas **do próprio procedimento** (sem repetir, falha registrada com a verdade, ausência não paralisa) + convite "Quer que eu veja um horário para sua avaliação?" (ou para o procedimento único que agenda direto); nunca depois de recusa/agendamento/pedido de horário | `incidentes-lisboa-e2e` (LIVIA, FOTOS ×3), `vendedora-*` | Fotos precisam estar cadastradas por procedimento (galeria) |
| 10 | **Orzy**: expediente x vagas | print | "dias e horários de atendimento" disparava agenda | `asksOpeningHours` → responde expediente; agenda fechada | `incidentes-lisboa-*` (EXPEDIENTE) | — |
| 11 | Repetição / "Oi" no meio | prints | cumprimento repetido e fecho idêntico | cumprimento removido se houve fala da Alice nas últimas 12 h; fecho genérico removido; mensagens seguidas lidas juntas (já existia), agora com todas as perguntas pendentes | `incidentes-lisboa-*` | Eventos duplicados/concorrência: suíte de agrupamento existente passou; **nenhum defeito novo provado** |
| 12 | **Lembretes de 20/10** | relato da Aline | **não determinada** (sem dados de produção) | prévia + recuperação segura (hotfix branch e master); diagnóstico sem deploy | `incidente-lembretes-lisboa` (12), `confirmacao-pos-auditoria` | ver `scripts/incidente-lembretes.mjs`; hipóteses abertas no relatório anterior |
| 13 | Resultado incerto ao criar no CE | (requisito) | recusa e timeout recebiam o mesmo tratamento | resultado **incerto** (rede/tempo esgotado) é registrado (`ce_mirror_uncertain`), não diz "agendado", **não recria** por 60 min e envia à equipe; pull periódico do CE reconcilia se a reserva existir | `agenda-ferramentas` | — |

## 2. Jornadas

Suelen 12h–21h, Adriana 12h–21h, Talita 8h–17h: o código de elegibilidade/jornada **não foi alterado** nesta etapa; a aplicação no cadastro é feita pelo comando existente com prévia (`POST /api/clinics/lisboa-jornadas`). **Não verificado em produção**.

## 3. O que cada ajuste cadastral faz (`node dist/maintenance/lisboaFatos.js`)

Prévia por padrão; `--aplicar` grava só: formação da Sabrina (campo vazio), quantidade do procedimento indicado em `--oferta=<id>` (campo vazio), e a FAQ nova "Qual tecnologia de criolipólise a clínica usa?". Nunca edita texto manual existente: relata conflitos (trechos com "médica Sabrina", faixa de UI, "sucção") para revisão humana. Idempotente; outra clínica intacta.

**Exige informação da clínica** (nada foi preenchido por suposição): sessões e intervalo da criolipólise; radiofrequência incluída ou não; origem dos 90 min; validação da distinção de flacidez; indicação/preços/vigência de Carboxiterapia e Skinbooster; procedimento da oferta de 50 UI e marca; fotos aprovadas por queixa; existência de profissional médica.

## 4. Consumo de tokens

Nenhuma chamada de IA nova por verificação: tudo é código (regex/estado). O prompt cresce só com a linha `[formacao: …]`, `Quantidade INCLUIDA…` e a regra "6. FATOS QUE NAO SE DEDUZ" (≈ 650 caracteres, parte estável do prefixo, aproveita cache). Cada refação por afirmação sem reserva (`CLAIM_NUDGE`) acrescenta **no máximo uma** chamada principal naquele turno (mesmo teto de correções que já existia). A economia da etapa de custo não foi alterada.

## 5. Reversão

- `ALICE_REPLY_FACTS=off`: desliga **só** as travas novas de fatos (conclusão por significado, fotos, UI, valor, formação) e o acabamento (saudação/fecho/convite). `ALICE_TURN_READING=off`: leitura do turno (etapa anterior).
- Banco: `Professional.qualification` e `Procedure.includedQuantity` são colunas opcionais; versão anterior do código as ignora. Reverter o commit é compatível com todos os estados novos (inclusive `AppointmentConfirmation` e `PostProcedureSent.state`).

## 6. Sequência de implantação sugerida

1. Colar o `/health` de produção (revisão e migração) e rodar `node scripts/incidente-lembretes.mjs 2026-10-20` (somente leitura) para fechar a causa dos lembretes.
2. Decidir: implantar a **master** (traz tudo, incluindo as migrações `20261019210000`, `20261022100000`, `20261022120000`) ou a **branch hotfix** (só a recuperação).
3. "Implantar" no EasyPanel; conferir `/health`.
4. `node dist/maintenance/lisboaFatos.js --oferta=<id do procedimento da oferta>` (prévia) → revisar → `--aplicar`.
5. Preencher no painel: formação (Profissionais), quantidade incluída (Procedimento), fotos.
6. Recuperação dos lembretes: prévia → autorização explícita → `--executar --autorizado`.
7. Avaliação real do texto com o modelo real e contatos de teste autorizados (roteiro em `docs/vendedora-consultiva.md` e abaixo).

## 7. Roteiro de avaliação real (não executado)

Com contatos de teste autorizados e a clínica de teste: (1) cliente + acompanhante pedindo o mesmo horário; (2) aceite de proposta da equipe após meia-noite; (3) "a Sabrina é médica?"; (4) "quantas UI tem a oferta?"; (5) "dias e horários de atendimento?"; (6) "em quantas sessões?" e "inclui radiofrequência?"; (7) "cicatriz de acne" com e sem fotos cadastradas; (8) "bolsas sob os olhos" (sem preço cadastrado); (9) "OK, obrigada" depois do convite; (10) falha de envio de fotos; (11) CE fora do ar durante a reserva. Conferir texto, log `[decisao]` e o que ficou gravado.

## 8. Limitações

Modelo roteirizado: não prova a qualidade do texto real. A leitura é por padrões em português; fala fora do padrão cai no comportamento anterior, sem inferência inventada. Capacidade para duas pessoas e agendamento de terceiros dependem de decisão e cadastro da clínica.
