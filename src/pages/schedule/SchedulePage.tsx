import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Alert } from "../../components/Alert";
import { Badge, type BadgeStatus } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { LoadingState } from "../../components/LoadingState";
import { Modal } from "../../components/Modal";
import { ProgressBar } from "../../components/ProgressBar";
import {
  applySchedulePlan,
  completeScheduleActivity,
  dismissScheduleActivity,
  fetchScheduleActivities,
  fetchScheduleSummary,
  previewSchedulePlan,
  rescheduleScheduleActivity,
  startScheduleActivity,
  ScheduleApiError,
  type ScheduleActivity,
  type SchedulePlanPreview,
  type ScheduleSummary,
  type ScheduleView,
} from "../../api/scheduleClient";
import { MonthCalendarGrid } from "./MonthCalendarGrid";
import { ACTIVITY_TYPE_LABELS, BLOCK_REASON_LABELS, STATUS_LABELS, VIEW_OPTIONS } from "./scheduleOptions";
import "./SchedulePage.css";

const VALID_VIEWS = new Set(VIEW_OPTIONS.map((option) => option.value));

function statusBadgeStatus(effectiveStatus: string): BadgeStatus {
  switch (effectiveStatus) {
    case "completed":
      return "sucesso";
    case "overdue":
      return "prioridade-alta";
    case "in_progress":
      return "em-evolucao";
    case "dismissed":
    case "rescheduled":
      return "neutro";
    case "blocked":
      return "erro";
    default:
      return "nao-iniciado";
  }
}

interface ActivityCardProps {
  activity: ScheduleActivity;
  onOpenDetail: (activity: ScheduleActivity) => void;
  onStart: (activity: ScheduleActivity) => void;
  onComplete: (activity: ScheduleActivity) => void;
  onDismiss: (activity: ScheduleActivity) => void;
  onReschedule: (activity: ScheduleActivity) => void;
  busy: boolean;
}

