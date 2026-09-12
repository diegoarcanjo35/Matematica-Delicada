import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorialImportsPage } from "./EditorialImportsPage";
import { EditorialRoleContext } from "../../auth/editorialRoleContext";

/* Sprint 22 — aba "PDF oficial ENEM" (itens 63-79 da ordem, seção 40):
   exige os 2 PDFs + confirmação, mostra resumo/cards/avisos/gabarito para
   revisão editorial, seleção de padrão pelo NOME (nunca código), botão
   final diz "Criar N rascunhos" e a tela NUNCA contém a palavra
   "Publicar". Mesma convenção de mock de fetch global de
   EditorialImportsPage.test.tsx (Sprint 19). */

const PATTERNS_RESPONSE = {
  ok: true,
  patterns: [
    { id: "pat-published-1", name: "Razão e Proporcionalidade", editorialStatus: "published" },
    { id: "pat-draft-1", name: "Padrão Rascunho", editorialStatus: "draft" },
  ],
};

function buildPreviewResponse(overrides: Partial<{ questions: unknown[]; globalWarnings: string[] }> = {}) {
  return {
    ok: true,
    batchId: "batch-pdf-1",
    examIdentity: { exam: "ENEM", year: 2019, application: "Aplicação regular", booklet: "Caderno Azul", languageVariant: null, sourceLabel: null },
    pageCount: 1,
    detectedQuestionCount: 2,
    matchedAnswerCount: 1,
    questions: overrides.questions ?? [
      {
        tempId: "1",
        originalNumber: 1,
        pageStart: 1,
        pageEnd: 1,
        statement: "Enunciado tecnico da questao 1.",
        alternatives: [
          { letter: "A", text: "Alternativa A" },
          { letter: "B", text: "Alternativa B" },
          { letter: "C", text: "Alternativa C" },
          { letter: "D", text: "Alternativa D" },
          { letter: "E", text: "Alternativa E" },
        ],
        correctAlternative: "C",
        warnings: [],
        status: "ready",
        duplicateStatus: "none",
        visualReviewRequired: false,
        patternPrincipalId: null,
        canApply: true,
        code: "ENEM-2019-APLICACAO-REGULA-001",
        fingerprint: "fp-1",
      },
      {
        tempId: "2",
        originalNumber: 2,
        pageStart: 1,
        pageEnd: 1,
        statement: "Enunciado tecnico da questao 2.",
        alternatives: [
          { letter: "A", text: "Alternativa A" },
          { letter: "B", text: "Alternativa B" },
          { letter: "C", text: "Alternativa C" },
          { letter: "D", text: "Alternativa D" },
          { letter: "E", text: "Alternativa E" },
        ],
        correctAlternative: null,
        warnings: ["Gabarito ausente para esta questão."],
        status: "needs_review",
        duplicateStatus: "none",
        visualReviewRequired: false,
        patternPrincipalId: null,
        canApply: false,
        code: "ENEM-2019-APLICACAO-REGULA-002",
        fingerprint: "fp-2",
      },
    ],
    globalWarnings: overrides.globalWarnings ?? [],
    canApply: true,
    expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
  };
}

function mockApi(previewBody: unknown = buildPreviewResponse()) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/api/editorial/patterns")) return new Response(JSON.stringify(PATTERNS_RESPONSE), { status: 200 });
      if (url.includes("/question-imports/pdf/preview")) return new Response(JSON.stringify(previewBody), { status: 200 });
      if (url.includes("/question-imports/pdf/apply")) {
        return new Response(JSON.stringify({ ok: true, appliedCount: 1, alreadyApplied: false, questionIds: ["q-1"] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    })
  );
  return calls;
}

function renderPage(role: "editor" | "admin" = "editor") {
  return render(
    <EditorialRoleContext.Provider value={role}>
      <EditorialImportsPage />
    </EditorialRoleContext.Provider>
  );
}

function buildPdfFile(name: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "application/pdf" });
}

async function fillIdentityAndConfirm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Ano"), "2019");
  await user.type(screen.getByLabelText("Aplicação"), "Aplicação regular");
  await user.type(screen.getByLabelText("Caderno/cor"), "Caderno Azul");
  await user.click(screen.getByLabelText(/Confirmo que estes arquivos/));
}

async function selectPdfMode(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("radio", { name: "PDF oficial ENEM" }));
}

