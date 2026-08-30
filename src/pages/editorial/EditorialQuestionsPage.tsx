import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { LoadingState } from "../../components/LoadingState";
import { fetchQuestions, type QuestionSummary } from "../../api/editorialClient";
import "./editorial.css";

/* Catálogo editorial /editorial/questoes — Sprint 7 v1.0, seção 9 da
   ordem. Filtros e página vivem na URL, mesma convenção de
   src/pages/patterns/PatternsPage.tsx. NÃO é acessível pelo menu do aluno
   (seção 9: "Não adicionar ao menu do aluno") — só chega aqui quem navega
   diretamente para /editorial/questoes, e mesmo assim RequireEditorialRole
   bloqueia sem papel. */

const STATUS_OPTIONS = [
  { value: "", label: "Todos os status" },
  { value: "draft", label: "Rascunho" },
  { value: "in_review", label: "Em revisão" },
  { value: "changes_requested", label: "Correção solicitada" },
  { value: "approved", label: "Aprovada" },
  { value: "published", label: "Publicada" },
  { value: "archived", label: "Arquivada" },
];

const ORIGIN_OPTIONS = [
  { value: "", label: "Todas as origens" },
  { value: "oficial", label: "Oficial" },
  { value: "autoral", label: "Autoral" },
  { value: "licenciada", label: "Licenciada" },
  { value: "diagnostico", label: "Diagnóstico" },
  { value: "reconhecimento", label: "Reconhecimento" },
  { value: "revisao_base", label: "Revisão/base" },
];

const PAGE_SIZE = 10;

function statusLabel(status: string): string {
  return STATUS_OPTIONS.find((o) => o.value === status)?.label ?? status;
}

export function EditorialQuestionsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const busca = searchParams.get("busca") ?? "";
  const status = searchParams.get("status") ?? "";
  const origem = searchParams.get("origem") ?? "";
  const rawPagina = Number(searchParams.get("pagina") ?? "1");
  const pagina = Number.isInteger(rawPagina) && rawPagina >= 1 ? rawPagina : 1;

  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [questions, setQuestions] = useState<QuestionSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [searchDraft, setSearchDraft] = useState(busca);

  const load = useCallback(async () => {
    setPhase("loading");
    try {
      const result = await fetchQuestions({ busca: busca || null, status: status || null, origem: origem || null, pagina, limite: PAGE_SIZE });
      setQuestions(result.questions);
      setTotal(result.total);
      setTotalPages(result.totalPages);
      setPhase("ready");
    } catch {
      setPhase("error");
    }
  }, [busca, status, origem, pagina]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  function updateParams(changes: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (!value) next.delete(key);
      else next.set(key, value);
    }
    next.delete("pagina");
    setSearchParams(next);
  }

  function handleSearchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    updateParams({ busca: searchDraft.trim() || null });
  }

  function goToPage(nextPage: number) {
    const next = new URLSearchParams(searchParams);
    if (nextPage <= 1) next.delete("pagina");
    else next.set("pagina", String(nextPage));
    setSearchParams(next);
  }

  if (phase === "error") {
    return <ErrorState description="Não foi possível carregar o banco de questões." action={<Button onClick={() => void load()}>Tentar novamente</Button>} />;
  }

  return (
    <div className="editorial">
      <header className="editorial__header">
        <h1>Banco de Questões</h1>
        <Link to="/editorial/questoes/nova">
          <Button type="button">Nova questão</Button>
        </Link>
      </header>

      <form className="editorial__search" role="search" onSubmit={handleSearchSubmit}>
        <div className="editorial__field">
          <label className="editorial__field-label" htmlFor="questions-busca">
            Buscar por código ou enunciado
          </label>
          <input id="questions-busca" type="search" value={searchDraft} onChange={(e) => setSearchDraft(e.target.value)} />
        </div>
        <Button type="submit">Buscar</Button>
      </form>

      <div className="editorial__filters" data-testid="editorial-filters">
        <div className="editorial__field">
          <label className="editorial__field-label" htmlFor="questions-status">
            Status
          </label>
          <select id="questions-status" value={status} onChange={(e) => updateParams({ status: e.target.value })}>
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="editorial__field">
          <label className="editorial__field-label" htmlFor="questions-origem">
            Origem
          </label>
          <select id="questions-origem" value={origem} onChange={(e) => updateParams({ origem: e.target.value })}>
            {ORIGIN_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p className="editorial__results-count" role="status" aria-live="polite">
        {phase === "ready" ? `${total} questão(ões) encontrada(s). Página ${pagina} de ${Math.max(totalPages, 1)}.` : ""}
      </p>

      {phase === "loading" ? (
        <LoadingState label="Carregando questões…" />
      ) : questions.length === 0 ? (
        <EmptyState title="Nenhuma questão encontrada" description="Ajuste os filtros ou crie uma nova questão." />
      ) : (
        <div className="editorial__table-wrap">
          <table className="editorial__table">
            <thead>
              <tr>
                <th scope="col">Código</th>
                <th scope="col">Enunciado</th>
                <th scope="col">Status</th>
                <th scope="col">Origem</th>
                <th scope="col">Dificuldade</th>
                <th scope="col">Imagem</th>
              </tr>
            </thead>
            <tbody>
              {questions.map((q) => (
                <tr key={q.id}>
                  <td>
                    <Link to={`/editorial/questoes/${q.id}`}>{q.code}</Link>
                    {q.isLocalFixture && <span className="editorial__fixture-badge"> FIXTURE</span>}
                  </td>
                  <td className="editorial__table-enunciado">{q.enunciado}</td>
                  <td>
                    <span className={`editorial__status editorial__status--${q.editorialStatus}`}>{statusLabel(q.editorialStatus)}</span>
                  </td>
                  <td>{q.origem}</td>
                  <td>{q.dificuldade}</td>
                  <td>{q.hasImage ? "Sim" : "Não"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <nav className="editorial__pagination" aria-label="Paginação do banco de questões">
          <Button type="button" variant="secondary" onClick={() => goToPage(pagina - 1)} disabled={pagina <= 1}>
            Anterior
          </Button>
          <span>
            Página {pagina} de {totalPages}
          </span>
          <Button type="button" variant="secondary" onClick={() => goToPage(pagina + 1)} disabled={pagina >= totalPages}>
            Próxima
          </Button>
        </nav>
      )}

      <Card className="editorial__nav-card">
        <Link to="/editorial/importacoes">Ir para importação de questões (CSV)</Link>
      </Card>
    </div>
  );
}
