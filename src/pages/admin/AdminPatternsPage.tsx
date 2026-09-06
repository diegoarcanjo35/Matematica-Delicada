import { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { LoadingState } from "../../components/LoadingState";
import { PageTitle } from "../../components/PageTitle";
import { AdminApiError, createAdminPattern, fetchAdminPatterns, transitionAdminPatternStatus, updateAdminPattern, type PatternAdmin } from "../../api/adminClient";
import "./AdminPages.css";

/* /admin/padroes — superfície administrativa do catálogo de padrões.
   Sprint 17, seção A da ordem: "a operação da Andreia está complexa
   demais" — o formulário foi reduzido a Padrão (nome) + Macete/Como
   resolver. Código, slug e todos os campos editoriais legados
   (recognitionPhrase, description, introductoryExample, strategicSummary,
   atributos) saem da UI, mas continuam existindo e preservados no
   backend/banco — esta tela simplesmente não os edita mais. Um rascunho
   pode existir só com o nome; publicar exige nome + macete preenchidos
   (validado pelo servidor). */

interface FormState {
  name: string;
  mainStrategy: string;
}

function emptyForm(): FormState {
  return { name: "", mainStrategy: "" };
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
    setForm({ name: pattern.name, mainStrategy: pattern.mainStrategy });
    setSaveError(null);
  }

  function cancelEdit() {
    setEditing(null);
    setForm(emptyForm());
    setSaveError(null);
  }

  const canSubmit = form.name.trim().length > 0;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const core = { name: form.name.trim(), mainStrategy: form.mainStrategy.trim() };
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
    setSaveError(null);
    try {
      await transitionAdminPatternStatus(pattern.id, action, pattern.version, crypto.randomUUID());
      await load();
    } catch (error) {
      // Sprint 17, seção A da ordem — publicar agora pode falhar por
      // validação (macete vazio); reaproveita o mesmo aviso do formulário
      // em vez de falhar silenciosamente.
      setSaveError(error instanceof AdminApiError ? error.message : "Não foi possível concluir a ação.");
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
          <div className="admin-page__field">
            <label className="admin-page__field-label" htmlFor="pat-name">
              Padrão
            </label>
            <input id="pat-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="ex.: Mediana, moda e frequência" />
          </div>
          <div className="admin-page__field">
            <label className="admin-page__field-label" htmlFor="pat-strategy">
              Macete / Como resolver
            </label>
            <textarea
              id="pat-strategy"
              rows={6}
              value={form.mainStrategy}
              onChange={(event) => setForm({ ...form, mainStrategy: event.target.value })}
              placeholder="Orientação prática de como resolver questões deste padrão."
            />
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
                  <th scope="col">Padrão</th>
                  <th scope="col">Situação</th>
                  <th scope="col">
                    <span className="admin-page__sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {patterns.map((pattern) => (
                  <tr key={pattern.id}>
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
