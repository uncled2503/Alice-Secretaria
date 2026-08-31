// Mapeia o DDD do telefone para a UF (estado). Usado no painel para mostrar
// de onde estao chegando os leads.

const DDD_UF: Record<string, string> = {
  "11": "SP", "12": "SP", "13": "SP", "14": "SP", "15": "SP", "16": "SP", "17": "SP", "18": "SP", "19": "SP",
  "21": "RJ", "22": "RJ", "24": "RJ",
  "27": "ES", "28": "ES",
  "31": "MG", "32": "MG", "33": "MG", "34": "MG", "35": "MG", "37": "MG", "38": "MG",
  "41": "PR", "42": "PR", "43": "PR", "44": "PR", "45": "PR", "46": "PR",
  "47": "SC", "48": "SC", "49": "SC",
  "51": "RS", "53": "RS", "54": "RS", "55": "RS",
  "61": "DF",
  "62": "GO", "64": "GO",
  "63": "TO",
  "65": "MT", "66": "MT",
  "67": "MS",
  "68": "AC",
  "69": "RO",
  "71": "BA", "73": "BA", "74": "BA", "75": "BA", "77": "BA",
  "79": "SE",
  "81": "PE", "87": "PE",
  "82": "AL",
  "83": "PB",
  "84": "RN",
  "85": "CE", "88": "CE",
  "86": "PI", "89": "PI",
  "91": "PA", "93": "PA", "94": "PA",
  "92": "AM", "97": "AM",
  "95": "RR",
  "96": "AP",
  "98": "MA", "99": "MA",
};

// Aceita "5511987654321", "11987654321", "(11) 98765-4321" etc.
export function phoneToUf(phone: string | null | undefined): string | null {
  let digits = String(phone ?? "").replace(/\D/g, "");
  if (digits.length >= 12 && digits.startsWith("55")) digits = digits.slice(2);
  if (digits.length < 10) return null;
  return DDD_UF[digits.slice(0, 2)] ?? null;
}

// Conta leads por UF a partir de uma lista de telefones. Ordenado do maior
// para o menor; telefones sem DDD reconhecido caem em "??" (nao entram).
export function leadsByState(phones: (string | null | undefined)[]): { uf: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const phone of phones) {
    const uf = phoneToUf(phone);
    if (!uf) continue;
    counts.set(uf, (counts.get(uf) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([uf, count]) => ({ uf, count }))
    .sort((a, b) => b.count - a.count);
}
