import { expect, test, type Page } from "@playwright/test";
import { testClientIdHeader } from "../e2e/rateLimitIsolation";

/* Sprint 6 v1.0, seção 7 da ordem — as NOVE evidências visuais obrigatórias
   do catálogo e da ficha de padrões ENEM, geradas por automação real. Mesmo
   padrão das evidências das sprints anteriores: conta própria por teste,
   dados evidentemente fictícios e provisórios, sem nenhuma credencial
   visível, isolamento de rate limit por cabeçalho. */
test.use({ storageState: { cookies: [], origins: [] } });

const TEST_CLIENT_ID_HEADER = testClientIdHeader("sprint-06-screenshots");
const NEXT_YEAR = new Date().getUTCFullYear() + 1;
const FICTITIOUS_PASSWORD = "senha-evidencia-fake-padroes-1";
const SHOTS_DIR = "evidence/screenshots/sprint-06";

function uniqueFictitiousEmail(): string {
  return `evidencia-sprint6-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@evidencia.teste`;
}

async function createConfirmedFictitiousUser(page: Page): Promise<void> {
  const email = uniqueFictitiousEmail();
  await page.request.post("/api/auth/signup", {
    headers: TEST_CLIENT_ID_HEADER,
    data: {
      name: "Aluna Demonstração Sprint6",
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

async function completeOnboarding(page: Page): Promise<void> {
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

async function fictitiousStudent(page: Page): Promise<void> {
  await createConfirmedFictitiousUser(page);
  await completeOnboarding(page);
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const hasHorizontalScroll = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );
  expect(hasHorizontalScroll).toBe(false);
}

test.describe("Evidências visuais — Sprint 6 (padrões ENEM)", () => {
  test("padroes-catalogo-desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await fictitiousStudent(page);
    await page.goto("/padroes-enem");

    await expect(page.getByRole("heading", { name: "Padrões ENEM", level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: "Razão em Gráfico" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: `${SHOTS_DIR}/padroes-catalogo-desktop.png` });
  });

  test("padroes-catalogo-mobile-390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await fictitiousStudent(page);
    await page.goto("/padroes-enem");

    await expect(page.getByRole("heading", { name: "Padrões ENEM", level: 1 })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: `${SHOTS_DIR}/padroes-catalogo-mobile-390px.png` });
  });

  test("padroes-busca-filtros", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await fictitiousStudent(page);
    await page.goto("/padroes-enem");

    await page.getByLabel("Buscar padrão", { exact: true }).fill("Razão");
    await page.getByRole("button", { name: "Buscar" }).click();
    await expect(page).toHaveURL(/busca=Raz/);
    await page.getByLabel("Tag", { exact: true }).selectOption("proporcionalidade");
    await expect(page).toHaveURL(/tag=proporcionalidade/);
    await expect(page.locator(".patterns__results-count")).toContainText(/encontrad/);
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: `${SHOTS_DIR}/padroes-busca-filtros.png` });
  });

  test("padroes-estado-vazio", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await fictitiousStudent(page);
    await page.goto("/padroes-enem?busca=padrao-inexistente-de-demonstracao");

    await expect(page.getByText("Nenhum padrão encontrado", { exact: true })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: `${SHOTS_DIR}/padroes-estado-vazio.png` });
  });

  test("padrao-ficha-desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await fictitiousStudent(page);
    await page.goto("/padroes-enem/razao-em-grafico");

    await expect(page.getByRole("heading", { name: "Razão em Gráfico", level: 1 })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: `${SHOTS_DIR}/padrao-ficha-desktop.png`, fullPage: true });
  });

  test("padrao-ficha-mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await fictitiousStudent(page);
    await page.goto("/padroes-enem/razao-em-grafico");

    await expect(page.getByRole("heading", { name: "Razão em Gráfico", level: 1 })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: `${SHOTS_DIR}/padrao-ficha-mobile.png` });
  });

  test("padrao-indices-sem-evidencias", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await fictitiousStudent(page);
    await page.goto("/padroes-enem/escala");

    const heading = page.getByRole("heading", { name: "Seu progresso neste padrão" });
    await heading.scrollIntoViewIfNeeded();
    await expect(heading).toBeVisible();
    const indices = page.locator(".patterns__index-value");
    await expect(indices).toHaveCount(3);
    for (const text of await indices.allInnerTexts()) {
      expect(text.trim()).toBe("Ainda sem evidências suficientes");
    }
    await page.screenshot({ path: `${SHOTS_DIR}/padrao-indices-sem-evidencias.png` });
  });

  test("padrao-treino-em-preparacao", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await fictitiousStudent(page);
    await page.goto("/padroes-enem/escala");

    const heading = page.getByRole("heading", { name: "Treinar este padrão" });
    await heading.scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: /Treinar este padrão/ })).toBeDisabled();
    await expect(page.getByText("Conteúdo relacionado em preparação.")).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/padrao-treino-em-preparacao.png` });
  });

  test("dashboard-cta-conhecer-padroes", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await fictitiousStudent(page);
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Padrões ENEM" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Conhecer os padrões" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: `${SHOTS_DIR}/dashboard-cta-conhecer-padroes.png` });
  });
});
