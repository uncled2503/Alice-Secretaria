// ---------------------------------------------------------------------------
// LINK DE AVALIACAO NO GOOGLE: uma fonte so (Clinic.googleReviewUrl) e um estado de confirmacao. O link so e ENVIADO se (1) tem formato de link de
// avaliacao do Google e (2) alguem da clinica/admin CONFIRMOU que o destino e o estabelecimento certo (googleReviewConfirmedAt). Validar a URL nao
// prova que ela pertence a clinica: por isso a confirmacao e um ato explicito (painel da clinica ou manutencao com a conferencia do admin).
// Ausente ou nao confirmado: a Alice agradece normalmente, NAO manda link, e a pendencia fica registrada para a equipe.
// Tudo PURO (testavel).
// ---------------------------------------------------------------------------

export type ReviewLinkProblem = "vazio" | "nao_e_https" | "url_invalida" | "pagina_de_busca" | "dominio_nao_reconhecido" | "sem_caminho_de_avaliacao";

// Dominios usados nos links de AVALIACAO do Google (g.page/r/<id>/review, search.google.com/local/writereview?placeid=..., maps.app.goo.gl/..., g.co/kgs/...).
const REVIEW_HOSTS = ["g.page", "search.google.com", "maps.app.goo.gl", "goo.gl", "g.co", "www.google.com", "google.com", "maps.google.com"];

export interface ReviewLinkCheck {
  ok: boolean;
  problem?: ReviewLinkProblem;
  detail?: string;
  url?: string; // normalizada (sem espacos)
  host?: string;
}

export function validateReviewUrl(raw: string | null | undefined): ReviewLinkCheck {
  const url = (raw ?? "").trim();
  if (!url) return { ok: false, problem: "vazio", detail: "nenhum link informado" };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, problem: "url_invalida", detail: "nao e uma URL valida" };
  }
  if (u.protocol !== "https:") return { ok: false, problem: "nao_e_https", detail: "o link precisa comecar com https://" };
  const host = u.hostname.toLowerCase();
  if (!REVIEW_HOSTS.includes(host)) return { ok: false, problem: "dominio_nao_reconhecido", detail: `dominio ${host} nao e de link de avaliacao do Google`, host };
  const path = u.pathname.toLowerCase();
  // pagina de BUSCA generica (google.com/search?q=...) nao leva a avaliacao do estabelecimento
  if ((host === "www.google.com" || host === "google.com") && (path === "/search" || path === "/" || path.startsWith("/search"))) return { ok: false, problem: "pagina_de_busca", detail: "pagina de busca do Google nao vale como link de avaliacao", host };
  if (host === "g.page" && !/^\/r\/[^/]+\/review\/?$/.test(path)) return { ok: false, problem: "sem_caminho_de_avaliacao", detail: "link g.page sem /r/<codigo>/review", host };
  if (host === "search.google.com" && !/^\/local\/(writereview|reviews)/.test(path)) return { ok: false, problem: "sem_caminho_de_avaliacao", detail: "link search.google.com sem /local/writereview", host };
  if ((host === "www.google.com" || host === "google.com" || host === "maps.google.com") && !/\/maps\//.test(path) && !/\/local\//.test(path)) return { ok: false, problem: "pagina_de_busca", detail: "link do Google sem caminho de mapa/avaliacao", host };
  return { ok: true, url: u.toString(), host };
}

export interface ReviewLinkClinic {
  googleReviewUrl: string | null;
  googleReviewConfirmedAt: Date | null;
  googleReviewPlace?: string | null;
  googleReviewLegacyAllowed?: boolean | null; // envio mantido por compatibilidade com o comportamento anterior: NAO e conferencia do destino
}

export type ReviewLinkState =
  // basis: "confirmado" = alguem registrou a confirmacao (quem/quando); "compatibilidade" = so continua como era antes, o destino NUNCA foi conferido.
  // placeChecked: o nome do estabelecimento de destino foi conferido (so a confirmacao com estabelecimento informado).
  | { send: true; url: string; basis: "confirmado" | "compatibilidade"; placeChecked: boolean }
  | { send: false; reason: "ausente" | "invalido" | "nao_confirmado"; detail: string };

// O link pode ir na mensagem? Ausente / invalido / nao confirmado = nao vai.
export function reviewLinkState(c: ReviewLinkClinic): ReviewLinkState {
  const check = validateReviewUrl(c.googleReviewUrl);
  if (!c.googleReviewUrl?.trim()) return { send: false, reason: "ausente", detail: "a clinica nao cadastrou o link de avaliacao do Google" };
  if (!check.ok) return { send: false, reason: "invalido", detail: check.detail ?? "link invalido" };
  if (c.googleReviewConfirmedAt) return { send: true, url: check.url!, basis: "confirmado", placeChecked: !!c.googleReviewPlace?.trim() };
  if (c.googleReviewLegacyAllowed) return { send: true, url: check.url!, basis: "compatibilidade", placeChecked: false };
  return { send: false, reason: "nao_confirmado", detail: "o link esta cadastrado mas ninguem confirmou que o destino e o estabelecimento certo" };
}

// Texto do convite de indicacao: pede que a PROPRIA cliente compartilhe o contato da clinica. Nunca pede nome/telefone de terceiros, nem oferece recompensa.
const THIRD_PARTY_DATA = /\b(me )?(passa|passe|manda|mande|envia|envie|d[aê]|informe|diga)\b.{0,40}\b(telefone|numero|contato|whatsapp|nome|email|e-mail)\b.{0,30}\b(d[ae]|dela|dele|amig[ao]|familiar|parente|indicad[oa])\b|\b(telefone|numero|whatsapp|contato) (d[ae]|dela|dele) (sua |seu )?(amig|famil|parent|indicad)/;
const REWARD = /\b(desconto|brinde|presente|ganh[ae]|ganhar|premio|cortesia|gratis|gratuit[oa]|bonus|cashback|vantagem|beneficio|sorteio|vale)\b/;

export function validateReferralText(raw: string | null | undefined): { ok: boolean; problem?: string } {
  const t = (raw ?? "").trim();
  if (!t) return { ok: false, problem: "texto vazio" };
  const f = t.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
  if (THIRD_PARTY_DATA.test(f)) return { ok: false, problem: "nao pode pedir nome, telefone ou contato de terceiros: o convite e para a propria cliente compartilhar o contato da clinica" };
  if (REWARD.test(f)) return { ok: false, problem: "nao pode oferecer recompensa, desconto ou brinde pela indicacao" };
  return { ok: true };
}

export const DEFAULT_REFERRAL_TEXT =
  "Se você tiver uma amiga ou um familiar que gostaria de conhecer o atendimento da {unidade}, fique à vontade para compartilhar o nosso contato com ela. 💗";
