import { expect, test, type Page } from "@playwright/test";
import { testClientIdHeader } from "../e2e/rateLimitIsolation";

/* Sprint 13 v1.0, seção 13 da ordem — as DEZ evidências visuais
   obrigatórias do Relatório Semanal e Metas Realistas, geradas por
   automação real. Mesmo padrão das evidências das sprints anteriores (ver
   evidence/sprint-12-screenshots.spec.ts): conta própria por teste, dados
   evidentemente fictícios/fixture do seed local, sem nenhum dado sensível
   visível, isolamento de rate limit por cabeçalho.

   Único padrão publicado com questões PUBLICADAS treináveis no seed local:
   fixture-pat-04 ("Mediana e Frequência", slug mediana-e-frequencia) — duas
   questões (fixture-q-04, gabarito C — rótulo "Valor Z"; fixture-q-06). */
test.use({ storageState: { cookies: [], origins: [] } });

const TEST_CLIENT_ID_HEADER = testClientIdHeader("sprint-13-screenshots");
const NEXT_YEAR = new Date().getUTCFullYear() + 1;
const SHOTS_DIR = "evidence/screenshots/sprint-13";
const CORRECT_ALTERNATIVE_LABEL = /Valor Z/; // fixture-q-04, alternativa C

function uniqueEmail(prefix: string): string {
  return `evidencia-sprint13-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@evidencia.teste`;
}

