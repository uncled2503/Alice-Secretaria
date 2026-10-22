import { prisma } from "../db/client.js";
import { parsePhone, maskDigits } from "./phone.js";

// ---------------------------------------------------------------------------
// RESOLUCAO DE TELEFONE PERSISTIDA (PhoneResolution): quando o provedor REJEITA explicitamente a forma cadastrada e ACEITA a outra (com/sem o 9), isso fica gravado por clinica+telefone
// original, junto da origem e da data. Os proximos envios usam o destino validado; a sincronizacao do cadastro (CE, painel) nao desfaz a resolucao (ela e outra tabela). Corrigir o telefone
// no cadastro muda a chave e, portanto, reavalia sem apagar historico. Existir no WhatsApp NAO prova identidade: esta tabela guarda so a FORMA que funcionou.
// ---------------------------------------------------------------------------

const digitsOf = (raw: string) => raw.replace(/\D/g, "");

export async function resolvedDestinationFor(clinicId: string, original: string): Promise<string | null> {
  const key = digitsOf(original);
  if (!key) return null;
  try {
    const row = await prisma.phoneResolution.findUnique({ where: { clinicId_originalDigits: { clinicId, originalDigits: key } }, select: { destination: true } });
    return row?.destination ?? null;
  } catch {
    return null; // a consulta e auxiliar: sem ela vale a leitura central
  }
}

export async function saveResolution(clinicId: string, original: string, destination: string, source: "fallback_rejeicao_explicita" | "painel" | "manual", reason: string, patientId?: string | null): Promise<void> {
  const key = digitsOf(original);
  if (!key || !parsePhone(destination).valid) return;
  try {
    await prisma.phoneResolution.upsert({
      where: { clinicId_originalDigits: { clinicId, originalDigits: key } },
      create: { clinicId, originalDigits: key, destination, source, reason, patientId: patientId ?? null },
      update: { destination, source, reason, validatedAt: new Date(), ...(patientId ? { patientId } : {}) },
    });
  } catch (err) {
    console.error(`[telefone] nao consegui gravar a resolucao de ${maskDigits(original)}:`, err instanceof Error ? err.message : err);
  }
}

export async function clearResolution(clinicId: string, original: string): Promise<number> {
  const key = digitsOf(original);
  return (await prisma.phoneResolution.deleteMany({ where: { clinicId, originalDigits: key } })).count;
}
