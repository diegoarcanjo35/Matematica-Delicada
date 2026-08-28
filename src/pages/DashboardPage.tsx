import { useState } from "react";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Modal } from "../components/Modal";
import { ProgressBar } from "../components/ProgressBar";
import {
  MOCK_BIGGEST_BOTTLENECK,
  MOCK_ENEM_MAP,
  MOCK_PATTERN_CARDS,
  MOCK_STUDENT,
  MOCK_TODAY_TRAINING,
  MOCK_WEEK_EVOLUTION,
} from "../mocks/dashboardMock";
import "./DashboardPage.css";

export function DashboardPage() {
  const [isMapModalOpen, setIsMapModalOpen] = useState(false);

  return (
    <div className="dashboard">
      <p className="dashboard__mock-notice">
        Dados de demonstração — esta tela ainda não usa informações reais do aluno.
      </p>

      <header className="dashboard__greeting">
        <h2 className="dashboard__greeting-title">{MOCK_STUDENT.greeting}</h2>
        <p className="dashboard__tagline">{MOCK_STUDENT.tagline}</p>
        <p className="dashboard__streak">
          Sequência atual: <strong>{MOCK_STUDENT.streakDays} dias</strong>
        </p>
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
          <h3>Treino de Hoje</h3>
          <p className="dashboard__stat">
            {MOCK_TODAY_TRAINING.questionCount} questões — aproximadamente{" "}
            {MOCK_TODAY_TRAINING.estimatedMinutes} minutos
          </p>
          <ul className="dashboard__pattern-list">
            {MOCK_TODAY_TRAINING.patterns.map((pattern) => (
              <li key={pattern.code}>
                {pattern.name}: {pattern.questionCount}{" "}
                {pattern.questionCount === 1 ? "questão" : "questões"}
              </li>
            ))}
            <li>Revisão espaçada: {MOCK_TODAY_TRAINING.spacedReviewCount} questão</li>
          </ul>
          <p className="dashboard__message">{MOCK_TODAY_TRAINING.message}</p>
          <Button>COMEÇAR TREINO</Button>
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
