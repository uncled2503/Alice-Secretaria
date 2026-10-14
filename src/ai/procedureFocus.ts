// ---------------------------------------------------------------------------
// ECONOMIA DE TOKENS (pedido da Lisboa/dono, 14/10/2026: "gastar o menos possivel com a maior qualidade"). O catalogo da Lisboa tem ~290
// procedimentos com descricao: ~33 mil tokens mandados a CADA mensagem, mesmo quando a conversa e sobre um procedimento so. Agora o prompt leva
// a lista COMPACTA (nome, duracao, valor) e os DETALHES so dos procedimentos que a conversa toca (ate 6 + a avaliacao). A escolha e
// deterministica (sem chamada ao modelo): palavras da conversa x nome/apelidos/queixas/beneficios/descricao + regiao do corpo.
// ---------------------------------------------------------------------------

import { areasIn } from "./relevance.js";

function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

const STOP = new Set(
  "para com uma que por dos das nao sim quero queria gostaria saber sobre voce voces meu minha como tem tenho fazer valor valores preco quanto custa hoje amanha boa bom dia tarde noite obrigada obrigado ola oii pode posso mais muito pouco isso esse essa aqui ainda tambem entao porque pois quando onde qual quais fica ficar vez vezes algum alguma gente favor por".split(" "),
);

export function tokens(text: string): string[] {
  return fold(text)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !STOP.has(w));
}

export interface FocusProc {
  id: string;
  name: string;
  aliases?: string | null;
  goals?: string | null;
  benefits?: string | null;
  description?: string | null;
}

// PURO: ids dos procedimentos que a conversa toca (os mais relevantes primeiro). `texts` em ordem cronologica; os ultimos pesam mais.
export function selectFocusProcedures<P extends FocusProc>(procs: P[], texts: string[], max = 6): P[] {
  const clean = texts.map((t) => t.trim()).filter(Boolean);
  if (!clean.length || !procs.length) return procs.filter((p) => /avalia/i.test(p.name)).slice(0, 1);

  // peso de cada palavra: palavras que aparecem no nome de muitos procedimentos ("facial", "corporal") valem menos
  const df = new Map<string, number>();
  const nameTokens = new Map<string, Set<string>>();
  for (const p of procs) {
    const set = new Set(tokens(`${p.name} ${p.aliases ?? ""}`));
    nameTokens.set(p.id, set);
    for (const w of set) df.set(w, (df.get(w) ?? 0) + 1);
  }
  const weight = (w: string) => 1 / Math.log(2 + (df.get(w) ?? 0));

  // recencia: a ultima mensagem pesa 2x, as 3 anteriores 1x, o resto 0,5x
  const scoreByProc = new Map<string, number>();
  const bump = (id: string, v: number) => scoreByProc.set(id, (scoreByProc.get(id) ?? 0) + v);
  clean.forEach((text, idx) => {
    const fromEnd = clean.length - 1 - idx;
    const factor = fromEnd === 0 ? 2 : fromEnd <= 3 ? 1 : 0.5;
    const tks = new Set(tokens(text));
    const f = fold(text);
    const textAreas = areasIn(text);
    for (const p of procs) {
      const nameSet = nameTokens.get(p.id)!;
      let s = 0;
      for (const w of tks) if (nameSet.has(w)) s += 6 * weight(w);
      const key = fold(p.name).trim();
      if (key.length >= 5 && f.includes(key)) s += 12; // o nome inteiro foi dito
      const detail = new Set(tokens(`${p.goals ?? ""} ${p.benefits ?? ""} ${(p.description ?? "").slice(0, 600)}`));
      for (const w of tks) if (detail.has(w) && !nameSet.has(w)) s += 2 * weight(w);
      if (textAreas.size) {
        const procAreas = areasIn(`${p.name} ${p.aliases ?? ""}`);
        for (const a of procAreas) if (textAreas.has(a)) s += 5;
      }
      if (s > 0) bump(p.id, s * factor);
    }
  });

  const ranked = procs
    .map((p) => ({ p, s: scoreByProc.get(p.id) ?? 0 }))
    .filter((x) => x.s > 0.5)
    .sort((a, b) => b.s - a.s)
    .slice(0, max)
    .map((x) => x.p);
  // a avaliacao entra sempre (a conversa quase sempre chega nela)
  const evalProc = procs.find((p) => /avalia/i.test(p.name));
  if (evalProc && !ranked.some((p) => p.id === evalProc.id)) ranked.push(evalProc);
  return ranked;
}
