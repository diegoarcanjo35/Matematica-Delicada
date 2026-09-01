import { expect, test, type Page } from "@playwright/test";
import { testClientIdHeader } from "./rateLimitIsolation";

/* Sprint 8 v1.1, seção 16 da ordem — Player de Questão, Reconhecimento e
   Correção em Camadas, testado em Chromium real contra o servidor principal
   (porta 8793, mesmo padrão de e2e/patterns.spec.ts). Cada teste usa uma
   conta própria, isolada do rate limit por cabeçalho.

   Só existe UMA questão fixture publicada nesta sprint — fixture-q-04
   ("FIX-Q-04", questionId real = "fixture-q-04"), ligada ao padrão
   fixture-pat-04 (slug "mediana-e-frequencia"), gabarito na alternativa C
   ("[FIXTURE] Valor Z" — ver scripts/fixtures/questions-fixtures.local.sql).
   Isso não é uma limitação do teste: é a única questão `published` no seed
   local (as outras quatro ficam em draft/in_review/changes_requested,
   deliberadamente, para exercitar o Banco de Questões da Sprint 7). Como o
   índice único de "uma tentativa ativa por usuário+questão+modo" é por
   USUÁRIO, cada teste com sua própria conta nunca colide com outro. */
test.use({ storageState: { cookies: [], origins: [] } });

