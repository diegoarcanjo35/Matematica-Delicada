import { isHttpProtocol, isRecognizedLocalHostname } from "./lib/localHost";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ENVIRONMENT?: string;
  /** Exclusiva de wrangler.local.jsonc — nunca presente em config implantável. */
  DEV_OUTBOX_ENABLED?: string;
  /** Exclusiva de wrangler.local.jsonc — nunca presente em config implantável. */
  ALLOW_INSECURE_LOCAL_COOKIE?: string;
  /** Exclusiva de wrangler.local.jsonc — nunca presente em config implantável. */
  ALLOW_TEST_RATE_LIMIT_ISOLATION?: string;
  /** Exclusiva de wrangler.local.jsonc — nunca presente em config implantável. */
  ENABLE_LOCAL_DIAGNOSTIC_FIXTURES?: string;
  /** Exclusiva de wrangler.local.jsonc — nunca presente em config implantável. */
  ENABLE_LOCAL_SCHEDULE_FIXTURES?: string;
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

/* Sprint 3 v1.2 — correção estrutural de isolamento de teste. O limitador de
   taxa por IP (rateLimit.ts:clientIdentifier) cai num identificador fixo
   ("local-dev") em wrangler dev local, porque a Cloudflare não injeta
   cf-connecting-ip fora da borda real. Isso fazia toda a suíte E2E
   compartilhar UM contador de IP entre arquivos de teste diferentes — uma
   dependência implícita de ordem/execução (arquivo que esgota o limite
   "vazava" para qualquer outro arquivo que rodasse depois).

   A correção NÃO afrouxa o limite de produção nem cria um jeito de burlar o
   rate limit real: só permite que a REQUISIÇÃO DE TESTE informe seu próprio
   identificador (cabeçalho X-E2E-RateLimit-Client-Id), e só quando as
   mesmas três condições de falha fechada já usadas no projeto estiverem
   simultaneamente satisfeitas — igual a isDevOutboxAllowed. Fora de um
   ambiente local explícito, o cabeçalho é sempre ignorado e o identificador
   real do cliente prevalece; em produção real (sem ENVIRONMENT=development/
   test, sem esta flag em wrangler.jsonc, e com hostname público) esta função
   retorna false sempre, então o cabeçalho nunca tem efeito algum. */
export function isTestRateLimitIsolationAllowed(env: Env, url: URL): boolean {
  return (
    hasLocalDevEnvironmentValue(env) &&
    isTrue(env.ALLOW_TEST_RATE_LIMIT_ISOLATION) &&
    isRecognizedLocalHostname(url)
  );
}

/* Sprint 4 v1.0 — as 12 questões do diagnóstico inicial nesta sprint são
   CONTEÚDO TÉCNICO PROVISÓRIO (fixtures locais, nunca pedagogicamente
   aprovadas, nunca inseridas no D1 remoto — ver
   scripts/fixtures/diagnostic-fixtures.local.sql). Mesmo assim, todo
   endpoint que serve conteúdo de questão ou permite iniciar uma tentativa
   verifica este gate ANTES de tocar nas tabelas diagnostic_* — mesmo padrão
   de falha fechada de isDevOutboxAllowed. Fora das três condições
   simultâneas (ambiente local + flag exclusiva de wrangler.local.jsonc +
   hostname local), a API responde "diagnóstico em preparação pedagógica"
   sem consultar o banco, nunca 404/500 nem qualquer vazamento de conteúdo. */
export function isLocalDiagnosticFixturesAllowed(env: Env, url: URL): boolean {
  return (
    hasLocalDevEnvironmentValue(env) &&
    isTrue(env.ENABLE_LOCAL_DIAGNOSTIC_FIXTURES) &&
    isRecognizedLocalHostname(url)
  );
}

/* Sprint 5 v1.0 — mesmo padrão de falha fechada para as atividades técnicas
   fictícias do cronograma adaptativo (CONTEÚDO TÉCNICO PROVISÓRIO — ver
   scripts/fixtures/schedule-fixtures.local.sql). Fora das três condições
   simultâneas, a API responde "cronograma em preparação" sem tocar nas
   tabelas schedule_*. */
export function isLocalScheduleFixturesAllowed(env: Env, url: URL): boolean {
  return (
    hasLocalDevEnvironmentValue(env) &&
    isTrue(env.ENABLE_LOCAL_SCHEDULE_FIXTURES) &&
    isRecognizedLocalHostname(url)
  );
}
