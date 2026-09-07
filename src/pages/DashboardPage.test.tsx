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

function mockApi(dailyTrainingCurrent: unknown = { ok: true, list: null }, performanceOverview: unknown = { ok: true, available: false }) {
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
      if (url.endsWith("/api/student-metrics/patterns/overview")) {
        return new Response(JSON.stringify(performanceOverview), { status: 200 });
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

function buildDailyTrainingList(status: "active" | "completed" | "abandoned") {
  return {
    id: "list-1",
    date: "2026-09-01",
    timezone: "America/Sao_Paulo",
    status,
    estimatedMinutes: 20,
    itemCount: 4,
    version: 1,
    createdAt: "2026-09-01T10:00:00.000Z",
    completedAt: status === "completed" ? "2026-09-01T11:00:00.000Z" : null,
    focusPattern: { id: "p1", slug: "escala", name: "Escala", mainStrategy: "Macete." },
    items: [
      { id: "i1", questionId: "q1", questionCode: "C1", patternId: "p1", patternName: "Escala", origin: "development", reason: "pattern_exploration", reasonLabel: "x", playerMode: "learning", position: 0, estimatedMinutes: 4, status: "completed", questionAttemptId: "a1", isCorrect: true, skipReason: null, version: 1 },
      { id: "i2", questionId: "q2", questionCode: "C2", patternId: "p1", patternName: "Escala", origin: "development", reason: "pattern_exploration", reasonLabel: "x", playerMode: "learning", position: 1, estimatedMinutes: 4, status: "pending", questionAttemptId: null, isCorrect: null, skipReason: null, version: 0 },
    ],
  };
}

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
    mockApi({ ok: true, list: buildDailyTrainingList("active") });
    renderDashboard();
    const heading = await screen.findByRole("heading", { name: "Treino de Escala" });
    const dominantSection = heading.closest("section")!;
    expect(within(dominantSection).getByRole("link", { name: "Continuar treino" })).toHaveAttribute("href", "/treino-diario");
    // Nunca mostra o seletor de padrões ao mesmo tempo que uma lista ativa.
    expect(screen.queryByRole("heading", { name: "O que você quer treinar hoje?" })).not.toBeInTheDocument();
  });
});

/* Sprint 20.1, seção 1 da ordem — GET /current também devolve a lista
   mais recente do dia mesmo quando ela já está completed/abandoned (para
   o resumo terminal sobreviver a um refresh em DailyTrainingPage); a
   seção dominante do Dashboard NUNCA pode confundir isso com "há um
   treino em andamento". Só status === "active" bloqueia o seletor. */
