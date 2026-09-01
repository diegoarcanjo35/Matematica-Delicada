import { expect, test, type Page } from "@playwright/test";
import { testClientIdHeader } from "../e2e/rateLimitIsolation";

/* Sprint 8 v1.1, seção 17 da ordem — as CATORZE evidências visuais
   obrigatórias do Player de Questão, geradas por automação real. Mesmo
   padrão das evidências das sprints anteriores (ver
   evidence/sprint-07-screenshots.spec.ts): conta própria por teste, dados
   evidentemente fictícios/fixture, sem nenhuma credencial ou token visível,
   isolamento de rate limit por cabeçalho.

   Única questão publicada no seed local: fixture-q-04 (padrão
   fixture-pat-04, slug "mediana-e-frequencia", gabarito na alternativa C —
   ver scripts/fixtures/questions-fixtures.local.sql). Todas as evidências do
   Player usam esta mesma questão. */
test.use({ storageState: { cookies: [], origins: [] } });

const TEST_CLIENT_ID_HEADER = testClientIdHeader("sprint-08-screenshots");
const NEXT_YEAR = new Date().getUTCFullYear() + 1;
const SHOTS_DIR = "evidence/screenshots/sprint-08";
const QUESTION_ID = "fixture-q-04";
const PATTERN_SLUG = "mediana-e-frequencia";

function uniqueEmail(prefix: string): string {
  return `evidencia-sprint8-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@evidencia.teste`;
}

async function createConfirmedUser(page: Page, prefix: string): Promise<void> {
  const email = uniqueEmail(prefix);
  const password = "senha-evidencia-fake-player-1";

  await page.request.post("/api/auth/signup", {
    headers: TEST_CLIENT_ID_HEADER,
    data: { name: "Aluna Demonstração Sprint8", email, password, confirmPassword: password, acceptTerms: true },
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

async function startAttemptAndGoto(page: Page, mode: "learning" | "practice" | "recognition"): Promise<string> {
  const response = await page.request.post("/api/player/attempts", { data: { questionId: QUESTION_ID, mode } });
  const body = await response.json();
  const attemptId = body.attemptId as string;
  await page.goto(`/tentativas/${attemptId}`);
  return attemptId;
}

test.describe("Evidências visuais — Sprint 8 (Player de Questão)", () => {
  test("player-inicio-desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "inicio-desktop");
    await page.goto(`/questoes/${QUESTION_ID}`);
    await expect(page.getByRole("heading", { name: "Resolver questão", level: 1 })).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/player-inicio-desktop.png` });
  });

  test("player-mobile-390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signedInStudent(page, "mobile-390");
    await startAttemptAndGoto(page, "learning");
    await expect(page.getByText("FIXTURE TÉCNICA LOCAL")).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/player-mobile-390px.png` });
  });

  test("player-reconhecimento", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "reconhecimento");
    await startAttemptAndGoto(page, "recognition");
    await expect(page.getByText("Qual padrão você reconhece nesta questão?")).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/player-reconhecimento.png` });
  });

  test("player-alternativas", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "alternativas");
    await startAttemptAndGoto(page, "learning");
    await expect(page.getByText("Alternativas")).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/player-alternativas.png` });
  });

  test("player-ajuda-camada-1", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "ajuda-1");
    await startAttemptAndGoto(page, "learning");
    await page.getByRole("button", { name: "Pista leve" }).click();
    await expect(page.getByText("Pista leve:")).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/player-ajuda-camada-1.png` });
  });

  test("player-ajuda-camada-3", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "ajuda-3");
    await startAttemptAndGoto(page, "learning");
    await page.getByRole("button", { name: "Pista leve" }).click();
    await page.getByRole("button", { name: "Reconheça o padrão" }).click();
    await page.getByRole("button", { name: "Estratégia" }).click();
    await expect(page.getByText("Estratégia:")).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/player-ajuda-camada-3.png` });
  });

  test("player-confirmacao-resolucao", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "confirmacao-resolucao");
    await startAttemptAndGoto(page, "learning");
    await page.getByRole("button", { name: "Pista leve" }).click();
    await page.getByRole("button", { name: "Reconheça o padrão" }).click();
    await page.getByRole("button", { name: "Estratégia" }).click();
    await page.getByRole("button", { name: "Resolução comentada" }).click();
    await expect(page.getByRole("heading", { name: "Ver a resolução comentada?" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/player-confirmacao-resolucao.png` });
  });

  test("player-feedback-acerto", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "feedback-acerto");
    await startAttemptAndGoto(page, "learning");
    await page.getByLabel(/Valor Z/).check();
    // Espera o `PATCH .../answer` assíncrono terminar antes de confirmar —
    // sem isto a `version` enviada ao confirmar pode estar desatualizada.
    await expect(page.getByRole("status").filter({ hasText: "Salvo" })).toBeVisible();
    await page.getByRole("button", { name: "Confirmar resposta" }).click();
    // `role="status"` sozinho é ambíguo na tela de resultado (o banner de
    // acerto/erro e o indicador vazio de mensagem de bookmark são os dois).
    await expect(page.locator(".player__feedback-banner")).toContainText("Resposta correta!");
    await page.screenshot({ path: `${SHOTS_DIR}/player-feedback-acerto.png` });
  });

  test("player-feedback-erro", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "feedback-erro");
    await startAttemptAndGoto(page, "practice");
    await page.getByLabel(/Valor X/).check();
    await expect(page.getByRole("status").filter({ hasText: "Salvo" })).toBeVisible();
    await page.getByRole("button", { name: "Confirmar resposta" }).click();
    await expect(page.locator(".player__feedback-banner")).toContainText("Resposta incorreta.");
    await page.screenshot({ path: `${SHOTS_DIR}/player-feedback-erro.png` });
  });

  test("player-dna-questao", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "dna-questao");
    await startAttemptAndGoto(page, "learning");
    await page.getByLabel(/Valor Z/).check();
    await expect(page.getByRole("status").filter({ hasText: "Salvo" })).toBeVisible();
    await page.getByRole("button", { name: "Confirmar resposta" }).click();
    const dnaHeading = page.getByRole("heading", { name: "DNA da questão" });
    await expect(dnaHeading).toBeVisible();
    await dnaHeading.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS_DIR}/player-dna-questao.png` });
  });

  test("player-salvo-revisao", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "salvo-revisao");
    await startAttemptAndGoto(page, "learning");
    await page.getByRole("button", { name: "Salvar para revisar" }).click();
    await expect(page.getByRole("button", { name: "Remover da revisão" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/player-salvo-revisao.png` });
  });

  test("player-denunciar-problema", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "denunciar-problema");
    await startAttemptAndGoto(page, "learning");
    await page.getByRole("button", { name: "Denunciar problema" }).click();
    await expect(page.getByRole("heading", { name: "Denunciar problema nesta questão" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/player-denunciar-problema.png` });
  });

  test("player-retomada-apos-refresh", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "retomada-refresh");
    await startAttemptAndGoto(page, "learning");
    await page.getByLabel(/Valor Z/).check();
    await expect(page.getByRole("status").filter({ hasText: "Salvo" })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel(/Valor Z/)).toBeChecked();
    await page.screenshot({ path: `${SHOTS_DIR}/player-retomada-apos-refresh.png` });
  });

  test("padrao-treinar-habilitado", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "treinar-habilitado");
    await page.goto(`/padroes-enem/${PATTERN_SLUG}`);
    const trainLink = page.getByRole("link", { name: "Treinar este padrão" });
    await expect(trainLink).toBeVisible();
    await trainLink.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS_DIR}/padrao-treinar-habilitado.png` });
  });
});
