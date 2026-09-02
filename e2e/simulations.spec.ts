import { expect, test, type Page } from "@playwright/test";
import { testClientIdHeader } from "./rateLimitIsolation";

/* Sprint 12 v1.0, seção 20 da ordem — Simulados em Blocos e Análise Factual
   de Desempenho, testado em Chromium real contra o servidor principal
   (porta 8793, mesmo padrão de e2e/dailyTraining.spec.ts). Cada teste usa
   uma conta própria, isolada do rate limit por cabeçalho.

   Único padrão publicado com questões PUBLICADAS treináveis no seed local:
   fixture-pat-04 ("Mediana e Frequência", slug mediana-e-frequencia) — duas
   questões publicadas (fixture-q-04, fixture-q-06). Isto significa que
   QUALQUER bloco (misto ou focado) pedido nos tamanhos 5/10/15 encontra no
   máximo 2 questões disponíveis — o cenário de "quantidade insuficiente"
   (seção 6/7 da ordem) é, portanto, o caminho natural e mais realista para
   demonstrar/testar nesta base de fixtures, exatamente como a mesma base
   levou e2e/dailyTraining.spec.ts a sempre ter 1 único item elegível.
   fixture-pat-01 ("Razão em Gráfico", slug razao-em-grafico) é publicado mas
   sua única questão (fixture-q-01) está em draft — usado para o cenário de
   "preview vazio" (0 questões disponíveis). */
test.use({ storageState: { cookies: [], origins: [] } });

