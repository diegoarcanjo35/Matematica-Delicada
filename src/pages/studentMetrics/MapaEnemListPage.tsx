import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { LoadingState } from "../../components/LoadingState";
import {
  fetchPatternMetrics,
  fetchStudentMetricsSummary,
  type PatternMetricSummary,
  type ProvisionalState,
  type StudentMetricsSummary,
} from "../../api/studentMetricsClient";
import { isRecentPractice, RECENT_PRACTICE_WINDOW_DAYS } from "./recentPractice";
import "./MapaEnemPage.css";

/* Lista /mapa-enem — Sprint 10 v1.1, seção 9 da ordem.

   Toda evidência exibida vem literalmente da API (worker/src/services/
   studentMetricsService.ts) — nenhum número é calculado ou arredondado
   aqui além de formatação de data. Filtros e busca vivem na URL
   (useSearchParams, mesmo padrão de src/pages/errorNotebook/
   ErrorNotebookListPage.tsx e src/pages/patterns/PatternsPage.tsx) — mas,
   diferente do Caderno de Erros, são aplicados no CLIENTE sobre a lista
   completa já carregada (o Worker sempre devolve todos os padrões
   publicados de uma vez — worker/src/services/studentMetricsService.ts,
   `listPatternMetrics`), então trocar de filtro nunca dispara nova
   requisição.

   "Recente" (filtro de prática recente) usa um recorte de 14 dias — limiar
   PROVISÓRIO centralizado em ./recentPractice.ts (v1.1: extraído daqui
   para permitir relógio injetável em teste — ver docs/METRICAS_MAPA_ENEM.md,
   seção "O recorte de prática recente (14 dias)"), sujeito a ajuste futuro
   pela Andréia/PO, exatamente como os limiares de
   worker/src/lib/studentMetricsRules.ts. */

const STATE_ORDER: ProvisionalState[] = [
  "revisao_pendente",
  "sem_evidencias",
  "evidencias_iniciais",
  "em_desenvolvimento",
  "consistente_no_recorte",
];

const STATE_GROUP_TITLES: Record<ProvisionalState, string> = {
  revisao_pendente: "Revisão pendente",
  sem_evidencias: "Ainda sem evidências suficientes",
  evidencias_iniciais: "Evidências iniciais",
  em_desenvolvimento: "Em desenvolvimento",
  consistente_no_recorte: "Consistente neste recorte",
};

