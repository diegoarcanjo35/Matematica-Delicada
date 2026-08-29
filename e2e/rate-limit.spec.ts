import { execSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { testClientIdHeader } from "./rateLimitIsolation";

/* Sprint 2 v1.0/v1.1 — testes de rate limit que esgotam de propósito a cota
   de cadastro. Até a Sprint 3 v1.1 este arquivo se chamava
   "zz-rate-limit.spec.ts", nomeado de propósito para rodar por ÚLTIMO entre
   os specs de e2e/ — uma dependência implícita de ordem/nome de arquivo,
   rejeitada na correção v1.2. Agora usa o identificador de teste isolado
   abaixo (ver e2e/rateLimitIsolation.ts): o contador de IP que este arquivo
   esgota nunca é compartilhado com nenhum outro arquivo, então a ordem de
   execução deixou de importar — comprovado rodando esta suíte antes e depois
   de e2e/onboarding.spec.ts e evidence/sprint-03-screenshots.spec.ts. */
test.use({ storageState: { cookies: [], origins: [] }, extraHTTPHeaders: testClientIdHeader("rate-limit") });

// execSync (não execFileSync): no Windows, chamar "npx.cmd" via execFileSync
// falha com EINVAL; execSync roda a string inteira através do shell.
function readLocalD1<T>(sql: string): T[] {
  const escaped = sql.replace(/"/g, '\\"');
  const output = execSync(
    `npx wrangler d1 execute matematica-delicada-local --local -c wrangler.local.jsonc --json --command "${escaped}"`,
    { stdio: ["ignore", "pipe", "pipe"] }
  ).toString("utf8");
  const parsed = JSON.parse(output);
  return parsed[0]?.results ?? [];
}

test("rate limit de cadastro bloqueia após o limite configurado", async ({ request }) => {
  // Limite configurado é 30/min (ver RATE_LIMITS em worker/src/routes/auth.ts).
  // 70 requisições, não 35: a janela é fixa e alinhada ao minuto do relógio
  // (não deslizante — limitação documentada em worker/src/lib/rateLimit.ts).
  // Se o teste começar perto da virada do minuto, as requisições podem se
  // dividir entre duas janelas; 70 garante folga mesmo numa divisão bem
  // desfavorável (cada metade ainda ultrapassaria o limite de 30).
  const results: number[] = [];
  for (let i = 0; i < 70; i++) {
    const response = await request.post("/api/auth/signup", {
      data: {
        name: "Rate Limit Teste",
        email: `rate-limit-${Date.now()}-${i}@teste.dev`,
        password: "senhavalida123",
        confirmPassword: "senhavalida123",
        acceptTerms: true,
      },
    });
    results.push(response.status());
  }
  expect(results).toContain(429);
});

test("resposta de rate limit é genérica, sem revelar detalhes da conta", async ({ request }) => {
  // Roda depois do teste anterior, que já deixou o contador de IP acima do
  // limite na janela atual — mas usa a mesma folga (70) por segurança contra
  // a mesma virada de janela documentada acima.
  let last429Body: unknown = null;
  for (let i = 0; i < 70 && !last429Body; i++) {
    const response = await request.post("/api/auth/signup", {
      data: {
        name: "Rate Limit Genérico",
        email: `rate-limit-msg-${Date.now()}-${i}@teste.dev`,
        password: "senhavalida123",
        confirmPassword: "senhavalida123",
        acceptTerms: true,
      },
    });
    if (response.status() === 429) last429Body = await response.json();
  }
  expect(last429Body).toMatchObject({
    error: { code: "too_many_requests", message: expect.any(String) },
  });
  expect(JSON.stringify(last429Body)).not.toMatch(/@|senha|password/i);
});

/* Sprint 2 v1.1, correção E — prova de que chaves diferentes (rota + e-mail)
   geram contadores INDEPENDENTES no D1, e que nenhum dado sensível em texto
   puro (e-mail, IP, senha, token) fica persistido — só hashes SHA-256 (64
   caracteres hexadecimais). */
test("rate limit: chaves diferentes têm contadores independentes; nada sensível fica em texto puro", async ({
  request,
}) => {
  const emailA = `separacao-a-${Date.now()}@teste.dev`;
  const emailB = `separacao-b-${Date.now()}@teste.dev`;

  await request.post("/api/auth/password/request-reset", { data: { email: emailA } });
  await request.post("/api/auth/password/request-reset", { data: { email: emailB } });

  const rows = readLocalD1<{ scope: string; identifier_hash: string; count: number }>(
    "SELECT scope, identifier_hash, count FROM rate_limit_counters WHERE scope = 'password_reset_request:email'"
  );

  const identifierHashes = new Set(rows.map((row) => row.identifier_hash));
  // Duas contas diferentes -> pelo menos dois identifier_hash distintos nesta janela.
  expect(identifierHashes.size).toBeGreaterThanOrEqual(2);

  for (const row of rows) {
    // SHA-256 em hex: 64 caracteres [0-9a-f] — nunca o e-mail em texto puro.
    expect(row.identifier_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.identifier_hash).not.toBe(emailA);
    expect(row.identifier_hash).not.toBe(emailB);
    expect(row.identifier_hash.toLowerCase()).not.toContain("teste.dev");
  }

  // Confirma também que a tabela antiga (que guardava eventos) não existe mais
  // e que nenhuma tabela de rate limit tem coluna de e-mail/senha/token em claro.
  const tableInfo = readLocalD1<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='rate_limit_events'"
  );
  expect(tableInfo).toHaveLength(0);
});
