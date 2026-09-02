import { expect, test, type Page } from "@playwright/test";
import { testClientIdHeader } from "../e2e/rateLimitIsolation";

/* Sprint 11 v1.0, seção 17 da ordem — as DEZ evidências visuais
   obrigatórias do Treino Diário Real e Listas Adaptativas, geradas por
   automação real. Mesmo padrão das evidências das sprints anteriores (ver
   evidence/sprint-10-screenshots.spec.ts): conta própria por teste, dados
   evidentemente fictícios/fixture do seed local, sem nenhum dado sensível
   visível, isolamento de rate limit por cabeçalho.

   Único padrão publicado com questão treinável no seed local:
   fixture-pat-04 ("Mediana e Frequência"), com fixture-q-04 (gabarito C) —
   mesma fixture usada pelas Sprints 9/10. Um aluno recém-cadastrado cai na
   camada de exploração (seção 7 da ordem) e recebe exatamente 1 questão. */
test.use({ storageState: { cookies: [], origins: [] } });

const TEST_CLIENT_ID_HEADER = testClientIdHeader("sprint-11-screenshots");
const NEXT_YEAR = new Date().getUTCFullYear() + 1;
const SHOTS_DIR = "evidence/screenshots/sprint-11";
const CORRECT_ALTERNATIVE_LABEL = /Valor Z/; // fixture-q-04, alternativa C

function uniqueEmail(prefix: string): string {
  return `evidencia-sprint11-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@evidencia.teste`;
}

async function createConfirmedUser(page: Page, prefix: string): Promise<void> {
  const email = uniqueEmail(prefix);
  const password = "senha-evidencia-fake-treino-diario-1";

  await page.request.post("/api/auth/signup", {
    headers: TEST_CLIENT_ID_HEADER,
    data: { name: "Aluna Demonstração Sprint11", email, password, confirmPassword: password, acceptTerms: true },
  });

  const outboxResponse = await page.request.get(`/api/dev/outbox/last?to=${encodeURIComponent(email)}&kind=email_confirmation`);
  const { email: outboxEmail } = await outboxResponse.json();
  const confirmMatch = outboxEmail.body.match(/token=([^\s]+)/);
  if (confirmMatch) {
    await page.request.post("/api/auth/email/confirm", { data: { token: confirmMatch[1] } });
  }

  const loginResponse = await page.request.post("/api/auth/login", { headers: TEST_CLIENT_ID_HEADER, data: { email, password } });
  const setCookie = loginResponse.headers()["set-cookie"];
  const tokenValue = setCookie.split(";")[0].split("=").slice(1).join("=");
  await page.context().addCookies([{ name: "md_session", value: tokenValue, domain: "localhost", path: "/" }]);
}

const ALL_WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"] as const;

function todayWeekdayInDefaultTimezone(): (typeof ALL_WEEKDAYS)[number] {
  const civil = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", weekday: "short" }).format(new Date());
  const map: Record<string, (typeof ALL_WEEKDAYS)[number]> = { Sun: "dom", Mon: "seg", Tue: "ter", Wed: "qua", Thu: "qui", Fri: "sex", Sat: "sab" };
  return map[civil] ?? "dom";
}

async function completeOnboarding(page: Page, availableDays: readonly string[] = ALL_WEEKDAYS): Promise<void> {
  await page.request.patch("/api/onboarding", { data: { currentGrade: "3_serie_em", enemYear: NEXT_YEAR, currentStep: 1 } });
  await page.request.patch("/api/onboarding", { data: { goalType: "acertos", goalValue: 30, currentStep: 2 } });
  await page.request.patch("/api/onboarding", { data: { availableDays, dailyMinutes: 60, currentStep: 3 } });
  await page.request.patch("/api/onboarding", { data: { difficulties: [], currentStep: 4 } });
  await page.request.patch("/api/onboarding", { data: { timePreference: "noite", currentStep: 5 } });
  await page.request.patch("/api/onboarding", { data: { diagnosticChoice: "depois", currentStep: 6 } });
  await page.request.post("/api/onboarding/complete");
}

