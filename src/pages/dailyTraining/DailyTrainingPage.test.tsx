import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DailyTrainingPage } from "./DailyTrainingPage";

/* Sprint 20 (itens 49-58 da política de testes frontend) — novo fluxo de
   /treino-diario: seletor de padrão sem patternId na URL, preview focado
   com patternId, apply entrando na lista real, estados controlados de
   padrão inválido/sem questões. Mesma convenção de mock de `fetch` global
   usada em src/pages/editorial/EditorialImportsPage.test.tsx. */

const TRAINABLE_PATTERNS = [
  { id: "p1", slug: "escala", name: "Escala", mainStrategy: "Macete de escala.", availableQuestionCount: 3, canTrain: true },
  { id: "p2", slug: "porcentagem", name: "Porcentagem", mainStrategy: "", availableQuestionCount: 0, canTrain: false },
];

function focusedPreviewBody(patternId: string, itemCount = 5) {
  return {
    ok: true,
    preview: {
      date: "2026-09-01",
      timezone: "America/Sao_Paulo",
      hasAvailabilityToday: true,
      availableMinutesToday: 60,
      estimatedMinutes: itemCount * 4,
      itemCount,
      items: Array.from({ length: itemCount }, (_, i) => ({
        id: "",
        questionId: `q${i}`,
        questionCode: `C${i}`,
        patternId,
        patternName: "Escala",
        origin: "development",
        reason: "pattern_exploration",
        reasonLabel: "Padrão ainda sem nenhuma evidência registrada.",
        playerMode: "learning",
        position: i,
        estimatedMinutes: 4,
        status: "pending",
        questionAttemptId: null,
        isCorrect: null,
        skipReason: null,
        version: 0,
      })),
      composition: [],
      focusPattern: { id: patternId, slug: "escala", name: "Escala", mainStrategy: "Macete de escala." },
    },
  };
}

function buildList(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "list-1",
    date: "2026-09-01",
    timezone: "America/Sao_Paulo",
    status: "active",
    estimatedMinutes: 20,
    itemCount: 2,
    version: 1,
    createdAt: "2026-09-01T10:00:00.000Z",
    completedAt: null,
    focusPattern: { id: "p1", slug: "escala", name: "Escala", mainStrategy: "Macete de escala." },
    items: [
      {
        id: "item-1",
        questionId: "q1",
        questionCode: "C1",
        patternId: "p1",
        patternName: "Escala",
        origin: "development",
        reason: "pattern_exploration",
        reasonLabel: "Padrão ainda sem nenhuma evidência registrada.",
        playerMode: "learning",
        position: 0,
        estimatedMinutes: 4,
        status: "pending",
        questionAttemptId: null,
        isCorrect: null,
        skipReason: null,
        version: 0,
      },
    ],
    ...overrides,
  };
}

interface MockHttpResult {
  status: number;
  body: unknown;
}

interface MockRoutes {
  current?: unknown;
  patterns?: unknown;
  preview?: (patternId: string) => unknown | MockHttpResult;
  apply?: unknown;
}

function isMockHttpResult(value: unknown): value is MockHttpResult {
  return typeof value === "object" && value !== null && "status" in value && "body" in value;
}

function mockApi(routes: MockRoutes) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/daily-training/current")) {
        return new Response(JSON.stringify(routes.current ?? { ok: true, list: null }), { status: 200 });
      }
      if (url.includes("/api/daily-training/patterns") && url.endsWith("/preview")) {
        const patternId = url.match(/patterns\/([^/]+)\/preview/)?.[1] ?? "";
        const result = routes.preview?.(patternId) ?? focusedPreviewBody(patternId);
        if (isMockHttpResult(result)) {
          return new Response(JSON.stringify(result.body), { status: result.status });
        }
        return new Response(JSON.stringify(result), { status: 200 });
      }
      if (url.includes("/api/daily-training/patterns") && url.endsWith("/apply")) {
        return new Response(JSON.stringify(routes.apply ?? { ok: true, listId: "list-1" }), { status: 200 });
      }
      if (url.endsWith("/api/daily-training/patterns")) {
        return new Response(JSON.stringify(routes.patterns ?? { ok: true, patterns: TRAINABLE_PATTERNS }), { status: 200 });
      }
      if (url.match(/\/complete$/)) {
        return new Response(JSON.stringify({ ok: true, summary: {} }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    })
  );
}

