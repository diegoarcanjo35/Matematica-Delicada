import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { ProgressBar } from "../components/ProgressBar";
import { useAuth } from "../auth/useAuth";
import { useOnboardingStatus } from "../onboarding/useOnboardingStatus";
import { fetchScheduleSummary, type ScheduleSummary } from "../api/scheduleClient";
import { fetchPatterns } from "../api/patternsClient";
import { fetchSummary as fetchErrorNotebookSummary } from "../api/errorNotebookClient";
import { fetchStudentMetricsSummary, type StudentMetricsSummary } from "../api/studentMetricsClient";
import { fetchCurrent as fetchDailyTrainingCurrent, fetchPreview as fetchDailyTrainingPreview } from "../api/dailyTrainingClient";
import { fetchCurrent as fetchSimulationsCurrent, fetchHistory as fetchSimulationsHistory } from "../api/simulationsClient";
import { fetchCurrentReport as fetchWeeklyReviewCurrent } from "../api/weeklyReviewClient";
import {
  MOCK_BIGGEST_BOTTLENECK,
  MOCK_PATTERN_CARDS,
  MOCK_STUDENT,
  MOCK_WEEK_EVOLUTION,
} from "../mocks/dashboardMock";
import "./DashboardPage.css";

function timeOfDayGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Bom dia";
  if (hour < 18) return "Boa tarde";
  return "Boa noite";
}

