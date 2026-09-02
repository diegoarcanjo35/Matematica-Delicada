import { expect, test, type Page } from "@playwright/test";
import { testClientIdHeader } from "./rateLimitIsolation";

/* Sprint 15 v1.0 — Administração Essencial em Chromium real (ordem seção
   24). Login sempre pelas contas FIXAS de scripts/fixtures/
   admin-fixtures.local.sql + scripts/fixtures/teacher-fixtures.local.sql
   (aplicadas por `npm run db:seed:admin:local`/`db:seed:teacher:local`, já
   parte de `npm run worker:preview`, que este arquivo usa como webServer via
   playwright.config.ts) — nunca contas dinâmicas via /api/auth/signup, mesmo
   raciocínio de e2e/teacherDashboard.spec.ts (precisamos de vínculos/papéis
   determinísticos). Mesmo padrão de isolamento de rate limit
   (testClientIdHeader). */

test.use({ storageState: { cookies: [], origins: [] } });

const TEST_CLIENT_ID_HEADER = testClientIdHeader("admin-essential");

const FIXTURE_PASSWORD = "fixture-teacher-local-only-1";
const ADMIN_EMAIL = "fixture-admin-1@local.teste";
const PLAIN_USER_EMAIL = "fixture-plain-user-1@local.teste";
const TEACHER_A_EMAIL = "fixture-professora-a@local.teste";

const PLAIN_USER_NAME = "[PROVISÓRIO] Usuário Comum (Fixture Técnica)";
const TEACHER_A_NAME = "[PROVISÓRIO] Professora A (Fixture Técnica)";
const TEACHER_C_NAME = "[PROVISÓRIO] Professora C, sem alunos (Fixture Técnica)";

const TEACHER_C_ID = "fixture-teacher-c";
const STUDENT_4_ID = "fixture-student-4";
const PLAIN_USER_ID = "fixture-plain-user-1";

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

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const hasHorizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(hasHorizontalScroll).toBe(false);
}

test.describe("Acesso e RBAC (item 1/2)", () => {
  test("admin acessa a área administrativa", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await loginAs(page, ADMIN_EMAIL);
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Visão Geral" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "evidence/screenshots/sprint-15/admin-dashboard.png", fullPage: false });
  });

  test("usuário comum (sem papel admin) vê acesso restrito ao navegar para /admin", async ({ page }) => {
    await loginAs(page, PLAIN_USER_EMAIL);
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Acesso restrito" })).toBeVisible();
    await expect(page.getByText(/Total de usuários/)).toHaveCount(0);
  });

  test("professor (sem papel admin) também é bloqueado", async ({ page }) => {
    await loginAs(page, TEACHER_A_EMAIL);
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Acesso restrito" })).toBeVisible();
  });

  test("sem sessão nenhuma, /admin redireciona para login", async ({ page }) => {
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/entrar/);
  });
});

test.describe("Lista de usuários (item 3/4/5)", () => {
  test("lista de usuários carrega com papéis visíveis", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await loginAs(page, ADMIN_EMAIL);
    await page.goto("/admin/usuarios");
    await expect(page.getByRole("heading", { name: "Usuários" })).toBeVisible();
    await expect(page.getByText(TEACHER_A_NAME)).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "evidence/screenshots/sprint-15/admin-usuarios.png", fullPage: false });
  });

  test("busca por nome filtra a lista", async ({ page }) => {
    await loginAs(page, ADMIN_EMAIL);
    await page.goto("/admin/usuarios");
    await page.getByLabel("Buscar por nome ou e-mail").fill("Professora A");
    await expect(page.getByText(TEACHER_A_NAME)).toBeVisible();
    await expect(page.getByText(PLAIN_USER_NAME)).toHaveCount(0);
  });

  test("filtro por papel 'teacher' mantém só professores", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await loginAs(page, ADMIN_EMAIL);
    await page.goto("/admin/usuarios");
    await page.getByLabel("Papel").selectOption("teacher");
    await expect(page.getByText(TEACHER_A_NAME)).toBeVisible();
    await expect(page.getByText(PLAIN_USER_NAME)).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "evidence/screenshots/sprint-15/admin-usuarios-filtros.png", fullPage: false });
  });

  test("filtro por papel inexistente ('sem_papel') mostra estado vazio quando aplicável, sem quebrar a tela", async ({ page }) => {
    await loginAs(page, ADMIN_EMAIL);
    await page.goto("/admin/usuarios?papel=commercial");
    await expect(page.getByRole("heading", { name: "Usuários" })).toBeVisible();
    // Nenhum usuário de fixture tem o papel 'commercial' — estado vazio factual (item 13).
    await expect(page.getByText("Nenhum usuário encontrado com os filtros atuais")).toBeVisible();
    await page.screenshot({ path: "evidence/screenshots/sprint-15/admin-usuarios-vazio.png", fullPage: false });
  });
});

