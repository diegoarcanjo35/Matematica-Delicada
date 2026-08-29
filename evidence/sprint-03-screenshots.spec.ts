import { expect, test } from "@playwright/test";
import { testClientIdHeader } from "../e2e/rateLimitIsolation";

/* Sprint 3 v1.1, Correção D — evidências visuais próprias das telas novas do
   onboarding, geradas por automação real (não capturas manuais), com dados
   evidentemente fictícios ("Aluna Demonstração Sprint3", e-mail
   *@evidencia.teste). Roda 100% local, sempre deslogado no início (cria sua
   própria conta), então nunca reaproveita o cookie do usuário fixo de E2E.

   Sprint 3 v1.2: volta a viver em evidence/ (local semanticamente correto —
   só produz screenshots). A versão anterior morava em e2e/, com nome
   escolhido para rodar antes de e2e/zz-rate-limit.spec.ts alfabeticamente;
   isso foi rejeitado por criar dependência implícita de ordem/nome de
   arquivo. Agora cada arquivo que cadastra contas via API isola seu próprio
   identificador de rate limit por cabeçalho, passado direto nas chamadas via
   page.request (nunca via test.use({extraHTTPHeaders}) — isso vazaria para
   requisições cross-origin da própria página, como as fontes do Google
   Fonts, quebrando o preflight CORS delas; ver e2e/rateLimitIsolation.ts). */
test.use({ storageState: { cookies: [], origins: [] } });

const TEST_CLIENT_ID_HEADER = testClientIdHeader("sprint-03-screenshots");
const NEXT_YEAR = new Date().getUTCFullYear() + 1;
const FICTITIOUS_PASSWORD = "senha-evidencia-fake-1";

/* Cada teste precisa da SUA PRÓPRIA conta — um e-mail fixo compartilhado
   entre testes faria o segundo/terceiro teste reaproveitar (via signup
   falhando silenciosamente por "e-mail em uso") o progresso de onboarding
   já avançado pelo teste anterior, quebrando a etapa esperada na tela. */
function uniqueFictitiousEmail(): string {
  return `evidencia-sprint3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@evidencia.teste`;
}

async function createConfirmedFictitiousUser(page: import("@playwright/test").Page): Promise<void> {
  const email = uniqueFictitiousEmail();
  await page.request.post("/api/auth/signup", {
    headers: TEST_CLIENT_ID_HEADER,
    data: {
      name: "Aluna Demonstração Sprint3",
      email,
      password: FICTITIOUS_PASSWORD,
      confirmPassword: FICTITIOUS_PASSWORD,
      acceptTerms: true,
    },
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
    data: { email, password: FICTITIOUS_PASSWORD },
  });
  const setCookie = loginResponse.headers()["set-cookie"];
  const tokenValue = setCookie.split(";")[0].split("=").slice(1).join("=");
  await page.context().addCookies([{ name: "md_session", value: tokenValue, domain: "localhost", path: "/" }]);
}

async function expectNoHorizontalScroll(page: import("@playwright/test").Page): Promise<void> {
  const hasHorizontalScroll = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );
  expect(hasHorizontalScroll).toBe(false);
}

test.describe("Evidências visuais — Sprint 3 (onboarding)", () => {
  test("onboarding-desktop-etapa-1", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await createConfirmedFictitiousUser(page);
    await page.goto("/onboarding");

    await expect(page.getByRole("heading", { name: "Momento escolar e ENEM" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "evidence/screenshots/sprint-03/onboarding-desktop-etapa-1.png" });
  });

  test("onboarding-mobile-390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await createConfirmedFictitiousUser(page);
    await page.goto("/onboarding");

    await expect(page.getByRole("heading", { name: "Momento escolar e ENEM" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "evidence/screenshots/sprint-03/onboarding-mobile-390px.png" });
  });

  test("onboarding-acessibilidade-com-aviso-privacidade", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await createConfirmedFictitiousUser(page);
    await page.goto("/onboarding");

    await page.getByLabel("Série atual").selectOption("3_serie_em");
    await page.getByLabel("Ano em que fará o ENEM").fill(String(NEXT_YEAR));
    await page.getByRole("button", { name: "Avançar" }).click();
    await page.getByLabel("Quantidade de acertos").check();
    await page.getByLabel(/Meta de acertos/).fill("28");
    await page.getByRole("button", { name: "Avançar" }).click();
    await page.getByLabel("Segunda").check();
    await page.getByLabel(/Minutos disponíveis por dia/).fill("45");
    await page.getByRole("button", { name: "Avançar" }).click();
    await page.getByRole("button", { name: "Avançar" }).click();

    await expect(page.getByRole("heading", { name: "Preferências e acessibilidade" })).toBeVisible();
    await expect(page.getByText(/nunca aparece em URL, logs, auditoria/)).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({
      path: "evidence/screenshots/sprint-03/onboarding-acessibilidade-aviso-privacidade.png",
    });
  });

  test("onboarding-revisao-antes-da-conclusao", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await createConfirmedFictitiousUser(page);
    await page.goto("/onboarding");

    await page.getByLabel("Série atual").selectOption("3_serie_em");
    await page.getByLabel("Ano em que fará o ENEM").fill(String(NEXT_YEAR));
    await page.getByRole("button", { name: "Avançar" }).click();
    await page.getByLabel("Quantidade de acertos").check();
    await page.getByLabel(/Meta de acertos/).fill("28");
    await page.getByRole("button", { name: "Avançar" }).click();
    await page.getByLabel("Segunda").check();
    await page.getByLabel("Quarta").check();
    await page.getByLabel(/Minutos disponíveis por dia/).fill("45");
    await page.getByRole("button", { name: "Avançar" }).click();
    await page.getByRole("button", { name: "Avançar" }).click();
    await page.getByLabel("Noite").check();
    await page.getByRole("button", { name: "Avançar" }).click();
    await page.getByLabel("Prefiro fazer depois").check();
    await page.getByRole("button", { name: "Avançar" }).click();

    await expect(page.getByRole("heading", { name: "Revisão e conclusão" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({
      path: "evidence/screenshots/sprint-03/onboarding-revisao-antes-da-conclusao.png",
    });

    // Conclui para preparar as duas evidências seguintes (Configurações e Dashboard).
    await page.getByRole("button", { name: "Concluir onboarding" }).click();
    await expect(page.getByText("Seu Mapa ENEM")).toBeVisible();

    await page.goto("/configuracoes");
    await expect(page.getByRole("heading", { name: "Configurações" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "evidence/screenshots/sprint-03/configuracoes-apos-conclusao.png" });

    await page.goto("/");
    await expect(page.getByText("Seu Mapa ENEM")).toBeVisible();
    await expect(page.getByText(/28 acertos/)).toBeVisible();
    await expect(page.getByText(/dados de demonstração/)).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: "evidence/screenshots/sprint-03/dashboard-apos-onboarding.png" });
  });
});
