// ---------------------------------------------------------------------------
// TELEFONE: UM lugar para ler, normalizar e resolver o numero (importacao do CE, cadastro manual, mensagem recebida, selecao das automacoes, envio, deduplicacao e recuperacao pelo
// painel usam esta mesma leitura). Tudo PURO. Regras:
//  - JID e outros identificadores ("5511999999999@s.whatsapp.net", "@g.us", "@lid") NAO sao telefone: kind "jid", valid false (nunca se "corrige" um JID para virar numero);
//  - brasileiro: DDI 55 presente ou ausente, "+", espacos/parenteses/hifens, zeros de tronco ("011"), "0055", DDI duplicado ("5555...") SO quando a correcao e inequivoca;
//  - celular antigo (DDD + 8 digitos comecando em 6-9) e celular com 9: sao o MESMO aparelho em duas formas. `destination` respeita a forma CADASTRADA (so acrescenta o DDI);
//    a outra forma e so `alternate` (usada pelo envio SO depois de rejeicao explicita do primeiro destino - nunca por timeout, 429, desconexao ou erro generico);
//  - fixo nunca ganha 9; internacional nunca ganha nem perde digito; nada de "remover digitos ate achar um WhatsApp".
// Existencia no WhatsApp NAO prova identidade: este modulo nao decide quem e a pessoa, so a FORMA do numero.
// ---------------------------------------------------------------------------

export type PhoneKind = "br_mobile" | "br_landline" | "international" | "jid" | "invalid";

export interface PhoneInfo {
  original: string;
  kind: PhoneKind;
  valid: boolean;
  /** digitos com DDI (BR: 55 + DDD + numero como cadastrado; internacional: como informado). null se invalido. */
  destination: string | null;
  /** BR: DDD (2 digitos). */
  ddd: string | null;
  /** BR: numero local como cadastrado (8 ou 9 digitos). */
  local: string | null;
  /** BR celular: a OUTRA forma do mesmo aparelho (com/sem o 9), estruturalmente valida; so para fallback apos rejeicao explicita. */
  alternate: string | null;
  /** BR celular cadastrado SEM o 9 (numero antigo reconhecivel). */
  oldMobile: boolean;
  /** correcoes e decisoes aplicadas, em codigos curtos (sem dado pessoal). */
  reasons: string[];
  /** motivo da invalidez (quando !valid). */
  invalid?: string;
}

const VALID_DDD = new Set(
  "11 12 13 14 15 16 17 18 19 21 22 24 27 28 31 32 33 34 35 37 38 41 42 43 44 45 46 47 48 49 51 53 54 55 61 62 63 64 65 66 67 68 69 71 73 74 75 77 79 81 82 83 84 85 86 87 88 89 91 92 93 94 95 96 97 98 99".split(" "),
);
export const isBrDdd = (ddd: string): boolean => VALID_DDD.has(ddd);

function bad(original: string, kind: PhoneKind, invalid: string, reasons: string[] = []): PhoneInfo {
  return { original, kind, valid: false, destination: null, ddd: null, local: null, alternate: null, oldMobile: false, reasons, invalid };
}

function brazilian(original: string, ddd: string, local: string, reasons: string[]): PhoneInfo {
  if (!isBrDdd(ddd)) return bad(original, "invalid", "ddd_invalido", reasons);
  if (local.length === 9) {
    if (local[0] !== "9") return bad(original, "invalid", "celular_de_9_digitos_nao_comeca_com_9", reasons);
    // a forma sem o 9 so existe se o resto parece numero de celular antigo (comeca em 6-9)
    const alt = /^[6-9]/.test(local.slice(1)) ? `55${ddd}${local.slice(1)}` : null;
    return { original, kind: "br_mobile", valid: true, destination: `55${ddd}${local}`, ddd, local, alternate: alt, oldMobile: false, reasons };
  }
  if (local.length === 8) {
    if (/^[6-9]/.test(local)) return { original, kind: "br_mobile", valid: true, destination: `55${ddd}${local}`, ddd, local, alternate: `55${ddd}9${local}`, oldMobile: true, reasons: [...reasons, "celular_antigo_sem_9"] };
    if (/^[2-5]/.test(local)) return { original, kind: "br_landline", valid: true, destination: `55${ddd}${local}`, ddd, local, alternate: null, oldMobile: false, reasons };
    return bad(original, "invalid", "numero_local_invalido", reasons);
  }
  return bad(original, "invalid", "tamanho_invalido", reasons);
}

