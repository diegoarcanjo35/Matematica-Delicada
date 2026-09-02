import { expect, test, type Page } from "@playwright/test";
import { testClientIdHeader } from "../e2e/rateLimitIsolation";

/* Sprint 12 v1.0, seção 21 da ordem — as ONZE evidências visuais
   obrigatórias dos Simulados em Blocos e Análise Factual de Desempenho,
   geradas por automação real. Mesmo padrão das evidências das sprints
   anteriores (ver evidence/sprint-11-screenshots.spec.ts): conta própria
   por teste, dados evidentemente fictícios/fixture do seed local, sem
   nenhum dado sensível visível, isolamento de rate limit por cabeçalho.

   Único padrão publicado com questões PUBLICADAS treináveis no seed local:
   fixture-pat-04 ("Mediana e Frequência", slug mediana-e-frequencia) — duas
   questões (fixture-q-04, gabarito C; fixture-q-06). Qualquer bloco
   (misto ou focado) pedido nos tamanhos 5/10/15 encontra no máximo 2
   questões disponíveis — a mesma base de fixtures que fez
   e2e/dailyTraining.spec.ts sempre ter 1 único item elegível também faz da
   "quantidade insuficiente" o estado real e honesto para este seed, nunca
   um cenário artificial. fixture-pat-01 ("Razão em Gráfico", slug
   razao-em-grafico) é publicado, mas sua única questão está em draft — não
   usado nestas capturas específicas (reservado ao preview vazio, já coberto
   por e2e/simulations.spec.ts). */
test.use({ storageState: { cookies: [], origins: [] } });

const TEST_CLIENT_ID_HEADER = testClientIdHeader("sprint-12-screenshots");
const NEXT_YEAR = new Date().getUTCFullYear() + 1;
const SHOTS_DIR = "evidence/screenshots/sprint-12";
const CORRECT_ALTERNATIVE_LABEL = /Valor Z/; // fixture-q-04, alternativa C

function uniqueEmail(prefix: string): string {
  return `evidencia-sprint12-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@evidencia.teste`;
}

