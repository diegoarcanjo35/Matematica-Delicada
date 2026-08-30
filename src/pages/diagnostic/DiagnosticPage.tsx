import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Alert } from "../../components/Alert";
import { LoadingState } from "../../components/LoadingState";
import { ProgressBar } from "../../components/ProgressBar";
import { Modal } from "../../components/Modal";
import {
  completeDiagnosticAttempt,
  createDiagnosticAttempt,
  fetchDiagnosticAttempt,
  fetchDiagnosticResult,
  fetchDiagnosticStatus,
  openDiagnosticHelp,
  saveDiagnosticResponse,
  DiagnosticApiError,
  type DiagnosticAttemptDetail,
  type DiagnosticResult,
} from "../../api/diagnosticClient";
import "./DiagnosticPage.css";

type Phase =
  | "loading"
  | "unavailable"
  | "empty"
  | "intro"
  | "resume_prompt"
  | "completed_prompt"
  | "question"
  | "result"
  | "error";

const HELP_LAYER_LABELS: Record<number, string> = {
  1: "Pista leve",
  2: "Reconheça o padrão",
  3: "Estratégia",
  4: "Resolução comentada",
};

// Marca literal exigida (seção 2 da ordem) — independente do texto de
// qualquer questão/ajuda de fixture, para que este aviso apareça mesmo que
// uma questão futura não traga a marca embutida no próprio enunciado.
function ProvisionalContentNotice() {
  return (
    <p className="diagnostic__provisional-notice" role="note">
      CONTEÚDO TÉCNICO PROVISÓRIO — NÃO PUBLICAR. Estas questões são fixtures locais de
      desenvolvimento, não o banco pedagógico aprovado da Andreia.
    </p>
  );
}