async function createConfirmedUser(page: Page, prefix: string): Promise<void> {
  const email = uniqueEmail(prefix);
  const password = "senha-evidencia-fake-relatorio-1";

  await page.request.post("/api/auth/signup", {
    headers: TEST_CLIENT_ID_HEADER,
    data: { name: "Aluna Demonstração Sprint13", email, password, confirmPassword: password, acceptTerms: true },
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

async function completeOnboarding(page: Page): Promise<void> {
  await page.request.patch("/api/onboarding", { data: { currentGrade: "3_serie_em", enemYear: NEXT_YEAR, currentStep: 1 } });
  await page.request.patch("/api/onboarding", { data: { goalType: "acertos", goalValue: 30, currentStep: 2 } });
  await page.request.patch("/api/onboarding", { data: { availableDays: ALL_WEEKDAYS, dailyMinutes: 60, currentStep: 3 } });
  await page.request.patch("/api/onboarding", { data: { difficulties: [], currentStep: 4 } });
  await page.request.patch("/api/onboarding", { data: { timePreference: "noite", currentStep: 5 } });
  await page.request.patch("/api/onboarding", { data: { diagnosticChoice: "depois", currentStep: 6 } });
  await page.request.post("/api/onboarding/complete");
}

async function signedInStudent(page: Page, prefix: string): Promise<void> {
  await createConfirmedUser(page, prefix);
  await completeOnboarding(page);
}

/** Três tentativas de PRÁTICA confirmadas (mesma questão, via API direta do
 *  Player) — suficiente para o padrão sair de "evidências iniciais" e
 *  entrar em "em desenvolvimento" (MIN_CONFIRMED_FOR_DEVELOPMENT = 3,
 *  worker/src/lib/studentMetricsRules.ts), condição para que a sugestão de
 *  meta (seção 8 da ordem) o inclua entre os padrões prioritários. */
async function quickConfirmedPracticeAttempt(page: Page, questionId: string): Promise<void> {
  const startResponse = await page.request.post("/api/player/attempts", { data: { questionId, mode: "practice" } });
  const { attemptId } = await startResponse.json();
  await page.request.patch(`/api/player/attempts/${attemptId}/answer`, { data: { version: 1, alternative: "C" } });
  await page.request.post(`/api/player/attempts/${attemptId}/confirm`, { data: { version: 2 } });
}

async function generateRealEvidence(page: Page): Promise<void> {
  const applyResponse = await page.request.post("/api/simulations/apply", { data: { mutationId: crypto.randomUUID(), blockType: "mixed", size: 5 } });
  const { blockId } = await applyResponse.json();
  await page.goto(`/simulados/${blockId}`);
  await page.getByRole("button", { name: "Começar questão" }).first().click();
  await expect(page).toHaveURL(/\/tentativas\/.+/);
  await page.getByLabel(CORRECT_ALTERNATIVE_LABEL).check();
  await page.getByRole("button", { name: "Confirmar resposta" }).click();
  await page.goto(`/simulados/${blockId}`);
  await expect(page.locator(".simulados__status--completed")).toBeVisible();
  const skipButton = page.getByRole("button", { name: "Pular" });
  if (await skipButton.count()) {
    await skipButton.first().click();
    await page.getByRole("button", { name: "Confirmar" }).click();
  }
  await page.getByRole("button", { name: "Concluir bloco" }).click();
  await expect(page.getByRole("heading", { name: "Bloco concluído" })).toBeVisible();
}

test.describe("Evidências visuais — Sprint 13 (Relatório Semanal e Metas Realistas)", () => {
  test("relatorio-semanal-vazio", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "vazio");
    await page.goto("/relatorio-semanal");
    await expect(page.getByText("Ainda não há evidências suficientes nesta semana")).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/relatorio-semanal-vazio.png`, fullPage: true });
  });

  test("relatorio-semanal-com-evidencias", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "evidencias");
    await generateRealEvidence(page);
    await page.goto("/relatorio-semanal");
    await expect(page.getByTestId("weekly-review-facts")).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/relatorio-semanal-com-evidencias.png`, fullPage: true });
  });

  test("relatorio-semanal-comparacao", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "comparacao");
    await generateRealEvidence(page);
    await page.goto("/relatorio-semanal");
    await expect(page.getByTestId("weekly-review-comparison")).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/relatorio-semanal-comparacao.png`, fullPage: true });
  });

  test("relatorio-semanal-padroes-praticados", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "padroes");
    await generateRealEvidence(page);
    await page.goto("/relatorio-semanal");
    await expect(page.getByTestId("weekly-review-patterns")).toBeVisible();
    await page.getByTestId("weekly-review-patterns").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS_DIR}/relatorio-semanal-padroes-praticados.png`, fullPage: true });
  });

  test("metas-preview-proxima-semana", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "preview");
    await page.goto("/relatorio-semanal");
    await page.getByRole("button", { name: "Ver sugestão de meta" }).click();
    await expect(page.getByLabel("Minutos totais pretendidos")).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/metas-preview-proxima-semana.png`, fullPage: true });
  });

  test("metas-focos-selecionados", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "focos");
    await quickConfirmedPracticeAttempt(page, "fixture-q-04");
    await quickConfirmedPracticeAttempt(page, "fixture-q-04");
    await quickConfirmedPracticeAttempt(page, "fixture-q-04");
    await page.goto("/relatorio-semanal");
    await page.getByRole("button", { name: "Ver sugestão de meta" }).click();
    await expect(page.getByText("Padrões prioritários (até 3)")).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/metas-focos-selecionados.png`, fullPage: true });
  });

  test("metas-ativas", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "ativas");
    await page.goto("/relatorio-semanal");
    await page.getByRole("button", { name: "Ver sugestão de meta" }).click();
    await page.getByRole("button", { name: "Aplicar meta" }).click();
    await expect(page.getByTestId("weekly-review-goal-active")).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/metas-ativas.png`, fullPage: true });
  });

  test("metas-progresso-real", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "progresso");
    await generateRealEvidence(page);
    await page.goto("/relatorio-semanal");
    await page.getByRole("button", { name: "Ver sugestão de meta" }).click();
    await page.getByRole("button", { name: "Aplicar meta" }).click();
    await expect(page.getByTestId("weekly-review-progress")).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/metas-progresso-real.png`, fullPage: true });
  });

  test("relatorio-semanal-mobile-390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signedInStudent(page, "mobile-390");
    await generateRealEvidence(page);
    await page.goto("/relatorio-semanal");
    await expect(page.getByTestId("weekly-review-facts")).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/relatorio-semanal-mobile-390px.png` });
  });

  test("dashboard-relatorio-semanal", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "dashboard");
    await generateRealEvidence(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Sua semana" })).toBeVisible();
    // O card busca /api/weekly-review/current de forma assíncrona (useEffect)
    // — espera o conteúdo REAL (nunca só o título estático da seção) antes
    // de capturar, senão a screenshot pode flagrar o instante em que o
    // fetch ainda não resolveu (mesma corrida que afeta qualquer card do
    // Dashboard, não é específica desta sprint).
    await expect(page.getByRole("link", { name: "Ver relatório semanal" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/dashboard-relatorio-semanal.png` });
  });
});
