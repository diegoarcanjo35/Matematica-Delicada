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
  /** Exclusiva de wrangler.local.jsonc — nunca presente em config implantável. */
  ENABLE_LOCAL_PATTERN_FIXTURES?: string;
  /** Exclusiva de wrangler.local.jsonc — nunca presente em config implantável. */
  ENABLE_LOCAL_EDITORIAL_FIXTURES?: string;
  /** Sprint 15 v1.1 (adendo — Bootstrap Administrativo Seguro, seções H/N).
   *  Segredo comparado em tempo constante contra o cabeçalho
   *  X-Admin-Bootstrap-Secret em POST /api/admin-bootstrap/run (ver
   *  worker/src/routes/adminBootstrap.ts). Deliberadamente NUNCA presente em
   *  wrangler.jsonc NEM em wrangler.local.jsonc nesta sprint — ausente
   *  (undefined/vazio) faz a rota inteira responder 404 sem revelar que
   *  existe (mesmo padrão de falha fechada do resto de env.ts), então em
   *  todo ambiente hoje (local, preview, produção) o mecanismo está
   *  inteiramente inerte. Ao contrário das flags ENABLE_LOCAL_... / DEV_...
   *  acima, esta variável NÃO entra em FORBIDDEN_DEV_VAR_NAMES
   *  (scripts/check-deployable-d1-config.mjs): ela é, por desenho, a MESMA
   *  variável que uma ordem futura e separada do PO (adendo seção T)
   *  autorizaria configurar em produção via `wrangler secret put` — nunca
   *  commitada em nenhum arquivo de configuração, nem local nem
   *  implantável. Só é passada explicitamente em testes automatizados
   *  (worker/testing/adminBootstrap.test.ts), nunca lida de um arquivo
   *  versionado. */
  ADMIN_BOOTSTRAP_SECRET?: string;
  /** Sprint 16 v1.0 (A1) — e-mail transacional real (Resend). Secret, nunca
   *  presente em nenhum arquivo de configuração versionado (nem
   *  wrangler.jsonc, nem wrangler.local.jsonc) — configurado via
   *  `wrangler secret put` numa rodada separada, só depois de auditoria da
   *  implementação (mesma disciplina de ADMIN_BOOTSTRAP_SECRET). Ausente =
   *  nenhum provedor real configurado ainda; ver isRealEmailProviderConfigured. */
  RESEND_API_KEY?: string;
  /** Endereço "From" usado nos envios reais (ex.: "Matemática Delicada <no-reply@dominio>").
   *  Não é secret (não é sensível), mas também nunca hardcoded no código —
   *  vive em "vars" comuns, ao lado dela mesma exigindo domínio verificado
   *  na Resend antes de funcionar de verdade. */
  EMAIL_FROM_ADDRESS?: string;
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

/* Sprint 6 v1.0 — mesmo padrão de falha fechada para os cinco padrões
   recorrentes do ENEM citados no Documento Mestre (CONTEÚDO TÉCNICO
   PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR — ver
   scripts/fixtures/patterns-fixtures.local.sql). Fora das três condições
   simultâneas, a API de padrões responde "catálogo em preparação" sem
   tocar nas tabelas patterns/pattern_*. */
export function isLocalPatternFixturesAllowed(env: Env, url: URL): boolean {
  return (
    hasLocalDevEnvironmentValue(env) &&
    isTrue(env.ENABLE_LOCAL_PATTERN_FIXTURES) &&
    isRecognizedLocalHostname(url)
  );
}

/* Sprint 7 v1.0 — mesmo padrão de falha fechada, usado para DUAS coisas
   distintas do Banco de Questões, ambas sensíveis:
     1) o bootstrap local que concede papéis editor/admin (seção 4.2 da
        ordem) — nunca por GET, nunca por cadastro comum, só por uma ação
        explícita de setup local atrás deste gate;
     2) as questões técnicas fictícias (CONTEÚDO TÉCNICO PROVISÓRIO PARA
        DESENVOLVIMENTO LOCAL — NÃO PUBLICAR — ver
        scripts/fixtures/questions-fixtures.local.sql).
   Fora das três condições simultâneas (ambiente local + flag exclusiva de
   wrangler.local.jsonc + hostname local reconhecido, nunca X-Forwarded-Host),
   nenhum papel é concedido e nenhum conteúdo de fixture é servido. */
export function isLocalEditorialFixturesAllowed(env: Env, url: URL): boolean {
  return (
    hasLocalDevEnvironmentValue(env) &&
    isTrue(env.ENABLE_LOCAL_EDITORIAL_FIXTURES) &&
    isRecognizedLocalHostname(url)
  );
}

/* Sprint 15 v1.1 (adendo, seções H/N) — a ÚNICA condição de existência da
   rota de bootstrap administrativo: um valor não-vazio configurado para
   ADMIN_BOOTSTRAP_SECRET. Deliberadamente NÃO combinada com
   hasLocalDevEnvironmentValue/isRecognizedLocalHostname como as flags
   ENABLE_LOCAL_... / DEV_... acima — aquelas existem para conteúdo/atalhos que
   NUNCA podem alcançar produção; este mecanismo, ao contrário, é desenhado
   para ser utilizável em produção no futuro, mas só depois de uma ordem
   separada do PO configurar um segredo real via `wrangler secret put`
   (adendo seção T) — até lá, como nenhum arquivo de configuração deste
   repositório declara a variável, esta função retorna false em todo
   ambiente (local, preview, produção) e a rota responde 404. */
export function isAdminBootstrapConfigured(env: Env): boolean {
  return typeof env.ADMIN_BOOTSTRAP_SECRET === "string" && env.ADMIN_BOOTSTRAP_SECRET.length >= 20;
}

/* Sprint 16 v1.0 (A1) — mesmo padrão de isAdminBootstrapConfigured: a única
   condição de existência de um provedor real de e-mail é ter os dois
   valores necessários configurados (secret + remetente). Nenhuma
   verificação de ambiente/hostname aqui — ao contrário das flags
   ENABLE_LOCAL_.../DEV_..., um provedor real DEVE poder funcionar em
   produção (é exatamente o objetivo desta sprint); a condição de
   "ambiente local" já é tratada separadamente por isDevOutboxAllowed, que
   tem prioridade quando ambas fossem tecnicamente verdadeiras (ver
   emailAdapterFor em worker/src/routes/auth.ts). */
export function isRealEmailProviderConfigured(env: Env): boolean {
  return (
    typeof env.RESEND_API_KEY === "string" &&
    env.RESEND_API_KEY.length >= 20 &&
    typeof env.EMAIL_FROM_ADDRESS === "string" &&
    env.EMAIL_FROM_ADDRESS.includes("@")
  );
}
