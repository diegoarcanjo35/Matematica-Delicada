import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PerformancePage } from "./PerformancePage";
import type { PatternPerformanceOverviewItem } from "../../api/studentMetricsClient";

/* Sprint 21 — /desempenho. Toda evidência renderizada vem literalmente do
   corpo mockado da API (GET /api/student-metrics/patterns/overview) —
   nenhum número/rótulo é recalculado nesta página além de formatação de
   data/percentual. */

function buildItem(overrides: Partial<PatternPerformanceOverviewItem> = {}): PatternPerformanceOverviewItem {
  return {
    pattern: { id: "p1", slug: "escala", name: "Escala", mainStrategy: "Macete." },
    evidence: {
      confirmedAttempts: 3,
      correctCount: 2,
      incorrectCount: 1,
      distinctQuestionsUsed: 3,
      distinctPracticeDays: 2,
      attemptsWithHelp: 0,
      reviewsCorrect: 0,
      reviewsIncorrect: 0,
      lastPracticeAt: "2026-09-01T10:00:00.000Z",
    },
    accuracy: 0.667,
    state: { code: "em_desenvolvimento", label: "Em desenvolvimento" },
    attention: { needed: false, reason: null },
    training: { canTrain: true, availableQuestionCount: 1 },
    ...overrides,
  };
}

function mockApi(patterns: PatternPerformanceOverviewItem[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ ok: true, patterns }), { status: 200 }))
  );
}

function renderPage() {
  return render(
    <MemoryRouter>
      <PerformancePage />
    </MemoryRouter>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PerformancePage — /desempenho (Sprint 21)", () => {
  it("item 26 — todos os padrões devolvidos pela API aparecem", async () => {
    mockApi([
      buildItem({ pattern: { id: "p1", slug: "escala", name: "Escala", mainStrategy: "" } }),
      buildItem({ pattern: { id: "p2", slug: "geometria", name: "Geometria Espacial", mainStrategy: "" } }),
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Escala")).toBeInTheDocument());
    expect(screen.getByText("Geometria Espacial")).toBeInTheDocument();
  });

  it("item 27 — accuracy real renderiza como percentual", async () => {
    mockApi([buildItem({ accuracy: 0.667 })]);
    renderPage();
    await waitFor(() => expect(screen.getByText("67% de acerto")).toBeInTheDocument());
  });

  it("item 28 — accuracy null mostra 'Sem respostas confirmadas ainda', nunca '0%'", async () => {
    mockApi([buildItem({ accuracy: null, evidence: { ...buildItem().evidence, confirmedAttempts: 0, correctCount: 0, incorrectCount: 0 } })]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Sem respostas confirmadas ainda")).toBeInTheDocument());
    expect(screen.queryByText(/0%/)).not.toBeInTheDocument();
  });

  it("item 29 — revisao_pendente mostra o CTA 'Revisar agora' apontando para /caderno-de-erros", async () => {
    mockApi([buildItem({ state: { code: "revisao_pendente", label: "Revisão pendente" }, attention: { needed: true, reason: "Há uma revisão pendente." } })]);
    renderPage();
    const link = await screen.findByRole("link", { name: "Revisar agora" });
    expect(link).toHaveAttribute("href", "/caderno-de-erros");
    // Nunca manda automaticamente para o Treino Diário quando há revisão pendente.
    expect(screen.queryByRole("link", { name: "Treinar este padrão" })).not.toBeInTheDocument();
  });

  it("item 30 — attention real mostra o motivo (reason) devolvido pela API", async () => {
    mockApi([
      buildItem({
        state: { code: "em_desenvolvimento", label: "Em desenvolvimento" },
        attention: { needed: true, reason: "Mais respostas incorretas do que corretas neste padrão até agora." },
      }),
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText(/Mais respostas incorretas do que corretas/)).toBeInTheDocument());
    expect(screen.getByText("Precisa de atenção.")).toBeInTheDocument();
  });

  it("item 31 — padrão sem evidência não mostra nenhum alerta de atenção (nunca 'fraco'/'baixo desempenho')", async () => {
    mockApi([buildItem({ state: { code: "sem_evidencias", label: "Ainda sem evidências suficientes" }, accuracy: null, attention: { needed: false, reason: null } })]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Ainda sem evidências suficientes")).toBeInTheDocument());
    expect(screen.queryByText("Precisa de atenção.")).not.toBeInTheDocument();
    expect(screen.getByText("Ainda há pouca evidência para avaliar este padrão.")).toBeInTheDocument();
    expect(screen.queryByText(/fraco/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/baixo desempenho/i)).not.toBeInTheDocument();
  });

  it("item 32 — consistente_no_recorte mostra 'Consistente neste recorte'", async () => {
    mockApi([buildItem({ state: { code: "consistente_no_recorte", label: "Consistente neste recorte" } })]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Consistente neste recorte")).toBeInTheDocument());
  });

  it("item 33 — CTA 'Treinar este padrão' usa o patternId correto", async () => {
    mockApi([buildItem({ pattern: { id: "pattern-xyz", slug: "escala", name: "Escala", mainStrategy: "" } })]);
    renderPage();
    const link = await screen.findByRole("link", { name: "Treinar este padrão" });
    expect(link).toHaveAttribute("href", "/treino-diario?patternId=pattern-xyz");
  });

  it("item 34 — padrão sem questão treinável mostra CTA desabilitado 'Questões em preparação'", async () => {
    mockApi([buildItem({ training: { canTrain: false, availableQuestionCount: 0 } })]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Questões em preparação")).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: "Treinar este padrão" })).not.toBeInTheDocument();
  });

  it("item 36 — filtros e CTAs são elementos nativos focáveis por teclado (button/a reais, nunca div com onClick)", async () => {
    mockApi([buildItem()]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Escala")).toBeInTheDocument());
    const filterGroup = screen.getByRole("group", { name: "Filtrar por estado" });
    expect(filterGroup.querySelectorAll("button").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Treinar este padrão" }).tagName).toBe("A");
  });

  it("filtro 'Precisa de atenção' esconde padrões sem atenção", async () => {
    mockApi([
      buildItem({ pattern: { id: "p1", slug: "a", name: "Padrão Atenção", mainStrategy: "" }, attention: { needed: true, reason: "x" } }),
      buildItem({ pattern: { id: "p2", slug: "b", name: "Padrão Tranquilo", mainStrategy: "" }, attention: { needed: false, reason: null } }),
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Padrão Atenção")).toBeInTheDocument());
    expect(screen.getByText("Padrão Tranquilo")).toBeInTheDocument();

    screen.getByRole("button", { name: "Precisa de atenção" }).click();
    await waitFor(() => expect(screen.queryByText("Padrão Tranquilo")).not.toBeInTheDocument());
    expect(screen.getByText("Padrão Atenção")).toBeInTheDocument();
  });
});
