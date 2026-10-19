// ---------------------------------------------------------------------------
// SAUDACAO SEM NOME UTILIZAVEL (log de producao de 19/10/2026: "Oi, !" e contatos cujo nome so tem simbolos/emoji). O nome vem do WhatsApp (pushName) e pode ser vazio,
// so emoji ("🌸💗"), pontuacao ou um apelido sem letras. Nesses casos a mensagem sai com saudacao neutra ("Oi!") em vez de "Oi, !". Nenhum cadastro e alterado:
// so a forma como o primeiro nome entra no TEXTO. Tudo PURO.
// ---------------------------------------------------------------------------

// Primeiro nome UTILIZAVEL: a primeira palavra com pelo menos 2 letras (acentos, hifen e apostrofo valem); emoji e simbolos em volta sao ignorados. "" = nao ha.
export function usableFirstName(name: string | null | undefined): string {
  for (const token of (name ?? "").trim().split(/\s+/)) {
    const cleaned = token.replace(/[^\p{L}'’-]/gu, "").replace(/^[-'’]+|[-'’]+$/g, "");
    if ((cleaned.match(/\p{L}/gu) ?? []).length >= 2) return cleaned;
  }
  return "";
}

// Nome completo para {nome_completo}: sem simbolos soltos; vazio se nao houver nenhuma palavra com letras.
export function usableFullName(name: string | null | undefined): string {
  const words = (name ?? "").trim().split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}'’.-]/gu, "")).filter((w) => /\p{L}/u.test(w));
  return words.join(" ");
}

// Arruma o que sobra quando o nome entra vazio: "Oi, !" -> "Oi!", "Ola, , tudo bem" -> "Ola, tudo bem", "Bom dia, \n" -> "Bom dia\n". Nao mexe em virgula normal.
export function tidyGreetingText(text: string): string {
  return text
    .replace(/,\s*,/g, ",")
    .replace(/,[ \t]*([!?.])/g, "$1")
    .replace(/,[ \t]*(\r?\n)/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[ \t]+|[ \t]+$/gm, "");
}
