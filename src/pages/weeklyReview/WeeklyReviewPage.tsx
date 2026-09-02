import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { LoadingState } from "../../components/LoadingState";
import { ProgressBar } from "../../components/ProgressBar";
import {
  WeeklyReviewApiError,
  abandonGoal,
  applyGoal,
  completeGoal,
  fetchCurrentReport,
  fetchGoalPreview,
  fetchHistory,
  fetchReportForWeek,
  patchGoal,
  type Goal,
  type GoalSuggestion,
  type WeeklyHistoryEntry,
  type WeeklyReport,
} from "../../api/weeklyReviewClient";
import "./WeeklyReview.css";

/* Tela /relatorio-semanal — Sprint 13 v1.0, seção 11 da ordem. Estados
   mínimos exigidos: carregando; erro com tentativa novamente; semana sem
   evidência; relatório com evidências; comparação indisponível; preview de
   meta; meta ainda não aplicada; aplicando/salvando; meta ativa; conflito
   de versão; meta concluída; meta abandonada; histórico semanal.

   Explica sempre que os dados são factuais e não constituem nota/TRI
   (seção 11: "explicar que os dados são factuais"). Nunca usa linguagem
   avaliativa ("fraco"/"excelente"/"atrasado"/"dominado") — só fatos e
   diferenças factuais (seção 4.2). */

const WEEKDAY_LABELS: Record<string, string> = {
  dom: "Domingo",
  seg: "Segunda",
  ter: "Terça",
  qua: "Quarta",
  qui: "Quinta",
  sex: "Sexta",
  sab: "Sábado",
};
const WEEKDAY_ORDER = ["seg", "ter", "qua", "qui", "sex", "sab", "dom"];

function formatDate(civilDate: string): string {
  const [year, month, day] = civilDate.split("-");
  return `${day}/${month}/${year}`;
}

function formatMinutes(minutes: number | null): string {
  return minutes === null ? "sem evidência suficiente" : `aproximadamente ${minutes} min`;
}

function formatDelta(value: number, unit: string): string {
  if (value === 0) return `mesma quantidade de ${unit}`;
  const abs = Math.abs(value);
  return value > 0 ? `${abs} ${unit} a mais` : `${abs} ${unit} a menos`;
}

type ReviewPhase = "loading" | "error" | "ready";

