# Agenda, disponibilidade e confirmações (16/10/2026)

Pedido da Lisboa Beauty Center: horários fora da jornada, disponibilidade sem conferir procedimento/profissional, confirmações duplicadas, confirmação com horário errado, reservas sem procedimento sem confirmação e cancelados/remarcados ainda recebendo o horário antigo.

## De onde vem cada horário (precedência)

1. **Jornada da profissional** (`Professional.workStartHour/Minute`, `workEndHour/Minute`, `workDays`, `lunch*`): o que estiver preenchido manda.
2. **Configuração da clínica** (`Clinic.work*`, `lunch*`, `workDays`): vale para o que a profissional deixou em branco. (`hoursByDay` só vale para automações, nunca para ofertar horário.)
3. **Clínica Experts**: *intersecciona*, nunca amplia. O `/available-hours` só pode tirar horários (ocupado/fora da escala dele); um horário livre no CE mas fora da jornada cadastrada é recusado.
4. **Importação do CE** (`syncCatalog`, `pullClinicBookings`): só cria/vincula profissional e reserva; **não escreve jornada**. Nada restaura valor antigo depois.
5. **Seeds**: só preenchem na criação (Diamond, Dr. Saulo, Harmonizze, Teste). O seed da Lisboa não define jornada.
6. **Regras do prompt**: nenhuma regra da Lisboa cita horário de profissional; mesmo que citasse, o horário ofertado é montado pelo código e conferido contra o que as ferramentas devolveram (`slotGuard`).

## Elegibilidade (um critério só) — `src/scheduling/eligibility.ts`

Usada por `check_availability`, `check_specific_time`, `book_appointment` e remarcação. **O texto não é a única barreira: a execução recusa** (`createBooking` / `rescheduleBooking`), mesmo que o modelo chame a ferramenta direto.

- Atende quem é **ativa e vinculada ao procedimento**. Numa clínica com agenda no CE (conta conectada + `syncOut`), procedimento sem profissional vinculada **não tem oferta** (ausência de vínculo ≠ qualquer profissional) e profissional sem vínculo com o CE não é ofertada.
- Clínica sem CE e sem profissionais cadastradas segue com a agenda única da clínica (comportamento antigo). Clínica sem CE com profissionais mas procedimento sem vínculo também segue como antes.
- Cadastro conflitante (início ≥ fim, intervalo invertido, sem dias) bloqueia **só aquela profissional**; motivo no log e no diário (`agenda_conflict`, 1×/dia).
- Duração **inteira** dentro da jornada (60 min às 20h30 não cabe para quem encerra às 21h), fora de almoço, bloqueios e dias não trabalhados.
- Remarcação (`rescheduleBooking`): mesmo procedimento, mesma profissional (precisa continuar habilitada), duração preservada, revalidação dentro da transação, sem segunda reserva; se o CE recusar, a Alice volta ao horário anterior e não afirma sucesso.
- Agendamento **manual** pelo painel (`enforceHours:false`) continua decisão da clínica (não passa por esta elegibilidade).

### Portão do Clínica Experts
Dia que o CE não respondeu **não oferece** e **não reserva** (motivo `ce_unavailable`); antes ofertava sem conferir. Falha vale 10 s (não "gruda"). Escape de emergência: variável de ambiente `CE_GATE_FAIL_OPEN=on` (volta ao comportamento antigo).

## Lembretes / confirmações — `src/reminders/cron.ts`, `ledger.ts`, `clinicaexperts/liveCheck.ts`

Por reserva, nesta ordem: estado fresco → janela de envio ainda vale → controle persistente → conferência no CE → estado fresco de novo → reserva atômica → envio → resultado gravado como aconteceu.

| Conferência no CE | Ação |
|---|---|
| ok (status ativo + horário confere) | segue |
| cancelada / apagada (404) | não envia; cancela aqui |
| atendida / falta | não envia; marca `completed` / `no_show` (não vira "cancelada") |
| horário trocado (com fuso, futuro) | corrige aqui, não envia o antigo, libera a reserva atual |
| timeout, rede, 401/403, 429/5xx, resposta sem status/horário, outra reserva, horário divergente sem fuso | **ADIA**: não envia, não cancela, não altera, não consome |

