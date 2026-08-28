import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { App } from "./App";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>
  );
}

describe("App routing", () => {
  it("renders the dashboard at the root route", () => {
    renderAt("/");
    expect(screen.getByText("Boa tarde, Ana Cláudia! ♡")).toBeInTheDocument();
  });

  it("renders a placeholder page for a structural route", () => {
    renderAt("/treino-diario");
    expect(screen.getByRole("heading", { name: "Treino Diário" })).toBeInTheDocument();
    expect(screen.getByText("Módulo em construção")).toBeInTheDocument();
  });

  it("renders the not-found page for an unknown route", () => {
    renderAt("/rota-que-nao-existe");
    expect(screen.getByRole("heading", { name: "Página não encontrada" })).toBeInTheDocument();
  });

  it("renders the sidebar navigation with all ten student menu items", () => {
    renderAt("/");
    const nav = screen.getByRole("navigation", { name: "Navegação principal" });
    expect(nav).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /Início/ }).length).toBeGreaterThan(0);
  });
});