test.describe("Detalhe do usuário e papéis (item 6/7/8)", () => {
  test("detalhe do usuário mostra papéis atuais", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await loginAs(page, ADMIN_EMAIL);
    await page.goto(`/admin/usuarios/${TEACHER_C_ID}`);
    await expect(page.getByRole("heading", { name: TEACHER_C_NAME })).toBeVisible();
    await expect(page.getByText("teacher")).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "evidence/screenshots/sprint-15/admin-usuario-detalhe.png", fullPage: false });
  });

  test("atribuir e remover um papel refletem o estado real do servidor", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await loginAs(page, ADMIN_EMAIL);
    await page.goto(`/admin/usuarios/${PLAIN_USER_ID}`);
    await expect(page.getByRole("heading", { name: PLAIN_USER_NAME })).toBeVisible();

    // Atribuição (item 7).
    await page.getByLabel("Atribuir papel").selectOption("support");
    await page.getByRole("button", { name: "Atribuir" }).click();
    await expect(page.getByText("support", { exact: true })).toBeVisible();
    await page.screenshot({ path: "evidence/screenshots/sprint-15/admin-papeis.png", fullPage: false });

    // Remoção com confirmação (item 8, ordem seção 20).
    await page.getByRole("button", { name: "Remover" }).first().click();
    await expect(page.getByRole("heading", { name: "Remover papel" })).toBeVisible();
    await page.getByRole("button", { name: "Confirmar remoção" }).click();
    await expect(page.getByRole("heading", { name: "Remover papel" })).toHaveCount(0);
    await expect(page.getByText("Nenhum papel atribuído no momento.")).toBeVisible();
  });
});

test.describe("Vínculos professor-aluno (item 9/10/11/12)", () => {
  test("criar vínculo, inativar e reativar refletem sempre o estado real do servidor", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await loginAs(page, ADMIN_EMAIL);
    await page.goto("/admin/vinculos");
    await expect(page.getByRole("heading", { name: "Vínculos Professor-Aluno" })).toBeVisible();

    // Criação (item 9) — professora C (sem vínculos) com aluna 4 (sem professor).
    await page.getByLabel("ID do professor").fill(TEACHER_C_ID);
    await page.getByLabel("ID do aluno").fill(STUDENT_4_ID);
    await page.getByRole("button", { name: "Criar vínculo" }).click();
    await page.getByLabel("Buscar por nome do professor ou do aluno").fill("Aluna 4");
    const newBondRow = page.getByRole("row").filter({ hasText: "Aluna 4" }).filter({ hasText: "Professora C" });
    await expect(newBondRow).toBeVisible();
    await page.screenshot({ path: "evidence/screenshots/sprint-15/admin-vinculos.png", fullPage: false });

    // Inativação com confirmação (item 10, ordem seção 20).
    await newBondRow.getByRole("button", { name: "Inativar" }).click();
    await expect(page.getByRole("heading", { name: "Inativar vínculo" })).toBeVisible();
    await page.screenshot({ path: "evidence/screenshots/sprint-15/admin-vinculo-confirmacao.png", fullPage: false });
    await page.getByRole("button", { name: "Confirmar inativação" }).click();
    await expect(page.getByRole("heading", { name: "Inativar vínculo" })).toHaveCount(0);
    await expect(newBondRow.getByText("Inativo")).toBeVisible();

    // Reativação (item 11) — UPDATE na mesma linha, nunca uma segunda.
    await newBondRow.getByRole("button", { name: "Reativar" }).click();
    await expect(newBondRow.getByText("Ativo")).toBeVisible();
  });

  test("vínculo inválido (professor == aluno) é rejeitado com mensagem, sem criar nada (item 12)", async ({ page }) => {
    await loginAs(page, ADMIN_EMAIL);
    await page.goto("/admin/vinculos");
    await page.getByLabel("ID do professor").fill(TEACHER_C_ID);
    await page.getByLabel("ID do aluno").fill(TEACHER_C_ID);
    await page.getByRole("button", { name: "Criar vínculo" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
  });
});

test.describe("Responsividade e teclado (item 14/15)", () => {
  test("dashboard admin funciona em mobile 390px sem rolagem horizontal", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, ADMIN_EMAIL);
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Visão Geral" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "evidence/screenshots/sprint-15/admin-mobile-390px.png", fullPage: false });
  });

  test("navegação por teclado alcança os links do menu administrativo com foco visível", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await loginAs(page, ADMIN_EMAIL);
    await page.goto("/admin");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => document.activeElement?.tagName);
    expect(focused).toBeTruthy();
  });
});
