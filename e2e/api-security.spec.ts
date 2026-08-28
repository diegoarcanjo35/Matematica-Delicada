import { execSync } from "node:child_process";
import { expect, test } from "@playwright/test";

/* Sprint 2 v1.0/v1.1 — segurança da API, testada diretamente (sem UI). */
test.use({ storageState: { cookies: [], origins: [] } });

/** Executa SQL diretamente no D1 local (mesmo arquivo que o Worker em teste usa),
 *  só para manipular estado que a própria API não expõe (ex.: forçar expiração
 *  de sessão) — nunca usado para ler/gravar segredo, só para orquestrar o teste.
 *  execSync (não execFileSync) — no Windows, chamar "npx.cmd" via execFileSync
 *  falha com EINVAL; execSync roda a string inteira através do shell. */
function execLocalD1(sql: string): void {
  const escaped = sql.replace(/"/g, '\\"');
  execSync(
    `npx wrangler d1 execute matematica-delicada-local --local -c wrangler.local.jsonc --command "${escaped}"`,
    { stdio: "pipe" }
  );
}

function extractSessionCookie(setCookieHeader: string | undefined): string {
  if (!setCookieHeader) throw new Error("Resposta de login não retornou Set-Cookie.");
  return setCookieHeader.split(";")[0];
}

test("endpoint de saúde responde 200", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ ok: true, service: "matematica-delicada-api" });
});

test("rota de API inexistente responde 404, não 500", async ({ request }) => {
  const response = await request.get("/api/rota-que-nao-existe");
  expect(response.status()).toBe(404);
});

test("mutação com Origin diferente é recusada com 403", async ({ request }) => {
  const response = await request.post("/api/auth/login", {
    headers: { Origin: "https://site-malicioso.example.com" },
    data: { email: "qualquer@teste.dev", password: "qualquercoisa123" },
  });
  expect(response.status()).toBe(403);
});

test("JSON malformado não derruba o Worker — responde 400 com erro tratado", async ({ request }) => {
  const response = await request.post("/api/auth/login", {
    headers: { "Content-Type": "application/json" },
    data: "isto não é json válido {{{",
  });
  expect(response.status()).toBe(400);
  const body = await response.json();
  expect(body.error).toBeDefined();
  expect(body.error.message).not.toContain("at ");
  expect(JSON.stringify(body)).not.toMatch(/\.(ts|js):\d+/);
});

test("resposta de erro nunca expõe stack trace", async ({ request }) => {
  const response = await request.post("/api/auth/signup", {
    data: { name: "A", email: "invalido", password: "curta" },
  });
  const body = await response.json();
  expect(JSON.stringify(body)).not.toContain("at Object");
  expect(JSON.stringify(body)).not.toContain(".ts:");
});

test("sessão inexistente/expirada responde 401 em vez de vazar informação", async ({ request }) => {
  const response = await request.get("/api/auth/session", {
    headers: { Cookie: "md_session=token-que-nunca-existiu" },
  });
  expect(response.status()).toBe(401);
});

/* Sprint 2 v1.1, correção F — prova objetiva de que a proteção é do Worker, não
   da SPA: acesso direto à API privada (/api/auth/session) sem passar por
   nenhuma tela React, cobrindo sessão ausente, inválida, expirada, revogada e
   válida. Uma página estática carregável não é autorização — só a validação
   de sessão no servidor é. */
test.describe("Proteção real da API privada (sem sessão válida no servidor)", () => {
  test("sessão ausente -> 401", async ({ request }) => {
    const response = await request.get("/api/auth/session");
    expect(response.status()).toBe(401);
  });

  test("cookie presente mas inválido/adulterado -> 401", async ({ request }) => {
    const response = await request.get("/api/auth/session", {
      headers: { Cookie: "md_session=cookie-forjado-nao-existe-no-banco" },
    });
    expect(response.status()).toBe(401);
  });

  test("sessão válida -> 200 com dados do usuário", async ({ request }) => {
    const email = `protecao-valida-${Date.now()}@teste.dev`;
    await request.post("/api/auth/signup", {
      data: { name: "Proteção Válida", email, password: "senhavalida123", confirmPassword: "senhavalida123", acceptTerms: true },
    });
    const loginResponse = await request.post("/api/auth/login", {
      data: { email, password: "senhavalida123" },
    });
    const cookie = extractSessionCookie(loginResponse.headers()["set-cookie"]);

    const sessionResponse = await request.get("/api/auth/session", { headers: { Cookie: cookie } });
    expect(sessionResponse.status()).toBe(200);
    const body = await sessionResponse.json();
    expect(body.user.email).toBe(email);
  });

  test("sessão revogada por logout -> 401 mesmo com o cookie original", async ({ request }) => {
    const email = `protecao-revogada-${Date.now()}@teste.dev`;
    await request.post("/api/auth/signup", {
      data: { name: "Proteção Revogada", email, password: "senhavalida123", confirmPassword: "senhavalida123", acceptTerms: true },
    });
    const loginResponse = await request.post("/api/auth/login", {
      data: { email, password: "senhavalida123" },
    });
    const cookie = extractSessionCookie(loginResponse.headers()["set-cookie"]);

    await request.post("/api/auth/logout", { headers: { Cookie: cookie } });

    const sessionResponse = await request.get("/api/auth/session", { headers: { Cookie: cookie } });
    expect(sessionResponse.status()).toBe(401);
  });

  test("sessão expirada no servidor -> 401 mesmo com o cookie original", async ({ request }) => {
    const email = `protecao-expirada-${Date.now()}@teste.dev`;
    await request.post("/api/auth/signup", {
      data: { name: "Proteção Expirada", email, password: "senhavalida123", confirmPassword: "senhavalida123", acceptTerms: true },
    });
    const loginResponse = await request.post("/api/auth/login", {
      data: { email, password: "senhavalida123" },
    });
    const cookie = extractSessionCookie(loginResponse.headers()["set-cookie"]);

    // Força a expiração diretamente no D1 local — a API não expõe nenhum jeito
    // de fazer isso, então manipulamos o banco só para orquestrar o teste.
    execLocalD1(
      `UPDATE sessions SET expires_at = datetime('now','-1 hour') WHERE user_id = (SELECT id FROM users WHERE email_normalized = '${email}')`
    );

    const sessionResponse = await request.get("/api/auth/session", { headers: { Cookie: cookie } });
    expect(sessionResponse.status()).toBe(401);
  });
});
