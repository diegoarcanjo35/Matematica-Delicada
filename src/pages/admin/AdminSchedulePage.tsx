import { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { LoadingState } from "../../components/LoadingState";
import { Modal } from "../../components/Modal";
import { PageTitle } from "../../components/PageTitle";
import {
  AdminApiError,
  SCHEDULE_ACTIVITY_ORIGINS,
  SCHEDULE_ACTIVITY_TYPES,
  SCHEDULE_COMPLETION_MODES,
  createAdminScheduleActivity,
  deleteAdminScheduleActivity,
  fetchAdminScheduleActivities,
  updateAdminScheduleActivity,
  type ScheduleActivityAdmin,
  type ScheduleActivityInput,
} from "../../api/adminClient";
import "./AdminPages.css";

/* /admin/cronograma — pipeline administrativo mínimo do Cronograma
   (Sprint 16 v1.2, seção 3/9 da ordem). CRUD mínimo: criar, listar,
   editar (mesmo formulário, reaproveitado — "editingId" define se o
   submit cria ou atualiza), excluir (bloqueado pelo backend se a
   atividade já tem atribuição real de aluno). Sem importação em massa,
   sem calendário — só o catálogo de definições de atividade. */

interface FormState {
  type: string;
  title: string;
  objective: string;
  estimatedMinutes: string;
  completionCriteria: string;
  explanation: string;
  completionMode: string;
  origin: string;
  resourceRef: string;
  dismissible: boolean;
}

function emptyForm(): FormState {
  return {
    type: SCHEDULE_ACTIVITY_TYPES[0],
    title: "",
    objective: "",
    estimatedMinutes: "",
    completionCriteria: "",
    explanation: "",
    completionMode: SCHEDULE_COMPLETION_MODES[0],
    origin: SCHEDULE_ACTIVITY_ORIGINS[0],
    resourceRef: "",
    dismissible: true,
  };
}

function toInput(form: FormState): Omit<ScheduleActivityInput, "mutationId"> {
  return {
    type: form.type,
    title: form.title.trim(),
    objective: form.objective.trim(),
    estimatedMinutes: Number(form.estimatedMinutes),
    completionCriteria: form.completionCriteria.trim(),
    explanation: form.explanation.trim(),
    completionMode: form.completionMode,
    origin: form.origin,
    resourceRef: form.resourceRef.trim() || null,
    dismissible: form.dismissible,
  };
}

export function AdminSchedulePage() {
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [activities, setActivities] = useState<ScheduleActivityAdmin[]>([]);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [activityToDelete, setActivityToDelete] = useState<ScheduleActivityAdmin | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPhase("loading");
    try {
      const result = await fetchAdminScheduleActivities();
      setActivities(result.activities);
      setPhase("ready");
    } catch {
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  function startEdit(activity: ScheduleActivityAdmin) {
    setEditingId(activity.id);
    setForm({
      type: activity.type,
      title: activity.title,
      objective: activity.objective,
      estimatedMinutes: String(activity.estimatedMinutes),
      completionCriteria: activity.completionCriteria,
      explanation: activity.explanation,
      completionMode: activity.completionMode,
      origin: activity.origin,
      resourceRef: activity.resourceRef ?? "",
      dismissible: activity.dismissible,
    });
    setSaveError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(emptyForm());
    setSaveError(null);
  }

  const canSubmit =
    form.title.trim().length > 0 &&
    form.objective.trim().length > 0 &&
    form.completionCriteria.trim().length > 0 &&
    form.explanation.trim().length > 0 &&
    Number.isInteger(Number(form.estimatedMinutes)) &&
    Number(form.estimatedMinutes) > 0;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const input = toInput(form);
      if (editingId) {
        await updateAdminScheduleActivity(editingId, { ...input, mutationId: crypto.randomUUID() });
      } else {
        await createAdminScheduleActivity({ ...input, mutationId: crypto.randomUUID() });
      }
      cancelEdit();
      await load();
    } catch (error) {
      setSaveError(error instanceof AdminApiError ? error.message : "Não foi possível salvar a atividade.");
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!activityToDelete || deletingId) return;
    setDeletingId(activityToDelete.id);
    setDeleteError(null);
    try {
      await deleteAdminScheduleActivity(activityToDelete.id);
      setActivityToDelete(null);
      await load();
    } catch (error) {
      setDeleteError(error instanceof AdminApiError ? error.message : "Não foi possível excluir a atividade.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="admin-page">
      <PageTitle title="Cronograma" description="Cadastrar e manter o catálogo real de atividades do cronograma adaptativo." />

      <section aria-labelledby="admin-schedule-form-heading">
        <h2 id="admin-schedule-form-heading" className="admin-page__section-title">
          {editingId ? "Editar atividade" : "Nova atividade"}
        </h2>
        <form className="admin-page__content-form" onSubmit={(event) => void handleSubmit(event)}>
          <div className="admin-page__content-form-grid">
            <div className="admin-page__field">
              <label className="admin-page__field-label" htmlFor="sched-type">
                Tipo
              </label>
              <select id="sched-type" value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}>
                {SCHEDULE_ACTIVITY_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </div>
            <div className="admin-page__field">
              <label className="admin-page__field-label" htmlFor="sched-title">
                Título
              </label>
              <input id="sched-title" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
            </div>
            <div className="admin-page__field">
              <label className="admin-page__field-label" htmlFor="sched-minutes">
                Duração estimada (minutos)
              </label>
              <input
                id="sched-minutes"
                type="number"
                min={1}
                value={form.estimatedMinutes}
                onChange={(event) => setForm({ ...form, estimatedMinutes: event.target.value })}
              />
            </div>
            <div className="admin-page__field">
              <label className="admin-page__field-label" htmlFor="sched-mode">
                Modo de conclusão
              </label>
              <select id="sched-mode" value={form.completionMode} onChange={(event) => setForm({ ...form, completionMode: event.target.value })}>
                {SCHEDULE_COMPLETION_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </select>
            </div>
            <div className="admin-page__field">
              <label className="admin-page__field-label" htmlFor="sched-origin">
                Origem
              </label>
              <select id="sched-origin" value={form.origin} onChange={(event) => setForm({ ...form, origin: event.target.value })}>
                {SCHEDULE_ACTIVITY_ORIGINS.map((origin) => (
                  <option key={origin} value={origin}>
                    {origin}
                  </option>
                ))}
              </select>
            </div>
            <div className="admin-page__field">
              <label className="admin-page__field-label" htmlFor="sched-resource">
                Referência de recurso (opcional)
              </label>
              <input id="sched-resource" value={form.resourceRef} onChange={(event) => setForm({ ...form, resourceRef: event.target.value })} />
            </div>
          </div>

          <div className="admin-page__field">
            <label className="admin-page__field-label" htmlFor="sched-objective">
              Objetivo
            </label>
            <textarea id="sched-objective" rows={2} value={form.objective} onChange={(event) => setForm({ ...form, objective: event.target.value })} />
          </div>
          <div className="admin-page__field">
            <label className="admin-page__field-label" htmlFor="sched-criteria">
              Critério de conclusão
            </label>
            <textarea
              id="sched-criteria"
              rows={2}
              value={form.completionCriteria}
              onChange={(event) => setForm({ ...form, completionCriteria: event.target.value })}
            />
          </div>
          <div className="admin-page__field">
            <label className="admin-page__field-label" htmlFor="sched-explanation">
              Explicação exibida ao aluno ("Por que esta atividade?")
            </label>
            <textarea id="sched-explanation" rows={2} value={form.explanation} onChange={(event) => setForm({ ...form, explanation: event.target.value })} />
          </div>
          <div className="admin-page__field">
            <label>
              <input type="checkbox" checked={form.dismissible} onChange={(event) => setForm({ ...form, dismissible: event.target.checked })} /> Aluno pode
              dispensar esta atividade
            </label>
          </div>

          <div className="admin-page__filters">
            <Button type="submit" isLoading={saving} disabled={!canSubmit || saving}>
              {editingId ? "Salvar alterações" : "Criar atividade"}
            </Button>
            {editingId && (
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

      <section aria-labelledby="admin-schedule-list-heading">
        <h2 id="admin-schedule-list-heading" className="admin-page__section-title">
          Atividades cadastradas
        </h2>
        {phase === "loading" ? (
          <LoadingState label="Carregando atividades…" />
        ) : phase === "error" ? (
          <ErrorState description="Não foi possível carregar as atividades." action={<Button onClick={() => void load()}>Tentar novamente</Button>} />
        ) : activities.length === 0 ? (
          <EmptyState title="Nenhuma atividade real cadastrada ainda" description="Use o formulário acima para cadastrar a primeira." />
        ) : (
          <div className="admin-page__table-wrap">
            <table className="admin-page__table">
              <thead>
                <tr>
                  <th scope="col">Título</th>
                  <th scope="col">Tipo</th>
                  <th scope="col">Duração</th>
                  <th scope="col">
                    <span className="admin-page__sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {activities.map((activity) => (
                  <tr key={activity.id}>
                    <td>{activity.title}</td>
                    <td>{activity.type}</td>
                    <td>{activity.estimatedMinutes} min</td>
                    <td>
                      <div className="admin-page__filters">
                        <Button type="button" variant="secondary" onClick={() => startEdit(activity)} disabled={saving}>
                          Editar
                        </Button>
                        <Button type="button" variant="secondary" onClick={() => setActivityToDelete(activity)} disabled={deletingId !== null}>
                          Excluir
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Modal isOpen={activityToDelete !== null} title="Excluir atividade" onClose={() => setActivityToDelete(null)}>
        <p>
          Tem certeza de que deseja excluir a atividade <strong>{activityToDelete?.title}</strong>?
        </p>
        {deleteError && (
          <p className="admin-page__form-error" role="alert">
            {deleteError}
          </p>
        )}
        <div className="admin-page__filters">
          <Button type="button" variant="secondary" onClick={() => setActivityToDelete(null)} disabled={deletingId !== null}>
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