async function signedInStudent(page: Page, prefix: string, availableDays: readonly string[] = ALL_WEEKDAYS): Promise<void> {
  await createConfirmedUser(page, prefix);
  await completeOnboarding(page, availableDays);
}

async function applyTraining(page: Page): Promise<void> {
  await page.request.post("/api/daily-training/apply", { data: { mutationId: crypto.randomUUID() } });
}

test.describe("Evidências visuais — Sprint 11 (Treino Diário Real e Listas Adaptativas)", () => {
  test("treino-diario-vazio", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const availableDays = ALL_WEEKDAYS.filter((day) => day !== todayWeekdayInDefaultTimezone());
    await signedInStudent(page, "vazio", availableDays);
    await page.goto("/treino-diario");
    await expect(page.getByText("Sem disponibilidade configurada para hoje")).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/treino-diario-vazio.png` });
  });

  test("treino-diario-preview", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "preview");
    await page.goto("/treino-diario");
    await expect(page.getByRole("button", { name: "Começar treino" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/treino-diario-preview.png`, fullPage: true });
  });

  test("treino-diario-composicao", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "composicao");
    await page.goto("/treino-diario");
    const heading = page.getByRole("heading", { name: "Composição do treino" });
    await expect(heading).toBeVisible();
    await heading.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS_DIR}/treino-diario-composicao.png` });
  });

  test("treino-diario-lista-ativa", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "lista-ativa");
    await applyTraining(page);
    await page.goto("/treino-diario");
    await expect(page.getByText(/Progresso: /)).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/treino-diario-lista-ativa.png`, fullPage: true });
  });

  test("treino-diario-item-em-andamento", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "em-andamento");
    await applyTraining(page);
    await page.goto("/treino-diario");
    await page.getByRole("button", { name: "Começar questão" }).click();
    await expect(page).toHaveURL(/\/tentativas\/.+/);
    await page.goto("/treino-diario");
    await expect(page.locator(".treino-diario__status--in_progress")).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/treino-diario-item-em-andamento.png` });
  });

  test("treino-diario-retomada", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "retomada");
    await applyTraining(page);
    await page.goto("/treino-diario");
    await page.getByRole("button", { name: "Começar questão" }).click();
    await expect(page).toHaveURL(/\/tentativas\/.+/);
    await page.goto("/treino-diario");
    await expect(page.getByRole("button", { name: "Continuar questão" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Continuar questão" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/treino-diario-retomada.png` });
  });

  test("treino-diario-item-concluido", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "item-concluido");
    await applyTraining(page);
    await page.goto("/treino-diario");
    await page.getByRole("button", { name: "Começar questão" }).click();
    await expect(page).toHaveURL(/\/tentativas\/.+/);
    await page.getByLabel(CORRECT_ALTERNATIVE_LABEL).check();
    await page.getByRole("button", { name: "Confirmar resposta" }).click();
    await page.goto("/treino-diario");
    await expect(page.locator(".treino-diario__status--completed")).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/treino-diario-item-concluido.png` });
  });

  test("treino-diario-resumo-final", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "resumo-final");
    await applyTraining(page);
    await page.goto("/treino-diario");
    await page.getByRole("button", { name: "Começar questão" }).click();
    await expect(page).toHaveURL(/\/tentativas\/.+/);
    await page.getByLabel(CORRECT_ALTERNATIVE_LABEL).check();
    await page.getByRole("button", { name: "Confirmar resposta" }).click();
    await page.goto("/treino-diario");
    await expect(page.locator(".treino-diario__status--completed")).toBeVisible();
    await page.getByRole("button", { name: "Concluir treino" }).click();
    await expect(page.getByRole("heading", { name: "Treino concluído" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/treino-diario-resumo-final.png`, fullPage: true });
  });

  test("treino-diario-mobile-390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signedInStudent(page, "mobile-390");
    await applyTraining(page);
    await page.goto("/treino-diario");
    await expect(page.getByText(/Progresso: /)).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/treino-diario-mobile-390px.png` });
  });

  test("dashboard-treino-real", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "dashboard");
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Treino Diário" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Começar treino" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/dashboard-treino-real.png` });
  });
});
