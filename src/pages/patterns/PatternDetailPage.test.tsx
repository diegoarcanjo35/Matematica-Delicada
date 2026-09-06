import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PatternDetailPage } from "./PatternDetailPage";

/* Sprint 17.1, item 3 da ordem de auditoria — um padrão criado pelo novo
   modelo simplificado (Sprint 17) pode chegar ao aluno com só `name` +
   `mainStrategy` preenchidos; todos os campos legados (recognitionPhrase,
   description, introductoryExample, strategicSummary) e listas de
   atributos ficam vazios. A ficha nunca pode mostrar título/seção vazia
   nem o código técnico (UUID) como se fosse conteúdo pedagógico. Mock de
   `fetch` global — mesma convenção de src/App.test.tsx. */

const NEW_STYLE_PATTERN = {
  code: "c0e28588-2dc0-4311-89ea-d12cdc9494c7",
  slug: "sequencias",
  name: "Sequências",
  recognitionPhrase: "",
  requiredContents: [] as string[],
  tags: [] as string[],
  isLocalFixture: false,
  progress: {
    hasProgress: false,
    lastPracticedAt: null,
    nextReviewAt: null,
    indices: {
      recognition: { available: false, value: null },
      resolution: { available: false, value: null },
      mastery: { available: false, value: null },
    },
  },
  description: "",
  mainStrategy: "Identifique o padrão de recorrência entre os termos.",
  introductoryExample: "",
  strategicSummary: "",
  frequentClues: [] as string[],
  recurringPhrases: [] as string[],
  recurringVisualElements: [] as string[],
  alternativeStrategies: [] as string[],
  prerequisiteContents: [] as string[],
  commonMistakes: [] as string[],
  relations: [] as never[],
  availableQuestionCount: 0,
  trainableQuestionId: null,
};

function mockApi() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ ok: true, available: true, pattern: NEW_STYLE_PATTERN }), { status: 200 }))
  );
}

function renderAt(slug: string) {
  return render(
    <MemoryRouter initialEntries={[`/padroes-enem/${slug}`]}>
      <Routes>
        <Route path="/padroes-enem/:slug" element={<PatternDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("PatternDetailPage — padrão novo (só name + mainStrategy)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mostra Nome e Macete/Como resolver", async () => {
    mockApi();
    renderAt("sequencias");
    expect(await screen.findByRole("heading", { name: "Sequências", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Macete / Como resolver" })).toBeInTheDocument();
    expect(screen.getByText("Identifique o padrão de recorrência entre os termos.")).toBeInTheDocument();
  });

  it("NÃO renderiza seções/títulos de campos legados vazios", async () => {
    mockApi();
    renderAt("sequencias");
    await screen.findByRole("heading", { name: "Sequências", level: 1 });
    expect(screen.queryByRole("heading", { name: "Descrição" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Exemplo introdutório" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Resumo estratégico" })).not.toBeInTheDocument();
  });

  it("NÃO renderiza listas de atributos vazias", async () => {
    mockApi();
    renderAt("sequencias");
    await screen.findByRole("heading", { name: "Sequências", level: 1 });
    for (const title of ["Pistas frequentes", "Palavras e expressões recorrentes", "Elementos visuais recorrentes", "Estratégias alternativas", "Conteúdos necessários", "Pré-requisitos", "Erros e pegadinhas frequentes", "Tags"]) {
      expect(screen.queryByRole("heading", { name: title })).not.toBeInTheDocument();
    }
  });

  it("NÃO exibe o código técnico (UUID) como informação pedagógica", async () => {
    mockApi();
    renderAt("sequencias");
    await screen.findByRole("heading", { name: "Sequências", level: 1 });
    expect(screen.queryByText(NEW_STYLE_PATTERN.code)).not.toBeInTheDocument();
  });

  it("recognitionPhrase vazia não gera parágrafo vazio no cabeçalho", async () => {
    mockApi();
    const { container } = renderAt("sequencias");
    await screen.findByRole("heading", { name: "Sequências", level: 1 });
    expect(container.querySelector(".patterns__card-phrase")).not.toBeInTheDocument();
  });
});
