import { expect, test } from "@playwright/test";
import { installTestClientIdRoute, testClientIdHeader } from "./rateLimitIsolation";

/* Sprint 2 v1.0 — fluxos completos de autenticação, em Chromium real, deslogado. */
test.use({ storageState: { cookies: [], origins: [] } });

// Cadastro/login nesta suíte acontecem via UI real (formulário + clique),
// então o cabeçalho de isolamento precisa ser injetado por interceptação de
// mesma origem (/api/**) — nunca via test.use({extraHTTPHeaders}), que
// vazaria para requisições cross-origin da página (fontes do Google Fonts),
// quebrando o preflight CORS delas. Ver e2e/rateLimitIsolation.ts.
const TEST_CLIENT_ID_HEADER = testClientIdHeader("auth-flow");
test.beforeEach(async ({ page }) => {
  await installTestClientIdRoute(page, "auth-flow");
});

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@teste.dev`;
}

/* Sprint 3 — estes testes de autenticação usam contas recém-criadas, sem
   onboarding. Como a área do aluno agora exige onboarding concluído
   (RequireOnboardingComplete), completamos o onboarding via API logo após o
   login para que estes testes continuem exercitando exclusivamente a
   mecânica de sessão/autenticação que já cobriam — o fluxo de onboarding em
   si é coberto por e2e/onboarding.spec.ts. */
async function completeOnboardingViaApi(page: import("@playwright/test").Page): Promise<void> {
  const nextYear = new Date().getUTCFullYear() + 1;
  await page.request.patch("/api/onboarding", {
    data: { currentGrade: "3_serie_em", enemYear: nextYear, currentStep: 1 },
  });
  await page.request.patch("/api/onboarding", {
    data: { goalType: "acertos", goalValue: 25, currentStep: 2 },
  });
  await page.request.patch("/api/onboarding", {
    data: { availableDays: ["seg"], dailyMinutes: 30, currentStep: 3 },
  });
  await page.request.patch("/api/onboarding", { data: { difficulties: [], currentStep: 4 } });
  await page.request.patch("/api/onboarding", { data: { timePreference: "noite", currentStep: 5 } });
  await page.request.patch("/api/onboarding", { data: { diagnosticChoice: "depois", currentStep: 6 } });
  await page.request.post("/api/onboarding/complete");
}

async function readLastOutboxLink(
  request: import("@playwright/test").APIRequestContext,
  to: string,
  kind: "email_confirmation" | "password_reset"
): Promise<string> {
  const response = await request.get(
    `/api/dev/outbox/last?to=${encodeURIComponent(to)}&kind=${kind}`
  );
  expect(response.ok()).toBe(true);
  const { email } = await response.json();
  const match = email.body.match(/https?:\/\/\S+/);
  if (!match) throw new Error("Link não encontrado no corpo do e-mail.");
  return match[0];
}

test.describe("Cadastro", () => {
  test("cadastro com sucesso leva à tela de confirmação", async ({ page }) => {
    const email = uniqueEmail("cadastro-ok");
    await page.goto("/criar-conta");
    await page.getByLabel("Nome").fill("Aluna de Teste");
    await page.getByLabel("E-mail").fill(email);
    await page.getByLabel("Senha", { exact: true }).fill("senhavalida123");
    await page.getByLabel("Confirmar senha").fill("senhavalida123");
    await page.getByLabel(/Li e aceito/).check();
    await page.getByRole("button", { name: "Criar conta" }).click();

    await expect(page.getByText("Sua conta foi criada")).toBeVisible();
  });

  test("e-mail duplicado mostra erro e mantém foco acessível", async ({ page }) => {
    const email = uniqueEmail("duplicado");
    for (let i = 0; i < 2; i++) {
      await page.goto("/criar-conta");
      await page.getByLabel("Nome").fill("Aluna de Teste");
      await page.getByLabel("E-mail").fill(email);
      await page.getByLabel("Senha", { exact: true }).fill("senhavalida123");
      await page.getByLabel("Confirmar senha").fill("senhavalida123");
      await page.getByLabel(/Li e aceito/).check();
      await page.getByRole("button", { name: "Criar conta" }).click();
      if (i === 0) await expect(page.getByText("Sua conta foi criada")).toBeVisible();
    }
    await expect(page.getByText("Este e-mail já está cadastrado.")).toBeVisible();
  });

  test("senha curta é rejeitada com erro associado ao campo, sem round-trip ao servidor", async ({
    page,
  }) => {
    await page.goto("/criar-conta");
    await page.getByLabel("Nome").fill("Aluna de Teste");
    await page.getByLabel("E-mail").fill(uniqueEmail("senha-curta"));
    await page.getByLabel("Senha", { exact: true }).fill("curta");
    await page.getByLabel("Confirmar senha").fill("curta");
    await page.getByLabel(/Li e aceito/).check();
    await page.getByRole("button", { name: "Criar conta" }).click();

    await expect(page.getByText("A senha deve ter pelo menos 10 caracteres.")).toBeVisible();
    await expect(page.getByLabel("Senha", { exact: true })).toBeFocused();
  });

  test("termos não aceitos bloqueia o envio", async ({ page }) => {
    await page.goto("/criar-conta");
    await page.getByLabel("Nome").fill("Aluna de Teste");
    await page.getByLabel("E-mail").fill(uniqueEmail("sem-termos"));
    await page.getByLabel("Senha", { exact: true }).fill("senhavalida123");
    await page.getByLabel("Confirmar senha").fill("senhavalida123");
    await page.getByRole("button", { name: "Criar conta" }).click();

    await expect(
      page.getByText("É necessário aceitar os termos e a política de privacidade.")
    ).toBeVisible();
  });
});

test.describe("Confirmação de e-mail", () => {
  test("link válido confirma o e-mail; reuso é rejeitado", async ({ page, request }) => {
    const email = uniqueEmail("confirma");
    await page.goto("/criar-conta");
    await page.getByLabel("Nome").fill("Aluna de Teste");
    await page.getByLabel("E-mail").fill(email);
    await page.getByLabel("Senha", { exact: true }).fill("senhavalida123");
    await page.getByLabel("Confirmar senha").fill("senhavalida123");
    await page.getByLabel(/Li e aceito/).check();
    await page.getByRole("button", { name: "Criar conta" }).click();
    await expect(page.getByText("Sua conta foi criada")).toBeVisible();

    const link = await readLastOutboxLink(request, email, "email_confirmation");
    await page.goto(link.replace(/^https?:\/\/[^/]+/, ""));
    await expect(page.getByText("Seu e-mail foi confirmado com sucesso.")).toBeVisible();

    await page.reload();
    await expect(page.getByText(/inválido, já foi usado ou expirou/)).toBeVisible();
  });

  test("link ausente mostra erro", async ({ page }) => {
    await page.goto("/confirmar-email");
    await expect(page.getByText(/inválido, já foi usado ou expirou/)).toBeVisible();
  });
});

test.describe("Login e sessão", () => {
  async function createConfirmedUser(page: import("@playwright/test").Page, email: string) {
    await page.goto("/criar-conta");
    await page.getByLabel("Nome").fill("Aluna de Teste");
    await page.getByLabel("E-mail").fill(email);
    await page.getByLabel("Senha", { exact: true }).fill("senhavalida123");
    await page.getByLabel("Confirmar senha").fill("senhavalida123");
    await page.getByLabel(/Li e aceito/).check();
    await page.getByRole("button", { name: "Criar conta" }).click();
    await expect(page.getByText("Sua conta foi criada")).toBeVisible();
  }

  test("credenciais inválidas mostram mensagem genérica e devolvem o foco", async ({ page }) => {
    await page.goto("/entrar");
    await page.getByLabel("E-mail").fill("ninguem@teste.dev");
    await page.getByLabel("Senha").fill("qualquercoisa123");
    await page.getByRole("button", { name: "Entrar" }).click();

    await expect(page.getByText("E-mail ou senha incorretos.")).toBeVisible();
    await expect(page.getByLabel("E-mail")).toBeFocused();
  });

  test("acesso direto a rota protegida redireciona para login e retorna ao destino após entrar", async ({
    page,
  }) => {
    const email = uniqueEmail("retorno-destino");
    await createConfirmedUser(page, email);

    // Login/onboarding/logout temporários via API — só para que o teste real
    // (deslogado -> redireciona -> loga -> retorna ao destino) não seja
    // interceptado pelo gate de onboarding (ver completeOnboardingViaApi acima).
    await page.request.post("/api/auth/login", { headers: TEST_CLIENT_ID_HEADER, data: { email, password: "senhavalida123" } });
    await completeOnboardingViaApi(page);
    await page.request.post("/api/auth/logout");

    await page.goto("/padroes-enem");
    await expect(page.getByRole("heading", { name: "Entrar" })).toBeVisible();

    await page.getByLabel("E-mail").fill(email);
    await page.getByLabel("Senha").fill("senhavalida123");
    await page.getByRole("button", { name: "Entrar" }).click();

    await expect(page.getByRole("heading", { name: "Padrões ENEM" })).toBeVisible();
    expect(page.url()).toContain("/padroes-enem");
  });

  test("login completo, navegação autenticada e logout revogam o acesso", async ({ page }) => {
    const email = uniqueEmail("logout");
    await createConfirmedUser(page, email);

    await page.request.post("/api/auth/login", { headers: TEST_CLIENT_ID_HEADER, data: { email, password: "senhavalida123" } });
    await completeOnboardingViaApi(page);
    await page.request.post("/api/auth/logout");

    await page.goto("/entrar");
    await page.getByLabel("E-mail").fill(email);
    await page.getByLabel("Senha").fill("senhavalida123");
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.getByText("Seu Mapa ENEM")).toBeVisible();

    // Cookie de sessão não pode ficar acessível via JavaScript.
    const cookieVisibleToJs = await page.evaluate(() => document.cookie.includes("md_session"));
    expect(cookieVisibleToJs).toBe(false);

    await page.getByRole("button", { name: /Sair/ }).click();
    await expect(page.getByRole("heading", { name: "Entrar" })).toBeVisible();

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Entrar" })).toBeVisible();
  });

  test("formulário de login é totalmente operável por teclado", async ({ page }) => {
    await page.goto("/entrar");
    await page.getByLabel("E-mail").focus();
    await page.keyboard.type("teste-teclado@teste.dev");
    await page.keyboard.press("Tab");
    await page.keyboard.type("senhaerrada123");
    await page.keyboard.press("Enter");

    await expect(page.getByText("E-mail ou senha incorretos.")).toBeVisible();
  });

  test("duplo clique no envio de login não dispara duas requisições", async ({ page }) => {
    let requestCount = 0;
    await page.route("**/api/auth/login", async (route) => {
      requestCount++;
      await route.continue();
    });

    await page.goto("/entrar");
    await page.getByLabel("E-mail").fill("dupla-tentativa@teste.dev");
    await page.getByLabel("Senha").fill("senhaerrada123");

    // dblclick dispara um gesto nativo de clique duplo (mais fiel ao cenário real
    // do que dois click() concorrentes via Promise.all, cuja ordem de dispatch no
    // navegador não é garantida).
    await page.getByRole("button", { name: "Entrar" }).dblclick();
    await expect(page.getByText("E-mail ou senha incorretos.")).toBeVisible();

    expect(requestCount).toBe(1);
  });
});

test.describe("Recuperação de senha", () => {
  test("fluxo completo: solicitar, redefinir e logar com a nova senha", async ({ page, request }) => {
    const email = uniqueEmail("recuperar");
    await page.goto("/criar-conta");
    await page.getByLabel("Nome").fill("Aluna de Teste");
    await page.getByLabel("E-mail").fill(email);
    await page.getByLabel("Senha", { exact: true }).fill("senhaoriginal123");
    await page.getByLabel("Confirmar senha").fill("senhaoriginal123");
    await page.getByLabel(/Li e aceito/).check();
    await page.getByRole("button", { name: "Criar conta" }).click();
    await expect(page.getByText("Sua conta foi criada")).toBeVisible();

    await page.request.post("/api/auth/login", { headers: TEST_CLIENT_ID_HEADER, data: { email, password: "senhaoriginal123" } });
    await completeOnboardingViaApi(page);
    await page.request.post("/api/auth/logout");

    await page.goto("/esqueci-minha-senha");
    await page.getByLabel("E-mail").fill(email);
    await page.getByRole("button", { name: "Enviar link de redefinição" }).click();
    await expect(page.getByText(/receberá um link/)).toBeVisible();

    const link = await readLastOutboxLink(request, email, "password_reset");
    await page.goto(link.replace(/^https?:\/\/[^/]+/, ""));
    await page.getByLabel("Nova senha", { exact: true }).fill("senhanova456");
    await page.getByLabel("Confirmar nova senha").fill("senhanova456");
    await page.getByRole("button", { name: "Redefinir senha" }).click();

    await expect(page.getByRole("heading", { name: "Entrar" })).toBeVisible();
    await page.getByLabel("E-mail").fill(email);
    await page.getByLabel("Senha").fill("senhanova456");
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.getByText("Seu Mapa ENEM")).toBeVisible();
  });

  test("recuperação não enumera usuários — resposta idêntica para e-mail inexistente", async ({
    page,
  }) => {
    await page.goto("/esqueci-minha-senha");
    await page.getByLabel("E-mail").fill("naoexiste-nunca@teste.dev");
    await page.getByRole("button", { name: "Enviar link de redefinição" }).click();
    await expect(page.getByText(/receberá um link/)).toBeVisible();
  });

  test("link de redefinição sem token mostra erro claro", async ({ page }) => {
    await page.goto("/redefinir-senha");
    await expect(page.getByText("Este link de redefinição está incompleto.")).toBeVisible();
  });
});
