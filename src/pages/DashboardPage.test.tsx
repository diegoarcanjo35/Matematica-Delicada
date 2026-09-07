import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardPage } from "./DashboardPage";
import { AuthContext } from "../auth/authContextStore";
import { OnboardingStatusContext } from "../onboarding/onboardingStatusStore";

/* Sprint 20 (itens 43/46/47/48 da política de testes frontend) — a nova
   seção dominante "O que você quer treinar hoje?" no Dashboard: aparece em
   destaque, vem 100% da API (nunca hardcoded), padrão sem questão fica
   desabilitado, clique navega com patternId, e uma lista ATIVA troca o
   seletor por "Continuar treino" (nunca as duas coisas ao mesmo tempo). */

const TRAINABLE_PATTERNS = [
  { id: "p1", slug: "escala", name: "Escala", mainStrategy: "Macete.", availableQuestionCount: 4, canTrain: true },
  { id: "p2", slug: "geometria", name: "Geometria Espacial", mainStrategy: "", availableQuestionCount: 0, canTrain: false },
];

function mockApi(dailyTrainingCurrent: unknown = { ok: true, list: null }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/daily-training/patterns")) {
        return new Response(JSON.stringify({ ok: true, patterns: TRAINABLE_PATTERNS }), { status: 200 });
      }
      if (url.includes("/api/daily-training/current")) {
        return new Response(JSON.stringify(dailyTrainingCurrent), { status: 200 });
      }
      // Todos os outros cards do Dashboard (Cronograma, Padrões ENEM,
      // Caderno de Erros, Mapa ENEM, Simulados, Relatório Semanal) — resposta
      // genérica e inofensiva; cada seção já tolera "sem dados" (mostra o
      // estado "em preparação"), irrelevante para o que este arquivo cobre.
      return new Response(JSON.stringify({ ok: true, available: false }), { status: 200 });
    })
  );
}

function renderDashboard() {
  const authValue = {
    status: "authenticated" as const,
    user: { id: "u1", name: "Andreia Teste", email: "andreia@teste.dev", emailConfirmed: true },
    login: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
  };
  const onboardingValue = { status: "complete" as const, profile: null, refresh: vi.fn() };
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={authValue}>
        <OnboardingStatusContext.Provider value={onboardingValue}>
          <DashboardPage />
        </OnboardingStatusContext.Provider>
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DashboardPage — 'O que você quer treinar hoje?' (Sprint 20)", () => {
  it("item 43 — aparece em destaque, logo após a saudação", async () => {
    mockApi();
    renderDashboard();
    await waitFor(() => expect(screen.getByRole("heading", { name: "O que você quer treinar hoje?" })).toBeInTheDocument());
    expect(screen.getByText("Escolha um padrão e faça seu treino de hoje.")).toBeInTheDocument();
  });

  it("item 44 — os cards vêm da API, nunca hardcoded", async () => {
    mockApi();
    renderDashboard();
    await waitFor(() => expect(screen.getByText("Escala")).toBeInTheDocument());
    expect(screen.getByText("Geometria Espacial")).toBeInTheDocument();
  });

  it("item 45 — padrão com zero questões elegíveis fica desabilitado", async () => {
    mockApi();
    renderDashboard();
    await waitFor(() => expect(screen.getByText("Geometria Espacial")).toBeInTheDocument());
    expect(screen.getByText("Questões em preparação")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Geometria Espacial/ })).not.toBeInTheDocument();
  });

  it("item 46 — clicar num padrão navega com patternId na URL", async () => {
    mockApi();
    renderDashboard();
    await waitFor(() => expect(screen.getByText("Escala")).toBeInTheDocument());
    const link = screen.getByRole("link", { name: /Escala/ });
    expect(link).toHaveAttribute("href", "/treino-diario?patternId=p1");
  });

  it("item 47/48 — lista ativa troca o seletor por 'Continuar treino', com nome do padrão quando derivável com segurança", async () => {
    mockApi({
      ok: true,
      list: {
        id: "list-1",
        date: "2026-09-01",
        timezone: "America/Sao_Paulo",
        status: "active",
        estimatedMinutes: 20,
        itemCount: 4,
        version: 1,
        createdAt: "2026-09-01T10:00:00.000Z",
        completedAt: null,
        focusPattern: { id: "p1", slug: "escala", name: "Escala", mainStrategy: "Macete." },
        items: [
          { id: "i1", questionId: "q1", questionCode: "C1", patternId: "p1", patternName: "Escala", origin: "development", reason: "pattern_exploration", reasonLabel: "x", playerMode: "learning", position: 0, estimatedMinutes: 4, status: "completed", questionAttemptId: "a1", isCorrect: true, skipReason: null, version: 1 },
          { id: "i2", questionId: "q2", questionCode: "C2", patternId: "p1", patternName: "Escala", origin: "development", reason: "pattern_exploration", reasonLabel: "x", playerMode: "learning", position: 1, estimatedMinutes: 4, status: "pending", questionAttemptId: null, isCorrect: null, skipReason: null, version: 0 },
        ],
      },
    });
    renderDashboard();
    const heading = await screen.findByRole("heading", { name: "Treino de Escala" });
    const dominantSection = heading.closest("section")!;
    expect(within(dominantSection).getByRole("link", { name: "Continuar treino" })).toHaveAttribute("href", "/treino-diario");
    // Nunca mostra o seletor de padrões ao mesmo tempo que uma lista ativa.
    expect(screen.queryByRole("heading", { name: "O que você quer treinar hoje?" })).not.toBeInTheDocument();
  });
});
