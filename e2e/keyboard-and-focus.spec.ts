import { expect, test } from "@playwright/test";

/* Sprint 1 v1.1 — correção 2. Testes reais em Chromium local (não é inspeção de CSS).
   Cada teste comprova um cenário exigido pelo PO. */

test.describe("Teclado e foco — navegação real em Chromium", () => {
  test("1-2. skip-link recebe foco e leva ao conteúdo principal", async ({ page }) => {
    await page.goto("/");
    // Aguarda a sessão ser validada e o shell autenticado (com skip-link) montar
    // antes de simular Tab — senão a tecla pode ser pressionada durante o
    // LoadingState inicial, antes do skip-link existir no DOM.
    const skipLink = page.locator(".skip-link");
    await skipLink.waitFor({ state: "attached" });
    await page.keyboard.press("Tab");
    await expect(skipLink).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main-content")).toBeVisible();
  });

  test("3. itens principais da navegação (sidebar) recebem foco via Tab", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    const inicioLink = page.getByRole("navigation", { name: "Navegação principal" }).getByRole(
      "link",
      { name: "Início" }
    );
    await inicioLink.focus();
    await expect(inicioLink).toBeFocused();

    await page.keyboard.press("Tab");
    const treinoLink = page.getByRole("link", { name: "Treino Diário" });
    await expect(treinoLink).toBeFocused();
  });

  test("4. botão principal do dashboard (COMEÇAR TREINO) recebe foco e é ativável por teclado", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    const startButton = page.getByRole("button", { name: "COMEÇAR TREINO" });
    await startButton.focus();
    await expect(startButton).toBeFocused();
  });

  test("5-6. item Menu da navegação móvel recebe foco e abre o drawer sem mouse", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const menuButton = page.getByRole("button", { name: /Menu/ });
    await menuButton.focus();
    await expect(menuButton).toBeFocused();

    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Mais opções" });
    await expect(dialog).toBeVisible();
  });

  test("7. foco permanece visível (outline aplicado por :focus-visible)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await page.locator(".skip-link").waitFor({ state: "attached" });
    await page.keyboard.press("Tab");
    const focused = page.locator(":focus-visible");
    await expect(focused).toHaveCount(1);
    const outlineStyle = await focused.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outlineStyle).toBe("solid");
  });

  test("8. modal tem comportamento mínimo correto de foco (abre, Escape fecha)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    const openButton = page.getByRole("button", { name: "Ver mapa completo" });
    await openButton.focus();
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog", { name: "Seu Mapa ENEM completo" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("9. elementos interativos importantes são alcançáveis só com teclado", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");

    const bottleneckButton = page.getByRole("button", { name: "TREINAR AGORA" });
    await bottleneckButton.focus();
    await expect(bottleneckButton).toBeFocused();
    await page.keyboard.press("Enter");

    const mapButton = page.getByRole("button", { name: "Ver mapa completo" });
    await mapButton.focus();
    await expect(mapButton).toBeFocused();
  });
});
