import { expect, test } from "@playwright/test";

/* Sprint 1 v1.1 (correção 3) + Sprint 2 v1.0 — screenshots reais (não simulados) em
   evidence/screenshots/, com nomes indicando largura e estado. Roda 100% local.
   A partir da Sprint 2, o dashboard exige sessão — o storageState padrão do
   playwright.config.ts já autentica como o usuário de teste E2E ("Usuário E2E"). */

const WIDTHS: Array<{ width: number; height: number; label: string }> = [
  { width: 360, height: 800, label: "360px" },
  { width: 390, height: 844, label: "390px" },
  { width: 768, height: 1024, label: "768px" },
  { width: 1280, height: 800, label: "1280px" },
  { width: 1440, height: 900, label: "1440px" },
];

test.describe("Evidências visuais — dashboard autenticado", () => {
  for (const { width, height, label } of WIDTHS) {
    test(`home-${label}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto("/");
      await expect(page.getByText(/Usuário/)).toBeVisible();

      const hasHorizontalScroll = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth
      );
      expect(hasHorizontalScroll, `rolagem horizontal indevida em ${label}`).toBe(false);

      // fullPage:false — elementos com position:fixed/sticky duplicam visualmente em
      // capturas full-page "stitched"; viewport único é a evidência fiel ao uso real.
      await page.screenshot({
        path: `evidence/screenshots/home-${label}.png`,
        fullPage: false,
      });
    });
  }

  test("mobile-menu-aberto", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByRole("button", { name: /Menu/ }).click();
    await expect(page.getByRole("dialog", { name: "Mais opções" })).toBeVisible();
    await page.screenshot({ path: "evidence/screenshots/mobile-menu-aberto.png" });
  });

  /* Sprint 6 v1.0 — esta evidência usava /padroes-enem, que DEIXOU de ser
     placeholder nesta sprint (virou o catálogo real). Para continuar
     provando o que sempre provou — que uma rota ainda não implementada
     renderiza a página de placeholder —, passou a usar /reconheca-o-padrao,
     que segue sendo placeholder. O PNG antigo
     (evidence/screenshots/pagina-placeholder-padroes-enem.png) permanece no
     repositório como evidência histórica da Sprint 1 e não é mais
     regenerado por nenhum teste. */
  test("pagina-placeholder", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/reconheca-o-padrao");
    await expect(page.getByRole("heading", { name: "Reconheça o Padrão" })).toBeVisible();
    await page.screenshot({
      path: "evidence/screenshots/pagina-placeholder-reconheca-o-padrao.png",
      fullPage: false,
    });
  });

  test("pagina-404", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/rota-que-nao-existe");
    await expect(page.getByRole("heading", { name: "Página não encontrada" })).toBeVisible();
    await page.screenshot({ path: "evidence/screenshots/pagina-404.png", fullPage: true });
  });

  test("foco-por-teclado", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.screenshot({ path: "evidence/screenshots/foco-por-teclado.png" });
  });
});

test.describe("Evidências visuais — autenticação (visitante deslogado)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("login-desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/entrar");
    await expect(page.getByRole("heading", { name: "Entrar" })).toBeVisible();
    await page.screenshot({ path: "evidence/screenshots/login-desktop.png" });
  });

  test("login-mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/entrar");
    await expect(page.getByRole("heading", { name: "Entrar" })).toBeVisible();
    await page.screenshot({ path: "evidence/screenshots/login-mobile.png" });
  });

  test("cadastro-desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/criar-conta");
    await expect(page.getByRole("heading", { name: "Criar conta" })).toBeVisible();
    await page.screenshot({ path: "evidence/screenshots/cadastro-desktop.png" });
  });

  test("recuperar-senha-desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/esqueci-minha-senha");
    await expect(page.getByRole("heading", { name: "Esqueci minha senha" })).toBeVisible();
    await page.screenshot({ path: "evidence/screenshots/recuperar-senha-desktop.png" });
  });

  test("erro-login-invalido", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/entrar");
    await page.getByLabel("E-mail").fill("naoexiste@teste.com");
    await page.getByLabel("Senha").fill("senhaerrada123");
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.getByText("E-mail ou senha incorretos.")).toBeVisible();
    await page.screenshot({ path: "evidence/screenshots/erro-login-invalido.png" });
  });

  test("redirecionamento-visitante", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/treino-diario");
    await expect(page.getByRole("heading", { name: "Entrar" })).toBeVisible();
    await page.screenshot({ path: "evidence/screenshots/redirecionamento-visitante.png" });
  });
});
