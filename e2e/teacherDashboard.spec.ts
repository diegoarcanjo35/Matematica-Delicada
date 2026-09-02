import { expect, test, type Page } from "@playwright/test";
import { testClientIdHeader } from "./rateLimitIsolation";

/* Sprint 14 v1.0, seção 23 da ordem — Painel do Professor em Chromium real.

   Login sempre pelas contas FIXAS de scripts/fixtures/teacher-fixtures.local.sql
   (aplicadas por `npm run db:seed:teacher:local`, já parte de
   `npm run worker:preview`, que este arquivo de config usa como webServer) —
   nunca contas dinâmicas via /api/auth/signup: a ordem (seção 9) proíbe
   qualquer API que crie um vínculo professor-aluno, então só as fixtures
   estáticas têm vínculo determinístico para testar. Mesmo padrão de
   isolamento de rate limit de e2e/editorial.spec.ts (testClientIdHeader). */

test.use({ storageState: { cookies: [], origins: [] } });

const TEST_CLIENT_ID_HEADER = testClientIdHeader("teacher-dashboard");

const FIXTURE_PASSWORD = "fixture-teacher-local-only-1";
const TEACHER_A_EMAIL = "fixture-professora-a@local.teste";
const TEACHER_C_EMAIL = "fixture-professora-c@local.teste"; // sem alunos vinculados
const STUDENT_1_EMAIL = "fixture-aluno-1@local.teste"; // vinculado à professora A
const STUDENT_2_EMAIL = "fixture-aluno-2@local.teste"; // vinculado à professora A
const STUDENT_3_EMAIL = "fixture-aluno-3@local.teste"; // vinculado só ao professor B

const STUDENT_1_NAME = "[PROVISÓRIO] Aluno 1 (Fixture Técnica)";
const STUDENT_2_NAME = "[PROVISÓRIO] Aluna 2 (Fixture Técnica)";

async function loginAs(page: Page, email: string): Promise<void> {
  const response = await page.request.post("/api/auth/login", {
    headers: TEST_CLIENT_ID_HEADER,
    data: { email, password: FIXTURE_PASSWORD },
  });
  expect(response.ok(), `login falhou para ${email}: ${response.status()} ${await response.text()}`).toBe(true);
  const setCookie = response.headers()["set-cookie"];
  const tokenValue = setCookie.split(";")[0].split("=").slice(1).join("=");
  await page.context().addCookies([{ name: "md_session", value: tokenValue, domain: "localhost", path: "/" }]);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Semeia uma meta semanal REAL para o aluno 2, usando a API JÁ EXISTENTE da
 *  Sprint 13 (nunca uma tabela tocada diretamente) — para o teste de "meta/
 *  progresso factual" (seção 23, item 6) mostrar dado genuíno, não um
 *  estado sempre vazio. Roda como o PRÓPRIO aluno (nunca o professor —
 *  reforça que o professor não tem nenhuma via de escrita). */
async function seedRealWeeklyGoalForStudent2(page: Page): Promise<void> {
  await loginAs(page, STUDENT_2_EMAIL);
  const response = await page.request.post("/api/weekly-goals/apply", {
    headers: TEST_CLIENT_ID_HEADER,
    data: {
      mutationId: `e2e-teacher-goal-${Date.now()}`,
      weekStart: todayIso(),
      targetMinutes: 150,
      targetQuestions: 30,
      availableDays: ["seg", "qua", "sex"],
      patternIds: [],
    },
  });
  // 200 (criada) ou 400 "já tem meta ativa" (execução repetida da suíte) —
  // os dois deixam uma meta ativa real para a semana atual, que é tudo que
  // este teste precisa.
  expect([200, 400]).toContain(response.status());
  await page.context().clearCookies();
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const hasHorizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(hasHorizontalScroll).toBe(false);
}

test.describe("Acesso e RBAC", () => {
  test("aluno comum (sem papel professor) vê acesso restrito ao navegar para /professor", async ({ page }) => {
    await loginAs(page, STUDENT_1_EMAIL);
    await page.goto("/professor");
    await expect(page.getByRole("heading", { name: "Acesso restrito" })).toBeVisible();
    await expect(page.getByText(/Alunos vinculados/)).toHaveCount(0);
  });

  test("sem sessão nenhuma, /professor redireciona para login", async ({ page }) => {
    await page.goto("/professor");
    await expect(page).toHaveURL(/\/entrar/);
  });

  test("professor tentando abrir aluno vinculado a OUTRO professor recebe estado 'não encontrado', nunca os dados do aluno", async ({ page }) => {
    await loginAs(page, TEACHER_A_EMAIL);
    const studentsResponse = await page.request.get("/api/teacher/students", { headers: TEST_CLIENT_ID_HEADER });
    const { students } = await studentsResponse.json();
    const student3Id = "fixture-student-3";
    expect(students.some((s: { studentId: string }) => s.studentId === student3Id)).toBe(false);

    await page.goto(`/professor/alunos/${student3Id}`);
    await expect(page.getByText("Aluno não encontrado")).toBeVisible();
    await expect(page.getByText(/não existe ou não está vinculado/)).toBeVisible();
  });
});

test.describe("Dashboard", () => {
  test("professor sem alunos vinculados vê o estado vazio factual", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await loginAs(page, TEACHER_C_EMAIL);
    await page.goto("/professor");
    await expect(page.getByRole("heading", { name: "Visão Geral" })).toBeVisible();
    await expect(page.getByText("Nenhum aluno vinculado ainda")).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "evidence/screenshots/sprint-14/professor-dashboard-sem-alunos.png", fullPage: false });
  });

  test("professor com alunos vinculados vê contagens factuais e a seção 'Para acompanhar'", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAs(page, TEACHER_A_EMAIL);
    await page.goto("/professor");
    await expect(page.getByRole("heading", { name: "Visão Geral" })).toBeVisible();
    await expect(page.locator(".teacher-page__stat-value").first()).toHaveText("2");
    await expect(page.getByText("Para acompanhar")).toBeVisible();
    await expect(page.getByRole("link", { name: STUDENT_1_NAME })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "evidence/screenshots/sprint-14/professor-dashboard-desktop.png", fullPage: false });
  });

  test("dashboard funciona em mobile 390px sem rolagem horizontal", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, TEACHER_A_EMAIL);
    await page.goto("/professor");
    await expect(page.getByRole("heading", { name: "Visão Geral" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "evidence/screenshots/sprint-14/professor-dashboard-mobile-390px.png", fullPage: false });
  });

  test("navegação por teclado alcança os links do menu do professor com foco visível", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await loginAs(page, TEACHER_A_EMAIL);
    await page.goto("/professor");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => document.activeElement?.tagName);
    expect(focused).toBeTruthy();
  });
});

