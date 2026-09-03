import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { LoadingState } from "../../components/LoadingState";
import { fetchPatterns, type PatternSummary } from "../../api/patternsClient";
import {
  ERROR_TYPE_LABELS,
  STATUS_LABELS,
  fetchSummary,
  listEntries,
  startReview,
  type EntryListItem,
  type ErrorType,
} from "../../api/errorNotebookClient";
import "./ErrorNotebookPage.css";

/* Lista /caderno-de-erros — Sprint 9 v1.0, seção 12.1 da ordem. Mesmo
   padrão de src/pages/patterns/PatternsPage.tsx: filtros vivem na URL
   (useSearchParams), para que recarregar a página preserve exatamente a
   mesma consulta; resumo e contagens vêm sempre da API, nunca fabricados. */

const ERROR_TYPE_OPTIONS = Object.entries(ERROR_TYPE_LABELS) as Array<[ErrorType, string]>;
const STATUS_OPTIONS = Object.entries(STATUS_LABELS);
const PAGE_SIZE = 10;

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "data indisponível";
  return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function EntryCard({ entry, onStartReview, startingId }: { entry: EntryListItem; onStartReview: (id: string) => void; startingId: string | null }) {
  const isOverdue = entry.effectiveStatus === "due";
  return (
    <Card className="error-notebook__card">
      <div className="error-notebook__card-header">
        <span className="error-notebook__card-code">{entry.originalQuestionCode}</span>
        {entry.primaryPattern && <span className="error-notebook__card-pattern">{entry.primaryPattern.name}</span>}
      </div>
      <p className="error-notebook__card-type">
        <span className="error-notebook__card-label">Tipo de erro: </span>
        {ERROR_TYPE_LABELS[entry.errorType]}
      </p>
      <p className="error-notebook__card-status">
        <span className="error-notebook__card-label">Status: </span>
        {STATUS_LABELS[entry.effectiveStatus]}
        {isOverdue && (
          <strong className="error-notebook__overdue-flag" role="note">
            {" "}
            — revisão vencida
          </strong>
        )}
      </p>
      <p className="error-notebook__card-dates">
        <span className="error-notebook__card-label">Último erro: </span>
        {formatDate(entry.lastErrorAt)}
        {" · "}
        <span className="error-notebook__card-label">Próxima revisão: </span>
        {formatDate(entry.nextReviewAt)}
      </p>
      <div className="error-notebook__card-actions">
        {entry.status !== "archived" && entry.status !== "corrected" && (
          <Button type="button" onClick={() => onStartReview(entry.id)} isLoading={startingId === entry.id} disabled={startingId !== null}>
            Corrigir meu erro
          </Button>
        )}
        <Link to={`/caderno-de-erros/${entry.id}`} className="btn btn--secondary">
          <span>Ver detalhes</span>
        </Link>
      </div>
    </Card>
  );
}

