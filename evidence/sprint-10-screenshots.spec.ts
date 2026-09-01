import { expect, test, type Page } from "@playwright/test";
import { testClientIdHeader } from "../e2e/rateLimitIsolation";

/* Sprint 10 v1.0, seção 17 da ordem — as NOVE evidências visuais
   obrigatórias do Mapa ENEM do Aluno (Métricas Centrais), geradas por
   automação real. Mesmo padrão das evidências das sprints anteriores
   (ver evidence/sprint-09-screenshots.spec.ts): conta própria por teste,
   dados evidentemente fictícios/fixture do seed local, sem nenhuma nota
   livre sensível visível, isolamento de rate limit por cabeçalho.

   Única questão original publicada com padrão principal e evidência
   praticável no seed local: fixture-q-04 (padrão fixture-pat-04,
   "Mediana e Frequência", slug mediana-e-frequencia), gabarito na
   alternativa C — mesma fixture usada por e2e/studentMetrics.spec.ts. */
test.use({ storageState: { cookies: [], origins: [] } });

const TEST_CLIENT_ID_HEADER = testClientIdHeader("sprint-10-screenshots");
const NEXT_YEAR = new Date().getUTCFullYear() + 1;
const SHOTS_DIR = "evidence/screenshots/sprint-10";
const ORIGINAL_QUESTION_ID = "fixture-q-04";
const CORRECT_ALTERNATIVE = "C"; // gabarito de fixture-q-04
const INCORRECT_ALTERNATIVE = "A";
const PATTERN_SLUG = "mediana-e-frequencia";
const PATTERN_NAME = "Mediana e Frequência";

function uniqueEmail(prefix: string): string {
  return `evidencia-sprint10-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@evidencia.teste`;
}

async function createConfirmedUser(page: Page, prefix: string): Promise<void> {
  const email = uniqueEmail(prefix);
  const password = "senha-evidencia-fake-mapa-enem-1";

  await page.request.post("/api/auth/signup", {
    headers: TEST_CLIENT_ID_HEADER,
    data: { name: "Aluna Demonstração Sprint10", email, password, confirmPassword: password, acceptTerms: true },
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

async function signedInStudent(page: Page, prefix: string): Promise<void> {
  await createConfirmedUser(page, prefix);
  await completeOnboarding(page);
}

/** Confirma uma resposta (correta ou não) numa questão publicada via a API
 *  real do Player — mesmo caminho de e2e/studentMetrics.spec.ts:answerQuestion. */
async function answerQuestion(
  page: Page,
  questionId: string,
  alternative: "A" | "B" | "C" | "D" | "E",
  mode: "learning" | "practice" | "recognition" = "learning"
): Promise<void> {
  const create = await page.request.post("/api/player/attempts", { data: { questionId, mode } });
  const { attemptId } = await create.json();
  await page.request.patch(`/api/player/attempts/${attemptId}/answer`, { data: { version: 1, alternative } });
  await page.request.post(`/api/player/attempts/${attemptId}/confirm`, { data: { version: 2 } });
}

/** Uma resposta ERRADA confirmada cria automaticamente uma entrada ativa no
 *  Caderno de Erros (Sprint 9) — usada para as evidências de CTA para o
 *  Caderno de Erros. */
async function createActiveErrorEntry(page: Page): Promise<void> {
  await answerQuestion(page, ORIGINAL_QUESTION_ID, INCORRECT_ALTERNATIVE, "learning");
}

test.describe("Evidências visuais — Sprint 10 (Métricas Centrais e Mapa ENEM do Aluno)", () => {
  test("mapa-vazio", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "vazio");
    await page.goto("/mapa-enem");
    await expect(page.locator(".state-view__title")).toHaveText("Ainda sem evidências suficientes");
    await page.screenshot({ path: `${SHOTS_DIR}/mapa-vazio.png` });
  });

  test("mapa-com-evidencias", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "evidencias");
    await answerQuestion(page, ORIGINAL_QUESTION_ID, CORRECT_ALTERNATIVE, "learning");
    await page.goto("/mapa-enem");
    await expect(page.locator(".mapa-enem__card", { hasText: PATTERN_NAME })).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/mapa-com-evidencias.png`, fullPage: true });
  });

  test("mapa-filtros-busca", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "filtros");
    await answerQuestion(page, ORIGINAL_QUESTION_ID, CORRECT_ALTERNATIVE, "learning");
    await page.goto("/mapa-enem");
    await page.getByLabel("Buscar por padrão").fill("PAD-04");
    await expect(page).toHaveURL(/busca=PAD-04/);
    await expect(page.getByText(PATTERN_NAME)).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/mapa-filtros-busca.png` });
  });

  test("mapa-detalhe-padrao", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "detalhe");
    await answerQuestion(page, ORIGINAL_QUESTION_ID, CORRECT_ALTERNATIVE, "learning");
    await page.goto(`/mapa-enem/${PATTERN_SLUG}`);
    await expect(page.getByRole("heading", { name: PATTERN_NAME, level: 1 })).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/mapa-detalhe-padrao.png`, fullPage: true });
  });

  test("mapa-cta-treino", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "cta-treino");
    await page.goto(`/mapa-enem/${PATTERN_SLUG}`);
    await expect(page.getByRole("link", { name: "Treinar este padrão" })).toBeVisible();
    const actions = page.locator("#secao-acoes").locator("..");
    await actions.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS_DIR}/mapa-cta-treino.png` });
  });

  test("mapa-cta-caderno", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "cta-caderno");
    await createActiveErrorEntry(page);
    await page.goto("/mapa-enem");
    await expect(page.getByRole("link", { name: "Ir para o Caderno de Erros" }).first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/mapa-cta-caderno.png`, fullPage: true });
  });

  test("dashboard-mapa-enem", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "dashboard");
    await answerQuestion(page, ORIGINAL_QUESTION_ID, CORRECT_ALTERNATIVE, "learning");
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Seu Mapa ENEM" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Ver Mapa ENEM completo" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/dashboard-mapa-enem.png` });
  });

  test("mapa-mobile-390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signedInStudent(page, "mobile-390");
    await answerQuestion(page, ORIGINAL_QUESTION_ID, CORRECT_ALTERNATIVE, "learning");
    await page.goto("/mapa-enem");
    await expect(page.getByText(PATTERN_NAME)).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/mapa-mobile-390px.png` });
  });

  test("mapa-teclado-foco", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "teclado");
    await answerQuestion(page, ORIGINAL_QUESTION_ID, CORRECT_ALTERNATIVE, "learning");
    await page.goto("/mapa-enem");
    const searchInput = page.getByLabel("Buscar por padrão");
    await searchInput.focus();
    await expect(searchInput).toBeFocused();
    await page.screenshot({ path: `${SHOTS_DIR}/mapa-teclado-foco.png` });
  });
});
