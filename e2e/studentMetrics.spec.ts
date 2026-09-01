import { expect, test, type Page } from "@playwright/test";
import { testClientIdHeader } from "./rateLimitIsolation";

/* Sprint 10 v1.0, seção 15 da ordem — Métricas Centrais e Mapa ENEM do
   Aluno, testado em Chromium real contra o servidor principal (porta 8793,
   mesmo padrão de e2e/errorNotebook.spec.ts). Cada teste usa uma conta
   própria, isolada do rate limit por cabeçalho.

   Única questão original publicada com padrão principal e evidência
   praticável no seed local: fixture-q-04 (padrão fixture-pat-04,
   "Mediana e Frequência", slug mediana-e-frequencia), gabarito na
   alternativa C. fixture-q-06 é a SEGUNDA questão publicada do MESMO
   padrão (Sprint 9), gabarito B — usada aqui só para variar evidência
   quando um teste precisa de mais de uma tentativa confirmada. Os outros
   quatro padrões do seed (PAD-01/02/03/05) nunca têm questão publicada, e
   por isso permanecem sempre em `sem_evidencias` nestes testes — o que é
   deliberadamente aproveitado para o cenário "mapa vazio". */
test.use({ storageState: { cookies: [], origins: [] } });

const TEST_CLIENT_ID_HEADER = testClientIdHeader("student-metrics");
const NEXT_YEAR = new Date().getUTCFullYear() + 1;
const ORIGINAL_QUESTION_ID = "fixture-q-04";
const SIMILAR_QUESTION_ID = "fixture-q-06";
const CORRECT_ALTERNATIVE = "C"; // gabarito de fixture-q-04
const INCORRECT_ALTERNATIVE = "A";
const PATTERN_SLUG = "mediana-e-frequencia";
const PATTERN_CODE = "PAD-04";
const PATTERN_NAME = "Mediana e Frequência";

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@teste.dev`;
}

async function createConfirmedUser(page: Page, emailPrefix: string): Promise<void> {
  const email = uniqueEmail(emailPrefix);
  const password = "senha-de-teste-metricas-1";

  await page.request.post("/api/auth/signup", {
    headers: TEST_CLIENT_ID_HEADER,
    data: { name: "Aluna Métricas", email, password, confirmPassword: password, acceptTerms: true },
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

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const hasHorizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(hasHorizontalScroll).toBe(false);
}

/** Confirma uma resposta (correta ou não) numa questão publicada via a API
 *  real do Player — o único caminho real de registro de evidência (mesma
 *  convenção de e2e/errorNotebook.spec.ts:createWrongAnswerEntry). */
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
 *  Caderno de Erros (Sprint 9) — usada aqui para exercitar o CTA "Ir para o
 *  Caderno de Erros" e o filtro "Só com entrada ativa no Caderno de Erros". */
async function createActiveErrorEntry(page: Page): Promise<void> {
  await answerQuestion(page, ORIGINAL_QUESTION_ID, INCORRECT_ALTERNATIVE, "learning");
}

test.describe("Mapa ENEM — mapa vazio", () => {
  test("aluno sem nenhuma tentativa vê o estado honesto de ausência de evidência, nunca um 0%", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "mapa-vazio");
    await page.goto("/mapa-enem");
    await expect(page.getByRole("heading", { name: "Mapa ENEM", level: 1 })).toBeVisible();
    // Texto ambíguo sozinho: também aparece na explicação recolhida ("Como
    // ler esses dados") e como opção do select "Estado" — o título do
    // estado vazio real é a fonte da verdade aqui (mesmo padrão de
    // e2e/errorNotebook.spec.ts: locator(".state-view__title")).
    await expect(page.locator(".state-view__title")).toHaveText("Ainda sem evidências suficientes");
    await expect(page.getByText("0%")).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  });
});

test.describe("Mapa ENEM — mapa com evidências", () => {
  test("uma tentativa confirmada aparece agrupada fora de 'sem_evidencias', com acertos/erros e questões distintas", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "mapa-evidencias");
    await answerQuestion(page, ORIGINAL_QUESTION_ID, CORRECT_ALTERNATIVE, "learning");

    await page.goto("/mapa-enem");
    // Os outros quatro padrões do seed também aparecem, todos em
    // "sem_evidencias" com "Questões confirmadas: 0" — por isso a
    // verificação é escopada ao card do próprio PAD-04, nunca a um texto
    // solto repetido em vários cards.
    const card = page.locator(".mapa-enem__card", { hasText: PATTERN_NAME });
    await expect(card).toBeVisible();
    await expect(card.getByText(PATTERN_CODE)).toBeVisible();
    await expect(card).toContainText("Questões confirmadas:");
    await expect(card).toContainText("1 (1 certas, 0 erradas)");
  });
});

test.describe("Mapa ENEM — filtros e busca", () => {
  test("busca por código filtra a lista para o padrão correspondente", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "mapa-busca");
    await answerQuestion(page, ORIGINAL_QUESTION_ID, CORRECT_ALTERNATIVE, "learning");
    await page.goto("/mapa-enem");

    await page.getByLabel("Buscar por padrão").fill(PATTERN_CODE);
    await expect(page).toHaveURL(/busca=PAD-04/);
    await expect(page.getByText(PATTERN_NAME)).toBeVisible();
    await expect(page.getByText("Escala")).toHaveCount(0);
  });

  test("filtro por estado 'Evidências iniciais' mostra só padrões nesse estado", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "mapa-filtro-estado");
    await answerQuestion(page, ORIGINAL_QUESTION_ID, CORRECT_ALTERNATIVE, "learning");
    await page.goto("/mapa-enem");

    await page.getByLabel("Estado").selectOption("evidencias_iniciais");
    await expect(page).toHaveURL(/estado=evidencias_iniciais/);
    await expect(page.getByText(PATTERN_NAME)).toBeVisible();
  });

  test("filtro 'Só com entrada ativa no Caderno de Erros' mostra só padrões com erro pendente", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "mapa-filtro-caderno");
    await createActiveErrorEntry(page);
    await page.goto("/mapa-enem");

    await page.getByLabel("Só com entrada ativa no Caderno de Erros").check();
    await expect(page).toHaveURL(/caderno=true/);
    await expect(page.getByText(PATTERN_NAME)).toBeVisible();
  });

  test("filtros sem nenhum resultado mostram o estado vazio de filtro, com botão para limpar", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "mapa-filtro-vazio");
    await answerQuestion(page, ORIGINAL_QUESTION_ID, CORRECT_ALTERNATIVE, "learning");
    await page.goto("/mapa-enem?estado=consistente_no_recorte");

    // Texto ambíguo sozinho: também aparece (com um ponto final a mais) no
    // contador de resultados acima da lista — o título do estado vazio de
    // filtro é a fonte da verdade aqui (mesmo padrão do Caderno de Erros).
    await expect(page.locator(".state-view__title")).toHaveText("Nenhum padrão encontrado com os filtros atuais");
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    await expect(page.getByText(PATTERN_NAME)).toBeVisible();
  });
});

test.describe("Mapa ENEM — detalhe do padrão", () => {
  test("detalhe mostra evidência por modo, revisões, evolução e próximo passo, sem dado sensível", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "mapa-detalhe");
    await answerQuestion(page, ORIGINAL_QUESTION_ID, CORRECT_ALTERNATIVE, "learning");

    await page.goto(`/mapa-enem/${PATTERN_SLUG}`);
    await expect(page.getByRole("heading", { name: PATTERN_NAME, level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Evidência geral" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Evidência por modo" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Revisões do Caderno de Erros" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Evolução cronológica" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Próximo passo recomendado" })).toBeVisible();
    await expect(page.getByText(/nota estilo TRI/)).toBeVisible();

    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toMatch(/token/i);
    expect(bodyText).not.toContain("fixture-q-04");
  });
});

test.describe("Mapa ENEM — CTA para treino", () => {
  test("'Treinar este padrão' leva à tela real de início da questão", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "mapa-cta-treino");
    await page.goto(`/mapa-enem/${PATTERN_SLUG}`);

    await expect(page.getByRole("link", { name: "Treinar este padrão" })).toBeVisible();
    await page.getByRole("link", { name: "Treinar este padrão" }).click();
    await expect(page).toHaveURL(/\/questoes\/.+/);
  });
});

test.describe("Mapa ENEM — CTA para Caderno de Erros", () => {
  test("com pendência ativa, o CTA aparece na lista e no detalhe e leva ao Caderno filtrado pelo padrão", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "mapa-cta-caderno");
    await createActiveErrorEntry(page);

    await page.goto("/mapa-enem");
    await expect(page.getByRole("link", { name: "Ir para o Caderno de Erros" }).first()).toBeVisible();

    await page.goto(`/mapa-enem/${PATTERN_SLUG}`);
    await page.getByRole("link", { name: "Ir para o Caderno de Erros" }).click();
    await expect(page).toHaveURL(/\/caderno-de-erros\?padrao=mediana-e-frequencia/);
  });

  test("sem pendência ativa, o CTA para o Caderno não aparece", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "mapa-sem-cta-caderno");
    await answerQuestion(page, ORIGINAL_QUESTION_ID, CORRECT_ALTERNATIVE, "learning");

    await page.goto(`/mapa-enem/${PATTERN_SLUG}`);
    await expect(page.getByRole("link", { name: "Ir para o Caderno de Erros" })).toHaveCount(0);
  });
});

test.describe("Dashboard — resumo real do Mapa ENEM", () => {
  test("dashboard mostra evidência real, sem fórmula de domínio, e link para o mapa completo", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "mapa-dashboard");
    await answerQuestion(page, ORIGINAL_QUESTION_ID, CORRECT_ALTERNATIVE, "learning");

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Seu Mapa ENEM" })).toBeVisible();
    await expect(page.getByText(/padrões já têm alguma evidência registrada/)).toBeVisible();
    await expect(page.getByText(/Nenhuma nota estilo TRI ou domínio definitivo/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Ver Mapa ENEM completo" })).toHaveAttribute("href", "/mapa-enem");
  });

  test("dashboard de aluno sem nenhuma tentativa mostra o convite honesto, nunca um número fabricado", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "mapa-dashboard-vazio");
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Seu Mapa ENEM" })).toBeVisible();
    await expect(page.getByText("Ainda sem evidências suficientes registradas em nenhum padrão")).toBeVisible();
  });
});

test.describe("Mapa ENEM — mobile 390px", () => {
  test("lista e detalhe em 390 px não geram rolagem horizontal", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signedInStudent(page, "mapa-mobile");
    await answerQuestion(page, ORIGINAL_QUESTION_ID, CORRECT_ALTERNATIVE, "learning");

    await page.goto("/mapa-enem");
    await expect(page.getByText(PATTERN_NAME)).toBeVisible();
    await expectNoHorizontalScroll(page);

    await page.goto(`/mapa-enem/${PATTERN_SLUG}`);
    await expect(page.getByRole("heading", { name: PATTERN_NAME, level: 1 })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});

test.describe("Mapa ENEM — teclado e foco", () => {
  test("os filtros são alcançáveis e operáveis só pelo teclado, com foco visível", async ({ page }) => {
    await signedInStudent(page, "mapa-teclado");
    await answerQuestion(page, ORIGINAL_QUESTION_ID, CORRECT_ALTERNATIVE, "learning");
    await page.goto("/mapa-enem");

    const searchInput = page.getByLabel("Buscar por padrão");
    await searchInput.focus();
    await expect(searchInput).toBeFocused();
    // pressSequentially com atraso (nunca .fill(), que não dispara eventos
    // reais de teclado, nem keyboard.type() sem atraso): o campo é
    // controlado pela URL (useSearchParams) — cada tecla dispara uma
    // re-renderização do React Router, e digitar rápido demais intercala
    // com essa re-renderização e derruba caracteres.
    await searchInput.pressSequentially(PATTERN_CODE, { delay: 60 });
    await expect(searchInput).toHaveValue(PATTERN_CODE);
    await expect(page).toHaveURL(/busca=PAD-04/);

    const stateSelect = page.getByLabel("Estado");
    await stateSelect.focus();
    await expect(stateSelect).toBeFocused();
  });
});

test.describe("Mapa ENEM — aluno não autenticado", () => {
  test("visitante sem sessão é redirecionado para /entrar", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/mapa-enem");
    await expect(page).toHaveURL(/\/entrar/);
  });

  test("as APIs do Mapa ENEM recusam requisição sem sessão", async ({ page }) => {
    await page.context().clearCookies();
    const summary = await page.request.get("/api/student-metrics/summary");
    expect(summary.status()).toBe(401);
    const patterns = await page.request.get("/api/student-metrics/patterns");
    expect(patterns.status()).toBe(401);
    const detail = await page.request.get(`/api/student-metrics/patterns/${PATTERN_SLUG}`);
    expect(detail.status()).toBe(401);
    const activity = await page.request.get("/api/student-metrics/activity");
    expect(activity.status()).toBe(401);
  });
});

test.describe("Mapa ENEM — tentativa de acesso cruzado", () => {
  test("a evidência de um aluno nunca aparece na leitura de outro aluno para o mesmo padrão", async ({ page, browser }) => {
    await signedInStudent(page, "mapa-cross-owner");
    await answerQuestion(page, ORIGINAL_QUESTION_ID, CORRECT_ALTERNATIVE, "learning");
    await answerQuestion(page, SIMILAR_QUESTION_ID, "B", "practice");

    const otherContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const otherPage = await otherContext.newPage();
    await signedInStudent(otherPage, "mapa-cross-intruder");

    const response = await otherPage.request.get(`/api/student-metrics/patterns/${PATTERN_SLUG}`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.pattern.questionsConfirmed).toBe(0);
    expect(body.pattern.correctCount).toBe(0);
    expect(body.pattern.state).toBe("sem_evidencias");

    await otherPage.goto(`/mapa-enem/${PATTERN_SLUG}`);
    await expect(otherPage.getByText("Ainda sem evidências suficientes")).toBeVisible();
    await otherContext.close();
  });
});