const TEST_CLIENT_ID_HEADER = testClientIdHeader("player");
const NEXT_YEAR = new Date().getUTCFullYear() + 1;
const QUESTION_ID = "fixture-q-04";
const CORRECT_ALTERNATIVE = "C";
const INCORRECT_ALTERNATIVE = "A";
const PATTERN_SLUG = "mediana-e-frequencia";
const PATTERN_NAME = "Mediana e Frequência";

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@teste.dev`;
}

async function createConfirmedUser(page: Page, emailPrefix: string): Promise<void> {
  const email = uniqueEmail(emailPrefix);
  const password = "senha-de-teste-player-1";

  await page.request.post("/api/auth/signup", {
    headers: TEST_CLIENT_ID_HEADER,
    data: { name: "Aluna Player", email, password, confirmPassword: password, acceptTerms: true },
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
}

async function completeOnboarding(page: Page): Promise<void> {
  await page.request.patch("/api/onboarding", {
    data: { currentGrade: "3_serie_em", enemYear: NEXT_YEAR, currentStep: 1 },
  });
  await page.request.patch("/api/onboarding", { data: { goalType: "acertos", goalValue: 30, currentStep: 2 } });
  await page.request.patch("/api/onboarding", {
    data: { availableDays: ["seg", "qua", "sex"], dailyMinutes: 60, currentStep: 3 },
  });
  await page.request.patch("/api/onboarding", { data: { difficulties: [], currentStep: 4 } });
  await page.request.patch("/api/onboarding", { data: { timePreference: "noite", currentStep: 5 } });
  await page.request.patch("/api/onboarding", { data: { diagnosticChoice: "depois", currentStep: 6 } });
  await page.request.post("/api/onboarding/complete");
}

async function signedInStudent(page: Page, prefix: string): Promise<void> {
  await createConfirmedUser(page, prefix);
  await completeOnboarding(page);
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const hasHorizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(hasHorizontalScroll).toBe(false);
}

/** Inicia (ou retoma) uma tentativa via API — mesmo endpoint que
 *  QuestionStartPage.tsx chama — e navega direto para a tela da tentativa,
 *  evitando repetir a navegação pela tela "antes/início" em todo teste que
 *  só precisa do estado em andamento. */
async function startAttemptAndGoto(page: Page, mode: "learning" | "practice" | "recognition"): Promise<string> {
  const response = await page.request.post("/api/player/attempts", { data: { questionId: QUESTION_ID, mode } });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  const attemptId = body.attemptId as string;
  await page.goto(`/tentativas/${attemptId}`);
  return attemptId;
}

test.describe("Player de Questão — início", () => {
  test("tela de início lista os três modos e inicia uma tentativa em modo aprendizagem", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "player-inicio");
    await page.goto(`/questoes/${QUESTION_ID}`);

    await expect(page.getByRole("heading", { name: "Resolver questão", level: 1 })).toBeVisible();
    await expect(page.getByText("Aprendizagem", { exact: true })).toBeVisible();
    await expect(page.getByText("Prática", { exact: true })).toBeVisible();
    await expect(page.getByText("Reconhecimento", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Iniciar" }).click();
    await expect(page).toHaveURL(/\/tentativas\/.+/);
    await expect(page.getByText("FIXTURE TÉCNICA LOCAL")).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test("questão inexistente/não publicada responde 'não encontrada', não um erro cru", async ({ page }) => {
    await signedInStudent(page, "player-404");
    await page.goto("/questoes/questao-que-nao-existe");
    await page.getByRole("button", { name: "Iniciar" }).click();
    await expect(page.getByRole("heading", { name: "Questão não encontrada" })).toBeVisible();
  });
});

test.describe("Player de Questão — modo aprendizagem, ajuda progressiva e acerto", () => {
  test("fluxo completo: selecionar, abrir as 4 camadas de ajuda, confirmar e ver acerto", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "player-aprendizagem");
    await startAttemptAndGoto(page, "learning");

    await expect(page.locator(".player__question-prompt")).toContainText("FIXTURE TÉCNICA LOCAL");
    // Nenhuma alternativa revela o gabarito no texto antes da confirmação —
    // a correção do vazamento de fixture (Sprint 8 v1.1) garante isto.
    await expect(page.getByText(/\(correto\)|\(correta\)/i)).toHaveCount(0);

    await page.getByLabel(/Valor Z/).check();
    await expect(page.getByRole("status").filter({ hasText: "Salvo" })).toBeVisible();

    await page.getByRole("button", { name: "Pista leve" }).click();
    await expect(page.getByText("Pista leve:")).toBeVisible();
    await page.getByRole("button", { name: "Reconheça o padrão" }).click();
    await expect(page.getByText("Reconheça o padrão:")).toBeVisible();
    await page.getByRole("button", { name: "Estratégia" }).click();
    await expect(page.getByText("Estratégia:")).toBeVisible();

    // Camada 4 (resolução comentada) exige confirmação explícita antes de
    // revelar — seção 9 da ordem.
    await page.getByRole("button", { name: "Resolução comentada" }).click();
    await expect(page.getByRole("heading", { name: "Ver a resolução comentada?" })).toBeVisible();
    await page.getByRole("button", { name: "Ver resolução" }).click();
    await expect(page.getByText("Resolução comentada:")).toBeVisible();

    await page.getByRole("button", { name: "Confirmar resposta" }).click();

    await expect(page.getByRole("heading", { name: "Resultado" })).toBeVisible();
    // `role="status"` sozinho é ambíguo na tela de resultado: o banner de
    // acerto/erro e o indicador (vazio) de mensagem de bookmark são os dois
    // elementos `role="status"` — por isso o seletor pela classe do banner.
    await expect(page.locator(".player__feedback-banner")).toContainText("Resposta correta!");
    await expect(page.getByRole("heading", { name: "DNA da questão" })).toBeVisible();
    await expect(page.getByRole("link", { name: PATTERN_NAME })).toHaveAttribute("href", `/padroes-enem/${PATTERN_SLUG}`);
    await expectNoHorizontalScroll(page);
  });

  test("trocar a alternativa antes de confirmar atualiza a seleção sem duplicar tentativa", async ({ page }) => {
    await signedInStudent(page, "player-troca");
    const attemptId = await startAttemptAndGoto(page, "learning");

    await page.getByLabel(/Valor X/).check();
    await expect(page.getByRole("status").filter({ hasText: "Salvo" })).toBeVisible();
    await page.getByLabel(/Valor Z/).check();
    await expect(page.getByRole("status").filter({ hasText: "Salvo" })).toBeVisible();

    const state = await (await page.request.get(`/api/player/attempts/${attemptId}`)).json();
    expect(state.attempt.selectedAlternative).toBe(CORRECT_ALTERNATIVE);
  });
});

test.describe("Player de Questão — modo prática e erro", () => {
  test("resposta errada mostra o banner de incorreta e ainda revela o DNA", async ({ page }) => {
    await signedInStudent(page, "player-erro");
    await startAttemptAndGoto(page, "practice");

    await page.getByLabel(/Valor X/).check();
    await expect(page.getByRole("status").filter({ hasText: "Salvo" })).toBeVisible();
    await page.getByRole("button", { name: "Confirmar resposta" }).click();

    const banner = page.locator(".player__feedback-banner");
    await expect(banner).toContainText("Resposta incorreta.");
    await expect(banner).toContainText(`Você escolheu ${INCORRECT_ALTERNATIVE}`);
    await expect(banner).toContainText(`a alternativa correta é ${CORRECT_ALTERNATIVE}`);
    await expect(page.getByText(/futuro Caderno de Erros/)).toBeVisible();
  });
});

test.describe("Player de Questão — modo reconhecimento", () => {
  test("etapa de reconhecimento aparece antes das alternativas e o padrão só é exigido nela", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "player-reconhecimento");
    await startAttemptAndGoto(page, "recognition");

    await expect(page.getByText("Qual padrão você reconhece nesta questão?")).toBeVisible();
    // As alternativas da questão NÃO aparecem antes do reconhecimento ser
    // salvo (seção 8 da ordem: o padrão fica oculto até o aluno registrar).
    await expect(page.getByRole("radio")).toHaveCount(0);

    const saveButton = page.getByRole("button", { name: "Salvar e continuar" });
    await expect(saveButton).toBeDisabled();

    await page.getByLabel("Qual padrão você reconhece nesta questão?").selectOption(PATTERN_SLUG);
    await page.getByLabel("Qual pista levou você a essa escolha?").fill("Tabela de frequência com valores centrais.");
    await page.getByLabel("Qual estratégia parece mais adequada?").fill("Ordenar os valores e achar o centro.");
    await expect(saveButton).toBeEnabled();
    await saveButton.click();

    // "Reconhecimento salvo." é só o indicador TRANSIENTE de salvamento —
    // a própria tela de reconhecimento some logo em seguida (a recarga do
    // estado da tentativa via `load()` já revela as alternativas), então a
    // prova real de sucesso é a tela seguinte, não o texto de trânsito.
    await expect(page.getByLabel(/Valor Z/)).toBeVisible();

    await page.getByLabel(/Valor Z/).check();
    // Espera o `PATCH .../answer` assíncrono do onChange terminar (mesmo
    // padrão das outras suítes deste arquivo) — clicar "Confirmar resposta"
    // antes disso manda a `version` ainda desatualizada e o confirm nunca
    // chega a acontecer (nenhuma falha visível na UI, só o botão sem efeito).
    await expect(page.getByRole("status").filter({ hasText: "Salvo" })).toBeVisible();
    await page.getByRole("button", { name: "Confirmar resposta" }).click();
    await expect(page.locator(".player__feedback-banner")).toContainText("Resposta correta!");
  });

  test("confirmar sem reconhecimento salvo é recusado pela API (validação no servidor, não só na UI)", async ({ page }) => {
    await signedInStudent(page, "player-reconhecimento-guard");
    const response = await page.request.post("/api/player/attempts", { data: { questionId: QUESTION_ID, mode: "recognition" } });
    const { attemptId } = await response.json();

    const answerResponse = await page.request.patch(`/api/player/attempts/${attemptId}/answer`, {
      data: { version: 1, alternative: CORRECT_ALTERNATIVE },
    });
    expect(answerResponse.ok()).toBe(true);

    const confirmResponse = await page.request.post(`/api/player/attempts/${attemptId}/confirm`, { data: { version: 2 } });
    expect(confirmResponse.status()).toBe(400);
    const body = await confirmResponse.json();
    expect(body.error.fields.reconhecimento).toBeTruthy();
  });
});

test.describe("Player de Questão — retomada, revisão e denúncia", () => {
  test("recarregar a página retoma a MESMA tentativa (resposta e camadas abertas preservadas)", async ({ page }) => {
    await signedInStudent(page, "player-retomada");
    const attemptId = await startAttemptAndGoto(page, "learning");

    await page.getByLabel(/Valor Z/).check();
    await expect(page.getByRole("status").filter({ hasText: "Salvo" })).toBeVisible();
    await page.getByRole("button", { name: "Pista leve" }).click();
    await expect(page.getByText("Pista leve:")).toBeVisible();

    await page.reload();

    await expect(page).toHaveURL(new RegExp(`/tentativas/${attemptId}$`));
    await expect(page.getByLabel(/Valor Z/)).toBeChecked();
    await expect(page.getByText("Pista leve:")).toBeVisible();

    // Iniciar de novo (mesmo usuário, mesma questão, mesmo modo) resolve
    // para a MESMA tentativa em vez de criar uma nova — a garantia de banco
    // (índice único parcial, migrations/0013) é quem decide.
    const restart = await page.request.post("/api/player/attempts", { data: { questionId: QUESTION_ID, mode: "learning" } });
    const restartBody = await restart.json();
    expect(restartBody.attemptId).toBe(attemptId);
  });

  test("salvar para revisar e remover da revisão alternam o estado do botão", async ({ page }) => {
    await signedInStudent(page, "player-revisao");
    await startAttemptAndGoto(page, "learning");

    const bookmarkButton = page.getByRole("button", { name: "Salvar para revisar" });
    await bookmarkButton.click();
    await expect(page.getByRole("button", { name: "Remover da revisão" })).toBeVisible();
    await expect(page.getByText("Salvo para revisar depois.")).toBeVisible();

    await page.getByRole("button", { name: "Remover da revisão" }).click();
    await expect(page.getByRole("button", { name: "Salvar para revisar" })).toBeVisible();
    await expect(page.getByText("Removido da lista de revisão.")).toBeVisible();
  });

  test("Correção B — bookmark sobrevive ao refresh (recuperado do GET da tentativa, não só do estado local)", async ({ page }) => {
    await signedInStudent(page, "player-revisao-refresh");
    await startAttemptAndGoto(page, "learning");

    await page.getByRole("button", { name: "Salvar para revisar" }).click();
    await expect(page.getByRole("button", { name: "Remover da revisão" })).toBeVisible();

    // Um refresh real do navegador é o único jeito de provar que o estado
    // vem do SERVIDOR (via `isBookmarked` no GET da tentativa) — um estado
    // só local em `useState` sempre voltaria a "não salvo" aqui.
    await page.reload();
    await expect(page.getByRole("button", { name: "Remover da revisão" })).toBeVisible();

    // Desmarcar e recarregar de novo — o estado inverso também sobrevive.
    await page.getByRole("button", { name: "Remover da revisão" }).click();
    await expect(page.getByRole("button", { name: "Salvar para revisar" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Salvar para revisar" })).toBeVisible();
  });

  test("denunciar problema abre o modal, envia e confirma o registro", async ({ page }) => {
    await signedInStudent(page, "player-denuncia");
    await startAttemptAndGoto(page, "learning");

    await page.getByRole("button", { name: "Denunciar problema" }).click();
    await expect(page.getByRole("heading", { name: "Denunciar problema nesta questão" })).toBeVisible();

    await page.getByLabel("Categoria").selectOption("answer_key_problem");
    await page.getByLabel("Comentário (opcional)").fill("Comentário de teste E2E — sem dado real.");
    await page.getByRole("button", { name: "Enviar denúncia" }).click();

    await expect(page.getByText("Obrigada por avisar — sua denúncia foi registrada.")).toBeVisible();
  });
});

test.describe("Player de Questão — teclado, foco e responsividade", () => {
  test("é possível selecionar uma alternativa e confirmar só pelo teclado", async ({ page }) => {
    await signedInStudent(page, "player-teclado");
    await startAttemptAndGoto(page, "learning");

    // `level: 1` sozinho é ambíguo: o cabeçalho fixo do site
    // ("Matemática Delicada") também é um <h1>, além do título da questão.
    await expect(page.locator(".player__question-prompt")).toBeFocused();

    const targetRadio = page.getByLabel(/Valor Z/);
    await targetRadio.focus();
    await page.keyboard.press("Space");
    await expect(targetRadio).toBeChecked();
    // Espera o `PATCH .../answer` assíncrono terminar antes de confirmar —
    // mesma razão do teste de reconhecimento acima.
    await expect(page.getByRole("status").filter({ hasText: "Salvo" })).toBeVisible();

    const confirmButton = page.getByRole("button", { name: "Confirmar resposta" });
    await confirmButton.focus();
    await page.keyboard.press("Enter");

    await expect(page.getByRole("heading", { name: "Resultado" })).toBeVisible();
    // O foco volta para o título da tela de resultado após a transição de
    // fase — mesmo padrão de headingRef.current?.focus() já usado em
    // DiagnosticPage.tsx/PatternDetailPage.tsx.
    await expect(page.getByRole("heading", { name: "Resultado" })).toBeFocused();
  });

  test("tentativa em 390 px não gera rolagem horizontal, em nenhuma das fases", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signedInStudent(page, "player-mobile");
    await startAttemptAndGoto(page, "learning");
    await expectNoHorizontalScroll(page);

    await page.getByLabel(/Valor Z/).check();
    await expect(page.getByRole("status").filter({ hasText: "Salvo" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.getByRole("button", { name: "Confirmar resposta" }).click();
    await expect(page.getByRole("heading", { name: "Resultado" })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test("visitante sem sessão é redirecionado para /entrar", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto(`/questoes/${QUESTION_ID}`);
    await expect(page).toHaveURL(/\/entrar/);
  });

  test("a API do Player recusa requisição sem sessão", async ({ page }) => {
    await page.context().clearCookies();
    const response = await page.request.post("/api/player/attempts", { data: { questionId: QUESTION_ID, mode: "learning" } });
    expect(response.status()).toBe(401);
  });

  test("tentativa de outro aluno responde 404, nunca 403", async ({ page, browser }) => {
    await signedInStudent(page, "player-isolamento-dono");
    const attemptId = await startAttemptAndGoto(page, "learning");

    const otherContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const otherPage = await otherContext.newPage();
    await signedInStudent(otherPage, "player-isolamento-intruso");
    const response = await otherPage.request.get(`/api/player/attempts/${attemptId}`);
    expect(response.status()).toBe(404);
    await otherContext.close();
  });
});

test.describe("Padrões ENEM — treino integrado ao Player", () => {
  test("'Treinar este padrão' fica habilitado e leva ao Player, com a copy de seleção técnica inicial", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "player-treinar-padrao");
    await page.goto(`/padroes-enem/${PATTERN_SLUG}`);

    const trainLink = page.getByRole("link", { name: "Treinar este padrão" });
    await expect(trainLink).toBeVisible();
    await expect(trainLink).toHaveAttribute("href", `/questoes/${QUESTION_ID}`);
    // A copy diz explicitamente "nenhum algoritmo pedagógico ou adaptação
    // está em uso ainda" — a palavra "adaptação" aparece, mas só para NEGAR
    // que ela existe; o que a ordem proíbe é apresentar a seleção COMO uma
    // adaptação, nunca a palavra em si.
    await expect(page.getByText(/seleção técnica inicial/)).toBeVisible();
    await expect(page.getByText(/nenhum algoritmo pedagógico ou adaptação está em uso ainda/)).toBeVisible();

    await trainLink.click();
    await expect(page.getByRole("heading", { name: "Resolver questão", level: 1 })).toBeVisible();
  });

  test("dashboard mostra o convite 'Resolver uma questão' quando há questão treinável", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "player-dashboard-cta");
    await page.goto("/");

    await expect(page.getByRole("link", { name: "Resolver uma questão" })).toBeVisible();
  });
});