Adiar: nova tentativa a cada rodada (intervalo mínimo de 10 min), **só enquanto a janela de envio valer** (lembrete vencido nunca é disparado para compensar), até 16 tentativas; depois desiste e avisa a equipe. Um aviso agregado por clínica (no máx. 1 a cada 3 h). Depois de 3 falhas de sistema seguidas na rodada o CE é dado como fora do ar e as demais reservas são adiadas sem martelá-lo. Uma reserva problemática não trava as outras nem outras clínicas.

### Controle persistente (`ReminderDispatch`, migration `20261016160000_controle_de_lembretes`, tabela nova)
Chave: **reserva** (`ce:<uuid>` ou `appt:<id>`) + **regra** + **horário do agendamento**; segundo índice único: reserva + **tipo** (`dia_seguinte`, `do_dia`, `cobranca`) + horário + dia do envio. Adquirido de forma atômica antes do envio; sobrevive a reinício e a cópias locais da mesma reserva. A remarcação **não apaga** o histórico do horário antigo (o horário novo ganha linha própria). Estados: `deferred`, `reserved`, `sent`, `unconfirmed` (timeout: pode ter saído, **nunca reenvia**), `blocked`, `vetoed`, `duplicate`, `failed` (nada saiu: libera, até 3 tentativas com intervalo de 5 min), `failed_permanent`, `exhausted`.

Limites honestos: a UAZAPI não oferece idempotência nem consulta de status, então "entrega única" não é garantia absoluta — o envio ambíguo fica explícito (`unconfirmed`) e não é repetido. O CE é externo: nos segundos entre a conferência e a entrega no WhatsApp (revisão por IA incluída) a reserva ainda pode mudar lá.

A **segunda cobrança** (regra-filha, 16h, "ainda não recebemos sua confirmação") continua existindo por pedido da clínica de 08/10; é um tipo próprio (`cobranca`). Se a queixa de "duas confirmações no mesmo dia" incluir essa cobrança, basta desativar a regra-filha.

## Rastreabilidade (responder "o que a Alice recebeu e por que decidiu")
- Logs `[lembrete] decisao=enviar|pular|adiar|desistir …` com clínica, agendamento, reserva CE, regra, horário (ISO), fuso, tipo, tentativa, resultado do CE e do envio, e a revisão do código.
- Logs `[agenda] horario-livre|horario-recusado|reserva-validada|reserva-recusada|remarcacao-… ` com procedimento, profissional, duração, jornada usada e resposta do CE por profissional.
- `GET /api/clinic/reminder-trail?appointmentId=…` devolve a trilha persistida (`ReminderDispatch`) da reserva.
- Diário de atividades: `agenda_conflict`, `reminder_deferred`, `professional_hours_updated`, `appointment_completed/no_show` vindos do CE.

## Jornadas da Lisboa (Suelen 12–21h, Adriana 12–21h, Talita 8–17h)
Painel → Configurações → Lisboa → **Ajustar jornadas** (ou `POST /api/clinics/lisboa-jornadas`, admin). Sempre mostra a **prévia** primeiro (`dryRun`, padrão). Só altera início/fim quando existe **exatamente uma** profissional **ativa** com aquele primeiro nome na clínica; duplicatas, nomes só inativos ou sem cadastro viram **pendência** com ids para resolver (`escolhas: {"suelen": "<id>"}`). Dias, almoço, bloqueios e agendamentos não são alterados; conflitos (almoço colado no início/fim da nova jornada, agendamentos futuros fora do novo horário) são **sinalizados**. Idempotente.

## Depois do deploy (EasyPanel é manual — clicar "Implantar" e conferir `/health`)
1. `/health` → `revision` deve começar com `2026-10-16-f` e `lastMigration` = `20261016160000_controle_de_lembretes`.
2. Painel → Lisboa → **Ajustar jornadas**: ler a prévia, resolver pendências, confirmar.
3. "Diagnosticar horário" (já existente) em 2 casos: 20h30 com Suelen (deve recusar) e 8h30 com Talita (deve aceitar).
4. Esperar a próxima janela de confirmação e conferir no Diário/`reminder-trail` que cada reserva tem 1 linha `sent`.
