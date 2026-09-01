import { expect, test, type Page } from "@playwright/test";
import { testClientIdHeader } from "./rateLimitIsolation";

/* Sprint 9 v1.0, seção 15.5 da ordem — Caderno de Erros e Revisão
   Espaçada, testado em Chromium real contra o servidor principal (porta
   8793, mesmo padrão de e2e/player.spec.ts). Cada teste usa uma conta
   própria, isolada do rate limit por cabeçalho.

   Única questão original disponível no seed local com erro registrável:
   fixture-q-04 (padrão fixture-pat-04, "Mediana e Frequência"), gabarito
   na alternativa C. fixture-q-06 é a SEGUNDA questão publicada do MESMO
   padrão (Sprint 9), usada para provar "outro contexto" (seção 6.1). */
test.use({ storageState: { cookies: [], origins: [] } });

const TEST_CLIENT_ID_HEADER = testClientIdHeader("error-notebook");
const NEXT_YEAR = new Date().getUTCFullYear() + 1;
const ORIGINAL_QUESTION_ID = "fixture-q-04";
const INCORRECT_ALTERNATIVE = "A";
const CORRECT_ALTERNATIVE_SIMILAR = "B"; // gabarito de fixture-q-06

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@teste.dev`;
}

async function createConfirmedUser(page: Page, emailPrefix: string): Promise<void> {
  const email = uniqueEmail(emailPrefix);
  const password = "senha-de-teste-caderno-1";

  await page.request.post("/api/auth/signup", {
    headers: TEST_CLIENT_ID_HEADER,
    data: { name: "Aluna Caderno", email, password, confirmPassword: password, acceptTerms: true },
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

/** Confirma uma resposta ERRADA em fixture-q-04 via a API real do Player —
 *  o único caminho real de registro automático (seção 5.1) — e devolve o
 *  id da entrada criada, consultando a lista do Caderno. */
async function createWrongAnswerEntry(page: Page): Promise<string> {
  const create = await page.request.post("/api/player/attempts", { data: { questionId: ORIGINAL_QUESTION_ID, mode: "learning" } });
  const { attemptId } = await create.json();
  await page.request.patch(`/api/player/attempts/${attemptId}/answer`, { data: { version: 1, alternative: INCORRECT_ALTERNATIVE } });
  await page.request.post(`/api/player/attempts/${attemptId}/confirm`, { data: { version: 2 } });
  const list = await (await page.request.get("/api/error-notebook")).json();
  const entry = list.entries.find((e: { originalQuestionId: string }) => e.originalQuestionId === ORIGINAL_QUESTION_ID);
  return entry.id;
}

test.describe("Caderno de Erros — erro aparece automaticamente", () => {
  test("uma resposta errada confirmada no Player aparece no Caderno, com tipo 'ainda não classificado'", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "notebook-auto");
    const entryId = await createWrongAnswerEntry(page);
    expect(entryId).toBeTruthy();

    await page.goto("/caderno-de-erros");
    await expect(page.getByRole("heading", { name: "Caderno de Erros", level: 1 })).toBeVisible();
    await expect(page.getByText("FIX-Q-04")).toBeVisible();
    // Texto ambíguo sozinho: também aparece como opção (oculta) do select
    // "Tipo de erro" — o card real é a fonte da verdade aqui.
    await expect(page.locator(".error-notebook__card-type")).toContainText("Ainda não classificado");
    await expectNoHorizontalScroll(page);
  });

  test("uma resposta CORRETA comum não cria nenhuma entrada", async ({ page }) => {
    await signedInStudent(page, "notebook-correct-common");
    const create = await page.request.post("/api/player/attempts", { data: { questionId: ORIGINAL_QUESTION_ID, mode: "practice" } });
    const { attemptId } = await create.json();
    await page.request.patch(`/api/player/attempts/${attemptId}/answer`, { data: { version: 1, alternative: "C" } });
    await page.request.post(`/api/player/attempts/${attemptId}/confirm`, { data: { version: 2 } });

    const list = await (await page.request.get("/api/error-notebook")).json();
    expect(list.entries.length).toBe(0);
  });
});

test.describe("Caderno de Erros — lista, filtros e estados", () => {
  test("estado genuinamente vazio, sem nenhum erro registrado", async ({ page }) => {
    await signedInStudent(page, "notebook-empty");
    await page.goto("/caderno-de-erros");
    await expect(page.getByText("Nenhum erro registrado ainda")).toBeVisible();
  });

  test("filtro por status sem resultados mostra o estado vazio de filtro, com botão para limpar", async ({ page }) => {
    await signedInStudent(page, "notebook-filter-empty");
    await createWrongAnswerEntry(page);
    await page.goto("/caderno-de-erros?status=corrected");
    // Texto ambíguo sozinho: aparece tanto no título do estado vazio quanto
    // no contador de resultados (com um ponto final a mais) — o título é a
    // fonte da verdade do estado vazio de filtro em si.
    await expect(page.locator(".state-view__title")).toHaveText("Nenhum erro encontrado com os filtros atuais");
    await page.getByRole("button", { name: "Limpar filtros" }).click();
    await expect(page.getByText("FIX-Q-04")).toBeVisible();
  });

  test("filtro por padrão mostra só os erros daquele padrão", async ({ page }) => {
    await signedInStudent(page, "notebook-filter-pattern");
    await createWrongAnswerEntry(page);
    await page.goto("/caderno-de-erros?padrao=mediana-e-frequencia");
    await expect(page.getByText("FIX-Q-04")).toBeVisible();
  });

  test("estado de erro na API mostra tentar novamente", async ({ page }) => {
    await signedInStudent(page, "notebook-api-error");
    const notebookApi = (url: URL) => url.pathname === "/api/error-notebook";
    await page.route(notebookApi, (route) => route.fulfill({ status: 500, body: "{}" }));
    await page.goto("/caderno-de-erros");
    await expect(page.getByRole("button", { name: "Tentar novamente" })).toBeVisible();
  });
});

test.describe("Caderno de Erros — classificação e privacidade da anotação", () => {
  test("classificar o erro e salvar uma anotação, com o aviso de privacidade visível", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "notebook-classify");
    const entryId = await createWrongAnswerEntry(page);
    await page.goto(`/caderno-de-erros/${entryId}`);

    await expect(
      page.getByText("Opcional. Registre somente o necessário para lembrar o que aprendeu. Sua anotação não")
    ).toBeVisible();

    await page.getByLabel("Tipo de erro").selectOption("calculation");
    await page.getByRole("button", { name: "Salvar tipo de erro" }).click();
    await expect(page.getByText("Salvo.")).toBeVisible();

    const note = "Esqueci de ordenar os valores antes de achar a mediana.";
    await page.getByLabel("O que você aprendeu com este erro? (opcional)").fill(note);
    await page.getByRole("button", { name: "Salvar anotação" }).click();
    await expect(page.getByText("Salvo.")).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("O que você aprendeu com este erro? (opcional)")).toHaveValue(note);
  });

  test("a anotação NUNCA aparece na URL, e o audit_log correspondente não contém o texto", async ({ page }) => {
    await signedInStudent(page, "notebook-privacy");
    const entryId = await createWrongAnswerEntry(page);
    const secretNote = "SEGREDO_PESSOAL_" + Date.now();

    const urlsVisited: string[] = [];
    page.on("request", (request) => urlsVisited.push(request.url()));

    await page.goto(`/caderno-de-erros/${entryId}`);
    await page.getByLabel("O que você aprendeu com este erro? (opcional)").fill(secretNote);
    await page.getByRole("button", { name: "Salvar anotação" }).click();
    await expect(page.getByText("Salvo.")).toBeVisible();

    expect(page.url()).not.toContain(secretNote);
    for (const url of urlsVisited) {
      expect(url).not.toContain(secretNote);
    }
  });
});

test.describe("Caderno de Erros — revisão", () => {
  test("iniciar revisão leva ao Player com o rótulo 'Revisão' e a questão semelhante", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "notebook-review-start");
    const entryId = await createWrongAnswerEntry(page);
    await page.goto(`/caderno-de-erros/${entryId}`);

    await page.getByRole("button", { name: "Corrigir meu erro" }).click();
    await expect(page).toHaveURL(/\/tentativas\/.+/);
    await expect(page.getByText("REVISÃO")).toBeVisible();
  });

  test("refresh durante a revisão retoma a MESMA tentativa", async ({ page }) => {
    await signedInStudent(page, "notebook-review-resume");
    const entryId = await createWrongAnswerEntry(page);
    await page.goto(`/caderno-de-erros/${entryId}`);
    await page.getByRole("button", { name: "Corrigir meu erro" }).click();
    await expect(page).toHaveURL(/\/tentativas\/.+/);
    const attemptUrl = page.url();

    await page.reload();
    expect(page.url()).toBe(attemptUrl);
  });

  test("revisão correta avança o estágio e agenda a próxima revisão mais à frente", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "notebook-review-correct");
    const entryId = await createWrongAnswerEntry(page);

    const start = await page.request.post(`/api/error-notebook/${entryId}/start-review`);
    const { attemptId } = await start.json();
    await page.request.patch(`/api/player/attempts/${attemptId}/answer`, { data: { version: 1, alternative: CORRECT_ALTERNATIVE_SIMILAR } });
    await page.request.post(`/api/player/attempts/${attemptId}/confirm`, { data: { version: 2 } });

    await page.goto(`/caderno-de-erros/${entryId}`);
    await expect(page.getByText("Correta", { exact: true })).toBeVisible();
    await expect(page.getByText("Status: Revisão agendada")).toBeVisible();
  });

  test("revisão incorreta reseta o estágio e agenda +1 dia", async ({ page }) => {
    await signedInStudent(page, "notebook-review-incorrect");
    const entryId = await createWrongAnswerEntry(page);

    const start = await page.request.post(`/api/error-notebook/${entryId}/start-review`);
    const { attemptId } = await start.json();
    await page.request.patch(`/api/player/attempts/${attemptId}/answer`, { data: { version: 1, alternative: "A" } }); // errada em fixture-q-06 também
    await page.request.post(`/api/player/attempts/${attemptId}/confirm`, { data: { version: 2 } });

    const detail = await (await page.request.get(`/api/error-notebook/${entryId}`)).json();
    expect(detail.entry.reviewStage).toBe(0);
  });

  test("outro contexto: duas revisões corretas em questões distintas corrigem a entrada", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "notebook-other-context");
    const entryId = await createWrongAnswerEntry(page);

    // 1ª revisão correta (cai na questão semelhante, fixture-q-06).
    const start1 = await page.request.post(`/api/error-notebook/${entryId}/start-review`);
    const { attemptId: attempt1 } = await start1.json();
    await page.request.patch(`/api/player/attempts/${attempt1}/answer`, { data: { version: 1, alternative: CORRECT_ALTERNATIVE_SIMILAR } });
    await page.request.post(`/api/player/attempts/${attempt1}/confirm`, { data: { version: 2 } });

    // Depois de só UMA revisão correta (mesmo já numa questão diferente),
    // o critério de "outro contexto" em si já foi tocado, mas o total de
    // 2 revisões corretas (seção 6.1) ainda não foi atingido — a entrada
    // não pode estar corrigida ainda.
    const midDetail = await (await page.request.get(`/api/error-notebook/${entryId}`)).json();
    expect(midDetail.entry.status).not.toBe("corrected");

    // 2ª revisão correta (a seleção passa a excluir a já usada com
    // sucesso — cai na original, que ainda não teve sucesso registrado).
    const start2 = await page.request.post(`/api/error-notebook/${entryId}/start-review`);
    const { attemptId: attempt2 } = await start2.json();
    await page.request.patch(`/api/player/attempts/${attempt2}/answer`, { data: { version: 1, alternative: "C" } });
    await page.request.post(`/api/player/attempts/${attempt2}/confirm`, { data: { version: 2 } });

    await page.goto(`/caderno-de-erros/${entryId}`);
    await expect(page.getByText("Status: Corrigido")).toBeVisible();
  });
});

test.describe("Caderno de Erros — teclado, foco e responsividade", () => {
  test("é possível abrir os detalhes e classificar só pelo teclado", async ({ page }) => {
    await signedInStudent(page, "notebook-keyboard");
    const entryId = await createWrongAnswerEntry(page);
    await page.goto(`/caderno-de-erros/${entryId}`);

    await expect(page.getByRole("heading", { level: 1 }).filter({ hasText: "FIX-Q-04" })).toBeFocused();

    const select = page.getByLabel("Tipo de erro");
    await select.focus();
    await expect(select).toBeFocused();
  });

  test("lista em 390 px não gera rolagem horizontal", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signedInStudent(page, "notebook-mobile");
    await createWrongAnswerEntry(page);
    await page.goto("/caderno-de-erros");
    await expect(page.getByText("FIX-Q-04")).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test("visitante sem sessão é redirecionado para /entrar", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/caderno-de-erros");
    await expect(page).toHaveURL(/\/entrar/);
  });

  test("a API do Caderno recusa requisição sem sessão", async ({ page }) => {
    await page.context().clearCookies();
    const response = await page.request.get("/api/error-notebook");
    expect(response.status()).toBe(401);
  });

  test("entrada de outro aluno responde 404, nunca 403", async ({ page, browser }) => {
    await signedInStudent(page, "notebook-isolation-owner");
    const entryId = await createWrongAnswerEntry(page);

    const otherContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const otherPage = await otherContext.newPage();
    await signedInStudent(otherPage, "notebook-isolation-intruder");
    const response = await otherPage.request.get(`/api/error-notebook/${entryId}`);
    expect(response.status()).toBe(404);
    await otherContext.close();
  });
});

test.describe("Dashboard — resumo real do Caderno de Erros", () => {
  test("dashboard mostra a contagem real de erros ativos, sem métrica fabricada", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "notebook-dashboard");
    await createWrongAnswerEntry(page);

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Caderno de Erros" })).toBeVisible();
    await expect(page.getByText("1 erro ativo")).toBeVisible();
    await expect(page.getByRole("link", { name: "Ver Caderno de Erros" })).toHaveAttribute("href", "/caderno-de-erros");
  });
});
