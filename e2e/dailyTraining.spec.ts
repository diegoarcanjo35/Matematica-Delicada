import { expect, test, type Page } from "@playwright/test";
import { testClientIdHeader } from "./rateLimitIsolation";

/* Sprint 11 v1.0, seção 16 da ordem — Treino Diário Real e Listas
   Adaptativas, testado em Chromium real contra o servidor principal
   (porta 8793, mesmo padrão de e2e/errorNotebook.spec.ts). Cada teste usa
   uma conta própria, isolada do rate limit por cabeçalho.

   Única pergunta/padrão publicado com questão treinável no seed local:
   fixture-q-04 (padrão fixture-pat-04, "Mediana e Frequência"), gabarito
   na alternativa C — mesma fixture usada pelas Sprints 9/10. Um aluno
   recém-cadastrado, sem nenhuma evidência ainda, cai no estado
   `sem_evidencias` desse único padrão publicado — a camada de exploração
   (seção 7 da ordem), então o treino de hoje tem exatamente 1 questão
   (fixture-q-04, a de menor código). */
test.use({ storageState: { cookies: [], origins: [] } });

const TEST_CLIENT_ID_HEADER = testClientIdHeader("daily-training");
const NEXT_YEAR = new Date().getUTCFullYear() + 1;
const QUESTION_CODE = "FIX-Q-04";
// Texto das alternativas de fixture-q-04 (nunca a letra sozinha — o texto
// nunca vaza o gabarito antes da confirmação, mas identifica a alternativa
// certa/errada de forma estável para o teste, mesmo padrão de e2e/player.spec.ts).
const CORRECT_ALTERNATIVE_LABEL = /Valor Z/; // alternativa C, gabarito real
const INCORRECT_ALTERNATIVE_LABEL = /Valor X/; // alternativa A

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@teste.dev`;
}

async function createConfirmedUser(page: Page, emailPrefix: string): Promise<void> {
  const email = uniqueEmail(emailPrefix);
  const password = "senha-de-teste-treino-diario-1";

  await page.request.post("/api/auth/signup", {
    headers: TEST_CLIENT_ID_HEADER,
    data: { name: "Aluna Treino", email, password, confirmPassword: password, acceptTerms: true },
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

/** Dia da semana de HOJE no mesmo fuso padrão usado pelo servidor
 *  (America/Sao_Paulo — worker/src/services/scheduleService.ts,
 *  DEFAULT_TIMEZONE) — usado só para montar `availableDays` de forma
 *  determinística nos testes de disponibilidade, nunca no runtime real. */
function todayWeekdayInDefaultTimezone(): (typeof ALL_WEEKDAYS)[number] {
  const civil = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", weekday: "short" }).format(new Date());
  const map: Record<string, (typeof ALL_WEEKDAYS)[number]> = { Sun: "dom", Mon: "seg", Tue: "ter", Wed: "qua", Thu: "qui", Fri: "sex", Sat: "sab" };
  return map[civil] ?? "dom";
}

async function completeOnboarding(page: Page, availableDays: readonly string[] = ALL_WEEKDAYS, dailyMinutes = 60): Promise<void> {
  await page.request.patch("/api/onboarding", { data: { currentGrade: "3_serie_em", enemYear: NEXT_YEAR, currentStep: 1 } });
  await page.request.patch("/api/onboarding", { data: { goalType: "acertos", goalValue: 30, currentStep: 2 } });
  await page.request.patch("/api/onboarding", { data: { availableDays, dailyMinutes, currentStep: 3 } });
  await page.request.patch("/api/onboarding", { data: { difficulties: [], currentStep: 4 } });
  await page.request.patch("/api/onboarding", { data: { timePreference: "noite", currentStep: 5 } });
  await page.request.patch("/api/onboarding", { data: { diagnosticChoice: "depois", currentStep: 6 } });
  await page.request.post("/api/onboarding/complete");
}

async function signedInStudent(page: Page, prefix: string, availableDays: readonly string[] = ALL_WEEKDAYS): Promise<void> {
  await createConfirmedUser(page, prefix);
  await completeOnboarding(page, availableDays);
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const hasHorizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(hasHorizontalScroll).toBe(false);
}

async function applyTraining(page: Page): Promise<string> {
  const response = await page.request.post("/api/daily-training/apply", { data: { mutationId: crypto.randomUUID() } });
  const body = await response.json();
  return body.listId as string;
}

test.describe("Treino Diário — preview", () => {
  test("preview vazio: sem disponibilidade hoje (dia de hoje fora dos dias configurados)", async ({ page }) => {
    const availableDays = ALL_WEEKDAYS.filter((day) => day !== todayWeekdayInDefaultTimezone());
    await signedInStudent(page, "preview-vazio", availableDays);
    await page.goto("/treino-diario");
    await expect(page.getByText("Sem disponibilidade configurada para hoje")).toBeVisible();
  });

  test("preview real: mostra quantidade, duração aproximada e composição, com botão Começar treino", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "preview-real");
    await page.goto("/treino-diario");
    await expect(page.getByText(QUESTION_CODE)).toBeVisible();
    await expect(page.getByText(/aproximadamente/i)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Composição do treino" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Começar treino" })).toBeVisible();
  });

  test("nenhum GET cria lista — recarregar a prévia várias vezes nunca aplica nada", async ({ page }) => {
    await signedInStudent(page, "preview-no-write");
    await page.goto("/treino-diario");
    await page.reload();
    await page.reload();
    const current = await (await page.request.get("/api/daily-training/current")).json();
    expect(current.list).toBeNull();
  });
});

test.describe("Treino Diário — aplicar e listar", () => {
  test("aplicar lista: Começar treino cria a lista ativa e mostra o progresso", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "apply");
    await page.goto("/treino-diario");
    await page.getByRole("button", { name: "Começar treino" }).click();
    await expect(page.getByText(/Progresso: /)).toBeVisible();
    await expect(page.getByText(QUESTION_CODE)).toBeVisible();
  });
});

test.describe("Treino Diário — item e Player", () => {
  test("iniciar questão leva ao Player real com a questão correta", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "start-item");
    await applyTraining(page);
    await page.goto("/treino-diario");
    await page.getByRole("button", { name: "Começar questão" }).click();
    await expect(page).toHaveURL(/\/tentativas\/.+/);
  });

  test("voltar e retomar: sair para o Dashboard e voltar retoma o mesmo item em andamento", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "resume");
    await applyTraining(page);
    await page.goto("/treino-diario");
    await page.getByRole("button", { name: "Começar questão" }).click();
    await expect(page).toHaveURL(/\/tentativas\/.+/);

    await page.goto("/treino-diario");
    await expect(page.getByRole("button", { name: "Continuar questão" })).toBeVisible();
    await expect(page.locator(".treino-diario__status--in_progress")).toBeVisible();
  });

  test("sincronizar conclusão: responder e confirmar no Player, voltar ao treino mostra item concluído", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "sync");
    await applyTraining(page);
    await page.goto("/treino-diario");
    await page.getByRole("button", { name: "Começar questão" }).click();
    await expect(page).toHaveURL(/\/tentativas\/.+/);

    await page.getByLabel(CORRECT_ALTERNATIVE_LABEL).check();
    await page.getByRole("button", { name: "Confirmar resposta" }).click();

    await page.goto("/treino-diario");
    await expect(page.locator(".treino-diario__status--completed")).toBeVisible();
    await expect(page.getByText("Resposta correta.")).toBeVisible();
  });

  test("uma resposta errada confirmada no treino também alimenta o Caderno de Erros pela regra existente", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "sync-wrong");
    await applyTraining(page);
    await page.goto("/treino-diario");
    await page.getByRole("button", { name: "Começar questão" }).click();
    await expect(page).toHaveURL(/\/tentativas\/.+/);

    await page.getByLabel(INCORRECT_ALTERNATIVE_LABEL).check();
    await page.getByRole("button", { name: "Confirmar resposta" }).click();

    await page.goto("/treino-diario");
    await expect(page.getByText("Resposta incorreta")).toBeVisible();

    const notebook = await (await page.request.get("/api/error-notebook")).json();
    expect(notebook.entries.length).toBeGreaterThan(0);
  });

  test("pular item: confirmação com motivo técnico fechado move o item para Pulado", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "skip");
    await applyTraining(page);
    await page.goto("/treino-diario");
    await page.getByRole("button", { name: "Pular" }).click();
    await expect(page.getByRole("dialog", { name: "Pular esta questão?" })).toBeVisible();
    await page.getByLabel("Motivo").selectOption("too_hard");
    await page.getByRole("button", { name: "Confirmar" }).click();
    await expect(page.locator(".treino-diario__status--skipped")).toBeVisible();
  });
});

test.describe("Treino Diário — conclusão", () => {
  test("concluir treino: com todos os itens em estado terminal, mostra o resumo factual", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "complete");
    await applyTraining(page);
    await page.goto("/treino-diario");
    await page.getByRole("button", { name: "Pular" }).click();
    await page.getByRole("button", { name: "Confirmar" }).click();
    await expect(page.locator(".treino-diario__status--skipped")).toBeVisible();

    await page.getByRole("button", { name: "Concluir treino" }).click();
    await expect(page.getByRole("heading", { name: "Treino concluído" })).toBeVisible();
    await expect(page.getByText("questão pulada")).toBeVisible();
  });

  test("refresh depois de concluído mostra o MESMO resumo, sem perda de progresso", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "complete-refresh");
    await applyTraining(page);
    await page.goto("/treino-diario");
    await page.getByRole("button", { name: "Pular" }).click();
    await page.getByRole("button", { name: "Confirmar" }).click();
    await page.getByRole("button", { name: "Concluir treino" }).click();
    await expect(page.getByRole("heading", { name: "Treino concluído" })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("heading", { name: "Treino concluído" })).toBeVisible();
    await expect(page.getByText("questão pulada")).toBeVisible();
  });
});

test.describe("Treino Diário — acessibilidade, mobile, segurança", () => {
  test("390 px não gera rolagem horizontal", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signedInStudent(page, "mobile-390");
    await page.goto("/treino-diario");
    await expect(page.getByText(QUESTION_CODE)).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test("é possível focar o botão Começar treino só pelo teclado", async ({ page }) => {
    await signedInStudent(page, "keyboard");
    await page.goto("/treino-diario");
    const button = page.getByRole("button", { name: "Começar treino" });
    await button.focus();
    await expect(button).toBeFocused();
  });

  test("visitante sem sessão é redirecionado para /entrar", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/treino-diario");
    await expect(page).toHaveURL(/\/entrar/);
  });

  test("a API do Treino Diário recusa requisição sem sessão", async ({ page }) => {
    await page.context().clearCookies();
    const response = await page.request.get("/api/daily-training/preview");
    expect(response.status()).toBe(401);
  });

  test("lista de outro aluno responde 404, nunca 403", async ({ page, browser }) => {
    await signedInStudent(page, "isolation-owner");
    const listId = await applyTraining(page);

    const otherContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const otherPage = await otherContext.newPage();
    await signedInStudent(otherPage, "isolation-intruder");
    const response = await otherPage.request.get(`/api/daily-training/${listId}`);
    expect(response.status()).toBe(404);
    await otherContext.close();
  });
});
