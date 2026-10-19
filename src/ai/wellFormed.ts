// ---------------------------------------------------------------------------
// TEXTO BEM FORMADO PARA A OPENAI (log de producao de 19/10/2026: HTTP 400 "Invalid body: failed to parse JSON value" / code=invalid_json no juiz de recontato). A rejeicao e do
// CORPO DA REQUISICAO, nao do que o modelo respondeu. Causa mais provavel e reproduzida em teste: cortar um texto com \`slice(0, N)\` no meio de um emoji (par substituto UTF-16, ex.:
// 💗 = \\ud83d\\udc97) deixa um substituto SOZINHO; JSON.stringify o escreve como "\\ud83d" (sintaticamente valido para o JavaScript), mas o servidor da OpenAI recusa a requisicao.
// Duas defesas: (1) cortar sem partir o par (safeSlice) e (2) um fetch que, no ultimo instante, troca qualquer substituto solto do corpo por U+FFFD (safeFetch), valendo para TODOS
// os clientes da OpenAI. Nada de montar JSON na mao: o corpo continua sendo o JSON.stringify do SDK.
// ---------------------------------------------------------------------------

// Corta em `n` unidades sem deixar o primeiro caractere de um par substituto no fim.
export function safeSlice(text: string, n: number): string {
  const cut = text.slice(0, n);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

// Troca substitutos soltos por U+FFFD.
export function wellFormed(text: string): string {
  return text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "�");
}

// Procura, num CORPO JSON ja serializado, escapes \uD800-\uDFFF que nao formam um par valido. \\\\ (barra escapada) e consumida antes para nao confundir "\\\\ud83d" (texto) com escape.
const SERIALIZED_SURROGATE = /\\\\|\\u(d[89ab][0-9a-f]{2})\\u(d[c-f][0-9a-f]{2})|\\u(d[89a-f][0-9a-f]{2})/gi;

export function hasLoneSurrogateEscape(body: string): boolean {
  SERIALIZED_SURROGATE.lastIndex = 0;
  for (let m = SERIALIZED_SURROGATE.exec(body); m; m = SERIALIZED_SURROGATE.exec(body)) if (m[3]) return true;
  return false;
}

export function sanitizeJsonBody(body: string): string {
  return body.replace(SERIALIZED_SURROGATE, (m, _hi, _lo, lone) => (lone ? "\\ufffd" : m));
}

// fetch para os clientes da OpenAI: corrige o corpo antes de sair. Le globalThis.fetch NA HORA da chamada (testes simulam a rede trocando-o).
export const safeFetch: typeof fetch = (input, init) => {
  const body = init?.body;
  const fixed = typeof body === "string" && hasLoneSurrogateEscape(body) ? { ...init, body: sanitizeJsonBody(body) } : init;
  return globalThis.fetch(input, fixed);
};
