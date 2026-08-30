import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { ErrorState } from "../../components/ErrorState";
import { LoadingState } from "../../components/LoadingState";
import {
  createQuestion,
  fetchQuestionDetail,
  runWorkflowAction,
  updateQuestion,
  EditorialApiError,
  type AlternativeDto,
  type QuestionDetail,
  type QuestionDnaDto,
} from "../../api/editorialClient";
import { useEditorialRole } from "../../auth/editorialRoleContext";
import { computePayloadSignature, isNetworkFailure, resolveMutationId, type MutationRetryState } from "./mutationId";
import "./editorial.css";

/* Editor de questão — /editorial/questoes/nova e /editorial/questoes/:id,
   Sprint 7 v1.0, seção 9 da ordem. Formulário por seções (dados básicos,
   alternativas A-E, DNA, padrões, direitos/licença). Salvamento é sempre
   MANUAL (nenhum autosave); conflito de versão é mostrado explicitamente,
   nunca sobrescreve silenciosamente. Enunciado/resolução são tratados como
   TEXTO PURO nesta sprint — nenhum dangerouslySetInnerHTML em lugar
   nenhum. */

const LETTERS = ["A", "B", "C", "D", "E"] as const;

function emptyAlternatives(): AlternativeDto[] {
  return LETTERS.map((letter) => ({ letter, text: "", isCorrect: false, distractorExplanation: null }));
}

function emptyDna(): QuestionDnaDto {
  return { pista: "", estrategia: "", pegadinha: "", conteudoApoio: "", resolucao: "", atalho: null, aprendizadoErro: "" };
}

