import { expect, test } from "@playwright/test";

/* Verificação de ausência de erros relevantes no console — regressão v1.1, item 14. */
test("nenhum erro no console ao navegar pelas rotas principais", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));

  for (const path of ["/", "/treino-diario", "/padroes-enem", "/rota-inexistente"]) {
    await page.goto(path);
  }

  expect(errors, `erros de console encontrados: ${JSON.stringify(errors)}`).toEqual([]);
});
