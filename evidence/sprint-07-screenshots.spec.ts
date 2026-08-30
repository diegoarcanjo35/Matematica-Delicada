import { expect, test, type Page } from "@playwright/test";
import { testClientIdHeader } from "../e2e/rateLimitIsolation";

/* Sprint 7 v1.0, seção 12 da ordem — as DOZE evidências visuais obrigatórias
   do Banco de Questões e Importação Editorial, geradas por automação real.
   Mesmo padrão das evidências das sprints anteriores: conta própria por
   teste, dados evidentemente fictícios/fixture, sem nenhuma credencial ou
   token visível, isolamento de rate limit por cabeçalho. Papel editor/admin
   concedido só via o bootstrap local gateado
   (POST /api/dev/editorial/bootstrap-role), nunca via GET, nunca a outro
   usuário. */
test.use({ storageState: { cookies: [], origins: [] } });

const TEST_CLIENT_ID_HEADER = testClientIdHeader("sprint-07-screenshots");
const FICTITIOUS_PASSWORD = "senha-evidencia-fake-editorial-1";
const SHOTS_DIR = "evidence/screenshots/sprint-07";

function uniqueFictitiousEmail(): string {
  return `evidencia-sprint7-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@evidencia.teste`;
}

function uniqueToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function createConfirmedFictitiousUser(page: Page): Promise<void> {
  const email = uniqueFictitiousEmail();
  await page.request.post("/api/auth/signup", {
    headers: TEST_CLIENT_ID_HEADER,
    data: {
      name: "Editora Demonstração Sprint7",
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

async function fictitiousEditor(page: Page, role: "editor" | "admin" = "editor"): Promise<void> {
  await createConfirmedFictitiousUser(page);
  const response = await page.request.post("/api/dev/editorial/bootstrap-role", { data: { role } });
  expect(response.ok()).toBe(true);
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const hasHorizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(hasHorizontalScroll).toBe(false);
}

async function createDemoQuestion(page: Page): Promise<string> {
  const response = await page.request.post("/api/editorial/questions", {
    data: {
      code: `EVID-${uniqueToken()}`,
      enunciado: `FIXTURE TÉCNICA LOCAL — NÃO PUBLICAR — NÃO É QUESTÃO OFICIAL. Enunciado de demonstração ${uniqueToken()}.`,
      dificuldade: "media",
      origem: "autoral",
      alternativas: ["A", "B", "C", "D", "E"].map((letter) => ({
        letter,
        text: `Alternativa ${letter} de demonstração`,
        isCorrect: letter === "B",
        distractorExplanation: null,
      })),
      dna: {
        pista: "Pista de demonstração",
        estrategia: "Estratégia de demonstração",
        pegadinha: "Pegadinha de demonstração",
        conteudoApoio: "Conteúdo de apoio de demonstração",
        resolucao: "Resolução de demonstração",
        atalho: null,
        aprendizadoErro: "Aprendizado de demonstração",
      },
      // Padrão principal necessário para a evidência "workflow-em-revisao"
      // conseguir avançar até in_review — fixture-pat-01 vem do seed de
      // patterns-fixtures.local.sql, já aplicado pela cadeia worker:preview.
      padroes: [{ patternId: "fixture-pat-01", role: "principal" }],
      tags: ["demonstracao"],
    },
  });
  const body = await response.json();
  return body.id as string;
}

test.describe("Evidências visuais — Sprint 7 (Banco de Questões e Importação)", () => {
  test("banco-questoes-desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await fictitiousEditor(page);
    await createDemoQuestion(page);
    await page.goto("/editorial/questoes");
    await expect(page.getByRole("heading", { name: "Banco de Questões" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: `${SHOTS_DIR}/banco-questoes-desktop.png` });
  });

  test("banco-questoes-mobile-390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await fictitiousEditor(page);
    await createDemoQuestion(page);
    await page.goto("/editorial/questoes");
    await expect(page.getByRole("heading", { name: "Banco de Questões" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: `${SHOTS_DIR}/banco-questoes-mobile-390px.png` });
  });

  test("banco-filtros-status", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await fictitiousEditor(page);
    await createDemoQuestion(page);
    await page.goto("/editorial/questoes");
    await page.getByLabel("Status").selectOption("draft");
    await expect(page).toHaveURL(/status=draft/);
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: `${SHOTS_DIR}/banco-filtros-status.png` });
  });

  test("editor-questao-dados-basicos", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await fictitiousEditor(page);
    const id = await createDemoQuestion(page);
    await page.goto(`/editorial/questoes/${id}`);
    await expect(page.getByRole("group", { name: "Dados básicos" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/editor-questao-dados-basicos.png` });
  });

  test("editor-questao-alternativas", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await fictitiousEditor(page);
    const id = await createDemoQuestion(page);
    await page.goto(`/editorial/questoes/${id}`);
    const group = page.getByRole("group", { name: "Alternativas (A-E)" });
    await group.scrollIntoViewIfNeeded();
    await expect(group).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/editor-questao-alternativas.png` });
  });

  test("editor-questao-dna-padroes", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await fictitiousEditor(page);
    const id = await createDemoQuestion(page);
    await page.goto(`/editorial/questoes/${id}`);
    const group = page.getByRole("group", { name: "DNA da questão" });
    await group.scrollIntoViewIfNeeded();
    await expect(group).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/editor-questao-dna-padroes.png` });
  });

  test("editor-questao-direitos", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await fictitiousEditor(page);
    const id = await createDemoQuestion(page);
    await page.goto(`/editorial/questoes/${id}`);
    const group = page.getByRole("group", { name: "Direitos e licença" });
    await group.scrollIntoViewIfNeeded();
    await expect(group).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/editor-questao-direitos.png` });
  });

  test("workflow-em-revisao", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await fictitiousEditor(page, "admin");
    const id = await createDemoQuestion(page);
    // Submete para revisão pela própria API para chegar no estado
    // `in_review` de forma determinística para a evidência.
    const detail = await (await page.request.get(`/api/editorial/questions/${id}`)).json();
    await page.request.post(`/api/editorial/questions/${id}/submit-review`, {
      data: { expectedVersion: detail.question.version },
    });
    await page.goto(`/editorial/questoes/${id}`);
    await expect(page.getByText(/status atual: in_review/)).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/workflow-em-revisao.png` });
  });

  test("importacao-preview-valida", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await fictitiousEditor(page);
    await page.goto("/editorial/importacoes");

    const header =
      "codigo,enunciado,resolucao_comentada,conteudo,subconteudo,habilidade,competencia,dificuldade,origem,prova,ano,tempo_estimado_segundos,tipo_calculo,necessita_calculadora,alt_a,alt_b,alt_c,alt_d,alt_e,correta,pista,estrategia,pegadinha,conteudo_apoio,resolucao_dna,atalho,aprendizado_erro,padrao_principal_code,padroes_secundarios_codes,tags,titular_direitos,base_licenca,texto_atribuicao,imagem_ref,imagem_alt";
    const row = [
      `EVID-IMP-${uniqueToken()}`,
      `Enunciado de demonstracao de importacao ${uniqueToken()}`,
      "Resolucao", "Conteudo", "Sub", "Habilidade", "Competencia",
      "media", "autoral", "", "", "90", "misto", "nao",
      "Alt A", "Alt B", "Alt C", "Alt D", "Alt E", "B",
      "Pista", "Estrategia", "Pegadinha", "Apoio", "ResolucaoDna", "", "Aprendizado",
      "PAD-01", "", "demonstracao",
      "Fixture", "Interno", "", "", "",
    ];
    const csv = `${header}\n${row.join(",")}\n`;
    await page.setInputFiles("#import-file", { name: "evidencia.csv", mimeType: "text/csv", buffer: Buffer.from(csv, "utf-8") });
    await expect(page.getByText(/prévia válida/i)).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/importacao-preview-valida.png` });
  });

  test("importacao-erros-por-linha", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await fictitiousEditor(page);
    await page.goto("/editorial/importacoes");

    const header =
      "codigo,enunciado,resolucao_comentada,conteudo,subconteudo,habilidade,competencia,dificuldade,origem,prova,ano,tempo_estimado_segundos,tipo_calculo,necessita_calculadora,alt_a,alt_b,alt_c,alt_d,alt_e,correta,pista,estrategia,pegadinha,conteudo_apoio,resolucao_dna,atalho,aprendizado_erro,padrao_principal_code,padroes_secundarios_codes,tags,titular_direitos,base_licenca,texto_atribuicao,imagem_ref,imagem_alt";
    const badRow = [
      "", `Enunciado de demonstracao com erro de propósito ${uniqueToken()}`,
      "", "", "", "", "",
      "media", "autoral", "", "", "", "misto", "nao",
      "Alt A", "Alt B", "Alt C", "Alt D", "Alt E", "B",
      "", "", "", "", "", "", "",
      "PAD-01", "", "",
      "", "", "", "", "",
    ];
    const csv = `${header}\n${badRow.join(",")}\n`;
    await page.setInputFiles("#import-file", { name: "evidencia-erro.csv", mimeType: "text/csv", buffer: Buffer.from(csv, "utf-8") });
    await expect(page.getByTestId("import-error-table")).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/importacao-erros-por-linha.png` });
  });

  test("importacao-lote-aplicado", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await fictitiousEditor(page);
    await page.goto("/editorial/importacoes");

    const header =
      "codigo,enunciado,resolucao_comentada,conteudo,subconteudo,habilidade,competencia,dificuldade,origem,prova,ano,tempo_estimado_segundos,tipo_calculo,necessita_calculadora,alt_a,alt_b,alt_c,alt_d,alt_e,correta,pista,estrategia,pegadinha,conteudo_apoio,resolucao_dna,atalho,aprendizado_erro,padrao_principal_code,padroes_secundarios_codes,tags,titular_direitos,base_licenca,texto_atribuicao,imagem_ref,imagem_alt";
    const row = [
      `EVID-APLICADO-${uniqueToken()}`,
      `Enunciado de demonstracao aplicada ${uniqueToken()}`,
      "Resolucao", "Conteudo", "Sub", "Habilidade", "Competencia",
      "media", "autoral", "", "", "90", "misto", "nao",
      "Alt A", "Alt B", "Alt C", "Alt D", "Alt E", "B",
      "Pista", "Estrategia", "Pegadinha", "Apoio", "ResolucaoDna", "", "Aprendizado",
      "PAD-01", "", "demonstracao",
      "Fixture", "Interno", "", "", "",
    ];
    const csv = `${header}\n${row.join(",")}\n`;
    await page.setInputFiles("#import-file", { name: "evidencia-aplicar.csv", mimeType: "text/csv", buffer: Buffer.from(csv, "utf-8") });
    await expect(page.getByText(/prévia válida/i)).toBeVisible();
    await page.getByRole("button", { name: "Aplicar lote" }).click();
    await expect(page.getByTestId("import-applied-result")).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/importacao-lote-aplicado.png` });
  });

  test("acesso-negado-aluno", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await createConfirmedFictitiousUser(page); // sem bootstrap de papel — aluno comum
    await page.goto("/editorial/questoes");
    await expect(page.getByRole("heading", { name: "Acesso restrito" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS_DIR}/acesso-negado-aluno.png` });
  });
});
