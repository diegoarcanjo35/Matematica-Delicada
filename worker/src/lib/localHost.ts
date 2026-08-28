/* Sprint 2 v1.2 — reconhecimento de "execução local" baseado SÓ na URL
   efetivamente recebida pelo Worker (o `url` que o runtime já resolveu a
   partir da conexão real), nunca em headers que o cliente controla como
   `X-Forwarded-Host` — esse header pode alegar "localhost" vindo de qualquer
   lugar e não prova nada sobre onde o Worker está rodando de verdade. */

// Node/WHATWG URL mantém os colchetes em `url.hostname` para IPv6 ("[::1]",
// não "::1") — incluímos as duas formas para não depender desse detalhe de
// runtime específico.
const RECOGNIZED_LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Aceita tanto "::1" quanto "[::1]", dependendo de como o runtime normaliza. */
export function isRecognizedLocalHostname(url: URL): boolean {
  return RECOGNIZED_LOCAL_HOSTNAMES.has(url.hostname);
}

export function isHttpProtocol(url: URL): boolean {
  return url.protocol === "http:";
}
