import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorialQuestionFormPage } from "./EditorialQuestionFormPage";
import { EditorialRoleContext } from "../../auth/editorialRoleContext";

/* Sprint 18, seção 19 da ordem — itens 1/3/4/5/6/7/8/9 da política de
   testes (o que é observável só no componente, não no backend): código
   editorial nunca aparece; padrão escolhido por NOME num <select> dinâmico
   (nunca um campo de ID digitado); DNA visível só tem "Macete / Como
   resolver"; editar Macete/padrão principal/edição comum nunca inclui
   `imagens` no payload de PATCH e só inclui `dna`/`padroes`/`tags` quando
   o valor realmente muda (prova de preservação por omissão). Mock de
   `fetch` global — mesma convenção de src/App.test.tsx. */

const DYNAMIC_PATTERN = { id: "pat-dyn-1", name: "Zzz Padrão Dinâmico De Teste", editorialStatus: "published" };

const LOADED_QUESTION = {
  id: "q-1",
  code: "Q-existing-code-123",
  enunciado: "Enunciado carregado.",
  dificuldade: "media",
  origem: "autoral",
  editorialStatus: "draft",
  autorId: "autor1",
  revisorId: null,
  ano: 2023,
  hasImage: false,
  version: 3,
  isLocalFixture: false,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  resolucaoComentada: "Resolução carregada.",
  conteudo: "Conteúdo legado",
  subconteudo: "Sub legado",
  habilidade: "Habilidade legada",
  competencia: "Competência legada",
  prova: "ENEM",
  tempoEstimadoSegundos: null,
  tipoCalculo: "misto",
  necessitaCalculadora: false,
  titularDireitos: "Titular legado",
  baseLicenca: "Licença legada",
  textoAtribuicao: null,
  fingerprint: "fp-1",
  alternativas: [
    { letter: "A", text: "Alt A", isCorrect: false, distractorExplanation: "Explicação legada A" },
    { letter: "B", text: "Alt B", isCorrect: true, distractorExplanation: null },
    { letter: "C", text: "Alt C", isCorrect: false, distractorExplanation: null },
    { letter: "D", text: "Alt D", isCorrect: false, distractorExplanation: null },
    { letter: "E", text: "Alt E", isCorrect: false, distractorExplanation: null },
  ],
  imagens: [],
  padroes: [
    { patternId: "pat-dyn-1", role: "principal" },
    { patternId: "pat-secundario-oculto", role: "secundario" },
  ],
  tags: ["tag-legada-1", "tag-legada-2"],
  dna: {
    pista: "Pista legada",
    estrategia: "Macete carregado",
    pegadinha: "Pegadinha legada",
    conteudoApoio: "Conteúdo de apoio legado",
    resolucao: "Resolução DNA legada",
    atalho: null,
    aprendizadoErro: "Aprendizado legado",
  },
};

