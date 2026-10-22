# Disparos: auditoria de envios, aba "Disparos" e recuperação (22/10/2026)

Situação: **local, sem commit, sem push, sem deploy, nenhum envio real**. Produção não foi lida nem alterada (não há acesso nesta sessão). Base analisada: commit `bf96925` + alterações locais.

## 1. Causas: o que está provado e o que é hipótese

**Provado no código (e coberto por teste):**

| # | Achado | Efeito | Correção |
|---|---|---|---|
| 1 | A resposta do provedor era descartada: nenhum id de mensagem, nenhum destino realmente usado, nenhum estado de entrega | "enviado" nunca significava mais que "a chamada não falhou"; impossível conciliar | `providerId`, `destination`, `attemptedAt`, `deliveryState` em lembretes e aniversários; webhook `messages_update` atualiza só para frente |
| 2 | Aniversário: a linha de controle era **apagada** em falha/barramento (motivo perdido) e `duplicate` contava como enviado | pessoa sem parabéns e sem rastro | estados persistem (`deferred/failed/vetoed/failed_permanent/unconfirmed/duplicate`), motivo e tentativas ficam visíveis; "duplicado" só com a mensagem no chat |
| 3 | Aniversário: reserva abandonada era sempre "incerta" e o rodada inteira parava no primeiro erro | parabéns perdido por queda de processo; um telefone ruim barrava os demais | `attemptedAt` distingue reserva (provedor não chamado → libera) de tentativa iniciada (incerta, nunca reenvia); erro por pessoa isolado |
| 4 | Lembretes: fila única sequencial entre clínicas; candidatos problemáticos ocupavam sempre o começo | clínica lenta/ruim atrasava as outras; starvation | uma clínica por vez em paralelo; fila ordenada por tentativas; controle persistente consultado antes do orçamento de checagens |
| 5 | Lembretes: qualquer erro de banco em `ReminderSent.create` virava "duplicado" | envio descartado por falha transitória | só violação de unicidade (P2002) é duplicidade; outro erro adia |
| 6 | Telefone: sem leitura central; fallback do 9º dígito por regex de mensagem | formatos válidos recusados, tentativa dupla indevida, pessoas fundidas pelos 8 últimos dígitos | `src/uazapi/phone.ts` (ver §3) |
| 7 | HTTP 200 com corpo de erro e sem id era tratado como enviado | falso "enviado" | vira falha tipada |
| 8 | Lembretes ignoravam `Patient.optedOut` (LGPD) | mensagem para quem pediu para não receber | filtro `opt_out` na seleção |
| 9 | Nenhum rastro de que o job rodou em ciclos ociosos; sem ampliação de janela | impossível distinguir "job parado" de "nada a fazer"; envio perdido ao fim da janela | uma linha de `AutomationRun` por clínica por rodada; ampliação autorizada (§2) |

**Hipóteses (não comprovadas sem produção):** a causa real de cada aniversário/confirmação que a Lisboa não recebeu (job parado, WhatsApp fora, Clínica Experts indisponível, telefone, aniversariante não importado). A aba mostra, por item, o motivo registrado; onde não há registro, diz **"sem evidência suficiente"** em vez de inventar causa. O relatório somente leitura (`scripts/disparos-lisboa.mjs`) deve ser rodado contra a produção.

## 2. Ampliação automática da janela (autorizada)

Política por clínica e tipo (`DispatchPolicy`, editável na aba → "Janela e ampliação"). Padrões: confirmação até 18h (máx. 360 min, antecedência 120 min), cobrança 19h, lembrete 20h, aniversário 21h.

- Só com **causa operacional comprovada**: rodada que não aconteceu na janela, falhas/adiamentos/capacidade nas rodadas, WhatsApp fora. Janela cumprida sem problema = sem ampliação.
- Sempre no **dia local** da clínica; **teto duro 21h**; respeita a antecedência mínima do atendimento; mesmo ritmo de envio (ampliar não acelera).
- Item enviado na janela ampliada registra `extendedReason` e `deadlineAt`. Passou do limite = expira; a equipe é avisada (aniversário: `birthday_expired`; confirmações: aviso de cobertura já existente).
- **Alerta de capacidade** (`dispatch_capacity_risk`): se o que falta não cabe nas rodadas que restam, a equipe é avisada uma vez por regra/dia, antes do prazo.
- Desligar: `extendEnabled=false` (os testes antigos que esperavam "nada fora da janela" usam isso).

## 3. Telefones (`src/uazapi/phone.ts`, `phoneRegistry.ts`)

BR com/sem DDI, 0 de tronco, `00`, `+`, fixo (nunca ganha 9), celular antigo sem 9, internacional plausível, JID/`@` não é telefone, DDI duplicado só quando o miolo é BR válido. Chave canônica (`canonicalKey`) iguala só as duas escritas do **mesmo** celular; fixo e celular não se fundem (também no sync de aniversários do CE e na confirmação de presença).

**Fallback com/sem 9:** só após rejeição **explícita** do provedor (mensagem "não está no WhatsApp"), com **uma** alternativa estruturalmente válida, **nunca** depois de timeout/429/5xx/queda/incerto, nunca os dois. A resolução validada fica em `PhoneResolution` (original, usado, fonte, motivo, data) e o sync não a desfaz. Ações no painel: "Usar a outra forma do número", "Corrigir telefone" (valida, recusa número de outro cadastro, **não reenvia na hora**, não apaga histórico).

## 4. Aba Disparos

Menu **Organização → Disparos** (`public/disparos.js`, `src/api/dispatches.ts`, `src/dispatch/*`).