export function ErrorNotebookListPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const patternSlug = searchParams.get("padrao") ?? "";
  const errorType = searchParams.get("tipo") ?? "";
  const status = searchParams.get("status") ?? "";
  const overdue = searchParams.get("vencida") === "true";
  const from = searchParams.get("de") ?? "";
  const to = searchParams.get("ate") ?? "";
  const rawPage = Number(searchParams.get("pagina") ?? "1");
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1;

  const [phase, setPhase] = useState<"loading" | "ready" | "unavailable" | "error">("loading");
  const [entries, setEntries] = useState<EntryListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<{ active: number; overdue: number; corrected: number; total: number } | null>(null);
  const [patterns, setPatterns] = useState<PatternSummary[]>([]);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const hasActiveFilters = Boolean(patternSlug || errorType || status || overdue || from || to);

  const load = useCallback(async () => {
    setPhase("loading");
    try {
      const result = await listEntries({
        patternSlug: patternSlug || undefined,
        errorType: errorType || undefined,
        status: status || undefined,
        overdue,
        from: from || undefined,
        to: to || undefined,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      });
      if (result.available === false) {
        setPhase("unavailable");
        return;
      }
      setEntries(result.entries ?? []);
      setTotal(result.total ?? 0);
      setPhase("ready");
    } catch {
      setPhase("error");
    }
  }, [patternSlug, errorType, status, overdue, from, to, page]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  useEffect(() => {
    fetchSummary()
      .then((result) => {
        if (result.available !== false && result.summary) setSummary(result.summary);
      })
      .catch(() => {
        // Sem resumo disponível — a lista continua funcionando normalmente.
      });
  }, []);

  useEffect(() => {
    fetchPatterns({ limite: 50 })
      .then((result) => {
        if (result.available && result.patterns) setPatterns(result.patterns);
      })
      .catch(() => {
        // Sem catálogo de padrões — o filtro por padrão fica só com "Todos".
      });
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const resultAnnouncement = useMemo(() => {
    if (phase !== "ready") return "";
    if (total === 0) return "Nenhum erro encontrado com os filtros atuais.";
    const noun = total === 1 ? "erro encontrado" : "erros encontrados";
    return `${total} ${noun}. Página ${page} de ${totalPages}.`;
  }, [phase, total, page, totalPages]);

  function updateParams(changes: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    next.delete("pagina");
    setSearchParams(next);
  }

  function goToPage(nextPage: number) {
    const next = new URLSearchParams(searchParams);
    if (nextPage <= 1) next.delete("pagina");
    else next.set("pagina", String(nextPage));
    setSearchParams(next);
  }

  async function handleStartReview(entryId: string) {
    setStartingId(entryId);
    setStartError(null);
    try {
      const result = await startReview(entryId);
      if (result.attemptId) navigate(`/tentativas/${result.attemptId}`);
    } catch {
      setStartError("Não foi possível iniciar a revisão agora. Tente novamente.");
      setStartingId(null);
    }
  }

  if (phase === "unavailable") {
    return (
      <div className="error-notebook error-notebook--centered">
        <Card className="error-notebook__card">
          <h1>Seu Caderno de Erros está vazio</h1>
          <p>Ele será preenchido automaticamente quando houver erros para revisar.</p>
        </Card>
      </div>
    );
  }

  if (phase === "error") {
    return <ErrorState description="Não foi possível carregar o Caderno de Erros." action={<Button onClick={() => void load()}>Tentar novamente</Button>} />;
  }

  return (
    <div className="error-notebook">
      <header className="error-notebook__header">
        <h1>Caderno de Erros</h1>
        <p className="error-notebook__intro">
          Todo erro que você confirma no Player fica registrado aqui, automaticamente. Classifique o que
          aconteceu, anote o que aprendeu e volte para corrigir quando a revisão estiver pronta.
        </p>
        {summary && (
          <p className="error-notebook__summary" role="status">
            <span>
              <strong>{summary.active}</strong> ativos
            </span>
            <span>
              <strong>{summary.overdue}</strong> vencidos
            </span>
            <span>
              <strong>{summary.corrected}</strong> corrigidos
            </span>
            <span>
              <strong>{summary.total}</strong> registrados no total
            </span>
          </p>
        )}
      </header>

      <div className="error-notebook__filters">
        <div className="error-notebook__field">
          <label className="error-notebook__field-label" htmlFor="caderno-padrao">
            Padrão
          </label>
          <select id="caderno-padrao" value={patternSlug} onChange={(event) => updateParams({ padrao: event.target.value })}>
            <option value="">Todos</option>
            {patterns.map((pattern) => (
              <option key={pattern.slug} value={pattern.slug}>
                {pattern.name}
              </option>
            ))}
          </select>
        </div>

        <div className="error-notebook__field">
          <label className="error-notebook__field-label" htmlFor="caderno-tipo">
            Tipo de erro
          </label>
          <select id="caderno-tipo" value={errorType} onChange={(event) => updateParams({ tipo: event.target.value })}>
            <option value="">Todos</option>
            {ERROR_TYPE_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <div className="error-notebook__field">
          <label className="error-notebook__field-label" htmlFor="caderno-status">
            Status
          </label>
          <select id="caderno-status" value={status} onChange={(event) => updateParams({ status: event.target.value })}>
            <option value="">Todos</option>
            {STATUS_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <div className="error-notebook__field">
          <label className="error-notebook__field-label" htmlFor="caderno-de">
            De
          </label>
          <input id="caderno-de" type="date" value={from} onChange={(event) => updateParams({ de: event.target.value })} />
        </div>

        <div className="error-notebook__field">
          <label className="error-notebook__field-label" htmlFor="caderno-ate">
            Até
          </label>
          <input id="caderno-ate" type="date" value={to} onChange={(event) => updateParams({ ate: event.target.value })} />
        </div>

        <label className="error-notebook__checkbox-field">
          <input type="checkbox" checked={overdue} onChange={(event) => updateParams({ vencida: event.target.checked ? "true" : null })} />
          <span>Só revisões vencidas</span>
        </label>
      </div>

      <p className="error-notebook__results-count" role="status" aria-live="polite">
        {resultAnnouncement}
      </p>

      {startError && (
        <p className="error-notebook__save-indicator error-notebook__save-indicator--error" role="status" aria-live="polite">
          {startError}
        </p>
      )}

      {phase === "loading" ? (
        <LoadingState label="Carregando o Caderno de Erros…" />
      ) : entries.length === 0 && !hasActiveFilters ? (
        <EmptyState
          title="Nenhum erro registrado ainda"
          description="Assim que você confirmar uma resposta errada no Player, ela aparece aqui automaticamente — não é preciso fazer nada manualmente."
        />
      ) : entries.length === 0 ? (
        <EmptyState
          title="Nenhum erro encontrado com os filtros atuais"
          description="Ajuste os filtros ou limpe-os para ver todos os erros registrados."
          action={
            <Button variant="secondary" onClick={() => setSearchParams(new URLSearchParams())}>
              Limpar filtros
            </Button>
          }
        />
      ) : (
        <div className="error-notebook__grid">
          {entries.map((entry) => (
            <EntryCard key={entry.id} entry={entry} onStartReview={(id) => void handleStartReview(id)} startingId={startingId} />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <nav className="error-notebook__pagination" aria-label="Paginação do Caderno de Erros">
          <Button type="button" variant="secondary" onClick={() => goToPage(page - 1)} disabled={page <= 1}>
            Anterior
          </Button>
          <span className="error-notebook__pagination-status">
            Página {page} de {totalPages}
          </span>
          <Button type="button" variant="secondary" onClick={() => goToPage(page + 1)} disabled={page >= totalPages}>
            Próxima
          </Button>
        </nav>
      )}
    </div>
  );
}
