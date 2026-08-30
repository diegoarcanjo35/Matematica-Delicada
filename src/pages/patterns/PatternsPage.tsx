import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { LoadingState } from "../../components/LoadingState";
import {
  fetchPatterns,
  type PatternSummary,
  type PatternProgress,
} from "../../api/patternsClient";
import {
  INDEX_UNAVAILABLE_LABEL,
  PATTERN_EVIDENCE_OPTIONS,
  PATTERN_SORT_OPTIONS,
  PROVISIONAL_CONTENT_NOTICE,
} from "./patternOptions";
import "./PatternsPage.css";

/* Catálogo /padroes-enem — Sprint 6 v1.0.

   Filtros e página vivem na URL (useSearchParams), para que recarregar a
   página preserve exatamente a mesma consulta. Nenhum dado pessoal vai para
   a URL: só busca textual, conteúdo, tag, filtro de evidência, ordenação e
   número da página.

   Nenhuma quantidade de padrões é escrita como texto fixo — o total exibido
   vem sempre do que a API realmente retornou. */

const VALID_SORTS = new Set(PATTERN_SORT_OPTIONS.map((option) => option.value as string));
const VALID_EVIDENCES = new Set(PATTERN_EVIDENCE_OPTIONS.map((option) => option.value as string));
const PAGE_SIZE = 4;
/** Teto validado também no Worker (PATTERNS_MAX_LIMIT) — usado só para
 *  montar as opções de filtro a partir dos padrões realmente publicados. */
const OPTIONS_FETCH_LIMIT = 50;

function progressStateLabel(progress: PatternProgress): string {
  const { recognition, resolution, mastery } = progress.indices;
  if (!recognition.available && !resolution.available && !mastery.available) {
    return INDEX_UNAVAILABLE_LABEL;
  }
  const parts: string[] = [];
  if (recognition.available) parts.push(`Reconhecimento ${recognition.value}`);
  if (resolution.available) parts.push(`Resolução ${resolution.value}`);
  if (mastery.available) parts.push(`Domínio ${mastery.value}`);
  return parts.join(" · ");
}

function PatternCard({ pattern }: { pattern: PatternSummary }) {
  return (
    <Card className="patterns__card">
      {pattern.isLocalFixture && (
        <p className="patterns__provisional-notice" role="note">
          {PROVISIONAL_CONTENT_NOTICE}
        </p>
      )}
      <div className="patterns__card-header">
        <span className="patterns__card-code">{pattern.code}</span>
      </div>
      <h2 className="patterns__card-title">
        <Link to={`/padroes-enem/${pattern.slug}`}>{pattern.name}</Link>
      </h2>
      <p className="patterns__card-phrase">{pattern.recognitionPhrase}</p>
      {pattern.tags.length > 0 && (
        <ul className="patterns__chips" aria-label={`Tags de ${pattern.name}`}>
          {pattern.tags.map((tag) => (
            <li key={tag} className="patterns__chip">
              {tag}
            </li>
          ))}
        </ul>
      )}
      {pattern.requiredContents.length > 0 && (
        <p className="patterns__card-contents">
          <span className="patterns__card-label">Conteúdos: </span>
          {pattern.requiredContents.join(", ")}
        </p>
      )}
      <p className="patterns__card-progress">
        <span className="patterns__card-label">Seu progresso: </span>
        {progressStateLabel(pattern.progress)}
      </p>
    </Card>
  );
}

