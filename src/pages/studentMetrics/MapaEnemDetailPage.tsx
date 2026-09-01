import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { ErrorState } from "../../components/ErrorState";
import { LoadingState } from "../../components/LoadingState";
import {
  fetchPatternMetricDetail,
  fetchRecentActivity,
  StudentMetricsApiError,
  type ActivityItem,
  type PatternMetricDetail,
} from "../../api/studentMetricsClient";
import { fetchPatternDetail } from "../../api/patternsClient";

const ACTIVITY_KIND_LABELS: Record<ActivityItem["kind"], string> = {
  answer: "Tentativa confirmada",
  recognition: "Reconhecimento registrado",
  help: "Ajuda aberta",
  review: "Revisão do Caderno de Erros",
};

function describeActivity(item: ActivityItem): string {
  if (item.kind === "answer") return item.isCorrect ? "acertou" : "errou";
  if (item.kind === "review") return item.reviewResult === "correct" ? "revisão correta" : "revisão incorreta";
  return "";
}
import "./MapaEnemPage.css";

/* Detalhe /mapa-enem/:slug — Sprint 10 v1.0, seção 10 da ordem.

   Nunca mostra resposta livre do aluno, token, id interno ou dado de
   auditoria — só os contadores técnicos já expostos pela API
   (worker/src/services/studentMetricsService.ts:getPatternMetricDetail).
   O CTA de treino reaproveita EXATAMENTE `fetchPatternDetail` (Sprint 6,
   src/api/patternsClient.ts) para obter `trainableQuestionId` — a MESMA
   fonte de verdade já usada em src/pages/patterns/PatternDetailPage.tsx,
   nunca uma seleção nova de questão calculada aqui. */

