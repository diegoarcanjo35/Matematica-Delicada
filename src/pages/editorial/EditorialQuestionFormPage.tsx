import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { ErrorState } from "../../components/ErrorState";
import { LoadingState } from "../../components/LoadingState";
import {
  createQuestion,
  fetchEditorialPatterns,
  fetchQuestionDetail,
  runWorkflowAction,
  updateQuestion,
  EditorialApiError,
  type AlternativeDto,
  type EditorialPatternSummary,
  type QuestionDetail,
  type QuestionFormInput,
} from "../../api/editorialClient";
import { useEditorialRole } from "../../auth/editorialRoleContext";
import { computePayloadSignature, isNetworkFailure, resolveMutationId, type MutationRetryState } from "./mutationId";
import { ImageUploadZone } from "./ImageUploadZone";
import "./editorial.css";

/* Editor de questão — /editorial/questoes/nova e /editorial/questoes/:id.

   Sprint 18 da ordem — "editor de questão simplificado": a visão principal
   mostra só Prova/Ano/Enunciado/imagens do enunciado/Alternativas A-E
   (+ imagem de cada)/resposta correta/Padrão principal (por NOME, nunca
   ID)/Resolução comentada/Macete-Como-resolver. Código editorial, ID de
   padrão manual e os 6 campos legados de DNA saem da interface — mas
   continuam preservados internamente: o PATCH desta tela nunca envia
   `code` (imutável), só envia `padroes`/`dna`/`tags` quando o valor
   EFETIVAMENTE mudou (mesclando com o que já existia, nunca zerando um
   padrão secundário ou um campo legado de DNA por omissão), e NUNCA envia
   `imagens` (imagem tem endpoints dedicados — ver ImageUploadZone). */

const LETTERS = ["A", "B", "C", "D", "E"] as const;

interface AlternativeFormState {
  letter: (typeof LETTERS)[number];
  text: string;
  isCorrect: boolean;
}

function emptyAlternatives(): AlternativeFormState[] {
  return LETTERS.map((letter) => ({ letter, text: "", isCorrect: false }));
}

function tagsToText(tags: string[]): string {
  return tags.join(", ");
}