async function createConfirmedUser(page: Page, prefix: string): Promise<void> {
  const email = uniqueEmail(prefix);
  const password = "senha-evidencia-fake-simulados-1";

  await page.request.post("/api/auth/signup", {
    headers: TEST_CLIENT_ID_HEADER,
    data: { name: "Aluna Demonstração Sprint12", email, password, confirmPassword: password, acceptTerms: true },
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

async function applyMixedBlock(page: Page, size = 5): Promise<string> {
  const response = await page.request.post("/api/simulations/apply", { data: { mutationId: crypto.randomUUID(), blockType: "mixed", size } });
  const body = await response.json();
  return body.blockId as string;
}

test.describe("Evidências visuais — Sprint 12 (Simulados em Blocos e Análise Factual de Desempenho)", () => {
  test("simulados-configuracao", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "configuracao");
    await page.goto("/simulados");
    await expect(page.getByRole("heading", { name: "Configurar bloco" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/simulados-configuracao.png`, fullPage: true });
  });

  test("simulados-preview-misto", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "preview-misto");
    await page.goto("/simulados");
    await page.getByLabel(/Misto/).check();
    await page.getByLabel("5 questões", { exact: true }).check();
    await page.getByRole("button", { name: "Ver prévia" }).click();
    await expect(page.getByRole("heading", { name: "Composição" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/simulados-preview-misto.png`, fullPage: true });
  });

  test("simulados-preview-focado", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "preview-focado");
    await page.goto("/simulados");
    await page.getByLabel(/Focado em um padrão/).check();
    await page.locator("#pattern-select").selectOption({ label: "Mediana e Frequência" });
    await page.getByRole("button", { name: "Ver prévia" }).click();
    await expect(page.getByRole("heading", { name: "Composição" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/simulados-preview-focado.png`, fullPage: true });
  });

  test("simulados-quantidade-insuficiente", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "insuficiente");
    await page.goto("/simulados");
    await page.getByLabel("15 questões").check();
    await page.getByRole("button", { name: "Ver prévia" }).click();
    await expect(page.getByText(/Ainda não há questões publicadas suficientes/i)).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/simulados-quantidade-insuficiente.png`, fullPage: true });
  });

  test("simulado-bloco-ativo", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "bloco-ativo");
    const blockId = await applyMixedBlock(page);
    await page.goto(`/simulados/${blockId}`);
    await expect(page.getByText(/Progresso: /)).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/simulado-bloco-ativo.png`, fullPage: true });
  });

  test("simulado-item-em-andamento", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "item-andamento");
    const blockId = await applyMixedBlock(page);
    await page.goto(`/simulados/${blockId}`);
    await page.getByRole("button", { name: "Começar questão" }).first().click();
    await expect(page).toHaveURL(/\/tentativas\/.+/);
    await page.goto(`/simulados/${blockId}`);
    await expect(page.locator(".simulados__status--in_progress")).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/simulado-item-em-andamento.png`, fullPage: true });
  });

  test("simulado-retomada", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "retomada");
    const blockId = await applyMixedBlock(page);
    await page.goto(`/simulados/${blockId}`);
    await page.getByRole("button", { name: "Começar questão" }).first().click();
    await expect(page).toHaveURL(/\/tentativas\/.+/);
    await page.goto(`/simulados/${blockId}`);
    await expect(page.getByRole("button", { name: "Continuar questão" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Continuar questão" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/simulado-retomada.png`, fullPage: true });
  });

  test("simulado-resultado-final", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "resultado-final");
    const blockId = await applyMixedBlock(page);
    await page.goto(`/simulados/${blockId}`);
    await page.getByRole("button", { name: "Começar questão" }).first().click();
    await expect(page).toHaveURL(/\/tentativas\/.+/);
    await page.getByLabel(CORRECT_ALTERNATIVE_LABEL).check();
    await page.getByRole("button", { name: "Confirmar resposta" }).click();
    await page.goto(`/simulados/${blockId}`);
    await expect(page.locator(".simulados__status--completed")).toBeVisible();
    // Segunda questão pulada para alcançar o estado terminal em todos os
    // itens (seção 12 da ordem: só conclui com todos os itens terminais).
    const skipButton = page.getByRole("button", { name: "Pular" });
    if (await skipButton.count()) {
      await skipButton.first().click();
      await page.getByRole("button", { name: "Confirmar" }).click();
    }
    await page.getByRole("button", { name: "Concluir bloco" }).click();
    await expect(page.getByRole("heading", { name: "Bloco concluído" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/simulado-resultado-final.png`, fullPage: true });
  });

  test("simulados-historico", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "historico");
    const blockId = await applyMixedBlock(page);
    await page.goto(`/simulados/${blockId}`);
    // Aguarda o bloco terminar de carregar antes de contar botões "Pular" —
    // `.count()` do Playwright não espera elementos aparecerem (diferente
    // de `.click()`), então contar antes do fetch assíncrono do bloco
    // terminar sempre devolveria 0 (mesma correção aplicada em
    // e2e/simulations.spec.ts:waitForActiveBlockLoaded).
    await expect(page.getByText(/Progresso: /)).toBeVisible();
    const skipButtons = page.getByRole("button", { name: "Pular" });
    const count = await skipButtons.count();
    for (let i = 0; i < count; i++) {
      await page.getByRole("button", { name: "Pular" }).first().click();
      await page.getByRole("button", { name: "Confirmar" }).click();
    }
    await page.getByRole("button", { name: "Concluir bloco" }).click();
    await expect(page.getByRole("heading", { name: "Bloco concluído" })).toBeVisible();

    await page.goto("/simulados");
    await expect(page.getByRole("heading", { name: "Histórico de simulados" })).toBeVisible();
    await expect(page.getByText("Concluído")).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/simulados-historico.png`, fullPage: true });
  });

  test("simulados-mobile-390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signedInStudent(page, "mobile-390");
    const blockId = await applyMixedBlock(page);
    await page.goto(`/simulados/${blockId}`);
    await expect(page.getByText(/Progresso: /)).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/simulados-mobile-390px.png` });
  });

  test("dashboard-simulado-real", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "dashboard");
    await applyMixedBlock(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Simulados em blocos" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Continuar bloco" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/dashboard-simulado-real.png` });
  });
});
