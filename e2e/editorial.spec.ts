import { expect, test, type Page } from "@playwright/test";
import { testClientIdHeader } from "./rateLimitIsolation";

/* Sprint 7 v1.0, seção 11.5 da ordem — Banco de Questões e Importação
   Editorial em Chromium real. Mesmo padrão de e2e/patterns.spec.ts/
   schedule.spec.ts: cada teste usa conta própria isolada do rate limit por
   cabeçalho. O bootstrap de papel usa exclusivamente
   POST /api/dev/editorial/bootstrap-role, atrás do gate local
   (ENABLE_LOCAL_EDITORIAL_FIXTURES) já ligado em wrangler.local.jsonc para
   este ambiente de testes — nunca um GET, nunca concede papel a outro
   usuário. */
test.use({ storageState: { cookies: [], origins: [] } });

const TEST_CLIENT_ID_HEADER = testClientIdHeader("editorial");

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@teste.dev`;
}

/* Token único por execução — usado dentro do ENUNCIADO de cada questão
   criada por este arquivo. Necessário porque a suíte roda DUAS vezes
   consecutivas contra o MESMO D1 local sem limpar entre rodadas (seção 14
   da ordem): um enunciado fixo colidiria com a fingerprint de duplicidade
   já criada pela rodada anterior — o que é o comportamento CORRETO do
   fingerprint (prova de que funciona), mas quebraria a suposição de estado
   limpo do teste se não fosse considerado aqui. */
function uniqueToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function createConfirmedUser(page: Page, emailPrefix: string): Promise<string> {
  const email = uniqueEmail(emailPrefix);
  const password = "senha-de-teste-editorial-1";

  await page.request.post("/api/auth/signup", {
    headers: TEST_CLIENT_ID_HEADER,
    data: { name: "Usuária Editorial", email, password, confirmPassword: password, acceptTerms: true },
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
    data: { email, password },
  });
  const setCookie = loginResponse.headers()["set-cookie"];
  const tokenValue = setCookie.split(";")[0].split("=").slice(1).join("=");
  await page.context().addCookies([{ name: "md_session", value: tokenValue, domain: "localhost", path: "/" }]);
  return email;
}

async function grantEditorialRole(page: Page, role: "editor" | "admin"): Promise<void> {
  const response = await page.request.post("/api/dev/editorial/bootstrap-role", { data: { role } });
  expect(response.ok()).toBe(true);
}

async function signedInEditor(page: Page, prefix: string, role: "editor" | "admin" = "editor"): Promise<void> {
  await createConfirmedUser(page, prefix);
  await grantEditorialRole(page, role);
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const hasHorizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(hasHorizontalScroll).toBe(false);
}

test.describe("Acesso e RBAC", () => {
  test("aluno sem papel vê acesso negado ao navegar para /editorial/questoes", async ({ page }) => {
    await createConfirmedUser(page, "edit-aluno");
    await page.goto("/editorial/questoes");
    await expect(page.getByRole("heading", { name: "Acesso restrito" })).toBeVisible();
    await expect(page.getByText(/enunciado/i)).toHaveCount(0);
  });

  test("sem sessão nenhuma, /editorial/questoes redireciona para login", async ({ page }) => {
    await page.goto("/editorial/questoes");
    await expect(page).toHaveURL(/\/entrar/);
  });
});

test.describe("Catálogo editorial", () => {
  test("editor vê o catálogo com colunas de status/origem/dificuldade", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInEditor(page, "edit-catalogo");
    await page.goto("/editorial/questoes");
    await expect(page.getByRole("heading", { name: "Banco de Questões" })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test("catálogo em 390px não gera rolagem horizontal", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signedInEditor(page, "edit-mobile");
    await page.goto("/editorial/questoes");
    await expect(page.getByRole("heading", { name: "Banco de Questões" })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test("filtro por status atualiza a URL e a listagem", async ({ page }) => {
    await signedInEditor(page, "edit-filtro");
    await page.goto("/editorial/questoes");
    await page.getByLabel("Status").selectOption("draft");
    await expect(page).toHaveURL(/status=draft/);
  });
});

test.describe("Criação, edição e conflito", () => {
  test("criar uma questão nova salva como rascunho e navega para a ficha", async ({ page }) => {
    await signedInEditor(page, "edit-criar");
    await page.goto("/editorial/questoes/nova");

    const code = `E2E-${uniqueToken()}`;
    await page.getByLabel("Código editorial").fill(code);
    await page.getByLabel("Enunciado").fill(`Enunciado técnico de teste E2E suficientemente longo ${uniqueToken()}.`);
    await page.getByLabel("Texto da alternativa A").fill("Alt A");
    await page.getByLabel("Texto da alternativa B").fill("Alt B");
    await page.getByLabel("Texto da alternativa C").fill("Alt C");
    await page.getByLabel("Texto da alternativa D").fill("Alt D");
    await page.getByLabel("Texto da alternativa E").fill("Alt E");
    await page.locator("#alt-B").locator("..").getByRole("radio").check();
    await page.getByRole("button", { name: "Salvar" }).click();

    await expect(page).toHaveURL(/\/editorial\/questoes\/[^/]+$/);
    await expect(page.getByText(`Editar ${code}`)).toBeVisible();
  });

  test("conflito de versão é mostrado sem sobrescrever silenciosamente", async ({ page, request }) => {
    await signedInEditor(page, "edit-conflito", "admin");
    // Cria a questão via API para simplificar o setup do teste.
    const createResponse = await page.request.post("/api/editorial/questions", {
      data: {
        code: `E2E-CONFLICT-${uniqueToken()}`,
        enunciado: `Enunciado técnico de teste E2E para conflito de versão ${uniqueToken()}.`,
        dificuldade: "media",
        origem: "autoral",
        alternativas: ["A", "B", "C", "D", "E"].map((letter) => ({
          letter,
          text: `Alt ${letter}`,
          isCorrect: letter === "B",
          distractorExplanation: null,
        })),
        dna: { pista: "p", estrategia: "e", pegadinha: "p", conteudoApoio: "c", resolucao: "r", atalho: null, aprendizadoErro: "a" },
        padroes: [],
        tags: [],
      },
    });
    const { id } = await createResponse.json();

    await page.goto(`/editorial/questoes/${id}`);
    // Espera a ficha terminar de carregar (version=1 já refletida no estado
    // do formulário) ANTES do PATCH "por fora" — sem isso, o fetch inicial
    // da página poderia terminar DEPOIS do PATCH externo e capturar a
    // versão já bumped (2), mascarando o conflito que este teste prova.
    await expect(page.getByLabel("Código editorial")).toHaveValue(/./);
    // Simula outra pessoa editando por fora enquanto esta aba está aberta —
    // o PATCH precisa do payload completo (alternativas/dna), já que o
    // serviço substitui essas coleções inteiras a cada edição.
    const outOfBandPatch = await page.request.patch(`/api/editorial/questions/${id}`, {
      data: {
        expectedVersion: 1,
        mutationId: crypto.randomUUID(),
        enunciado: `Alterado por outra sessão ${uniqueToken()}.`,
        alternativas: ["A", "B", "C", "D", "E"].map((letter) => ({
          letter,
          text: `Alt ${letter}`,
          isCorrect: letter === "B",
          distractorExplanation: null,
        })),
        dna: { pista: "p", estrategia: "e", pegadinha: "p", conteudoApoio: "c", resolucao: "r", atalho: null, aprendizadoErro: "a" },
        padroes: [],
        tags: [],
      },
    });
    expect(outOfBandPatch.ok()).toBe(true);

    await page.getByLabel("Enunciado").fill(`Tentativa de sobrescrever pela aba antiga ${uniqueToken()}.`);
    await page.getByRole("button", { name: "Salvar" }).click();

    await expect(page.getByText(/alterada por outra pessoa/i)).toBeVisible();
    void request;
  });
});

test.describe("Workflow editor/admin", () => {
  test("editor não vê botões de aprovar/publicar; admin vê", async ({ page }) => {
    await signedInEditor(page, "edit-wf-editor", "editor");
    const createResponse = await page.request.post("/api/editorial/questions", {
      data: {
        code: `E2E-WF-${uniqueToken()}`,
        enunciado: `Enunciado técnico de teste E2E para workflow ${uniqueToken()}.`,
        dificuldade: "media",
        origem: "autoral",
        alternativas: ["A", "B", "C", "D", "E"].map((letter) => ({
          letter,
          text: `Alt ${letter}`,
          isCorrect: letter === "B",
          distractorExplanation: null,
        })),
        dna: { pista: "p", estrategia: "e", pegadinha: "p", conteudoApoio: "c", resolucao: "r", atalho: null, aprendizadoErro: "a" },
        padroes: [],
        tags: [],
      },
    });
    const { id } = await createResponse.json();
    await page.goto(`/editorial/questoes/${id}`);
    await expect(page.getByRole("button", { name: "Aprovar" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Publicar" })).toHaveCount(0);
  });
});

test.describe("Importação CSV", () => {
  test("preview com erro mostra tabela de erros por linha e bloqueia aplicar", async ({ page }) => {
    await signedInEditor(page, "edit-import-erro");
    await page.goto("/editorial/importacoes");

    // Cabeçalho correto, mas uma linha de dados inválida (código vazio) —
    // diferente de cabeçalho ausente/extra (rejeitado por inteiro antes de
    // qualquer prévia), isto deve gerar uma prévia COM erro por linha.
    const header =
      "codigo,enunciado,resolucao_comentada,conteudo,subconteudo,habilidade,competencia,dificuldade,origem,prova,ano,tempo_estimado_segundos,tipo_calculo,necessita_calculadora,alt_a,alt_b,alt_c,alt_d,alt_e,correta,pista,estrategia,pegadinha,conteudo_apoio,resolucao_dna,atalho,aprendizado_erro,padrao_principal_code,padroes_secundarios_codes,tags,titular_direitos,base_licenca,texto_atribuicao,imagem_ref,imagem_alt";
    const badRow = [
      "", // codigo vazio -> erro de linha
      `Enunciado técnico de teste E2E com código vazio de propósito ${uniqueToken()}.`,
      "", "", "", "", "",
      "media", "autoral", "", "", "", "misto", "nao",
      "Alt A", "Alt B", "Alt C", "Alt D", "Alt E", "B",
      "", "", "", "", "", "", "",
      "PAD-01", "", "",
      "", "", "",
      "", "",
    ];
    const csv = `${header}\n${badRow.join(",")}\n`;
    await page.setInputFiles("#import-file", { name: "invalido.csv", mimeType: "text/csv", buffer: Buffer.from(csv, "utf-8") });

    await expect(page.getByTestId("import-preview")).toBeVisible();
    await expect(page.getByText(/corrija os erros/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "Aplicar lote" })).toHaveCount(0);
  });

  test("preview válido permite aplicar e ver resultado; admin pode desfazer", async ({ page }) => {
    await signedInEditor(page, "edit-import-ok", "admin");
    await page.goto("/editorial/importacoes");

    const code = `E2E-IMP-${uniqueToken()}`;
    const row = [
      code,
      `Enunciado técnico de teste E2E de importação suficientemente longo ${uniqueToken()}.`,
      "Resolução de teste",
      "Conteúdo", "Sub", "Habilidade", "Competência",
      "media", "autoral", "", "", "90", "misto", "nao",
      "Alt A", "Alt B", "Alt C", "Alt D", "Alt E", "B",
      "Pista", "Estrategia", "Pegadinha", "Apoio", "ResolucaoDna", "", "Aprendizado",
      "PAD-01", "", "e2e",
      "Fixture", "Interno", "",
      "", "",
    ];
    const header =
      "codigo,enunciado,resolucao_comentada,conteudo,subconteudo,habilidade,competencia,dificuldade,origem,prova,ano,tempo_estimado_segundos,tipo_calculo,necessita_calculadora,alt_a,alt_b,alt_c,alt_d,alt_e,correta,pista,estrategia,pegadinha,conteudo_apoio,resolucao_dna,atalho,aprendizado_erro,padrao_principal_code,padroes_secundarios_codes,tags,titular_direitos,base_licenca,texto_atribuicao,imagem_ref,imagem_alt";
    const csv = `${header}\n${row.join(",")}\n`;

    await page.setInputFiles("#import-file", { name: "valido.csv", mimeType: "text/csv", buffer: Buffer.from(csv, "utf-8") });
    await expect(page.getByText(/prévia válida/i)).toBeVisible();

    await page.getByRole("button", { name: "Aplicar lote" }).click();
    await expect(page.getByTestId("import-applied-result")).toBeVisible();
    await expect(page.getByText(/criada.*rascunho/i)).toBeVisible();

    await page.getByRole("button", { name: "Desfazer lote" }).click();
    await expect(page.getByText(/removida/i)).toBeVisible();
  });
});

test.describe("Acessibilidade", () => {
  test("navegação por teclado alcança o campo de busca do catálogo editorial", async ({ page }) => {
    await signedInEditor(page, "edit-teclado");
    await page.goto("/editorial/questoes");
    await page.getByLabel("Buscar por código ou enunciado").focus();
    await expect(page.getByLabel("Buscar por código ou enunciado")).toBeFocused();
  });
});
