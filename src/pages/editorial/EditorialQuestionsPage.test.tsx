import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorialQuestionsPage } from "./EditorialQuestionsPage";

/* Sprint 17, seção D da ordem — cobre exatamente os itens da ordem que só
   são observáveis no componente (não no backend): chips gerados
   DINAMICAMENTE a partir de /api/editorial/patterns (nunca hardcoded no
   componente), o padrão selecionado persistido/lido da URL, e a
   paginação resetada ao trocar de padrão. Mock de `fetch` global — mesma
   convenção de src/App.test.tsx. */

const DYNAMIC_PATTERN_NAME = "Zzz Padrão Dinâmico De Teste";

function mockApi() {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);
      if (url.includes("/api/editorial/patterns")) {
        return new Response(
          JSON.stringify({
            ok: true,
            patterns: [
              { id: "pat-dyn-1", name: DYNAMIC_PATTERN_NAME, editorialStatus: "draft" },
              { id: "pat-dyn-2", name: "Outro Padrão", editorialStatus: "published" },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes("/api/editorial/questions")) {
        return new Response(JSON.stringify({ ok: true, questions: [], page: 1, pageSize: 10, total: 0, totalPages: 0 }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    })
  );
  return calls;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <EditorialQuestionsPage />
    </MemoryRouter>
  );
}

describe("EditorialQuestionsPage — chips de padrão principal (Sprint 17)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renderiza os chips a partir do catálogo real (GET /api/editorial/patterns) — nada hardcoded", async () => {
    mockApi();
    renderAt("/editorial/questoes");
    expect(await screen.findByRole("button", { name: DYNAMIC_PATTERN_NAME })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Outro Padrão" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Todas" })).toBeInTheDocument();
  });

  it("sem padraoPrincipalId na URL: 'Todas' começa selecionada", async () => {
    mockApi();
    renderAt("/editorial/questoes");
    await screen.findByRole("button", { name: DYNAMIC_PATTERN_NAME });
    expect(screen.getByRole("button", { name: "Todas" })).toHaveClass("editorial__pattern-tab--active");
  });

  it("padraoPrincipalId já na URL: o chip correspondente nasce selecionado (estado lido da URL)", async () => {
    mockApi();
    renderAt("/editorial/questoes?padraoPrincipalId=pat-dyn-2");
    const chip = await screen.findByRole("button", { name: "Outro Padrão" });
    expect(chip).toHaveClass("editorial__pattern-tab--active");
    expect(screen.getByRole("button", { name: "Todas" })).not.toHaveClass("editorial__pattern-tab--active");
  });

  it("clicar num chip envia padraoPrincipalId à API e reseta a página (pagina some da requisição)", async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderAt("/editorial/questoes?pagina=3");
    const chip = await screen.findByRole("button", { name: DYNAMIC_PATTERN_NAME });

    await user.click(chip);

    await waitFor(() => {
      const last = calls.filter((u) => u.includes("/api/editorial/questions")).at(-1)!;
      expect(last).toContain("padraoPrincipalId=pat-dyn-1");
      expect(last).not.toContain("pagina=3");
    });
  });

  it("voltar para 'Todas' remove padraoPrincipalId da requisição", async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderAt("/editorial/questoes?padraoPrincipalId=pat-dyn-2");
    await screen.findByRole("button", { name: "Outro Padrão" });

    await user.click(screen.getByRole("button", { name: "Todas" }));

    await waitFor(() => {
      const last = calls.filter((u) => u.includes("/api/editorial/questions")).at(-1)!;
      expect(last).not.toContain("padraoPrincipalId");
    });
  });
});
