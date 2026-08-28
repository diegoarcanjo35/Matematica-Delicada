import { expect, test } from "@playwright/test";

/* Sprint 1 v1.1 — correção 3. Gera screenshots reais (não simulados) em
   evidence/screenshots/, com nomes indicando largura e estado. Roda 100% local. */

const WIDTHS: Array<{ width: number; height: number; label: string }> = [
  { width: 360, height: 800, label: "360px" },
  { width: 390, height: 844, label: "390px" },
  { width: 768, height: 1024, label: "768px" },
  { width: 1280, height: 800, label: "1280px" },
  { width: 1440, height: 900, label: "1440px" },
];

test.describe("Evidências visuais — Sprint 1 v1.1", () => {
  for (const { width, height, label } of WIDTHS) {
    test(`home-${label}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto("/");
      await expect(page.getByText("Boa tarde, Ana Cláudia! ♡")).toBeVisible();

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

  test("pagina-placeholder", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/padroes-enem");
    await expect(page.getByRole("heading", { name: "Padrões ENEM" })).toBeVisible();
    await page.screenshot({
      path: "evidence/screenshots/pagina-placeholder-padroes-enem.png",
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
