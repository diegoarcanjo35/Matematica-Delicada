import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { LoadingState } from "../../components/LoadingState";
import { fetchPatterns, type PatternSummary } from "../../api/patternsClient";
import {
  ALLOWED_BLOCK_SIZES,
  SimulationsApiError,
  applyBlock,
  fetchCurrent,
  fetchHistory,
  fetchPreview,
  type HistoryEntry,
  type Preview,
  type SimulationBlockSize,
  type SimulationBlockType,
} from "../../api/simulationsClient";
import "./Simulados.css";

/* Tela /simulados — Sprint 12 v1.0, seção 15 da ordem. Estados mínimos
   exigidos por esta rota: carregando, nenhuma questão elegível (dentro da
   prévia), configuração do bloco, preview, quantidade insuficiente (parte
   do preview), aplicando, erro recuperável, histórico vazio, histórico com
   dados. "bloco ativo"/"item em andamento"/"retomada"/"conclusão"/
   "abandono" pertencem à rota /simulados/:blockId (SimuladoBlocoPage.tsx) —
   um bloco ativo encontrado aqui redireciona automaticamente para lá (nunca
   duplica a interface do bloco nesta tela de configuração). */

type Phase = "loading" | "unavailable" | "config" | "preview" | "applying" | "error";

function useAvailablePatterns() {
  const [patterns, setPatterns] = useState<PatternSummary[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    // PATTERNS_MAX_LIMIT (worker/src/lib/patternsValidation.ts) é 50 — pedir
    // mais que isso é rejeitado (400), nunca saturado silenciosamente.
    fetchPatterns({ limite: 50 })
      .then((result) => {
        if (!cancelled && result.available && result.patterns) setPatterns(result.patterns);
      })
      .catch(() => {
        // Sem catálogo disponível — o seletor de padrão fica vazio; o modo
        // misto continua funcionando normalmente.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return patterns;
}

function HistorySection() {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchHistory()
      .then((result) => {
        if (!cancelled) setEntries(result.entries);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (entries === null) return null;

  return (
    <section aria-labelledby="simulados-historico-heading" className="simulados__history">
      <h2 id="simulados-historico-heading">Histórico de simulados</h2>
      {entries.length === 0 ? (
        <EmptyState
          title="Nenhum bloco concluído ainda"
          description="Quando você concluir ou abandonar um bloco de simulado, ele aparece aqui — sem nota, sem ranking, só os fatos."
        />
      ) : (
        <ul className="simulados__history-list">
          {entries.map((entry) => (
            <li key={entry.id} className="simulados__history-item">
              <span className="simulados__history-date">{entry.blockDate}</span>
              <span className="simulados__history-type">
                {entry.blockType === "mixed" ? "Misto" : `Focado — ${entry.primaryPatternName ?? "padrão"}`}
              </span>
              <span className="simulados__history-status">{entry.status === "completed" ? "Concluído" : "Abandonado"}</span>
              <span className="simulados__history-stats">
                {entry.completedCount} questões concluídas · {entry.correctCount} acertos · {entry.incorrectCount} erros · aproximadamente{" "}
                {entry.estimatedMinutes} min
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function SimuladosPage() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("loading");
  const [blockType, setBlockType] = useState<SimulationBlockType>("mixed");
  const [patternSlug, setPatternSlug] = useState<string>("");
  const [size, setSize] = useState<SimulationBlockSize>(5);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const patterns = useAvailablePatterns();

  const checkActive = useCallback(async () => {
    setPhase("loading");
    try {
      const current = await fetchCurrent();
      if (current.available === false) {
        setPhase("unavailable");
        return;
      }
      if (current.block && current.block.status === "active") {
        // Seção 16 da ordem: "nenhuma leitura do Dashboard/config pode
        // criar bloco" — aqui só REDIRECIONA para o bloco JÁ existente,
        // nunca cria nada.
        navigate(`/simulados/${current.block.id}`, { replace: true });
        return;
      }
      setPhase("config");
    } catch {
      setPhase("error");
    }
  }, [navigate]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void checkActive();
  }, [checkActive]);

  async function handlePreview() {
    setPreviewError(null);
    setPreview(null);
    setPhase("preview");
    try {
      const result = await fetchPreview({ blockType, patternSlug: blockType === "pattern_focused" ? patternSlug : undefined, size });
      if (result.available === false) {
        setPhase("unavailable");
        return;
      }
      if (!result.preview) {
        setPhase("config");
        setPreviewError("Não foi possível montar a prévia agora. Tente novamente.");
        return;
      }
      setPreview(result.preview);
    } catch (error) {
      setPhase("config");
      if (error instanceof SimulationsApiError && error.status === 404) {
        setPreviewError("Este padrão não está disponível.");
      } else {
        setPreviewError("Não foi possível montar a prévia agora. Tente novamente.");
      }
    }
  }

  async function handleApply() {
    setApplying(true);
    setApplyError(null);
    setPhase("applying");
    try {
      const result = await applyBlock({ blockType, patternSlug: blockType === "pattern_focused" ? patternSlug : undefined, size });
      if (result.empty) {
        setApplyError("Não há questões publicadas suficientes para montar este bloco agora.");
        setPhase("preview");
        return;
      }
      if (result.blockId) {
        navigate(`/simulados/${result.blockId}`);
      }
    } catch (error) {
      setPhase("preview");
      if (error instanceof SimulationsApiError && error.fields.block) {
        setApplyError(error.fields.block);
      } else {
        setApplyError("Não foi possível criar o bloco agora. Tente novamente.");
      }
    } finally {
      setApplying(false);
    }
  }

  if (phase === "loading") {
    return <LoadingState label="Verificando seus simulados…" />;
  }

  if (phase === "unavailable") {
    return (
      <div className="simulados simulados--centered">
        <Card>
          <h1>Ainda não há questões disponíveis</h1>
          <p>Os Simulados em Blocos já estão prontos tecnicamente, mas nenhuma questão está disponível para montar um simulado neste ambiente agora.</p>
        </Card>
      </div>
    );
  }

  if (phase === "error") {
    return <ErrorState description="Não foi possível carregar os simulados agora." action={<Button onClick={() => void checkActive()}>Tentar novamente</Button>} />;
  }

  if (phase === "applying") {
    return <LoadingState label="Aplicando o bloco…" />;
  }

  const publishedPatterns = patterns ?? [];

  return (
    <div className="simulados">
      <header className="simulados__header">
        <h1>Simulados em blocos</h1>
        <p className="simulados__welcome">
          Prática em formato de simulado, com questões reais do Banco de Questões. Este bloco{" "}
          <strong>não é a prova oficial do ENEM</strong> e não calcula TRI, nota estimada nem qualquer previsão de aprovação.
        </p>
      </header>

      <Card className="simulados__config-card">
        <h2>Configurar bloco</h2>

        <fieldset className="simulados__field">
          <legend>Tipo de bloco</legend>
          <label className="simulados__radio">
            <input type="radio" name="blockType" value="mixed" checked={blockType === "mixed"} onChange={() => setBlockType("mixed")} />
            <span>Misto — questões distribuídas entre padrões publicados</span>
          </label>
          <label className="simulados__radio">
            <input
              type="radio"
              name="blockType"
              value="pattern_focused"
              checked={blockType === "pattern_focused"}
              onChange={() => setBlockType("pattern_focused")}
            />
            <span>Focado em um padrão</span>
          </label>
        </fieldset>

        {blockType === "pattern_focused" && (
          <div className="simulados__field">
            <label htmlFor="pattern-select">Padrão</label>
            <select id="pattern-select" value={patternSlug} onChange={(event) => setPatternSlug(event.target.value)}>
              <option value="">Selecione um padrão publicado</option>
              {publishedPatterns.map((pattern) => (
                <option key={pattern.slug} value={pattern.slug}>
                  {pattern.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <fieldset className="simulados__field">
          <legend>Quantidade de questões</legend>
          {ALLOWED_BLOCK_SIZES.map((option) => (
            <label key={option} className="simulados__radio">
              <input type="radio" name="size" checked={size === option} onChange={() => setSize(option)} />
              <span>{option} questões</span>
            </label>
          ))}
        </fieldset>

        {previewError && (
          <p className="simulados__error-indicator" role="alert">
            {previewError}
          </p>
        )}

        <Button
          type="button"
          onClick={() => void handlePreview()}
          disabled={blockType === "pattern_focused" && !patternSlug}
        >
          Ver prévia
        </Button>
      </Card>

      {phase === "preview" && preview && (
        <Card className="simulados__preview-card">
          <h2>Prévia do bloco</h2>
          <p className="simulados__disclaimer">
            Aviso: esta prévia e o bloco resultante <strong>não são a prova oficial do ENEM</strong> e não calculam nota TRI nem
            qualquer equivalência com o exame oficial.
          </p>
          <p className="simulados__preview-stat">
            <strong>{preview.selectableCount}</strong> de <strong>{preview.requestedSize}</strong> questões pedidas — aproximadamente{" "}
            <strong>{preview.estimatedMinutes} min</strong>
          </p>
          {preview.insufficientQuantity && (
            <p className="simulados__warning" role="status">
              Ainda não há questões publicadas suficientes para o tamanho pedido. O bloco será criado com{" "}
              {preview.selectableCount} {preview.selectableCount === 1 ? "questão" : "questões"} disponíveis agora.
            </p>
          )}
          {preview.selectableCount === 0 ? (
            <EmptyState title="Nenhuma questão elegível" description="Ainda não há questões publicadas suficientes para este bloco. Volte mais tarde." />
          ) : (
            <>
              <section aria-labelledby="simulados-composicao-heading" className="simulados__composition">
                <h3 id="simulados-composicao-heading">Composição</h3>
                <ul>
                  {preview.composition.map((entry) => (
                    <li key={entry.patternId}>
                      <strong>{entry.count}</strong> — {entry.patternName}
                    </li>
                  ))}
                </ul>
              </section>

              {applyError && (
                <p className="simulados__error-indicator" role="alert">
                  {applyError}
                </p>
              )}

              <Button type="button" onClick={() => void handleApply()} isLoading={applying} disabled={applying}>
                Criar bloco
              </Button>
            </>
          )}
        </Card>
      )}

      <HistorySection />

      <nav className="simulados__footer-nav" aria-label="Outras áreas">
        <Link to="/">Dashboard</Link>
        <Link to="/treino-diario">Treino Diário</Link>
        <Link to="/caderno-de-erros">Caderno de Erros</Link>
        <Link to="/mapa-enem">Mapa ENEM</Link>
      </nav>
    </div>
  );
}