describe("EditorialImportsPage — aba PDF oficial ENEM (Sprint 22)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("item 63 — aba 'PDF oficial ENEM' aparece no seletor de modo", async () => {
    mockApi();
    renderPage();
    expect(screen.getByRole("radio", { name: "PDF oficial ENEM" })).toBeInTheDocument();
  });

  it("item 64 — exige os dois PDFs: botão 'Gerar prévia' fica desabilitado até examPdf + answerKeyPdf + identidade + confirmação", async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await selectPdfMode(user);

    const generateButton = screen.getByRole("button", { name: "Gerar prévia" });
    expect(generateButton).toBeDisabled();

    await user.upload(screen.getByLabelText("PDF da prova"), buildPdfFile("prova.pdf"));
    expect(generateButton).toBeDisabled(); // ainda falta o gabarito + identidade + confirmação

    await user.upload(screen.getByLabelText("PDF do gabarito oficial"), buildPdfFile("gabarito.pdf"));
    await fillIdentityAndConfirm(user);
    expect(generateButton).toBeEnabled();
  });

  it("item 65 — exige confirmação explícita (checkbox desmarcado mantém o botão desabilitado)", async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await selectPdfMode(user);
    await user.upload(screen.getByLabelText("PDF da prova"), buildPdfFile("prova.pdf"));
    await user.upload(screen.getByLabelText("PDF do gabarito oficial"), buildPdfFile("gabarito.pdf"));
    await user.type(screen.getByLabelText("Ano"), "2019");
    await user.type(screen.getByLabelText("Aplicação"), "Aplicação regular");
    await user.type(screen.getByLabelText("Caderno/cor"), "Caderno Azul");

    expect(screen.getByRole("button", { name: "Gerar prévia" })).toBeDisabled();
  });

  it("item 66/68 — gera a prévia e mostra o resumo (detectadas/prontas/precisam revisão)", async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await selectPdfMode(user);
    await user.upload(screen.getByLabelText("PDF da prova"), buildPdfFile("prova.pdf"));
    await user.upload(screen.getByLabelText("PDF do gabarito oficial"), buildPdfFile("gabarito.pdf"));
    await fillIdentityAndConfirm(user);
    await user.click(screen.getByRole("button", { name: "Gerar prévia" }));

    const preview = await screen.findByTestId("pdf-preview");
    expect(within(preview).getByText(/2 questões detectadas/)).toBeInTheDocument();
    expect(within(preview).getByText(/1 prontas/)).toBeInTheDocument();
    expect(within(preview).getByText(/1 precisam revisão/)).toBeInTheDocument();
  });

  it("item 69/70 — cada questão aparece com enunciado, alternativas e o gabarito oficial marcado", async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await selectPdfMode(user);
    await user.upload(screen.getByLabelText("PDF da prova"), buildPdfFile("prova.pdf"));
    await user.upload(screen.getByLabelText("PDF do gabarito oficial"), buildPdfFile("gabarito.pdf"));
    await fillIdentityAndConfirm(user);
    await user.click(screen.getByRole("button", { name: "Gerar prévia" }));

    const list = await screen.findByTestId("pdf-question-list");
    expect(within(list).getByText("Questão 1")).toBeInTheDocument();
    expect(within(list).getByText(/Alternativa C \(gabarito oficial\)/)).toBeInTheDocument();
  });

  it("item 71 — avisos (warnings) da questão sem gabarito ficam visíveis para o editor", async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await selectPdfMode(user);
    await user.upload(screen.getByLabelText("PDF da prova"), buildPdfFile("prova.pdf"));
    await user.upload(screen.getByLabelText("PDF do gabarito oficial"), buildPdfFile("gabarito.pdf"));
    await fillIdentityAndConfirm(user);
    await user.click(screen.getByRole("button", { name: "Gerar prévia" }));

    await screen.findByTestId("pdf-preview");
    expect(screen.getByText("Gabarito ausente para esta questão.")).toBeInTheDocument();
    expect(screen.getByText("Gabarito ausente")).toBeInTheDocument(); // badge textual, seção 31 (nunca só cor)
  });

  it("item 72 — seleção de padrão principal mostra o NOME do padrão, nunca o código técnico, e só lista padrões published", async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await selectPdfMode(user);
    await user.upload(screen.getByLabelText("PDF da prova"), buildPdfFile("prova.pdf"));
    await user.upload(screen.getByLabelText("PDF do gabarito oficial"), buildPdfFile("gabarito.pdf"));
    await fillIdentityAndConfirm(user);
    await user.click(screen.getByRole("button", { name: "Gerar prévia" }));

    await screen.findByTestId("pdf-preview");
    const select = screen.getByLabelText("Padrão principal", { selector: "#pdf-pattern-1" }) as HTMLSelectElement;
    expect(within(select).getByText("Razão e Proporcionalidade")).toBeInTheDocument();
    expect(within(select).queryByText("Padrão Rascunho")).not.toBeInTheDocument(); // draft nunca aparece
    expect(select.innerHTML).not.toContain("PAD-"); // nunca o código técnico
  });

  it("item 73/74 — desmarcar 'Selecionar para aplicar' de uma questão atualiza a contagem final", async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await selectPdfMode(user);
    await user.upload(screen.getByLabelText("PDF da prova"), buildPdfFile("prova.pdf"));
    await user.upload(screen.getByLabelText("PDF do gabarito oficial"), buildPdfFile("gabarito.pdf"));
    await fillIdentityAndConfirm(user);
    await user.click(screen.getByRole("button", { name: "Gerar prévia" }));

    await screen.findByTestId("pdf-preview");
    expect(screen.getByText("Serão criadas 1 questões em rascunho.")).toBeInTheDocument();

    const checkbox = screen.getAllByLabelText("Selecionar para aplicar")[0];
    await user.click(checkbox); // desmarca a única questão pronta (question 2 já vem desmarcada, sem canApply)
    expect(screen.getByText("Serão criadas 0 questões em rascunho.")).toBeInTheDocument();
  });

  it("item 75/76 — botão final diz 'Criar N rascunhos' e a tela NUNCA contém a palavra 'Publicar'", async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await selectPdfMode(user);
    await user.upload(screen.getByLabelText("PDF da prova"), buildPdfFile("prova.pdf"));
    await user.upload(screen.getByLabelText("PDF do gabarito oficial"), buildPdfFile("gabarito.pdf"));
    await fillIdentityAndConfirm(user);
    await user.click(screen.getByRole("button", { name: "Gerar prévia" }));

    await screen.findByTestId("pdf-preview");
    expect(screen.getByRole("button", { name: "Criar 1 rascunhos" })).toBeInTheDocument();
    expect(screen.queryByText(/Publicar/i)).not.toBeInTheDocument();
  });

  it("item 32/75 — apply exige escolher o padrão E marcar a confirmação final antes de habilitar o botão", async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await selectPdfMode(user);
    await user.upload(screen.getByLabelText("PDF da prova"), buildPdfFile("prova.pdf"));
    await user.upload(screen.getByLabelText("PDF do gabarito oficial"), buildPdfFile("gabarito.pdf"));
    await fillIdentityAndConfirm(user);
    await user.click(screen.getByRole("button", { name: "Gerar prévia" }));

    await screen.findByTestId("pdf-preview");
    const applyButton = screen.getByRole("button", { name: "Criar 1 rascunhos" });
    expect(applyButton).toBeDisabled(); // sem padrão escolhido, sem confirmação final

    const select = screen.getByLabelText("Padrão principal", { selector: "#pdf-pattern-1" });
    await user.selectOptions(select, "pat-published-1");
    expect(applyButton).toBeDisabled(); // falta a confirmação final

    await user.click(screen.getByLabelText("Revisei os gabaritos e os dados desta importação."));
    expect(applyButton).toBeEnabled();

    await user.click(applyButton);
    const result = await screen.findByTestId("pdf-applied-result");
    expect(within(result).getByText("1 questão(ões) criada(s) como rascunho.")).toBeInTheDocument();
  });

  it("item 79 — PDF corrompido/inválido (extensão correta, conteúdo inválido) não trava a UI: erro amigável aparece", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/editorial/patterns")) return new Response(JSON.stringify(PATTERNS_RESPONSE), { status: 200 });
        if (url.includes("/question-imports/pdf/preview")) {
          return new Response(JSON.stringify({ error: { code: "pdf_invalid_exam", message: "PDF inválido ou corrompido." } }), { status: 400 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );
    const user = userEvent.setup();
    renderPage();
    await selectPdfMode(user);
    // Um arquivo com nome/MIME de PDF mas conteúdo inválido — o filtro
    // "accept" do input já barra extensões erradas no navegador real (e no
    // próprio userEvent, confirmado ao investigar esta suíte); o cenário
    // real que o backend precisa rejeitar é justamente este: parece PDF,
    // mas pdf.js não consegue abri-lo.
    await user.upload(screen.getByLabelText("PDF da prova"), new File(["nao e um pdf valido"], "prova-corrompida.pdf", { type: "application/pdf" }));
    await user.upload(screen.getByLabelText("PDF do gabarito oficial"), buildPdfFile("gabarito.pdf"));
    await fillIdentityAndConfirm(user);
    await user.click(screen.getByRole("button", { name: "Gerar prévia" }));

    await waitFor(() => expect(screen.getByText("PDF inválido ou corrompido.")).toBeInTheDocument());
    // A UI continua responsiva — o seletor de modo ainda funciona.
    await user.click(screen.getByRole("radio", { name: "CSV" }));
    expect(screen.getByLabelText("Arquivo CSV")).toBeInTheDocument();
  });
});