- Visões: Hoje · Próximos · Precisam de atenção · Histórico (+ período livre, máx. 31 dias).
- Contadores separados: esperados, fora (legítimo), **aceitos**, **entregues**, **lidos**, adiados, falharam, incertos, expirados, não tentados, recuperáveis hoje. Aceito ≠ entregue; nunca somados. A soma dos baldes fecha com o total (teste).
- Cobertura por tipo: percentual só quando a fonte é completa (agenda da própria Alice); com Clínica Experts, aniversários (só os cadastrados) e cobrança, aparece **"não calculável"** + a nota do porquê. Nunca 100% por padrão.
- Motivos: lista fechada em `REASONS` (não importado, nascimento ausente, telefone ausente/inválido/ambíguo, regra desligada, opt-out, fora da janela, capacidade, trava ocupada, CE indisponível, WhatsApp desconectado, revisão barrou, falha do provedor, incerto, já enviado, cancelado/remarcado/confirmado, tentativas esgotadas, prazo expirado, sem evidência…).
- Filtros: período, tipo, estado, motivo, regra, profissional, busca (nome ou final do telefone), recuperável hoje, janela ampliada. Escopo de clínica **no servidor**.
- Detalhe (gaveta): estado, motivo, origem, tentativas, telefone cadastrado × destino usado (mascarados), id do provedor (truncado), entrega, janela ampliada, mensagem, linha do tempo, e as ações.
- Ações individuais: tentar de novo agora, tentar mais tarde hoje, conciliar incerto (equipe atesta "chegou"/"não saiu"), corrigir telefone, resolver destino, avisar a equipe, cancelar pendente. Lote: recuperar selecionados / todos do filtro (com prévia), exportar CSV (BOM, telefones mascarados, neutraliza fórmula de planilha).
- Seleção: "N selecionados nesta página" × "todos os X resultados do filtro" (explícito).

## 5. Recuperação em lote (fila persistida)

`DispatchRun` + `DispatchRunItem` (migração aditiva `20261025100000_disparos`). O HTTP só cria a fila; o worker (job `disparos` a cada minuto + empurrão logo após criar) envia.

- **Idempotência:** `activeKey` único = clínica|tipo|referência|versão do horário|regra, liberado ao terminar → duplo clique, segundo usuário e recriação não duplicam.
- **Mesma via de envio:** `deliverReminder` / `deliverBirthday`: revalida estado, CE ao vivo, reserva atômica no controle persistente, revisão de envio, registro do desfecho. Cron e painel juntos mandam **uma** vez (teste).
- Revalidação por item: cancelou/confirmou/remarcou (horário mudou)/já recebeu/depois das 21h/telefone recusado com o mesmo número → sai da fila com o motivo.
- Concessão com dono e validade (renovada por item); reinício devolve o que ficou `running`; pausa/cancelamento no meio param já; WhatsApp fora adia 5 min sem gastar tentativa; teto por rodada da política.
- Aceito/entregue/incerto **nunca** é reenviado automaticamente; incerto só após conciliação.
- Só recupera o que é **do dia de hoje** (sem reabrir histórico, sem aniversário velho).

## 6. Arquivos

Novos: `src/uazapi/phone.ts`, `src/uazapi/phoneRegistry.ts`, `src/dispatch/{policy,delivery,model,actions}.ts`, `src/api/dispatches.ts`, `public/disparos.js`, `prisma/migrations/20261025100000_disparos/`, `scripts/disparos-lisboa.mjs`, `tests/disparos-envio.test.mjs`, `tests/disparos-aba.test.mjs`.
Alterados: `src/reminders/{cron,birthday,coverage,ledger}.ts`, `src/uazapi/client.ts` (relatório do envio, erro funcional 200, fallback, `messages_update`), `src/clinicaexperts/{identity,birthdays}.ts`, `src/ai/presenceConfirmation.ts`, `src/api/routes.ts`, `src/server.ts`, `src/crm/plan.ts`, `prisma/schema.prisma`, `public/{index.html,app.js,styles.css}`, e dois testes antigos ajustados (`lisboa-fluxos`, `confirmacoes-sabado-prazo`).

## 7. Deploy e reversão

1. Deploy normal; a migração é **aditiva** (colunas anuláveis/com padrão e 4 tabelas novas): roda sozinha no start.
2. **Reconfigurar o webhook** de cada clínica (Canais → reaplicar webhook) para incluir `messages_update`; sem isso a aba funciona, mas o estado "entregue/lido" não chega (fica "aceito").
3. Conferir uptime no `/health` (o push não reinicia o servidor).
4. Reversão: voltar ao commit anterior; as colunas/tabelas novas são ignoradas pelo código antigo. Para só desligar a ampliação: `extendEnabled=false` por tipo na tela. Nada exige apagar dados.

## 8. Limitações e o que depende de produção/provedor

- Causas reais dos incidentes da Lisboa: não comprovadas aqui; rodar `node scripts/disparos-lisboa.mjs` na produção (somente leitura).
- Formato exato do payload `messages_update` da UAZAPI não está documentado em detalhe: a leitura é tolerante; validar com um evento real. Sem id do provedor não há conciliação de entrega.
- Não prometemos entrega: "aceito pelo WhatsApp" é o máximo que o provedor garante sem o evento de entrega.
- Aniversariantes que existem só no Clínica Experts e não foram importados **não aparecem** (cobertura "não calculável"); o sync em modo prévia agora devolve uma amostra mascarada (`notInAliceSample`). A **importação** desses cadastros não foi implementada nesta rodada.
- Falha de banco depois da aceitação pelo provedor: o aniversário/lembrete já aceito não é reenviado (registro do chat falha só loga); não há teste dedicado de injeção de falha de banco.
- Backlog: tela de "importar aniversariantes do CE", ação em lote de cancelar/encaminhar, exportação com mais colunas.
