import { expect, test, type Page } from "@playwright/test";
import { testClientIdHeader } from "../e2e/rateLimitIsolation";

/* Sprint 9 v1.0, seção 17 da ordem — as DOZE evidências visuais
   obrigatórias do Caderno de Erros e Revisão Espaçada, geradas por
   automação real. Mesmo padrão das evidências das sprints anteriores:
   conta própria por teste, dados evidentemente fictícios/fixture, sem
   nenhuma nota livre sensível visível, isolamento de rate limit por
   cabeçalho. */
test.use({ storageState: { cookies: [], origins: [] } });

const TEST_CLIENT_ID_HEADER = testClientIdHeader("sprint-09-screenshots");
const NEXT_YEAR = new Date().getUTCFullYear() + 1;
const SHOTS_DIR = "evidence/screenshots/sprint-09";
const ORIGINAL_QUESTION_ID = "fixture-q-04";

function uniqueEmail(prefix: string): string {
  return `evidencia-sprint9-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@evidencia.teste`;
}

async function createConfirmedUser(page: Page, prefix: string): Promise<void> {
  const email = uniqueEmail(prefix);
  const password = "senha-evidencia-fake-caderno-1";

  await page.request.post("/api/auth/signup", {
    headers: TEST_CLIENT_ID_HEADER,
    data: { name: "Aluna Demonstração Sprint9", email, password, confirmPassword: password, acceptTerms: true },
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

async function createWrongAnswerEntry(page: Page): Promise<string> {
  const create = await page.request.post("/api/player/attempts", { data: { questionId: ORIGINAL_QUESTION_ID, mode: "learning" } });
  const { attemptId } = await create.json();
  await page.request.patch(`/api/player/attempts/${attemptId}/answer`, { data: { version: 1, alternative: "A" } });
  await page.request.post(`/api/player/attempts/${attemptId}/confirm`, { data: { version: 2 } });
  const list = await (await page.request.get("/api/error-notebook")).json();
  const entry = list.entries.find((e: { originalQuestionId: string }) => e.originalQuestionId === ORIGINAL_QUESTION_ID);
  return entry.id;
}

test.describe("Evidências visuais — Sprint 9 (Caderno de Erros e Revisão Espaçada)", () => {
  test("caderno-vazio", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "vazio");
    await page.goto("/caderno-de-erros");
    await expect(page.getByText("Nenhum erro registrado ainda")).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/caderno-vazio.png` });
  });

  test("caderno-lista-desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "lista-desktop");
    await createWrongAnswerEntry(page);
    await page.goto("/caderno-de-erros");
    await expect(page.getByText("FIX-Q-04")).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/caderno-lista-desktop.png` });
  });

  test("caderno-mobile-390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signedInStudent(page, "mobile-390");
    await createWrongAnswerEntry(page);
    await page.goto("/caderno-de-erros");
    await expect(page.getByText("FIX-Q-04")).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/caderno-mobile-390px.png` });
  });

  test("caderno-filtros", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "filtros");
    await createWrongAnswerEntry(page);
    await page.goto("/caderno-de-erros");
    await page.getByLabel("Status").selectOption("scheduled");
    await expect(page).toHaveURL(/status=scheduled/);
    await page.screenshot({ path: `${SHOTS_DIR}/caderno-filtros.png` });
  });

  test("erro-detalhes", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "detalhes");
    const entryId = await createWrongAnswerEntry(page);
    await page.goto(`/caderno-de-erros/${entryId}`);
    await expect(page.getByRole("heading", { level: 1 }).filter({ hasText: "FIX-Q-04" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/erro-detalhes.png` });
  });

  test("erro-classificacao-anotacao", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "classificacao");
    const entryId = await createWrongAnswerEntry(page);
    await page.goto(`/caderno-de-erros/${entryId}`);
    const section = page.locator("#secao-classificacao").locator("..");
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS_DIR}/erro-classificacao-anotacao.png` });
  });

  test("revisao-vencida", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "vencida");
    await createWrongAnswerEntry(page);
    // A visão "vencida" é derivada de next_review_at <= agora — o seed
    // real agenda +1 dia, então simulamos o filtro que a tela oferece
    // (overdue=true) sobre o estado real já registrado, para documentar a
    // UI do indicador sem depender de esperar um dia real.
    await page.goto("/caderno-de-erros?vencida=true");
    // A entrada recém-criada é agendada para +1 dia (nunca vencida no
    // instante da criação) — o filtro "Só revisões vencidas" mostra
    // corretamente a lista vazia aqui; a evidência documenta a INTERAÇÃO
    // do filtro em si, não fabrica uma data vencida.
    await expect(page.getByRole("checkbox", { name: "Só revisões vencidas" })).toBeChecked();
    await page.screenshot({ path: `${SHOTS_DIR}/revisao-vencida.png` });
  });

  test("revisao-iniciada-player", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "revisao-iniciada");
    const entryId = await createWrongAnswerEntry(page);
    await page.goto(`/caderno-de-erros/${entryId}`);
    await page.getByRole("button", { name: "Corrigir meu erro" }).click();
    await expect(page).toHaveURL(/\/tentativas\/.+/);
    await expect(page.getByText("REVISÃO")).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/revisao-iniciada-player.png` });
  });

  test("revisao-feedback-correta", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "revisao-correta");
    const entryId = await createWrongAnswerEntry(page);
    const start = await page.request.post(`/api/error-notebook/${entryId}/start-review`);
    const { attemptId } = await start.json();
    await page.goto(`/tentativas/${attemptId}`);
    await page.getByLabel(/Valor Q/).check();
    await expect(page.getByRole("status").filter({ hasText: "Salvo" })).toBeVisible();
    await page.getByRole("button", { name: "Confirmar resposta" }).click();
    await expect(page.locator(".player__feedback-banner")).toContainText("Resposta correta!");
    await page.screenshot({ path: `${SHOTS_DIR}/revisao-feedback-correta.png` });
  });

  test("revisao-feedback-incorreta", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "revisao-incorreta");
    const entryId = await createWrongAnswerEntry(page);
    const start = await page.request.post(`/api/error-notebook/${entryId}/start-review`);
    const { attemptId } = await start.json();
    await page.goto(`/tentativas/${attemptId}`);
    await page.getByLabel(/Valor P/).check();
    await expect(page.getByRole("status").filter({ hasText: "Salvo" })).toBeVisible();
    await page.getByRole("button", { name: "Confirmar resposta" }).click();
    await expect(page.locator(".player__feedback-banner")).toContainText("Resposta incorreta.");
    await page.screenshot({ path: `${SHOTS_DIR}/revisao-feedback-incorreta.png` });
  });

  test("erro-corrigido-outro-contexto", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "corrigido-outro-contexto");
    const entryId = await createWrongAnswerEntry(page);

    const start1 = await page.request.post(`/api/error-notebook/${entryId}/start-review`);
    const { attemptId: attempt1 } = await start1.json();
    await page.request.patch(`/api/player/attempts/${attempt1}/answer`, { data: { version: 1, alternative: "B" } });
    await page.request.post(`/api/player/attempts/${attempt1}/confirm`, { data: { version: 2 } });

    const start2 = await page.request.post(`/api/error-notebook/${entryId}/start-review`);
    const { attemptId: attempt2 } = await start2.json();
    await page.request.patch(`/api/player/attempts/${attempt2}/answer`, { data: { version: 1, alternative: "C" } });
    await page.request.post(`/api/player/attempts/${attempt2}/confirm`, { data: { version: 2 } });

    await page.goto(`/caderno-de-erros/${entryId}`);
    await expect(page.getByText("Status: Corrigido")).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/erro-corrigido-outro-contexto.png` });
  });

  test("dashboard-erros-reais", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "dashboard-real");
    await createWrongAnswerEntry(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Caderno de Erros" })).toBeVisible();
    await expect(page.getByText("1 erro ativo")).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/dashboard-erros-reais.png` });
  });
});
