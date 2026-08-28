import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const MOCK_USER = { id: "u1", name: "Ana Cláudia Teste", email: "ana@teste.com", emailConfirmed: true };

function mockSession(authenticated: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/auth/session")) {
        return authenticated
          ? new Response(JSON.stringify({ ok: true, user: MOCK_USER }), { status: 200 })
          : new Response(JSON.stringify({ error: { code: "unauthorized", message: "" } }), {
              status: 401,
            });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    })
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>
  );
}

describe("App routing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("visitante não autenticado", () => {
    beforeEach(() => mockSession(false));

    it("redireciona para /entrar ao acessar a área do aluno", async () => {
      renderAt("/");
      expect(await screen.findByRole("heading", { name: "Entrar" })).toBeInTheDocument();
    });

    it("permite acessar a tela de login diretamente", async () => {
      renderAt("/entrar");
      expect(await screen.findByRole("heading", { name: "Entrar" })).toBeInTheDocument();
    });

    it("renderiza a página 404 para rota desconhecida, mesmo sem sessão", () => {
      renderAt("/rota-que-nao-existe");
      expect(screen.getByRole("heading", { name: "Página não encontrada" })).toBeInTheDocument();
    });
  });

  describe("aluno autenticado", () => {
    beforeEach(() => mockSession(true));

    it("renderiza o dashboard com o nome do usuário logado", async () => {
      renderAt("/");
      expect(await screen.findByText(/Ana/)).toBeInTheDocument();
      expect(screen.getByText("Seu Mapa ENEM")).toBeInTheDocument();
    });

    it("renderiza uma página placeholder para uma rota estrutural", async () => {
      renderAt("/treino-diario");
      expect(await screen.findByRole("heading", { name: "Treino Diário" })).toBeInTheDocument();
      expect(screen.getByText("Módulo em construção")).toBeInTheDocument();
    });

    it("renderiza a navegação lateral com todos os itens do menu do aluno", async () => {
      renderAt("/");
      const nav = await screen.findByRole("navigation", { name: "Navegação principal" });
      expect(nav).toBeInTheDocument();
      expect(screen.getAllByRole("link", { name: /Início/ }).length).toBeGreaterThan(0);
    });
  });
});
