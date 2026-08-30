// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  isDevOutboxAllowed,
  isLocalDiagnosticFixturesAllowed,
  isTestRateLimitIsolationAllowed,
  shouldOmitSecureCookie,
  type Env,
} from "./env";

function envWith(overrides: Partial<Env>): Env {
  return { DB: {} as never, ASSETS: {} as never, ...overrides };
}

/* Sprint 2 v1.2 — matriz obrigatória da ordem de correção, seção 4.
   "ENVIRONMENT=development" sozinho NÃO é mais suficiente para nada sensível. */
describe("isDevOutboxAllowed — três condições obrigatórias (ambiente + flag local + hostname)", () => {
  it.each([
    ["development + true + localhost", "development", "true", "http://localhost:8788", true],
    ["test + true + 127.0.0.1", "test", "true", "http://127.0.0.1:8788", true],
    ["development + true + [::1]", "development", "true", "http://[::1]:8788", true],
    ["development + ausente/false + localhost", "development", undefined, "http://localhost:8788", false],
    ["development + \"false\" + localhost", "development", "false", "http://localhost:8788", false],
    ["test + ausente/false + localhost", "test", undefined, "http://localhost:8788", false],
    ["production + true + localhost", "production", "true", "http://localhost:8788", false],
    ["ausente + true + localhost", undefined, "true", "http://localhost:8788", false],
    [
      "development + true + workers.dev",
      "development",
      "true",
      "https://matematica-delicada.proffandreia5.workers.dev",
      false,
    ],
    ["development + true + domínio arbitrário", "development", "true", "https://exemplo.com", false],
  ])("%s -> habilitado? %s", (_label, environment, flag, urlStr, expectedEnabled) => {
    const env = envWith({ ENVIRONMENT: environment, DEV_OUTBOX_ENABLED: flag });
    expect(isDevOutboxAllowed(env, new URL(urlStr))).toBe(expectedEnabled);
  });

  it("X-Forwarded-Host alegando localhost NÃO transforma uma URL remota em local", () => {
    // O header não é consultado em nenhum momento — a função só olha `url`, que
    // é sempre a URL efetivamente recebida pelo Worker (request.url), nunca
    // reconstruída a partir de headers controláveis pelo cliente.
    const env = envWith({ ENVIRONMENT: "development", DEV_OUTBOX_ENABLED: "true" });
    const remoteUrlDespiteHeaderClaim = new URL(
      "https://matematica-delicada.proffandreia5.workers.dev/api/dev/outbox/last"
    );
    // (mesmo que a requisição real trouxesse "X-Forwarded-Host: localhost", a
    // função não olha esse header — só a URL efetivamente recebida)
    expect(isDevOutboxAllowed(env, remoteUrlDespiteHeaderClaim)).toBe(false);
  });
});

describe("shouldOmitSecureCookie — quatro condições obrigatórias", () => {
  it.each([
    ["development + true + http://localhost", "development", "true", "http://localhost:8788", true],
    ["development + true + http://127.0.0.1", "development", "true", "http://127.0.0.1:8788", true],
    ["development + ausente/false + http://localhost", "development", undefined, "http://localhost:8788", false],
    ["test + true + http://localhost", "test", "true", "http://localhost:8788", false],
    ["production + true + http://localhost", "production", "true", "http://localhost:8788", false],
    ["development + true + https://localhost", "development", "true", "https://localhost:8788", false],
    [
      "development + true + https://workers.dev",
      "development",
      "true",
      "https://matematica-delicada.proffandreia5.workers.dev",
      false,
    ],
    ["ausente + true + http://localhost", undefined, "true", "http://localhost:8788", false],
  ])("%s -> omite Secure? %s", (_label, environment, flag, urlStr, expectedOmitSecure) => {
    const env = envWith({ ENVIRONMENT: environment, ALLOW_INSECURE_LOCAL_COOKIE: flag });
    expect(shouldOmitSecureCookie(env, new URL(urlStr))).toBe(expectedOmitSecure);
  });
});

/* Sprint 3 v1.2 — isolamento de rate limit entre arquivos de teste E2E. Mesma
   matriz de falha fechada das outras duas flags: precisa das três condições
   simultaneamente, incluindo em produção (sem a flag em wrangler.jsonc, sem
   ENVIRONMENT=development/test, com hostname público) onde nunca é true. */
