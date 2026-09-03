import { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { LoadingState } from "../../components/LoadingState";
import { PageTitle } from "../../components/PageTitle";
import {
  AdminApiError,
  createAdminPattern,
  fetchAdminPatterns,
  transitionAdminPatternStatus,
  updateAdminPattern,
  type PatternAdmin,
  type PatternAttributeLists,
} from "../../api/adminClient";
import "./AdminPages.css";

/* /admin/padroes — superfície administrativa do catálogo de padrões
   (Sprint 16 v1.2, seção 4/9 da ordem — emenda do charter de
   patternsRepository.ts). UI mínima: um formulário único (criar/editar,
   reaproveitado como em AdminSchedulePage.tsx) + lista com
   Publicar/Inativar. Listas de atributos (pistas, tags, etc.) são um
   textarea por tipo, um item por linha — sem editor de array dinâmico.
   Sem score/TRI/domínio em lugar nenhum desta tela. */

interface FormState {
  code: string;
  slug: string;
  name: string;
  recognitionPhrase: string;
  description: string;
  mainStrategy: string;
  introductoryExample: string;
  strategicSummary: string;
  attributesText: Record<keyof PatternAttributeLists, string>;
}

const ATTRIBUTE_LABELS: Record<keyof PatternAttributeLists, string> = {
  frequentClues: "Pistas frequentes",
  recurringPhrases: "Expressões recorrentes",
  recurringVisualElements: "Elementos visuais recorrentes",
  alternativeStrategies: "Estratégias alternativas",
  requiredContents: "Conteúdos necessários",
  prerequisiteContents: "Pré-requisitos",
  commonMistakes: "Erros/pegadinhas frequentes",
  tags: "Tags",
};

function emptyAttributesText(): Record<keyof PatternAttributeLists, string> {
  return {
    frequentClues: "",
    recurringPhrases: "",
    recurringVisualElements: "",
    alternativeStrategies: "",
    requiredContents: "",
    prerequisiteContents: "",
    commonMistakes: "",
    tags: "",
  };
}

function emptyForm(): FormState {
  return {
    code: "",
    slug: "",
    name: "",
    recognitionPhrase: "",
    description: "",
    mainStrategy: "",
    introductoryExample: "",
    strategicSummary: "",
    attributesText: emptyAttributesText(),
  };
}

function linesOf(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function attributesTextToLists(text: Record<keyof PatternAttributeLists, string>): PatternAttributeLists {
  const result = {} as PatternAttributeLists;
  for (const key of Object.keys(text) as (keyof PatternAttributeLists)[]) result[key] = linesOf(text[key]);
  return result;
}

function attributesListsToText(lists: PatternAttributeLists): Record<keyof PatternAttributeLists, string> {
  const result = {} as Record<keyof PatternAttributeLists, string>;
  for (const key of Object.keys(lists) as (keyof PatternAttributeLists)[]) result[key] = lists[key].join("\n");
  return result;
}

export function AdminPatternsPage() {
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [patterns, setPatterns] = useState<PatternAdmin[]>([]);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [editing, setEditing] = useState<PatternAdmin | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [transitioningId, setTransitioningId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPhase("loading");
    try {
      const result = await fetchAdminPatterns();
      setPatterns(result.patterns);
      setPhase("ready");
    } catch {
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  function startEdit(pattern: PatternAdmin) {
    setEditing(pattern);
    setForm({
      code: pattern.code,
      slug: pattern.slug,
      name: pattern.name,
      recognitionPhrase: pattern.recognitionPhrase,
      description: pattern.description,
      mainStrategy: pattern.mainStrategy,
      introductoryExample: pattern.introductoryExample,
      strategicSummary: pattern.strategicSummary,
      attributesText: attributesListsToText(pattern.attributes),
    });
    setSaveError(null);
  }

  function cancelEdit() {
    setEditing(null);
    setForm(emptyForm());
    setSaveError(null);
  }

  const canSubmit =
    form.code.trim().length > 0 &&
    form.slug.trim().length > 0 &&
    form.name.trim().length > 0 &&
    form.recognitionPhrase.trim().length > 0 &&
    form.description.trim().length > 0 &&
    form.mainStrategy.trim().length > 0 &&
    form.introductoryExample.trim().length > 0 &&
    form.strategicSummary.trim().length > 0;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const core = {
        code: form.code.trim(),
        slug: form.slug.trim(),
        name: form.name.trim(),
        recognitionPhrase: form.recognitionPhrase.trim(),
        description: form.description.trim(),
        mainStrategy: form.mainStrategy.trim(),
        introductoryExample: form.introductoryExample.trim(),
        strategicSummary: form.strategicSummary.trim(),
        attributes: attributesTextToLists(form.attributesText),
      };
      if (editing) {
        await updateAdminPattern(editing.id, { ...core, expectedVersion: editing.version, mutationId: crypto.randomUUID() });
      } else {
        await createAdminPattern({ ...core, mutationId: crypto.randomUUID() });
      }
      cancelEdit();
      await load();
    } catch (error) {
      setSaveError(error instanceof AdminApiError ? error.message : "Não foi possível salvar o padrão.");
    } finally {
      setSaving(false);
    }
  }

  async function handleTransition(pattern: PatternAdmin, action: "publish" | "inactivate") {
    if (transitioningId) return;
    setTransitioningId(pattern.id);
    try {
      await transitionAdminPatternStatus(pattern.id, action, pattern.version, crypto.randomUUID());
      await load();
    } finally {
      setTransitioningId(null);
    }
  }

  return (
    <div className="admin-page">
      <PageTitle title="Padrões" description="Cadastrar, editar e publicar padrões do catálogo — superfície administrativa separada da leitura pedagógica do aluno." />

      <section aria-labelledby="admin-patterns-form-heading">
        <h2 id="admin-patterns-form-heading" className="admin-page__section-title">
          {editing ? `Editar padrão — ${editing.name}` : "Novo padrão"}
        </h2>
        <form className="admin-page__content-form" onSubmit={(event) => void handleSubmit(event)}>
          <div className="admin-page__content-form-grid">
            <div className="admin-page__field">
              <label className="admin-page__field-label" htmlFor="pat-code">
                Código
              </label>
              <input id="pat-code" value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} />
            </div>
            <div className="admin-page__field">
              <label className="admin-page__field-label" htmlFor="pat-slug">
                Slug
              </label>
              <input id="pat-slug" value={form.slug} onChange={(event) => setForm({ ...form, slug: event.target.value })} />
            </div>
            <div className="admin-page__field">
              <label className="admin-page__field-label" htmlFor="pat-name">
                Nome
              </label>
              <input id="pat-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </div>
          </div>

          <div className="admin-page__field">
            <label className="admin-page__field-label" htmlFor="pat-recognition">
              Frase de reconhecimento
            </label>
            <textarea id="pat-recognition" rows={2} value={form.recognitionPhrase} onChange={(event) => setForm({ ...form, recognitionPhrase: event.target.value })} />
          </div>
          <div className="admin-page__field">
            <label className="admin-page__field-label" htmlFor="pat-description">
              Descrição
            </label>
            <textarea id="pat-description" rows={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
          </div>
          <div className="admin-page__field">
            <label className="admin-page__field-label" htmlFor="pat-strategy">
              Estratégia principal
            </label>
            <textarea id="pat-strategy" rows={3} value={form.mainStrategy} onChange={(event) => setForm({ ...form, mainStrategy: event.target.value })} />
          </div>
          <div className="admin-page__field">
            <label className="admin-page__field-label" htmlFor="pat-example">
              Exemplo introdutório
            </label>
            <textarea id="pat-example" rows={3} value={form.introductoryExample} onChange={(event) => setForm({ ...form, introductoryExample: event.target.value })} />
          </div>
          <div className="admin-page__field">
            <label className="admin-page__field-label" htmlFor="pat-summary">
              Resumo estratégico
            </label>
            <textarea id="pat-summary" rows={2} value={form.strategicSummary} onChange={(event) => setForm({ ...form, strategicSummary: event.target.value })} />
          </div>

          <div className="admin-page__content-form-grid">
            {(Object.keys(ATTRIBUTE_LABELS) as (keyof PatternAttributeLists)[]).map((key) => (
              <div className="admin-page__field" key={key}>
                <label className="admin-page__field-label" htmlFor={`pat-attr-${key}`}>
                  {ATTRIBUTE_LABELS[key]} (um por linha)
                </label>
                <textarea
                  id={`pat-attr-${key}`}
                  rows={3}
                  value={form.attributesText[key]}
                  onChange={(event) => setForm({ ...form, attributesText: { ...form.attributesText, [key]: event.target.value } })}
                />
              </div>
            ))}
          </div>

          <div className="admin-page__filters">
            <Button type="submit" isLoading={saving} disabled={!canSubmit || saving}>
              {editing ? "Salvar alterações" : "Criar padrão (rascunho)"}
            </Button>
            {editing && (
              <Button type="button" variant="secondary" onClick={cancelEdit} disabled={saving}>
                Cancelar edição
              </Button>
            )}
          </div>
        </form>
        {saveError && (
          <p className="admin-page__form-error" role="alert">
            {saveError}
          </p>
        )}
      </section>

      <section aria-labelledby="admin-patterns-list-heading">
        <h2 id="admin-patterns-list-heading" className="admin-page__section-title">
          Padrões cadastrados
        </h2>
        {phase === "loading" ? (
          <LoadingState label="Carregando padrões…" />
        ) : phase === "error" ? (
          <ErrorState description="Não foi possível carregar os padrões." action={<Button onClick={() => void load()}>Tentar novamente</Button>} />
        ) : patterns.length === 0 ? (
          <EmptyState title="Nenhum padrão real cadastrado ainda" description="Use o formulário acima para cadastrar o primeiro." />
        ) : (
          <div className="admin-page__table-wrap">
            <table className="admin-page__table">
              <thead>
                <tr>
                  <th scope="col">Código</th>
                  <th scope="col">Nome</th>
                  <th scope="col">Situação</th>
                  <th scope="col">
                    <span className="admin-page__sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {patterns.map((pattern) => (
                  <tr key={pattern.id}>
                    <td>{pattern.code}</td>
                    <td>{pattern.name}</td>
                    <td>
                      <span
                        className={`admin-page__status-badge admin-page__status-badge--${pattern.editorialStatus === "published" ? "active" : "inactive"}`}
                      >
                        {pattern.editorialStatus}
                      </span>
                    </td>
                    <td>
                      <div className="admin-page__filters">
                        <Button type="button" variant="secondary" onClick={() => startEdit(pattern)} disabled={saving}>
                          Editar
                        </Button>
                        {pattern.editorialStatus !== "published" && (
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={() => void handleTransition(pattern, "publish")}
                            isLoading={transitioningId === pattern.id}
                            disabled={transitioningId !== null}
                          >
                            Publicar
                          </Button>
                        )}
                        {pattern.editorialStatus === "published" && (
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={() => void handleTransition(pattern, "inactivate")}
                            isLoading={transitioningId === pattern.id}
                            disabled={transitioningId !== null}
                          >
                            Inativar
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
