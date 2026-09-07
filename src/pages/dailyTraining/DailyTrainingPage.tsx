import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { LoadingState } from "../../components/LoadingState";
import { Modal } from "../../components/Modal";
import { TrainablePatternGrid } from "../../components/dailyTraining/TrainablePatternGrid";
import {
  DailyTrainingApiError,
  SKIP_REASON_LABELS,
  abandonList,
  applyFocusedTraining,
  completeList,
  fetchCurrent,
  fetchFocusedPreview,
  fetchTrainablePatterns,
  skipItem,
  startItem,
  syncItem,
  type FocusedTrainingPreview,
  type TrainablePattern,
  type TrainingItem,
  type TrainingList,
} from "../../api/dailyTrainingClient";
import "./DailyTrainingPage.css";

/* Tela /treino-diario — Sprint 11 v1.0, evoluída pela Sprint 20 ("Treino
   Diário por Padrão", seção 8 da ordem): sem lista ativa e SEM `patternId`
   na URL, mostra o MESMO seletor "O que você quer treinar hoje?" do
   Dashboard (reaproveita `TrainablePatternGrid`, nunca uma segunda
   implementação); COM `patternId`, mostra o preview focado apenas daquele
   padrão. A antiga prévia adaptativa genérica deixou de ser o fluxo
   OFICIAL desta tela (seção 8: "não exibir lista adaptativa genérica como
   fluxo principal") — os endpoints/serviço antigos continuam existindo no
   Worker por compatibilidade, só não são mais alcançados por esta UI. */

type Phase =
  | "loading"
  | "unavailable"
  | "picker"
  | "pattern_not_found"
  | "no_availability"
  | "empty"
  | "focused_preview"
  | "applying"
  | "active"
  | "completed"
  | "abandoned"
  | "error";

interface DerivedSummary {
  completedCount: number;
  skippedCount: number;
  blockedCount: number;
  correctCount: number;
  incorrectCount: number;
  patternsPracticed: string[];
  reviewsCompleted: number;
  approxMinutes: number;
}

/** Resumo factual (seção 11 da ordem original / seção 16 da ordem Sprint
 *  20) recalculado a partir dos itens da própria lista — nunca depende só
 *  da resposta efêmera de POST .../complete, para que um refresh depois de
 *  concluído mostre exatamente o mesmo resumo. */
function deriveSummary(list: TrainingList): DerivedSummary {
  let completedCount = 0;
  let skippedCount = 0;
  let blockedCount = 0;
  let correctCount = 0;
  let incorrectCount = 0;
  let reviewsCompleted = 0;
  let approxMinutes = 0;
  const patterns = new Set<string>();

  for (const item of list.items) {
    if (item.status === "completed") {
      completedCount++;
      approxMinutes += item.estimatedMinutes;
      if (item.patternName) patterns.add(item.patternName);
      if (item.reason === "overdue_review") reviewsCompleted++;
      if (item.isCorrect === true) correctCount++;
      else if (item.isCorrect === false) incorrectCount++;
    } else if (item.status === "skipped") {
      skippedCount++;
    } else if (item.status === "blocked") {
      blockedCount++;
    }
  }

  return {
    completedCount,
    skippedCount,
    blockedCount,
    correctCount,
    incorrectCount,
    patternsPracticed: Array.from(patterns).sort(),
    reviewsCompleted,
    approxMinutes,
  };
}

function allTerminal(list: TrainingList): boolean {
  return list.items.every((item) => item.status === "completed" || item.status === "skipped" || item.status === "blocked");
}

function ItemStatusLabel({ status }: { status: TrainingItem["status"] }) {
  const labels: Record<TrainingItem["status"], string> = {
    pending: "A fazer",
    in_progress: "Em andamento",
    completed: "Concluído",
    skipped: "Pulado",
    blocked: "Indisponível",
  };
  return <span className={`treino-diario__status treino-diario__status--${status}`}>{labels[status]}</span>;
}

