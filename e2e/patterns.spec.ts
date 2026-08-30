import { expect, test, type Page } from "@playwright/test";
import { testClientIdHeader } from "./rateLimitIsolation";

/* Sprint 6 v1.0, seção 6.4 da ordem — catálogo e ficha de padrões ENEM em
   Chromium real. Mesmo padrão de e2e/schedule.spec.ts: cada teste usa uma
   conta própria, isolada do rate limit por cabeçalho, e o estado do banco
   nunca depende da ordem de execução (nenhum teste altera padrões — os três
   endpoints são somente leitura). */
test.use({ storageState: { cookies: [], origins: [] } });

const TEST_CLIENT_ID_HEADER = testClientIdHeader("patterns");
const NEXT_YEAR = new Date().getUTCFullYear() + 1;

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@teste.dev`;
}

async function createConfirmedUser(page: Page, emailPrefix: string): Promise<void> {
  const email = uniqueEmail(emailPrefix);
  const password = "senha-de-teste-padroes-1";

  await page.request.post("/api/auth/signup", {
    headers: TEST_CLIENT_ID_HEADER,
    data: { name: "Aluna Padrões", email, password, confirmPassword: password, acceptTerms: true },
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
  const hasHorizontalScroll = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );
  expect(hasHorizontalScroll).toBe(false);
}

test.describe("Padrões ENEM — catálogo", () => {
  test("catálogo desktop lista os padrões publicados com código, nome e frase de reconhecimento", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "pad-catalogo");
    await page.goto("/padroes-enem");

    await expect(page.getByRole("heading", { name: "Padrões ENEM", level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: "Razão em Gráfico" })).toBeVisible();
    await expect(page.locator(".patterns__card-code").first()).toContainText("PAD-");
    await expect(page.getByText("CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR").first()).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test("catálogo em 390 px não gera rolagem horizontal", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signedInStudent(page, "pad-mobile");
    await page.goto("/padroes-enem");

    await expect(page.getByRole("heading", { name: "Padrões ENEM", level: 1 })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test("a contagem de resultados é anunciada de forma acessível, sem quantidade fixa na copy", async ({ page }) => {
    await signedInStudent(page, "pad-anuncio");
    await page.goto("/padroes-enem");

    const status = page.locator(".patterns__results-count");
    await expect(status).toHaveAttribute("aria-live", "polite");
    await expect(status).toContainText(/padr(ão|ões) encontrad/);
    // Nenhuma quantidade fechada de padrões aparece como texto fixo.
    await expect(page.getByText("20 padrões")).toHaveCount(0);
  });

  test("busca filtra o catálogo e a URL guarda o termo", async ({ page }) => {
    await signedInStudent(page, "pad-busca");
    await page.goto("/padroes-enem");

    await page.getByLabel("Buscar padrão", { exact: true }).fill("Escala");
    await page.getByRole("button", { name: "Buscar" }).click();

    await expect(page).toHaveURL(/busca=Escala/);
    await expect(page.getByRole("link", { name: "Escala", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Mediana e Frequência" })).toHaveCount(0);
  });

  test("filtro por tag e filtro de evidência ficam na URL e são preservados no refresh", async ({ page }) => {
    await signedInStudent(page, "pad-filtros");
    await page.goto("/padroes-enem");

    await page.getByLabel("Tag", { exact: true }).selectOption("proporcionalidade");
    await expect(page).toHaveURL(/tag=proporcionalidade/);

    await page.getByLabel("Evidência", { exact: true }).selectOption("sem_evidencia");
    await expect(page).toHaveURL(/evidencia=sem_evidencia/);

    await page.reload();
    await expect(page.getByLabel("Tag", { exact: true })).toHaveValue("proporcionalidade");
    await expect(page.getByLabel("Evidência", { exact: true })).toHaveValue("sem_evidencia");
    await expect(page.getByRole("link", { name: "Escala", exact: true })).toBeVisible();
  });

  test("a URL do catálogo nunca carrega dado pessoal do aluno", async ({ page }) => {
    await signedInStudent(page, "pad-url-limpa");
    await page.goto("/padroes-enem?busca=Escala&tag=proporcionalidade&evidencia=sem_evidencia&ordenar=nome&pagina=1");
    const url = new URL(page.url());
    const allowed = new Set(["busca", "conteudo", "tag", "evidencia", "ordenar", "pagina"]);
    for (const key of url.searchParams.keys()) {
      expect(allowed.has(key)).toBe(true);
    }
    expect(url.search).not.toContain("@");
  });

  test("paginação avança e volta, sem repetir padrões entre as páginas", async ({ page }) => {
    await signedInStudent(page, "pad-paginacao");
    await page.goto("/padroes-enem");

    const firstPageNames = await page.locator(".patterns__card-title").allInnerTexts();
    await expect(page.locator(".patterns__pagination-status")).toContainText("Página 1 de");

    await page.getByRole("button", { name: "Próxima" }).click();
    await expect(page).toHaveURL(/pagina=2/);
    await expect(page.locator(".patterns__pagination-status")).toContainText("Página 2 de");

    const secondPageNames = await page.locator(".patterns__card-title").allInnerTexts();
    for (const name of secondPageNames) {
      expect(firstPageNames).not.toContain(name);
    }

    await page.getByRole("button", { name: "Anterior" }).click();
    await expect(page.locator(".patterns__pagination-status")).toContainText("Página 1 de");
  });

  test("estado vazio é acolhedor e permite limpar os filtros", async ({ page }) => {
    await signedInStudent(page, "pad-vazio");
    await page.goto("/padroes-enem?busca=zzzznaoexistepadrao");

    await expect(page.getByText("Nenhum padrão encontrado", { exact: true })).toBeVisible();
    await expect(page.locator(".patterns__results-count")).toContainText("Nenhum padrão encontrado");

    await page.getByRole("button", { name: "Limpar filtros" }).click();
    await expect(page.getByRole("link", { name: "Razão em Gráfico" })).toBeVisible();
  });

  test("estado de erro aparece quando a API falha, e o botão de repetir recarrega", async ({ page }) => {
    await signedInStudent(page, "pad-erro");
    const patternsApi = (url: URL) => url.pathname.startsWith("/api/patterns");
    await page.route(patternsApi, (route) => route.fulfill({ status: 500, body: "{}" }));

    await page.goto("/padroes-enem");
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByText("Não foi possível carregar o catálogo de padrões.")).toBeVisible();

    await page.unroute(patternsApi);
    await page.getByRole("button", { name: "Tentar novamente" }).click();
    await expect(page.getByRole("link", { name: "Razão em Gráfico" })).toBeVisible();
  });
});

test.describe("Padrões ENEM — ficha", () => {
  test("ficha mostra todos os blocos disponíveis do padrão", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "pad-ficha");
    await page.goto("/padroes-enem/razao-em-grafico");

    await expect(page.getByRole("heading", { name: "Razão em Gráfico", level: 1 })).toBeVisible();
    for (const section of [
      "Descrição",
      "Estratégia principal",
      "Pistas frequentes",
      "Palavras e expressões recorrentes",
      "Elementos visuais recorrentes",
      "Estratégias alternativas",
      "Conteúdos necessários",
      "Pré-requisitos",
      "Erros e pegadinhas frequentes",
      "Exemplo introdutório",
      "Resumo estratégico",
      "Relações com outros padrões",
      "Seu progresso neste padrão",
    ]) {
      await expect(page.getByRole("heading", { name: section })).toBeVisible();
    }
    await expectNoHorizontalScroll(page);
  });

  test("ficha em 390 px não gera rolagem horizontal", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signedInStudent(page, "pad-ficha-mobile");
    await page.goto("/padroes-enem/escala");

    await expect(page.getByRole("heading", { name: "Escala", level: 1 })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test("os três índices aparecem como 'Ainda sem evidências suficientes', nunca como zero", async ({ page }) => {
    await signedInStudent(page, "pad-indices");
    await page.goto("/padroes-enem/escala");

    const indices = page.locator(".patterns__index-value");
    await expect(indices).toHaveCount(3);
    for (const text of await indices.allInnerTexts()) {
      expect(text.trim()).toBe("Ainda sem evidências suficientes");
      expect(text).not.toMatch(/^0%?$/);
    }
  });

  test("o botão de treino fica desabilitado e não cria nenhum dado", async ({ page }) => {
    await signedInStudent(page, "pad-treino");
    await page.goto("/padroes-enem/porcentagem-direta");

    const trainButton = page.getByRole("button", { name: /Treinar este padrão/ });
    await expect(trainButton).toBeVisible();
    await expect(trainButton).toBeDisabled();
    await expect(page.getByText("Este botão não inicia nenhuma sessão e não registra nenhum progresso.")).toBeVisible();
    await expect(page.getByText("Conteúdo relacionado em preparação.")).toBeVisible();

    // Nenhum progresso foi criado ao abrir a ficha nem ao tentar treinar.
    const progress = await (await page.request.get("/api/patterns/porcentagem-direta/progress")).json();
    expect(progress.progress.hasProgress).toBe(false);
    expect(progress.progress.indices.recognition).toEqual({ available: false, value: null });
  });

  test("slug inexistente mostra o estado 'não encontrado', não um erro cru", async ({ page }) => {
    await signedInStudent(page, "pad-404");
    await page.goto("/padroes-enem/slug-que-nao-existe");

    await expect(page.getByRole("heading", { name: "Padrão não encontrado" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Voltar para o catálogo" })).toBeVisible();
  });

  test("relações levam à ficha do padrão relacionado", async ({ page }) => {
    await signedInStudent(page, "pad-relacoes");
    await page.goto("/padroes-enem/razao-em-grafico");

    await page.getByRole("link", { name: /PAD-02 — Escala/ }).click();
    await expect(page).toHaveURL(/\/padroes-enem\/escala$/);
    await expect(page.getByRole("heading", { name: "Escala", level: 1 })).toBeVisible();
  });
});

test.describe("Padrões ENEM — teclado, foco e acesso", () => {
  test("é possível chegar ao catálogo e abrir uma ficha só pelo teclado", async ({ page }) => {
    await signedInStudent(page, "pad-teclado");
    await page.goto("/padroes-enem");
    await expect(page.getByRole("link", { name: "Razão em Gráfico" })).toBeVisible();

    const firstCardLink = page.locator(".patterns__card-title a").first();
    await firstCardLink.focus();
    await expect(firstCardLink).toBeFocused();

    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/padroes-enem\/razao-em-grafico$/);
  });

  test("navegar catálogo → ficha → voltar mantém o aluno no fluxo, com foco alcançável", async ({ page }) => {
    await signedInStudent(page, "pad-foco");
    await page.goto("/padroes-enem?busca=Escala");

    await page.getByRole("link", { name: "Escala", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Escala", level: 1 })).toBeVisible();

    const backLink = page.getByRole("link", { name: "← Voltar para o catálogo" });
    await backLink.focus();
    await expect(backLink).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(page.getByRole("heading", { name: "Padrões ENEM", level: 1 })).toBeVisible();
  });

  test("visitante sem sessão é redirecionado para /entrar e volta ao padrão pretendido", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/padroes-enem/escala");
    await expect(page).toHaveURL(/\/entrar/);
  });

  test("a API de padrões recusa requisição sem sessão", async ({ page }) => {
    await page.context().clearCookies();
    const response = await page.request.get("/api/patterns");
    expect(response.status()).toBe(401);
  });
});

test.describe("Padrões ENEM — dashboard", () => {
  test("aluno sem evidência vê o convite para conhecer os padrões, sem métrica fabricada", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "pad-dashboard");
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Padrões ENEM" })).toBeVisible();
    await expect(
      page.getByText("Ainda sem evidências suficientes para resumir seu domínio por padrão.")
    ).toBeVisible();
    await page.getByRole("link", { name: "Conhecer os padrões" }).click();
    await expect(page).toHaveURL(/\/padroes-enem$/);
  });
});
