import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { LoadingState } from "../../components/LoadingState";
import { PageTitle } from "../../components/PageTitle";
import { fetchTeacherStudentDetail, TeacherApiError, type StudentDetail } from "../../api/teacherClient";
import "./TeacherPages.css";

/* /professor/alunos/:studentId — Acompanhamento Individual (ordem seção
   13). Consolida dados JÁ existentes (relatório semanal, padrões, Caderno
   de Erros, treino) numa única projeção sanitizada vinda do Worker — esta
   tela nunca calcula nem infere nada, só formata o que a API já entrega.
   Nunca oferece edição de meta (seção 13: "não permitir ao professor
   editar a meta do aluno nesta sprint"). */

const ERROR_TYPE_LABELS: Record<string, string> = {
  unclassified: "Não classificado",
  pattern_not_recognized: "Padrão não reconhecido",
  wrong_pattern: "Padrão errado",
  inadequate_strategy: "Estratégia inadequada",
  interpretation: "Interpretação",
  content_or_base: "Conteúdo de base",
  calculation: "Cálculo",
  haste: "Pressa",
  time_shortage: "Falta de tempo",
  marking_error: "Erro de marcação",
};

function formatMinutes(minutes: number | null): string {
  if (minutes === null) return "sem registro no período";
  return `${minutes} min`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "sem registro";
  const date = new Date(iso.includes("T") || iso.includes("Z") ? iso : iso.replace(" ", "T") + "Z");
  if (Number.isNaN(date.getTime())) return "sem registro";
  return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function TeacherStudentDetailPage() {
  const { studentId } = useParams<{ studentId: string }>();
  const [phase, setPhase] = useState<"loading" | "ready" | "not_found" | "error">("loading");
  const [detail, setDetail] = useState<StudentDetail | null>(null);

  const load = useCallback(async () => {
    if (!studentId) return;
    setPhase("loading");
    try {
      const result = await fetchTeacherStudentDetail(studentId);
      setDetail(result.detail);
      setPhase("ready");
    } catch (error) {
      if (error instanceof TeacherApiError && error.status === 404) {
        setPhase("not_found");
        return;
      }
      setPhase("error");
    }
  }, [studentId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  if (phase === "loading") return <LoadingState label="Carregando acompanhamento do aluno…" />;

  if (phase === "not_found") {
    return (
      <EmptyState
        title="Aluno não encontrado"
        description="Este aluno não existe ou não está vinculado à sua conta de professor."
        action={
          <Link to="/professor/alunos" className="btn btn--secondary">
            <span>Voltar para a lista de alunos</span>
          </Link>
        }
      />
    );
  }

  if (phase === "error" || !detail) {
    return <ErrorState description="Não foi possível carregar o acompanhamento deste aluno." action={<Button onClick={() => void load()}>Tentar novamente</Button>} />;
  }

  const { student, weeklyReview, patterns, errorNotebook, trainingToday } = detail;
  const errorTypeEntries = Object.entries(errorNotebook.countsByErrorType).filter(([, count]) => count > 0);

  return (
    <div className="teacher-page">
      <header className="teacher-page__detail-header">
        <PageTitle title={student.studentName} description={student.currentGrade ?? "Série não informada"} />
      </header>

      <section aria-labelledby="teacher-detail-resumo">
        <h2 id="teacher-detail-resumo" className="teacher-page__section-title">
          Resumo factual da semana
        </h2>
        {!weeklyReview.hasAnyEvidence ? (
          <EmptyState title="Ainda não há evidências registradas neste período." />
        ) : (
          <Card>
            <div className="teacher-page__fact-grid">
              <div className="teacher-page__fact">
                <span className="teacher-page__fact-value">{weeklyReview.confirmedQuestionsCount}</span>
                <span className="teacher-page__fact-label">Questões confirmadas</span>
              </div>
              <div className="teacher-page__fact">
                <span className="teacher-page__fact-value">
                  {weeklyReview.correctCount}/{weeklyReview.correctCount + weeklyReview.incorrectCount}
                </span>
                <span className="teacher-page__fact-label">Acertos/total</span>
              </div>
              <div className="teacher-page__fact">
                <span className="teacher-page__fact-value">{formatMinutes(weeklyReview.approxMinutes)}</span>
                <span className="teacher-page__fact-label">Minutos aproximados</span>
              </div>
              <div className="teacher-page__fact">
                <span className="teacher-page__fact-value">{weeklyReview.daysWithEvidenceCount}</span>
                <span className="teacher-page__fact-label">Dias com evidência</span>
              </div>
              <div className="teacher-page__fact">
                <span className="teacher-page__fact-value">{weeklyReview.overdueReviewsAtWeekEnd ?? "—"}</span>
                <span className="teacher-page__fact-label">Revisões vencidas (agora)</span>
              </div>
            </div>
          </Card>
        )}
      </section>

      <section aria-labelledby="teacher-detail-semana">
        <h2 id="teacher-detail-semana" className="teacher-page__section-title">
          Semana e meta
        </h2>
        {!weeklyReview.goal ? (
          <EmptyState title="Nenhuma meta semanal registrada para este período." />
        ) : (
          <Card>
            <p>
              Meta ativa: <strong>{weeklyReview.goal.targetMinutes} min</strong> / <strong>{weeklyReview.goal.targetQuestions} questões</strong> —
              status <strong>{weeklyReview.goal.status}</strong>
            </p>
            <p>
              Progresso factual: {weeklyReview.goal.progress.minutesDone ?? "sem registro"} min feitos
              {weeklyReview.goal.progress.minutesPercent !== null ? ` (${weeklyReview.goal.progress.minutesPercent}%)` : ""} ·{" "}
              {weeklyReview.goal.progress.questionsDone ?? "sem registro"} questões feitas
              {weeklyReview.goal.progress.questionsPercent !== null ? ` (${weeklyReview.goal.progress.questionsPercent}%)` : ""}
            </p>
            {weeklyReview.goal.patterns.length > 0 && (
              <p>Padrões priorizados: {weeklyReview.goal.patterns.map((p) => p.patternName).join(", ")}</p>
            )}
          </Card>
        )}

        {weeklyReview.comparison.available && weeklyReview.comparison.deltas && (
          <Card>
            <p>
              Comparação factual com a semana anterior: {weeklyReview.comparison.deltas.confirmedQuestionsCount >= 0 ? "+" : ""}
              {weeklyReview.comparison.deltas.confirmedQuestionsCount} questões confirmadas,{" "}
              {weeklyReview.comparison.deltas.daysWithEvidenceCount >= 0 ? "+" : ""}
              {weeklyReview.comparison.deltas.daysWithEvidenceCount} dias com evidência.
            </p>
          </Card>
        )}
      </section>

      <section aria-labelledby="teacher-detail-treino">
        <h2 id="teacher-detail-treino" className="teacher-page__section-title">
          Treino
        </h2>
        <Card>
          <p>Itens de treino diário concluídos nesta semana: {weeklyReview.dailyTrainingItemsCompleted}</p>
          {trainingToday ? (
            <p>
              Treino de hoje ({trainingToday.date}): status <strong>{trainingToday.status}</strong>, {trainingToday.completedCount} de{" "}
              {trainingToday.itemCount} itens concluídos.
            </p>
          ) : (
            <p>Nenhum treino diário iniciado hoje.</p>
          )}
        </Card>
      </section>

      <section aria-labelledby="teacher-detail-caderno">
        <h2 id="teacher-detail-caderno" className="teacher-page__section-title">
          Caderno de Erros
        </h2>
        {errorNotebook.totalCount === 0 ? (
          <EmptyState title="Nenhum registro no Caderno de Erros ainda." />
        ) : (
          <Card>
            <div className="teacher-page__fact-grid">
              <div className="teacher-page__fact">
                <span className="teacher-page__fact-value">{errorNotebook.totalCount}</span>
                <span className="teacher-page__fact-label">Registros no total</span>
              </div>
              <div className="teacher-page__fact">
                <span className="teacher-page__fact-value">{errorNotebook.activeCount}</span>
                <span className="teacher-page__fact-label">Ativos</span>
              </div>
              <div className="teacher-page__fact">
                <span className="teacher-page__fact-value">{errorNotebook.overdueCount}</span>
                <span className="teacher-page__fact-label">Revisões vencidas</span>
              </div>
              <div className="teacher-page__fact">
                <span className="teacher-page__fact-value">{errorNotebook.correctedCount}</span>
                <span className="teacher-page__fact-label">Corrigidos</span>
              </div>
            </div>
            {errorTypeEntries.length > 0 && (
              <div className="teacher-page__error-type-list">
                {errorTypeEntries.map(([type, count]) => (
                  <span key={type} className="teacher-page__error-type-chip">
                    {(ERROR_TYPE_LABELS[type] ?? type)}: {count}
                  </span>
                ))}
              </div>
            )}
          </Card>
        )}
      </section>

      <section aria-labelledby="teacher-detail-padroes">
        <h2 id="teacher-detail-padroes" className="teacher-page__section-title">
          Padrões
        </h2>
        {patterns.every((p) => p.state === "sem_evidencias") ? (
          <EmptyState title="Ainda não há evidências registradas em nenhum padrão." />
        ) : (
          <Card>
            <ul className="teacher-page__pattern-list">
              {patterns
                .filter((p) => p.state !== "sem_evidencias")
                .map((pattern) => (
                  <li key={pattern.patternId} className="teacher-page__pattern-item">
                    <span>{pattern.name}</span>
                    <span className={`teacher-page__state-badge teacher-page__state-badge--${pattern.state}`}>{pattern.stateLabel}</span>
                    <span>Última prática: {formatDate(pattern.lastPracticeAt)}</span>
                    {pattern.hasActiveErrorEntry && <span>Revisão pendente</span>}
                  </li>
                ))}
            </ul>
          </Card>
        )}
      </section>
    </div>
  );
}
