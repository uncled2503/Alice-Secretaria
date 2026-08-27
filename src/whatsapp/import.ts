import type { Chat, Contact, WAMessage } from "@whiskeysockets/baileys";
import { prisma } from "../db/client.js";

// So traz conversa de 1:1 (nao grupo) e so o que aconteceu nos ultimos N dias -
// historico mais antigo e ignorado de proposito (ver "partialHistory" nas stats).
const HISTORY_DAYS = 30;

interface ImportStats {
  found: number;
  created: number;
  merged: number;
  ignored: number;
  conversations: number;
  partialHistory: number;
}

function emptyStats(): ImportStats {
  return { found: 0, created: 0, merged: 0, ignored: 0, conversations: 0, partialHistory: 0 };
}

// So aceita numero que pareca telefone de verdade (10-13 digitos cobre o
// formato de praticamente todo pais com o DDI). O WhatsApp moderno usa "lid"
// (id vinculado, so privacidade) como identificador de varios contatos -
// esses ids sao numericos parecidos com telefone mas NAO SAO telefones, e
// aparecem bem mais longos (14-15 digitos) - rejeitados aqui de proposito.
function isValidPhone(digits: string): boolean {
  if (!/^\d{10,13}$/.test(digits)) return false;
  if (/^0+$/.test(digits)) return false;
  return true;
}

// Resolve o telefone de verdade por tras de um jid. "@s.whatsapp.net" ja e o
// numero; "@lid" e um id vinculado (privacidade) que so vira telefone de
// verdade via o mapa lidPnMappings mandado junto no historico - sem mapa,
// nao da pra confiar no numero e o contato/mensagem e ignorado.
function resolvePhone(jid: string | undefined | null, lidToPn: Map<string, string>): string | null {
  if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast") return null;

  let raw: string | null = null;
  if (jid.endsWith("@lid")) {
    raw = lidToPn.get(jid) ?? null;
  } else if (jid.endsWith("@s.whatsapp.net")) {
    raw = jid;
  }
  if (!raw) return null;

  const digits = raw.split("@")[0].replace(/\D/g, "");
  return isValidPhone(digits) ? digits : null;
}

async function readStats(clinicId: string): Promise<ImportStats> {
  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { importStats: true } });
  if (!clinic?.importStats) return emptyStats();
  try {
    return { ...emptyStats(), ...JSON.parse(clinic.importStats) };
  } catch {
    return emptyStats();
  }
}

async function saveStats(clinicId: string, stats: ImportStats, done: boolean): Promise<void> {
  const contactsInBase = await prisma.patient.count({ where: { clinicId } });
  await prisma.clinic.update({
    where: { id: clinicId },
    data: {
      importStatus: done ? "completed" : "running",
      importStats: JSON.stringify({ ...stats, contactsInBase }),
      importUpdatedAt: new Date(),
    },
  });
}

// Disparado pelo evento "messaging-history.set" do Baileys - chega em varios
// pedacos (chunks); "isLatest" marca o ultimo. So roda quando alguem clica em
// "Importar do WhatsApp" (ver triggerHistoryImport em manager.ts), que pede
// syncFullHistory:true nessa reconexao especifica.
//
// So importa quem tem numero de telefone valido E pelo menos uma mensagem
// real dentro da janela de 30 dias - a lista de contatos sozinha (agenda do
// celular) NAO cria paciente, so serve pra completar o nome de quem ja
// qualificou por ter conversa.
export async function processHistorySync(
  clinicId: string,
  data: {
    chats: Chat[];
    contacts: Contact[];
    messages: WAMessage[];
    lidPnMappings?: { pn: string; lid: string }[];
    isLatest?: boolean | null;
  }
): Promise<void> {
  const stats = await readStats(clinicId);

  const lidToPn = new Map<string, string>();
  for (const mapping of data.lidPnMappings ?? []) {
    lidToPn.set(mapping.lid, mapping.pn);
  }

  const contactNameByPhone = new Map<string, string>();
  for (const contact of data.contacts) {
    const id = contact.phoneNumber || contact.id;
    const phone = resolvePhone(id, lidToPn);
    const name = contact.name || contact.notify;
    if (phone && name) contactNameByPhone.set(phone, name);
  }

  const cutoffMs = Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000;
  const touchedConversations = new Set<string>();
  const seenPhones = new Set<string>();
  const patientIdByPhone = new Map<string, string>(); // cache local desse lote - evita recontar created/merged por mensagem

  for (const msg of data.messages) {
    if (!msg.message || !msg.key.remoteJid) continue;

    const phone = resolvePhone(msg.key.remoteJid, lidToPn);
    if (!phone) {
      stats.ignored++;
      continue;
    }
    seenPhones.add(phone);

    const tsMs = Number(msg.messageTimestamp) * 1000;
    if (!tsMs || tsMs < cutoffMs) {
      stats.partialHistory++;
      continue;
    }

    const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
    if (!text) continue; // midia sem transcricao - fora do escopo do import, igual no atendimento ao vivo

    let patientId = patientIdByPhone.get(phone);
    if (!patientId) {
      const existingPatient = await prisma.patient.findUnique({ where: { clinicId_phone: { clinicId, phone } } });
      if (!existingPatient) {
        const created = await prisma.patient.create({ data: { clinicId, phone, name: contactNameByPhone.get(phone) ?? null } });
        patientId = created.id;
        stats.created++;
      } else {
        patientId = existingPatient.id;
        if (!existingPatient.name && contactNameByPhone.has(phone)) {
          await prisma.patient.update({ where: { id: patientId }, data: { name: contactNameByPhone.get(phone) } });
        }
        stats.merged++;
      }
      patientIdByPhone.set(phone, patientId);
    }

    let conversation = await prisma.conversation.findFirst({ where: { patientId } });
    if (!conversation) {
      // Entra fechada e ja em humanTakeover: e historico, a Alice nunca deve
      // retomar/responder essas conversas importadas sozinha.
      conversation = await prisma.conversation.create({
        data: { patientId, status: "closed", humanTakeover: true },
      });
    }
    touchedConversations.add(conversation.id);

    const createdAt = new Date(tsMs);
    const already = await prisma.message.findFirst({ where: { conversationId: conversation.id, createdAt, content: text } });
    if (already) continue;

    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: msg.key.fromMe ? "human" : "user",
        content: text,
        createdAt,
      },
    });
  }

  stats.found += seenPhones.size;
  stats.conversations += touchedConversations.size;

  await saveStats(clinicId, stats, !!data.isLatest);
}