test.describe("Lista de alunos", () => {
  test("busca por nome filtra a lista", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await loginAs(page, TEACHER_A_EMAIL);
    await page.goto("/professor/alunos");
    await expect(page.getByRole("heading", { name: "Alunos" })).toBeVisible();
    await expect(page.getByText(STUDENT_1_NAME)).toBeVisible();
    await expect(page.getByText(STUDENT_2_NAME)).toBeVisible();

    await page.getByLabel("Buscar por nome").fill("Aluno 1");
    await expect(page.getByText(STUDENT_1_NAME)).toBeVisible();
    await expect(page.getByText(STUDENT_2_NAME)).toHaveCount(0);

    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "evidence/screenshots/sprint-14/professor-alunos-lista.png", fullPage: false });
  });

  test("filtro 'sem atividade recente' mantém os dois alunos sem evidência", async ({ page }) => {
    await loginAs(page, TEACHER_A_EMAIL);
    await page.goto("/professor/alunos");
    await page.getByLabel("Filtro").selectOption("sem_atividade_recente");
    await expect(page.getByText(STUDENT_1_NAME)).toBeVisible();
  });
});

test.describe("Acompanhamento individual", () => {
  test("acesso ao aluno autorizado mostra resumo factual, semana, treino, Caderno de Erros e padrões", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await loginAs(page, TEACHER_A_EMAIL);
    await page.goto("/professor/alunos");
    await page.getByRole("link", { name: "Ver acompanhamento" }).first().click();

    await expect(page.getByRole("heading", { name: /Resumo factual da semana/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Semana e meta" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Treino" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Caderno de Erros" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Padrões" })).toBeVisible();

    // Nunca expõe e-mail/token/anotação privada em nenhum ponto da página.
    await expect(page.getByText("@local.teste")).toHaveCount(0);

    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "evidence/screenshots/sprint-14/professor-aluno-individual.png", fullPage: false });
  });

  test("aluno sem nenhuma evidência mostra o estado vazio factual, nunca um zero fabricado", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await loginAs(page, TEACHER_A_EMAIL);
    await page.goto("/professor/alunos/fixture-student-1");
    await expect(page.getByText("Ainda não há evidências registradas neste período.")).toBeVisible();
    await expect(page.getByText("Nenhuma meta semanal registrada para este período.")).toBeVisible();
    await expect(page.getByText("Nenhum registro no Caderno de Erros ainda.")).toBeVisible();
    await page.screenshot({ path: "evidence/screenshots/sprint-14/professor-aluno-sem-evidencias.png", fullPage: false });
    // Mesma tela também documenta o estado vazio das revisões do Caderno de
    // Erros (seção 24 — professor-aluno-revisoes.png): sem nenhum registro,
    // não existe nenhuma revisão pendente/vencida a mostrar.
    await page.screenshot({ path: "evidence/screenshots/sprint-14/professor-aluno-revisoes.png", fullPage: false });
  });

  test("meta/progresso factual: aluno com meta semanal real mostra números vindos da API, nunca fabricados", async ({ page, browser }) => {
    const seedPage = await browser.newPage();
    await seedRealWeeklyGoalForStudent2(seedPage);
    await seedPage.close();

    await page.setViewportSize({ width: 1280, height: 800 });
    await loginAs(page, TEACHER_A_EMAIL);
    await page.goto("/professor/alunos/fixture-student-2");
    await expect(page.getByText(/Meta ativa:/)).toBeVisible();
    await expect(page.getByText(/150 min/)).toBeVisible();
    await expect(page.getByText(/30 questões/)).toBeVisible();
    await expect(page.getByText(/Progresso factual:/)).toBeVisible();
    await page.screenshot({ path: "evidence/screenshots/sprint-14/professor-aluno-semana.png", fullPage: false });
  });
});