export function WeeklyReviewPage() {
  const [phase, setPhase] = useState<ReviewPhase>("loading");
  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [history, setHistory] = useState<WeeklyHistoryEntry[] | null>(null);
  const [selectedWeekStart, setSelectedWeekStart] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const loadReport = useCallback(async (weekStart: string | null) => {
    setPhase("loading");
    try {
      const result = weekStart ? await fetchReportForWeek(weekStart) : await fetchCurrentReport();
      setReport(result.report);
      setSelectedWeekStart(result.report.weekStart);
      setPhase("ready");
    } catch {
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadReport(null);
  }, [loadReport]);

  useEffect(() => {
    let cancelled = false;
    fetchHistory()
      .then((result) => {
        if (!cancelled) setHistory(result.weeks);
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (phase === "ready" && headingRef.current) headingRef.current.focus();
  }, [phase, report?.weekStart]);

  function handleGoalChanged(updatedReport: WeeklyReport) {
    setReport(updatedReport);
  }

  if (phase === "loading") {
    return <LoadingState label="Carregando seu relatório semanal…" />;
  }

  if (phase === "error" || !report) {
    return (
      <ErrorState
        description="Não foi possível carregar o relatório semanal agora."
        action={<Button onClick={() => void loadReport(selectedWeekStart)}>Tentar novamente</Button>}
      />
    );
  }

  return (
    <div className="weekly-review">
      <header className="weekly-review__header">
        <h1 ref={headingRef} tabIndex={-1}>
          Relatório semanal
        </h1>
        <p className="weekly-review__disclaimer">
          Estes dados são <strong>factuais</strong> — contagens reais do que você já praticou. Nunca é uma nota, TRI, ranking
          ou previsão de aprovação.
        </p>
      </header>

      {history && history.length > 1 && (
        <div className="weekly-review__week-selector">
          <label htmlFor="week-select">Semana</label>
          <select
            id="week-select"
            value={report.weekStart}
            onChange={(event) => void loadReport(event.target.value)}
          >
            {history.map((entry) => (
              <option key={entry.weekStart} value={entry.weekStart}>
                {formatDate(entry.weekStart)} a {formatDate(entry.weekEnd)}
                {entry.isCurrentWeek ? " (semana atual)" : ""}
              </option>
            ))}
          </select>
        </div>
      )}

      <ReportSection report={report} />
      <ComparisonSection report={report} />
      <GoalSection report={report} onGoalChanged={handleGoalChanged} onReload={() => void loadReport(report.weekStart)} />

      <nav className="weekly-review__footer-nav" aria-label="Outras áreas">
        <Link to="/">Dashboard</Link>
        <Link to="/mapa-enem">Mapa ENEM</Link>
        <Link to="/caderno-de-erros">Caderno de Erros</Link>
      </nav>
    </div>
  );
}

/* ------------------------------------- Relatório ------------------------------------- */

function ReportSection({ report }: { report: WeeklyReport }) {
  return (
    <Card className="weekly-review__report-card">
      <h2>
        Semana de {formatDate(report.weekStart)} a {formatDate(report.weekEnd)}
        {report.isCurrentWeek ? " (em andamento)" : ""}
      </h2>

      {!report.hasAnyEvidence ? (
        <EmptyState
          title="Ainda não há evidências suficientes nesta semana"
          description="Assim que você praticar questões, treinar ou revisar, os fatos aparecem aqui automaticamente. Ausência de evidência nunca significa desempenho baixo."
        />
      ) : (
        <div className="weekly-review__facts" data-testid="weekly-review-facts">
          <p className="weekly-review__fact">
            Tempo de estudo: <strong>{formatMinutes(report.approxMinutes)}</strong>
          </p>
          <p className="weekly-review__fact">
            Questões confirmadas: <strong>{report.confirmedQuestionsCount}</strong> ({report.distinctQuestionsCount} distintas)
          </p>
          <p className="weekly-review__fact">
            Acertos e erros (prática comum): <strong>{report.correctCount}</strong> acertos, <strong>{report.incorrectCount}</strong> erros
          </p>
          {report.reviewsCompletedCount > 0 && (
            <p className="weekly-review__fact">
              Revisões do Caderno de Erros concluídas: <strong>{report.reviewsCompletedCount}</strong> ({report.reviewsCorrectCount} corretas,{" "}
              {report.reviewsIncorrectCount} incorretas)
            </p>
          )}
          {report.dailyTrainingItemsCompleted > 0 && (
            <p className="weekly-review__fact">Itens do Treino Diário concluídos: <strong>{report.dailyTrainingItemsCompleted}</strong></p>
          )}
          {report.simulationBlocksCompleted > 0 && (
            <p className="weekly-review__fact">Blocos de Simulado concluídos: <strong>{report.simulationBlocksCompleted}</strong></p>
          )}
          {(report.scheduleCompletedCount > 0 || report.scheduleRescheduledCount > 0) && (
            <p className="weekly-review__fact">
              Cronograma: <strong>{report.scheduleCompletedCount}</strong> concluídas, <strong>{report.scheduleRescheduledCount}</strong> reagendadas
            </p>
          )}
          {report.errorNotebookEntriesCreated > 0 && (
            <p className="weekly-review__fact">Novas entradas no Caderno de Erros: <strong>{report.errorNotebookEntriesCreated}</strong></p>
          )}
          {report.helpLayersOpenedCount > 0 && (
            <p className="weekly-review__fact">Camadas de ajuda abertas: <strong>{report.helpLayersOpenedCount}</strong></p>
          )}
          <p className="weekly-review__fact">
            Dias com alguma evidência real de estudo: <strong>{report.daysWithEvidenceCount}</strong> de 7
          </p>
          {report.overdueReviewsAtWeekEnd !== null && (
            <p className="weekly-review__fact">
              Revisões vencidas até o momento: <strong>{report.overdueReviewsAtWeekEnd}</strong>
            </p>
          )}
          {report.patternsPracticed.length > 0 && (
            <section aria-labelledby="patterns-practiced-heading" className="weekly-review__patterns" data-testid="weekly-review-patterns">
              <h3 id="patterns-practiced-heading">Padrões praticados</h3>
              <ul>
                {report.patternsPracticed.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------- Comparação ------------------------------------- */

function ComparisonSection({ report }: { report: WeeklyReport }) {
  const { comparison } = report;
  return (
    <Card className="weekly-review__comparison-card" data-testid="weekly-review-comparison">
      <h2>Comparação com a semana anterior</h2>
      {!comparison.available || !comparison.deltas ? (
        <p className="weekly-review__message">
          Comparação indisponível — uma das duas semanas ainda não tem evidência suficiente para comparar.
        </p>
      ) : (
        <ul className="weekly-review__comparison-list">
          <li>{formatDelta(comparison.deltas.confirmedQuestionsCount, "questões confirmadas")}</li>
          <li>{formatDelta(comparison.deltas.daysWithEvidenceCount, "dias com atividade")}</li>
          <li>{formatDelta(comparison.deltas.correctCount, "acertos")}</li>
          <li>{formatDelta(comparison.deltas.incorrectCount, "erros")}</li>
          {comparison.deltas.approxMinutes !== null && <li>{formatDelta(comparison.deltas.approxMinutes, "minutos de estudo")}</li>}
        </ul>
      )}
    </Card>
  );
}

/* ------------------------------------- Meta ------------------------------------- */

type GoalPhase = "idle" | "previewing" | "editing-preview" | "applying" | "editing-active" | "patching";

function GoalSection({ report, onGoalChanged, onReload }: { report: WeeklyReport; onGoalChanged: (report: WeeklyReport) => void; onReload: () => void }) {
  const [goalPhase, setGoalPhase] = useState<GoalPhase>("idle");
  const [preview, setPreview] = useState<GoalSuggestion | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [minutes, setMinutes] = useState(150);
  const [questions, setQuestions] = useState(30);
  const [days, setDays] = useState<string[]>([]);
  const [selectedPatternIds, setSelectedPatternIds] = useState<string[]>([]);
  const statusHeadingRef = useRef<HTMLHeadingElement>(null);

  const goal = report.goal;

  useEffect(() => {
    if (goalPhase !== "idle" && statusHeadingRef.current) statusHeadingRef.current.focus();
  }, [goalPhase]);

  async function startPreview() {
    setPreviewError(null);
    setGoalPhase("previewing");
    try {
      const result = await fetchGoalPreview(report.weekStart);
      setPreview(result.preview);
      setMinutes(result.preview.suggestedMinutes);
      setQuestions(result.preview.suggestedQuestions);
      setDays(result.preview.availableDays);
      setSelectedPatternIds(result.preview.suggestedPatterns.map((p) => p.patternId));
      setGoalPhase("editing-preview");
    } catch {
      setPreviewError("Não foi possível montar a sugestão de meta agora. Tente novamente.");
      setGoalPhase("idle");
    }
  }

  function toggleDay(day: string) {
    setDays((current) => (current.includes(day) ? current.filter((d) => d !== day) : [...current, day]));
  }

  function togglePattern(patternId: string) {
    setSelectedPatternIds((current) => {
      if (current.includes(patternId)) return current.filter((id) => id !== patternId);
      if (current.length >= 3) return current;
      return [...current, patternId];
    });
  }

  async function handleApply() {
    setFormError(null);
    setGoalPhase("applying");
    try {
      const result = await applyGoal({ weekStart: report.weekStart, targetMinutes: minutes, targetQuestions: questions, availableDays: days, patternIds: selectedPatternIds });
      const refreshed = await (report.isCurrentWeek ? fetchCurrentReportSafe() : fetchReportForWeekSafe(report.weekStart));
      if (refreshed) onGoalChanged(refreshed);
      setGoalPhase("idle");
      void result;
    } catch (error) {
      setGoalPhase("editing-preview");
      if (error instanceof WeeklyReviewApiError && error.status === 409) {
        setFormError("Você já tem uma meta ativa para esta semana. Recarregue para vê-la.");
      } else if (error instanceof WeeklyReviewApiError && Object.keys(error.fields).length > 0) {
        setFormError(Object.values(error.fields)[0]);
      } else {
        setFormError("Não foi possível aplicar a meta agora. Tente novamente.");
      }
    }
  }

  function startEditActive(current: Goal) {
    setMinutes(current.targetMinutes);
    setQuestions(current.targetQuestions);
    setDays(current.availableDays);
    setSelectedPatternIds(current.patterns.map((p) => p.patternId));
    setFormError(null);
    setGoalPhase("editing-active");
  }

  async function handlePatch(current: Goal) {
    setFormError(null);
    setConflict(false);
    setGoalPhase("patching");
    try {
      await patchGoal(current.id, { targetMinutes: minutes, targetQuestions: questions, availableDays: days, patternIds: selectedPatternIds, version: current.version });
      const refreshed = await (report.isCurrentWeek ? fetchCurrentReportSafe() : fetchReportForWeekSafe(report.weekStart));
      if (refreshed) onGoalChanged(refreshed);
      setGoalPhase("idle");
    } catch (error) {
      if (error instanceof WeeklyReviewApiError && error.status === 409) {
        setConflict(true);
        setGoalPhase("idle");
      } else {
        setGoalPhase("editing-active");
        setFormError("Não foi possível salvar as alterações agora. Tente novamente.");
      }
    }
  }

  async function handleComplete(current: Goal) {
    setGoalPhase("patching");
    try {
      await completeGoal(current.id);
      const refreshed = await (report.isCurrentWeek ? fetchCurrentReportSafe() : fetchReportForWeekSafe(report.weekStart));
      if (refreshed) onGoalChanged(refreshed);
    } catch {
      setFormError("Não foi possível concluir a meta agora. Tente novamente.");
    } finally {
      setGoalPhase("idle");
    }
  }

  async function handleAbandon(current: Goal) {
    setGoalPhase("patching");
    try {
      await abandonGoal(current.id);
      const refreshed = await (report.isCurrentWeek ? fetchCurrentReportSafe() : fetchReportForWeekSafe(report.weekStart));
      if (refreshed) onGoalChanged(refreshed);
    } catch {
      setFormError("Não foi possível abandonar a meta agora. Tente novamente.");
    } finally {
      setGoalPhase("idle");
    }
  }

  async function fetchCurrentReportSafe(): Promise<WeeklyReport | null> {
    try {
      return (await fetchCurrentReport()).report;
    } catch {
      return null;
    }
  }
  async function fetchReportForWeekSafe(weekStart: string): Promise<WeeklyReport | null> {
    try {
      return (await fetchReportForWeek(weekStart)).report;
    } catch {
      return null;
    }
  }

  const availablePatterns =
    goalPhase === "editing-preview" && preview
      ? preview.suggestedPatterns.map((p) => ({ patternId: p.patternId, patternName: p.patternName }))
      : goal
        ? goal.patterns.map((p) => ({ patternId: p.patternId, patternName: p.patternName }))
        : [];

  if (goalPhase === "applying" || goalPhase === "patching") {
    return <LoadingState label="Salvando sua meta…" />;
  }

  return (
    <Card className="weekly-review__goal-card" data-testid="weekly-review-goal">
      <h2 ref={statusHeadingRef} tabIndex={-1}>
        Meta da semana
      </h2>
      <p className="weekly-review__disclaimer">
        A meta é uma sugestão técnica editável — nunca promete melhora de nota ou aprovação.
      </p>

      {conflict && (
        <p className="weekly-review__conflict" role="alert" data-testid="weekly-review-conflict">
          Esta meta foi alterada em outro lugar. <button type="button" onClick={onReload}>Recarregar</button>
        </p>
      )}

      {formError && (
        <p className="weekly-review__error-indicator" role="alert">
          {formError}
        </p>
      )}

      {goalPhase === "idle" && !goal && (
        <div>
          <p className="weekly-review__message">Você ainda não tem uma meta aplicada para esta semana.</p>
          {previewError && (
            <p className="weekly-review__error-indicator" role="alert">
              {previewError}
            </p>
          )}
          <Button type="button" onClick={() => void startPreview()}>
            Ver sugestão de meta
          </Button>
        </div>
      )}

      {goalPhase === "idle" && goal && goal.status === "active" && (
        <ActiveGoalView goal={goal} onEdit={() => startEditActive(goal)} onComplete={() => void handleComplete(goal)} onAbandon={() => void handleAbandon(goal)} />
      )}

      {goalPhase === "idle" && goal && goal.status === "completed" && (
        <div data-testid="weekly-review-goal-completed">
          <p className="weekly-review__message">
            Meta concluída em {goal.completedAt ? formatDate(goal.completedAt.slice(0, 10)) : "—"}.
          </p>
          <GoalSummary goal={goal} />
        </div>
      )}

      {goalPhase === "idle" && goal && goal.status === "abandoned" && (
        <div data-testid="weekly-review-goal-abandoned">
          <p className="weekly-review__message">
            Meta abandonada em {goal.abandonedAt ? formatDate(goal.abandonedAt.slice(0, 10)) : "—"}. Você pode aplicar uma nova sugestão.
          </p>
          <Button type="button" onClick={() => void startPreview()}>
            Ver nova sugestão de meta
          </Button>
        </div>
      )}

      {(goalPhase === "editing-preview" || goalPhase === "editing-active") && (
        <GoalForm
          minutes={minutes}
          questions={questions}
          days={days}
          selectedPatternIds={selectedPatternIds}
          availablePatterns={availablePatterns}
          onMinutesChange={setMinutes}
          onQuestionsChange={setQuestions}
          onToggleDay={toggleDay}
          onTogglePattern={togglePattern}
          onCancel={() => setGoalPhase("idle")}
          onSubmit={() => (goalPhase === "editing-preview" ? void handleApply() : goal ? void handlePatch(goal) : undefined)}
          submitLabel={goalPhase === "editing-preview" ? "Aplicar meta" : "Salvar alterações"}
        />
      )}
    </Card>
  );
}

function ActiveGoalView({ goal, onEdit, onComplete, onAbandon }: { goal: Goal; onEdit: () => void; onComplete: () => void; onAbandon: () => void }) {
  return (
    <div data-testid="weekly-review-goal-active">
      <p className="weekly-review__fact">
        Meta ativa: <strong>{goal.targetMinutes} min</strong> e <strong>{goal.targetQuestions} questões</strong> nesta semana.
      </p>
      {goal.patterns.length > 0 && (
        <p className="weekly-review__fact">Padrões prioritários: {goal.patterns.map((p) => p.patternName).join(", ")}</p>
      )}
      <GoalSummary goal={goal} />
      <div className="weekly-review__goal-actions">
        <Button type="button" variant="secondary" onClick={onEdit}>
          Editar meta
        </Button>
        <Button type="button" variant="secondary" onClick={onComplete}>
          Concluir meta
        </Button>
        <Button type="button" variant="text" onClick={onAbandon}>
          Abandonar meta
        </Button>
      </div>
    </div>
  );
}

function GoalSummary({ goal }: { goal: Goal }) {
  const { progress } = goal;
  return (
    <div className="weekly-review__progress" data-testid="weekly-review-progress">
      {progress.minutesPercent !== null ? (
        <ProgressBar label="Minutos realizados versus pretendidos" value={progress.minutesPercent} max={100} />
      ) : (
        <p className="weekly-review__message">Ainda sem evidência suficiente de minutos realizados nesta semana.</p>
      )}
      {progress.questionsPercent !== null ? (
        <ProgressBar label="Questões confirmadas versus pretendidas" value={progress.questionsPercent} max={100} />
      ) : (
        <p className="weekly-review__message">Ainda sem evidência suficiente de questões confirmadas nesta semana.</p>
      )}
      <p className="weekly-review__fact">
        Dias com atividade: <strong>{progress.daysWithActivity ?? "sem evidência"}</strong> de {progress.daysAvailable || "—"} disponíveis
      </p>
      {goal.patterns.length > 0 && (
        <p className="weekly-review__fact">
          Padrões prioritários com alguma prática: <strong>{progress.patternsWithPractice.length}</strong> de {goal.patterns.length}
        </p>
      )}
    </div>
  );
}

function GoalForm(props: {
  minutes: number;
  questions: number;
  days: string[];
  selectedPatternIds: string[];
  availablePatterns: { patternId: string; patternName: string }[];
  onMinutesChange: (value: number) => void;
  onQuestionsChange: (value: number) => void;
  onToggleDay: (day: string) => void;
  onTogglePattern: (patternId: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
  submitLabel: string;
}) {
  return (
    <form
      className="weekly-review__form"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      <div className="weekly-review__field">
        <label htmlFor="goal-minutes">Minutos totais pretendidos</label>
        <input
          id="goal-minutes"
          type="number"
          min={30}
          max={1500}
          value={props.minutes}
          onChange={(event) => props.onMinutesChange(Number(event.target.value))}
        />
      </div>

      <div className="weekly-review__field">
        <label htmlFor="goal-questions">Questões confirmadas pretendidas</label>
        <input
          id="goal-questions"
          type="number"
          min={1}
          max={500}
          value={props.questions}
          onChange={(event) => props.onQuestionsChange(Number(event.target.value))}
        />
      </div>

      <fieldset className="weekly-review__field">
        <legend>Dias disponíveis</legend>
        {WEEKDAY_ORDER.map((day) => (
          <label key={day} className="weekly-review__checkbox">
            <input type="checkbox" checked={props.days.includes(day)} onChange={() => props.onToggleDay(day)} />
            <span>{WEEKDAY_LABELS[day]}</span>
          </label>
        ))}
      </fieldset>

      {props.availablePatterns.length > 0 && (
        <fieldset className="weekly-review__field">
          <legend>Padrões prioritários (até 3)</legend>
          {props.availablePatterns.map((pattern) => (
            <label key={pattern.patternId} className="weekly-review__checkbox">
              <input
                type="checkbox"
                checked={props.selectedPatternIds.includes(pattern.patternId)}
                onChange={() => props.onTogglePattern(pattern.patternId)}
                disabled={!props.selectedPatternIds.includes(pattern.patternId) && props.selectedPatternIds.length >= 3}
              />
              <span>{pattern.patternName}</span>
            </label>
          ))}
        </fieldset>
      )}

      <div className="weekly-review__goal-actions">
        <Button type="submit">{props.submitLabel}</Button>
        <Button type="button" variant="text" onClick={props.onCancel}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