function ItemCard({
  item,
  onStart,
  onSkip,
  busy,
  justSynced,
}: {
  item: TrainingItem;
  onStart: (item: TrainingItem) => void;
  onSkip: (item: TrainingItem) => void;
  busy: boolean;
  justSynced: boolean;
}) {
  return (
    <Card className="treino-diario__item-card">
      <div className="treino-diario__item-header">
        <span className="treino-diario__item-code">{item.questionCode}</span>
        {item.patternName && <span className="treino-diario__item-pattern">{item.patternName}</span>}
        <ItemStatusLabel status={item.status} />
      </div>
      <p className="treino-diario__item-reason">
        <span className="treino-diario__item-reason-label">Por que este item? </span>
        {item.reasonLabel}
      </p>
      <p className="treino-diario__item-minutes">Aproximadamente {item.estimatedMinutes} min</p>
      {justSynced && item.status === "completed" && (
        <p className="treino-diario__saved-indicator" role="status">
          Progresso salvo.
        </p>
      )}
      {item.status === "completed" && item.isCorrect !== null && (
        <p className={`treino-diario__result treino-diario__result--${item.isCorrect ? "correct" : "incorrect"}`}>
          {item.isCorrect ? "Resposta correta." : "Resposta incorreta — registrada no Caderno de Erros."}
        </p>
      )}
      {(item.status === "pending" || item.status === "in_progress") && (
        <div className="treino-diario__item-actions">
          <Button type="button" onClick={() => onStart(item)} isLoading={busy} disabled={busy}>
            {item.status === "in_progress" ? "Continuar questão" : "Começar questão"}
          </Button>
          <Button type="button" variant="secondary" onClick={() => onSkip(item)} disabled={busy}>
            Pular
          </Button>
        </div>
      )}
    </Card>
  );
}