describe("isTestRateLimitIsolationAllowed — três condições obrigatórias (ambiente + flag local + hostname)", () => {
  it.each([
    ["development + true + localhost", "development", "true", "http://localhost:8788", true],
    ["test + true + 127.0.0.1", "test", "true", "http://127.0.0.1:8788", true],
    ["development + true + [::1]", "development", "true", "http://[::1]:8788", true],
    ["development + ausente/false + localhost", "development", undefined, "http://localhost:8788", false],
    ["development + \"false\" + localhost", "development", "false", "http://localhost:8788", false],
    ["test + ausente/false + localhost", "test", undefined, "http://localhost:8788", false],
    ["production + true + localhost", "production", "true", "http://localhost:8788", false],
    ["ausente + true + localhost", undefined, "true", "http://localhost:8788", false],
    [
      "development + true + workers.dev",
      "development",
      "true",
      "https://matematica-delicada.proffandreia5.workers.dev",
      false,
    ],
    ["development + true + domínio arbitrário", "development", "true", "https://exemplo.com", false],
  ])("%s -> habilitado? %s", (_label, environment, flag, urlStr, expectedEnabled) => {
    const env = envWith({ ENVIRONMENT: environment, ALLOW_TEST_RATE_LIMIT_ISOLATION: flag });
    expect(isTestRateLimitIsolationAllowed(env, new URL(urlStr))).toBe(expectedEnabled);
  });

  it("produção real (sem a flag, sem ENVIRONMENT local, hostname público) nunca habilita — mesmo com cabeçalho de teste presente na requisição real", () => {
    // Este teste documenta a garantia central da correção v1.2: a função de
    // gate nunca depende do cabeçalho em si (que é só lido depois, em
    // rateLimit.ts, e só SE isTestRateLimitIsolationAllowed já for true).
    const productionEnv = envWith({}); // sem ENVIRONMENT, sem a flag — configuração implantável real
    const productionUrl = new URL("https://matematica-delicada.proffandreia5.workers.dev/api/auth/signup");
    expect(isTestRateLimitIsolationAllowed(productionEnv, productionUrl)).toBe(false);
  });
});

/* Sprint 4 v1.0 — as fixtures do diagnóstico (CONTEÚDO TÉCNICO PROVISÓRIO)
   só podem ser servidas sob as mesmas três condições de falha fechada. */
describe("isLocalDiagnosticFixturesAllowed — três condições obrigatórias (ambiente + flag local + hostname)", () => {
  it.each([
    ["development + true + localhost", "development", "true", "http://localhost:8788", true],
    ["test + true + 127.0.0.1", "test", "true", "http://127.0.0.1:8788", true],
    ["development + true + [::1]", "development", "true", "http://[::1]:8788", true],
    ["development + ausente/false + localhost", "development", undefined, "http://localhost:8788", false],
    ["development + \"false\" + localhost", "development", "false", "http://localhost:8788", false],
    ["test + ausente/false + localhost", "test", undefined, "http://localhost:8788", false],
    ["production + true + localhost", "production", "true", "http://localhost:8788", false],
    ["ausente + true + localhost", undefined, "true", "http://localhost:8788", false],
    [
      "development + true + workers.dev",
      "development",
      "true",
      "https://matematica-delicada.proffandreia5.workers.dev",
      false,
    ],
    ["development + true + domínio arbitrário", "development", "true", "https://exemplo.com", false],
  ])("%s -> habilitado? %s", (_label, environment, flag, urlStr, expectedEnabled) => {
    const env = envWith({ ENVIRONMENT: environment, ENABLE_LOCAL_DIAGNOSTIC_FIXTURES: flag });
    expect(isLocalDiagnosticFixturesAllowed(env, new URL(urlStr))).toBe(expectedEnabled);
  });

  it("produção real (sem a flag, sem ENVIRONMENT local, hostname público) nunca serve conteúdo de fixture", () => {
    const productionEnv = envWith({});
    const productionUrl = new URL("https://matematica-delicada.proffandreia5.workers.dev/api/diagnostic/status");
    expect(isLocalDiagnosticFixturesAllowed(productionEnv, productionUrl)).toBe(false);
  });
});
