import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { ErrorState } from "../../components/ErrorState";
import { LoadingState } from "../../components/LoadingState";
import { Modal } from "../../components/Modal";
import {
  abandonBlock,
  completeBlock,
  fetchBlockDetail,
  skipItem,
  startItem,
  syncItem,
  type Block,
  type BlockItem,
  type CompletionSummary,
} from "../../api/simulationsClient";
import "./Simulados.css";

/* Tela /simulados/:blockId — Sprint 12 v1.0, seção 15 da ordem. Estados
   mínimos exigidos por esta rota: carregando, bloco ativo, item em
   andamento, retomada após refresh, progresso salvo, erro recuperável,
   conclusão, abandono. Nunca duplica a interface interna do Player — iniciar
   uma questão navega para /tentativas/:attemptId, o Player real (Sprint 8),
   e o retorno para esta tela sincroniza silenciosamente (seção 11 da
   ordem: cronômetro é informativo, tempo aproximado, sem fiscalização). */

type Phase = "loading" | "notFound" | "active" | "completed" | "abandoned" | "error";

function allTerminal(block: Block): boolean {
  return block.items.every((item) => item.status === "completed" || item.status === "skipped" || item.status === "blocked");
}

function ItemStatusLabel({ status }: { status: BlockItem["status"] }) {
  const labels: Record<BlockItem["status"], string> = {
    pending: "A fazer",
    in_progress: "Em andamento",
    completed: "Concluído",
    skipped: "Pulado",
    blocked: "Indisponível",
  };
  return <span className={`simulados__status simulados__status--${status}`}>{labels[status]}</span>;
}

