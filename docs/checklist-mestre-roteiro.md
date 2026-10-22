# Roteiro de validação operacional — Checklist Mestre (lotes 1 e 2)

Complementa `docs/checklist-22-10-roteiro.md` (27 testes de confirmação, sábado, recontato, aniversário, pós, não-pacientes, campanha para humano, pesquisa, duas pessoas, isolamento). **Nada aqui foi executado.** Teste automático (`npm test`) é simulação e **não conta** como validação. **Não simular passagem de dias**: critérios de dias consecutivos só valem com dias reais.

**Contatos de teste:** use 3 números da equipe cadastrados como pacientes ("Teste A/B/C"), com telefone completo (DDI+DDD+9), um deles com **opt-out total**, outro com **"sem promoções"**, outro classificado como **não-paciente**. Nunca usar pacientes reais para provocar falhas. Para falha controlada, desconecte o WhatsApp de uma clínica **de teste** (nunca a Lisboa em horário de atendimento).

## Critérios de baixa (iguais ao PDF)
Confirmações: **2 dias consecutivos** (hoje + dia seguinte) com relatório elegíveis × enviados × retidos × falhos e motivo por paciente. Aniversários: **3 dias consecutivos** com encontrados × elegíveis × enviados × falhas. Cada outro item: uma execução real documentada (print/log).

## Lote 1 — confiabilidade
| # | Teste real | Como | Evidência | Status |
| --- | --- | --- | --- | --- |
| L1 | Central: detalhe e ação em item "longe" | dia com >200 itens (ou histórico longo) → abrir o 250º item | detalhe e "Avisar a equipe" funcionam | PEND |
| L2 | Texto exato | enviar 1 lembrete real de teste; mudar o texto da regra; abrir o detalhe | o detalhe mostra o texto **enviado**, não o novo | PEND |
| L3 | Conciliação | provocar resultado incerto (timeout controlado) → conciliar "chegou" | estado "Confirmado pela equipe (sem evidência do provedor)" ≠ "Aceito" | PEND |
| L4 | Aviso à equipe | desligar o evento de transferência → "Avisar a equipe" | mensagem "A equipe NÃO foi avisada: …" | PEND |
| L5 | Renovação vetada | contato de teste com Botox concluído há 4 meses; forçar veto da revisão | linha "Barrado", **não consumida**; nova tentativa no ciclo seguinte | PEND |
| L6 | Renovação — fim de mês | atendimento concluído em 31/10 + regra de 4 meses | vence em 28/02 (29/02 em bissexto) | PEND |
| L7 | Retorno combinado — falha | combinar retorno; derrubar o WhatsApp da clínica de teste | a promessa **continua no cadastro**; volta e envia uma vez | PEND |
| L8 | Retorno combinado — equipe | conversa em atendimento humano + retorno vencido | "Encaminhado à equipe" (não "enviado"), só com aviso aceito | PEND |
| L9 | Campanha — sem `sentAt` | campanha de teste com 1 vetado e 1 enviado | vetado sem horário de envio; enviado com id do provedor | PEND |
| L10 | Campanha para humano | campanha "atendimento humano após resposta"; responder | conversa na equipe, Alice silencia, retorno por inatividade não devolve | PEND |
| L11 | Pós sem conclusão | atendimento **não** marcado como concluído | não sai; resumo da rodada mostra `sem_evidencia_de_realizacao`; marcando concluído, sai | PEND |
| L12 | `/health` | após o deploy | `migrationsFailed: []`, `lastMigration 20261028…` | PEND |

## Lote 2 — Central e Fases 2/3
| # | Teste real | Como | Evidência | Status |
| --- | --- | --- | --- | --- |
| C1 | Tipos na Central | abrir um dia com renovação, retorno, campanha, pós, pré e recontato | cada tipo com estado, texto e (quando houver) id do provedor | PEND |
| C2 | Entregue/lido | mensagem de teste lida no aparelho | status "Lido" só após o evento do provedor | PEND |
| C3 | Programado × não tentado | ver "Próximos" com a janela ainda fechada | "Programado" | PEND |
| P1 | Sem promoções | marcar Teste B; enviar campanha e lembrete | campanha **não** chega; lembrete chega | PEND |
| P2 | Opt-out total | Teste A | nada automático chega | PEND |
| P3 | Autorização de imagem | registrar com procedência | campos visíveis; (integração com envio de fotos: pendente) | PEND |
| M1 | Motivos | registrar perda e cancelamento com motivo; relatório semanal | "não informado" visível no denominador | PEND |
| W1 | Lista de espera | entrada "quinta, manhã, 24h de antecedência"; liberar vaga de terça à tarde e depois quinta de manhã | só a de quinta de manhã recebe; **nenhuma reserva** criada | PEND |
| K1 | Pacote | registrar pacote de 4; usar 2; esperar/forjar 10 dias sem uso | avisos "restam 2" e "parado" **para a equipe**, nada ao paciente | PEND |
| K2 | Comprovante | enviar imagem de comprovante | **não** vira "pago": fica "pendente de conferência" até a equipe conferir | PEND |
| R1 | Relatório semanal/mensal | gerar e conferir 3 números à mão | taxas batem com os denominadores declarados | PEND |
| G1 | Prévia Lisboa | `GET /clinics/lisboa-regras-diff` | lista de divergências; **nada alterado** | PEND |
| E1 | Comparar 10+ reservas CE × Alice | data, hora, procedimento, profissional, status | tabela com divergências | PEND |
