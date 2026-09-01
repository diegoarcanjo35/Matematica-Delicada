import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/* Sprint 4 v1.0, seção 12 da ordem — prova do estado "indisponível" quando
   as fixtures locais do diagnóstico NÃO estão habilitadas, testada
   diretamente no gate (worker/src/env.ts:isLocalDiagnosticFixturesAllowed)
   através de um servidor `wrangler dev` próprio (porta 8790, banco local
   separado, ver wrangler.local.no-diagnostic.jsonc) — sem desligar
   ENABLE_LOCAL_DIAGNOSTIC_FIXTURES no servidor principal (porta 8793), do
   qual e2e/diagnostic.spec.ts e as evidências da Sprint 4 dependem.

   Este arquivo sobe e derruba seu próprio servidor (em vez de registrá-lo no
   `webServer` global do playwright.config.ts) porque é o único consumidor:
   mantê-lo rodando durante a suíte inteira dobraria a carga de CPU da
   máquina local pela duração toda e causava flakiness por timeout em testes
   sem nenhuma relação com o diagnóstico.

   Sprint 6 v1.0 — wrangler.local.no-diagnostic.jsonc também NÃO define
   ENABLE_LOCAL_PATTERN_FIXTURES, então este mesmo servidor já é o ambiente
   "gate de padrões desligado" exigido pela seção 6.2 da ordem da Sprint 6.
   Os testes de padrões abaixo reaproveitam este servidor em vez de subir um
   terceiro `wrangler dev` (que dobraria de novo o custo da suíte).

   Sprint 8 v1.1 — este arquivo também NÃO define ENABLE_LOCAL_EDITORIAL_FIXTURES,
   o mesmo gate que worker/src/routes/player.ts:handlePlayerRequest reaproveita
   (isLocalEditorialFixturesAllowed, seção 14 da ordem — nenhum gate novo foi
   criado para o Player). Os testes do Player abaixo reaproveitam este mesmo
   servidor pela mesma razão dos padrões acima. */

const BASE_URL = "http://localhost:8790";
const HEALTH_URL = `${BASE_URL}/api/health`;
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

let server: ChildProcess | undefined;

async function waitForHealth(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(HEALTH_URL);
      if (response.ok) return;
    } catch {
      // ainda subindo
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Servidor no-diagnostic não respondeu em ${HEALTH_URL} a tempo.`);
}

function stopServer(): void {
  if (!server?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(server.pid), "/t", "/f"]);
  } else {
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {
      server.kill("SIGKILL");
    }
  }
  server = undefined;
}

test.beforeAll(async () => {
  // O timeout padrão de hook (herdado do timeout de teste em
  // playwright.config.ts) é menor que os 120s que este servidor pode levar
  // pra subir (build + migration + wrangler dev) — sem isto, o hook falha
  // antes de waitForHealth() ter a chance de esperar o tempo todo.
  test.setTimeout(150_000);
  server = spawn("npm run worker:preview:no-diagnostic", {
    cwd: REPO_ROOT,
    shell: true,
    stdio: "ignore",
    detached: process.platform !== "win32",
  });
  await waitForHealth(120_000);
});

test.afterAll(() => {
  stopServer();
});

test.use({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });

const NEXT_YEAR = new Date().getUTCFullYear() + 1;

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@teste.dev`;
}

async function createConfirmedUserWithOnboarding(page: Page, emailPrefix: string): Promise<void> {
  const email = uniqueEmail(emailPrefix);
  const password = "senha-de-teste-diagnostico-gate-1";

  await page.request.post("/api/auth/signup", {
    data: { name: "Aluna Gate", email, password, confirmPassword: password, acceptTerms: true },
  });

  const outboxResponse = await page.request.get(
    `/api/dev/outbox/last?to=${encodeURIComponent(email)}&kind=email_confirmation`
  );
  const { email: outboxEmail } = await outboxResponse.json();
  const confirmMatch = outboxEmail.body.match(/token=([^\s]+)/);
  if (confirmMatch) {
    await page.request.post("/api/auth/email/confirm", { data: { token: confirmMatch[1] } });
  }

  const loginResponse = await page.request.post("/api/auth/login", { data: { email, password } });
  const setCookie = loginResponse.headers()["set-cookie"];
  const tokenValue = setCookie.split(";")[0].split("=").slice(1).join("=");
  await page.context().addCookies([{ name: "md_session", value: tokenValue, domain: "localhost", path: "/" }]);

  await page.request.patch("/api/onboarding", {
    data: { currentGrade: "3_serie_em", enemYear: NEXT_YEAR, currentStep: 1 },
  });
  await page.request.patch("/api/onboarding", { data: { goalType: "acertos", goalValue: 30, currentStep: 2 } });
  await page.request.patch("/api/onboarding", {
    data: { availableDays: ["seg", "qua", "sex"], dailyMinutes: 60, currentStep: 3 },
  });
  await page.request.patch("/api/onboarding", { data: { difficulties: [], currentStep: 4 } });
  await page.request.patch("/api/onboarding", { data: { timePreference: "noite", currentStep: 5 } });
  await page.request.patch("/api/onboarding", { data: { diagnosticChoice: "depois", currentStep: 6 } });
  await page.request.post("/api/onboarding/complete");
}

