import { expect, test, type Page } from "@playwright/test";
import { testClientIdHeader } from "./rateLimitIsolation";

/* Sprint 13 v1.0, seção 12.2 da ordem — Relatório Semanal e Metas
   Realistas, testado em Chromium real contra o servidor principal (porta
   8793), mesmo padrão de e2e/simulations.spec.ts. Cada teste usa uma conta
   própria, isolada do rate limit por cabeçalho.

   Único padrão publicado com questões PUBLICADAS treináveis no seed local:
   fixture-pat-04 ("Mediana e Frequência", slug mediana-e-frequencia) — duas
   questões (fixture-q-04, gabarito C — rótulo "Valor Z"; fixture-q-06). Um
   bloco de simulado misto concluído com sucesso gera evidência REAL (tempo,
   questão confirmada, padrão praticado) para o relatório da semana CORRENTE
   — a única semana alcançável neste ambiente (o relógio do Worker em E2E é
   sempre o relógio real da máquina; não há endpoint de injeção de relógio
   sintético para além do ambiente de testes Vitest). Por isso a comparação
   com a semana anterior é sempre "indisponível" neste ambiente (uma conta
   nova nunca tem evidência na semana anterior) — comportamento factual e
   honesto, não uma limitação do teste. */
test.use({ storageState: { cookies: [], origins: [] } });