function ItemCard({
  item,
  index,
  total,
  onStart,
  onSkip,
  busy,
  justSynced,
}: {
  item: BlockItem;
  index: number;
  total: number;
  onStart: (item: BlockItem) => void;
  onSkip: (item: BlockItem) => void;
  busy: boolean;
  justSynced: boolean;
}) {
  return (
    <Card className="simulados__item-card">
      <div className="simulados__item-header">
        <span className="simulados__item-position">
          Questão {index + 1} de {total}
        </span>
        <ItemStatusLabel status={item.status} />
      </div>
      <div className="simulados__item-meta">
        <span className="simulados__item-code">{item.questionCode}</span>
        {item.patternName && <span className="simulados__item-pattern">{item.patternName}</span>}
      </div>
      <p className="simulados__item-minutes">Aproximadamente {item.estimatedMinutes} min</p>
      {justSynced && item.status === "completed" && (
        <p className="simulados__saved-indicator" role="status">
          Progresso salvo.
        </p>
      )}
      {item.status === "completed" && item.isCorrect !== null && (
        <p className={`simulados__result simulados__result--${item.isCorrect ? "correct" : "incorrect"}`}>
          {item.isCorrect ? "Resposta correta." : "Resposta incorreta — registrada no Caderno de Erros."}
        </p>
      )}
      {(item.status === "pending" || item.status === "in_progress") && (
        <div className="simulados__item-actions">
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

function SummaryCard({ summary }: { summary: CompletionSummary }) {
  return (
    <Card className="simulados__summary-card">
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
        <strong>{summary.correctCount}</strong> acertos e <strong>{summary.incorrectCount}</strong> erros confirmados.
      </p>
      {summary.accuracyPercent !== null && (
        <p className="simulados__accuracy">
          <strong>{summary.accuracyPercent}%</strong> de acerto neste bloco.
        </p>
      )}
      <p>
        Tempo total aproximado: <strong>{summary.approxMinutes} min</strong>
        {summary.approxMinutesPerQuestion !== null && <> — média aproximada de {summary.approxMinutesPerQuestion} min por questão.</>}
      </p>
      {summary.helpsUsedCount > 0 && (
        <p>
          <strong>{summary.helpsUsedCount}</strong> {summary.helpsUsedCount === 1 ? "questão usou ajuda." : "questões usaram ajuda."}
        </p>
      )}
      {summary.patternsPracticed.length > 0 && <p>Padrões praticados: {summary.patternsPracticed.join(", ")}.</p>}
      <p className="simulados__disclaimer">
        Este resultado é factual — não representa nota ENEM, TRI, projeção de aprovação nem comparação com outros alunos.
      </p>
    </Card>
  );
}

export function SimuladoBlocoPage() {
  const { blockId } = useParams<{ blockId: string }>();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("loading");
  const [block, setBlock] = useState<Block | null>(null);
  const [summary, setSummary] = useState<CompletionSummary | null>(null);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [justSyncedItemId, setJustSyncedItemId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [skipTarget, setSkipTarget] = useState<BlockItem | null>(null);
  const [completing, setCompleting] = useState(false);
  const syncedOnLoad = useRef(false);

  const load = useCallback(async () => {
    if (!blockId) return;
    setPhase("loading");
    try {
      const result = await fetchBlockDetail(blockId);
      if (result.available === false) {
        setPhase("error");
        return;
      }
      if (!result.block) {
        setPhase("notFound");
        return;
      }
      setBlock(result.block);
      if (result.block.status === "completed") setPhase("completed");
      else if (result.block.status === "abandoned") setPhase("abandoned");
      else setPhase("active");
    } catch {
      setPhase("error");
    }
  }, [blockId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Retomada após refresh (seção 11 da ordem: "refresh e reabertura retomam
  // o mesmo bloco") — sincroniza silenciosamente qualquer item in_progress
  // com a tentativa real do Player ao chegar num bloco ativo.
  useEffect(() => {
    if (phase !== "active" || !block || syncedOnLoad.current) return;
    syncedOnLoad.current = true;
    const inProgress = block.items.filter((item) => item.status === "in_progress");
    if (inProgress.length === 0) return;
    (async () => {
      let changed = false;
      let syncedId: string | null = null;
      const nextItems = [...block.items];
      for (const item of inProgress) {
        try {
          const result = await syncItem(block.id, item.id);
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
        setBlock({ ...block, items: nextItems });
        setJustSyncedItemId(syncedId);
      }
    })();
  }, [phase, block]);

  useEffect(() => {
    syncedOnLoad.current = false;
  }, [block?.id]);

  async function handleStart(item: BlockItem) {
    if (!block) return;
    setBusyItemId(item.id);
    setActionError(null);
    try {
      const result = await startItem(block.id, item.id);
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

  function requestSkip(item: BlockItem) {
    setSkipTarget(item);
  }

  async function confirmSkip() {
    if (!block || !skipTarget) return;
    setBusyItemId(skipTarget.id);
    setActionError(null);
    try {
      await skipItem(block.id, skipTarget.id);
      const result = await fetchBlockDetail(block.id);
      if (result.block) setBlock(result.block);
      setSkipTarget(null);
    } catch {
      setActionError("Não foi possível pular este item agora. Tente novamente.");
    } finally {
      setBusyItemId(null);
    }
  }

  async function handleComplete() {
    if (!block) return;
    setCompleting(true);
    setActionError(null);
    try {
      const result = await completeBlock(block.id);
      setSummary(result.summary ?? null);
      setPhase("completed");
    } catch {
      setActionError("Não foi possível concluir o bloco agora. Tente novamente.");
    } finally {
      setCompleting(false);
    }
  }

  async function handleAbandon() {
    if (!block) return;
    if (!window.confirm("Abandonar este bloco de simulado? Você poderá aplicar um novo bloco depois.")) return;
    setActionError(null);
    try {
      await abandonBlock(block.id);
      setPhase("abandoned");
    } catch {
      setActionError("Não foi possível abandonar o bloco agora. Tente novamente.");
    }
  }

  const footerNav = (
    <nav className="simulados__footer-nav" aria-label="Outras áreas">
      <Link to="/simulados">Simulados</Link>
      <Link to="/">Dashboard</Link>
      <Link to="/caderno-de-erros">Caderno de Erros</Link>
      <Link to="/mapa-enem">Mapa ENEM</Link>
      <Link to="/treino-diario">Treino Diário</Link>
    </nav>
  );

  if (phase === "loading") {
    return <LoadingState label="Carregando o bloco de simulado…" />;
  }

  if (phase === "notFound") {
    return <ErrorState description="Este bloco de simulado não foi encontrado." action={<Link to="/simulados">Voltar para Simulados</Link>} />;
  }

  if (phase === "error") {
    return <ErrorState description="Não foi possível carregar este bloco agora." action={<Button onClick={() => void load()}>Tentar novamente</Button>} />;
  }

  if (phase === "completed" && block) {
    return (
      <div className="simulados">
        <header className="simulados__header">
          <h1>Bloco concluído</h1>
          <p className="simulados__welcome">Aqui está o resumo factual do que você fez neste bloco.</p>
        </header>
        {summary ? <SummaryCard summary={summary} /> : <LoadingState label="Calculando o resumo…" />}
        {footerNav}
      </div>
    );
  }

  if (phase === "abandoned") {
    return (
      <div className="simulados">
        <header className="simulados__header">
          <h1>Bloco abandonado</h1>
          <p className="simulados__welcome">Sem problema — você pode aplicar um novo bloco quando quiser.</p>
        </header>
        {footerNav}
      </div>
    );
  }

  if (!block) return <LoadingState label="Carregando o bloco de simulado…" />;

  const done = block.items.filter((item) => item.status === "completed" || item.status === "skipped" || item.status === "blocked").length;

  return (
    <div className="simulados">
      <header className="simulados__header">
        <h1>{block.blockType === "mixed" ? "Bloco misto" : `Bloco focado — ${block.primaryPatternName ?? ""}`}</h1>
        <p className="simulados__disclaimer">
          Prática em formato de simulado — não é a prova oficial do ENEM, sem cálculo de nota TRI.
        </p>
      </header>

      <Card className="simulados__progress-card">
        <p className="simulados__preview-stat" role="status" aria-live="polite">
          Progresso: <strong>{done}</strong> de <strong>{block.actualItemCount}</strong> · aproximadamente{" "}
          <strong>{block.estimatedMinutes} min</strong> no total
        </p>
      </Card>

      {actionError && (
        <p className="simulados__error-indicator" role="alert">
          {actionError}
        </p>
      )}

      <div className="simulados__items">
        {block.items.map((item, index) => (
          <ItemCard
            key={item.id}
            item={item}
            index={index}
            total={block.actualItemCount}
            onStart={(target) => void handleStart(target)}
            onSkip={requestSkip}
            busy={busyItemId === item.id}
            justSynced={justSyncedItemId === item.id}
          />
        ))}
      </div>

      <div className="simulados__list-actions">
        {allTerminal(block) && (
          <Button type="button" onClick={() => void handleComplete()} isLoading={completing} disabled={completing}>
            Concluir bloco
          </Button>
        )}
        <Button type="button" variant="text" onClick={() => void handleAbandon()}>
          Abandonar bloco
        </Button>
      </div>

      {footerNav}

      <Modal isOpen={skipTarget !== null} title="Pular esta questão?" onClose={() => setSkipTarget(null)}>
        <div className="simulados__skip-modal">
          <p>Você poderá revisar este padrão depois pelo Caderno de Erros ou pelo Treino Diário.</p>
          <div className="simulados__skip-actions">
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
