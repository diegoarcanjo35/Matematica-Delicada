import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { TrainablePatternGrid } from "./TrainablePatternGrid";
import type { TrainablePattern } from "../../api/dailyTrainingClient";

/* Sprint 20 (itens 44/45 da política de testes frontend) — a grade vem
   100% dos dados recebidos via props (nunca hardcoded); um padrão com
   `canTrain: false` fica visível, mas desabilitado, com mensagem amigável
   — nunca escondido. */

function pattern(overrides: Partial<TrainablePattern> = {}): TrainablePattern {
  return {
    id: "p1",
    slug: "escala",
    name: "Escala",
    mainStrategy: "Macete de escala.",
    availableQuestionCount: 3,
    canTrain: true,
    ...overrides,
  };
}

function renderGrid(patterns: TrainablePattern[]) {
  return render(
    <MemoryRouter>
      <TrainablePatternGrid patterns={patterns} />
    </MemoryRouter>
  );
}

describe("TrainablePatternGrid", () => {
  it("renderiza os padrões recebidos via props, nunca uma lista fixa", () => {
    renderGrid([pattern({ id: "p1", name: "Escala" }), pattern({ id: "p2", name: "Porcentagem" })]);
    expect(screen.getByText("Escala")).toBeInTheDocument();
    expect(screen.getByText("Porcentagem")).toBeInTheDocument();
  });

  it("padrão treinável é um link para /treino-diario?patternId=<id>", () => {
    renderGrid([pattern({ id: "pattern-abc", name: "Escala", canTrain: true })]);
    const link = screen.getByRole("link", { name: /Escala/ });
    expect(link).toHaveAttribute("href", "/treino-diario?patternId=pattern-abc");
  });

  it("padrão com canTrain=false fica visível, mas desabilitado, com mensagem amigável", () => {
    renderGrid([pattern({ id: "p1", name: "Geometria Espacial", canTrain: false, availableQuestionCount: 0 })]);
    expect(screen.getByText("Geometria Espacial")).toBeInTheDocument();
    expect(screen.getByText("Questões em preparação")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Geometria Espacial/ })).not.toBeInTheDocument();
  });

  it("nunca mostra UUID/código técnico visível ao aluno", () => {
    renderGrid([pattern({ id: "11111111-2222-3333-4444-555555555555", slug: "escala-e-proporcao", name: "Escala e Proporção" })]);
    expect(screen.queryByText("11111111-2222-3333-4444-555555555555")).not.toBeInTheDocument();
    expect(screen.queryByText("escala-e-proporcao")).not.toBeInTheDocument();
  });

  it("lista vazia mostra mensagem honesta, nunca quebra", () => {
    renderGrid([]);
    expect(screen.getByText(/Nenhum padrão publicado ainda/)).toBeInTheDocument();
  });
});