function formatDate(iso: string | null): string {
  if (!iso) return "Ainda sem registro";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "data indisponível";
  return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatApproxTime(seconds: number): string {
  if (seconds <= 0) return "sem registro";
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return "menos de 1 minuto";
  return `aproximadamente ${minutes} ${minutes === 1 ? "minuto" : "minutos"}`;
}

export function MapaEnemDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const [phase, setPhase] = useState<"loading" | "ready" | "unavailable" | "notFound" | "error">("loading");
  const [pattern, setPattern] = useState<PatternMetricDetail | null>(null);
  const [trainableQuestionId, setTrainableQuestionId] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);

  const load = useCallback(async () => {
    if (!slug) {
      setPhase("notFound");
      return;
    }
    setPhase("loading");
    try {
      const result = await fetchPatternMetricDetail(slug);
      if (result.available === false) {
        setPhase("unavailable");
        return;
      }
      if (!result.pattern) {
        setPhase("notFound");
        return;
      }
      setPattern(result.pattern);
      setPhase("ready");
    } catch (error) {
      if (error instanceof StudentMetricsApiError && error.status === 404) {
        setPhase("notFound");
        return;
      }
      setPhase("error");
    }
  }, [slug]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    fetchPatternDetail(slug)
      .then((result) => {
        if (!cancelled && result.available && result.pattern) setTrainableQuestionId(result.pattern.trainableQuestionId);
      })
      .catch(() => {
        // CTA de treino simplesmente não aparece — o restante da página segue funcionando.
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    if (!pattern) return;
    let cancelled = false;
    fetchRecentActivity()
      .then((result) => {
        if (!cancelled && result.available !== false && result.activity) {
          setActivity(result.activity.filter((item) => item.patternId === pattern.patternId));
        }
      })
      .catch(() => {
        // Sem linha do tempo disponível — o restante da página segue funcionando.
      });
    return () => {
      cancelled = true;
    };
  }, [pattern]);

  if (phase === "loading") {
    return <LoadingState label="Carregando o detalhe do padrão…" />;
  }

  if (phase === "unavailable") {
    return (
      <div className="mapa-enem mapa-enem--centered">
        <Card className="mapa-enem__card">
          <h1>Mapa ENEM em preparação</h1>
          <p>Esta funcionalidade ainda está em preparação técnica local — ainda não disponível.</p>
          <Link to="/mapa-enem">Voltar ao Mapa ENEM</Link>
        </Card>
      </div>
    );
  }

  if (phase === "notFound") {
    return (
      <div className="mapa-enem mapa-enem--centered">
        <Card className="mapa-enem__card">
          <h1>Padrão não encontrado</h1>
          <p>Este padrão não existe ou ainda não está publicado.</p>
          <Link to="/mapa-enem">Voltar ao Mapa ENEM</Link>
        </Card>
      </div>
    );
  }

  if (phase === "error" || !pattern) {
    return <ErrorState description="Não foi possível carregar o detalhe deste padrão." action={<Button onClick={() => void load()}>Tentar novamente</Button>} />;
  }

  return (
    <article className="mapa-enem mapa-enem__detail">
      <p className="mapa-enem__back">
        <Link to="/mapa-enem">← Voltar ao Mapa ENEM</Link>
      </p>

      <header className="mapa-enem__header">
        <span className="mapa-enem__card-code">{pattern.code}</span>
        <h1>{pattern.name}</h1>
        <p>
          <span className={`mapa-enem__state-badge mapa-enem__state-badge--${pattern.state}`}>{pattern.stateLabel}</span>
        </p>
        <p className="mapa-enem__disclaimer" role="note">
          Isto NÃO é uma nota estilo TRI nem uma declaração definitiva de domínio — é um resumo descritivo da
          evidência disponível até agora.
        </p>
      </header>

      <section className="mapa-enem__section" aria-labelledby="secao-evidencia-geral">
        <h2 id="secao-evidencia-geral">Evidência geral</h2>
        <table className="mapa-enem__table">
          <caption className="visually-hidden">Contagens gerais de evidência para este padrão</caption>
          <tbody>
            <tr>
              <th scope="row">Questões iniciadas</th>
              <td>{pattern.questionsStarted}</td>
            </tr>
            <tr>
              <th scope="row">Questões confirmadas</th>
              <td>{pattern.questionsConfirmed}</td>
            </tr>
            <tr>
              <th scope="row">Acertos</th>
              <td>{pattern.correctCount}</td>
            </tr>
            <tr>
              <th scope="row">Erros</th>
              <td>{pattern.incorrectCount}</td>
            </tr>
            <tr>
              <th scope="row">Questões distintas usadas</th>
              <td>{pattern.distinctQuestionsUsed}</td>
            </tr>
            <tr>
              <th scope="row">Reconhecimentos registrados</th>
              <td>{pattern.recognitionsLogged}</td>
            </tr>
            <tr>
              <th scope="row">Ajuda aberta</th>
              <td>
                {pattern.helpOpens} {pattern.helpOpens === 1 ? "vez" : "vezes"} (camada mais funda: {pattern.highestHelpLayer})
              </td>
            </tr>
            <tr>
              <th scope="row">Tempo aproximado de prática</th>
              <td>{formatApproxTime(pattern.approxTimeSeconds)}</td>
            </tr>
            <tr>
              <th scope="row">Última prática</th>
              <td>{formatDate(pattern.lastPracticeAt)}</td>
            </tr>
            <tr>
              <th scope="row">Próxima revisão</th>
              <td>{formatDate(pattern.nextReviewAt)}</td>
            </tr>
          </tbody>
        </table>
        <p className="mapa-enem__note">{pattern.limitationsNote}</p>
      </section>

      <section className="mapa-enem__section" aria-labelledby="secao-evidencia-modo">
        <h2 id="secao-evidencia-modo">Evidência por modo</h2>
        <table className="mapa-enem__table">
          <caption className="visually-hidden">Tentativas confirmadas por modo de prática</caption>
          <tbody>
            <tr>
              <th scope="row">Aprendizado</th>
              <td>{pattern.attemptsLearning}</td>
            </tr>
            <tr>
              <th scope="row">Prática</th>
              <td>{pattern.attemptsPractice}</td>
            </tr>
            <tr>
              <th scope="row">Reconhecimento</th>
              <td>{pattern.attemptsRecognition}</td>
            </tr>
            <tr>
              <th scope="row">Revisão (Caderno de Erros)</th>
              <td>{pattern.attemptsReview}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="mapa-enem__section" aria-labelledby="secao-revisoes">
        <h2 id="secao-revisoes">Revisões do Caderno de Erros</h2>
        <table className="mapa-enem__table">
          <caption className="visually-hidden">Resultado das revisões já concluídas para este padrão</caption>
          <tbody>
            <tr>
              <th scope="row">Revisões corretas</th>
              <td>{pattern.reviewsCorrect}</td>
            </tr>
            <tr>
              <th scope="row">Revisões incorretas</th>
              <td>{pattern.reviewsIncorrect}</td>
            </tr>
            <tr>
              <th scope="row">Última revisão</th>
              <td>{formatDate(pattern.lastReviewedAt)}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="mapa-enem__section" aria-labelledby="secao-evolucao">
        <h2 id="secao-evolucao">Evolução cronológica</h2>
        {activity.length === 0 ? (
          <p className="mapa-enem__note">Ainda sem eventos recentes registrados para este padrão.</p>
        ) : (
          <ol className="mapa-enem__timeline">
            {activity.map((item, index) => (
              <li key={`${item.kind}-${item.createdAt}-${index}`}>
                {formatDate(item.createdAt)} — {ACTIVITY_KIND_LABELS[item.kind]}
                {describeActivity(item) ? ` (${describeActivity(item)})` : ""}
              </li>
            ))}
          </ol>
        )}
        <p className="mapa-enem__note">
          Lista construída a partir de eventos técnicos reais (tentativas confirmadas, reconhecimentos, aberturas
          de ajuda e revisões) — nunca inclui respostas livres, comentários ou dados de auditoria.
        </p>
      </section>

      <section className="mapa-enem__section" aria-labelledby="secao-proximo-passo">
        <h2 id="secao-proximo-passo">Próximo passo recomendado</h2>
        <p>{pattern.nextStepRecommendation}</p>
        <p className="mapa-enem__note">
          Esta recomendação vem de uma regra técnica simples baseada no seu estado atual — nunca de uma
          pontuação ou fórmula de domínio.
        </p>
      </section>

      <section className="mapa-enem__section" aria-labelledby="secao-acoes">
        <h2 id="secao-acoes">Próximas ações</h2>
        <div className="mapa-enem__card-actions">
          {trainableQuestionId ? (
            <Link to={`/questoes/${trainableQuestionId}`} className="btn btn--primary">
              <span>Treinar este padrão</span>
            </Link>
          ) : (
            <Button type="button" disabled>
              Treinar este padrão (sem questão disponível)
            </Button>
          )}
          {pattern.hasActiveErrorEntry && (
            <Link to={`/caderno-de-erros?padrao=${encodeURIComponent(pattern.slug)}`} className="btn btn--secondary">
              <span>Ir para o Caderno de Erros</span>
            </Link>
          )}
          <Link to={`/padroes-enem/${pattern.slug}`} className="btn btn--secondary">
            <span>Ver ficha completa do padrão</span>
          </Link>
        </div>
      </section>
    </article>
  );
}
