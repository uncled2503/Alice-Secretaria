import { prisma } from "../db/client.js";
import { formatDateTimeInZone } from "../scheduling/time.js";
import { displayProcedureName } from "../clinicaexperts/placeholderProcedure.js";

// ---------------------------------------------------------------------------
// ETIQUETA INTERNA DO LEAD (pedido do dono, 15/10/2026): "Agendado" (com a data) ou "Nao agendado", que SO A ALICE ENXERGA (nao aparece no painel
// nem no WhatsApp). Em vez de uma coluna gravada (que ficaria velha quando a equipe marca pelo painel, pelo Clinica Experts ou por telefone),
// ela e CALCULADA na hora a partir dos agendamentos: qualquer procedimento, marcado pela Alice, pela equipe, pela API ou importado do CE. Quem
// esta Agendado nao recebe nova tentativa de agendamento (ver a regra no prompt e a trava em ai/alice.ts).
// ---------------------------------------------------------------------------

export interface BookingTag {
  status: "agendado" | "nao_agendado";
  items: { when: Date; label: string; procedure: string; professional: string | null }[]; // proximos horarios, do mais cedo
  text: string; // "Agendado: 20/10/2026 09:30 - Lavieen com Sabrina" | "Nao agendado"
}

// PURO: monta o texto da etiqueta.
export function renderBookingTag(items: BookingTag["items"]): string {
  if (!items.length) return "Nao agendado";
  const first = items[0];
  const more = items.length > 1 ? ` (+${items.length - 1} horario(s): ${items.slice(1, 4).map((i) => `${i.label} ${i.procedure}`).join("; ")})` : "";
  return `Agendado: ${first.label} - ${first.procedure}${first.professional ? ` com ${first.professional}` : ""}${more}`;
}

export async function getBookingTag(patientId: string, tz: string): Promise<BookingTag> {
  const appts = await prisma.appointment.findMany({
    where: { patientId, status: "confirmed", scheduledAt: { gte: new Date(Date.now() - 30 * 60_000) } },
    orderBy: { scheduledAt: "asc" },
    take: 10,
    select: { scheduledAt: true, procedure: { select: { name: true } }, professional: { select: { name: true } } },
  });
  const items = appts.map((a) => ({ when: a.scheduledAt, label: formatDateTimeInZone(a.scheduledAt, tz), procedure: displayProcedureName(a.procedure.name), professional: a.professional?.name ?? null }));
  return { status: items.length ? "agendado" : "nao_agendado", items, text: renderBookingTag(items) };
}

// O que a Alice le (so ela): a etiqueta e a regra que decorre dela.
export function bookingTagPrompt(tag: BookingTag, staffSaidBooked: boolean): string {
  if (tag.status !== "agendado" && staffSaidBooked) {
    // fala da equipe NAO e retorno de ferramenta: sem reserva na agenda nada pode ser afirmado como agendado/confirmado
    return "ETIQUETA INTERNA DESTE LEAD (so voce ve; nunca mencione a etiqueta): a EQUIPE escreveu no chat que combinou/marcou um horario, mas NAO EXISTE reserva dela na agenda. REGRA: NAO afirme que esta agendado/confirmado e NAO diga 'te esperamos'. Se ela aceitar ('pode ser', 'fechado') uma proposta de horario da equipe, efetive pela agenda (check_specific_time e book_appointment, com o procedimento e o horario que a equipe propos) ou chame transfer_to_human para a equipe lancar; so diga 'agendado' DEPOIS de agendado:true. NAO ofereca horarios novos, avaliacao nem outro procedimento por conta propria (a equipe ja estava combinando): so efetive o que a equipe propos quando ela aceitar, e nao reinicie a venda.";
  }
  if (tag.status === "agendado") {
    const detail = tag.text;
    return `ETIQUETA INTERNA DESTE LEAD (so voce ve; nunca mencione a etiqueta): ${detail}. REGRA: este lead JA ESTA AGENDADO. NAO tente agendar de novo: nao ofereca horarios, nao ofereca avaliacao nem outro procedimento, nao pergunte dia e turno. So responda o que ele perguntar (endereco, preparo, reagendar ou cancelar quando ele pedir). Se ele pedir EXPLICITAMENTE outro procedimento, mais um horario ou remarcar, ai sim atenda o pedido. Se citar um horario diferente de "${tag.status === "agendado" ? tag.items[0].label : "o combinado"}", nao confirme: confira na agenda real acima.`;
  }
  return "ETIQUETA INTERNA DESTE LEAD (so voce ve; nunca mencione a etiqueta): Nao agendado. Siga o fluxo normal: identifique o procedimento que ele quer e agende; avaliacao so se ele nao souber.";
}
