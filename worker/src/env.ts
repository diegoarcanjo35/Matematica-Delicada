import { isHttpProtocol, isRecognizedLocalHostname } from "./lib/localHost";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ENVIRONMENT?: string;
  /** Exclusiva de wrangler.local.jsonc — nunca presente em config implantável. */
  DEV_OUTBOX_ENABLED?: string;
  /** Exclusiva de wrangler.local.jsonc — nunca presente em config implantável. */
  ALLOW_INSECURE_LOCAL_COOKIE?: string;
}

const LOCAL_DEV_ENVIRONMENTS = new Set(["development", "test"]);

/** Só a variável de ambiente — mantido para checagens que não têm a URL à mão
 *  (nenhum comportamento sensível deve depender só disto; ver as funções
 *  combinadas abaixo, que são as usadas de fato pelas rotas). */
function hasLocalDevEnvironmentValue(env: Env): boolean {
  return LOCAL_DEV_ENVIRONMENTS.has(env.ENVIRONMENT ?? "");
}

function isTrue(value: string | undefined): boolean {
  return value === "true";
}

/* Sprint 2 v1.2, correção 3.1 — três condições, TODAS obrigatórias:
   1) ENVIRONMENT é exatamente "development" ou "test";
   2) a flag local explícita DEV_OUTBOX_ENABLED é exatamente "true" — presente
      só em wrangler.local.jsonc, nunca na config implantável;
   3) o hostname da URL efetivamente recebida é localhost/127.0.0.1/[::1] —
      nunca X-Forwarded-Host, nunca *.workers.dev, nunca domínio customizado.
   "ENVIRONMENT=development" sozinho NÃO basta mais (falhava aberto se aplicado
   por engano a um Worker remoto). */
export function isDevOutboxAllowed(env: Env, url: URL): boolean {
  return hasLocalDevEnvironmentValue(env) && isTrue(env.DEV_OUTBOX_ENABLED) && isRecognizedLocalHostname(url);
}

/* Sprint 2 v1.2, correção 3.2 — quatro condições, TODAS obrigatórias:
   1) ENVIRONMENT === "development" (exatamente — "test" NÃO omite Secure);
   2) ALLOW_INSECURE_LOCAL_COOKIE é exatamente "true";
   3) hostname é localhost/127.0.0.1/[::1];
   4) protocolo é http: (HTTPS local mantém Secure).
   Qualquer outro cenário — ambiente ausente/test/staging/production/desconhecido,
   flag ausente, hostname remoto, domínio workers.dev, HTTPS local — mantém Secure. */
export function shouldOmitSecureCookie(env: Env, url: URL): boolean {
  return (
    env.ENVIRONMENT === "development" &&
    isTrue(env.ALLOW_INSECURE_LOCAL_COOKIE) &&
    isRecognizedLocalHostname(url) &&
    isHttpProtocol(url)
  );
}