describe("DashboardPage — só lista ACTIVE bloqueia o seletor (Sprint 20.1)", () => {
  it("cenário A — status=active mostra 'Continuar treino' e NÃO mostra a grade de padrões", async () => {
    mockApi({ ok: true, list: buildDailyTrainingList("active") });
    renderDashboard();
    const heading = await screen.findByRole("heading", { name: "Treino de Escala" });
    const dominantSection = heading.closest("section")!;
    expect(within(dominantSection).getByRole("link", { name: "Continuar treino" })).toHaveAttribute("href", "/treino-diario");
    expect(screen.queryByRole("heading", { name: "O que você quer treinar hoje?" })).not.toBeInTheDocument();
  });

  it("cenário B — status=completed mostra a grade de padrões e NÃO mostra 'Continuar treino'", async () => {
    mockApi({ ok: true, list: buildDailyTrainingList("completed") });
    renderDashboard();
    const heading = await screen.findByRole("heading", { name: "O que você quer treinar hoje?" });
    const dominantSection = heading.closest("section")!;
    expect(within(dominantSection).getByRole("link", { name: /Escala/ })).toHaveAttribute("href", "/treino-diario?patternId=p1");
    expect(screen.queryByRole("link", { name: "Continuar treino" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Treino de Escala" })).not.toBeInTheDocument();
  });

  it("cenário C — status=abandoned mostra a grade de padrões e NÃO mostra 'Continuar treino'", async () => {
    mockApi({ ok: true, list: buildDailyTrainingList("abandoned") });
    renderDashboard();
    const heading = await screen.findByRole("heading", { name: "O que você quer treinar hoje?" });
    const dominantSection = heading.closest("section")!;
    expect(within(dominantSection).getByRole("link", { name: /Escala/ })).toHaveAttribute("href", "/treino-diario?patternId=p1");
    expect(screen.queryByRole("link", { name: "Continuar treino" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Treino de Escala" })).not.toBeInTheDocument();
  });
});

/* Sprint 21 — "Seu desempenho por padrão", resumo compacto abaixo da seção
   dominante do Treino Diário (seção 11 da ordem). */

function buildPerformanceItem(
  patternId: string,
  name: string,
  stateCode: string,
  stateLabel: string,
  overrides: Partial<{ attentionNeeded: boolean; lastPracticeAt: string | null; accuracy: number | null }> = {}
) {
  return {
    pattern: { id: patternId, slug: patternId, name, mainStrategy: "" },
    evidence: {
      confirmedAttempts: 3,
      correctCount: 1,
      incorrectCount: 2,
      distinctQuestionsUsed: 3,
      distinctPracticeDays: 2,
      attemptsWithHelp: 0,
      reviewsCorrect: 0,
      reviewsIncorrect: 0,
      lastPracticeAt: "lastPracticeAt" in overrides ? overrides.lastPracticeAt! : "2026-09-01T10:00:00.000Z",
    },
    accuracy: overrides.accuracy ?? null,
    state: { code: stateCode, label: stateLabel },
    attention: { needed: overrides.attentionNeeded ?? false, reason: overrides.attentionNeeded ? "Mais respostas incorretas do que corretas neste padrão até agora." : null },
    training: { canTrain: true, availableQuestionCount: 1 },
  };
}

describe("DashboardPage — 'Seu desempenho por padrão' (Sprint 21)", () => {
  it("item 21 — mostra a seção quando há dados reais de desempenho", async () => {
    mockApi(undefined, {
      ok: true,
      patterns: [buildPerformanceItem("p1", "Escala", "em_desenvolvimento", "Em desenvolvimento", { attentionNeeded: true })],
    });
    renderDashboard();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Seu desempenho por padrão" })).toBeInTheDocument());
  });

  it("item 22 — mostra no máximo 3 padrões, mesmo com mais disponíveis", async () => {
    mockApi(undefined, {
      ok: true,
      patterns: [
        buildPerformanceItem("p1", "Padrão Um", "revisao_pendente", "Revisão pendente", { attentionNeeded: true }),
        buildPerformanceItem("p2", "Padrão Dois", "em_desenvolvimento", "Em desenvolvimento", { attentionNeeded: true }),
        buildPerformanceItem("p3", "Padrão Três", "em_desenvolvimento", "Em desenvolvimento", { attentionNeeded: true }),
        buildPerformanceItem("p4", "Padrão Quatro", "em_desenvolvimento", "Em desenvolvimento", { attentionNeeded: true }),
      ],
    });
    renderDashboard();
    const heading = await screen.findByRole("heading", { name: "Seu desempenho por padrão" });
    const section = heading.closest("section")!;
    expect(within(section).getAllByText(/Padrão (Um|Dois|Três|Quatro)/)).toHaveLength(3);
  });

  it("item 23 — 'Ver desempenho completo' aponta para /desempenho", async () => {
    mockApi(undefined, {
      ok: true,
      patterns: [buildPerformanceItem("p1", "Escala", "em_desenvolvimento", "Em desenvolvimento", { attentionNeeded: true })],
    });
    renderDashboard();
    const heading = await screen.findByRole("heading", { name: "Seu desempenho por padrão" });
    const section = heading.closest("section")!;
    expect(within(section).getByRole("link", { name: "Ver desempenho completo" })).toHaveAttribute("href", "/desempenho");
  });

  it("item 24/25 — pouca evidência nunca é chamada de 'fraco', e nenhum '0%' aparece no resumo", async () => {
    mockApi(undefined, {
      ok: true,
      patterns: [
        buildPerformanceItem("p1", "Padrão Sem Evidência", "sem_evidencias", "Ainda sem evidências suficientes"),
        buildPerformanceItem("p2", "Padrão Inicial", "evidencias_iniciais", "Evidências iniciais", { lastPracticeAt: "2026-09-02T10:00:00.000Z" }),
      ],
    });
    renderDashboard();
    const heading = await screen.findByRole("heading", { name: "Seu desempenho por padrão" });
    const section = heading.closest("section")!;
    expect(within(section).queryByText(/fraco/i)).not.toBeInTheDocument();
    expect(within(section).queryByText(/0%/)).not.toBeInTheDocument();
  });

  it("sem nenhum padrão acionável e sem evidência recente: a seção não aparece (nunca inventa urgência)", async () => {
    mockApi(undefined, { ok: true, patterns: [buildPerformanceItem("p1", "Escala", "sem_evidencias", "Ainda sem evidências suficientes", { lastPracticeAt: null })] });
    renderDashboard();
    await waitFor(() => expect(screen.getByRole("heading", { name: "O que você quer treinar hoje?" })).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Seu desempenho por padrão" })).not.toBeInTheDocument();
  });
});