const TEST_CLIENT_ID_HEADER = testClientIdHeader("weekly-review");
const NEXT_YEAR = new Date().getUTCFullYear() + 1;
const CORRECT_ALTERNATIVE_LABEL = /Valor Z/; // fixture-q-04, alternativa C

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@teste.dev`;
}

async function createConfirmedUser(page: Page, emailPrefix: string): Promise<void> {
  const email = uniqueEmail(emailPrefix);
  const password = "senha-de-teste-relatorio-semanal-1";

  await page.request.post("/api/auth/signup", {
    headers: TEST_CLIENT_ID_HEADER,
    data: { name: "Aluna Relatório Semanal", email, password, confirmPassword: password, acceptTerms: true },
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

async function completeOnboarding(page: Page): Promise<void> {
  await page.request.patch("/api/onboarding", { data: { currentGrade: "3_serie_em", enemYear: NEXT_YEAR, currentStep: 1 } });
  await page.request.patch("/api/onboarding", { data: { goalType: "acertos", goalValue: 30, currentStep: 2 } });
  await page.request.patch("/api/onboarding", {
    data: { availableDays: ["dom", "seg", "ter", "qua", "qui", "sex", "sab"], dailyMinutes: 60, currentStep: 3 },
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

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const hasHorizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(hasHorizontalScroll).toBe(false);
}

/** Aplica um bloco misto de simulado, responde e confirma a primeira
 *  questão corretamente, pula a segunda (se houver) e conclui o bloco —
 *  gera evidência REAL (tentativa confirmada, bloco concluído, padrão
 *  praticado) para a semana corrente, reaproveitando o mesmo fluxo já
 *  provado por e2e/simulations.spec.ts, nunca uma segunda implementação. */
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

test.describe("Relatório Semanal — estados do relatório", () => {
  test("relatório vazio: semana sem nenhuma evidência mostra estado honesto, sem erro", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "vazio");
    await page.goto("/relatorio-semanal");
    await expect(page.getByText("Ainda não há evidências suficientes nesta semana")).toBeVisible();
    await expect(page.getByText(/dados são/i)).toBeVisible();
  });

  test("relatório com evidências reais: concluir um bloco de simulado mostra os fatos reais", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "evidencias");
    await generateRealEvidence(page);
    await page.goto("/relatorio-semanal");
    await expect(page.getByTestId("weekly-review-facts")).toBeVisible();
    await expect(page.getByText(/Questões confirmadas:/)).toBeVisible();
    await expect(page.getByText(/Blocos de Simulado concluídos:/)).toBeVisible();
    await expect(page.getByTestId("weekly-review-patterns")).toContainText("Mediana e Frequência");
  });

  test("comparação: indisponível quando a semana anterior não tem evidência comparável (comportamento factual)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "comparacao");
    await generateRealEvidence(page);
    await page.goto("/relatorio-semanal");
    await expect(page.getByTestId("weekly-review-comparison")).toContainText("indisponível");
  });
});

test.describe("Relatório Semanal — metas", () => {
  test("preview de meta sem escrita: ver sugestão nunca aplica a meta sozinho", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "preview-meta");
    await page.goto("/relatorio-semanal");
    await page.getByRole("button", { name: "Ver sugestão de meta" }).click();
    await expect(page.getByLabel("Minutos totais pretendidos")).toBeVisible();
    // Nenhuma meta foi criada só por ver a prévia — confirmado diretamente na API.
    const current = await (await page.request.get("/api/weekly-review/current")).json();
    expect(current.report.goal).toBeNull();
  });

  test("edição e aplicação: ajustar minutos e aplicar cria a meta ativa", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "aplicar-meta");
    await page.goto("/relatorio-semanal");
    await page.getByRole("button", { name: "Ver sugestão de meta" }).click();
    const minutesInput = page.getByLabel("Minutos totais pretendidos");
    await minutesInput.fill("200");
    await page.getByRole("button", { name: "Aplicar meta" }).click();
    await expect(page.getByTestId("weekly-review-goal-active")).toBeVisible();
    await expect(page.getByText("200 min")).toBeVisible();
  });

  test("retomada após refresh: a meta ativa continua visível depois de recarregar a página", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "retomada-meta");
    await page.goto("/relatorio-semanal");
    await page.getByRole("button", { name: "Ver sugestão de meta" }).click();
    await page.getByRole("button", { name: "Aplicar meta" }).click();
    await expect(page.getByTestId("weekly-review-goal-active")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("weekly-review-goal-active")).toBeVisible();
  });

  test("progresso real: meta ativa com evidência real mostra progresso factual, nunca porcentagem fabricada", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "progresso");
    await generateRealEvidence(page);
    await page.goto("/relatorio-semanal");
    await page.getByRole("button", { name: "Ver sugestão de meta" }).click();
    await page.getByRole("button", { name: "Aplicar meta" }).click();
    await expect(page.getByTestId("weekly-review-progress")).toBeVisible();
    await expect(page.getByText(/Minutos realizados versus pretendidos/)).toBeVisible();
    await expect(page.getByText(/Questões confirmadas versus pretendidas/)).toBeVisible();
  });

  test("conclusão: concluir a meta ativa mostra o estado 'meta concluída'", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "concluir-meta");
    await page.goto("/relatorio-semanal");
    await page.getByRole("button", { name: "Ver sugestão de meta" }).click();
    await page.getByRole("button", { name: "Aplicar meta" }).click();
    await expect(page.getByTestId("weekly-review-goal-active")).toBeVisible();
    await page.getByRole("button", { name: "Concluir meta" }).click();
    await expect(page.getByTestId("weekly-review-goal-completed")).toBeVisible();
  });

  test("abandono: abandonar a meta ativa mostra o estado 'meta abandonada' e permite nova sugestão", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "abandonar-meta");
    await page.goto("/relatorio-semanal");
    await page.getByRole("button", { name: "Ver sugestão de meta" }).click();
    await page.getByRole("button", { name: "Aplicar meta" }).click();
    await expect(page.getByTestId("weekly-review-goal-active")).toBeVisible();
    await page.getByRole("button", { name: "Abandonar meta" }).click();
    await expect(page.getByTestId("weekly-review-goal-abandoned")).toBeVisible();
    await expect(page.getByRole("button", { name: "Ver nova sugestão de meta" })).toBeVisible();
  });
});

test.describe("Relatório Semanal — Dashboard, mobile, teclado e segurança", () => {
  test("Dashboard mostra o card real 'Sua semana' com link para /relatorio-semanal", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "dashboard");
    await generateRealEvidence(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Sua semana" })).toBeVisible();
    // Espera o conteúdo REAL do card (busca assíncrona) antes de clicar —
    // nunca só o título estático da seção, que aparece antes do fetch
    // resolver.
    const reportLink = page.getByRole("link", { name: /Ver relatório/ });
    await expect(reportLink).toBeVisible();
    await reportLink.click();
    await expect(page).toHaveURL(/\/relatorio-semanal/);
  });

  test("mobile 390px: sem rolagem horizontal", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signedInStudent(page, "mobile-390");
    await generateRealEvidence(page);
    await page.goto("/relatorio-semanal");
    await expect(page.getByTestId("weekly-review-facts")).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test("teclado e foco: o foco vai para o título do relatório ao carregar (funcionamento por teclado, sem mouse)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "teclado");
    await page.goto("/relatorio-semanal");
    await expect(page.getByRole("heading", { name: "Relatório semanal" })).toBeFocused();
  });

  test("não autenticado: acessar /relatorio-semanal sem sessão redireciona para o login", async ({ page }) => {
    await page.goto("/relatorio-semanal");
    await expect(page).toHaveURL(/\/entrar/);
  });

  test("isolamento entre alunos: a meta de uma aluna nunca aparece para outra", async ({ page, browser }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "isolamento-a");
    await page.goto("/relatorio-semanal");
    await page.getByRole("button", { name: "Ver sugestão de meta" }).click();
    await page.getByRole("button", { name: "Aplicar meta" }).click();
    await expect(page.getByTestId("weekly-review-goal-active")).toBeVisible();

    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    await signedInStudent(otherPage, "isolamento-b");
    await otherPage.goto("/relatorio-semanal");
    await expect(otherPage.getByText("Você ainda não tem uma meta aplicada para esta semana.")).toBeVisible();
    await otherContext.close();
  });
});
