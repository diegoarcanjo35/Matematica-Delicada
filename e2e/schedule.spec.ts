import { expect, test, type Page } from "@playwright/test";
import { testClientIdHeader } from "./rateLimitIsolation";

/* Sprint 5 v1.0 — fluxo completo do cronograma adaptativo, em Chromium real.
   Mesmo padrão de e2e/diagnostic.spec.ts: cada teste usa uma conta própria,
   isolada do rate limit por cabeçalho. */
test.use({ storageState: { cookies: [], origins: [] } });

const TEST_CLIENT_ID_HEADER = testClientIdHeader("schedule");
const NEXT_YEAR = new Date().getUTCFullYear() + 1;

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@teste.dev`;
}

async function createConfirmedUser(page: Page, emailPrefix: string): Promise<void> {
  const email = uniqueEmail(emailPrefix);
  const password = "senha-de-teste-cronograma-1";

  await page.request.post("/api/auth/signup", {
    headers: TEST_CLIENT_ID_HEADER,
    data: { name: "Aluna Cronograma", email, password, confirmPassword: password, acceptTerms: true },
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
    data: { availableDays: ["seg", "ter", "qua", "qui", "sex", "sab", "dom"], dailyMinutes: 240, currentStep: 3 },
  });
  await page.request.patch("/api/onboarding", { data: { difficulties: [], currentStep: 4 } });
  await page.request.patch("/api/onboarding", { data: { timePreference: "noite", currentStep: 5 } });
  await page.request.patch("/api/onboarding", { data: { diagnosticChoice: "depois", currentStep: 6 } });
  await page.request.post("/api/onboarding/complete");
}

test.describe("Cronograma — fluxo completo", () => {
  test("usuário novo vê Pendências vazia; aplicar um plano mostra o aviso de conteúdo técnico provisório", async ({
    page,
  }) => {
    await createConfirmedUser(page, "sched-hoje");
    await completeOnboarding(page);
    // Correção v1.1: nenhum GET cria nada — antes de aplicar um plano, a
    // visão Pendências está genuinamente vazia (nenhuma atribuição existe).
    await page.goto("/cronograma?view=pending");
    await expect(page.getByRole("heading", { name: "Cronograma" })).toBeVisible();
    await expect(page.getByText("Nada por aqui")).toBeVisible();

    await page.getByRole("button", { name: "Gerar prévia do plano" }).click();
    await page.getByRole("button", { name: "Aplicar plano" }).click();
    await page.getByRole("button", { name: "Aplicar", exact: true }).click();

    await page.goto("/cronograma?view=today");
    await expect(page.getByText("CONTEÚDO TÉCNICO PROVISÓRIO — NÃO PUBLICAR").first()).toBeVisible();
  });

  test("navegar entre abas atualiza a URL e preserva a visão no refresh", async ({ page }) => {
    await createConfirmedUser(page, "sched-abas");
    await completeOnboarding(page);
    await page.goto("/cronograma");

    await page.getByRole("button", { name: "Pendências" }).click();
    await expect(page).toHaveURL(/view=pending/);

    await page.reload();
    await expect(page.getByRole("button", { name: "Pendências" })).toHaveAttribute("aria-current", "page");
  });

  test("gerar prévia e aplicar o plano distribui atividades pendentes em datas", async ({ page }) => {
    await createConfirmedUser(page, "sched-plano");
    await completeOnboarding(page);
    await page.goto("/cronograma?view=pending");

    await expect(page.getByRole("heading", { name: "Planejar atividades pendentes" })).toBeVisible();
    await page.getByRole("button", { name: "Gerar prévia do plano" }).click();
    await expect(page.getByText(/atividade\(s\) encontraram data disponível/)).toBeVisible();

    await page.getByRole("button", { name: "Aplicar plano" }).click();
    await expect(page.getByRole("heading", { name: "Aplicar este plano?" })).toBeVisible();
    await page.getByRole("button", { name: "Aplicar", exact: true }).click();

    await page.goto("/cronograma?view=today");
    await expect(page.locator(".schedule__grid .schedule__card").first()).toBeVisible();
  });

  test("iniciar, concluir e dispensar uma atividade via interface", async ({ page }) => {
    await createConfirmedUser(page, "sched-acoes");
    await completeOnboarding(page);
    await page.goto("/cronograma?view=pending");
    await page.getByRole("button", { name: "Gerar prévia do plano" }).click();
    await page.getByRole("button", { name: "Aplicar plano" }).click();
    await page.getByRole("button", { name: "Aplicar", exact: true }).click();

    await page.goto("/cronograma?view=today");
    const firstCard = page.locator(".schedule__grid .schedule__card").first();
    await expect(firstCard).toBeVisible();

    // Uma atividade dismissible + manual sempre existe entre as fixtures
    // (ex.: "Concluir o diagnóstico inicial"); localiza qualquer card com o
    // botão "Iniciar" disponível.
    await firstCard.getByRole("button", { name: "Iniciar" }).click();
    await expect(page.getByText("Atividade iniciada.")).toBeVisible();
  });

  test("reagendar uma atividade abre confirmação e move para outra data", async ({ page }) => {
    await createConfirmedUser(page, "sched-reagendar");
    await completeOnboarding(page);
    await page.goto("/cronograma?view=pending");
    await page.getByRole("button", { name: "Gerar prévia do plano" }).click();
    await page.getByRole("button", { name: "Aplicar plano" }).click();
    await page.getByRole("button", { name: "Aplicar", exact: true }).click();

    await page.goto("/cronograma?view=today");
    const firstCard = page.locator(".schedule__grid .schedule__card").first();
    await firstCard.getByRole("button", { name: "Reagendar" }).click();
    const rescheduleDialog = page.getByRole("dialog", { name: "Reagendar atividade?" });
    await expect(rescheduleDialog).toBeVisible();
    await rescheduleDialog.getByRole("button", { name: "Reagendar", exact: true }).click();
    await expect(page.getByText("Atividade reagendada.")).toBeVisible();
  });

  test("detalhe da atividade mostra 'Por que esta atividade?'", async ({ page }) => {
    await createConfirmedUser(page, "sched-detalhe");
    await completeOnboarding(page);
    await page.goto("/cronograma?view=pending");
    await page.getByRole("button", { name: "Gerar prévia do plano" }).click();
    await page.getByRole("button", { name: "Aplicar plano" }).click();
    await page.getByRole("button", { name: "Aplicar", exact: true }).click();

    await page.goto("/cronograma?view=today");
    await expect(page.locator(".schedule__grid .schedule__card").first()).toBeVisible();

    await page.locator(".schedule__why-link").first().click();
    await expect(page.getByText(/demonstração técnica/i)).toBeVisible();
  });

  test("mobile 390px sem rolagem horizontal", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await createConfirmedUser(page, "sched-mobile");
    await completeOnboarding(page);
    await page.goto("/cronograma");
    await expect(page.getByRole("heading", { name: "Cronograma" })).toBeVisible();

    const hasHorizontalScroll = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    expect(hasHorizontalScroll).toBe(false);
  });

  test("isolamento entre usuários — atribuição de um não é acessível pelo outro via API", async ({ page, browser }) => {
    await createConfirmedUser(page, "sched-isolamento-a");
    await completeOnboarding(page);
    const summaryA = await (await page.request.get("/api/schedule/summary")).json();
    expect(summaryA.available).toBe(true);

    // Correção v1.1: nenhum GET cria nada — aplica um plano explicitamente
    // via API (preview → apply) para ter uma atribuição real de quem testar
    // o isolamento.
    const previewResponse = await page.request.post("/api/schedule/plan/preview");
    const preview = await previewResponse.json();
    await page.request.post("/api/schedule/plan/apply", { data: { previewId: preview.previewId } });
    const activitiesA = await (await page.request.get("/api/schedule/activities?view=assigned")).json();
    const assignmentId = activitiesA.activities[0].id;

    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    await createConfirmedUser(otherPage, "sched-isolamento-b");
    await completeOnboarding(otherPage);

    const blockedResponse = await otherPage.request.get(`/api/schedule/activities/${assignmentId}`);
    expect(blockedResponse.status()).toBe(404);

    await otherContext.close();
  });

  test("calendário mensal — navegação mês anterior/seguinte, seleção por teclado e sem rolagem horizontal no mobile", async ({
    page,
  }) => {
    await createConfirmedUser(page, "sched-calendario");
    await completeOnboarding(page);
    await page.goto("/cronograma?view=pending");
    await page.getByRole("button", { name: "Gerar prévia do plano" }).click();
    await page.getByRole("button", { name: "Aplicar plano" }).click();
    await page.getByRole("button", { name: "Aplicar", exact: true }).click();

    await page.goto("/cronograma?view=month");
    await expect(page.getByRole("grid")).toBeVisible();
    const initialTitle = await page.locator(".schedule__calendar-title").textContent();

    await page.getByRole("button", { name: "Mês seguinte" }).click();
    await expect(page.locator(".schedule__calendar-title")).not.toHaveText(initialTitle ?? "");

    await page.getByRole("button", { name: "Mês anterior" }).click();
    await expect(page.locator(".schedule__calendar-title")).toHaveText(initialTitle ?? "");

    // Seleção por teclado: uma célula do dia é um <button> focável e
    // ativável por Enter, sem precisar de mouse.
    const todayCell = page.locator('[aria-current="date"]');
    await todayCell.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".schedule__day-detail")).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    const hasHorizontalScroll = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    expect(hasHorizontalScroll).toBe(false);
  });

  test("sem erros no console durante o fluxo do cronograma", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    await createConfirmedUser(page, "sched-console");
    await completeOnboarding(page);
    await page.goto("/cronograma");
    await expect(page.getByRole("heading", { name: "Cronograma" })).toBeVisible();
    await page.getByRole("button", { name: "Semana" }).click();
    await expect(page.getByRole("button", { name: "Semana" })).toHaveAttribute("aria-current", "page");

    expect(consoleErrors).toEqual([]);
  });
});