function ActivityCard({ activity, onOpenDetail, onStart, onComplete, onDismiss, onReschedule, busy }: ActivityCardProps) {
  const isFinal = ["completed", "dismissed", "rescheduled", "blocked"].includes(activity.status);
  const canStart = activity.status === "not_started";
  const canComplete = (activity.status === "not_started" || activity.status === "in_progress") && activity.completionMode === "manual";
  const canDismiss = (activity.status === "not_started" || activity.status === "in_progress") && activity.dismissible;
  const canReschedule = activity.status === "not_started" || activity.status === "in_progress";

  return (
    <Card className="schedule__card">
      {activity.isLocalFixture && (
        <p className="schedule__provisional-notice" role="note">
          CONTEÚDO TÉCNICO PROVISÓRIO — NÃO PUBLICAR
        </p>
      )}
      <div className="schedule__card-header">
        <span className="schedule__card-type">{ACTIVITY_TYPE_LABELS[activity.type] ?? activity.type}</span>
        <Badge status={statusBadgeStatus(activity.effectiveStatus)} label={STATUS_LABELS[activity.effectiveStatus] ?? activity.effectiveStatus} />
      </div>
      <h3 className="schedule__card-title">{activity.title}</h3>
      <p className="schedule__card-objective">{activity.objective}</p>
      <p className="schedule__card-duration">Duração estimada: {activity.estimatedMinutes} min</p>
      {activity.inDailyTraining && (
        <p className="schedule__daily-training-notice" role="note">
          Já está no treino de hoje
        </p>
      )}
      {activity.status === "blocked" && activity.lastTransitionReason && (
        <p className="schedule__card-block-reason">
          Motivo: {BLOCK_REASON_LABELS[activity.lastTransitionReason] ?? activity.lastTransitionReason}
        </p>
      )}
      <button type="button" className="schedule__why-link" onClick={() => onOpenDetail(activity)}>
        Por que esta atividade?
      </button>
      {!isFinal && (
        <div className="schedule__card-actions">
          {canStart && (
            <Button type="button" variant="secondary" onClick={() => onStart(activity)} disabled={busy}>
              Iniciar
            </Button>
          )}
          {canComplete && (
            <Button type="button" onClick={() => onComplete(activity)} disabled={busy}>
              Concluir
            </Button>
          )}
          {canReschedule && (
            <Button type="button" variant="secondary" onClick={() => onReschedule(activity)} disabled={busy}>
              Reagendar
            </Button>
          )}
          {canDismiss && (
            <Button type="button" variant="text" onClick={() => onDismiss(activity)} disabled={busy}>
              Dispensar
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

function activitiesByDate(activities: ScheduleActivity[]): Map<string, ScheduleActivity[]> {
  const map = new Map<string, ScheduleActivity[]>();
  for (const activity of activities) {
    if (!activity.plannedDate) continue;
    const list = map.get(activity.plannedDate) ?? [];
    list.push(activity);
    map.set(activity.plannedDate, list);
  }
  return map;
}

function selectedDayActivities(activities: ScheduleActivity[], date: string): ScheduleActivity[] {
  return activities.filter((activity) => activity.plannedDate === date);
}

export function SchedulePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawView = searchParams.get("view") ?? "today";
  const view = (VALID_VIEWS.has(rawView) ? rawView : "today") as ScheduleView;
  const year = searchParams.get("year") ? Number(searchParams.get("year")) : undefined;
  const month = searchParams.get("month") ? Number(searchParams.get("month")) : undefined;

  const [phase, setPhase] = useState<"loading" | "ready" | "unavailable" | "error">("loading");
  const [summary, setSummary] = useState<ScheduleSummary | null>(null);
  const [activities, setActivities] = useState<ScheduleActivity[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [detailActivity, setDetailActivity] = useState<ScheduleActivity | null>(null);
  const [rescheduleActivity, setRescheduleActivity] = useState<ScheduleActivity | null>(null);
  const [preview, setPreview] = useState<SchedulePlanPreview | null>(null);
  const [showApplyConfirm, setShowApplyConfirm] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPhase("loading");
    try {
      const summaryResult = await fetchScheduleSummary();
      if (!summaryResult.available) {
        setPhase("unavailable");
        return;
      }
      setSummary(summaryResult);
      const activitiesResult = await fetchScheduleActivities(view, { year, month });
      setActivities(activitiesResult.activities);
      setPhase("ready");
    } catch {
      setPhase("error");
    }
  }, [view, year, month]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Ano/mês efetivos da grade: os da URL, ou os de "hoje" (sempre vindos do
  // resumo do Worker — nunca do relógio do navegador) assim que carregado.
  const effectiveYear = year ?? (summary ? Number(summary.today.slice(0, 4)) : undefined);
  const effectiveMonth = month ?? (summary ? Number(summary.today.slice(5, 7)) : undefined);

  function changeView(nextView: string) {
    const next = new URLSearchParams();
    next.set("view", nextView);
    setSearchParams(next);
    setSelectedDate(null);
  }

  function navigateMonth(nextYear: number, nextMonth: number) {
    const next = new URLSearchParams();
    next.set("view", "month");
    next.set("year", String(nextYear));
    next.set("month", String(nextMonth));
    setSearchParams(next);
    setSelectedDate(null);
  }

  async function runAction(action: () => Promise<unknown>, successMessage: string) {
    setSaveState("saving");
    setActionMessage(null);
    try {
      await action();
      setSaveState("saved");
      setActionMessage(successMessage);
      await load();
    } catch (error) {
      setSaveState("error");
      if (error instanceof ScheduleApiError && error.code === "conflict") {
        setActionMessage("Esta atividade foi alterada por outra requisição. Recarregando...");
        await load();
      } else if (error instanceof ScheduleApiError && error.code === "no_capacity") {
        setActionMessage("Não há capacidade disponível para reagendar dentro do horizonte técnico.");
      } else {
        setActionMessage("Não foi possível concluir esta ação. Tente novamente.");
      }
    }
  }

  function handleStart(activity: ScheduleActivity) {
    void runAction(() => startScheduleActivity(activity.id, activity.version), "Atividade iniciada.");
  }
  function handleComplete(activity: ScheduleActivity) {
    void runAction(() => completeScheduleActivity(activity.id, activity.version), "Atividade concluída.");
  }
  function handleDismiss(activity: ScheduleActivity) {
    void runAction(() => dismissScheduleActivity(activity.id, activity.version), "Atividade dispensada.");
  }
  function confirmReschedule() {
    if (!rescheduleActivity) return;
    const activity = rescheduleActivity;
    setRescheduleActivity(null);
    void runAction(() => rescheduleScheduleActivity(activity.id, activity.version), "Atividade reagendada.");
  }

  async function handlePreviewPlan() {
    setSaveState("saving");
    try {
      const result = await previewSchedulePlan();
      setPreview(result);
      setSaveState("idle");
    } catch {
      setSaveState("error");
      setActionMessage("Não foi possível gerar a prévia do plano.");
    }
  }

  async function handleApplyPlan() {
    if (!preview) return;
    setShowApplyConfirm(false);
    await runAction(() => applySchedulePlan(preview.previewId), "Plano aplicado.");
    setPreview(null);
  }

  if (phase === "loading") {
    return <LoadingState label="Carregando seu cronograma…" />;
  }

  if (phase === "unavailable") {
    return (
      <div className="schedule schedule--centered">
        <Card className="schedule__card">
          <h1>Ainda não há atividades cadastradas</h1>
          <p>
            O cronograma adaptativo já está pronto tecnicamente, mas nenhuma atividade está disponível
            neste ambiente agora. Isso não é um erro do seu lado — tente novamente mais tarde.
          </p>
        </Card>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <ErrorState
        description="Não foi possível carregar seu cronograma."
        action={
          <Button onClick={() => void load()}>Tentar novamente</Button>
        }
      />
    );
  }

  return (
    <div className="schedule">
      <header className="schedule__header">
        <h1>Cronograma</h1>
        {summary && (
          <div className="schedule__capacity" aria-live="polite">
            <ProgressBar
              label={`Capacidade de hoje: ${summary.plannedMinutesToday} / ${summary.availableMinutesToday} minutos planejados`}
              value={
                summary.availableMinutesToday > 0
                  ? Math.min(100, Math.round((summary.plannedMinutesToday / summary.availableMinutesToday) * 100))
                  : 0
              }
            />
          </div>
        )}
      </header>

      <nav className="schedule__tabs" aria-label="Visualizações do cronograma">
        {VIEW_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`schedule__tab${view === option.value ? " schedule__tab--active" : ""}`}
            aria-current={view === option.value ? "page" : undefined}
            onClick={() => changeView(option.value)}
          >
            {option.label}
          </button>
        ))}
      </nav>

      <div className="schedule__save-indicator" role="status" aria-live="polite">
        {saveState === "saving" && "Salvando…"}
        {actionMessage}
      </div>

      {view === "pending" && (
        <Card className="schedule__card schedule__plan-card">
          <h2>Planejar atividades pendentes</h2>
          <p>Gere uma prévia de onde cada atividade pendente cabe na sua disponibilidade configurada.</p>
          <Button type="button" onClick={() => void handlePreviewPlan()} isLoading={saveState === "saving"}>
            Gerar prévia do plano
          </Button>
          {preview && (
            <div className="schedule__plan-preview">
              <p>{preview.placed.length} atividade(s) encontraram data disponível.</p>
              {preview.unplaceableAssignmentIds.length > 0 && (
                <Alert variant="info">
                  {preview.unplaceableAssignmentIds.length} atividade(s) não couberam na sua
                  disponibilidade configurada dentro do horizonte técnico e continuam pendentes.
                </Alert>
              )}
              <Button type="button" onClick={() => setShowApplyConfirm(true)}>
                Aplicar plano
              </Button>
            </div>
          )}
        </Card>
      )}

      {view === "month" && effectiveYear && effectiveMonth && summary ? (
        <>
          <MonthCalendarGrid
            year={effectiveYear}
            month={effectiveMonth}
            today={summary.today}
            activitiesByDate={activitiesByDate(activities)}
            selectedDate={selectedDate}
            onSelectDate={setSelectedDate}
            onNavigate={navigateMonth}
          />
          {selectedDate && (
            <section className="schedule__day-detail" aria-label={`Atividades de ${selectedDate}`}>
              <h3>Atividades de {selectedDate}</h3>
              {selectedDayActivities(activities, selectedDate).length === 0 ? (
                <EmptyState title="Nada por aqui" description="Nenhuma atividade planejada para este dia." />
              ) : (
                <div className="schedule__grid">
                  {selectedDayActivities(activities, selectedDate).map((activity) => (
                    <ActivityCard
                      key={activity.id}
                      activity={activity}
                      onOpenDetail={setDetailActivity}
                      onStart={handleStart}
                      onComplete={handleComplete}
                      onDismiss={handleDismiss}
                      onReschedule={setRescheduleActivity}
                      busy={saveState === "saving"}
                    />
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      ) : activities.length === 0 ? (
        <EmptyState
          title="Nada por aqui"
          description="Nenhuma atividade nesta visão no momento."
        />
      ) : (
        <div className="schedule__grid">
          {activities.map((activity) => (
            <ActivityCard
              key={activity.id}
              activity={activity}
              onOpenDetail={setDetailActivity}
              onStart={handleStart}
              onComplete={handleComplete}
              onDismiss={handleDismiss}
              onReschedule={setRescheduleActivity}
              busy={saveState === "saving"}
            />
          ))}
        </div>
      )}

      <Modal isOpen={detailActivity !== null} title={detailActivity?.title ?? ""} onClose={() => setDetailActivity(null)}>
        {detailActivity && (
          <div className="schedule__detail">
            <p>
              <strong>Objetivo:</strong> {detailActivity.objective}
            </p>
            <p>
              <strong>Critério de conclusão:</strong> {detailActivity.completionCriteria}
            </p>
            <p>
              <strong>Por que esta atividade?</strong> {detailActivity.explanation}
            </p>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={rescheduleActivity !== null}
        title="Reagendar atividade?"
        onClose={() => setRescheduleActivity(null)}
      >
        <p>
          Vamos procurar o próximo dia disponível com capacidade, respeitando sua disponibilidade
          configurada. Se não houver capacidade no horizonte técnico, nada será alterado.
        </p>
        <div className="schedule__actions">
          <Button variant="secondary" onClick={() => setRescheduleActivity(null)}>
            Cancelar
          </Button>
          <Button onClick={confirmReschedule}>Reagendar</Button>
        </div>
      </Modal>

      <Modal isOpen={showApplyConfirm} title="Aplicar este plano?" onClose={() => setShowApplyConfirm(false)}>
        <p>As atividades da prévia serão distribuídas nas datas calculadas.</p>
        <div className="schedule__actions">
          <Button variant="secondary" onClick={() => setShowApplyConfirm(false)}>
            Cancelar
          </Button>
          <Button onClick={() => void handleApplyPlan()}>Aplicar</Button>
        </div>
      </Modal>
    </div>
  );
}
