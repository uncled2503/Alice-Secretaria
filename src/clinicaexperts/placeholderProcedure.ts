import { prisma } from "../db/client.js";
import type { Procedure } from "@prisma/client";

// ---------------------------------------------------------------------------
// RESERVA SEM PROCEDIMENTO (pedido da Lisboa, repetido varias vezes - ultima em 16/10/2026: "quando nao tem procedimento vinculado ela
// nao envia a mensagem de confirmacao da agenda"). Antes a importacao do Clinica Experts DESCARTAVA a reserva sem procedimento (ou com
// procedimento que nao existe aqui) e a pessoa ficava sem lembrete. Agora a reserva entra com um procedimento INTERNO ("Horario sem
// procedimento") e a confirmacao sai so com data e horario, sem citar procedimento. Quando a recepcao escolhe o procedimento no CE, a
// importacao troca pelo de verdade (ver pull.ts).
// ---------------------------------------------------------------------------

export const PLACEHOLDER_PROCEDURE_NAME = "Horário sem procedimento (Clínica Experts)";

export function isPlaceholderProcedure(p: { name: string }): boolean {
  return p.name === PLACEHOLDER_PROCEDURE_NAME;
}

// So cria uma vez por clinica. internalOnly: a Alice nunca oferece nem agenda isso.
export async function ensurePlaceholderProcedure(clinicId: string): Promise<Procedure> {
  const found = await prisma.procedure.findFirst({ where: { clinicId, name: PLACEHOLDER_PROCEDURE_NAME } });
  if (found) return found;
  return prisma.procedure.create({
    data: { clinicId, name: PLACEHOLDER_PROCEDURE_NAME, durationMin: 30, internalOnly: true, description: "Interno: reserva do Clínica Experts sem procedimento escolhido. Não é oferecido nem agendado pela Alice." },
  });
}

// PURO: tira do texto da mensagem as linhas que SO existem pra citar o procedimento ("💆 Procedimento: {procedimento}"); o resto da
// mensagem fica igual. Onde {procedimento} aparece no meio de uma frase, o chamador troca por "seu atendimento".
const LABEL_LINE_RE = /^[^\S\n]*[^\p{L}\p{N}\n]*[^\S\n]*(?:procedimento|servi[cç]o|tratamento)s?[^\S\n]*:[^\S\n]*[{\[](?:procedimento)[}\]][^\S\n]*$/iu;

export function stripProcedureLines(message: string): string {
  return message
    .split("\n")
    .filter((line) => !LABEL_LINE_RE.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}
