import { expect, test, type Page } from "@playwright/test";
import { testClientIdHeader } from "./rateLimitIsolation";

/* Sprint 4 v1.0 — fluxo completo do diagnóstico inicial, em Chromium real.
   Cada teste usa uma conta própria (mesmo padrão de e2e/onboarding.spec.ts),
   isolada do rate limit por cabeçalho (nunca por nome/ordem de arquivo — ver
   e2e/rateLimitIsolation.ts). */
test.use({ storageState: { cookies: [], origins: [] } });

const TEST_CLIENT_ID_HEADER = testClientIdHeader("diagnostic");
const NEXT_YEAR = new Date().getUTCFullYear() + 1;

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@teste.dev`;
}

async function createConfirmedUser(page: Page, emailPrefix: string): Promise<string> {
  const email = uniqueEmail(emailPrefix);
  const password = "senha-de-teste-diagnostico-1";

  await page.request.post("/api/auth/signup", {
    headers: TEST_CLIENT_ID_HEADER,
    data: { name: "Aluna Diagnóstico", email, password, confirmPassword: password, acceptTerms: true },
  });

  const outboxResponse = await page.request.get(
    `/api/dev/outbox/last?to=${encodeURIComponent(email)}&kind=email_confirmation`
  );
  const { email: outboxEmail } = await outboxResponse.json();
  const confirmMatch = outboxEmail.body.match(/token=([^\s]+)/);
  if (confirmMatch) {
    await page.request.post("/api/auth/email/confirm", { data: { token: confirmMatch[1] } });
  }

  const loginResponse = await page.request.post("/api/auth/login", {
    headers: TEST_CLIENT_ID_HEADER,
    data: { email, password },
  });
  const setCookie = loginResponse.headers()["set-cookie"];
  const tokenValue = setCookie.split(";")[0].split("=").slice(1).join("=");
  await page.context().addCookies([{ name: "md_session", value: tokenValue, domain: "localhost", path: "/" }]);
  return email;
}

async function completeOnboarding(page: Page, diagnosticChoice: "agora" | "depois"): Promise<void> {
  await page.request.patch("/api/onboarding", {
    data: { currentGrade: "3_serie_em", enemYear: NEXT_YEAR, currentStep: 1 },
  });
  await page.request.patch("/api/onboarding", { data: { goalType: "acertos", goalValue: 30, currentStep: 2 } });
  await page.request.patch("/api/onboarding", {
    data: { availableDays: ["seg", "qua", "sex"], dailyMinutes: 60, currentStep: 3 },
  });
  await page.request.patch("/api/onboarding", { data: { difficulties: [], currentStep: 4 } });
  await page.request.patch("/api/onboarding", { data: { timePreference: "noite", currentStep: 5 } });
  await page.request.patch("/api/onboarding", { data: { diagnosticChoice, currentStep: 6 } });
  await page.request.post("/api/onboarding/complete");
}

test.describe("Diagnóstico — fluxo completo", () => {
  test("iniciar pelo onboarding com escolha 'agora' leva direto ao diagnóstico", async ({ page }) => {
    await createConfirmedUser(page, "diag-onboarding-agora");
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
    await expect(page.getByRole("heading", { name: "Vamos conhecer seu ponto de partida" })).toBeVisible();
  });

  test("iniciar pelo CTA do dashboard quando escolhido 'depois'", async ({ page }) => {
    await createConfirmedUser(page, "diag-cta-dashboard");
    await completeOnboarding(page, "depois");
    await page.goto("/");
    await expect(page.getByText("Você optou por fazer o diagnóstico depois.")).toBeVisible();
    await page.getByRole("link", { name: "Fazer o diagnóstico agora" }).click();
    await expect(page).toHaveURL("/diagnostico");
    await expect(page.getByRole("heading", { name: "Vamos conhecer seu ponto de partida" })).toBeVisible();
  });

  test("responder, usar 'não sei', abrir ajudas, atualizar e retomar", async ({ page }) => {
    await createConfirmedUser(page, "diag-responder-retomar");
    await completeOnboarding(page, "agora");
    await page.goto("/diagnostico");
    await page.getByRole("button", { name: "Começar diagnóstico" }).click();

    await expect(page.getByText("Questão 1 de 12")).toBeVisible();
    await page.getByLabel("2/5").check();
    await page.getByRole("button", { name: "Pista leve" }).click();
    await expect(page.getByText(/Pista:/)).toBeVisible();
    await page.getByRole("button", { name: "Avançar" }).click();

    await expect(page.getByText("Questão 2 de 12")).toBeVisible();
    await page.getByLabel("Não sei por onde começar").check();
    await page.getByRole("button", { name: "Avançar" }).click();

    await expect(page.getByText("Questão 3 de 12")).toBeVisible();

    // Atualiza a página — oferece "Continuar diagnóstico" (seção 5.1 da
    // ordem: retomada nunca é silenciosa), que leva de volta exatamente à
    // questão 3.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Você tem um diagnóstico em andamento" })).toBeVisible();
    await page.getByRole("button", { name: "Continuar diagnóstico" }).click();
    await expect(page.getByText("Questão 3 de 12")).toBeVisible();
  });

  test("concluir as 12 questões e visualizar o resultado", async ({ page }) => {
    await createConfirmedUser(page, "diag-concluir");
    await completeOnboarding(page, "agora");
    await page.goto("/diagnostico");
    await page.getByRole("button", { name: "Começar diagnóstico" }).click();

    for (let i = 0; i < 12; i++) {
      await expect(page.getByText(`Questão ${i + 1} de 12`)).toBeVisible();
      const firstOption = page.locator('input[name="answer"]').first();
      await firstOption.check();
      const buttonName = i === 11 ? "Concluir diagnóstico" : "Avançar";
      await page.getByRole("button", { name: buttonName }).click();
    }

    await expect(page.getByRole("heading", { name: "Resultado técnico provisório" })).toBeVisible();
    await expect(page.getByText("Questões respondidas: 12 de 12")).toBeVisible();
    await expect(page.getByText(/Resultado técnico provisório para validação do sistema/)).toBeVisible();
  });

  test("navegação por teclado e foco entre etapas", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await createConfirmedUser(page, "diag-teclado");
    await completeOnboarding(page, "agora");
    await page.goto("/diagnostico");
    await page.getByRole("button", { name: "Começar diagnóstico" }).click();

    await expect(page.locator(".diagnostic__question-prompt")).toBeFocused();
    const firstOption = page.locator('input[name="answer"]').first();
    await firstOption.focus();
    await expect(firstOption).toBeFocused();
  });

  test("mobile 390px sem rolagem horizontal", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await createConfirmedUser(page, "diag-mobile");
    await completeOnboarding(page, "agora");
    await page.goto("/diagnostico");
    await page.getByRole("button", { name: "Começar diagnóstico" }).click();
    await expect(page.getByText("Questão 1 de 12")).toBeVisible();

    const hasHorizontalScroll = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    expect(hasHorizontalScroll).toBe(false);
  });

  test("tentativa concluída não é editável — API rejeita nova resposta", async ({ page }) => {
    await createConfirmedUser(page, "diag-imutavel");
    await completeOnboarding(page, "agora");

    const statusResponse = await page.request.get("/api/diagnostic/status");
    expect((await statusResponse.json()).available).toBe(true);

    const createResponse = await page.request.post("/api/diagnostic/attempts", { data: {} });
    const { attemptId } = await createResponse.json();
    const attemptResponse = await page.request.get(`/api/diagnostic/attempts/${attemptId}`);
    const { attempt } = await attemptResponse.json();

    for (const question of attempt.questions) {
      await page.request.patch(`/api/diagnostic/attempts/${attemptId}/responses/${question.id}`, {
        data: { optionId: question.options[0].id },
      });
    }
    await page.request.post(`/api/diagnostic/attempts/${attemptId}/complete`);

    const blockedResponse = await page.request.patch(
      `/api/diagnostic/attempts/${attemptId}/responses/${attempt.questions[0].id}`,
      { data: { optionId: attempt.questions[0].options[1].id } }
    );
    expect(blockedResponse.status()).toBe(404);
  });

  test("acesso à tentativa de outro usuário é bloqueado", async ({ page, browser }) => {
    await createConfirmedUser(page, "diag-isolamento-a");
    await completeOnboarding(page, "agora");
    const createResponse = await page.request.post("/api/diagnostic/attempts", { data: {} });
    const { attemptId } = await createResponse.json();

    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    await createConfirmedUser(otherPage, "diag-isolamento-b");
    await completeOnboarding(otherPage, "agora");

    const blockedResponse = await otherPage.request.get(`/api/diagnostic/attempts/${attemptId}`);
    expect(blockedResponse.status()).toBe(404);

    await otherContext.close();
  });

  test("reinício exige confirmação explícita — cancelar preserva a tentativa; confirmar cria uma nova sem herdar respostas", async ({
    page,
  }) => {
    await createConfirmedUser(page, "diag-reiniciar");
    await completeOnboarding(page, "agora");
    await page.goto("/diagnostico");
    await page.getByRole("button", { name: "Começar diagnóstico" }).click();

    await expect(page.getByText("Questão 1 de 12")).toBeVisible();
    const firstOption = page.locator('input[name="answer"]').first();
    await firstOption.check();
    await page.getByRole("button", { name: "Avançar" }).click();
    await expect(page.getByText("Questão 2 de 12")).toBeVisible();

    const statusBeforeCancel = await page.request.get("/api/diagnostic/status");
    const { activeAttemptId: attemptIdBeforeCancel } = await statusBeforeCancel.json();

    await page.reload();
    await expect(page.getByRole("heading", { name: "Você tem um diagnóstico em andamento" })).toBeVisible();

    // Abrir o modal e cancelar não reinicia nada — a tentativa original
    // continua ativa, com a resposta já dada preservada.
    await page.getByRole("button", { name: "Reiniciar diagnóstico" }).click();
    await expect(page.getByRole("heading", { name: "Reiniciar diagnóstico?" })).toBeVisible();
    await page.getByRole("button", { name: "Cancelar" }).click();

    const statusAfterCancel = await page.request.get("/api/diagnostic/status");
    const { activeAttemptId: attemptIdAfterCancel } = await statusAfterCancel.json();
    expect(attemptIdAfterCancel).toBe(attemptIdBeforeCancel);

    await page.getByRole("button", { name: "Continuar diagnóstico" }).click();
    await expect(page.getByText("Questão 2 de 12")).toBeVisible();

    // Confirmando o reinício: nova tentativa, sem a resposta de q1 herdada.
    await page.reload();
    await page.getByRole("button", { name: "Reiniciar diagnóstico" }).click();
    const restartDialog = page.getByRole("dialog", { name: "Reiniciar diagnóstico?" });
    await expect(restartDialog).toBeVisible();
    await restartDialog.getByRole("button", { name: "Reiniciar", exact: true }).click();

    await expect(page.getByText("Questão 1 de 12")).toBeVisible();
    const statusAfterRestart = await page.request.get("/api/diagnostic/status");
    const { activeAttemptId: attemptIdAfterRestart } = await statusAfterRestart.json();
    expect(attemptIdAfterRestart).not.toBe(attemptIdBeforeCancel);
  });

  test("sem erros no console durante o fluxo do diagnóstico", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    await createConfirmedUser(page, "diag-console");
    await completeOnboarding(page, "agora");
    await page.goto("/diagnostico");
    await page.getByRole("button", { name: "Começar diagnóstico" }).click();
    await expect(page.getByText("Questão 1 de 12")).toBeVisible();
    const firstOption = page.locator('input[name="answer"]').first();
    await firstOption.check();
    await page.getByRole("button", { name: "Avançar" }).click();
    await expect(page.getByText("Questão 2 de 12")).toBeVisible();

    expect(consoleErrors).toEqual([]);
  });
});