function textToTags(text: string): string[] {
  return text
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

export function EditorialQuestionFormPage() {
  const { id } = useParams<{ id?: string }>();
  const isNew = !id;
  const navigate = useNavigate();
  const role = useEditorialRole();

  const [phase, setPhase] = useState<"loading" | "ready" | "error" | "not_found">(isNew ? "ready" : "loading");
  const [question, setQuestion] = useState<QuestionDetail | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [patterns, setPatterns] = useState<EditorialPatternSummary[]>([]);

  const [prova, setProva] = useState("");
  const [ano, setAno] = useState("");
  const [enunciado, setEnunciado] = useState("");
  const [resolucaoComentada, setResolucaoComentada] = useState("");
  const [macete, setMacete] = useState("");
  const [alternativas, setAlternativas] = useState<AlternativeFormState[]>(emptyAlternatives());
  const [principalPatternId, setPrincipalPatternId] = useState("");

  const [avancadoOpen, setAvancadoOpen] = useState(false);
  const [origem, setOrigem] = useState("autoral");
  const [conteudo, setConteudo] = useState("");
  const [dificuldade, setDificuldade] = useState("media");
  const [titularDireitos, setTitularDireitos] = useState("");
  const [baseLicenca, setBaseLicenca] = useState("");
  const [tagsText, setTagsText] = useState("");

  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [versionConflict, setVersionConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const patchRetryState = useRef<MutationRetryState | null>(null);

  useEffect(() => {
    fetchEditorialPatterns()
      .then((result) => setPatterns(result.patterns))
      .catch(() => setPatterns([]));
  }, []);

  const load = useCallback(async () => {
    if (!id) return;
    setPhase("loading");
    try {
      const result = await fetchQuestionDetail(id);
      const q = result.question;
      setQuestion(q);
      setVersion(q.version);
      setProva(q.prova ?? "");
      setAno(q.ano !== null ? String(q.ano) : "");
      setEnunciado(q.enunciado);
      setResolucaoComentada(q.resolucaoComentada);
      setMacete(q.dna?.estrategia ?? "");
      setAlternativas(
        q.alternativas.length === 5
          ? (q.alternativas.map((a) => ({ letter: a.letter as (typeof LETTERS)[number], text: a.text, isCorrect: a.isCorrect })) as AlternativeFormState[])
          : emptyAlternatives()
      );
      setPrincipalPatternId(q.padroes.find((p) => p.role === "principal")?.patternId ?? "");
      setOrigem(q.origem);
      setConteudo(q.conteudo);
      setDificuldade(q.dificuldade);
      setTitularDireitos(q.titularDireitos ?? "");
      setBaseLicenca(q.baseLicenca ?? "");
      setTagsText(tagsToText(q.tags));
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

  function updateAlternative(letter: string, changes: Partial<AlternativeFormState>) {
    setAlternativas((prev) => prev.map((a) => (a.letter === letter ? { ...a, ...changes } : a)));
  }

  function markCorrect(letter: string) {
    setAlternativas((prev) => prev.map((a) => ({ ...a, isCorrect: a.letter === letter })));
  }

  /** Sprint 18, seção 2/6/7/8 da ordem — só inclui no payload o que
   *  REALMENTE mudou desde o que foi carregado; um campo/coleção ausente do
   *  payload preserva o que já existia (semântica de PATCH parcial já
   *  existente no backend, reaproveitada aqui sem alterações). `imagens`
   *  NUNCA entra aqui — tem endpoints dedicados (ImageUploadZone). */
  function buildUpdatePayload(): Partial<QuestionFormInput> {
    const q = question!;
    const payload: Partial<QuestionFormInput> = {};

    if (enunciado !== q.enunciado) payload.enunciado = enunciado;
    if (resolucaoComentada !== q.resolucaoComentada) payload.resolucaoComentada = resolucaoComentada;
    if (conteudo !== q.conteudo) payload.conteudo = conteudo;
    if (dificuldade !== q.dificuldade) payload.dificuldade = dificuldade;
    if (origem !== q.origem) payload.origem = origem;
    const provaValue = prova.trim() || null;
    if (provaValue !== q.prova) payload.prova = provaValue;
    const anoValue = ano.trim() ? Number(ano) : null;
    if (anoValue !== q.ano) payload.ano = anoValue;
    const titularValue = titularDireitos.trim() || null;
    if (titularValue !== q.titularDireitos) payload.titularDireitos = titularValue;
    const licencaValue = baseLicenca.trim() || null;
    if (licencaValue !== q.baseLicenca) payload.baseLicenca = licencaValue;

    // Alternativas: qualquer mudança de texto/correta reenvia o conjunto
    // completo (exigência do backend — sempre as 5 A-E), preservando
    // `distractorExplanation` de cada uma tal como já estava (campo legado,
    // não editável nesta UI simplificada).
    const alternativesChanged = alternativas.some((a, i) => {
      const original = q.alternativas[i];
      return !original || a.text !== original.text || a.isCorrect !== original.isCorrect;
    });
    if (alternativesChanged) {
      payload.alternativas = alternativas.map((a) => ({
        letter: a.letter,
        text: a.text,
        isCorrect: a.isCorrect,
        distractorExplanation: q.alternativas.find((orig) => orig.letter === a.letter)?.distractorExplanation ?? null,
      })) as AlternativeDto[];
    }

    // DNA: só Macete (estrategia) é editável aqui — ao mudar, reenvia o DNA
    // INTEIRO mesclado com o que já existia (pista/pegadinha/conteudoApoio/
    // resolucao/aprendizadoErro/atalho preservados byte a byte).
    if (macete !== (q.dna?.estrategia ?? "")) {
      payload.dna = {
        pista: q.dna?.pista ?? "",
        estrategia: macete,
        pegadinha: q.dna?.pegadinha ?? "",
        conteudoApoio: q.dna?.conteudoApoio ?? "",
        resolucao: q.dna?.resolucao ?? "",
        atalho: q.dna?.atalho ?? null,
        aprendizadoErro: q.dna?.aprendizadoErro ?? "",
      };
    }

    // Padrão principal: só ao mudar, reenvia [secundários existentes,
    // principal novo] — nunca perde um vínculo secundário que a UI nem
    // mostra.
    const originalPrincipalId = q.padroes.find((p) => p.role === "principal")?.patternId ?? "";
    if (principalPatternId !== originalPrincipalId) {
      const secundarios = q.padroes.filter((p) => p.role === "secundario").map((p) => ({ patternId: p.patternId, role: p.role }));
      payload.padroes = principalPatternId ? [...secundarios, { patternId: principalPatternId, role: "principal" }] : secundarios;
    }

    const newTags = textToTags(tagsText);
    if (!sameStringSet(newTags, q.tags)) payload.tags = newTags;

    return payload;
  }

  function buildCreatePayload(): Partial<QuestionFormInput> {
    return {
      enunciado,
      resolucaoComentada,
      conteudo,
      dificuldade,
      origem,
      prova: prova.trim() || null,
      ano: ano.trim() ? Number(ano) : null,
      titularDireitos: titularDireitos.trim() || null,
      baseLicenca: baseLicenca.trim() || null,
      alternativas: alternativas.map((a) => ({ letter: a.letter, text: a.text, isCorrect: a.isCorrect, distractorExplanation: null })) as AlternativeDto[],
      dna: { pista: "", estrategia: macete, pegadinha: "", conteudoApoio: "", resolucao: "", atalho: null, aprendizadoErro: "" },
      padroes: principalPatternId ? [{ patternId: principalPatternId, role: "principal" }] : [],
      tags: textToTags(tagsText),
      // `code` nunca enviado por esta UI (seção 3 da ordem) — o servidor
      // gera um técnico estável quando ausente.
    };
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    setFieldErrors({});
    setVersionConflict(false);
    setSavedNotice(null);

    const payload = isNew ? buildCreatePayload() : buildUpdatePayload();

    if (!isNew && Object.keys(payload).length === 0) {
      setSavedNotice("Nada para salvar — nenhuma alteração feita.");
      setSaving(false);
      return;
    }

    const payloadSignature = computePayloadSignature(payload);
    const mutationId = resolveMutationId(patchRetryState.current, payloadSignature);

    try {
      if (isNew) {
        const result = await createQuestion(payload);
        setSavedNotice("Questão criada como rascunho.");
        navigate(`/editorial/questoes/${result.id}`, { replace: true });
      } else if (id && version !== null) {
        const result = await updateQuestion(id, version, mutationId, payload);
        patchRetryState.current = null;
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
        patchRetryState.current = null;
      } else {
        setSaveError("Erro inesperado ao salvar.");
        if (isNetworkFailure(error)) {
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
  const enunciadoImages = question?.imagens.filter((img) => img.placement === "enunciado") ?? [];

  return (
    <div className="editorial">
      <h1>{isNew ? "Nova questão" : `Editar questão${question?.code ? ` (${question.code})` : ""}`}</h1>

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
        <legend>Dados da questão</legend>
        <div className="editorial__content-form-grid">
          <div className="editorial__field">
            <label htmlFor="q-prova">Prova</label>
            <input id="q-prova" value={prova} onChange={(e) => setProva(e.target.value)} placeholder="ex.: ENEM" />
          </div>
          <div className="editorial__field">
            <label htmlFor="q-ano">Ano</label>
            <input id="q-ano" type="number" value={ano} onChange={(e) => setAno(e.target.value)} placeholder="ex.: 2024" />
          </div>
        </div>
        <div className="editorial__field">
          <label htmlFor="q-enunciado">Enunciado</label>
          <textarea id="q-enunciado" value={enunciado} onChange={(e) => setEnunciado(e.target.value)} rows={4} aria-invalid={Boolean(fieldErrors.enunciado)} />
          {fieldErrors.enunciado && <p className="editorial__field-error">{fieldErrors.enunciado}</p>}
        </div>

        {!isNew && id ? (
          <ImageUploadZone questionId={id} placement="enunciado" images={enunciadoImages} onChanged={() => void load()} />
        ) : (
          <p className="editorial__image-notice">Salve o rascunho para adicionar imagens.</p>
        )}
      </fieldset>

      <fieldset className="editorial__section" disabled={!canEditContent}>
        <legend>Alternativas (A-E)</legend>
        {fieldErrors.alternativas && <p className="editorial__field-error">{fieldErrors.alternativas}</p>}
        {alternativas.map((alt) => {
          const altImages = question?.imagens.filter((img) => img.placement === "alternativa" && img.alternativeLetter === alt.letter) ?? [];
          return (
            <div className="editorial__alternative-block" key={alt.letter}>
              <div className="editorial__alternative">
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
              {!isNew && id ? (
                <ImageUploadZone questionId={id} placement="alternativa" alternativeLetter={alt.letter} images={altImages} onChanged={() => void load()} />
              ) : null}
            </div>
          );
        })}
      </fieldset>

      <fieldset className="editorial__section" disabled={!canEditContent}>
        <legend>Padrão principal</legend>
        {fieldErrors.padroes && <p className="editorial__field-error">{fieldErrors.padroes}</p>}
        <div className="editorial__field">
          <label htmlFor="q-pattern">Padrão</label>
          <select id="q-pattern" value={principalPatternId} onChange={(e) => setPrincipalPatternId(e.target.value)}>
            <option value="">Nenhum selecionado</option>
            {patterns.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </fieldset>

      <fieldset className="editorial__section" disabled={!canEditContent}>
        <legend>Resolução e macete</legend>
        <div className="editorial__field">
          <label htmlFor="q-resolucao">Resolução comentada</label>
          <textarea id="q-resolucao" value={resolucaoComentada} onChange={(e) => setResolucaoComentada(e.target.value)} rows={3} />
        </div>
        <div className="editorial__field">
          <label htmlFor="q-macete">Macete / Como resolver</label>
          <textarea id="q-macete" value={macete} onChange={(e) => setMacete(e.target.value)} rows={3} />
          {fieldErrors.dna && <p className="editorial__field-error">{fieldErrors.dna}</p>}
        </div>
      </fieldset>

      <fieldset className="editorial__section" disabled={!canEditContent}>
        <button type="button" className="editorial__advanced-toggle" onClick={() => setAvancadoOpen((open) => !open)} aria-expanded={avancadoOpen}>
          {avancadoOpen ? "▾" : "▸"} Avançado
        </button>
        {avancadoOpen && (
          <div className="editorial__advanced-content">
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
              <label htmlFor="q-titular">Titular dos direitos</label>
              <input id="q-titular" value={titularDireitos} onChange={(e) => setTitularDireitos(e.target.value)} />
            </div>
            <div className="editorial__field">
              <label htmlFor="q-licenca">Base de uso/licença</label>
              <input id="q-licenca" value={baseLicenca} onChange={(e) => setBaseLicenca(e.target.value)} />
            </div>
            <div className="editorial__field">
              <label htmlFor="q-tags">Tags (separadas por vírgula)</label>
              <input id="q-tags" value={tagsText} onChange={(e) => setTagsText(e.target.value)} />
            </div>
          </div>
        )}
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