function mockApi(options: { withLoadedQuestion?: boolean } = {}) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      let body: unknown = null;
      if (init?.body && typeof init.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      calls.push({ url, method, body });

      if (url.includes("/api/editorial/patterns")) {
        return new Response(JSON.stringify({ ok: true, patterns: [DYNAMIC_PATTERN] }), { status: 200 });
      }
      if (options.withLoadedQuestion && url.includes("/api/editorial/questions/q-1") && method === "GET") {
        return new Response(JSON.stringify({ ok: true, question: LOADED_QUESTION }), { status: 200 });
      }
      if (method === "PATCH") {
        return new Response(JSON.stringify({ ok: true, id: "q-1", changed: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    })
  );
  return calls;
}

function renderNew() {
  return render(
    <MemoryRouter initialEntries={["/editorial/questoes/nova"]}>
      <EditorialRoleContext.Provider value="editor">
        <Routes>
          <Route path="/editorial/questoes/nova" element={<EditorialQuestionFormPage />} />
        </Routes>
      </EditorialRoleContext.Provider>
    </MemoryRouter>
  );
}

function renderEdit() {
  return render(
    <MemoryRouter initialEntries={["/editorial/questoes/q-1"]}>
      <EditorialRoleContext.Provider value="editor">
        <Routes>
          <Route path="/editorial/questoes/:id" element={<EditorialQuestionFormPage />} />
        </Routes>
      </EditorialRoleContext.Provider>
    </MemoryRouter>
  );
}

describe("EditorialQuestionFormPage — editor simplificado (Sprint 18)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("item 1 — código editorial NUNCA aparece como campo editável", async () => {
    mockApi();
    renderNew();
    await screen.findByLabelText("Enunciado");
    expect(screen.queryByLabelText(/código editorial/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /^código$/i })).not.toBeInTheDocument();
  });

  it("correção 18.1, seção A — o código técnico NÃO aparece em nenhum ponto da tela simplificada, nem no título", async () => {
    const calls = mockApi({ withLoadedQuestion: true });
    renderEdit();
    await screen.findByLabelText("Macete / Como resolver");
    expect(screen.getByRole("heading", { name: "Editar questão" })).toBeInTheDocument();
    expect(screen.queryByText(LOADED_QUESTION.code)).not.toBeInTheDocument();
    expect(screen.queryByText(new RegExp(LOADED_QUESTION.code))).not.toBeInTheDocument();
    // O código nunca é buscado pela tela — nenhuma chamada de rede o
    // referencia (nem no corpo, nem na URL, mesmo em GET/PATCH).
    expect(calls.every((c) => !c.url.includes(LOADED_QUESTION.code))).toBe(true);
  });

  it("item 2 — Prova e Ano aparecem na visão principal", async () => {
    mockApi();
    renderNew();
    expect(await screen.findByLabelText("Prova")).toBeInTheDocument();
    expect(screen.getByLabelText("Ano")).toBeInTheDocument();
  });

  it("item 3/4 — padrão principal é um <select> com o NOME vindo do catálogo dinâmico, nunca um campo de ID", async () => {
    mockApi();
    renderNew();
    const select = (await screen.findByLabelText("Padrão")) as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect(screen.getByRole("option", { name: DYNAMIC_PATTERN.name })).toBeInTheDocument();
    expect(screen.queryByLabelText(/id do padrão/i)).not.toBeInTheDocument();
  });

  it("item 5 — a única seção de DNA visível é 'Macete / Como resolver' (nenhum dos 6 campos legados aparece)", async () => {
    mockApi();
    renderNew();
    await screen.findByLabelText("Macete / Como resolver");
    for (const legacyLabel of ["Pista", "Estratégia", "Pegadinha", "Conteúdo de apoio", "Resolução DNA", "Aprendizado do erro", "Atalho"]) {
      expect(screen.queryByLabelText(new RegExp(`^${legacyLabel}`, "i"))).not.toBeInTheDocument();
    }
  });

  it("nova questão: mostra aviso para salvar antes de anexar imagem (item 16 da ordem)", async () => {
    mockApi();
    renderNew();
    await screen.findByLabelText("Enunciado");
    expect(screen.getByText(/salve o rascunho para adicionar imagens/i)).toBeInTheDocument();
  });

  it("item 6/8/9 — editar só o Macete envia `dna` mesclado, mas NUNCA `padroes`/`tags`/`imagens`", async () => {
    const calls = mockApi({ withLoadedQuestion: true });
    const user = userEvent.setup();
    renderEdit();

    const macete = await screen.findByLabelText("Macete / Como resolver");
    expect(macete).toHaveValue("Macete carregado");
    await user.clear(macete);
    await user.type(macete, "Macete editado agora.");

    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH");
      expect(patch).toBeDefined();
      const body = patch!.body as Record<string, unknown>;
      expect(body.dna).toMatchObject({
        estrategia: "Macete editado agora.",
        pista: "Pista legada",
        pegadinha: "Pegadinha legada",
        conteudoApoio: "Conteúdo de apoio legado",
        resolucao: "Resolução DNA legada",
        aprendizadoErro: "Aprendizado legado",
      });
      expect(body.padroes).toBeUndefined();
      expect(body.tags).toBeUndefined();
      expect(body.imagens).toBeUndefined();
      expect(body.enunciado).toBeUndefined(); // não editado — omitido também.
    });
  });

  it("item 7 — trocar o padrão principal preserva o padrão secundário oculto", async () => {
    const calls = mockApi({ withLoadedQuestion: true });
    const user = userEvent.setup();
    renderEdit();

    const select = (await screen.findByLabelText("Padrão")) as HTMLSelectElement;
    await user.selectOptions(select, DYNAMIC_PATTERN.id === "pat-dyn-1" ? "pat-dyn-1" : "");
    // Já está em pat-dyn-1 (carregado) — troca para "Nenhum selecionado" e
    // depois de volta não muda nada; força uma troca real selecionando
    // vazio primeiro.
    await user.selectOptions(select, "");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH");
      expect(patch).toBeDefined();
      const body = patch!.body as Record<string, unknown>;
      // Principal removido, mas o secundário oculto PRECISA sobreviver.
      expect(body.padroes).toEqual([{ patternId: "pat-secundario-oculto", role: "secundario" }]);
    });
  });

  it("nenhuma alteração real: Salvar não faz PATCH nenhum (payload vazio é interceptado antes)", async () => {
    const calls = mockApi({ withLoadedQuestion: true });
    const user = userEvent.setup();
    renderEdit();
    await screen.findByLabelText("Macete / Como resolver");
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => {
      expect(screen.getByText(/nada para salvar/i)).toBeInTheDocument();
    });
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});
