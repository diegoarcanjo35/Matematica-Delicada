import { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { LoadingState } from "../../components/LoadingState";
import { Modal } from "../../components/Modal";
import { PageTitle } from "../../components/PageTitle";
import {
  AdminApiError,
  createAdminDiagnosticQuestion,
  deleteAdminDiagnosticQuestion,
  fetchAdminDiagnosticQuestions,
  type DiagnosticAdminQuestion,
} from "../../api/adminClient";
import "./AdminPages.css";

/* /admin/diagnostico — pipeline administrativo mínimo do Diagnóstico
   (Sprint 16 v1.2, seção 2/9 da ordem). UI mínima: formulário único de
   criação (4 alternativas fixas + reconhecimento opcional + camadas de
   ajuda opcionais) + lista com exclusão. Sem edição (seção 2: "sem
   workflow editorial complexo" — para corrigir uma questão, exclui e
   recria; são poucas questões, o custo é baixo). Nunca mostra/gerencia
   fixture local (o backend já garante isso — ver diagnosticAdminService.ts). */

const OPTION_COUNT = 4;

interface OptionFormState {
  text: string;
}

function emptyOptions(): OptionFormState[] {
  return Array.from({ length: OPTION_COUNT }, () => ({ text: "" }));
}

export function AdminDiagnosticPage() {
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [questions, setQuestions] = useState<DiagnosticAdminQuestion[]>([]);

  const [prompt, setPrompt] = useState("");
  const [options, setOptions] = useState<OptionFormState[]>(emptyOptions());
  const [correctIndex, setCorrectIndex] = useState(0);
  const [hasRecognition, setHasRecognition] = useState(false);
  const [recognitionOptions, setRecognitionOptions] = useState<OptionFormState[]>([{ text: "" }, { text: "" }]);
  const [recognitionCorrectIndex, setRecognitionCorrectIndex] = useState(0);
  const [helpLayers, setHelpLayers] = useState<Record<1 | 2 | 3 | 4, string>>({ 1: "", 2: "", 3: "", 4: "" });

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [questionToDelete, setQuestionToDelete] = useState<DiagnosticAdminQuestion | null>(null);

  const load = useCallback(async () => {
    setPhase("loading");
    try {
      const result = await fetchAdminDiagnosticQuestions();
      setQuestions(result.questions);
      setPhase("ready");
    } catch {
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  function resetForm() {
    setPrompt("");
    setOptions(emptyOptions());
    setCorrectIndex(0);
    setHasRecognition(false);
    setRecognitionOptions([{ text: "" }, { text: "" }]);
    setRecognitionCorrectIndex(0);
    setHelpLayers({ 1: "", 2: "", 3: "", 4: "" });
  }

  const filledOptions = options.filter((o) => o.text.trim().length > 0);
  const canSubmit = prompt.trim().length > 0 && filledOptions.length >= 2 && correctIndex < filledOptions.length;

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const filledRecognition = hasRecognition ? recognitionOptions.filter((o) => o.text.trim().length > 0) : [];
      const helpLayersPayload: Partial<Record<1 | 2 | 3 | 4, string>> = {};
      for (const layer of [1, 2, 3, 4] as const) {
        if (helpLayers[layer].trim().length > 0) helpLayersPayload[layer] = helpLayers[layer];
      }
      await createAdminDiagnosticQuestion({
        prompt: prompt.trim(),
        options: filledOptions.map((o, index) => ({ text: o.text.trim(), isCorrect: index === correctIndex })),
        recognitionOptions: filledRecognition.map((o, index) => ({ text: o.text.trim(), isCorrect: index === recognitionCorrectIndex })),
        helpLayers: helpLayersPayload,
        mutationId: crypto.randomUUID(),
      });
      resetForm();
      await load();
    } catch (error) {
      setCreateError(error instanceof AdminApiError ? error.message : "Não foi possível criar a questão.");
    } finally {
      setCreating(false);
    }
  }

  async function confirmDelete() {
    if (!questionToDelete || deletingId) return;
    setDeletingId(questionToDelete.id);
    try {
      await deleteAdminDiagnosticQuestion(questionToDelete.id);
      setQuestionToDelete(null);
      await load();
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="admin-page">
      <PageTitle title="Diagnóstico" description="Cadastrar questões reais do diagnóstico inicial — sem SQL manual, sem conteúdo fictício em produção." />

      <section aria-labelledby="admin-diagnostic-create-heading">
        <h2 id="admin-diagnostic-create-heading" className="admin-page__section-title">
          Nova questão
        </h2>
        <form className="admin-page__content-form" onSubmit={(event) => void handleCreate(event)}>
          <div className="admin-page__field">
            <label className="admin-page__field-label" htmlFor="diag-prompt">
              Enunciado
            </label>
            <textarea id="diag-prompt" rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          </div>

          <fieldset>
            <legend className="admin-page__field-label">Alternativas (marque a correta; deixe em branco as que não usar — mínimo 2)</legend>
            {options.map((option, index) => (
              <div className="admin-page__option-row" key={index}>
                <input
                  type="radio"
                  name="diag-correct"
                  aria-label={`Alternativa ${index + 1} é a correta`}
                  checked={correctIndex === index}
                  onChange={() => setCorrectIndex(index)}
                />
                <input
                  type="text"
                  aria-label={`Texto da alternativa ${index + 1}`}
                  value={option.text}
                  onChange={(event) => {
                    const next = [...options];
                    next[index] = { text: event.target.value };
                    setOptions(next);
                  }}
                  placeholder={`Alternativa ${index + 1}`}
                />
              </div>
            ))}
          </fieldset>

          <div className="admin-page__field">
            <label>
              <input type="checkbox" checked={hasRecognition} onChange={(event) => setHasRecognition(event.target.checked)} /> Incluir pergunta de
              reconhecimento de padrão
            </label>
          </div>

          {hasRecognition && (
            <fieldset>
              <legend className="admin-page__field-label">Opções de reconhecimento (marque a correta)</legend>
              {recognitionOptions.map((option, index) => (
                <div className="admin-page__option-row" key={index}>
                  <input
                    type="radio"
                    name="diag-recognition-correct"
                    aria-label={`Opção de reconhecimento ${index + 1} é a correta`}
                    checked={recognitionCorrectIndex === index}
                    onChange={() => setRecognitionCorrectIndex(index)}
                  />
                  <input
                    type="text"
                    aria-label={`Texto da opção de reconhecimento ${index + 1}`}
                    value={option.text}
                    onChange={(event) => {
                      const next = [...recognitionOptions];
                      next[index] = { text: event.target.value };
                      setRecognitionOptions(next);
                    }}
                    placeholder={`Opção ${index + 1}`}
                  />
                </div>
              ))}
            </fieldset>
          )}

          <div className="admin-page__content-form-grid">
            {([1, 2, 3, 4] as const).map((layer) => (
              <div className="admin-page__field" key={layer}>
                <label className="admin-page__field-label" htmlFor={`diag-help-${layer}`}>
                  Camada de ajuda {layer} (opcional)
                </label>
                <textarea
                  id={`diag-help-${layer}`}
                  rows={2}
                  value={helpLayers[layer]}
                  onChange={(event) => setHelpLayers({ ...helpLayers, [layer]: event.target.value })}
                />
              </div>
            ))}
          </div>

          <Button type="submit" isLoading={creating} disabled={!canSubmit || creating}>
            Criar questão
          </Button>
        </form>
        {createError && (
          <p className="admin-page__form-error" role="alert">
            {createError}
          </p>
        )}
      </section>

      <section aria-labelledby="admin-diagnostic-list-heading">
        <h2 id="admin-diagnostic-list-heading" className="admin-page__section-title">
          Questões cadastradas
        </h2>
        {phase === "loading" ? (
          <LoadingState label="Carregando questões…" />
        ) : phase === "error" ? (
          <ErrorState description="Não foi possível carregar as questões." action={<Button onClick={() => void load()}>Tentar novamente</Button>} />
        ) : questions.length === 0 ? (
          <EmptyState title="Nenhuma questão real cadastrada ainda" description="Use o formulário acima para cadastrar a primeira." />
        ) : (
          <div className="admin-page__table-wrap">
            <table className="admin-page__table">
              <thead>
                <tr>
                  <th scope="col">Posição</th>
                  <th scope="col">Enunciado</th>
                  <th scope="col">Alternativas</th>
                  <th scope="col">
                    <span className="admin-page__sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {questions.map((question) => (
                  <tr key={question.id}>
                    <td>{question.position}</td>
                    <td>{question.prompt}</td>
                    <td>{question.options.length}</td>
                    <td>
                      <Button type="button" variant="secondary" onClick={() => setQuestionToDelete(question)} disabled={deletingId !== null}>
                        Excluir
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Modal isOpen={questionToDelete !== null} title="Excluir questão" onClose={() => setQuestionToDelete(null)}>
        <p>
          Tem certeza de que deseja excluir a questão <strong>{questionToDelete?.prompt}</strong>? Esta ação não pode ser desfeita.
        </p>
        <div className="admin-page__filters">
          <Button type="button" variant="secondary" onClick={() => setQuestionToDelete(null)} disabled={deletingId !== null}>
            Cancelar
          </Button>
          <Button type="button" onClick={() => void confirmDelete()} isLoading={deletingId !== null}>
            Confirmar exclusão
          </Button>
        </div>
      </Modal>
    </div>
  );
}
