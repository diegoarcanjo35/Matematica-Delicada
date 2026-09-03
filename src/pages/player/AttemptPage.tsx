import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { ErrorState } from "../../components/ErrorState";
import { LoadingState } from "../../components/LoadingState";
import { Modal } from "../../components/Modal";
import { fetchPatterns, type PatternSummary } from "../../api/patternsClient";
import {
  confirmAnswer,
  fetchAttempt,
  openHelpLayer,
  PlayerApiError,
  removeBookmark,
  reportProblem,
  saveAnswer,
  saveBookmark,
  saveRecognition,
  type AttemptState,
  type ProblemReportCategory,
} from "../../api/playerClient";
import "./PlayerPage.css";

/* Tela da tentativa — /tentativas/:attemptId (Sprint 8 v1.1, seção 12 da
   ordem). Uma ÚNICA página com fases derivadas do estado real da tentativa
   (nunca um estado local que possa divergir do servidor): reconhecimento
   (modo recognition, ainda não salvo) → questão em andamento (alternativas,
   ajuda progressiva) → feedback (depois de confirmada). Retomada após
   refresh é o MESMO carregamento inicial — o servidor já devolve tudo
   (resposta não confirmada, camadas abertas, reconhecimento salvo). */

const HELP_LAYER_LABELS: Record<number, string> = {
  1: "Pista leve",
  2: "Reconheça o padrão",
  3: "Estratégia",
  4: "Resolução comentada",
};

const MODE_LABELS: Record<string, string> = {
  learning: "Aprendizagem",
  practice: "Prática",
  recognition: "Reconhecimento",
};

/* Sprint 9 v1.0 (seção 4.5/13.1 da ordem) — o Player continua persistindo
   `mode = "practice"` tecnicamente numa tentativa de revisão do Caderno de
   Erros (nenhum novo valor de `mode` foi criado). `errorEntryId` não-nulo
   é o único sinal usado aqui para apresentar a tela como "Revisão" em vez
   do rótulo técnico "Prática" — ver docs/CADERNO_ERROS_REVISAO.md. */
function modeLabel(attempt: AttemptState): string {
  if (attempt.errorEntryId) return "Revisão";
  return MODE_LABELS[attempt.mode] ?? attempt.mode;
}

const REPORT_CATEGORY_LABELS: Record<ProblemReportCategory, string> = {
  statement_problem: "Problema no enunciado",
  alternative_problem: "Problema numa alternativa",
  answer_key_problem: "Gabarito parece errado",
  image_problem: "Problema na imagem",
  accessibility_problem: "Problema de acessibilidade",
  other: "Outro",
};

function ProvisionalContentNotice() {
  return (
    <p className="player__provisional-notice" role="note">
      CONTEÚDO TÉCNICO PROVISÓRIO — NÃO PUBLICAR. Esta questão é uma fixture local de
      desenvolvimento, não o banco pedagógico aprovado da Andreia.
    </p>
  );
}

function formatElapsed(startedAt: string): string {
  const startMs = new Date(startedAt).getTime();
  if (Number.isNaN(startMs)) return "tempo indisponível";
  const minutes = Math.max(0, Math.floor((Date.now() - startMs) / 60000));
  if (minutes < 1) return "menos de 1 minuto";
  return `aproximadamente ${minutes} ${minutes === 1 ? "minuto" : "minutos"}`;
}

