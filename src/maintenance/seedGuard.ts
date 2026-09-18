import { prisma } from "../db/client.js";

// Principio geral de todo seed de clinica, a partir de 18/09/2026 (pedido
// explicito do cliente depois de editar manualmente os procedimentos da
// Diamond Clinic e quase perder isso num "Aplicar configuração" futuro):
// reaplicar um treino NUNCA pode sobrescrever o que ja existe. Um registro
// so e criado quando ainda nao existe - uma vez criado, so a propria
// clinica (via painel) ou uma correcao pontual e explicita muda ele.
// Clicar o botao de novo vira, na pratica, "preencher o que ainda falta",
// nunca "sincronizar tudo de novo por cima".
export async function createOnce<T>(find: () => Promise<T | null>, create: () => Promise<T>): Promise<T> {
  const existing = await find();
  if (existing) return existing;
  return create();
}

// Blocos de regra (CustomRule) sao recriados em lote (deleteMany+createMany)
// hoje - isso apaga qualquer edicao manual que a clinica tenha feito numa
// regra individual pelo painel. Roda a criacao so na PRIMEIRA vez (nenhuma
// regra com esse marker ainda existe pra essa clinica); depois disso nunca
// mais mexe no bloco, mesmo que o array de regras no codigo mude depois.
export async function seedRulesOnce(
  clinicId: string,
  marker: string,
  rules: readonly { category: string; instruction: string }[],
): Promise<{ created: boolean }> {
  const alreadySeeded = await prisma.customRule.findFirst({ where: { clinicId, rawInput: marker } });
  if (alreadySeeded) return { created: false };
  await prisma.customRule.createMany({
    data: rules.map((r) => ({ clinicId, category: r.category, rawInput: marker, instruction: r.instruction, status: "active" })),
  });
  return { created: true };
}
