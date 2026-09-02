import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const MOCK_USER = { id: "u1", name: "Ana Cláudia Teste", email: "ana@teste.com", emailConfirmed: true };

// Perfil "concluído" — estes testes cobrem roteamento pós-login, não o
// onboarding em si (ver onboarding.test.ts no worker e os specs de e2e
// dedicados). Sem isso, RequireOnboardingComplete redirecionaria toda
// navegação autenticada para /onboarding.
const MOCK_COMPLETED_PROFILE = {
  status: "completed",
  currentStep: 7,
  currentGrade: "3_serie_em",
  enemYear: 2026,
  goalType: "acertos",
  goalValue: 30,
  currentCorrectEstimate: null,
  availableDays: ["seg", "qua", "sex"],
  dailyMinutes: 60,
  difficulties: [],
  timePreference: "noite",
  accessibilityNeeds: null,
  diagnosticChoice: "depois",
  startedAt: "2026-01-01 00:00:00",
  completedAt: "2026-01-01 00:00:00",
};

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
      if (url.includes("/api/onboarding")) {
        return new Response(JSON.stringify({ ok: true, profile: MOCK_COMPLETED_PROFILE }), { status: 200 });
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

    it("renderiza a página REAL do Treino Diário (Sprint 11) — não é mais um placeholder", async () => {
      // Mock LOCAL a este teste (nunca global/compartilhado — restaurado pelo
      // afterEach de vi.unstubAllGlobals() do describe pai, igual a todo o
      // resto do arquivo): a DailyTrainingPage real faz fetch de
      // /api/daily-training/current e, sem lista ativa, de
      // /api/daily-training/preview. Devolve "sem disponibilidade hoje" — um
      // estado estável e determinístico da página real (não a tela de
      // aplicar/carregar itens, que exigiria mockar todo o catálogo de
      // questões) — para provar que a rota monta o COMPONENTE REAL, nunca a
      // tela de erro genérica (ErrorState) que apareceria se a resposta não
      // batesse com o formato esperado pelo cliente.
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url.includes("/api/auth/session")) {
            return new Response(JSON.stringify({ ok: true, user: MOCK_USER }), { status: 200 });
          }
          if (url.includes("/api/onboarding")) {
            return new Response(JSON.stringify({ ok: true, profile: MOCK_COMPLETED_PROFILE }), { status: 200 });
          }
          if (url.includes("/api/daily-training/current")) {
            return new Response(JSON.stringify({ ok: true, list: null }), { status: 200 });
          }
          if (url.includes("/api/daily-training/preview")) {
            return new Response(
              JSON.stringify({
                ok: true,
                preview: {
                  date: "2026-09-02",
                  timezone: "America/Sao_Paulo",
                  hasAvailabilityToday: false,
                  availableMinutesToday: 0,
                  estimatedMinutes: 0,
                  itemCount: 0,
                  items: [],
                  composition: [],
                },
              }),
              { status: 200 }
            );
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        })
      );

      renderAt("/treino-diario");
      expect(await screen.findByRole("heading", { name: "Treino Diário" })).toBeInTheDocument();
      expect(screen.getByText("Sem disponibilidade configurada para hoje")).toBeInTheDocument();
      // Nunca aceitar o antigo placeholder nem a tela de erro genérica como
      // um falso "sucesso" — a rota deixou de ser placeholder (seção 1 desta
      // correção) e uma resposta mal-mockada deve falhar contra ESTE texto,
      // não passar silenciosamente.
      expect(screen.queryByText("Módulo em construção")).not.toBeInTheDocument();
      expect(screen.queryByText("Não foi possível carregar o treino de hoje.")).not.toBeInTheDocument();
    });

    it("renderiza a navegação lateral com todos os itens do menu do aluno", async () => {
      renderAt("/");
      const nav = await screen.findByRole("navigation", { name: "Navegação principal" });
      expect(nav).toBeInTheDocument();
      expect(screen.getAllByRole("link", { name: /Início/ }).length).toBeGreaterThan(0);
    });
  });

  describe("aluno autenticado com onboarding incompleto", () => {
    beforeEach(() => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url.includes("/api/auth/session")) {
            return new Response(JSON.stringify({ ok: true, user: MOCK_USER }), { status: 200 });
          }
          if (url.includes("/api/onboarding")) {
            return new Response(
              JSON.stringify({
                ok: true,
                profile: { ...MOCK_COMPLETED_PROFILE, status: "in_progress", currentStep: 2 },
              }),
              { status: 200 }
            );
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        })
      );
    });

    it("é redirecionado para /onboarding ao tentar acessar a área do aluno", async () => {
      renderAt("/");
      // currentStep salvo é 2 — o redirecionamento retoma na etapa salva, não sempre na 1.
      expect(await screen.findByRole("heading", { name: "Meta e ponto atual" })).toBeInTheDocument();
    });

    it("consegue acessar /onboarding diretamente e retoma na etapa salva", async () => {
      renderAt("/onboarding");
      expect(await screen.findByRole("heading", { name: "Meta e ponto atual" })).toBeInTheDocument();
    });
  });
});
