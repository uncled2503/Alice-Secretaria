import { scheduleLocked } from "../jobs/lock.js";
import { prisma } from "../db/client.js";
import { saveContactToPhone } from "../uazapi/client.js";
import { PAID_CLINIC_WHERE } from "./plan.js";

// Salva na AGENDA DE CONTATOS do celular da clinica (WhatsApp conectado) cada paciente que ja tem
// nome, pra o nome aparecer no WhatsApp em vez do numero. Opcao por clinica (saveContactsToPhone).
// Roda aos poucos (lote pequeno com pausa) e guarda o nome salvo em Patient.phoneContactName:
// so salva de novo se o nome mudar.
const BATCH = 15;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Nome utilizavel como contato: tem letras (nao e so numero, emoji ou pontuacao).
export function usableContactName(name: string | null | undefined): string | null {
  const n = (name ?? "").replace(/\s+/g, " ").trim();
  if (n.length < 2 || !/[a-zA-ZÀ-ÿ]/.test(n)) return null;
  return n.slice(0, 80);
}

let running = false;

export async function runSavePhoneContacts(): Promise<number> {
  if (running) return 0;
  running = true;
  let saved = 0;
  try {
    const clinics = await prisma.clinic.findMany({
      where: { saveContactsToPhone: true, aliceActive: true, ...PAID_CLINIC_WHERE },
      select: { id: true },
    });
    for (const clinic of clinics) {
      const candidates = await prisma.patient.findMany({
        where: { clinicId: clinic.id, name: { not: null } },
        select: { id: true, name: true, phone: true, phoneContactName: true },
        orderBy: { createdAt: "desc" },
        take: BATCH * 8,
      });
      const todo = candidates
        .map((p) => ({ ...p, contactName: usableContactName(p.name) }))
        .filter((p) => p.contactName && p.phoneContactName !== p.contactName)
        .slice(0, BATCH);
      for (const p of todo) {
        const result = await saveContactToPhone(clinic.id, p.phone, p.contactName!);
        if (result === "retry") break; // sem conexao/erro do servidor: tenta de novo no proximo ciclo
        // "ok" ou "invalid" (numero invalido, conta comercial...): marca pra nao insistir
        await prisma.patient.update({ where: { id: p.id }, data: { phoneContactName: p.contactName } });
        if (result === "ok") saved++;
        await sleep(1500 + Math.random() * 2500);
      }
    }
  } finally {
    running = false;
  }
  return saved;
}

export function startPhoneContactsJob(): void {
  scheduleLocked("salvar-contatos", "*/10 * * * *", () => {
    runSavePhoneContacts().catch((err) => console.error("Erro ao salvar contatos no celular:", err));
  });
}