function renderPage(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/treino-diario" element={<DailyTrainingPage />} />
      </Routes>
    </MemoryRouter>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal("crypto", { ...crypto, randomUUID: () => "mut-test" });
});

describe("DailyTrainingPage — Sprint 20", () => {
  it("item 49 — sem patternId na URL mostra o seletor de padrões", async () => {
    mockApi({});
    renderPage("/treino-diario");
    await waitFor(() => expect(screen.getByText("O que você quer treinar hoje?")).toBeInTheDocument());
    expect(screen.getByText("Escala")).toBeInTheDocument();
    expect(screen.getByText("Questões em preparação")).toBeInTheDocument();
  });

  it("item 50/53 — com patternId válido mostra o preview focal (nome, quantidade, minutos)", async () => {
    mockApi({});
    renderPage("/treino-diario?patternId=p1");
    await waitFor(() => expect(screen.getByText("Treino de Escala")).toBeInTheDocument());
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText(/questões/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Começar treino" })).toBeInTheDocument();
  });

  it("item 51 — 'Escolher outro padrão' volta para o seletor", async () => {
    mockApi({});
    renderPage("/treino-diario?patternId=p1");
    await waitFor(() => expect(screen.getByText("Treino de Escala")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Escolher outro padrão" }));
    await waitFor(() => expect(screen.getByText("O que você quer treinar hoje?")).toBeInTheDocument());
  });

  it("item 52 — URL com patternId sobrevive a um novo carregamento da página (deep link)", async () => {
    mockApi({});
    renderPage("/treino-diario?patternId=p1");
    await waitFor(() => expect(screen.getByText("Treino de Escala")).toBeInTheDocument());
  });

  it("item 54 — apply entra na lista REAL retornada pelo servidor", async () => {
    mockApi({ apply: { ok: true, listId: "list-1" }, current: { ok: true, list: null } });
    renderPage("/treino-diario?patternId=p1");
    await waitFor(() => expect(screen.getByRole("button", { name: "Começar treino" })).toBeInTheDocument());

    // Depois do apply, a próxima leitura de /current precisa devolver a
    // lista real para a tela avançar para a fase "active".
    let applyCalled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/apply")) {
          applyCalled = true;
          return new Response(JSON.stringify({ ok: true, listId: "list-1" }), { status: 200 });
        }
        if (url.includes("/current")) {
          return new Response(JSON.stringify({ ok: true, list: applyCalled ? buildList() : null }), { status: 200 });
        }
        if (url.endsWith("/preview")) return new Response(JSON.stringify(focusedPreviewBody("p1")), { status: 200 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );

    await userEvent.click(screen.getByRole("button", { name: "Começar treino" }));
    await waitFor(() => expect(screen.getByText("C1")).toBeInTheDocument());
  });

  it("item 55 — lista ativa (já existente) mantém o ciclo de vida atual (itens, ações)", async () => {
    mockApi({ current: { ok: true, list: buildList() } });
    renderPage("/treino-diario");
    await waitFor(() => expect(screen.getByText("Treino de Escala")).toBeInTheDocument());
    expect(screen.getByText("C1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Começar questão" })).toBeInTheDocument();
  });

  it("item 56 — padrão inválido/inexistente mostra estado controlado (nunca fallback silencioso)", async () => {
    mockApi({ preview: () => ({ status: 404, body: { error: { code: "not_found", message: "não encontrado" } } }) });
    renderPage("/treino-diario?patternId=nao-existe");
    await waitFor(() => expect(screen.getByText("Este padrão não está disponível")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Escolher outro padrão" })).toBeInTheDocument();
  });

  it("item 57 — padrão sem questões elegíveis mostra empty state honesto", async () => {
    mockApi({ preview: (id) => ({ ...focusedPreviewBody(id, 0), preview: { ...focusedPreviewBody(id, 0).preview, itemCount: 0, items: [] } }) });
    renderPage("/treino-diario?patternId=p1");
    await waitFor(() => expect(screen.getByText("Este padrão ainda não tem questões disponíveis para treino")).toBeInTheDocument());
  });
});

describe("DailyTrainingPage — resumo pós-treino (Sprint 20, itens 59-64)", () => {
  function completedList(overrides: Partial<Record<string, unknown>> = {}) {
    return buildList({
      status: "completed",
      focusPattern: { id: "p1", slug: "escala", name: "Escala", mainStrategy: "Some o numerador com o denominador." },
      items: [
        { id: "i1", questionId: "q1", questionCode: "C1", patternId: "p1", patternName: "Escala", origin: "development", reason: "pattern_exploration", reasonLabel: "x", playerMode: "learning", position: 0, estimatedMinutes: 4, status: "completed", questionAttemptId: "a1", isCorrect: true, skipReason: null, version: 1 },
        { id: "i2", questionId: "q2", questionCode: "C2", patternId: "p1", patternName: "Escala", origin: "development", reason: "pattern_exploration", reasonLabel: "x", playerMode: "learning", position: 1, estimatedMinutes: 4, status: "completed", questionAttemptId: "a2", isCorrect: false, skipReason: null, version: 1 },
        { id: "i3", questionId: "q3", questionCode: "C3", patternId: "p1", patternName: "Escala", origin: "development", reason: "pattern_exploration", reasonLabel: "x", playerMode: "learning", position: 2, estimatedMinutes: 4, status: "completed", questionAttemptId: "a3", isCorrect: true, skipReason: null, version: 1 },
        { id: "i4", questionId: "q4", questionCode: "C4", patternId: "p1", patternName: "Escala", origin: "development", reason: "pattern_exploration", reasonLabel: "x", playerMode: "learning", position: 3, estimatedMinutes: 4, status: "completed", questionAttemptId: "a4", isCorrect: true, skipReason: null, version: 1 },
      ],
      itemCount: 4,
      ...overrides,
    });
  }

  it("item 59 — 3 corretas / 1 incorreta mostra 75% de acerto", async () => {
    mockApi({ current: { ok: true, list: completedList() } });
    renderPage("/treino-diario");
    await waitFor(() => expect(screen.getByText("Treino concluído")).toBeInTheDocument());
    expect(screen.getByText(/75%/)).toBeInTheDocument();
  });

  it("item 61 — zero respostas confirmadas NUNCA mostra 0%, mostra mensagem honesta", async () => {
    mockApi({
      current: {
        ok: true,
        list: buildList({
          status: "completed",
          items: [
            { id: "i1", questionId: "q1", questionCode: "C1", patternId: "p1", patternName: "Escala", origin: "development", reason: "pattern_exploration", reasonLabel: "x", playerMode: "learning", position: 0, estimatedMinutes: 4, status: "skipped", questionAttemptId: null, isCorrect: null, skipReason: "not_now", version: 1 },
          ],
        }),
      },
    });
    renderPage("/treino-diario");
    await waitFor(() => expect(screen.getByText("Treino concluído")).toBeInTheDocument());
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
    expect(screen.getByText("Nenhuma questão respondida foi registrada neste treino.")).toBeInTheDocument();
  });

  it("item 62 — mainStrategy real do focusPattern aparece como 'Macete / Como resolver'", async () => {
    mockApi({ current: { ok: true, list: completedList() } });
    renderPage("/treino-diario");
    await waitFor(() => expect(screen.getByText("Treino concluído")).toBeInTheDocument());
    expect(screen.getByText("Macete / Como resolver")).toBeInTheDocument();
    expect(screen.getByText("Some o numerador com o denominador.")).toBeInTheDocument();
  });

  it("item 63 — mainStrategy vazio NUNCA gera uma seção de Macete vazia", async () => {
    mockApi({
      current: {
        ok: true,
        list: completedList({ focusPattern: { id: "p1", slug: "escala", name: "Escala", mainStrategy: "" } }),
      },
    });
    renderPage("/treino-diario");
    await waitFor(() => expect(screen.getByText("Treino concluído")).toBeInTheDocument());
    expect(screen.queryByText("Macete / Como resolver")).not.toBeInTheDocument();
  });

  it("item 64 — questões incorretas geram a seção 'Vale revisar' com CTA para o Caderno de Erros", async () => {
    mockApi({ current: { ok: true, list: completedList() } });
    renderPage("/treino-diario");
    await waitFor(() => expect(screen.getByText("Treino concluído")).toBeInTheDocument());
    expect(screen.getByText("Vale revisar")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ver Caderno de Erros" })).toHaveAttribute("href", "/caderno-de-erros");
  });

  it("'Treinar outro padrão' no resumo concluído leva ao Dashboard", async () => {
    mockApi({ current: { ok: true, list: completedList() } });
    renderPage("/treino-diario");
    await waitFor(() => expect(screen.getByText("Treino concluído")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Treinar outro padrão" })).toHaveAttribute("href", "/");
  });

  it("estado abandonado oferece 'Escolher outro padrão' (nunca 'só amanhã', já que o backend permite outra lista hoje)", async () => {
    mockApi({ current: { ok: true, list: buildList({ status: "abandoned" }) } });
    renderPage("/treino-diario");
    await waitFor(() => expect(screen.getByText("Treino abandonado")).toBeInTheDocument());
    expect(screen.queryByText(/amanhã/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Escolher outro padrão" })).toHaveAttribute("href", "/");
  });
});

/* Sprint 20.1, seção 2/4 da ordem — distinção explícita entre lista
   ACTIVE (sempre soberana sobre qualquer patternId da URL) e lista
   TERMINAL (completed/abandoned, que preserva o resumo num refresh SEM
   patternId, mas nunca bloqueia uma escolha explícita de outro padrão
   feita agora). */
describe("DailyTrainingPage — ACTIVE vs TERMINAL ao decidir o que carregar (Sprint 20.1)", () => {
  function completedListOf(patternName: string) {
    return {
      id: "list-escala",
      date: "2026-09-01",
      timezone: "America/Sao_Paulo",
      status: "completed",
      estimatedMinutes: 8,
      itemCount: 2,
      version: 2,
      createdAt: "2026-09-01T10:00:00.000Z",
      completedAt: "2026-09-01T10:30:00.000Z",
      focusPattern: { id: "p1", slug: "escala", name: patternName, mainStrategy: "Macete." },
      items: [
        { id: "i1", questionId: "q1", questionCode: "C1", patternId: "p1", patternName, origin: "development", reason: "pattern_exploration", reasonLabel: "x", playerMode: "learning", position: 0, estimatedMinutes: 4, status: "completed", questionAttemptId: "a1", isCorrect: true, skipReason: null, version: 1 },
        { id: "i2", questionId: "q2", questionCode: "C2", patternId: "p1", patternName, origin: "development", reason: "pattern_exploration", reasonLabel: "x", playerMode: "learning", position: 1, estimatedMinutes: 4, status: "completed", questionAttemptId: "a2", isCorrect: true, skipReason: null, version: 1 },
      ],
    };
  }

  it("cenário completo — lista COMPLETED de 'Escala' + escolha explícita de 'Probabilidade': a escolha nova vence, nunca o resumo antigo", async () => {
    mockApi({
      current: { ok: true, list: completedListOf("Escala") },
      preview: (patternId) => ({
        ok: true,
        preview: {
          date: "2026-09-01",
          timezone: "America/Sao_Paulo",
          hasAvailabilityToday: true,
          availableMinutesToday: 60,
          estimatedMinutes: 8,
          itemCount: 2,
          items: [],
          composition: [],
          focusPattern: { id: patternId, slug: "probabilidade", name: "Probabilidade", mainStrategy: "Macete de probabilidade." },
        },
      }),
    });
    renderPage("/treino-diario?patternId=p-prob");
    await waitFor(() => expect(screen.getByText("Treino de Probabilidade")).toBeInTheDocument());
    // NUNCA mostra o resumo terminal do padrão anterior.
    expect(screen.queryByText("Treino concluído")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Começar treino" })).toBeInTheDocument();
  });

  it("sem patternId, depois de concluir — o resumo terminal sobrevive a um novo carregamento/refresh", async () => {
    mockApi({ current: { ok: true, list: completedListOf("Escala") } });
    renderPage("/treino-diario");
    await waitFor(() => expect(screen.getByText("Treino concluído")).toBeInTheDocument());
    expect(screen.getByText("Bom trabalho no treino de Escala!")).toBeInTheDocument();
  });

  it("sem patternId, depois de abandonar — o estado terminal sobrevive a um novo carregamento/refresh", async () => {
    mockApi({ current: { ok: true, list: { ...completedListOf("Escala"), status: "abandoned" } } });
    renderPage("/treino-diario");
    await waitFor(() => expect(screen.getByText("Treino abandonado")).toBeInTheDocument());
  });

  it("lista ATIVA sempre vence qualquer patternId na URL (mesmo de um padrão diferente)", async () => {
    mockApi({ current: { ok: true, list: buildList({ status: "active" }) } });
    renderPage("/treino-diario?patternId=algum-outro-padrao");
    await waitFor(() => expect(screen.getByText("Treino de Escala")).toBeInTheDocument());
    // A tela ativa (com itens/ações), nunca um preview focado do padrão da URL.
    expect(screen.getByRole("button", { name: "Começar questão" })).toBeInTheDocument();
  });
});
