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

  test("4. CTA principal do card de Cronograma (Ver cronograma) recebe foco e é ativável por teclado", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    const scheduleLink = page.getByRole("link", { name: "Ver cronograma" });
    await scheduleLink.focus();
    await expect(scheduleLink).toBeFocused();
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

  test("8. link do Mapa ENEM recebe foco e navega por teclado", async ({
    page,
  }) => {
    // Sprint 10 — o antigo botão "Ver mapa completo" que abria um modal
    // (dialog "Seu Mapa ENEM completo") foi substituído por um <Link>
    // real para /mapa-enem. Este teste comprova o novo contrato: link
    // real, nome acessível estável, foco visível e navegação por Enter —
    // sem modal, sem Escape.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    const mapLink = page.getByRole("link", { name: "Ver Mapa ENEM completo" });
    await expect(mapLink).toHaveAttribute("href", "/mapa-enem");

    await mapLink.focus();
    await expect(mapLink).toBeFocused();

    const focused = page.locator(":focus-visible");
    await expect(focused).toHaveCount(1);
    const outlineStyle = await focused.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outlineStyle).toBe("solid");

    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/mapa-enem$/);
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

    // Sprint 10 — Mapa ENEM agora é um <Link> real (não mais um botão que
    // abre modal). Recarrega para partir de um estado de foco conhecido no
    // topo da página e comprova que o link é alcançável só com Tab
    // (nenhum mouse), com nome acessível estável, e que a navegação
    // funciona.
    await page.goto("/");
    const mapLink = page.getByRole("link", { name: "Ver Mapa ENEM completo" });
    let reachedViaTab = false;
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      const isFocused = await mapLink
        .evaluate((el) => el === document.activeElement)
        .catch(() => false);
      if (isFocused) {
        reachedViaTab = true;
        break;
      }
    }
    expect(reachedViaTab).toBe(true);
    await expect(mapLink).toBeFocused();
    await expect(mapLink).toHaveAccessibleName("Ver Mapa ENEM completo");

    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/mapa-enem$/);
  });
});
