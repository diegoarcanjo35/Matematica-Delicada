import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttemptPage } from "./AttemptPage";
import type { AttemptState } from "../../api/playerClient";

/* Hotfix pós-Sprint 20 — o aviso "CONTEÚDO TÉCNICO PROVISÓRIO — NÃO
   PUBLICAR" só pode aparecer quando a questão É realmente uma fixture
   local de desenvolvimento. Antes deste hotfix, `ProvisionalContentNotice`
   era renderizado incondicionalmente em toda tela do Player — inclusive
   para uma questão REAL publicada, achado durante o smoke de produção da
   Sprint 20. A fonte de verdade agora é `attempt.question.isLocalFixture`,
   propagada 1:1 do backend a partir de `questions.is_local_fixture`. */

function buildAttempt(overrides: Partial<AttemptState> = {}): AttemptState {
  return {
    id: "attempt-1",
    questionId: "q-1",
    mode: "learning",
    status: "in_progress",
    selectedAlternative: null,
    recognitionSaved: false,
    recognitionPatternId: null,
    recognitionClue: null,
    recognitionStrategy: null,
    highestHelpLayer: 0,
    openedLayers: [],
    startedAt: new Date().toISOString(),
    answeredAt: null,
    completedAt: null,
    lastActivityAt: new Date().toISOString(),
    version: 1,
    question: {
      id: "q-1",
      code: "TESTE-01",
      enunciado: "Enunciado de teste.",
      dificuldade: "media",
      tipoCalculo: "mental",
      necessitaCalculadora: false,
      alternativas: [
        { letter: "A", text: "Alternativa A" },
        { letter: "B", text: "Alternativa B" },
      ],
      imagens: [],
      principalPatternId: null,
      isLocalFixture: false,
    },
    helpContent: {},
    feedback: null,
    isBookmarked: false,
    errorEntryId: null,
    ...overrides,
  };
}

function mockAttemptFetch(attempt: AttemptState) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ ok: true, attempt }), { status: 200 }))
  );
}

function renderAttemptPage() {
  return render(
    <MemoryRouter initialEntries={["/tentativas/attempt-1"]}>
      <Routes>
        <Route path="/tentativas/:attemptId" element={<AttemptPage />} />
      </Routes>
    </MemoryRouter>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AttemptPage — aviso de fixture só aparece para fixture REAL (hotfix pós-Sprint 20)", () => {
  it("1. questão real (isLocalFixture=false) em andamento — aviso NÃO aparece", async () => {
    mockAttemptFetch(buildAttempt({ question: { ...buildAttempt().question, isLocalFixture: false } }));
    renderAttemptPage();
    await waitFor(() => expect(screen.getByText("Enunciado de teste.")).toBeInTheDocument());
    expect(screen.queryByText(/CONTEÚDO TÉCNICO PROVISÓRIO/)).not.toBeInTheDocument();
  });

  it("2. questão real concluída — aviso NÃO aparece no feedback", async () => {
    mockAttemptFetch(
      buildAttempt({
        status: "completed",
        completedAt: new Date().toISOString(),
        selectedAlternative: "A",
        question: { ...buildAttempt().question, isLocalFixture: false },
        feedback: {
          selectedAlternative: "A",
          correctAlternative: "B",
          isCorrect: false,
          correctExplanation: null,
          distractorExplanations: [],
          principalPattern: null,
          dna: null,
        },
      })
    );
    renderAttemptPage();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Resultado" })).toBeInTheDocument());
    expect(screen.queryByText(/CONTEÚDO TÉCNICO PROVISÓRIO/)).not.toBeInTheDocument();
  });

  it("3. fixture local autorizada (isLocalFixture=true) — aviso aparece", async () => {
    mockAttemptFetch(buildAttempt({ question: { ...buildAttempt().question, isLocalFixture: true } }));
    renderAttemptPage();
    await waitFor(() => expect(screen.getByText("Enunciado de teste.")).toBeInTheDocument());
    expect(screen.getByText(/CONTEÚDO TÉCNICO PROVISÓRIO/)).toBeInTheDocument();
  });

  it("4. flag ausente (payload histórico/compatibilidade) — fail-closed: aviso NÃO aparece por padrão", async () => {
    const attempt = buildAttempt();
    // Simula um payload antigo, de antes deste hotfix, sem o campo novo.
    const { isLocalFixture: _omit, ...questionWithoutFlag } = attempt.question;
    void _omit;
    mockAttemptFetch({ ...attempt, question: questionWithoutFlag as typeof attempt.question });
    renderAttemptPage();
    await waitFor(() => expect(screen.getByText("Enunciado de teste.")).toBeInTheDocument());
    expect(screen.queryByText(/CONTEÚDO TÉCNICO PROVISÓRIO/)).not.toBeInTheDocument();
  });
});
