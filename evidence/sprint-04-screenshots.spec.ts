import { expect, test, type Page } from "@playwright/test";
import { testClientIdHeader } from "../e2e/rateLimitIsolation";

/* Sprint 4 v1.0, item 13 da ordem — as sete evidências visuais obrigatórias
   do diagnóstico inicial, geradas por automação real (não capturas manuais).
   Mesmo padrão das evidências das sprints anteriores: conta própria por
   teste, dados evidentemente fictícios, isolamento de rate limit por
   cabeçalho (nunca por nome/ordem de arquivo — ver e2e/rateLimitIsolation.ts). */
test.use({ storageState: { cookies: [], origins: [] } });

const TEST_CLIENT_ID_HEADER = testClientIdHeader("sprint-04-screenshots");
const NEXT_YEAR = new Date().getUTCFullYear() + 1;
const FICTITIOUS_PASSWORD = "senha-evidencia-fake-diagnostico-1";

function uniqueFictitiousEmail(): string {
  return `evidencia-sprint4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@evidencia.teste`;
}

async function createConfirmedFictitiousUser(page: Page): Promise<void> {
  const email = uniqueFictitiousEmail();
  await page.request.post("/api/auth/signup", {
    headers: TEST_CLIENT_ID_HEADER,
    data: {
      name: "Aluna Demonstração Sprint4",
      email,
      password: FICTITIOUS_PASSWORD,
      confirmPassword: FICTITIOUS_PASSWORD,
      acceptTerms: true,
    },
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
    data: { email, password: FICTITIOUS_PASSWORD },
  });
  const setCookie = loginResponse.headers()["set-cookie"];
  const tokenValue = setCookie.split(";")[0].split("=").slice(1).join("=");
  await page.context().addCookies([{ name: "md_session", value: tokenValue, domain: "localhost", path: "/" }]);
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

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const hasHorizontalScroll = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );
  expect(hasHorizontalScroll).toBe(false);
}

test.describe("Evidências visuais — Sprint 4 (diagnóstico inicial)", () => {
  test("diagnostico-introducao-desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await createConfirmedFictitiousUser(page);
    await completeOnboarding(page, "agora");
    await page.goto("/diagnostico");

    await expect(page.getByRole("heading", { name: "Vamos conhecer seu ponto de partida" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "evidence/screenshots/sprint-04/diagnostico-introducao-desktop.png" });
  });

  test("diagnostico-questao-com-reconhecimento", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await createConfirmedFictitiousUser(page);
    await completeOnboarding(page, "agora");
    await page.goto("/diagnostico");
    await page.getByRole("button", { name: "Começar diagnóstico" }).click();

    await expect(page.getByText("Questão 1 de 12")).toBeVisible();
    await expect(page.getByText(/qual padrão ou estratégia você reconhece/)).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "evidence/screenshots/sprint-04/diagnostico-questao-com-reconhecimento.png" });
  });

  test("diagnostico-camada-de-ajuda-aberta", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await createConfirmedFictitiousUser(page);
    await completeOnboarding(page, "agora");
    await page.goto("/diagnostico");
    await page.getByRole("button", { name: "Começar diagnóstico" }).click();

    await expect(page.getByText("Questão 1 de 12")).toBeVisible();
    await page.getByRole("button", { name: "Pista leve" }).click();
    await expect(page.getByText(/Pista leve:/)).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "evidence/screenshots/sprint-04/diagnostico-camada-de-ajuda-aberta.png" });
  });

  test("diagnostico-nao-sei-por-onde-comecar", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await createConfirmedFictitiousUser(page);
    await completeOnboarding(page, "agora");
    await page.goto("/diagnostico");
    await page.getByRole("button", { name: "Começar diagnóstico" }).click();

    await expect(page.getByText("Questão 1 de 12")).toBeVisible();
    await page.getByLabel("Não sei por onde começar").check();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "evidence/screenshots/sprint-04/diagnostico-nao-sei-por-onde-comecar.png" });
  });

  test("diagnostico-retomada-de-tentativa", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await createConfirmedFictitiousUser(page);
    await completeOnboarding(page, "agora");
    await page.goto("/diagnostico");
    await page.getByRole("button", { name: "Começar diagnóstico" }).click();

    await expect(page.getByText("Questão 1 de 12")).toBeVisible();
    const firstOption = page.locator('input[name="answer"]').first();
    await firstOption.check();
    await page.getByRole("button", { name: "Avançar" }).click();
    await expect(page.getByText("Questão 2 de 12")).toBeVisible();

    await page.reload();
    await expect(page.getByRole("heading", { name: "Você tem um diagnóstico em andamento" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "evidence/screenshots/sprint-04/diagnostico-retomada-de-tentativa.png" });
  });

  test("diagnostico-resultado-tecnico-provisorio", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await createConfirmedFictitiousUser(page);
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
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "evidence/screenshots/sprint-04/diagnostico-resultado-tecnico-provisorio.png" });
  });

  test("diagnostico-mobile-390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await createConfirmedFictitiousUser(page);
    await completeOnboarding(page, "agora");
    await page.goto("/diagnostico");
    await page.getByRole("button", { name: "Começar diagnóstico" }).click();

    await expect(page.getByText("Questão 1 de 12")).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "evidence/screenshots/sprint-04/diagnostico-mobile-390px.png" });
  });
});
