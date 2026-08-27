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

function phoneFromJid(jid: string | undefined | null): string | null {
  if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast") return null;
  return jid.split("@")[0].replace(/\D/g, "") || null;
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
export async function processHistorySync(
  clinicId: string,
  data: { chats: Chat[]; contacts: Contact[]; messages: WAMessage[]; isLatest?: boolean | null }
): Promise<void> {
  const stats = await readStats(clinicId);

  for (const contact of data.contacts) {
    const phone = phoneFromJid(contact.id);
    stats.found++;
    if (!phone) {
      stats.ignored++;
      continue;
    }

    const existingPatient = await prisma.patient.findUnique({ where: { clinicId_phone: { clinicId, phone } } });
    const contactName = contact.name || contact.notify || null;
    if (existingPatient) {
      stats.merged++;
      if (!existingPatient.name && contactName) {
        await prisma.patient.update({ where: { id: existingPatient.id }, data: { name: contactName } });
      }
    } else {
      await prisma.patient.create({ data: { clinicId, phone, name: contactName } });
      stats.created++;
    }
  }

  const cutoffMs = Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000;
  const touchedConversations = new Set<string>();

  for (const msg of data.messages) {
    if (!msg.message || !msg.key.remoteJid) continue;
    const phone = phoneFromJid(msg.key.remoteJid);
    if (!phone) continue;

    const tsMs = Number(msg.messageTimestamp) * 1000;
    if (!tsMs || tsMs < cutoffMs) {
      stats.partialHistory++;
      continue;
    }

    const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
    if (!text) continue; // midia sem transcricao - fora do escopo do import, igual no atendimento ao vivo

    const patient = await prisma.patient.upsert({
      where: { clinicId_phone: { clinicId, phone } },
      update: {},
      create: { clinicId, phone },
    });

    let conversation = await prisma.conversation.findFirst({ where: { patientId: patient.id } });
    if (!conversation) {
      // Entra fechada e ja em humanTakeover: e historico, a Alice nunca deve
      // retomar/responder essas conversas importadas sozinha.
      conversation = await prisma.conversation.create({
        data: { patientId: patient.id, status: "closed", humanTakeover: true },
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
  stats.conversations += touchedConversations.size;

  await saveStats(clinicId, stats, !!data.isLatest);
}