export function AttemptPage() {
  const { attemptId } = useParams<{ attemptId: string }>();
  const [phase, setPhase] = useState<"loading" | "ready" | "unavailable" | "notFound" | "error">("loading");
  const [attempt, setAttempt] = useState<AttemptState | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Reconhecimento (rascunho local até salvar).
  const [patterns, setPatterns] = useState<PatternSummary[]>([]);
  const [recognitionPatternSlug, setRecognitionPatternSlug] = useState("");
  const [recognitionClue, setRecognitionClue] = useState("");
  const [recognitionStrategy, setRecognitionStrategy] = useState("");

  // Resposta (rascunho local até confirmar).
  const [selectedAlternative, setSelectedAlternative] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [isConfirming, setIsConfirming] = useState(false);
  const [showResolutionConfirm, setShowResolutionConfirm] = useState(false);
  const [pendingHelpLayer, setPendingHelpLayer] = useState<number | null>(null);

  // Salvar para revisão / denunciar.
  const [bookmarkSaved, setBookmarkSaved] = useState(false);
  const [bookmarkMessage, setBookmarkMessage] = useState<string | null>(null);
  const [showReportModal, setShowReportModal] = useState(false);
  const [reportCategory, setReportCategory] = useState<ProblemReportCategory>("statement_problem");
  const [reportComment, setReportComment] = useState("");
  const [reportSubmitted, setReportSubmitted] = useState(false);

  const [, forceElapsedTick] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async () => {
    if (!attemptId) {
      setPhase("notFound");
      return;
    }
    setPhase("loading");
    try {
      const result = await fetchAttempt(attemptId);
      // Mesma ressalva de QuestionStartPage.tsx: sucesso nunca inclui
      // `available` — só o gate fechado devolve `false` explicitamente.
      if (result.available === false) {
        setPhase("unavailable");
        return;
      }
      if (!result.attempt) {
        setPhase("notFound");
        return;
      }
      setAttempt(result.attempt);
      setSelectedAlternative(result.attempt.selectedAlternative);
      // Sprint 8 v1.2 — correção B: o bookmark agora vem do servidor a cada
      // carregamento (refresh/remontagem inclusive), nunca mais um estado
      // local que sempre começava "não salvo".
      setBookmarkSaved(result.attempt.isBookmarked);
      setPhase("ready");
    } catch (error) {
      if (error instanceof PlayerApiError && error.status === 404) {
        setPhase("notFound");
        return;
      }
      setErrorMessage("Não foi possível carregar a tentativa. Tente novamente.");
      setPhase("error");
    }
  }, [attemptId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Lista de padrões publicados, só para o seletor de reconhecimento —
  // leitura pura, mesmo endpoint GET já usado pelo catálogo (Sprint 6).
  useEffect(() => {
    if (attempt?.mode !== "recognition" || attempt.recognitionSaved) return;
    let cancelled = false;
    fetchPatterns({ limite: 50 })
      .then((result) => {
        if (!cancelled && result.available && result.patterns) setPatterns(result.patterns);
      })
      .catch(() => {
        // Sem catálogo disponível — o seletor fica vazio; o aluno ainda pode
        // digitar pista/estratégia, mas não consegue salvar sem um padrão.
      });
    return () => {
      cancelled = true;
    };
  }, [attempt?.mode, attempt?.recognitionSaved]);

  useEffect(() => {
    headingRef.current?.focus();
  }, [phase, attempt?.status, attempt?.recognitionSaved]);

  // Tempo decorrido aproximado, atualizado a cada 30s — nunca um cronômetro
  // avaliativo (seção 12: "não deve pressionar aluno nem ser apresentado
  // como cronômetro avaliativo").
  useEffect(() => {
    if (attempt?.status !== "in_progress") return;
    const interval = setInterval(() => forceElapsedTick((n) => n + 1), 30_000);
    return () => clearInterval(interval);
  }, [attempt?.status]);

  // Estado do bookmark não vem no payload da tentativa (é por questão, não
  // por tentativa, e a lista de 9 endpoints não inclui um GET de leitura
  // dedicado) — inferido só pela última ação do próprio aluno nesta sessão;
  // o botão começa "não salvo" a cada carregamento, refletindo o estado
  // conhecido localmente, nunca uma suposição sobre o servidor.

  async function handleSaveRecognition() {
    if (!attempt || !recognitionPatternSlug) return;
    setSaveState("saving");
    try {
      await saveRecognition(attempt.id, attempt.version, {
        patternSlug: recognitionPatternSlug,
        clue: recognitionClue,
        strategy: recognitionStrategy,
      });
      setSaveState("saved");
      await load();
    } catch {
      setSaveState("error");
    }
  }

  async function handleSelectAlternative(letter: string) {
    if (!attempt) return;
    setSelectedAlternative(letter);
    setSaveState("saving");
    try {
      await saveAnswer(attempt.id, attempt.version, letter);
      setSaveState("saved");
      await load();
    } catch {
      setSaveState("error");
    }
  }

  async function handleConfirm() {
    if (!attempt) return;
    setIsConfirming(true);
    try {
      const result = await confirmAnswer(attempt.id, attempt.version);
      if (result.attempt) applyResultAttempt(result.attempt);
    } catch {
      setErrorMessage("Não foi possível confirmar a resposta. Tente novamente.");
    } finally {
      setIsConfirming(false);
    }
  }

  function applyResultAttempt(next: AttemptState) {
    setAttempt(next);
    setSelectedAlternative(next.selectedAlternative);
    setBookmarkSaved(next.isBookmarked);
  }

  async function handleOpenHelp(layer: number, confirmViewResolution = false) {
    if (!attempt) return;
    if (layer === 4 && !confirmViewResolution) {
      setPendingHelpLayer(layer);
      setShowResolutionConfirm(true);
      return;
    }
    try {
      const result = await openHelpLayer(attempt.id, attempt.version, layer, confirmViewResolution);
      if (result.attempt) applyResultAttempt(result.attempt);
    } catch {
      setErrorMessage("Não foi possível abrir esta camada de ajuda agora.");
    }
  }

  async function handleToggleBookmark() {
    if (!attempt) return;
    try {
      if (bookmarkSaved) {
        await removeBookmark(attempt.questionId);
        setBookmarkSaved(false);
        setBookmarkMessage("Removido da lista de revisão.");
      } else {
        await saveBookmark(attempt.questionId);
        setBookmarkSaved(true);
        setBookmarkMessage("Salvo para revisar depois.");
      }
    } catch {
      setBookmarkMessage("Não foi possível atualizar a lista de revisão.");
    }
  }

  async function handleSubmitReport() {
    if (!attempt) return;
    try {
      await reportProblem(attempt.questionId, reportCategory, reportComment.trim() || null, attempt.id);
      setReportSubmitted(true);
    } catch {
      setErrorMessage("Não foi possível enviar a denúncia agora.");
    }
  }

  if (phase === "loading") return <LoadingState label="Carregando a tentativa…" />;

  if (phase === "unavailable") {
    return (
      <div className="player player--centered">
        <Card className="player__card">
          <h1 ref={headingRef} tabIndex={-1}>
            Ainda não há questões disponíveis
          </h1>
          <p>O Player de Questão já está pronto tecnicamente, mas nenhuma questão está disponível para praticar neste ambiente agora.</p>
        </Card>
      </div>
    );
  }

  if (phase === "notFound") {
    return (
      <div className="player player--centered">
        <Card className="player__card">
          <h1 ref={headingRef} tabIndex={-1}>
            Tentativa não encontrada
          </h1>
          <p>Esta tentativa não existe ou não pertence a você.</p>
        </Card>
      </div>
    );
  }

  if (phase === "error" || !attempt) {
    return <ErrorState description={errorMessage ?? "Não foi possível carregar a tentativa."} action={<Button onClick={() => void load()}>Tentar novamente</Button>} />;
  }

  const needsRecognitionFirst = attempt.mode === "recognition" && !attempt.recognitionSaved && attempt.status === "in_progress";

  // -------------------------- Feedback (depois de confirmar) --------------------------
  if (attempt.status === "completed" && attempt.feedback) {
    const feedback = attempt.feedback;
    return (
      <div className="player">
        <Card className="player__card">
          <ProvisionalContentNotice />
          <h1 ref={headingRef} tabIndex={-1} className="player__heading">
            Resultado
          </h1>

          <div
            className={`player__feedback-banner ${feedback.isCorrect ? "player__feedback-banner--correct" : "player__feedback-banner--incorrect"}`}
            role="status"
          >
            {feedback.isCorrect ? "Resposta correta!" : "Resposta incorreta."} Você escolheu {feedback.selectedAlternative}; a
            alternativa correta é {feedback.correctAlternative}.
          </div>

          {feedback.correctExplanation && (
            <p>
              <strong>Por que a alternativa {feedback.correctAlternative} está correta: </strong>
              {feedback.correctExplanation}
            </p>
          )}

          {feedback.distractorExplanations.length > 0 && (
            <div className="player__dna-section">
              <h2>Por que as outras alternativas não servem</h2>
              <ul className="player__distractor-list">
                {feedback.distractorExplanations.map((d) => (
                  <li key={d.letter}>
                    <strong>{d.letter}:</strong> {d.explanation}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {feedback.dna && (
            <div className="player__dna-section">
              <h2>DNA da questão</h2>
              {feedback.principalPattern && (
                <p>
                  <strong>Padrão principal: </strong>
                  <Link to={`/padroes-enem/${feedback.principalPattern.slug}`}>{feedback.principalPattern.name}</Link>
                </p>
              )}
              <p>
                <strong>Pista: </strong>
                {feedback.dna.pista}
              </p>
              <p>
                <strong>Estratégia: </strong>
                {feedback.dna.estrategia}
              </p>
              <p>
                <strong>Pegadinha: </strong>
                {feedback.dna.pegadinha}
              </p>
              <p>
                <strong>Conteúdo de apoio: </strong>
                {feedback.dna.conteudoApoio}
              </p>
              <p>
                <strong>Resolução: </strong>
                {feedback.dna.resolucao}
              </p>
              {feedback.dna.atalho && (
                <p>
                  <strong>Atalho/macete: </strong>
                  {feedback.dna.atalho}
                </p>
              )}
              <p>
                <strong>Aprendizado do erro: </strong>
                {feedback.dna.aprendizadoErro}
              </p>
            </div>
          )}

          {!feedback.isCorrect && (
            <p className="player__objective" role="note">
              Este erro vai alimentar o futuro Caderno de Erros — ainda não existe uma classificação
              pedagógica definitiva nesta sprint, só o registro técnico bruto já foi salvo.
            </p>
          )}

          <p className="player__objective">Próximo passo: em preparação.</p>

          <div className="player__actions">
            <div className="player__secondary-actions">
              <Button type="button" variant="secondary" onClick={() => void handleToggleBookmark()}>
                {bookmarkSaved ? "Remover da revisão" : "Salvar para revisar"}
              </Button>
              <Button type="button" variant="secondary" onClick={() => setShowReportModal(true)}>
                Denunciar problema
              </Button>
            </div>
            {attempt.errorEntryId ? (
              <Link to={`/caderno-de-erros/${attempt.errorEntryId}`} className="btn btn--primary">
                <span>Voltar ao Caderno de Erros</span>
              </Link>
            ) : (
              <Link to="/" className="btn btn--primary">
                <span>Voltar ao início</span>
              </Link>
            )}
          </div>
          <div role="status" aria-live="polite">
            {bookmarkMessage}
          </div>
        </Card>

        {renderReportModal()}
      </div>
    );
  }

  // -------------------------- Reconhecimento --------------------------
  if (needsRecognitionFirst) {
    return (
      <div className="player">
        <Card className="player__card">
          <ProvisionalContentNotice />
          <header className="player__header">
            <span className="player__mode-badge">{modeLabel(attempt)}</span>
            <span className="player__elapsed">Tempo decorrido: {formatElapsed(attempt.startedAt)}</span>
          </header>

          <h1 ref={headingRef} tabIndex={-1} className="player__question-prompt">
            {attempt.question.enunciado}
          </h1>

          {attempt.question.imagens.map((image) => (
            <img key={image.id} className="player__image" src={image.assetRef} alt={image.altText} />
          ))}

          <div role="status" aria-live="polite" className={`player__save-indicator${saveState === "error" ? " player__save-indicator--error" : ""}`}>
            {saveState === "saving" && "Salvando…"}
            {saveState === "saved" && "Reconhecimento salvo."}
            {saveState === "error" && "Não foi possível salvar. Tente novamente."}
          </div>

          <div className="player__fieldset">
            <label className="player__field-label" htmlFor="recognition-pattern">
              Qual padrão você reconhece nesta questão?
            </label>
            <select
              id="recognition-pattern"
              className="player__select"
              value={recognitionPatternSlug}
              onChange={(event) => setRecognitionPatternSlug(event.target.value)}
            >
              <option value="">Selecione um padrão</option>
              {patterns.map((pattern) => (
                <option key={pattern.slug} value={pattern.slug}>
                  {pattern.name}
                </option>
              ))}
            </select>

            <label className="player__field-label" htmlFor="recognition-clue">
              Qual pista levou você a essa escolha?
            </label>
            <textarea
              id="recognition-clue"
              className="player__textarea"
              value={recognitionClue}
              onChange={(event) => setRecognitionClue(event.target.value)}
              maxLength={300}
            />

            <label className="player__field-label" htmlFor="recognition-strategy">
              Qual estratégia parece mais adequada?
            </label>
            <textarea
              id="recognition-strategy"
              className="player__textarea"
              value={recognitionStrategy}
              onChange={(event) => setRecognitionStrategy(event.target.value)}
              maxLength={300}
            />
          </div>

          <div className="player__actions">
            <span />
            <Button type="button" onClick={() => void handleSaveRecognition()} disabled={!recognitionPatternSlug} isLoading={saveState === "saving"}>
              Salvar e continuar
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  // -------------------------- Questão em andamento --------------------------
  const nextLayer = attempt.highestHelpLayer + 1;

  return (
    <div className="player">
      <Card className="player__card">
        <ProvisionalContentNotice />
        <header className="player__header">
          <span className="player__mode-badge">{modeLabel(attempt)}</span>
          <span>{attempt.selectedAlternative ? "Resposta selecionada" : "Aguardando resposta"}</span>
          <span className="player__elapsed">Tempo decorrido: {formatElapsed(attempt.startedAt)}</span>
        </header>

        <h1 ref={headingRef} tabIndex={-1} className="player__question-prompt">
          {attempt.question.enunciado}
        </h1>

        {attempt.question.imagens.map((image) => (
          <img key={image.id} className="player__image" src={image.assetRef} alt={image.altText} />
        ))}

        <div role="status" aria-live="polite" className={`player__save-indicator${saveState === "error" ? " player__save-indicator--error" : ""}`}>
          {saveState === "saving" && "Salvando…"}
          {saveState === "saved" && "Salvo"}
          {saveState === "error" && "Não foi possível salvar. Tente novamente."}
        </div>

        <fieldset className="player__fieldset">
          <legend className="player__legend">Alternativas</legend>
          <div className="player__option-group">
            {attempt.question.alternativas.map((alt) => (
              <label key={alt.letter} className="player__option">
                <input
                  type="radio"
                  name="alternativa"
                  checked={selectedAlternative === alt.letter}
                  onChange={() => void handleSelectAlternative(alt.letter)}
                />
                <span>
                  <strong>{alt.letter}) </strong>
                  {alt.text}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {attempt.highestHelpLayer === 0 && (
          <button type="button" className="player__dont-know" onClick={() => void handleOpenHelp(1)}>
            Não sei por onde começar
          </button>
        )}

        <div className="player__help-panel">
          <p className="player__help-panel-title">Ajuda progressiva</p>
          <div className="player__help-buttons">
            {[1, 2, 3, 4].map((layer) => (
              <Button
                key={layer}
                type="button"
                variant="secondary"
                disabled={layer > nextLayer}
                onClick={() => void handleOpenHelp(layer)}
              >
                {HELP_LAYER_LABELS[layer]}
              </Button>
            ))}
          </div>
          {[1, 2, 3, 4]
            .filter((layer) => attempt.helpContent[String(layer)] !== undefined)
            .map((layer) => (
              <p key={layer} className="player__help-content">
                <strong>{HELP_LAYER_LABELS[layer]}:</strong> {attempt.helpContent[String(layer)]}
              </p>
            ))}
        </div>

        <div className="player__actions">
          <div className="player__secondary-actions">
            <Button type="button" variant="secondary" onClick={() => void handleToggleBookmark()}>
              {bookmarkSaved ? "Remover da revisão" : "Salvar para revisar"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setShowReportModal(true)}>
              Denunciar problema
            </Button>
          </div>
          <Button type="button" onClick={() => void handleConfirm()} disabled={!selectedAlternative} isLoading={isConfirming}>
            Confirmar resposta
          </Button>
        </div>
        <div role="status" aria-live="polite">
          {bookmarkMessage}
        </div>
      </Card>

      <Modal
        isOpen={showResolutionConfirm}
        title="Ver a resolução comentada?"
        onClose={() => {
          setShowResolutionConfirm(false);
          setPendingHelpLayer(null);
        }}
      >
        <p>
          A resolução comentada mostra o caminho completo da solução. Depois de vê-la, você ainda
          pode confirmar sua resposta normalmente.
        </p>
        <Button
          type="button"
          onClick={() => {
            setShowResolutionConfirm(false);
            if (pendingHelpLayer) void handleOpenHelp(pendingHelpLayer, true);
            setPendingHelpLayer(null);
          }}
        >
          Ver resolução
        </Button>
      </Modal>

      {renderReportModal()}
    </div>
  );

  function renderReportModal() {
    return (
      <Modal
        isOpen={showReportModal}
        title="Denunciar problema nesta questão"
        onClose={() => {
          setShowReportModal(false);
          setReportSubmitted(false);
        }}
      >
        {reportSubmitted ? (
          <p role="status">Obrigada por avisar — sua denúncia foi registrada.</p>
        ) : (
          <>
            <label className="player__field-label" htmlFor="report-category">
              Categoria
            </label>
            <select
              id="report-category"
              className="player__select"
              value={reportCategory}
              onChange={(event) => setReportCategory(event.target.value as ProblemReportCategory)}
            >
              {Object.entries(REPORT_CATEGORY_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <label className="player__field-label" htmlFor="report-comment">
              Comentário (opcional)
            </label>
            <textarea
              id="report-comment"
              className="player__textarea"
              value={reportComment}
              onChange={(event) => setReportComment(event.target.value)}
              maxLength={500}
            />
            <Button type="button" onClick={() => void handleSubmitReport()}>
              Enviar denúncia
            </Button>
          </>
        )}
      </Modal>
    );
  }
}
