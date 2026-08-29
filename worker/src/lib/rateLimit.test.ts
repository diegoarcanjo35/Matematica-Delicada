// @vitest-environment node
import { describe, expect, it } from "vitest";
import { clientIdentifier } from "./rateLimit";
import type { Env } from "../env";

/* Sprint 3 v1.2 — prova direta de que o cabeçalho de isolamento de teste
   (X-E2E-RateLimit-Client-Id) só tem efeito quando as três condições de
   isTestRateLimitIsolationAllowed estão satisfeitas, e é sempre ignorado fora
   disso — inclusive quando enviado numa requisição contra o Worker público. */

function envWith(overrides: Partial<Env>): Env {
  return { DB: {} as never, ASSETS: {} as never, ...overrides };
}

function requestWithTestHeader(url: string, testClientId?: string): Request {
  const headers = new Headers();
  if (testClientId) headers.set("X-E2E-RateLimit-Client-Id", testClientId);
  return new Request(url, { headers });
}

describe("clientIdentifier — isolamento de teste condicional (nunca em produção)", () => {
  it("ambiente local com a flag: usa o identificador do cabeçalho de teste, prefixado", () => {
    const env = envWith({ ENVIRONMENT: "development", ALLOW_TEST_RATE_LIMIT_ISOLATION: "true" });
    const url = new URL("http://localhost:8788/api/auth/signup");
    const request = requestWithTestHeader(url.toString(), "arquivo-a");

    expect(clientIdentifier(request, env, url)).toBe("test:arquivo-a");
  });

  it("dois identificadores de teste diferentes produzem identifiers diferentes — é isso que isola os arquivos entre si", () => {
    const env = envWith({ ENVIRONMENT: "development", ALLOW_TEST_RATE_LIMIT_ISOLATION: "true" });
    const url = new URL("http://localhost:8788/api/auth/signup");

    const idA = clientIdentifier(requestWithTestHeader(url.toString(), "arquivo-a"), env, url);
    const idB = clientIdentifier(requestWithTestHeader(url.toString(), "arquivo-b"), env, url);

    expect(idA).not.toBe(idB);
  });

  it("ambiente local com a flag, mas SEM o cabeçalho: cai no fallback normal (local-dev)", () => {
    const env = envWith({ ENVIRONMENT: "development", ALLOW_TEST_RATE_LIMIT_ISOLATION: "true" });
    const url = new URL("http://localhost:8788/api/auth/signup");
    const request = requestWithTestHeader(url.toString());

    expect(clientIdentifier(request, env, url)).toBe("local-dev");
  });

  it("flag ausente (mesmo em ENVIRONMENT=development): cabeçalho de teste é ignorado", () => {
    const env = envWith({ ENVIRONMENT: "development" });
    const url = new URL("http://localhost:8788/api/auth/signup");
    const request = requestWithTestHeader(url.toString(), "arquivo-a");

    expect(clientIdentifier(request, env, url)).toBe("local-dev");
  });

  it("produção real (sem ENVIRONMENT local, sem a flag, hostname público): cabeçalho de teste é sempre ignorado", () => {
    const env = envWith({}); // configuração implantável real — sem ENVIRONMENT, sem a flag
    const url = new URL("https://matematica-delicada.proffandreia5.workers.dev/api/auth/signup");
    const request = requestWithTestHeader(url.toString(), "qualquer-valor-forjado");

    // Sem cf-connecting-ip no teste (Cloudflare real injetaria isso na borda) — cai no fallback,
    // nunca no valor forjado pelo cabeçalho de teste.
    expect(clientIdentifier(request, env, url)).toBe("local-dev");
  });

  it("com o gate satisfeito, o cabeçalho de teste tem prioridade mesmo se cf-connecting-ip também estiver presente", () => {
    const env = envWith({ ENVIRONMENT: "development", ALLOW_TEST_RATE_LIMIT_ISOLATION: "true" });
    const url = new URL("http://localhost:8788/api/auth/signup");
    const headers = new Headers({ "cf-connecting-ip": "203.0.113.5", "X-E2E-RateLimit-Client-Id": "arquivo-a" });
    const request = new Request(url.toString(), { headers });

    // Cenário hipotético (a Cloudflare real nunca injeta cf-connecting-ip em wrangler dev
    // local) — documenta que, com o gate satisfeito, o identificador de teste isola o arquivo
    // independentemente do que mais estiver no cabeçalho.
    expect(clientIdentifier(request, env, url)).toBe("test:arquivo-a");
  });
});