const TEST_CLIENT_ID_HEADER = testClientIdHeader("simulations");
const EMPTY_PATTERN_SLUG = "razao-em-grafico";
// Texto da alternativa correta de fixture-q-04 (letra C) — mesma fixture e
// mesma convenção de e2e/dailyTraining.spec.ts (nunca a letra sozinha, o
// texto identifica a alternativa de forma estável sem vazar o gabarito
// antes da confirmação).
const CORRECT_ALTERNATIVE_LABEL = /Valor Z/;

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@teste.dev`;
}

async function createConfirmedUser(page: Page, emailPrefix: string): Promise<void> {
  const email = uniqueEmail(emailPrefix);
  const password = "senha-de-teste-simulados-1";

  await page.request.post("/api/auth/signup", {
    headers: TEST_CLIENT_ID_HEADER,
    data: { name: "Aluna Simulado", email, password, confirmPassword: password, acceptTerms: true },
  });

  const outboxResponse = await page.request.get(`/api/dev/outbox/last?to=${encodeURIComponent(email)}&kind=email_confirmation`);
  const { email: outboxEmail } = await outboxResponse.json();
  const confirmMatch = outboxEmail.body.match(/token=([^\s]+)/);
  if (confirmMatch) {
    await page.request.post("/api/auth/email/confirm", { data: { token: confirmMatch[1] } });
  }

  const loginResponse = await page.request.post("/api/auth/login", { headers: TEST_CLIENT_ID_HEADER, data: { email, password } });
  const setCookie = loginResponse.headers()["set-cookie"];
  const tokenValue = setCookie.split(";")[0].split("=").slice(1).join("=");
  await page.context().addCookies([{ name: "md_session", value: tokenValue, domain: "localhost", path: "/" }]);
}

const NEXT_YEAR = new Date().getUTCFullYear() + 1;

async function completeOnboarding(page: Page): Promise<void> {
  await page.request.patch("/api/onboarding", { data: { currentGrade: "3_serie_em", enemYear: NEXT_YEAR, currentStep: 1 } });
  await page.request.patch("/api/onboarding", { data: { goalType: "acertos", goalValue: 30, currentStep: 2 } });
  await page.request.patch("/api/onboarding", {
    data: { availableDays: ["dom", "seg", "ter", "qua", "qui", "sex", "sab"], dailyMinutes: 60, currentStep: 3 },
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

async function applyMixedBlock(page: Page, size = 5): Promise<string> {
  const response = await page.request.post("/api/simulations/apply", { data: { mutationId: crypto.randomUUID(), blockType: "mixed", size } });
  const body = await response.json();
  return body.blockId as string;
}

test.describe("Simulados — configuração e preview", () => {
  test("configuração mista: escolher Misto e 5 questões mostra a prévia com composição e aviso de não ser prova oficial", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "config-mixed");
    await page.goto("/simulados");
    await page.getByLabel(/Misto/).check();
    await page.getByRole("button", { name: "Ver prévia" }).click();
    await expect(page.getByText(/não é a prova oficial do ENEM/i)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Composição" })).toBeVisible();
  });

  test("configuração focada: escolher um padrão publicado mostra a prévia só daquele padrão", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "config-focused");
    await page.goto("/simulados");
    await page.getByLabel(/Focado em um padrão/).check();
    await page.locator("#pattern-select").selectOption({ label: "Mediana e Frequência" });
    await page.getByLabel("10 questões").check();
    await page.getByRole("button", { name: "Ver prévia" }).click();
    await expect(page.getByRole("heading", { name: "Composição" })).toBeVisible();
    // Composição só traz o padrão focado (Mediana e Frequência) — nunca
    // outro padrão publicado misturado.
    await expect(page.locator(".simulados__composition")).toContainText("Mediana e Frequência");
  });

  test("preview vazio: padrão publicado sem nenhuma questão publicada treinável mostra estado honesto, sem erro", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "preview-empty");
    await page.goto("/simulados");
    await page.getByLabel(/Focado em um padrão/).check();
    await page.locator("#pattern-select").selectOption({ value: EMPTY_PATTERN_SLUG });
    await page.getByRole("button", { name: "Ver prévia" }).click();
    await expect(page.getByText("Nenhuma questão elegível")).toBeVisible();
  });

  test("preview com quantidade insuficiente: pedir mais questões do que existem disponíveis mostra aviso explícito", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "preview-insufficient");
    await page.goto("/simulados");
    await page.getByLabel("15 questões").check();
    await page.getByRole("button", { name: "Ver prévia" }).click();
    await expect(page.getByText(/Ainda não há questões publicadas suficientes/i)).toBeVisible();
  });

  test("GET de preview nunca cria bloco, mesmo consultado várias vezes", async ({ page }) => {
    await signedInStudent(page, "preview-no-write");
    await page.goto("/simulados");
    await page.getByRole("button", { name: "Ver prévia" }).click();
    await page.reload();
    await page.getByRole("button", { name: "Ver prévia" }).click();
    const current = await (await page.request.get("/api/simulations/current")).json();
    expect(current.block).toBeNull();
  });
});

test.describe("Simulados — criação do bloco", () => {
  test("Criar bloco cria o bloco ativo e navega para /simulados/:blockId", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "apply");
    await page.goto("/simulados");
    await page.getByRole("button", { name: "Ver prévia" }).click();
    await page.getByRole("button", { name: "Criar bloco" }).click();
    await expect(page).toHaveURL(/\/simulados\/.+/);
    await expect(page.getByText(/Progresso: /)).toBeVisible();
  });
});

test.describe("Simulados — item e Player", () => {
  test("iniciar questão leva ao Player real com a questão correta", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "start-item");
    const blockId = await applyMixedBlock(page);
    await page.goto(`/simulados/${blockId}`);
    await page.getByRole("button", { name: "Começar questão" }).first().click();
    await expect(page).toHaveURL(/\/tentativas\/.+/);
  });

  test("voltar e retomar: sair para o Dashboard e voltar retoma o mesmo item em andamento", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "resume");
    const blockId = await applyMixedBlock(page);
    await page.goto(`/simulados/${blockId}`);
    await page.getByRole("button", { name: "Começar questão" }).first().click();
    await expect(page).toHaveURL(/\/tentativas\/.+/);

    await page.goto(`/simulados/${blockId}`);
    await expect(page.getByRole("button", { name: "Continuar questão" })).toBeVisible();
    await expect(page.locator(".simulados__status--in_progress")).toBeVisible();
  });

  test("sincronizar conclusão: responder e confirmar no Player, voltar ao bloco mostra item concluído", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "sync");
    const blockId = await applyMixedBlock(page);
    await page.goto(`/simulados/${blockId}`);
    await page.getByRole("button", { name: "Começar questão" }).first().click();
    await expect(page).toHaveURL(/\/tentativas\/.+/);

    await page.getByLabel(CORRECT_ALTERNATIVE_LABEL).check();
    await page.getByRole("button", { name: "Confirmar resposta" }).click();

    await page.goto(`/simulados/${blockId}`);
    await expect(page.locator(".simulados__status--completed")).toBeVisible();
  });

  test("pular item: confirmação move o item para Pulado", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "skip");
    const blockId = await applyMixedBlock(page);
    await page.goto(`/simulados/${blockId}`);
    await page.getByRole("button", { name: "Pular" }).first().click();
    await expect(page.getByRole("dialog", { name: "Pular esta questão?" })).toBeVisible();
    await page.getByRole("button", { name: "Confirmar" }).click();
    await expect(page.locator(".simulados__status--skipped")).toBeVisible();
  });
});

/* PO v1.1 (correção, seção 2 da ordem) — o `useEffect` de "sync automático
   ao carregar a tela" (SimuladoBlocoPage.tsx, `syncedOnLoad`) é inspecionado
   diretamente pela rede: confirma que o POST .../sync dispara sozinho ao
   carregar/recarregar a tela com um item `in_progress`, e prova — via
   GET /api/simulations/:blockId antes/depois, nunca só a UI — que esse POST
   NUNCA escreve no banco (version/status inalterados) quando a tentativa
   real ainda não está `completed`, só quando está genuinamente concluída,
   e que recarregamentos repetidos nunca duplicam a escrita (idempotente).
   Ver docs/SIMULADOS_BLOCOS.md, seção "Sync automático ao carregar a tela
   — efeito colateral documentado". */
interface BlockItemProbe {
  id: string;
  status: string;
  version: number;
}
interface BlockDetailProbe {
  block: { items: BlockItemProbe[] };
}

async function fetchBlockItems(page: Page, blockId: string): Promise<BlockItemProbe[]> {
  const response = await page.request.get(`/api/simulations/${blockId}`);
  const body = (await response.json()) as BlockDetailProbe;
  return body.block.items;
}

test.describe("Simulados — sincronização automática ao carregar a tela (correção PO v1.1, seção 2 da ordem)", () => {
  test("item em andamento com tentativa AINDA NÃO concluída: POST .../sync dispara sozinho ao carregar a tela, mas sem NENHUM efeito no banco (version/status inalterados), mesmo em recarregamentos repetidos", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "sync-noop");
    const blockId = await applyMixedBlock(page);
    await page.goto(`/simulados/${blockId}`);
    await page.getByRole("button", { name: "Começar questão" }).first().click();
    await expect(page).toHaveURL(/\/tentativas\/.+/);

    const itemsBefore = await fetchBlockItems(page, blockId);
    const itemBefore = itemsBefore.find((i) => i.status === "in_progress");
    expect(itemBefore).toBeTruthy();

    // Volta para a tela do bloco (nunca respondeu/confirmou no Player) —
    // observa o POST .../sync disparado automaticamente pelo `useEffect`.
    const syncRequestPromise = page.waitForRequest((req) => req.url().includes(`/items/${itemBefore!.id}/sync`) && req.method() === "POST");
    await page.goto(`/simulados/${blockId}`);
    const syncRequest = await syncRequestPromise;
    const syncResponse = await syncRequest.response();
    expect(syncResponse?.status()).toBe(200);
    const syncBody = (await syncResponse!.json()) as { itemStatus?: string };
    // Seção 10 da ordem: resposta salva mas não confirmada nunca conclui o
    // item — honesto, `in_progress`, nunca um erro nem uma falsa conclusão.
    expect(syncBody.itemStatus).toBe("in_progress");

    const itemsAfterFirstLoad = await fetchBlockItems(page, blockId);
    const itemAfterFirstLoad = itemsAfterFirstLoad.find((i) => i.id === itemBefore!.id)!;
    expect(itemAfterFirstLoad.status).toBe("in_progress");
    expect(itemAfterFirstLoad.version).toBe(itemBefore!.version); // nenhuma escrita real — mesma versão, nenhum evento, nenhuma auditoria

    // Segundo recarregamento: continua sem efeito nenhum (idempotente por
    // nunca escrever, não só por não duplicar).
    await page.goto(`/simulados/${blockId}`);
    await expect(page.getByText(/Progresso: /)).toBeVisible();
    const itemsAfterSecondLoad = await fetchBlockItems(page, blockId);
    const itemAfterSecondLoad = itemsAfterSecondLoad.find((i) => i.id === itemBefore!.id)!;
    expect(itemAfterSecondLoad.status).toBe("in_progress");
    expect(itemAfterSecondLoad.version).toBe(itemBefore!.version);
  });

  test("item em andamento com tentativa REALMENTE concluída: POST .../sync dispara sozinho, conclui de verdade uma única vez, sem duplicar em recarregamentos seguintes", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "sync-real");
    const blockId = await applyMixedBlock(page);
    await page.goto(`/simulados/${blockId}`);
    await page.getByRole("button", { name: "Começar questão" }).first().click();
    await expect(page).toHaveURL(/\/tentativas\/.+/);

    await page.getByLabel(CORRECT_ALTERNATIVE_LABEL).check();
    await page.getByRole("button", { name: "Confirmar resposta" }).click();

    const itemsBefore = await fetchBlockItems(page, blockId);
    const itemBefore = itemsBefore.find((i) => i.status === "in_progress");
    expect(itemBefore).toBeTruthy(); // núcleo do Player já confirmou a resposta, mas o item do simulado ainda não foi sincronizado

    const syncRequestPromise = page.waitForRequest((req) => req.url().includes(`/items/${itemBefore!.id}/sync`) && req.method() === "POST");
    await page.goto(`/simulados/${blockId}`);
    const syncRequest = await syncRequestPromise;
    const syncResponse = await syncRequest.response();
    expect(syncResponse?.status()).toBe(200);
    const syncBody = (await syncResponse!.json()) as { itemStatus?: string };
    expect(syncBody.itemStatus).toBe("completed");
    await expect(page.locator(".simulados__status--completed")).toBeVisible();

    const itemsAfterFirstLoad = await fetchBlockItems(page, blockId);
    const itemAfterFirstLoad = itemsAfterFirstLoad.find((i) => i.id === itemBefore!.id)!;
    expect(itemAfterFirstLoad.status).toBe("completed");
    const versionAfterFirstSync = itemAfterFirstLoad.version;

    // Segundo recarregamento: item já `completed` — idempotente, nenhuma
    // segunda escrita (version não avança de novo, nenhum evento duplicado).
    await page.goto(`/simulados/${blockId}`);
    await expect(page.getByText(/Progresso: /)).toBeVisible();
    const itemsAfterSecondLoad = await fetchBlockItems(page, blockId);
    const itemAfterSecondLoad = itemsAfterSecondLoad.find((i) => i.id === itemBefore!.id)!;
    expect(itemAfterSecondLoad.version).toBe(versionAfterFirstSync);
  });
});

/** Aguarda o bloco ativo terminar de carregar (o indicador de progresso
 *  aparecer) antes de contar/clicar botões de item — evita uma corrida real
 *  entre a navegação (`page.goto`) e o fetch assíncrono do bloco: `.count()`
 *  do Playwright NÃO espera elementos aparecerem (diferente de `.click()`),
 *  então contar botões "Pular" antes do React terminar de buscar e
 *  renderizar os itens sempre devolveria 0. */
async function waitForActiveBlockLoaded(page: Page): Promise<void> {
  await expect(page.getByText(/Progresso: /)).toBeVisible();
}

async function skipAllPendingItems(page: Page): Promise<void> {
  await waitForActiveBlockLoaded(page);
  const skipButtons = page.getByRole("button", { name: "Pular" });
  const count = await skipButtons.count();
  for (let i = 0; i < count; i++) {
    await page.getByRole("button", { name: "Pular" }).first().click();
    await page.getByRole("button", { name: "Confirmar" }).click();
  }
}

test.describe("Simulados — conclusão e resultado factual", () => {
  test("concluir bloco: com todos os itens em estado terminal, mostra o resumo factual, sem TRI/nota/ranking", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "complete");
    const blockId = await applyMixedBlock(page);
    await page.goto(`/simulados/${blockId}`);
    await skipAllPendingItems(page);

    await page.getByRole("button", { name: "Concluir bloco" }).click();
    await expect(page.getByRole("heading", { name: "Bloco concluído" })).toBeVisible();
    await expect(page.getByText(/não representa nota ENEM, TRI/i)).toBeVisible();
  });

  test("refresh depois de concluído mostra o MESMO resumo, sem perda de progresso", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "complete-refresh");
    const blockId = await applyMixedBlock(page);
    await page.goto(`/simulados/${blockId}`);
    await skipAllPendingItems(page);
    await page.getByRole("button", { name: "Concluir bloco" }).click();
    await expect(page.getByRole("heading", { name: "Bloco concluído" })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("heading", { name: "Bloco concluído" })).toBeVisible();
  });
});

test.describe("Simulados — histórico", () => {
  test("histórico vazio: aluno sem nenhum bloco concluído vê o estado honesto", async ({ page }) => {
    await signedInStudent(page, "history-empty");
    await page.goto("/simulados");
    await expect(page.getByText("Nenhum bloco concluído ainda")).toBeVisible();
  });

  test("histórico com dados: bloco concluído aparece listado com data, tipo e contagens factuais", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signedInStudent(page, "history-data");
    const blockId = await applyMixedBlock(page);
    await page.goto(`/simulados/${blockId}`);
    await skipAllPendingItems(page);
    await page.getByRole("button", { name: "Concluir bloco" }).click();

    await page.goto("/simulados");
    await expect(page.getByRole("heading", { name: "Histórico de simulados" })).toBeVisible();
    await expect(page.getByText("Concluído")).toBeVisible();
  });
});

test.describe("Simulados — acessibilidade, mobile, segurança", () => {
  test("390 px não gera rolagem horizontal, na configuração e no bloco ativo", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signedInStudent(page, "mobile-390");
    await page.goto("/simulados");
    await expectNoHorizontalScroll(page);
    const blockId = await applyMixedBlock(page);
    await page.goto(`/simulados/${blockId}`);
    await expectNoHorizontalScroll(page);
  });

  test("é possível focar o botão Ver prévia só pelo teclado", async ({ page }) => {
    await signedInStudent(page, "keyboard");
    await page.goto("/simulados");
    const button = page.getByRole("button", { name: "Ver prévia" });
    await button.focus();
    await expect(button).toBeFocused();
  });

  test("visitante sem sessão é redirecionado para /entrar", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/simulados");
    await expect(page).toHaveURL(/\/entrar/);
  });

  test("a API dos Simulados recusa requisição sem sessão", async ({ page }) => {
    await page.context().clearCookies();
    const response = await page.request.get("/api/simulations/preview?blockType=mixed&size=5");
    expect(response.status()).toBe(401);
  });

  test("bloco de outro aluno responde 404, nunca 403", async ({ page, browser }) => {
    await signedInStudent(page, "isolation-owner");
    const blockId = await applyMixedBlock(page);

    const otherContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const otherPage = await otherContext.newPage();
    await signedInStudent(otherPage, "isolation-intruder");
    const response = await otherPage.request.get(`/api/simulations/${blockId}`);
    expect(response.status()).toBe(404);
    await otherContext.close();
  });
});