export function DiagnosticPage() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<DiagnosticAttemptDetail | null>(null);
  const [result, setResult] = useState<DiagnosticResult | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [completedAttemptSummary, setCompletedAttemptSummary] = useState<{ id: string } | null>(null);
  const [showRestartConfirm, setShowRestartConfirm] = useState(false);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);

  // Estado da questão atual (não persistido até "Avançar").
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const [recognitionOptionId, setRecognitionOptionId] = useState<string | null>(null);
  const [isDontKnow, setIsDontKnow] = useState(false);
  const [openedHelpContent, setOpenedHelpContent] = useState<Record<number, string>>({});
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Inicializado com 0 (não Date.now() — chamar função impura durante o
  // render não é permitido); o valor real é sempre definido em
  // loadQuestionState, chamado a partir de handlers/efeitos, nunca do render.
  const questionStartRef = useRef<number>(0);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const loadStatus = useCallback(async () => {
    setPhase("loading");
    try {
      const status = await fetchDiagnosticStatus();
      if (!status.available) {
        setPhase("unavailable");
        return;
      }
      if (status.activeAttemptId) {
        const { attempt: detail } = await fetchDiagnosticAttempt(status.activeAttemptId);
        setAttempt(detail);
        setPhase("resume_prompt");
        return;
      }
      if (status.latestCompletedAttemptId) {
        setCompletedAttemptSummary({ id: status.latestCompletedAttemptId });
        setPhase("completed_prompt");
        return;
      }
      setPhase("intro");
    } catch {
      setErrorMessage("Não foi possível carregar o diagnóstico. Tente novamente.");
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (phase === "question") headingRef.current?.focus();
  }, [phase, currentIndex]);

  function loadQuestionState(detail: DiagnosticAttemptDetail, index: number) {
    const question = detail.questions[index];
    setSelectedOptionId(null);
    setRecognitionOptionId(null);
    setIsDontKnow(question?.isDontKnow ?? false);
    setOpenedHelpContent({});
    setSaveState("idle");
    questionStartRef.current = Date.now();
  }

  async function beginAttempt(restart: boolean) {
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const result = await createDiagnosticAttempt(restart);
      if (!("ok" in result) || !result.ok) {
        setErrorMessage("Não foi possível iniciar o diagnóstico. Tente novamente.");
        setPhase("error");
        return;
      }
      const { attempt: detail } = await fetchDiagnosticAttempt(result.attemptId);
      setAttempt(detail);
      const firstUnanswered = detail.questions.findIndex((question) => !question.answered);
      const startIndex = firstUnanswered === -1 ? 0 : firstUnanswered;
      setCurrentIndex(startIndex);
      loadQuestionState(detail, startIndex);
      setPhase("question");
    } catch (error) {
      if (error instanceof DiagnosticApiError && error.code === "no_questions") {
        setPhase("empty");
        return;
      }
      setErrorMessage("Não foi possível iniciar o diagnóstico. Tente novamente.");
      setPhase("error");
    } finally {
      setIsSubmitting(false);
      setShowRestartConfirm(false);
    }
  }

  function resumeAttempt() {
    if (!attempt) return;
    const firstUnanswered = attempt.questions.findIndex((question) => !question.answered);
    const startIndex = firstUnanswered === -1 ? attempt.questions.length - 1 : firstUnanswered;
    setCurrentIndex(startIndex);
    loadQuestionState(attempt, startIndex);
    setPhase("question");
  }

  async function viewResult(attemptId: string) {
    setPhase("loading");
    try {
      const { result: resultData } = await fetchDiagnosticResult(attemptId);
      setResult(resultData);
      setPhase("result");
    } catch {
      setErrorMessage("Não foi possível carregar o resultado.");
      setPhase("error");
    }
  }

  async function handleOpenHelp(layer: number) {
    if (!attempt) return;
    const question = attempt.questions[currentIndex];
    try {
      const { content } = await openDiagnosticHelp(attempt.id, question.id, layer);
      setOpenedHelpContent((prev) => ({ ...prev, [layer]: content }));
    } catch {
      setErrorMessage("Não foi possível abrir esta camada de ajuda agora.");
    }
  }

  async function handleAdvance() {
    if (!attempt || isSubmitting) return;
    const question = attempt.questions[currentIndex];
    if (!isDontKnow && !selectedOptionId) return;

    setIsSubmitting(true);
    setSaveState("saving");
    const timeSpentMs = Date.now() - questionStartRef.current;
    try {
      await saveDiagnosticResponse(attempt.id, question.id, {
        optionId: isDontKnow ? undefined : selectedOptionId ?? undefined,
        recognitionOptionId: recognitionOptionId ?? undefined,
        isDontKnow,
        timeSpentMs,
      });
      setSaveState("saved");

      const isLast = currentIndex === attempt.questions.length - 1;
      if (isLast) {
        await completeDiagnosticAttempt(attempt.id);
        await viewResult(attempt.id);
        return;
      }

      const nextIndex = currentIndex + 1;
      setCurrentIndex(nextIndex);
      loadQuestionState(attempt, nextIndex);
    } catch (error) {
      setSaveState("error");
      if (!(error instanceof DiagnosticApiError)) {
        setErrorMessage("Não foi possível salvar sua resposta. Tente novamente.");
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleBack() {
    if (!attempt || currentIndex === 0) return;
    const previousIndex = currentIndex - 1;
    setCurrentIndex(previousIndex);
    loadQuestionState(attempt, previousIndex);
  }

  function handleLeave() {
    navigate("/", { replace: true });
  }

  if (phase === "loading") {
    return <LoadingState label="Carregando o diagnóstico…" />;
  }

  if (phase === "unavailable") {
    return (
      <div className="diagnostic diagnostic--centered">
        <Card className="diagnostic__card">
          <h1>Diagnóstico em preparação</h1>
          <p>
            O diagnóstico inicial ainda está em preparação pedagógica. Assim que a metodologia e o banco
            de questões forem aprovados, ele ficará disponível por aqui.
          </p>
          <Button onClick={() => navigate("/")}>Voltar ao início</Button>
        </Card>
      </div>
    );
  }

  if (phase === "empty") {
    return (
      <div className="diagnostic diagnostic--centered">
        <Card className="diagnostic__card">
          <h1>Ainda não há questões cadastradas</h1>
          <p>
            O motor técnico do diagnóstico está pronto, mas nenhuma questão está disponível neste ambiente
            agora. Isso não é um erro do seu lado — tente novamente mais tarde.
          </p>
          <Button onClick={() => navigate("/")}>Voltar ao início</Button>
        </Card>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="diagnostic diagnostic--centered">
        <Card className="diagnostic__card">
          <Alert variant="error">{errorMessage ?? "Ocorreu um erro inesperado."}</Alert>
          <Button onClick={() => void loadStatus()}>Tentar novamente</Button>
        </Card>
      </div>
    );
  }

  if (phase === "intro") {
    return (
      <div className="diagnostic diagnostic--centered">
        <Card className="diagnostic__card">
          <ProvisionalContentNotice />
          <h1>Vamos conhecer seu ponto de partida</h1>
          <p>
            Este diagnóstico tem algumas questões para entender como você reconhece e resolve problemas de
            Matemática — sem pressa e sem cobrança. Leva cerca de 15 a 20 minutos, mas você pode pausar e
            retomar quando quiser.
          </p>
          <p className="diagnostic__help-text">
            Se não souber por onde começar em alguma questão, é só marcar essa opção — isso também nos
            ajuda a entender seu momento atual.
          </p>
          <Button onClick={() => void beginAttempt(false)} isLoading={isSubmitting}>
            Começar diagnóstico
          </Button>
        </Card>
      </div>
    );
  }

  if (phase === "resume_prompt") {
    return (
      <div className="diagnostic diagnostic--centered">
        <Card className="diagnostic__card">
          <h1>Você tem um diagnóstico em andamento</h1>
          <p>Suas respostas já salvas continuam aqui. Quer continuar de onde parou?</p>
          <div className="diagnostic__actions">
            <Button variant="secondary" onClick={() => setShowRestartConfirm(true)}>
              Reiniciar diagnóstico
            </Button>
            <Button onClick={resumeAttempt}>Continuar diagnóstico</Button>
          </div>
        </Card>
        <Modal isOpen={showRestartConfirm} title="Reiniciar diagnóstico?" onClose={() => setShowRestartConfirm(false)}>
          <p>
            Isso inicia uma nova tentativa do zero. Sua tentativa em andamento fica guardada no histórico,
            mas não será usada.
          </p>
          <div className="diagnostic__actions">
            <Button variant="secondary" onClick={() => setShowRestartConfirm(false)}>
              Cancelar
            </Button>
            <Button onClick={() => void beginAttempt(true)} isLoading={isSubmitting}>
              Reiniciar
            </Button>
          </div>
        </Modal>
      </div>
    );
  }

  if (phase === "completed_prompt") {
    return (
      <div className="diagnostic diagnostic--centered">
        <Card className="diagnostic__card">
          <h1>Você já concluiu o diagnóstico</h1>
          <p>Você pode ver o resultado técnico provisório ou refazer o diagnóstico do zero.</p>
          <div className="diagnostic__actions">
            <Button variant="secondary" onClick={() => setShowRestartConfirm(true)}>
              Refazer diagnóstico
            </Button>
            <Button onClick={() => void viewResult(completedAttemptSummary!.id)}>Ver resultado</Button>
          </div>
        </Card>
        <Modal isOpen={showRestartConfirm} title="Refazer diagnóstico?" onClose={() => setShowRestartConfirm(false)}>
          <p>Isso inicia uma nova tentativa do zero. O resultado anterior continua guardado no histórico.</p>
          <div className="diagnostic__actions">
            <Button variant="secondary" onClick={() => setShowRestartConfirm(false)}>
              Cancelar
            </Button>
            <Button onClick={() => void beginAttempt(true)} isLoading={isSubmitting}>
              Refazer
            </Button>
          </div>
        </Modal>
      </div>
    );
  }

  if (phase === "result" && result) {
    return (
      <div className="diagnostic diagnostic--centered">
        <Card className="diagnostic__card">
          <ProvisionalContentNotice />
          <h1>Resultado técnico provisório</h1>
          <Alert variant="info">{result.disclaimer}</Alert>
          <ul className="diagnostic__result-list">
            <li>
              Questões respondidas: <strong>{result.answeredCount}</strong> de {result.totalQuestions}
            </li>
            <li>
              Acertos brutos: <strong>{result.correctCount}</strong>
            </li>
            <li>
              Marcadas como "não sei por onde começar": <strong>{result.dontKnowCount}</strong>
            </li>
            <li>
              Tempo total aproximado: <strong>{Math.round(result.totalTimeMs / 1000)} s</strong> — média
              aproximada de <strong>{Math.round(result.averageTimeMs / 1000)} s</strong> por questão
            </li>
            <li>
              Ajudas abertas por camada:{" "}
              <strong>
                {Object.entries(result.helpOpensByLayer)
                  .map(([layer, count]) => `Camada ${layer}: ${count}`)
                  .join(" · ")}
              </strong>
            </li>
            {result.recognitionConfiguredCount > 0 && (
              <li>
                Reconhecimentos informados: <strong>{result.recognitionInformedCount}</strong> de{" "}
                {result.recognitionConfiguredCount} questões com essa pergunta configurada (
                {result.recognitionCorrectCount} coincidiram com o padrão esperado)
              </li>
            )}
          </ul>
          <Button onClick={() => navigate("/")}>Voltar ao início</Button>
        </Card>
      </div>
    );
  }

  if (phase === "question" && attempt) {
    const question = attempt.questions[currentIndex];
    const isLast = currentIndex === attempt.questions.length - 1;
    const canAdvance = isDontKnow || Boolean(selectedOptionId);
    const progressPercent = Math.round((currentIndex / attempt.questions.length) * 100);

    return (
      <div className="diagnostic">
        <div className="diagnostic__body">
          <Card className="diagnostic__card diagnostic__card--wide">
            <ProvisionalContentNotice />
            <div className="diagnostic__progress">
              <ProgressBar label={`Questão ${currentIndex + 1} de ${attempt.questions.length}`} value={progressPercent} />
            </div>

            <div
              className={`diagnostic__save-indicator diagnostic__save-indicator--${saveState}`}
              role="status"
              aria-live="polite"
            >
              {saveState === "saving" && "Salvando…"}
              {saveState === "saved" && "Salvo"}
              {saveState === "error" && "Não foi possível salvar. Tente novamente."}
            </div>

            {question.hasRecognition && (
              <fieldset className="diagnostic__fieldset">
                <legend className="diagnostic__legend">
                  Antes de resolver: qual padrão ou estratégia você reconhece aqui? (opcional)
                </legend>
                <div className="diagnostic__option-group">
                  {question.recognitionOptions.map((option) => (
                    <label key={option.id} className="diagnostic__option">
                      <input
                        type="radio"
                        name="recognition"
                        checked={recognitionOptionId === option.id}
                        onChange={() => setRecognitionOptionId(option.id)}
                      />
                      {option.text}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            <h1 className="diagnostic__question-prompt" ref={headingRef} tabIndex={-1}>
              {question.prompt}
            </h1>

            <fieldset className="diagnostic__fieldset">
              <legend className="visually-hidden">Alternativas</legend>
              <div className="diagnostic__option-group">
                {question.options.map((option) => (
                  <label key={option.id} className="diagnostic__option">
                    <input
                      type="radio"
                      name="answer"
                      checked={selectedOptionId === option.id}
                      disabled={isDontKnow}
                      onChange={() => {
                        setSelectedOptionId(option.id);
                        setIsDontKnow(false);
                      }}
                    />
                    {option.text}
                  </label>
                ))}
              </div>
            </fieldset>

            <label className="diagnostic__dont-know">
              <input
                type="checkbox"
                checked={isDontKnow}
                onChange={(event) => {
                  setIsDontKnow(event.target.checked);
                  if (event.target.checked) setSelectedOptionId(null);
                }}
              />
              Não sei por onde começar
            </label>

            {question.helpLayersAvailable.length > 0 && (
              <div className="diagnostic__help-panel">
                <p className="diagnostic__help-panel-title">Precisa de uma ajuda?</p>
                <div className="diagnostic__help-buttons">
                  {question.helpLayersAvailable.map((layer) => {
                    const previousOpened = layer === 1 || openedHelpContent[layer - 1] !== undefined;
                    return (
                      <Button
                        key={layer}
                        type="button"
                        variant="secondary"
                        disabled={!previousOpened || openedHelpContent[layer] !== undefined}
                        onClick={() => void handleOpenHelp(layer)}
                      >
                        {HELP_LAYER_LABELS[layer] ?? `Camada ${layer}`}
                      </Button>
                    );
                  })}
                </div>
                {Object.entries(openedHelpContent)
                  .sort(([a], [b]) => Number(a) - Number(b))
                  .map(([layer, content]) => (
                    <p key={layer} className="diagnostic__help-content">
                      <strong>{HELP_LAYER_LABELS[Number(layer)] ?? `Camada ${layer}`}:</strong> {content}
                    </p>
                  ))}
              </div>
            )}

            <div className="diagnostic__actions">
              <Button type="button" variant="secondary" onClick={handleBack} disabled={currentIndex === 0}>
                Voltar
              </Button>
              <Button type="button" variant="text" onClick={() => setShowLeaveConfirm(true)}>
                Sair por agora
              </Button>
              <Button type="button" onClick={() => void handleAdvance()} disabled={!canAdvance} isLoading={isSubmitting}>
                {isLast ? "Concluir diagnóstico" : "Avançar"}
              </Button>
            </div>
          </Card>
        </div>

        <Modal isOpen={showLeaveConfirm} title="Sair do diagnóstico?" onClose={() => setShowLeaveConfirm(false)}>
          <p>Suas respostas já salvas continuam guardadas. Você pode continuar de onde parou quando quiser.</p>
          <div className="diagnostic__actions">
            <Button variant="secondary" onClick={() => setShowLeaveConfirm(false)}>
              Continuar aqui
            </Button>
            <Button onClick={handleLeave}>Sair</Button>
          </div>
        </Modal>
      </div>
    );
  }

  return null;
}
