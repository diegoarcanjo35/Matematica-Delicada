import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { LoadingState } from "../../components/LoadingState";
import { fetchPatternPerformanceOverview, type PatternPerformanceOverviewItem } from "../../api/studentMetricsClient";
import "./PerformancePage.css";

/* Rota /desempenho — Sprint 21, "Dashboard de Desempenho por Padrão".

   Toda evidência exibida vem literalmente de
   worker/src/services/studentMetricsService.ts:getPatternPerformanceOverview
   — nenhum número/rótulo é inventado aqui, só formatação (data relativa,
   percentual). A ordenação já vem pronta do backend (prioridade de AÇÃO,
   nunca nota — revisão pendente primeiro, depois quem precisa de atenção,
   depois em desenvolvimento/evidências iniciais/sem evidências, e por
   último consistente neste recorte); o filtro nesta página só ESCONDE
   itens da lista já ordenada, nunca reordena. */

type FilterValue = "todos" | "atencao" | "em_desenvolvimento" | "consistente_no_recorte";

const FILTERS: Array<{ value: FilterValue; label: string }> = [
  { value: "todos", label: "Todos" },
  { value: "atencao", label: "Precisa de atenção" },
  { value: "em_desenvolvimento", label: "Em desenvolvimento" },
  { value: "consistente_no_recorte", label: "Consistente" },
];

function formatRelativeDate(iso: string | null): string {
  if (!iso) return "Ainda sem prática registrada";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "data indisponível";
  const today = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(today) - startOfDay(date)) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "Hoje";
  if (diffDays === 1) return "Ontem";
  return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function formatAccuracy(accuracy: number | null): string {
  if (accuracy === null) return "Sem respostas confirmadas ainda";
  return `${Math.round(accuracy * 100)}% de acerto`;
}

export function PatternPerformanceCard({ item }: { item: PatternPerformanceOverviewItem }) {
  const { pattern, evidence, accuracy, state, attention, training } = item;
  return (
    <Card className="performance__card">
      <div className="performance__card-header">
        <p className="performance__card-name">{pattern.name}</p>
        <span className={`performance__state-badge performance__state-badge--${state.code}`}>{state.label}</span>
      </div>

      {attention.needed && (
        <p className="performance__attention" role="note">
          <strong>Precisa de atenção.</strong> {attention.reason}
        </p>
      )}

      {(state.code === "sem_evidencias" || state.code === "evidencias_iniciais") && (
        <p className="performance__low-evidence-note" role="note">
          Ainda há pouca evidência para avaliar este padrão.
        </p>
      )}

      <p className="performance__accuracy">{formatAccuracy(accuracy)}</p>

      <p className="performance__stats">
        <span className="performance__stats-label">Tentativas confirmadas: </span>
        {evidence.confirmedAttempts} ({evidence.correctCount} certas, {evidence.incorrectCount} erradas) ·{" "}
        <span className="performance__stats-label">Questões distintas: </span>
        {evidence.distinctQuestionsUsed}
      </p>

      <p className="performance__last-practice">
        <span className="performance__stats-label">Última prática: </span>
        {formatRelativeDate(evidence.lastPracticeAt)}
      </p>

      <details className="performance__details">
        <summary>Ver detalhe factual</summary>
        <ul className="performance__detail-list">
          <li>{evidence.distinctPracticeDays} dias distintos de prática</li>
          <li>{evidence.attemptsWithHelp} tentativas confirmadas usaram ajuda</li>
          <li>
            {evidence.reviewsCorrect} revisões corretas · {evidence.reviewsIncorrect} revisões incorretas
          </li>
        </ul>
      </details>

      <div className="performance__card-actions">
        {state.code === "revisao_pendente" ? (
          <Link to="/caderno-de-erros" className="btn btn--primary">
            <span>Revisar agora</span>
          </Link>
        ) : training.canTrain ? (
          <Link to={`/treino-diario?patternId=${pattern.id}`} className="btn btn--primary">
            <span>Treinar este padrão</span>
          </Link>
        ) : (
          <span className="performance__cta-disabled" aria-disabled="true">
            Questões em preparação
          </span>
        )}
      </div>
    </Card>
  );
}

export function PerformancePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = (searchParams.get("filtro") as FilterValue | null) ?? "todos";

  const [phase, setPhase] = useState<"loading" | "ready" | "unavailable" | "error">("loading");
  const [patterns, setPatterns] = useState<PatternPerformanceOverviewItem[]>([]);

  const load = useCallback(async () => {
    setPhase("loading");
    try {
      const result = await fetchPatternPerformanceOverview();
      if (result.available === false) {
        setPhase("unavailable");
        return;
      }
      setPatterns(result.patterns ?? []);
      setPhase("ready");
    } catch {
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    if (filter === "todos") return patterns;
    if (filter === "atencao") return patterns.filter((p) => p.attention.needed);
    return patterns.filter((p) => p.state.code === filter);
  }, [patterns, filter]);

  function setFilter(value: FilterValue) {
    const next = new URLSearchParams(searchParams);
    if (value === "todos") next.delete("filtro");
    else next.set("filtro", value);
    setSearchParams(next);
  }

  if (phase === "unavailable") {
    return (
      <div className="performance performance--centered">
        <Card className="performance__card">
          <h1>Seu desempenho ainda não tem evidências</h1>
          <p>Faça seu primeiro treino para começar a ver seu desempenho por padrão aqui.</p>
        </Card>
      </div>
    );
  }

  if (phase === "error") {
    return <ErrorState description="Não foi possível carregar seu desempenho." action={<Button onClick={() => void load()}>Tentar novamente</Button>} />;
  }

  return (
    <div className="performance">
      <header className="performance__header">
        <h1>Desempenho por padrão</h1>
        <p className="performance__intro">Veja o que seus treinos já mostram — e onde ainda faltam evidências.</p>
        <p className="performance__disclaimer" role="note">
          Isto não é uma nota nem um domínio definitivo — é um resumo descritivo do que já foi praticado até agora.
        </p>
      </header>

      <div className="performance__filters" role="group" aria-label="Filtrar por estado">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            className={`performance__filter${filter === f.value ? " performance__filter--active" : ""}`}
            aria-pressed={filter === f.value}
            onClick={() => setFilter(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {phase === "loading" ? (
        <LoadingState label="Carregando seu desempenho…" />
      ) : patterns.length === 0 ? (
        <EmptyState
          title="Ainda sem padrões publicados"
          description="Assim que houver padrões publicados, eles aparecem aqui automaticamente."
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          title="Nenhum padrão neste filtro"
          description="Ajuste o filtro para ver outros padrões."
          action={
            <Button variant="secondary" onClick={() => setFilter("todos")}>
              Ver todos
            </Button>
          }
        />
      ) : (
        <div className="performance__grid">
          {filtered.map((item) => (
            <PatternPerformanceCard key={item.pattern.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