export function DashboardPage() {
  const [scheduleSummary, setScheduleSummary] = useState<ScheduleSummary | null>(null);
  /* Sprint 10 — resumo REAL do Mapa ENEM (seção 11 da ordem): substitui o
     antigo card mocado (`MOCK_ENEM_MAP`) por dados vindos de
     GET /api/student-metrics/summary. `available: false` (gate de
     fixtures fechado) mostra o mesmo estado "em preparação" do resto do
     namespace do aluno; `hasAnyEvidence: false` mostra um convite honesto,
     nunca um 0%/domínio fabricado. */
  const [metricsSummary, setMetricsSummary] = useState<StudentMetricsSummary | null>(null);
  /* Sprint 6 — resumo REAL do catálogo de padrões, sem nenhuma métrica
     fabricada: `total` é quantos padrões publicados o Worker devolveu e
     `withEvidence` é quantos deles têm evidência realmente registrada para
     ESTE aluno (filtro evidencia=com_evidencia, escopado por sessão no SQL).
     Enquanto não houver evidência, o card mostra apenas o convite a conhecer
     os padrões — nunca um domínio, gargalo ou percentual inventado. */
  const [patternsSummary, setPatternsSummary] = useState<
    { available: boolean; total: number; withEvidence: number; hasAnyTrainableQuestion: boolean } | null
  >(null);
  /* Sprint 9 — resumo REAL do Caderno de Erros (seção 13.2 da ordem):
     erros a revisar, revisões vencidas, CTA. Nenhuma métrica fabricada —
     `available: false` (gate fechado) mostra o card "em preparação", igual
     ao Cronograma/Padrões ENEM acima. */
  const [errorNotebookSummary, setErrorNotebookSummary] = useState<
    { active: number; overdue: number; corrected: number; total: number } | null
  >(null);
  /* Sprint 11 — card real do Treino Diário (seção 13 da ordem: "Dashboard
     aponta para o treino real; card mostra lista ativa ou preview
     disponível"). Nenhuma leitura cria lista — GET /current e GET
     /preview são 100% somente leitura. */
  const [dailyTrainingCard, setDailyTrainingCard] = useState<
    { kind: "active"; itemCount: number; estimatedMinutes: number; doneCount: number } | { kind: "preview"; itemCount: number; estimatedMinutes: number } | { kind: "empty" } | null
  >(null);
  /* Sprint 12 — card real dos Simulados em Blocos (seção 16 da ordem:
     "Dashboard pode mostrar bloco ativo ou último bloco concluído"; "nenhum
     card pode inventar nota, evolução ou desempenho"; "nenhuma leitura do
     Dashboard pode criar bloco"). GET /current e GET /history são 100%
     somente leitura. */
  const [simulationsCard, setSimulationsCard] = useState<
    | { kind: "active"; doneCount: number; itemCount: number; estimatedMinutes: number; blockId: string }
    | { kind: "last_completed"; completedCount: number; correctCount: number; incorrectCount: number }
    | { kind: "none" }
    | null
  >(null);
  /* Sprint 13 — card real "Sua semana" (seção 11 da ordem: "card real
   *  mostrando resumo factual e link para /relatorio-semanal"). Nenhuma
   *  métrica fabricada: `null` enquanto carrega, resumo REAL depois. */
  const [weeklyReviewSummary, setWeeklyReviewSummary] = useState<
    { hasAnyEvidence: boolean; confirmedQuestionsCount: number; daysWithEvidenceCount: number; approxMinutes: number | null; hasActiveGoal: boolean } | null
  >(null);
  const { user } = useAuth();
  const { profile } = useOnboardingStatus();
  const firstName = user?.name.trim().split(/\s+/)[0] ?? MOCK_STUDENT.firstName;

  useEffect(() => {
    let cancelled = false;
    fetchStudentMetricsSummary()
      .then((result) => {
        if (!cancelled && result.available !== false && result.summary) setMetricsSummary(result.summary);
      })
      .catch(() => {
        // Sem Mapa ENEM disponível — o card mostra o estado "em preparação".
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchErrorNotebookSummary()
      .then((result) => {
        if (!cancelled && result.available !== false && result.summary) setErrorNotebookSummary(result.summary);
      })
      .catch(() => {
        // Sem Caderno de Erros disponível — o card mostra o estado "em preparação".
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchScheduleSummary()
      .then((summary) => {
        if (!cancelled) setScheduleSummary(summary);
      })
      .catch(() => {
        // Sem cronograma disponível — o card mostra o estado "em preparação".
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Duas leituras puras do MESMO endpoint somente-leitura (GET /api/patterns)
    // — nenhuma delas cria padrão, progresso ou qualquer linha.
    Promise.all([fetchPatterns({ limite: 1 }), fetchPatterns({ limite: 1, evidencia: "com_evidencia" })])
      .then(([all, withEvidence]) => {
        if (cancelled) return;
        setPatternsSummary({
          available: all.available,
          total: all.total ?? 0,
          withEvidence: withEvidence.total ?? 0,
          hasAnyTrainableQuestion: all.hasAnyTrainableQuestion ?? false,
        });
      })
      .catch(() => {
        // Sem catálogo disponível — o card mostra o estado "em preparação".
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const current = await fetchDailyTrainingCurrent();
        if (cancelled || current.available === false) return;
        if (current.list) {
          const doneCount = current.list.items.filter((item) => item.status === "completed" || item.status === "skipped" || item.status === "blocked").length;
          setDailyTrainingCard({ kind: "active", itemCount: current.list.itemCount, estimatedMinutes: current.list.estimatedMinutes, doneCount });
          return;
        }
        const previewResult = await fetchDailyTrainingPreview();
        if (cancelled || previewResult.available === false || !previewResult.preview) return;
        if (previewResult.preview.itemCount === 0) {
          setDailyTrainingCard({ kind: "empty" });
        } else {
          setDailyTrainingCard({ kind: "preview", itemCount: previewResult.preview.itemCount, estimatedMinutes: previewResult.preview.estimatedMinutes });
        }
      } catch {
        // Sem Treino Diário disponível — o card mostra o estado "em preparação".
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const current = await fetchSimulationsCurrent();
        if (cancelled || current.available === false) return;
        if (current.block && current.block.status === "active") {
          const doneCount = current.block.items.filter((item) => item.status === "completed" || item.status === "skipped" || item.status === "blocked").length;
          setSimulationsCard({
            kind: "active",
            doneCount,
            itemCount: current.block.actualItemCount,
            estimatedMinutes: current.block.estimatedMinutes,
            blockId: current.block.id,
          });
          return;
        }
        const history = await fetchSimulationsHistory();
        if (cancelled) return;
        const last = history.entries[0];
        if (last && last.status === "completed") {
          setSimulationsCard({ kind: "last_completed", completedCount: last.completedCount, correctCount: last.correctCount, incorrectCount: last.incorrectCount });
        } else {
          setSimulationsCard({ kind: "none" });
        }
      } catch {
        // Sem Simulados disponível — o card mostra o estado "em preparação".
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchWeeklyReviewCurrent()
      .then((result) => {
        if (cancelled) return;
        setWeeklyReviewSummary({
          hasAnyEvidence: result.report.hasAnyEvidence,
          confirmedQuestionsCount: result.report.confirmedQuestionsCount,
          daysWithEvidenceCount: result.report.daysWithEvidenceCount,
          approxMinutes: result.report.approxMinutes,
          hasActiveGoal: result.report.goal?.status === "active",
        });
      })
      .catch(() => {
        // Sem Relatório Semanal disponível — o card mostra o estado "em preparação".
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const goalLabel =
    profile?.goalType === "acertos"
      ? `${profile.goalValue} acertos`
      : profile?.goalType === "nota"
        ? `${profile.goalValue} pontos`
        : null;

  return (
    <div className="dashboard">
      <p className="dashboard__mock-notice">
        Sequência, Maior Gargalo, Evolução da Semana e Padrões em destaque abaixo ainda são
        dados de demonstração — ainda não refletem seu progresso real. Cronograma, Padrões
        ENEM, Caderno de Erros e Mapa ENEM já mostram dados reais.
      </p>

      <header className="dashboard__greeting">
        <h2 className="dashboard__greeting-title">
          {timeOfDayGreeting()}, {firstName}! ♡
        </h2>
        <p className="dashboard__tagline">{MOCK_STUDENT.tagline}</p>
        <p className="dashboard__streak">
          Sequência atual: <strong>{MOCK_STUDENT.streakDays} dias</strong>
        </p>
        {goalLabel && (
          <p className="dashboard__goal">
            Sua meta: <strong>{goalLabel}</strong>
          </p>
        )}
        {profile?.diagnosticChoice === "depois" && (
          <p className="dashboard__diagnostic-cta">
            Você optou por fazer o diagnóstico depois.{" "}
            <Link to="/diagnostico">Fazer o diagnóstico agora</Link>
          </p>
        )}
      </header>

      <div className="dashboard__grid">
        <Card className="dashboard__card">
          <h3>Seu Mapa ENEM</h3>
          {metricsSummary ? (
            metricsSummary.hasAnyEvidence ? (
              <>
                <p className="dashboard__stat">
                  {metricsSummary.totalPublishedPatterns - metricsSummary.patternsByState.sem_evidencias} de{" "}
                  {metricsSummary.totalPublishedPatterns} padrões já têm alguma evidência registrada
                </p>
                {metricsSummary.pendingReviewCount > 0 && (
                  <p className="dashboard__message">
                    {metricsSummary.pendingReviewCount}{" "}
                    {metricsSummary.pendingReviewCount === 1 ? "padrão com revisão pendente" : "padrões com revisão pendente"}.
                  </p>
                )}
                <p className="dashboard__message">
                  Nenhuma nota estilo TRI ou domínio definitivo é calculado — só evidência real por padrão.
                </p>
                <Link to="/mapa-enem" className="btn btn--primary">
                  <span>Ver Mapa ENEM completo</span>
                </Link>
              </>
            ) : (
              <>
                <p className="dashboard__message">
                  Ainda sem evidências suficientes registradas em nenhum padrão. Assim que você praticar
                  questões, elas aparecem aqui automaticamente.
                </p>
                <Link to="/mapa-enem" className="btn btn--primary">
                  <span>Ver Mapa ENEM completo</span>
                </Link>
              </>
            )
          ) : (
            <p className="dashboard__message">Seu mapa ganha forma conforme você resolve questões — faça seu primeiro treino.</p>
          )}
        </Card>

        <Card className="dashboard__card">
          <h3>Treino Diário</h3>
          {dailyTrainingCard === null && (
            <p className="dashboard__message">Ainda não há questões disponíveis para o treino de hoje.</p>
          )}
          {dailyTrainingCard?.kind === "active" && (
            <>
              <p className="dashboard__stat">
                {dailyTrainingCard.doneCount} de {dailyTrainingCard.itemCount} questões — aproximadamente {dailyTrainingCard.estimatedMinutes} min
              </p>
              <Link to="/treino-diario" className="btn btn--primary">
                <span>Continuar treino</span>
              </Link>
            </>
          )}
          {dailyTrainingCard?.kind === "preview" && (
            <>
              <p className="dashboard__stat">
                {dailyTrainingCard.itemCount} {dailyTrainingCard.itemCount === 1 ? "questão" : "questões"} — aproximadamente{" "}
                {dailyTrainingCard.estimatedMinutes} min
              </p>
              <Link to="/treino-diario" className="btn btn--primary">
                <span>Começar treino</span>
              </Link>
            </>
          )}
          {dailyTrainingCard?.kind === "empty" && (
            <p className="dashboard__message">
              Sem disponibilidade ou sem questões elegíveis hoje. <Link to="/treino-diario">Ver detalhes</Link>
            </p>
          )}
        </Card>

        <Card className="dashboard__card">
          <h3>Simulados em blocos</h3>
          {simulationsCard === null && (
            <p className="dashboard__message">Ainda não há questões disponíveis para montar um simulado.</p>
          )}
          {simulationsCard?.kind === "active" && (
            <>
              <p className="dashboard__stat">
                {simulationsCard.doneCount} de {simulationsCard.itemCount} questões — aproximadamente {simulationsCard.estimatedMinutes} min
              </p>
              <Link to={`/simulados/${simulationsCard.blockId}`} className="btn btn--primary">
                <span>Continuar bloco</span>
              </Link>
            </>
          )}
          {simulationsCard?.kind === "last_completed" && (
            <>
              <p className="dashboard__stat">
                Último bloco: {simulationsCard.completedCount} questões — {simulationsCard.correctCount} acertos, {simulationsCard.incorrectCount} erros
              </p>
              <p className="dashboard__message">Prática em formato de simulado — nunca uma nota oficial do ENEM.</p>
              <Link to="/simulados" className="btn btn--primary">
                <span>Ver simulados</span>
              </Link>
            </>
          )}
          {simulationsCard?.kind === "none" && (
            <>
              <p className="dashboard__message">Nenhum bloco de simulado ainda. Escolha um bloco misto ou focado em um padrão.</p>
              <Link to="/simulados" className="btn btn--primary">
                <span>Configurar simulado</span>
              </Link>
            </>
          )}
        </Card>

        <Card className="dashboard__card">
          <h3>Sua semana</h3>
          {weeklyReviewSummary === null && (
            <p className="dashboard__message">Seu relatório semanal aparece assim que você tiver a primeira atividade registrada.</p>
          )}
          {weeklyReviewSummary?.hasAnyEvidence ? (
            <>
              <p className="dashboard__stat">
                {weeklyReviewSummary.confirmedQuestionsCount} questões confirmadas — {weeklyReviewSummary.daysWithEvidenceCount} dias com atividade
                {weeklyReviewSummary.approxMinutes !== null ? `, aproximadamente ${weeklyReviewSummary.approxMinutes} min` : ""}
              </p>
              <p className="dashboard__message">Dados factuais — nunca nota, TRI ou ranking.</p>
            </>
          ) : (
            weeklyReviewSummary && <p className="dashboard__message">Ainda sem evidências suficientes nesta semana.</p>
          )}
          {weeklyReviewSummary && (
            <Link to="/relatorio-semanal" className="btn btn--primary">
              <span>{weeklyReviewSummary.hasActiveGoal ? "Ver relatório e meta" : "Ver relatório semanal"}</span>
            </Link>
          )}
        </Card>

        <Card className="dashboard__card">
          <h3>Cronograma</h3>
          {scheduleSummary?.available ? (
            <>
              <p className="dashboard__stat">
                {scheduleSummary.plannedMinutesToday} de {scheduleSummary.availableMinutesToday} minutos
                planejados hoje
              </p>
              <ProgressBar
                label="Capacidade de hoje"
                value={
                  scheduleSummary.availableMinutesToday > 0
                    ? Math.min(100, Math.round((scheduleSummary.plannedMinutesToday / scheduleSummary.availableMinutesToday) * 100))
                    : 0
                }
              />
              {scheduleSummary.pendingCount > 0 && (
                <p className="dashboard__message">
                  {scheduleSummary.pendingCount}{" "}
                  {scheduleSummary.pendingCount === 1 ? "atividade pendente" : "atividades pendentes"} sem data.
                </p>
              )}
              <Link to="/cronograma" className="btn btn--primary">
                <span>Ver cronograma</span>
              </Link>
            </>
          ) : (
            <p className="dashboard__message">
              Ainda não há atividades cadastradas para o cronograma.
            </p>
          )}
        </Card>

        <Card className="dashboard__card">
          <h3>Padrões ENEM</h3>
          {patternsSummary?.available ? (
            patternsSummary.withEvidence === 0 ? (
              <>
                <p className="dashboard__message">
                  Ainda sem evidências suficientes para resumir seu domínio por padrão. Comece
                  conhecendo como cada padrão é reconhecido.
                </p>
                <Link to="/padroes-enem" className="btn btn--primary">
                  <span>Conhecer os padrões</span>
                </Link>
              </>
            ) : (
              <>
                <p className="dashboard__stat">
                  {patternsSummary.withEvidence} de {patternsSummary.total} padrões publicados já
                  têm evidência registrada
                </p>
                <p className="dashboard__message">
                  As fórmulas dos três índices ainda estão em definição — nenhum domínio é
                  calculado nesta etapa.
                </p>
                <Link to="/padroes-enem" className="btn btn--primary">
                  <span>Ver padrões</span>
                </Link>
              </>
            )
          ) : (
            <p className="dashboard__message">
              Ainda não há padrões publicados neste catálogo.
            </p>
          )}
          {patternsSummary?.available && patternsSummary.hasAnyTrainableQuestion && (
            <p className="dashboard__player-cta">
              <Link to="/padroes-enem" className="btn btn--secondary">
                <span>Resolver uma questão</span>
              </Link>
            </p>
          )}
        </Card>

        <Card className="dashboard__card">
          <h3>Caderno de Erros</h3>
          {errorNotebookSummary ? (
            errorNotebookSummary.active === 0 ? (
              <p className="dashboard__message">
                Nenhum erro para revisar agora — assim que você confirmar uma resposta errada no
                Player, ela aparece aqui automaticamente.
              </p>
            ) : (
              <>
                <p className="dashboard__stat">
                  {errorNotebookSummary.active} {errorNotebookSummary.active === 1 ? "erro ativo" : "erros ativos"}
                </p>
                {errorNotebookSummary.overdue > 0 && (
                  <p className="dashboard__message">
                    {errorNotebookSummary.overdue} {errorNotebookSummary.overdue === 1 ? "revisão vencida" : "revisões vencidas"}.
                  </p>
                )}
                <p className="dashboard__message">{errorNotebookSummary.corrected} corrigidos até agora.</p>
              </>
            )
          ) : (
            <p className="dashboard__message">Seu Caderno de Erros está vazio. Ele será preenchido automaticamente quando houver erros para revisar.</p>
          )}
          {errorNotebookSummary && (
            <Link to="/caderno-de-erros" className="btn btn--primary">
              <span>Ver Caderno de Erros</span>
            </Link>
          )}
        </Card>

        <Card className="dashboard__card">
          <h3>Seu Maior Gargalo</h3>
          <p className="dashboard__stat">
            {MOCK_BIGGEST_BOTTLENECK.code} — {MOCK_BIGGEST_BOTTLENECK.name}
          </p>
          <ProgressBar label="Domínio atual" value={MOCK_BIGGEST_BOTTLENECK.masteryPercent} />
          <p>Causa: {MOCK_BIGGEST_BOTTLENECK.cause}</p>
          <p className="dashboard__message">{MOCK_BIGGEST_BOTTLENECK.recommendation}</p>
          <Button variant="secondary">TREINAR AGORA</Button>
        </Card>

        <Card className="dashboard__card">
          <h3>Evolução da Semana</h3>
          <ul className="dashboard__week-chart" aria-hidden="true">
            {MOCK_WEEK_EVOLUTION.days.map((day, index) => (
              <li key={day}>
                <span
                  className="dashboard__week-bar"
                  style={{ height: `${MOCK_WEEK_EVOLUTION.values[index]}%` }}
                />
                <span className="dashboard__week-day">{day}</span>
              </li>
            ))}
          </ul>
          <p className="dashboard__week-summary">
            Variação de <strong>+{MOCK_WEEK_EVOLUTION.variationPercent}%</strong> em relação à
            semana anterior, com {MOCK_WEEK_EVOLUTION.sessionsCompleted} sessões realizadas.
            {" "}
            <span className="visually-hidden">
              Resumo diário:{" "}
              {MOCK_WEEK_EVOLUTION.days
                .map((day, index) => `${day} ${MOCK_WEEK_EVOLUTION.values[index]}%`)
                .join(", ")}
              .
            </span>
          </p>
        </Card>
      </div>

      <section aria-labelledby="pattern-cards-heading" className="dashboard__patterns">
        <h3 id="pattern-cards-heading">Padrões em destaque</h3>
        <div className="dashboard__pattern-cards">
          {MOCK_PATTERN_CARDS.map((pattern) => (
            <Card key={pattern.code} className="dashboard__pattern-card">
              <div className="dashboard__pattern-card-header">
                <span className="dashboard__pattern-code">{pattern.code}</span>
                <Badge status={pattern.status} />
              </div>
              <p className="dashboard__pattern-name">{pattern.name}</p>
              <ProgressBar label="Domínio" value={pattern.masteryPercent} />
              <p className="dashboard__pattern-detail">
                Reconhecimento {pattern.recognitionPercent}% · Resolução{" "}
                {pattern.resolutionPercent}%
              </p>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