export function parsePhone(raw: string | null | undefined): PhoneInfo {
  const original = String(raw ?? "");
  const text = original.trim();
  if (!text) return bad(original, "invalid", "vazio");
  // identificadores do WhatsApp: nao sao telefone (e nao se "limpa" um JID para virar numero)
  if (/@/.test(text) || /^[a-z]+:/i.test(text)) return bad(original, "jid", "identificador_nao_e_telefone");
  const plus = text.startsWith("+");
  let d = text.replace(/\D/g, "");
  if (!d) return bad(original, "invalid", "sem_digitos");
  const reasons: string[] = [];
  if (d.startsWith("00") && d.length > 4) { d = d.slice(2); reasons.push("prefixo_00_removido"); } // 0055..., 001...
  // internacional explicito (+ ou 00) que NAO e brasileiro
  const explicit = plus || reasons.includes("prefixo_00_removido");
  if (explicit && !d.startsWith("55")) {
    // DDI nunca comeca com 0, e sequencia de um digito so (0000..., 1111...) nao e numero
    if (!/^[1-9]/.test(d) || /^(\d)\1+$/.test(d)) return bad(original, "invalid", "internacional_implausivel", reasons);
    if (d.length < 8 || d.length > 15) return bad(original, "invalid", "internacional_tamanho_invalido", reasons);
    return { original, kind: "international", valid: true, destination: d, ddd: null, local: null, alternate: null, oldMobile: false, reasons };
  }
  // DDI duplicado (5555 + DDD + numero): so quando, tirando UM 55, sobra um numero brasileiro completo e valido
  if (d.startsWith("5555") && (d.length === 14 || d.length === 15)) {
    const inner = parsePhoneDigitsBr(d.slice(2));
    if (inner) { reasons.push("ddi_duplicado_corrigido"); return brazilian(original, inner.ddd, inner.local, reasons); }
  }
  // com DDI 55 (12 ou 13 digitos)
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) {
    const ddd = d.slice(2, 4), local = d.slice(4);
    if (isBrDdd(ddd)) return brazilian(original, ddd, local, reasons);
  }
  // nacional com zero de tronco ("011 99999-9999")
  let nat = d;
  if (nat.startsWith("0") && (nat.length === 11 || nat.length === 12) && isBrDdd(nat.slice(1, 3))) { nat = nat.slice(1); reasons.push("zero_de_tronco_removido"); }
  if (nat.length === 10 || nat.length === 11) {
    const ddd = nat.slice(0, 2), local = nat.slice(2);
    if (isBrDdd(ddd)) {
      reasons.push("ddi_55_assumido");
      return brazilian(original, ddd, local, reasons);
    }
  }
  // numero sem + com mais de 13 digitos ou que nao fecha como brasileiro: nao se adivinha
  if (d.length >= 8 && d.length <= 15 && explicit) return { original, kind: "international", valid: true, destination: d, ddd: null, local: null, alternate: null, oldMobile: false, reasons };
  return bad(original, "invalid", d.length < 10 ? "curto_demais" : d.length > 13 ? "longo_demais_ou_ambiguo" : "nao_fecha_como_numero_brasileiro", reasons);
}

function parsePhoneDigitsBr(d: string): { ddd: string; local: string } | null {
  if (d.startsWith("55") && (d.length === 12 || d.length === 13) && isBrDdd(d.slice(2, 4))) return { ddd: d.slice(2, 4), local: d.slice(4) };
  return null;
}

/** DDI + DDD + numero tal como esta cadastrado (a forma que o envio usa primeiro). null se invalido. */
export function destinationOf(raw: string | null | undefined): string | null {
  return parsePhone(raw).destination;
}

/** Chave canonica de IDENTIDADE (celular sempre com o 9; fixo como esta; internacional como informado). NUNCA "ultimos 8 digitos": o DDD tambem precisa bater. */
export function canonicalKey(raw: string | null | undefined): string | null {
  const p = parsePhone(raw);
  if (!p.valid) return null;
  if (p.kind === "br_mobile") return `55${p.ddd}${p.local!.length === 8 ? `9${p.local}` : p.local}`;
  return p.destination;
}

/** Duas formas do MESMO numero (com/sem DDI, com/sem o 9o digito do celular). */
export function samePhoneStrict(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = canonicalKey(a), y = canonicalKey(b);
  return !!x && x === y;
}

/** Mascara para log/tela sem permissao: so os 4 ultimos digitos. */
export function maskDigits(raw: string | null | undefined): string {
  const d = String(raw ?? "").replace(/\D/g, "");
  return d.length >= 4 ? `…${d.slice(-4)}` : "…";
}
