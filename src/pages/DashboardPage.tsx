import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Modal } from "../components/Modal";
import { ProgressBar } from "../components/ProgressBar";
import { useAuth } from "../auth/useAuth";
import { useOnboardingStatus } from "../onboarding/useOnboardingStatus";
import { fetchScheduleSummary, type ScheduleSummary } from "../api/scheduleClient";
import { fetchPatterns } from "../api/patternsClient";
import {
  MOCK_BIGGEST_BOTTLENECK,
  MOCK_ENEM_MAP,
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
  const [isMapModalOpen, setIsMapModalOpen] = useState(false);
  const [scheduleSummary, setScheduleSummary] = useState<ScheduleSummary | null>(null);
  /* Sprint 6 — resumo REAL do catálogo de padrões, sem nenhuma métrica
     fabricada: `total` é quantos padrões publicados o Worker devolveu e
     `withEvidence` é quantos deles têm evidência realmente registrada para
     ESTE aluno (filtro evidencia=com_evidencia, escopado por sessão no SQL).
     Enquanto não houver evidência, o card mostra apenas o convite a conhecer
     os padrões — nunca um domínio, gargalo ou percentual inventado. */
  const [patternsSummary, setPatternsSummary] = useState<
    { available: boolean; total: number; withEvidence: number } | null
  >(null);
  const { user } = useAuth();
  const { profile } = useOnboardingStatus();
  const firstName = user?.name.trim().split(/\s+/)[0] ?? MOCK_STUDENT.firstName;

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
        });
      })
      .catch(() => {
        // Sem catálogo disponível — o card mostra o estado "em preparação".
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
        Sequência, Mapa ENEM e demais números abaixo (exceto os cards de Cronograma e
        Padrões ENEM) são dados de demonstração — ainda não refletem seu progresso real.
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
          <p className="dashboard__stat">
            {MOCK_ENEM_MAP.patternsDominated}/{MOCK_ENEM_MAP.patternsTotal} padrões dominados
          </p>
          <ProgressBar label="Progresso geral" value={MOCK_ENEM_MAP.overallPercent} />
          <div className="dashboard__dual-stat">
            <p>
              Reconhecimento: <strong>{MOCK_ENEM_MAP.recognitionPercent}%</strong> — Muito bom!
            </p>
            <p>
              Resolução: <strong>{MOCK_ENEM_MAP.resolutionPercent}%</strong> — Vamos evoluir!
            </p>
          </div>
          <Button variant="secondary" onClick={() => setIsMapModalOpen(true)}>
            Ver mapa completo
          </Button>
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
              O cronograma adaptativo está em preparação técnica — ainda não disponível.
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
              O catálogo de padrões está em preparação pedagógica — ainda não disponível.
            </p>
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

      <Modal
        isOpen={isMapModalOpen}
        title="Seu Mapa ENEM completo"
        onClose={() => setIsMapModalOpen(false)}
      >
        <p>
          A visão completa do Mapa ENEM, com todos os padrões e filtros, será implementada
          em uma sprint posterior.
        </p>
        <Button onClick={() => setIsMapModalOpen(false)}>Entendi</Button>
      </Modal>
    </div>
  );
}
