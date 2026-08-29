import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { testClientIdHeader } from "./rateLimitIsolation";

/* Sprint 3 v1.0 — fluxo completo de onboarding, em Chromium real. Cada teste
   usa uma conta própria, recém-criada e confirmada via API (mesmo padrão de
   e2e/auth-flow.spec.ts), para nunca depender ou interferir no estado do
   usuário fixo de E2E (que já está com onboarding concluído, ver
   e2e/global-setup.ts). */
test.use({ storageState: { cookies: [], origins: [] } });

// APIRequestContext (request/page.request) nunca passa pelo navegador — o
// cabeçalho de isolamento pode ser passado direto, sem risco de vazar para
// requisições cross-origin da própria página (ver e2e/rateLimitIsolation.ts).
const TEST_CLIENT_ID_HEADER = testClientIdHeader("onboarding");

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@teste.dev`;
}

async function createConfirmedUser(request: APIRequestContext, emailPrefix: string): Promise<string> {
  const email = uniqueEmail(emailPrefix);
  const password = "senha-de-teste-onboarding-1";

  await request.post("/api/auth/signup", {
    headers: TEST_CLIENT_ID_HEADER,
    data: { name: "Aluna Onboarding", email, password, confirmPassword: password, acceptTerms: true },
  });

  const outboxResponse = await request.get(
    `/api/dev/outbox/last?to=${encodeURIComponent(email)}&kind=email_confirmation`
  );
  const { email: outboxEmail } = await outboxResponse.json();
  const confirmMatch = outboxEmail.body.match(/token=([^\s]+)/);
  if (confirmMatch) {
    await request.post("/api/auth/email/confirm", { data: { token: confirmMatch[1] } });
  }

  return email;
}

/** Loga via API e injeta o cookie de sessão diretamente no contexto do browser
 *  — evita repetir o formulário de login em cada teste (o formulário em si já
 *  é coberto por e2e/auth-flow.spec.ts). */
async function loginAsFreshUser(page: Page, emailPrefix: string): Promise<string> {
  const email = await createConfirmedUser(page.request, emailPrefix);
  const password = "senha-de-teste-onboarding-1";

  const response = await page.request.post("/api/auth/login", {
    headers: TEST_CLIENT_ID_HEADER,
    data: { email, password },
  });
  expect(response.ok()).toBe(true);

  const setCookie = response.headers()["set-cookie"];
  const tokenValue = setCookie.split(";")[0].split("=").slice(1).join("=");
  await page.context().addCookies([
    { name: "md_session", value: tokenValue, domain: "localhost", path: "/" },
  ]);
  return email;
}

const NEXT_YEAR = new Date().getUTCFullYear() + 1;

test.describe("Onboarding — fluxo completo", () => {
  test("fluxo completo no desktop conclui e vai ao dashboard (diagnóstico depois)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAsFreshUser(page, "onboarding-desktop");
    await page.goto("/");

    // Usuário sem onboarding concluído é redirecionado ao acessar a área do aluno.
    await expect(page.getByRole("heading", { name: "Momento escolar e ENEM" })).toBeVisible();

    await page.getByLabel("Série atual").selectOption("3_serie_em");
    await page.getByLabel("Ano em que fará o ENEM").fill(String(NEXT_YEAR));
    await page.getByRole("button", { name: "Avançar" }).click();

    await expect(page.getByRole("heading", { name: "Meta e ponto atual" })).toBeVisible();
    await page.getByLabel("Quantidade de acertos").check();
    await page.getByLabel(/Meta de acertos/).fill("30");
    await page.getByRole("button", { name: "Avançar" }).click();

    await expect(page.getByRole("heading", { name: "Disponibilidade e rotina" })).toBeVisible();
    await page.getByLabel("Segunda").check();
    await page.getByLabel("Quarta").check();
    await page.getByLabel(/Minutos disponíveis por dia/).fill("60");
    await page.getByRole("button", { name: "Avançar" }).click();

    await expect(page.getByRole("heading", { name: "Dificuldades percebidas" })).toBeVisible();
    await page.getByRole("button", { name: "Avançar" }).click();

    await expect(page.getByRole("heading", { name: "Preferências e acessibilidade" })).toBeVisible();
    await page.getByLabel("Noite").check();
    await page.getByRole("button", { name: "Avançar" }).click();

    await expect(page.getByRole("heading", { name: "Diagnóstico" })).toBeVisible();
    await page.getByLabel("Prefiro fazer depois").check();
    await page.getByRole("button", { name: "Avançar" }).click();

    await expect(page.getByRole("heading", { name: "Revisão e conclusão" })).toBeVisible();
    await expect(page.getByText("30")).toBeVisible();

    await page.getByRole("button", { name: "Concluir onboarding" }).click();

    await expect(page.getByText("Seu Mapa ENEM")).toBeVisible();
    await expect(page.getByText(/30 acertos/)).toBeVisible();
  });

  test("fluxo completo em viewport móvel", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAsFreshUser(page, "onboarding-mobile");
    await page.goto("/onboarding");

    await expect(page.getByRole("heading", { name: "Momento escolar e ENEM" })).toBeVisible();
    const hasHorizontalScroll = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    expect(hasHorizontalScroll).toBe(false);

    await page.getByLabel("Série atual").selectOption("1_serie_em");
    await page.getByLabel("Ano em que fará o ENEM").fill(String(NEXT_YEAR));
    await page.getByRole("button", { name: "Avançar" }).click();
    await expect(page.getByRole("heading", { name: "Meta e ponto atual" })).toBeVisible();
  });

  test("voltar e avançar preservam as respostas já digitadas", async ({ page }) => {
    await loginAsFreshUser(page, "onboarding-voltar");
    await page.goto("/onboarding");

    await page.getByLabel("Série atual").selectOption("2_serie_em");
    await page.getByLabel("Ano em que fará o ENEM").fill(String(NEXT_YEAR));
    await page.getByRole("button", { name: "Avançar" }).click();
    await expect(page.getByRole("heading", { name: "Meta e ponto atual" })).toBeVisible();

    await page.getByRole("button", { name: "Voltar" }).click();
    await expect(page.getByRole("heading", { name: "Momento escolar e ENEM" })).toBeVisible();
    await expect(page.getByLabel("Série atual")).toHaveValue("2_serie_em");
    await expect(page.getByLabel("Ano em que fará o ENEM")).toHaveValue(String(NEXT_YEAR));
  });

  test("refresh da página retoma na etapa salva com os dados persistidos", async ({ page }) => {
    await loginAsFreshUser(page, "onboarding-refresh");
    await page.goto("/onboarding");

    await page.getByLabel("Série atual").selectOption("9_ano_ef");
    await page.getByLabel("Ano em que fará o ENEM").fill(String(NEXT_YEAR));
    await page.getByRole("button", { name: "Avançar" }).click();
    await expect(page.getByRole("heading", { name: "Meta e ponto atual" })).toBeVisible();

    await page.reload();

    await expect(page.getByRole("heading", { name: "Meta e ponto atual" })).toBeVisible();
    await page.getByRole("button", { name: "Voltar" }).click();
    await expect(page.getByLabel("Série atual")).toHaveValue("9_ano_ef");
  });

  test("erros de validação são acessíveis (role=alert) e não avançam a etapa", async ({ page }) => {
    await loginAsFreshUser(page, "onboarding-erro");
    await page.goto("/onboarding");

    await page.getByRole("button", { name: "Avançar" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Momento escolar e ENEM" })).toBeVisible();
  });

  test("navegação por teclado alcança os campos e o botão avançar", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAsFreshUser(page, "onboarding-teclado");
    await page.goto("/onboarding");

    await page.getByLabel("Série atual").focus();
    await expect(page.getByLabel("Série atual")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Ano em que fará o ENEM")).toBeFocused();

    const nextButton = page.getByRole("button", { name: "Avançar" });
    await nextButton.focus();
    await expect(nextButton).toBeFocused();
  });

  test("usuário com onboarding concluído acessando /onboarding é redirecionado ao dashboard", async ({
    page,
  }) => {
    await loginAsFreshUser(page, "onboarding-concluido");
    await page.goto("/onboarding");
    await expect(page.getByRole("heading", { name: "Momento escolar e ENEM" })).toBeVisible();

    // Preenche e conclui rapidamente via API para chegar ao estado "concluído".
    await page.request.patch("/api/onboarding", {
      data: { currentGrade: "3_serie_em", enemYear: NEXT_YEAR, currentStep: 1 },
    });
    await page.request.patch("/api/onboarding", {
      data: { goalType: "nota", goalValue: 700, currentStep: 2 },
    });
    await page.request.patch("/api/onboarding", {
      data: { availableDays: ["ter", "qui"], dailyMinutes: 45, currentStep: 3 },
    });
    await page.request.patch("/api/onboarding", { data: { difficulties: [], currentStep: 4 } });
    await page.request.patch("/api/onboarding", {
      data: { timePreference: "manha", currentStep: 5 },
    });
    await page.request.patch("/api/onboarding", {
      data: { diagnosticChoice: "agora", currentStep: 6 },
    });
    await page.request.post("/api/onboarding/complete");

    await page.goto("/onboarding");
    await expect(page).toHaveURL("/");
  });

  test("escolha de diagnóstico agora direciona para a rota estrutural do diagnóstico", async ({ page }) => {
    await loginAsFreshUser(page, "onboarding-diagnostico-agora");
    await page.goto("/onboarding");

    await page.getByLabel("Série atual").selectOption("3_serie_em");
    await page.getByLabel("Ano em que fará o ENEM").fill(String(NEXT_YEAR));
    await page.getByRole("button", { name: "Avançar" }).click();
    await page.getByLabel("Quantidade de acertos").check();
    await page.getByLabel(/Meta de acertos/).fill("20");
    await page.getByRole("button", { name: "Avançar" }).click();
    await page.getByLabel("Sexta").check();
    await page.getByLabel(/Minutos disponíveis por dia/).fill("30");
    await page.getByRole("button", { name: "Avançar" }).click();
    await page.getByRole("button", { name: "Avançar" }).click();
    await page.getByLabel("Tarde").check();
    await page.getByRole("button", { name: "Avançar" }).click();
    await page.getByLabel("Quero fazer o diagnóstico agora").check();
    await page.getByRole("button", { name: "Avançar" }).click();
    await page.getByRole("button", { name: "Concluir onboarding" }).click();

    await expect(page).toHaveURL("/diagnostico");
    await expect(page.getByRole("heading", { name: "Diagnóstico" })).toBeVisible();
    await expect(page.getByText("Será implementado na próxima sprint.")).toBeVisible();
  });

  test("sem erros no console durante o fluxo de onboarding", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    await loginAsFreshUser(page, "onboarding-console");
    await page.goto("/onboarding");
    await page.getByLabel("Série atual").selectOption("3_serie_em");
    await page.getByLabel("Ano em que fará o ENEM").fill(String(NEXT_YEAR));
    await page.getByRole("button", { name: "Avançar" }).click();
    await expect(page.getByRole("heading", { name: "Meta e ponto atual" })).toBeVisible();

    expect(consoleErrors).toEqual([]);
  });
});