function formatDate(iso: string | null): string {
  if (!iso) return "Ainda sem registro";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "data indisponível";
  return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function PatternCard({ pattern }: { pattern: PatternMetricSummary }) {
  return (
    <Card className="mapa-enem__card">
      <div className="mapa-enem__card-header">
        <span className="mapa-enem__card-code">{pattern.code}</span>
        <span className={`mapa-enem__state-badge mapa-enem__state-badge--${pattern.state}`}>{pattern.stateLabel}</span>
      </div>
      <p className="mapa-enem__card-label" style={{ margin: 0 }}>
        {pattern.name}
      </p>
      <p className="mapa-enem__card-stats">
        <span className="mapa-enem__card-label">Questões confirmadas: </span>
        {pattern.questionsConfirmed} ({pattern.correctCount} certas, {pattern.incorrectCount} erradas) ·{" "}
        <span className="mapa-enem__card-label">Distintas: </span>
        {pattern.distinctQuestionsUsed}
      </p>
      {pattern.helpOpens > 0 && (
        <p className="mapa-enem__note">
          Ajuda foi aberta {pattern.helpOpens} {pattern.helpOpens === 1 ? "vez" : "vezes"} (camada mais funda usada: {pattern.highestHelpLayer}) —
          isso não é um julgamento, só um registro técnico de uso.
        </p>
      )}
      <p className="mapa-enem__card-dates">
        <span className="mapa-enem__card-label">Última prática: </span>
        {formatDate(pattern.lastPracticeAt)}
        {" · "}
        <span className="mapa-enem__card-label">Próxima revisão: </span>
        {formatDate(pattern.nextReviewAt)}
      </p>
      <div className="mapa-enem__card-actions">
        <Link to={`/mapa-enem/${pattern.slug}`} className="btn btn--secondary">
          <span>Ver detalhe</span>
        </Link>
        <Link to={`/padroes-enem/${pattern.slug}`} className="btn btn--secondary">
          <span>Ver ficha do padrão</span>
        </Link>
        {pattern.hasActiveErrorEntry && (
          <Link to={`/caderno-de-erros?padrao=${encodeURIComponent(pattern.slug)}`} className="btn btn--primary">
            <span>Ir para o Caderno de Erros</span>
          </Link>
        )}
      </div>
    </Card>
  );
}

export function MapaEnemListPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const stateFilter = searchParams.get("estado") ?? "";
  const recentOnly = searchParams.get("recente") === "true";
  const reviewPendingOnly = searchParams.get("revisao") === "true";
  const activeErrorOnly = searchParams.get("caderno") === "true";
  const search = searchParams.get("busca") ?? "";

  const [phase, setPhase] = useState<"loading" | "ready" | "unavailable" | "error">("loading");
  const [patterns, setPatterns] = useState<PatternMetricSummary[]>([]);
  const [summary, setSummary] = useState<StudentMetricsSummary | null>(null);

  const load = useCallback(async () => {
    setPhase("loading");
    try {
      const [patternsResult, summaryResult] = await Promise.all([fetchPatternMetrics(), fetchStudentMetricsSummary()]);
      if (patternsResult.available === false) {
        setPhase("unavailable");
        return;
      }
      setPatterns(patternsResult.patterns ?? []);
      if (summaryResult.available !== false && summaryResult.summary) setSummary(summaryResult.summary);
      setPhase("ready");
    } catch {
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const hasActiveFilters = Boolean(stateFilter || recentOnly || reviewPendingOnly || activeErrorOnly || search);

  /* Estado vazio HONESTO (seção 9): "nenhuma evidência em nenhum padrão"
     nunca pode depender só de `filtered.length === 0`, porque o catálogo
     publicado normalmente não é vazio — um aluno recém-cadastrado ainda
     assim vê todos os padrões publicados, só que todos agrupados em
     "sem_evidencias". Usa o mesmo sinal `hasAnyEvidence` já exposto por
     `getStudentMetricsSummary` (worker/src/services/studentMetricsService.ts)
     e já usado por src/pages/DashboardPage.tsx para a mesma distinção — com
     fallback calculado localmente a partir de `patterns` caso o resumo
     ainda não tenha chegado (nunca bloqueia a tela por causa de uma
     segunda requisição). */
  const noEvidenceAtAll = summary ? !summary.hasAnyEvidence : patterns.every((p) => p.state === "sem_evidencias");

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return patterns.filter((pattern) => {
      if (stateFilter && pattern.state !== stateFilter) return false;
      if (recentOnly && !isRecentPractice(pattern.lastPracticeAt)) return false;
      if (reviewPendingOnly && pattern.state !== "revisao_pendente") return false;
      if (activeErrorOnly && !pattern.hasActiveErrorEntry) return false;
      if (term && !pattern.name.toLowerCase().includes(term) && !pattern.code.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [patterns, stateFilter, recentOnly, reviewPendingOnly, activeErrorOnly, search]);

  const groups = useMemo(() => {
    return STATE_ORDER.map((state) => ({
      state,
      title: STATE_GROUP_TITLES[state],
      items: filtered.filter((p) => p.state === state),
    })).filter((group) => group.items.length > 0);
  }, [filtered]);

  const resultAnnouncement = useMemo(() => {
    if (phase !== "ready") return "";
    if (filtered.length === 0) return "Nenhum padrão encontrado com os filtros atuais.";
    const noun = filtered.length === 1 ? "padrão encontrado" : "padrões encontrados";
    return `${filtered.length} ${noun}.`;
  }, [phase, filtered]);

  function updateParams(changes: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    setSearchParams(next);
  }

  if (phase === "unavailable") {
    return (
      <div className="mapa-enem mapa-enem--centered">
        <Card className="mapa-enem__card">
          <h1>Mapa ENEM em preparação</h1>
          <p>Esta funcionalidade ainda está em preparação técnica local — ainda não disponível.</p>
        </Card>
      </div>
    );
  }

  if (phase === "error") {
    return <ErrorState description="Não foi possível carregar o Mapa ENEM." action={<Button onClick={() => void load()}>Tentar novamente</Button>} />;
  }

  return (
    <div className="mapa-enem">
      <header className="mapa-enem__header">
        <h1>Mapa ENEM</h1>
        <p className="mapa-enem__intro">
          Uma visão consolidada da sua evidência real por padrão — reunindo o que você já praticou, reconheceu,
          revisou e errou. Nenhum número aqui é inventado: tudo vem de eventos reais registrados no Player, no
          Reconheça o Padrão e no Caderno de Erros.
        </p>
        <p className="mapa-enem__disclaimer" role="note">
          Isto NÃO é uma nota estilo TRI, nem uma nota do ENEM, nem uma declaração definitiva de domínio. É um
          resumo descritivo e provisório da evidência disponível até agora — os rótulos abaixo podem mudar
          conforme você pratica mais.
        </p>
        <details className="mapa-enem__explanation">
          <summary>Como ler esses dados</summary>
          <p>
            Cada padrão recebe um rótulo provisório com base em critérios técnicos combinados — nunca em uma
            fórmula definitiva de reconhecimento, resolução ou domínio (essas fórmulas ainda estão pendentes de
            decisão pedagógica). "Consistente neste recorte" só aparece quando várias condições valem ao mesmo
            tempo: questões distintas praticadas (nunca a mesma questão repetida), prática em mais de um dia,
            taxa de acerto recente, uma revisão correta já confirmada no Caderno de Erros e baixo uso de ajuda —
            taxa de acerto sozinha nunca decide o rótulo. Quando não há nenhuma tentativa confirmada, o padrão
            aparece como "Ainda sem evidências suficientes" — nunca como uma nota zero. Uma revisão vencida no
            Caderno de Erros tem prioridade sobre todos os demais critérios.
          </p>
        </details>
        {summary && (
          <p className="mapa-enem__summary-bar" role="status">
            <span>
              <strong>{summary.totalPublishedPatterns}</strong> padrões publicados
            </span>
            <span>
              <strong>{summary.pendingReviewCount}</strong> com revisão pendente
            </span>
            <span>
              <strong>{formatDate(summary.lastPracticeAt)}</strong> — última prática registrada
            </span>
          </p>
        )}
      </header>

      <div className="mapa-enem__filters">
        <div className="mapa-enem__field">
          <label className="mapa-enem__field-label" htmlFor="mapa-busca">
            Buscar por padrão
          </label>
          <input
            id="mapa-busca"
            type="search"
            value={search}
            placeholder="Nome ou código do padrão"
            onChange={(event) => updateParams({ busca: event.target.value })}
          />
        </div>

        <div className="mapa-enem__field">
          <label className="mapa-enem__field-label" htmlFor="mapa-estado">
            Estado
          </label>
          <select id="mapa-estado" value={stateFilter} onChange={(event) => updateParams({ estado: event.target.value })}>
            <option value="">Todos</option>
            {STATE_ORDER.map((state) => (
              <option key={state} value={state}>
                {STATE_GROUP_TITLES[state]}
              </option>
            ))}
          </select>
        </div>

        <label className="mapa-enem__checkbox-field">
          <input type="checkbox" checked={recentOnly} onChange={(event) => updateParams({ recente: event.target.checked ? "true" : null })} />
          <span>Só prática recente (últimos {RECENT_PRACTICE_WINDOW_DAYS} dias)</span>
        </label>

        <label className="mapa-enem__checkbox-field">
          <input
            type="checkbox"
            checked={reviewPendingOnly}
            onChange={(event) => updateParams({ revisao: event.target.checked ? "true" : null })}
          />
          <span>Só revisão pendente</span>
        </label>

        <label className="mapa-enem__checkbox-field">
          <input type="checkbox" checked={activeErrorOnly} onChange={(event) => updateParams({ caderno: event.target.checked ? "true" : null })} />
          <span>Só com entrada ativa no Caderno de Erros</span>
        </label>
      </div>

      <p className="mapa-enem__results-count" role="status" aria-live="polite">
        {resultAnnouncement}
      </p>

      {phase === "loading" ? (
        <LoadingState label="Carregando o Mapa ENEM…" />
      ) : !hasActiveFilters && noEvidenceAtAll ? (
        <EmptyState
          title="Ainda sem evidências suficientes"
          description="Assim que você começar a praticar questões, reconhecer padrões e revisar erros, a evidência real aparece aqui automaticamente."
          action={
            <Link to="/padroes-enem" className="btn btn--primary">
              <span>Conhecer os padrões</span>
            </Link>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          title="Nenhum padrão encontrado com os filtros atuais"
          description="Ajuste os filtros ou limpe-os para ver todos os padrões."
          action={
            <Button variant="secondary" onClick={() => setSearchParams(new URLSearchParams())}>
              Limpar filtros
            </Button>
          }
        />
      ) : (
        groups.map((group) => (
          <section key={group.state} className="mapa-enem__group" aria-labelledby={`grupo-${group.state}`}>
            <h2 id={`grupo-${group.state}`} className="mapa-enem__group-title">
              {group.title} ({group.items.length})
            </h2>
            <div className="mapa-enem__grid">
              {group.items.map((pattern) => (
                <PatternCard key={pattern.patternId} pattern={pattern} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