export function PatternsPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const busca = searchParams.get("busca") ?? "";
  const conteudo = searchParams.get("conteudo") ?? "";
  const tag = searchParams.get("tag") ?? "";
  const rawEvidencia = searchParams.get("evidencia") ?? "todos";
  const evidencia = VALID_EVIDENCES.has(rawEvidencia) ? rawEvidencia : "todos";
  const rawOrdenar = searchParams.get("ordenar") ?? "codigo";
  const ordenar = VALID_SORTS.has(rawOrdenar) ? rawOrdenar : "codigo";
  const rawPagina = Number(searchParams.get("pagina") ?? "1");
  const pagina = Number.isInteger(rawPagina) && rawPagina >= 1 ? rawPagina : 1;

  const [phase, setPhase] = useState<"loading" | "ready" | "unavailable" | "error">("loading");
  const [patterns, setPatterns] = useState<PatternSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [searchDraft, setSearchDraft] = useState(busca);
  const [allContents, setAllContents] = useState<string[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);

  const load = useCallback(async () => {
    setPhase("loading");
    try {
      const result = await fetchPatterns({
        busca: busca || null,
        conteudo: conteudo || null,
        tag: tag || null,
        evidencia,
        ordenar,
        pagina,
        limite: PAGE_SIZE,
      });
      if (!result.available) {
        setPhase("unavailable");
        return;
      }
      setPatterns(result.patterns ?? []);
      setTotal(result.total ?? 0);
      setTotalPages(result.totalPages ?? 0);
      setPhase("ready");
    } catch {
      setPhase("error");
    }
  }, [busca, conteudo, tag, evidencia, ordenar, pagina]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Opções dos filtros derivadas dos padrões REALMENTE publicados — nunca uma
  // taxonomia fixa escrita no frontend. Leitura pura, sem efeito colateral.
  useEffect(() => {
    let cancelled = false;
    fetchPatterns({ limite: OPTIONS_FETCH_LIMIT })
      .then((result) => {
        if (cancelled || !result.available) return;
        const contents = new Set<string>();
        const tags = new Set<string>();
        for (const pattern of result.patterns ?? []) {
          pattern.requiredContents.forEach((item) => contents.add(item));
          pattern.tags.forEach((item) => tags.add(item));
        }
        setAllContents([...contents].sort((a, b) => a.localeCompare(b, "pt-BR")));
        setAllTags([...tags].sort((a, b) => a.localeCompare(b, "pt-BR")));
      })
      .catch(() => {
        // Sem opções derivadas, os selects ficam só com "Todos" — a busca
        // textual continua funcionando normalmente.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const resultAnnouncement = useMemo(() => {
    if (phase !== "ready") return "";
    if (total === 0) return "Nenhum padrão encontrado com os filtros atuais.";
    const noun = total === 1 ? "padrão encontrado" : "padrões encontrados";
    return `${total} ${noun}. Página ${pagina} de ${Math.max(totalPages, 1)}.`;
  }, [phase, total, pagina, totalPages]);

  function updateParams(changes: Record<string, string | null>, resetPage = true) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    if (resetPage) next.delete("pagina");
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

  if (phase === "unavailable") {
    return (
      <div className="patterns patterns--centered">
        <Card className="patterns__card">
          <h1>Padrões ENEM em preparação</h1>
          <p>
            O catálogo de padrões recorrentes ainda está em preparação pedagógica. Assim que a
            taxonomia e o conteúdo forem aprovados, ele ficará disponível por aqui.
          </p>
        </Card>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <ErrorState
        description="Não foi possível carregar o catálogo de padrões."
        action={<Button onClick={() => void load()}>Tentar novamente</Button>}
      />
    );
  }

  return (
    <div className="patterns">
      <header className="patterns__header">
        <h1>Padrões ENEM</h1>
        <p className="patterns__intro">
          Cada padrão descreve uma situação que se repete nas provas: como reconhecê-la e por
          onde começar a resolver. A taxonomia é revisável e continua sendo construída a partir
          da análise do acervo.
        </p>
      </header>

      {/* Rótulo e controle são associados explicitamente por htmlFor/id (não
          por aninhamento): num <select> aninhado dentro do <label>, o nome
          acessível passa a incluir o texto de TODAS as opções, o que degrada
          o anúncio por leitor de tela e torna os campos ambíguos. */}
      <form className="patterns__search" onSubmit={handleSearchSubmit} role="search">
        <div className="patterns__field">
          <label className="patterns__field-label" htmlFor="patterns-busca">
            Buscar padrão
          </label>
          <input
            id="patterns-busca"
            type="search"
            name="busca"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            placeholder="Nome, código ou frase de reconhecimento"
          />
        </div>
        <Button type="submit">Buscar</Button>
      </form>

      <div className="patterns__filters">
        <div className="patterns__field">
          <label className="patterns__field-label" htmlFor="patterns-conteudo">
            Conteúdo
          </label>
          <select
            id="patterns-conteudo"
            value={conteudo}
            onChange={(event) => updateParams({ conteudo: event.target.value })}
          >
            <option value="">Todos</option>
            {allContents.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>

        <div className="patterns__field">
          <label className="patterns__field-label" htmlFor="patterns-tag">
            Tag
          </label>
          <select id="patterns-tag" value={tag} onChange={(event) => updateParams({ tag: event.target.value })}>
            <option value="">Todas</option>
            {allTags.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>

        <div className="patterns__field">
          <label className="patterns__field-label" htmlFor="patterns-evidencia">
            Evidência
          </label>
          <select
            id="patterns-evidencia"
            value={evidencia}
            onChange={(event) => updateParams({ evidencia: event.target.value })}
          >
            {PATTERN_EVIDENCE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="patterns__field">
          <label className="patterns__field-label" htmlFor="patterns-ordenar">
            Ordenar por
          </label>
          <select
            id="patterns-ordenar"
            value={ordenar}
            onChange={(event) => updateParams({ ordenar: event.target.value })}
          >
            {PATTERN_SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p className="patterns__results-count" role="status" aria-live="polite">
        {resultAnnouncement}
      </p>

      {phase === "loading" ? (
        <LoadingState label="Carregando os padrões…" />
      ) : patterns.length === 0 ? (
        <EmptyState
          title="Nenhum padrão encontrado"
          description="Nenhum padrão publicado corresponde aos filtros escolhidos. Ajuste a busca ou limpe os filtros."
          action={
            <Button variant="secondary" onClick={() => setSearchParams(new URLSearchParams())}>
              Limpar filtros
            </Button>
          }
        />
      ) : (
        <div className="patterns__grid">
          {patterns.map((pattern) => (
            <PatternCard key={pattern.slug} pattern={pattern} />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <nav className="patterns__pagination" aria-label="Paginação do catálogo de padrões">
          <Button
            type="button"
            variant="secondary"
            onClick={() => goToPage(pagina - 1)}
            disabled={pagina <= 1}
          >
            Anterior
          </Button>
          <span className="patterns__pagination-status">
            Página {pagina} de {totalPages}
          </span>
          <Button
            type="button"
            variant="secondary"
            onClick={() => goToPage(pagina + 1)}
            disabled={pagina >= totalPages}
          >
            Próxima
          </Button>
        </nav>
      )}
    </div>
  );
}