export function DailyTrainingPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const patternId = searchParams.get("patternId");

  const [phase, setPhase] = useState<Phase>("loading");
  const [patterns, setPatterns] = useState<TrainablePattern[] | null>(null);
  const [focusedPreview, setFocusedPreview] = useState<FocusedTrainingPreview | null>(null);
  const [list, setList] = useState<TrainingList | null>(null);
  const [applying, setApplying] = useState(false);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [justSyncedItemId, setJustSyncedItemId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [skipTarget, setSkipTarget] = useState<TrainingItem | null>(null);
  const [skipReason, setSkipReason] = useState<string>("not_now");
  const [completing, setCompleting] = useState(false);
  const syncedOnLoad = useRef(false);

  const loadPicker = useCallback(async () => {
    try {
      const result = await fetchTrainablePatterns();
      if (result.available === false) {
        setPhase("unavailable");
        return;
      }
      setPatterns(result.patterns ?? []);
      setPhase("picker");
    } catch {
      setPhase("error");
    }
  }, []);

  const loadFocusedPreview = useCallback(async (id: string) => {
    try {
      const result = await fetchFocusedPreview(id);
      if (result.available === false) {
        setPhase("unavailable");
        return;
      }
      if (!result.preview) {
        setPhase("error");
        return;
      }
      setFocusedPreview(result.preview);
      if (!result.preview.hasAvailabilityToday) {
        setPhase("no_availability");
      } else if (result.preview.itemCount === 0) {
        setPhase("empty");
      } else {
        setPhase("focused_preview");
      }
    } catch (err) {
      // Seção 7 da ordem — padrão inexistente/não publicado: estado
      // controlado, NUNCA um fallback silencioso para outro padrão.
      if (err instanceof DailyTrainingApiError && err.status === 404) {
        setPhase("pattern_not_found");
        return;
      }
      setPhase("error");
    }
  }, []);

  const load = useCallback(async () => {
    setPhase("loading");
    try {
      const current = await fetchCurrent();
      if (current.available === false) {
        setPhase("unavailable");
        return;
      }
      if (current.list) {
        // Seção 6/14 da ordem — já existe lista ativa (deste padrão ou de
        // outro, aplicada agora ou antes): carrega a lista REAL, nunca
        // volta a oferecer a escolha de padrão nem finge que o
        // `patternId` da URL "ganhou".
        setList(current.list);
        setPhase(current.list.status === "abandoned" ? "abandoned" : "active");
        return;
      }
      if (patternId) {
        await loadFocusedPreview(patternId);
      } else {
        await loadPicker();
      }
    } catch {
      setPhase("error");
    }
  }, [patternId, loadFocusedPreview, loadPicker]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Ao chegar numa lista ativa (inclusive por retomada/refresh), sincroniza
  // silenciosamente qualquer item `in_progress` com a tentativa real do
  // Player (seção 10 da ordem) — cobre o caso "voltar do Player sem perder
  // progresso" mesmo sem o aluno clicar em nada.
  useEffect(() => {
    if (phase !== "active" || !list || syncedOnLoad.current) return;
    syncedOnLoad.current = true;
    const inProgress = list.items.filter((item) => item.status === "in_progress");
    if (inProgress.length === 0) return;
    (async () => {
      let changed = false;
      let syncedId: string | null = null;
      const nextItems = [...list.items];
      for (const item of inProgress) {
        try {
          const result = await syncItem(list.id, item.id);
          if (result.itemStatus === "completed") {
            changed = true;
            syncedId = item.id;
            const index = nextItems.findIndex((i) => i.id === item.id);
            if (index >= 0) nextItems[index] = { ...nextItems[index], status: "completed", isCorrect: result.isCorrect ?? null };
          }
        } catch {
          // Sincronização silenciosa — falha aqui não impede o aluno de
          // continuar usando a tela; o próximo sync tenta de novo.
        }
      }
      if (changed) {
        setList({ ...list, items: nextItems });
        setJustSyncedItemId(syncedId);
      }
    })();
  }, [phase, list]);

  useEffect(() => {
    syncedOnLoad.current = false;
  }, [list?.id]);

  async function handleApply() {
    if (!patternId) return;
    setApplying(true);
    setPhase("applying");
    setActionError(null);
    try {
      const result = await applyFocusedTraining(patternId);
      if (result.empty) {
        await loadFocusedPreview(patternId);
        return;
      }
      if (result.listId) {
        const current = await fetchCurrent();
        if (current.list) {
          setList(current.list);
          setPhase("active");
        } else {
          setPhase("error");
        }
      }
    } catch {
      setActionError("Não foi possível aplicar o treino de hoje agora. Tente novamente.");
      setPhase("focused_preview");
    } finally {
      setApplying(false);
    }
  }

  async function handleStart(item: TrainingItem) {
    if (!list) return;
    setBusyItemId(item.id);
    setActionError(null);
    try {
      const result = await startItem(list.id, item.id);
      if (result.attemptId) {
        navigate(`/tentativas/${result.attemptId}`);
        return;
      }
    } catch {
      setActionError("Não foi possível iniciar esta questão agora. Tente novamente.");
    } finally {
      setBusyItemId(null);
    }
  }

  function requestSkip(item: TrainingItem) {
    setSkipTarget(item);
    setSkipReason("not_now");
  }

  async function confirmSkip() {
    if (!list || !skipTarget) return;
    setBusyItemId(skipTarget.id);
    setActionError(null);
    try {
      await skipItem(list.id, skipTarget.id, skipReason);
      const current = await fetchCurrent();
      if (current.list) setList(current.list);
      setSkipTarget(null);
    } catch {
      setActionError("Não foi possível pular este item agora. Tente novamente.");
    } finally {
      setBusyItemId(null);
    }
  }

  async function handleComplete() {
    if (!list) return;
    setCompleting(true);
    setActionError(null);
    try {
      await completeList(list.id);
      const current = await fetchCurrent();
      // Depois de concluída, a lista deixa de ser "current" (não é mais
      // active) — relê o detalhe diretamente para mostrar o resumo.
      if (current.list && current.list.id === list.id) {
        setList(current.list);
      } else {
        setList({ ...list, status: "completed" });
      }
      setPhase("completed");
    } catch {
      setActionError("Não foi possível concluir o treino agora. Tente novamente.");
    } finally {
      setCompleting(false);
    }
  }

  async function handleAbandon() {
    if (!list) return;
    if (!window.confirm("Abandonar o treino de hoje? Você poderá aplicar um novo treino amanhã.")) return;
    setActionError(null);
    try {
      await abandonList(list.id);
      setList({ ...list, status: "abandoned" });
      setPhase("abandoned");
    } catch {
      setActionError("Não foi possível abandonar o treino agora. Tente novamente.");
    }
  }

  const footerNav = (
    <nav className="treino-diario__footer-nav" aria-label="Outras áreas">
      <Link to="/">Dashboard</Link>
      <Link to="/cronograma">Cronograma</Link>
      <Link to="/caderno-de-erros">Caderno de Erros</Link>
      <Link to="/mapa-enem">Mapa ENEM</Link>
    </nav>
  );

  if (phase === "loading") {
    return <LoadingState label="Carregando o treino de hoje…" />;
  }

  if (phase === "unavailable") {
    return (
      <div className="treino-diario treino-diario--centered">
        <Card>
          <h1>Ainda não há questões disponíveis</h1>
          <p>O Treino Diário já está pronto tecnicamente, mas nenhuma questão está disponível para praticar neste ambiente agora.</p>
        </Card>
      </div>
    );
  }

  if (phase === "error") {
    return <ErrorState description="Não foi possível carregar o treino de hoje." action={<Button onClick={() => void load()}>Tentar novamente</Button>} />;
  }

  if (phase === "picker") {
    return (
      <div className="treino-diario">
        <header className="treino-diario__header">
          <h1>O que você quer treinar hoje?</h1>
          <p className="treino-diario__welcome">Escolha um padrão e faça seu treino de hoje.</p>
        </header>
        {patterns && <TrainablePatternGrid patterns={patterns} />}
        {footerNav}
      </div>
    );
  }

  if (phase === "pattern_not_found") {
    return (
      <div className="treino-diario">
        <header className="treino-diario__header">
          <h1>Treino Diário</h1>
        </header>
        <EmptyState
          title="Este padrão não está disponível"
          description="O padrão escolhido não existe ou não está mais publicado."
          action={
            <Button type="button" onClick={() => navigate("/treino-diario")}>
              Escolher outro padrão
            </Button>
          }
        />
        {footerNav}
      </div>
    );
  }

  if (phase === "no_availability") {
    return (
      <div className="treino-diario">
        <header className="treino-diario__header">
          <h1>Treino Diário</h1>
          <p className="treino-diario__welcome">Foco hoje, vitória no ENEM.</p>
        </header>
        <EmptyState
          title="Sem disponibilidade configurada para hoje"
          description="Sua configuração atual não inclui o dia de hoje entre os dias disponíveis para estudar, ou o tempo diário está zerado. Ajuste em Configurações para ver o treino de hoje."
          action={
            <Link to="/configuracoes" className="btn btn--primary">
              <span>Ajustar disponibilidade</span>
            </Link>
          }
        />
        {footerNav}
      </div>
    );
  }

  if (phase === "empty") {
    return (
      <div className="treino-diario">
        <header className="treino-diario__header">
          <h1>Treino Diário</h1>
          {focusedPreview && <p className="treino-diario__welcome">{focusedPreview.focusPattern.name}</p>}
        </header>
        <EmptyState
          title="Este padrão ainda não tem questões disponíveis para treino"
          description="Ainda não há questões publicadas suficientes para este padrão. Volte mais tarde — o catálogo cresce continuamente."
          action={
            <Button type="button" onClick={() => navigate("/treino-diario")}>
              Escolher outro padrão
            </Button>
          }
        />
        {footerNav}
      </div>
    );
  }

  if (phase === "focused_preview" && focusedPreview) {
    return (
      <div className="treino-diario">
        <header className="treino-diario__header">
          <h1>Treino de {focusedPreview.focusPattern.name}</h1>
          <p className="treino-diario__welcome">Foco total neste padrão hoje.</p>
        </header>

        <Card className="treino-diario__preview-card">
          <p className="treino-diario__preview-stat">
            <strong>{focusedPreview.itemCount}</strong> {focusedPreview.itemCount === 1 ? "questão" : "questões"} — aproximadamente{" "}
            <strong>{focusedPreview.estimatedMinutes} min</strong>
          </p>

          <ul className="treino-diario__preview-items">
            {focusedPreview.items.map((item) => (
              <li key={item.questionId}>
                <span className="treino-diario__item-code">{item.questionCode}</span>
                <p className="treino-diario__item-reason">{item.reasonLabel}</p>
              </li>
            ))}
          </ul>

          {actionError && (
            <p className="treino-diario__error-indicator" role="alert">
              {actionError}
            </p>
          )}

          <div className="treino-diario__preview-actions">
            <Button type="button" onClick={() => void handleApply()} isLoading={applying} disabled={applying}>
              Começar treino
            </Button>
            <Button type="button" variant="secondary" onClick={() => navigate("/treino-diario")} disabled={applying}>
              Escolher outro padrão
            </Button>
          </div>
        </Card>
        {footerNav}
      </div>
    );
  }

  if (phase === "applying") {
    return <LoadingState label="Montando o seu treino de hoje…" />;
  }

  if ((phase === "active" || phase === "completed" || phase === "abandoned") && list) {
    const done = list.items.filter((item) => item.status === "completed" || item.status === "skipped" || item.status === "blocked").length;
    const isCompleted = phase === "completed" || list.status === "completed";
    const isAbandoned = phase === "abandoned" || list.status === "abandoned";

    if (isCompleted) {
      const summary = deriveSummary(list);
      // Seção 16 da ordem — acurácia só é mostrada com ≥1 resposta
      // CONFIRMADA (correta ou incorreta); puladas/bloqueadas nunca entram
      // no denominador. Nunca "0%" quando não há resposta nenhuma.
      const totalConfirmed = summary.correctCount + summary.incorrectCount;
      const accuracyPercent = totalConfirmed > 0 ? Math.round((summary.correctCount / totalConfirmed) * 100) : null;
      const incorrectItems = list.items.filter((item) => item.status === "completed" && item.isCorrect === false);

      return (
        <div className="treino-diario">
          <header className="treino-diario__header">
            <h1>Treino concluído</h1>
            <p className="treino-diario__welcome">
              {list.focusPattern ? `Bom trabalho no treino de ${list.focusPattern.name}!` : "Bom trabalho! Aqui está o resumo factual do que você fez hoje."}
            </p>
          </header>
          <Card className="treino-diario__summary-card">
            <p>
              <strong>{summary.completedCount}</strong> {summary.completedCount === 1 ? "questão concluída" : "questões concluídas"}
            </p>
            {summary.skippedCount > 0 && (
              <p>
                <strong>{summary.skippedCount}</strong> {summary.skippedCount === 1 ? "questão pulada" : "questões puladas"}
              </p>
            )}
            {summary.blockedCount > 0 && (
              <p>
                <strong>{summary.blockedCount}</strong> {summary.blockedCount === 1 ? "questão indisponível" : "questões indisponíveis"}
              </p>
            )}
            <p>
              Aproximadamente <strong>{summary.approxMinutes} min</strong> registrados.
            </p>
            {totalConfirmed > 0 ? (
              <p>
                <strong>{summary.correctCount}</strong> acertos e <strong>{summary.incorrectCount}</strong> erros confirmados — <strong>{accuracyPercent}%</strong> de
                acerto.
              </p>
            ) : (
              <p>Nenhuma questão respondida foi registrada neste treino.</p>
            )}
            {summary.reviewsCompleted > 0 && (
              <p>
                <strong>{summary.reviewsCompleted}</strong> {summary.reviewsCompleted === 1 ? "revisão realizada" : "revisões realizadas"}.
              </p>
            )}
            {summary.patternsPracticed.length > 0 && <p>Padrões praticados: {summary.patternsPracticed.join(", ")}.</p>}

            {list.focusPattern?.mainStrategy && (
              <section className="treino-diario__macete" aria-labelledby="macete-heading">
                <h2 id="macete-heading">Macete / Como resolver</h2>
                <p>{list.focusPattern.mainStrategy}</p>
              </section>
            )}

            {incorrectItems.length > 0 && (
              <section className="treino-diario__review-cta" aria-labelledby="vale-revisar-heading">
                <h2 id="vale-revisar-heading">Vale revisar</h2>
                <p>
                  <strong>{incorrectItems.length}</strong> {incorrectItems.length === 1 ? "questão incorreta" : "questões incorretas"}:{" "}
                  {incorrectItems.map((item) => item.questionCode).join(", ")}.
                </p>
                <Link to="/caderno-de-erros" className="btn btn--secondary">
                  <span>Ver Caderno de Erros</span>
                </Link>
              </section>
            )}
          </Card>
          {footerNav}
        </div>
      );
    }

    if (isAbandoned) {
      return (
        <div className="treino-diario">
          <header className="treino-diario__header">
            <h1>Treino abandonado</h1>
            <p className="treino-diario__welcome">Sem problema — você pode montar um novo treino amanhã.</p>
          </header>
          {footerNav}
        </div>
      );
    }

    return (
      <div className="treino-diario">
        <header className="treino-diario__header">
          <h1>{list.focusPattern ? `Treino de ${list.focusPattern.name}` : "Treino Diário"}</h1>
          <p className="treino-diario__welcome">Foco hoje, vitória no ENEM.</p>
        </header>

        <Card className="treino-diario__progress-card">
          <p className="treino-diario__preview-stat" role="status" aria-live="polite">
            Progresso: <strong>{done}</strong> de <strong>{list.itemCount}</strong> · aproximadamente{" "}
            <strong>{list.estimatedMinutes} min</strong> no total
          </p>
        </Card>

        {actionError && (
          <p className="treino-diario__error-indicator" role="alert">
            {actionError}
          </p>
        )}

        <div className="treino-diario__items">
          {list.items.map((item) => (
            <ItemCard
              key={item.id}
              item={item}
              onStart={(target) => void handleStart(target)}
              onSkip={requestSkip}
              busy={busyItemId === item.id}
              justSynced={justSyncedItemId === item.id}
            />
          ))}
        </div>

        <div className="treino-diario__list-actions">
          {allTerminal(list) && (
            <Button type="button" onClick={() => void handleComplete()} isLoading={completing} disabled={completing}>
              Concluir treino
            </Button>
          )}
          <Button type="button" variant="text" onClick={() => void handleAbandon()}>
            Abandonar treino por hoje
          </Button>
        </div>

        {footerNav}

        <Modal isOpen={skipTarget !== null} title="Pular esta questão?" onClose={() => setSkipTarget(null)}>
          <div className="treino-diario__skip-modal">
            <label className="treino-diario__skip-label" htmlFor="skip-reason-select">
              Motivo
            </label>
            <select id="skip-reason-select" value={skipReason} onChange={(event) => setSkipReason(event.target.value)}>
              {Object.entries(SKIP_REASON_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <div className="treino-diario__skip-actions">
              <Button type="button" variant="secondary" onClick={() => setSkipTarget(null)}>
                Cancelar
              </Button>
              <Button type="button" onClick={() => void confirmSkip()} isLoading={busyItemId === skipTarget?.id}>
                Confirmar
              </Button>
            </div>
          </div>
        </Modal>
      </div>
    );
  }

  return <LoadingState label="Carregando o treino de hoje…" />;
}
