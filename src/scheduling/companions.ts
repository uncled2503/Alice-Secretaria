import { prisma } from "../db/client.js";
import { canonicalBrPhone, phoneQueryForms, samePhone } from "../clinicaexperts/identity.js";
import { foldName, namesCompatible } from "../clinicaexperts/match.js";

// ---------------------------------------------------------------------------
// AGENDAR PARA OUTRA PESSOA NA MESMA CONVERSA ("quero marcar para mim e meu marido"). Cada pessoa e UM atendimento e UM cadastro de verdade:
//  - a pessoa que conversa continua sendo o contato (Patient); quem sera atendido e ou um ACOMPANHANTE que divide o telefone (Attendee, registrado de forma EXPLICITA:
//    a pessoa precisa dizer que o telefone e dos dois) ou um Patient PROPRIO (telefone proprio informado);
//  - o nome do acompanhante nunca sobrescreve o cadastro de quem conversa;
//  - nada e fundido automaticamente com outro cadastro: telefone ja cadastrado em nome de outra pessoa pede confirmacao.
// ---------------------------------------------------------------------------

export interface CompanionInput {
  fullName: unknown; // nome completo da pessoa atendida
  relation?: unknown; // "marido", "filha"... so informacao
  phone?: unknown; // telefone PROPRIO da pessoa (se tiver)
  sharesPhone?: unknown; // true = a pessoa disse que o telefone desta conversa e o contato dos dois
}

export type CompanionTarget =
  | { ok: true; patientId: string; attendeeId: string | null; bookedByPatientId: string | null; displayName: string; shared: boolean }
  | { ok: false; motivo: string; instrucao: string };

const cleanName = (v: unknown): string => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
const looksFullName = (n: string): boolean => {
  const parts = n.split(" ").filter(Boolean);
  return parts.length >= 2 && parts.every((w) => /^[\p{L}'.-]{2,}$/u.test(w));
};

export async function resolveCompanionTarget(clinicId: string, contactPatientId: string, input: CompanionInput): Promise<CompanionTarget> {
  const name = cleanName(input.fullName);
  if (!looksFullName(name)) {
    return { ok: false, motivo: "preciso do NOME COMPLETO (nome e sobrenome) da outra pessoa", instrucao: "Pergunte o nome completo da outra pessoa e chame book_appointment de novo com attendee_full_name." };
  }
  const contact = await prisma.patient.findFirst({ where: { id: contactPatientId, clinicId }, select: { id: true, name: true, phone: true } });
  if (!contact) return { ok: false, motivo: "cadastro da conversa nao encontrado", instrucao: "Chame transfer_to_human." };
  // e a PROPRIA pessoa da conversa? (mesmo nome completo): agenda normalmente, sem acompanhante
  if (contact.name && foldName(contact.name) === foldName(name)) {
    return { ok: false, motivo: "esse nome e o da propria pessoa desta conversa", instrucao: "Agende SEM attendee_full_name (e o cadastro dela)." };
  }
  const relation = cleanName(input.relation).slice(0, 40) || null;
  const rawPhone = String(input.phone ?? "").trim();

  if (rawPhone) {
    const canon = canonicalBrPhone(rawPhone);
    if (!canon) return { ok: false, motivo: "o telefone informado nao parece valido (DDD + numero)", instrucao: "Peca o telefone com DDD e chame de novo." };
    if (!samePhone(rawPhone, contact.phone)) {
      // telefone PROPRIO: cadastro proprio (as mensagens da pessoa vao para o telefone dela)
      const phone = `55${canon.ddd}${canon.local}`;
      const forms = [...new Set([phone, ...phoneQueryForms(phone)])];
      const existing = await prisma.patient.findFirst({ where: { clinicId, phone: { in: forms } } });
      if (existing) {
        if (existing.name && !namesCompatible(existing.name, name)) {
          return { ok: false, motivo: `o telefone ${rawPhone} ja esta cadastrado em nome de outra pessoa ("${existing.name}")`, instrucao: "NAO agende. Confirme com a pessoa o nome e o telefone corretos (ou chame transfer_to_human se o telefone dividido for de outra pessoa)." };
        }
        return { ok: true, patientId: existing.id, attendeeId: null, bookedByPatientId: contact.id, displayName: existing.name ?? name, shared: false };
      }
      const created = await prisma.patient.create({ data: { clinicId, phone, name } });
      return { ok: true, patientId: created.id, attendeeId: null, bookedByPatientId: contact.id, displayName: created.name ?? name, shared: false };
    }
    // o "telefone proprio" informado e o mesmo desta conversa: e telefone compartilhado, dito explicitamente pela pessoa
  } else if (input.sharesPhone !== true) {
    return {
      ok: false,
      motivo: "falta saber como falar com a outra pessoa",
      instrucao: "Pergunte: 'o contato dele(a) e este mesmo WhatsApp, ou ele(a) tem outro numero?'. Se for o mesmo, chame de novo com attendee_shares_phone=true; se tiver outro, informe em attendee_phone.",
    };
  }

  // telefone compartilhado: acompanhante do contato (registrado explicitamente)
  const folded = foldName(name);
  const siblings = await prisma.attendee.findMany({ where: { clinicId, contactPatientId: contact.id } });
  const found = siblings.find((a) => foldName(a.name) === folded);
  const attendee = found ?? (await prisma.attendee.create({ data: { clinicId, contactPatientId: contact.id, name, relation } }));
  return { ok: true, patientId: contact.id, attendeeId: attendee.id, bookedByPatientId: contact.id, displayName: attendee.name, shared: true };
}
