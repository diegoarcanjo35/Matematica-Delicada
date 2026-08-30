import { expect, test, type Page } from "@playwright/test";
import { testClientIdHeader } from "../e2e/rateLimitIsolation";

/* Sprint 5 v1.0, item 17 da ordem — as nove evidências visuais obrigatórias
   do cronograma adaptativo, geradas por automação real. Mesmo padrão das
   evidências das sprints anteriores: conta própria por teste, dados
   evidentemente fictícios, isolamento de rate limit por cabeçalho. */
test.use({ storageState: { cookies: [], origins: [] } });

const TEST_CLIENT_ID_HEADER = testClientIdHeader("sprint-05-screenshots");
const NEXT_YEAR = new Date().getUTCFullYear() + 1;
const FICTITIOUS_PASSWORD = "senha-evidencia-fake-cronograma-1";

function uniqueFictitiousEmail(): string {
  return `evidencia-sprint5-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@evidencia.teste`;
}

async function createConfirmedFictitiousUser(page: Page): Promise<void> {
  const email = uniqueFictitiousEmail();
  await page.request.post("/api/auth/signup", {
    headers: TEST_CLIENT_ID_HEADER,
    data: {
      name: "Aluna Demonstração Sprint5",
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
    data: { availableDays: ["seg", "ter", "qua", "qui", "sex", "sab", "dom"], dailyMinutes: 240, currentStep: 3 },
  });
  await page.request.patch("/api/onboarding", { data: { difficulties: [], currentStep: 4 } });
  await page.request.patch("/api/onboarding", { data: { timePreference: "noite", currentStep: 5 } });
  await page.request.patch("/api/onboarding", { data: { diagnosticChoice: "depois", currentStep: 6 } });
  await page.request.post("/api/onboarding/complete");
}

async function applyPlan(page: Page): Promise<void> {
  // Correção v1.1: nenhum GET cria nada — a prévia já descobre sozinha as
  // fixtures ainda não atribuídas a este usuário; aplicar é o único passo
  // que de fato persiste atribuições.
  const previewResponse = await page.request.post("/api/schedule/plan/preview");
  const preview = await previewResponse.json();
  await page.request.post("/api/schedule/plan/apply", { data: { previewId: preview.previewId } });
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const hasHorizontalScroll = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );
  expect(hasHorizontalScroll).toBe(false);
}

test.describe("Evidências visuais — Sprint 5 (cronograma adaptativo)", () => {
  test("cronograma-hoje-desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await createConfirmedFictitiousUser(page);
    await completeOnboarding(page);
    await applyPlan(page);
    await page.goto("/cronograma");

    await expect(page.getByRole("heading", { name: "Cronograma" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "evidence/screenshots/sprint-05/cronograma-hoje-desktop.png" });
  });

  test("cronograma-visao-semana", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await createConfirmedFictitiousUser(page);
    await completeOnboarding(page);
    await applyPlan(page);
    await page.goto("/cronograma?view=week");

    await expect(page.getByRole("button", { name: "Semana" })).toHaveAttribute("aria-current", "page");
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "evidence/screenshots/sprint-05/cronograma-visao-semana.png" });
  });

  test("cronograma-calendario-mensal", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await createConfirmedFictitiousUser(page);
    await completeOnboarding(page);
    await applyPlan(page);
    await page.goto("/cronograma?view=month");

    await expect(page.getByRole("button", { name: "Mês", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("grid")).toBeVisible();
    await expect(page.locator('[aria-current="date"]').first()).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "evidence/screenshots/sprint-05/cronograma-calendario-mensal.png" });
  });

  test("cronograma-pendencias", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await createConfirmedFictitiousUser(page);
    await completeOnboarding(page);
    await page.goto("/cronograma?view=pending");

    await expect(page.getByRole("heading", { name: "Planejar atividades pendentes" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "evidence/screenshots/sprint-05/cronograma-pendencias.png" });
  });

  test("cronograma-detalhe-por-que-esta-atividade", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await createConfirmedFictitiousUser(page);
    await completeOnboarding(page);
    await applyPlan(page);
    await page.goto("/cronograma?view=today");
    await expect(page.locator(".schedule__grid .schedule__card").first()).toBeVisible();

    await page.locator(".schedule__why-link").first().click();
    await expect(page.getByText(/demonstração técnica/i)).toBeVisible();
    await page.screenshot({ path: "evidence/screenshots/sprint-05/cronograma-detalhe-por-que-esta-atividade.png" });
  });

  test("cronograma-modal-reagendamento", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await createConfirmedFictitiousUser(page);
    await completeOnboarding(page);
    await applyPlan(page);
    await page.goto("/cronograma?view=today");

    const firstCard = page.locator(".schedule__grid .schedule__card").first();
    await expect(firstCard).toBeVisible();
    await firstCard.getByRole("button", { name: "Reagendar" }).click();
    await expect(page.getByRole("heading", { name: "Reagendar atividade?" })).toBeVisible();
    await page.screenshot({ path: "evidence/screenshots/sprint-05/cronograma-modal-reagendamento.png" });
  });

  test("cronograma-historico-concluido", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await createConfirmedFictitiousUser(page);
    await completeOnboarding(page);
    await applyPlan(page);
    await page.goto("/cronograma?view=today");

    const firstCard = page.locator(".schedule__grid .schedule__card").first();
    const completeButton = firstCard.getByRole("button", { name: "Concluir" });
    if (await completeButton.isVisible()) {
      await completeButton.click();
    } else {
      await firstCard.getByRole("button", { name: "Dispensar" }).click();
    }
    await page.goto("/cronograma?view=history");
    await expect(page.getByRole("button", { name: "Histórico" })).toHaveAttribute("aria-current", "page");
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "evidence/screenshots/sprint-05/cronograma-historico-concluido.png" });
  });

  test("cronograma-mobile-390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await createConfirmedFictitiousUser(page);
    await completeOnboarding(page);
    await applyPlan(page);
    await page.goto("/cronograma");

    await expect(page.getByRole("heading", { name: "Cronograma" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "evidence/screenshots/sprint-05/cronograma-mobile-390px.png" });
  });

  test("dashboard-resumo-real-da-agenda", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await createConfirmedFictitiousUser(page);
    await completeOnboarding(page);
    await applyPlan(page);
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Cronograma" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "evidence/screenshots/sprint-05/dashboard-resumo-real-da-agenda.png" });
  });
});