test.describe("Diagnóstico — gate de indisponibilidade (fixtures locais desligadas)", () => {
  test("GET /api/diagnostic/status responde available:false sem tocar nas tabelas diagnostic_*", async ({ page }) => {
    await createConfirmedUserWithOnboarding(page, "diag-gate-status");
    const response = await page.request.get("/api/diagnostic/status");
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, available: false, activeAttemptId: null, latestCompletedAttemptId: null });
  });

  test("POST /api/diagnostic/attempts responde acolhedor, nunca serve conteúdo", async ({ page }) => {
    await createConfirmedUserWithOnboarding(page, "diag-gate-create");
    const response = await page.request.post("/api/diagnostic/attempts", { data: {} });
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, available: false });
    expect(body.message).toBe("O diagnóstico está em preparação pedagógica.");
  });

  test("/diagnostico renderiza o estado indisponível na UI, não a introdução", async ({ page }) => {
    await createConfirmedUserWithOnboarding(page, "diag-gate-ui");
    await page.goto("/diagnostico");
    await expect(page.getByRole("heading", { name: "Diagnóstico em preparação" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Vamos conhecer seu ponto de partida" })).not.toBeVisible();
  });
});

test.describe("Padrões ENEM — gate de indisponibilidade (fixtures locais desligadas)", () => {
  test("GET /api/patterns responde available:false, sem nenhum padrão", async ({ page }) => {
    await createConfirmedUserWithOnboarding(page, "pad-gate-lista");
    const response = await page.request.get("/api/patterns");
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, available: false });
    expect(body.message).toBe("O catálogo de padrões está em preparação pedagógica.");
    expect(body.patterns).toBeUndefined();
    expect(body.total).toBeUndefined();
  });

  test("GET /api/patterns/:slug e /progress também respondem indisponível, nunca 404/500", async ({ page }) => {
    await createConfirmedUserWithOnboarding(page, "pad-gate-ficha");

    const detail = await page.request.get("/api/patterns/razao-em-grafico");
    expect(detail.status()).toBe(200);
    expect(await detail.json()).toMatchObject({ ok: true, available: false });

    const progress = await page.request.get("/api/patterns/razao-em-grafico/progress");
    expect(progress.status()).toBe(200);
    expect(await progress.json()).toMatchObject({ ok: true, available: false });
  });

  test("/padroes-enem renderiza o estado 'em preparação' na UI, nunca o catálogo", async ({ page }) => {
    await createConfirmedUserWithOnboarding(page, "pad-gate-ui");
    await page.goto("/padroes-enem");
    await expect(page.getByRole("heading", { name: "Padrões ENEM em preparação" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Razão em Gráfico" })).toHaveCount(0);
  });
});

test.describe("Player de Questão — gate de indisponibilidade (fixtures locais desligadas)", () => {
  test("POST /api/player/attempts responde available:false, nunca toca em question_attempts", async ({ page }) => {
    await createConfirmedUserWithOnboarding(page, "player-gate-attempts");
    const response = await page.request.post("/api/player/attempts", { data: { questionId: "fixture-q-04", mode: "learning" } });
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, available: false });
    expect(body.message).toBe("O Player de Questão está em preparação.");
    expect(body.attemptId).toBeUndefined();
  });

  test("/questoes/:id renderiza o estado indisponível na UI, nunca a tela de início real", async ({ page }) => {
    await createConfirmedUserWithOnboarding(page, "player-gate-inicio-ui");
    await page.goto("/questoes/fixture-q-04");
    await page.getByRole("button", { name: "Iniciar" }).click();
    await expect(page.getByRole("heading", { name: "Player de Questão em preparação" })).toBeVisible();
  });

  test("/tentativas/:id renderiza o estado indisponível na UI para qualquer id", async ({ page }) => {
    await createConfirmedUserWithOnboarding(page, "player-gate-tentativa-ui");
    await page.goto("/tentativas/qualquer-id");
    await expect(page.getByRole("heading", { name: "Player de Questão em preparação" })).toBeVisible();
  });
});
