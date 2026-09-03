import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { ErrorState } from "../../components/ErrorState";
import { LoadingState } from "../../components/LoadingState";
import { Modal } from "../../components/Modal";
import { fetchAttempt, type AttemptState } from "../../api/playerClient";
import {
  ERROR_TYPE_LABELS,
  STATUS_LABELS,
  archiveEntry,
  fetchEntry,
  patchEntry,
  startReview,
  type EntryDetail,
  type ErrorType,
} from "../../api/errorNotebookClient";
import { computePayloadSignature, resolveMutationId, type MutationRetryState } from "../editorial/mutationId";
import "./ErrorNotebookPage.css";

/* Detalhes /caderno-de-erros/:id — Sprint 9 v1.0, seção 12.2 da ordem. */

const ERROR_TYPE_OPTIONS = Object.entries(ERROR_TYPE_LABELS) as Array<[ErrorType, string]>;

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "data indisponível";
  return date.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function ErrorNotebookDetailPage() {
  const { entryId } = useParams<{ entryId: string }>();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<"loading" | "ready" | "unavailable" | "notFound" | "error">("loading");
  const [entry, setEntry] = useState<EntryDetail | null>(null);
  const [originalAttempt, setOriginalAttempt] = useState<AttemptState | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const [errorTypeDraft, setErrorTypeDraft] = useState<ErrorType>("unclassified");
  const [noteDraft, setNoteDraft] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const errorTypeRetry = useRef<MutationRetryState | null>(null);
  const noteRetry = useRef<MutationRetryState | null>(null);

  const [startingReview, setStartingReview] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [showArchiveModal, setShowArchiveModal] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const archiveRetry = useRef<MutationRetryState | null>(null);

  const load = useCallback(async () => {
    if (!entryId) {
      setPhase("notFound");
      return;
    }
    setPhase("loading");
    try {
      const result = await fetchEntry(entryId);
      if (result.available === false) {
        setPhase("unavailable");
        return;
      }
      if (!result.entry) {
        setPhase("notFound");
        return;
      }
      setEntry(result.entry);
      setErrorTypeDraft(result.entry.errorType);
      setNoteDraft(result.entry.studentNote ?? "");
      try {
        const attemptResult = await fetchAttempt(result.entry.originalAttemptId ?? "");
        if (attemptResult.available !== false && attemptResult.attempt) setOriginalAttempt(attemptResult.attempt);
      } catch {
        // Sem a tentativa original disponível, os detalhes do Caderno ainda
        // são exibidos — só a seção da questão original fica ausente.
      }
      setPhase("ready");
    } catch {
      setPhase("error");
    }
  }, [entryId]);

  // A tentativa original não vem no DTO da entrada — precisamos do id dela.
  // O fetchEntry já devolve `originalAttemptId`? Ver EntryDetail abaixo.

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  useEffect(() => {
    headingRef.current?.focus();
  }, [phase]);

  async function handleSaveErrorType() {
    if (!entry || !entryId) return;
    if (errorTypeDraft === entry.errorType) return;
    setSaveState("saving");
    const payload = { errorType: errorTypeDraft };
    const mutationId = resolveMutationId(errorTypeRetry.current, computePayloadSignature(payload));
    errorTypeRetry.current = { mutationId, payloadSignature: computePayloadSignature(payload) };
    try {
      await patchEntry(entryId, { errorType: errorTypeDraft, expectedVersion: entry.version, mutationId });
      errorTypeRetry.current = null;
      setSaveState("saved");
      await load();
    } catch {
      setSaveState("error");
    }
  }

  async function handleSaveNote() {
    if (!entry || !entryId) return;
    const normalized = noteDraft.trim();
    if (normalized === (entry.studentNote ?? "")) return;
    setSaveState("saving");
    const payload = { studentNote: normalized || null };
    const mutationId = resolveMutationId(noteRetry.current, computePayloadSignature(payload));
    noteRetry.current = { mutationId, payloadSignature: computePayloadSignature(payload) };
    try {
      await patchEntry(entryId, { studentNote: normalized || null, expectedVersion: entry.version, mutationId });
      noteRetry.current = null;
      setSaveState("saved");
      await load();
    } catch {
      setSaveState("error");
    }
  }

  async function handleStartReview() {
    if (!entryId) return;
    setStartingReview(true);
    setStartError(null);
    try {
      const result = await startReview(entryId);
      if (result.attemptId) navigate(`/tentativas/${result.attemptId}`);
    } catch {
      setStartError("Não foi possível iniciar a revisão agora. Tente novamente.");
      setStartingReview(false);
    }
  }

  async function handleArchive() {
    if (!entry || !entryId) return;
    setArchiving(true);
    const mutationId = resolveMutationId(archiveRetry.current, "archive");
    archiveRetry.current = { mutationId, payloadSignature: "archive" };
    try {
      await archiveEntry(entryId, entry.version, mutationId);
      archiveRetry.current = null;
      setShowArchiveModal(false);
      await load();
    } catch {
      // Mantém o modal aberto com o botão reabilitado para nova tentativa —
      // o foco gerenciado do Modal (Escape/clique fora) continua disponível.
    } finally {
      setArchiving(false);
    }
  }

  if (phase === "loading") return <LoadingState label="Carregando os detalhes do erro…" />;

  if (phase === "unavailable") {
    return (
      <div className="error-notebook error-notebook--centered">
        <Card className="error-notebook__card">
          <h1 ref={headingRef} tabIndex={-1}>
            Seu Caderno de Erros está vazio
          </h1>
          <p>Ele será preenchido automaticamente quando houver erros para revisar.</p>
        </Card>
      </div>
    );
  }

  if (phase === "notFound") {
    return (
      <div className="error-notebook error-notebook--centered">
        <Card className="error-notebook__card">
          <h1 ref={headingRef} tabIndex={-1}>
            Erro não encontrado
          </h1>
          <p>Esta entrada não existe ou não pertence a você.</p>
          <Link to="/caderno-de-erros" className="btn btn--primary">
            <span>Voltar ao Caderno</span>
          </Link>
        </Card>
      </div>
    );
  }

  if (phase === "error" || !entry) {
    return <ErrorState description="Não foi possível carregar os detalhes." action={<Button onClick={() => void load()}>Tentar novamente</Button>} />;
  }

  const feedback = originalAttempt?.feedback ?? null;

  return (
    <div className="error-notebook error-notebook__detail">
      <p className="error-notebook__back">
        <Link to="/caderno-de-erros">← Voltar para o Caderno</Link>
      </p>

      <Card className="error-notebook__card">
        <h1 ref={headingRef} tabIndex={-1} className="error-notebook__detail-heading">
          {entry.originalQuestionCode}
        </h1>
        <p className="error-notebook__card-status">
          <span className="error-notebook__card-label">Status: </span>
          {STATUS_LABELS[entry.effectiveStatus]}
          {entry.effectiveStatus === "due" && (
            <strong className="error-notebook__overdue-flag" role="note">
              {" "}
              — revisão vencida
            </strong>
          )}
        </p>
        {entry.primaryPattern && (
          <p>
            <span className="error-notebook__card-label">Padrão principal: </span>
            <Link to={`/padroes-enem/${entry.primaryPattern.slug}`}>{entry.primaryPattern.name}</Link>
          </p>
        )}
        <p>
          <span className="error-notebook__card-label">Próxima revisão: </span>
          {formatDateTime(entry.nextReviewAt)}
        </p>
        <p>
          <span className="error-notebook__card-label">Erros registrados nesta questão: </span>
          {entry.errorCount}
        </p>

        {entry.stillNeedsDifferentContext && (
          <p className="error-notebook__context-notice" role="note">
            Você já acertou uma revisão, mas ainda falta comprovar que resolve este padrão em outro
            contexto — continue revisando.
          </p>
        )}

        {originalAttempt && feedback && (
          <section className="error-notebook__section" aria-labelledby="secao-questao-original">
            <h2 id="secao-questao-original">Questão original</h2>
            <p>{originalAttempt.question.enunciado}</p>
            <ul className="error-notebook__alt-list">
              {originalAttempt.question.alternativas.map((alt) => (
                <li key={alt.letter}>
                  <strong>{alt.letter}) </strong>
                  {alt.text}
                  {alt.letter === feedback.correctAlternative && " (correta)"}
                  {alt.letter === feedback.selectedAlternative && alt.letter !== feedback.correctAlternative && " (marcada por você)"}
                </li>
              ))}
            </ul>
            <p className="error-notebook__note-privacy">
              A resposta correta só é mostrada aqui porque a tentativa original já foi confirmada.
            </p>

            <h3>DNA da questão</h3>
            {feedback.dna && (
              <>
                <p>
                  <strong>Pista: </strong>
                  {feedback.dna.pista}
                </p>
                <p>
                  <strong>Estratégia: </strong>
                  {feedback.dna.estrategia}
                </p>
                <p>
                  <strong>Pegadinha: </strong>
                  {feedback.dna.pegadinha}
                </p>
                <p>
                  <strong>Conteúdo de apoio: </strong>
                  {feedback.dna.conteudoApoio}
                </p>
                <p>
                  <strong>Aprendizado do erro: </strong>
                  {feedback.dna.aprendizadoErro}
                </p>
              </>
            )}
            <p>
              <span className="error-notebook__card-label">Camadas de ajuda usadas na tentativa original: </span>
              {originalAttempt.openedLayers.length > 0 ? originalAttempt.openedLayers.join(", ") : "nenhuma"}
            </p>
            <p>
              <span className="error-notebook__card-label">Data da tentativa original: </span>
              {formatDateTime(originalAttempt.completedAt)}
            </p>
          </section>
        )}

        <section className="error-notebook__section" aria-labelledby="secao-classificacao">
          <h2 id="secao-classificacao">Classificar o erro</h2>
          <div className="error-notebook__field">
            <label className="error-notebook__field-label" htmlFor="caderno-tipo-erro">
              Tipo de erro
            </label>
            <select id="caderno-tipo-erro" value={errorTypeDraft} onChange={(event) => setErrorTypeDraft(event.target.value as ErrorType)}>
              {ERROR_TYPE_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <Button type="button" variant="secondary" onClick={() => void handleSaveErrorType()} isLoading={saveState === "saving"}>
              Salvar tipo de erro
            </Button>
          </div>

          <div className="error-notebook__field">
            <label className="error-notebook__field-label" htmlFor="caderno-nota">
              O que você aprendeu com este erro? (opcional)
            </label>
            <p className="error-notebook__note-privacy">
              Opcional. Registre somente o necessário para lembrar o que aprendeu. Sua anotação não
              aparece em URL, logs ou auditoria.
            </p>
            <textarea id="caderno-nota" value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} maxLength={1000} rows={4} />
            <Button type="button" variant="secondary" onClick={() => void handleSaveNote()} isLoading={saveState === "saving"}>
              Salvar anotação
            </Button>
          </div>

          <div role="status" aria-live="polite" className={`error-notebook__save-indicator${saveState === "error" ? " error-notebook__save-indicator--error" : ""}`}>
            {saveState === "saving" && "Salvando…"}
            {saveState === "saved" && "Salvo."}
            {saveState === "error" && "Não foi possível salvar. Recarregue a página e tente novamente."}
          </div>
        </section>

        {entry.reviewHistory.length > 0 && (
          <section className="error-notebook__section" aria-labelledby="secao-historico">
            <h2 id="secao-historico">Histórico de revisões</h2>
            <ul className="error-notebook__review-history">
              {entry.reviewHistory.map((review) => (
                <li key={review.id}>
                  <strong>{review.result === "correct" ? "Correta" : "Incorreta"}</strong> — questão {review.reviewedQuestionCode}
                  {review.usedDifferentQuestion ? " (contexto diferente)" : " (mesma questão original)"} — {formatDateTime(review.createdAt)}
                </li>
              ))}
            </ul>
          </section>
        )}

        {startError && (
          <p className="error-notebook__save-indicator error-notebook__save-indicator--error" role="status" aria-live="polite">
            {startError}
          </p>
        )}

        <div className="error-notebook__actions">
          {entry.status !== "archived" && entry.status !== "corrected" && (
            <Button type="button" onClick={() => void handleStartReview()} isLoading={startingReview}>
              Corrigir meu erro
            </Button>
          )}
          {entry.status !== "archived" && (
            <Button type="button" variant="secondary" onClick={() => setShowArchiveModal(true)}>
              Arquivar
            </Button>
          )}
        </div>
      </Card>

      <Modal isOpen={showArchiveModal} title="Arquivar este erro?" onClose={() => setShowArchiveModal(false)}>
        <p>
          Arquivar não apaga o histórico — a entrada só sai da lista padrão do Caderno. Você pode
          encontrá-la depois filtrando por arquivados. Arquivar não é o mesmo que corrigir.
        </p>
        <Button type="button" onClick={() => void handleArchive()} isLoading={archiving}>
          Confirmar arquivamento
        </Button>
      </Modal>
    </div>
  );
}