export function EditorialQuestionFormPage() {
  const { id } = useParams<{ id?: string }>();
  const isNew = !id;
  const navigate = useNavigate();
  const role = useEditorialRole();

  const [phase, setPhase] = useState<"loading" | "ready" | "error" | "not_found">(isNew ? "ready" : "loading");
  const [question, setQuestion] = useState<QuestionDetail | null>(null);
  const [version, setVersion] = useState<number | null>(null);

  const [code, setCode] = useState("");
  const [enunciado, setEnunciado] = useState("");
  const [resolucaoComentada, setResolucaoComentada] = useState("");
  const [conteudo, setConteudo] = useState("");
  const [dificuldade, setDificuldade] = useState("media");
  const [origem, setOrigem] = useState("autoral");
  const [alternativas, setAlternativas] = useState<AlternativeDto[]>(emptyAlternatives());
  const [dna, setDna] = useState<QuestionDnaDto>(emptyDna());
  const [principalPatternId, setPrincipalPatternId] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [titularDireitos, setTitularDireitos] = useState("");
  const [baseLicenca, setBaseLicenca] = useState("");

  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [versionConflict, setVersionConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  // Sprint 7 v1.2, Correção A — estado de retry do PATCH: só populado quando
  // a ÚLTIMA tentativa falhou por FALHA DE REDE (nunca por 400/409, que já
  // significam que o servidor processou a requisição). `useRef` porque isto
  // nunca deve disparar re-render por si só — só é lido/escrito dentro de
  // handleSave.
  const patchRetryState = useRef<MutationRetryState | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setPhase("loading");
    try {
      const result = await fetchQuestionDetail(id);
      const q = result.question;
      setQuestion(q);
      setVersion(q.version);
      setCode(q.code);
      setEnunciado(q.enunciado);
      setResolucaoComentada(q.resolucaoComentada);
      setConteudo(q.conteudo);
      setDificuldade(q.dificuldade);
      setOrigem(q.origem);
      setAlternativas(q.alternativas.length === 5 ? q.alternativas : emptyAlternatives());
      setDna(q.dna ?? emptyDna());
      setPrincipalPatternId(q.padroes.find((p) => p.role === "principal")?.patternId ?? "");
      setTagsText(q.tags.join(", "));
      setTitularDireitos(q.titularDireitos ?? "");
      setBaseLicenca(q.baseLicenca ?? "");
      setPhase("ready");
    } catch (error) {
      if (error instanceof EditorialApiError && error.status === 404) setPhase("not_found");
      else setPhase("error");
    }
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  function updateAlternative(letter: string, changes: Partial<AlternativeDto>) {
    setAlternativas((prev) => prev.map((a) => (a.letter === letter ? { ...a, ...changes } : a)));
  }

  function markCorrect(letter: string) {
    setAlternativas((prev) => prev.map((a) => ({ ...a, isCorrect: a.letter === letter })));
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    setFieldErrors({});
    setVersionConflict(false);
    setSavedNotice(null);

    const payload = {
      code,
      enunciado,
      resolucaoComentada,
      conteudo,
      subconteudo: "",
      habilidade: "",
      competencia: "",
      dificuldade,
      origem,
      prova: null,
      ano: null,
      tempoEstimadoSegundos: null,
      tipoCalculo: "misto",
      necessitaCalculadora: false,
      titularDireitos: titularDireitos || null,
      baseLicenca: baseLicenca || null,
      textoAtribuicao: null,
      alternativas,
      dna,
      padroes: principalPatternId ? [{ patternId: principalPatternId, role: "principal" }] : [],
      tags: tagsText
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      imagens: [],
    };

    // Sprint 7 v1.2, Correção A — decide o mutationId ANTES de chamar a API:
    // reaproveita o ID da última tentativa SÓ SE o payload é idêntico ao
    // daquela tentativa (prova de que é o MESMO retry, nunca por
    // "parecença" de conteúdo) — qualquer alteração no formulário desde a
    // última falha gera um ID novo, mesmo que a tentativa anterior nunca
    // tenha sido confirmada pelo servidor.
    const payloadSignature = computePayloadSignature(payload);
    const mutationId = resolveMutationId(patchRetryState.current, payloadSignature);

    try {
      if (isNew) {
        const result = await createQuestion(payload);
        setSavedNotice("Questão criada como rascunho.");
        navigate(`/editorial/questoes/${result.id}`, { replace: true });
      } else if (id && version !== null) {
        const result = await updateQuestion(id, version, mutationId, payload);
        patchRetryState.current = null; // sucesso — próxima edição usa ID novo
        setSavedNotice(result.changed ? "Alterações salvas." : "Nada para salvar — o conteúdo já está igual ao atual.");
        if (result.changed) setVersion((v) => (v ?? 0) + 1);
        await load();
      }
    } catch (error) {
      if (error instanceof EditorialApiError) {
        if (error.status === 409) {
          setVersionConflict(true);
        } else {
          setFieldErrors(error.fields);
          setSaveError(error.message);
        }
        // Resposta do servidor recebida (mesmo que de erro) — a próxima
        // tentativa é uma decisão nova do usuário, nunca um retry automático
        // do mesmo mutationId.
        patchRetryState.current = null;
      } else {
        setSaveError("Erro inesperado ao salvar.");
        if (isNetworkFailure(error)) {
          // A requisição nunca chegou a uma resposta do servidor — se o
          // usuário clicar Salvar de novo SEM mudar nada, é o MESMO retry.
          patchRetryState.current = { mutationId, payloadSignature };
        } else {
          patchRetryState.current = null;
        }
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleWorkflow(action: "submit-review" | "request-changes" | "approve" | "publish" | "archive") {
    if (!id || version === null) return;
    setSaveError(null);
    setVersionConflict(false);
    try {
      let reason: string | undefined;
      if (action === "request-changes") {
        reason = window.prompt("Motivo da correção solicitada (obrigatório):") ?? "";
        if (!reason.trim()) return;
      }
      await runWorkflowAction(id, action, version, reason);
      await load();
    } catch (error) {
      if (error instanceof EditorialApiError && error.status === 409) setVersionConflict(true);
      else if (error instanceof EditorialApiError) setSaveError(error.fields.readiness ?? error.message);
      else setSaveError("Erro inesperado.");
    }
  }

  if (phase === "loading") return <LoadingState label="Carregando questão…" />;
  if (phase === "not_found") return <ErrorState title="Questão não encontrada" description="Verifique o link ou volte ao catálogo." />;
  if (phase === "error") return <ErrorState description="Não foi possível carregar a questão." action={<Button onClick={() => void load()}>Tentar novamente</Button>} />;

  const isPublished = question?.editorialStatus === "published";
  const canEditContent = isNew || (question && (question.editorialStatus === "draft" || question.editorialStatus === "changes_requested"));
  const isAdmin = role === "admin";

  return (
    <div className="editorial">
      <h1>{isNew ? "Nova questão" : `Editar ${question?.code ?? ""}`}</h1>

      {question?.isLocalFixture && (
        <p className="editorial__fixture-notice" role="note">
          FIXTURE TÉCNICA LOCAL — NÃO PUBLICAR — NÃO É QUESTÃO OFICIAL
        </p>
      )}

      {versionConflict && (
        <Card className="editorial__conflict" role="alert">
          <p>
            Esta questão foi alterada por outra pessoa desde que você abriu esta tela. Suas
            alterações NÃO foram salvas para evitar sobrescrever a versão mais recente. Recarregue
            para ver o conteúdo atual.
          </p>
          <Button variant="secondary" onClick={() => void load()}>
            Recarregar
          </Button>
        </Card>
      )}

      {saveError && <ErrorState description={saveError} />}
      {savedNotice && (
        <p className="editorial__saved-notice" role="status" aria-live="polite">
          {savedNotice}
        </p>
      )}

      {isPublished && (
        <p className="editorial__locked-notice" role="note">
          Questão publicada: conteúdo não pode ser editado nesta sprint. Arquive e crie uma revisão
          futura versionada, se necessário.
        </p>
      )}

      <fieldset className="editorial__section" disabled={!canEditContent}>
        <legend>Dados básicos</legend>
        <div className="editorial__field">
          <label htmlFor="q-code">Código editorial</label>
          <input id="q-code" value={code} onChange={(e) => setCode(e.target.value)} aria-invalid={Boolean(fieldErrors.code)} />
          {fieldErrors.code && <p className="editorial__field-error">{fieldErrors.code}</p>}
        </div>
        <div className="editorial__field">
          <label htmlFor="q-enunciado">Enunciado</label>
          <textarea id="q-enunciado" value={enunciado} onChange={(e) => setEnunciado(e.target.value)} rows={4} aria-invalid={Boolean(fieldErrors.enunciado)} />
          {fieldErrors.enunciado && <p className="editorial__field-error">{fieldErrors.enunciado}</p>}
        </div>
        <div className="editorial__field">
          <label htmlFor="q-resolucao">Resolução comentada</label>
          <textarea id="q-resolucao" value={resolucaoComentada} onChange={(e) => setResolucaoComentada(e.target.value)} rows={3} />
        </div>
        <div className="editorial__field">
          <label htmlFor="q-conteudo">Conteúdo</label>
          <input id="q-conteudo" value={conteudo} onChange={(e) => setConteudo(e.target.value)} />
        </div>
        <div className="editorial__field">
          <label htmlFor="q-dificuldade">Dificuldade</label>
          <select id="q-dificuldade" value={dificuldade} onChange={(e) => setDificuldade(e.target.value)}>
            <option value="facil">Fácil</option>
            <option value="media">Média</option>
            <option value="dificil">Difícil</option>
          </select>
        </div>
        <div className="editorial__field">
          <label htmlFor="q-origem">Origem/tipo</label>
          <select id="q-origem" value={origem} onChange={(e) => setOrigem(e.target.value)}>
            <option value="oficial">Oficial</option>
            <option value="autoral">Autoral</option>
            <option value="licenciada">Licenciada</option>
            <option value="diagnostico">Diagnóstico</option>
            <option value="reconhecimento">Reconhecimento</option>
            <option value="revisao_base">Revisão/base</option>
          </select>
        </div>
      </fieldset>

      <fieldset className="editorial__section" disabled={!canEditContent}>
        <legend>Alternativas (A-E)</legend>
        {fieldErrors.alternativas && <p className="editorial__field-error">{fieldErrors.alternativas}</p>}
        {alternativas.map((alt) => (
          <div className="editorial__alternative" key={alt.letter}>
            <label htmlFor={`alt-${alt.letter}`} className="editorial__alternative-letter">
              {alt.letter}
            </label>
            <input
              id={`alt-${alt.letter}`}
              value={alt.text}
              onChange={(e) => updateAlternative(alt.letter, { text: e.target.value })}
              aria-label={`Texto da alternativa ${alt.letter}`}
            />
            <label className="editorial__alternative-correct">
              <input type="radio" name="correta" checked={alt.isCorrect} onChange={() => markCorrect(alt.letter)} />
              Correta
            </label>
          </div>
        ))}
      </fieldset>

      <fieldset className="editorial__section" disabled={!canEditContent}>
        <legend>DNA da questão</legend>
        {fieldErrors.dna && <p className="editorial__field-error">{fieldErrors.dna}</p>}
        {(
          [
            ["pista", "Pista"],
            ["estrategia", "Estratégia"],
            ["pegadinha", "Pegadinha"],
            ["conteudoApoio", "Conteúdo de apoio"],
            ["resolucao", "Resolução"],
            ["aprendizadoErro", "Aprendizado do erro"],
          ] as const
        ).map(([key, label]) => (
          <div className="editorial__field" key={key}>
            <label htmlFor={`dna-${key}`}>{label}</label>
            <textarea
              id={`dna-${key}`}
              value={dna[key] ?? ""}
              onChange={(e) => setDna((prev) => ({ ...prev, [key]: e.target.value }))}
              rows={2}
            />
          </div>
        ))}
        <div className="editorial__field">
          <label htmlFor="dna-atalho">Atalho/macete (opcional)</label>
          <textarea id="dna-atalho" value={dna.atalho ?? ""} onChange={(e) => setDna((prev) => ({ ...prev, atalho: e.target.value }))} rows={2} />
        </div>
      </fieldset>

      <fieldset className="editorial__section" disabled={!canEditContent}>
        <legend>Padrão principal e tags</legend>
        {fieldErrors.padroes && <p className="editorial__field-error">{fieldErrors.padroes}</p>}
        <div className="editorial__field">
          <label htmlFor="q-pattern">ID do padrão principal</label>
          <input id="q-pattern" value={principalPatternId} onChange={(e) => setPrincipalPatternId(e.target.value)} placeholder="ex.: fixture-pat-01" />
        </div>
        <div className="editorial__field">
          <label htmlFor="q-tags">Tags (separadas por vírgula)</label>
          <input id="q-tags" value={tagsText} onChange={(e) => setTagsText(e.target.value)} />
        </div>
      </fieldset>

      <fieldset className="editorial__section" disabled={!canEditContent}>
        <legend>Direitos e licença</legend>
        <div className="editorial__field">
          <label htmlFor="q-titular">Titular dos direitos</label>
          <input id="q-titular" value={titularDireitos} onChange={(e) => setTitularDireitos(e.target.value)} />
        </div>
        <div className="editorial__field">
          <label htmlFor="q-licenca">Base de uso/licença</label>
          <input id="q-licenca" value={baseLicenca} onChange={(e) => setBaseLicenca(e.target.value)} />
        </div>
      </fieldset>

      {canEditContent && (
        <div className="editorial__actions">
          <Button type="button" onClick={() => void handleSave()} isLoading={saving}>
            Salvar
          </Button>
        </div>
      )}

      {!isNew && question && (
        <fieldset className="editorial__section">
          <legend>Workflow editorial (status atual: {question.editorialStatus})</legend>
          <div className="editorial__actions">
            {(question.editorialStatus === "draft" || question.editorialStatus === "changes_requested") && (
              <Button type="button" variant="secondary" onClick={() => void handleWorkflow("submit-review")}>
                Enviar para revisão
              </Button>
            )}
            {isAdmin && question.editorialStatus === "in_review" && (
              <>
                <Button type="button" variant="secondary" onClick={() => void handleWorkflow("request-changes")}>
                  Solicitar correção
                </Button>
                <Button type="button" variant="secondary" onClick={() => void handleWorkflow("approve")}>
                  Aprovar
                </Button>
              </>
            )}
            {isAdmin && question.editorialStatus === "approved" && (
              <Button type="button" variant="secondary" onClick={() => void handleWorkflow("publish")}>
                Publicar
              </Button>
            )}
            {isAdmin && question.editorialStatus !== "published" && question.editorialStatus !== "archived" && (
              <Button type="button" variant="secondary" onClick={() => void handleWorkflow("archive")}>
                Arquivar
              </Button>
            )}
          </div>
        </fieldset>
      )}
    </div>
  );
}
