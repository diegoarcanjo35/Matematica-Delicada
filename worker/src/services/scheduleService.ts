import { findProfile } from "../repositories/onboardingRepository";
import {
  buildConditionalTransitionEventStatement,
  buildInsertAssignmentStatement,
  buildInsertEventStatement,
  buildMarkPreviewAppliedStatement,
  buildMarkRescheduledStatement,
  buildTransitionStatement,
  buildUpsertTimezoneStatement,
  findActivity,
  findAssignment,
  findPlanPreview,
  getPreferences,
  insertPlanPreview,
  listActivitiesByIds,
  listAssignmentsForUser,
  listAssignmentsInDateRange,
  listLocalFixtureActivities,
  listPendingAssignments,
  sumActiveMinutesForDay,
  type ScheduleActivityRow,
  type ScheduleAssignmentRow,
} from "../repositories/scheduleRepository";
import {
  addCivilDays,
  civilDateInTimezone,
  compareCivilDates,
  PLAN_PREVIEW_TTL_MS,
  SCHEDULE_HORIZON_DAYS,
  weekdayCodeForCivilDate,
  type BlockReason,
  type WeekdayCode,
} from "../lib/scheduleValidation";

/* Serviço do cronograma adaptativo — Sprint 5 v1.0. Orquestra validação,
   atomicidade (db.batch()) e as regras de negócio das seções 7/8/9/11/12 da
   ordem. user_id é SEMPRE recebido de quem chama (routes/schedule.ts), que
   por sua vez deriva exclusivamente da sessão. */

function newId(): string {
  return crypto.randomUUID();
}

/** Relógio injetável (seção 9 da ordem: nunca depender implicitamente do
 *  relógio da máquina do servidor em testes; produção usa o relógio real). */
export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

const DEFAULT_TIMEZONE = "America/Sao_Paulo";

export async function getTimezone(db: D1Database, userId: string): Promise<string> {
  const prefs = await getPreferences(db, userId);
  return prefs?.timezone ?? DEFAULT_TIMEZONE;
}

export async function setTimezone(db: D1Database, userId: string, timezone: string): Promise<void> {
  await db.batch([buildUpsertTimezoneStatement(db, userId, timezone)]);
}

interface Availability {
  availableDays: WeekdayCode[];
  dailyMinutes: number;
}

async function getAvailability(db: D1Database, userId: string): Promise<Availability> {
  const profile = await findProfile(db, userId);
  const availableDays = ((profile?.available_days ? JSON.parse(profile.available_days) : []) as string[]).filter(
    (day): day is WeekdayCode => (["dom", "seg", "ter", "qua", "qui", "sex", "sab"] as string[]).includes(day)
  );
  return { availableDays, dailyMinutes: profile?.daily_minutes ?? 0 };
}

/* ---------------------------------------------------------------------- */
/* Estado efetivo × estado persistido (seção 5 da ordem)                   */
/* ---------------------------------------------------------------------- */

export type EffectiveStatus = ScheduleAssignmentRow["status"] | "overdue";

/** 'overdue' NUNCA é persistido — é sempre derivado na leitura comparando a
 *  data planejada com "hoje" no fuso do aluno. Uma leitura GET nunca grava
 *  nada (seção 5: "uma leitura GET não deve realizar mutação silenciosa"). */
export function effectiveStatus(assignment: ScheduleAssignmentRow, todayCivil: string): EffectiveStatus {
  if (
    (assignment.status === "not_started" || assignment.status === "in_progress") &&
    assignment.planned_date !== null &&
    compareCivilDates(assignment.planned_date, todayCivil) < 0
  ) {
    return "overdue";
  }
  return assignment.status as EffectiveStatus;
}

export interface AssignmentView {
  id: string;
  activityId: string;
  type: string;
  title: string;
  objective: string;
  estimatedMinutes: number;
  completionCriteria: string;
  explanation: string;
  completionMode: string;
  origin: string;
  dismissible: boolean;
  isLocalFixture: boolean;
  plannedDate: string | null;
  position: number | null;
  status: string;
  effectiveStatus: EffectiveStatus;
  version: number;
  startedAt: string | null;
  completedAt: string | null;
  // Só motivos técnicos fechados (start/complete/dismiss/reschedule/block) —
  // nunca texto livre, nunca conteúdo sensível (seção 3 da correção v1.1).
  lastTransitionReason: string | null;
}

function toView(assignment: ScheduleAssignmentRow, activity: ScheduleActivityRow, todayCivil: string): AssignmentView {
  return {
    id: assignment.id,
    activityId: activity.id,
    type: activity.type,
    title: activity.title,
    objective: activity.objective,
    estimatedMinutes: activity.estimated_minutes,
    completionCriteria: activity.completion_criteria,
    explanation: activity.explanation,
    completionMode: activity.completion_mode,
    origin: activity.origin,
    dismissible: activity.dismissible === 1,
    isLocalFixture: activity.is_local_fixture === 1,
    plannedDate: assignment.planned_date,
    position: assignment.position,
    status: assignment.status,
    effectiveStatus: effectiveStatus(assignment, todayCivil),
    lastTransitionReason: assignment.last_transition_reason,
    version: assignment.version,
    startedAt: assignment.started_at,
    completedAt: assignment.completed_at,
  };
}

async function toViews(db: D1Database, assignments: ScheduleAssignmentRow[], todayCivil: string): Promise<AssignmentView[]> {
  const activities = await listActivitiesByIds(db, [...new Set(assignments.map((a) => a.activity_id))]);
  const activityById = new Map(activities.map((activity) => [activity.id, activity]));
  return assignments
    .map((assignment) => {
      const activity = activityById.get(assignment.activity_id);
      return activity ? toView(assignment, activity, todayCivil) : null;
    })
    .filter((view): view is AssignmentView => view !== null);
}

/* ---------------------------------------------------------------------- */
/* Resumo e visões                                                         */
/* ---------------------------------------------------------------------- */

export interface ScheduleSummary {
  available: boolean;
  today: string;
  timezone: string;
  plannedMinutesToday: number;
  availableMinutesToday: number;
  pendingCount: number;
}

/** Lista as atividades de fixture locais que este usuário ainda NÃO tem em
 *  nenhuma atribuição (nem pendente, nem já datada, nem em histórico) — o
 *  conjunto de candidatas que `previewPlan()` pode oferecer pela primeira
 *  vez. Correção v1.1, seção 2: nenhuma leitura cria nada; só esta função
 *  (chamada apenas por previewPlan/applyPlan, nunca por um GET) enxerga
 *  fixtures ainda não atribuídas. */
async function listUnassignedFixtureActivities(db: D1Database, userId: string): Promise<ScheduleActivityRow[]> {
  const [fixtureActivities, existing] = await Promise.all([
    listLocalFixtureActivities(db),
    listAssignmentsForUser(db, userId),
  ]);
  const assignedActivityIds = new Set(existing.map((assignment) => assignment.activity_id));
  return fixtureActivities.filter((activity) => !assignedActivityIds.has(activity.id));
}

export async function getSummary(
  db: D1Database,
  userId: string,
  fixturesAllowed: boolean,
  clock: Clock
): Promise<ScheduleSummary> {
  const timezone = await getTimezone(db, userId);
  const today = civilDateInTimezone(clock.now(), timezone);
  if (!fixturesAllowed) {
    return { available: false, today, timezone, plannedMinutesToday: 0, availableMinutesToday: 0, pendingCount: 0 };
  }
  const [plannedMinutesToday, availability, pending] = await Promise.all([
    sumActiveMinutesForDay(db, userId, today),
    getAvailability(db, userId),
    listPendingAssignments(db, userId),
  ]);
  return {
    available: true,
    today,
    timezone,
    plannedMinutesToday,
    availableMinutesToday: availability.dailyMinutes,
    pendingCount: pending.length,
  };
}

export type ScheduleView = "today" | "week" | "month" | "pending" | "reviews" | "assigned" | "history";

const HISTORY_STATUSES = new Set(["completed", "dismissed", "rescheduled"]);
const ACTIVE_STATUSES = new Set(["not_started", "in_progress"]);

export async function getActivitiesView(
  db: D1Database,
  userId: string,
  view: ScheduleView,
  clock: Clock,
  params: { year?: number; month?: number } = {}
): Promise<AssignmentView[]> {
  const timezone = await getTimezone(db, userId);
  const today = civilDateInTimezone(clock.now(), timezone);

  if (view === "pending") {
    const assignments = await listPendingAssignments(db, userId);
    return toViews(db, assignments, today);
  }

  if (view === "today") {
    const assignments = await listAssignmentsInDateRange(db, userId, today, today);
    return toViews(db, assignments, today);
  }

  if (view === "week") {
    const weekEnd = addCivilDays(today, 6);
    const assignments = await listAssignmentsInDateRange(db, userId, today, weekEnd);
    return toViews(db, assignments, today);
  }

  if (view === "month") {
    const [yearStr, monthStr] = today.split("-");
    const year = params.year ?? Number(yearStr);
    const month = params.month ?? Number(monthStr);
    const from = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const to = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    const assignments = await listAssignmentsInDateRange(db, userId, from, to);
    return toViews(db, assignments, today);
  }

  const all = await listAssignmentsForUser(db, userId);

  if (view === "history") {
    return toViews(db, all.filter((a) => HISTORY_STATUSES.has(a.status)), today);
  }

  if (view === "assigned") {
    return toViews(
      db,
      all.filter((a) => ACTIVE_STATUSES.has(a.status) && a.planned_date !== null),
      today
    );
  }

  // reviews
  const activities = await listActivitiesByIds(db, [...new Set(all.map((a) => a.activity_id))]);
  const reviewActivityIds = new Set(activities.filter((activity) => activity.type === "revisao_espacada").map((a) => a.id));
  return toViews(
    db,
    all.filter((a) => ACTIVE_STATUSES.has(a.status) && reviewActivityIds.has(a.activity_id)),
    today
  );
}

export async function getAssignmentDetail(
  db: D1Database,
  userId: string,
  assignmentId: string,
  clock: Clock
): Promise<AssignmentView | null> {
  const assignment = await findAssignment(db, assignmentId);
  if (!assignment || assignment.user_id !== userId) return null;
  const activity = await findActivity(db, assignment.activity_id);
  if (!activity) return null;
  const timezone = await getTimezone(db, userId);
  const today = civilDateInTimezone(clock.now(), timezone);
  return toView(assignment, activity, today);
}

/* ---------------------------------------------------------------------- */
/* Transições (start / complete / dismiss)                                 */
/* ---------------------------------------------------------------------- */

export interface TransitionResult {
  ok: boolean;
  // Correção v1.2 — distingue mutação real de repetição idempotente, para
  // que o chamador (rota HTTP) só audite quando algo de fato mudou.
  changed?: boolean;
  notFound?: boolean;
  conflict?: boolean;
  fieldErrors?: Record<string, string>;
}

async function applyGuardedTransition(
  db: D1Database,
  params: {
    userId: string;
    assignmentId: string;
    expectedVersion: number;
    fromStatuses: string[];
    toStatus: string;
    reason: string;
    timestampColumn: "started_at" | "completed_at" | "dismissed_at" | "blocked_at" | null;
    auditEventType: string;
  }
): Promise<TransitionResult> {
  const before = await findAssignment(db, params.assignmentId);
  if (!before || before.user_id !== params.userId) return { ok: false, notFound: true };

  const updateStatement = buildTransitionStatement(db, {
    assignmentId: params.assignmentId,
    userId: params.userId,
    expectedVersion: params.expectedVersion,
    fromStatuses: params.fromStatuses,
    toStatus: params.toStatus,
    reason: params.reason,
    timestampColumn: params.timestampColumn,
  });
  // Correção v1.2 — UPDATE da transição e INSERT do histórico no MESMO
  // db.batch() (uma única transação): o evento só persiste se a linha, já
  // depois do UPDATE anterior no mesmo lote, estiver exatamente na
  // versão/estado alvo. Uma falha forçada em qualquer um dos dois statements
  // reverte o lote inteiro — nunca fica estado alterado sem o evento
  // correspondente.
  const eventStatement = buildConditionalTransitionEventStatement(db, {
    id: newId(),
    assignmentId: params.assignmentId,
    userId: params.userId,
    fromStatus: before.status,
    toStatus: params.toStatus,
    reason: params.reason,
    expectedVersionAfter: params.expectedVersion + 1,
  });
  const [updateResult] = await db.batch([updateStatement, eventStatement]);

  if (updateResult.meta.changes === 1) {
    return { ok: true, changed: true };
  }

  const after = await findAssignment(db, params.assignmentId);
  if (!after) return { ok: false, notFound: true };
  if (after.status === params.toStatus && after.version === params.expectedVersion + 1) {
    // Repetição idempotente da mesma transição já concluída. O UPDATE não
    // mudou nada agora (a versão enviada já está obsoleta), e o evento
    // também não duplicou — o guard `NOT EXISTS` de
    // buildConditionalTransitionEventStatement já impediu isso, já que o
    // evento real foi gravado na primeira chamada.
    return { ok: true, changed: false };
  }
  if (after.version !== params.expectedVersion) {
    return { ok: false, conflict: true };
  }
  return { ok: false, fieldErrors: { status: "Esta atividade não está num estado que permita esta ação." } };
}

export async function startAssignment(
  db: D1Database,
  userId: string,
  assignmentId: string,
  expectedVersion: number
): Promise<TransitionResult> {
  return applyGuardedTransition(db, {
    userId,
    assignmentId,
    expectedVersion,
    fromStatuses: ["not_started"],
    toStatus: "in_progress",
    reason: "manual_start",
    timestampColumn: "started_at",
    auditEventType: "schedule_activity_started",
  });
}

export async function completeAssignment(
  db: D1Database,
  userId: string,
  assignmentId: string,
  expectedVersion: number
): Promise<TransitionResult> {
  const assignment = await findAssignment(db, assignmentId);
  if (!assignment || assignment.user_id !== userId) return { ok: false, notFound: true };
  const activity = await findActivity(db, assignment.activity_id);
  if (!activity) return { ok: false, notFound: true };
  if (activity.completion_mode !== "manual") {
    return {
      ok: false,
      fieldErrors: { completionMode: "Esta atividade não pode ser concluída manualmente." },
    };
  }
  return applyGuardedTransition(db, {
    userId,
    assignmentId,
    expectedVersion,
    fromStatuses: ["not_started", "in_progress"],
    toStatus: "completed",
    reason: "manual_complete",
    timestampColumn: "completed_at",
    auditEventType: "schedule_activity_completed",
  });
}

export async function dismissAssignment(
  db: D1Database,
  userId: string,
  assignmentId: string,
  expectedVersion: number
): Promise<TransitionResult> {
  const assignment = await findAssignment(db, assignmentId);
  if (!assignment || assignment.user_id !== userId) return { ok: false, notFound: true };
  const activity = await findActivity(db, assignment.activity_id);
  if (!activity) return { ok: false, notFound: true };
  if (activity.dismissible !== 1) {
    return { ok: false, fieldErrors: { dismissible: "Esta atividade não pode ser dispensada." } };
  }
  return applyGuardedTransition(db, {
    userId,
    assignmentId,
    expectedVersion,
    fromStatuses: ["not_started", "in_progress"],
    toStatus: "dismissed",
    reason: "manual_dismiss",
    timestampColumn: "dismissed_at",
    auditEventType: "schedule_activity_dismissed",
  });
}

/** Correção v1.1, seção 3 — transição real para `blocked`. Só uma atividade
 *  não final pode ser bloqueada; motivo restrito ao enum técnico fechado
 *  (`BLOCK_REASONS`), nunca texto livre nem razão pedagógica. Sem perfil de
 *  professor/admin nesta sprint — a rota existe como fundação técnica,
 *  exercitável por API/testes locais; a UI só renderiza o estado e o
 *  motivo, sem oferecer um botão genérico "Bloquear" ao aluno. */
export async function blockAssignment(
  db: D1Database,
  userId: string,
  assignmentId: string,
  expectedVersion: number,
  reason: BlockReason
): Promise<TransitionResult> {
  return applyGuardedTransition(db, {
    userId,
    assignmentId,
    expectedVersion,
    fromStatuses: ["not_started", "in_progress"],
    toStatus: "blocked",
    reason,
    timestampColumn: "blocked_at",
    auditEventType: "schedule_activity_blocked",
  });
}

/* ---------------------------------------------------------------------- */
/* Algoritmo técnico de capacidade e reagendamento (puro, testável)         */
/* ---------------------------------------------------------------------- */

export interface PendingActivityInput {
  assignmentId: string;
  estimatedMinutes: number;
}

export interface PlanItem {
  assignmentId: string;
  plannedDate: string;
  position: number;
}

export interface PlanResult {
  placed: PlanItem[];
  unplaceableAssignmentIds: string[];
}

/** Planejador determinístico: distribui atividades pendentes (na ordem dada)
 *  pelos próximos dias disponíveis dentro do horizonte técnico, sem nunca
 *  ultrapassar a capacidade diária configurada. Atividade que não couber em
 *  nenhum dia do horizonte permanece pendente (seção 8 da ordem). Função
 *  pura — nenhum acesso a banco/relógio real, só entradas explícitas. */
export function computePlan(params: {
  todayCivil: string;
  availableDays: WeekdayCode[];
  dailyMinutesCapacity: number;
  existingLoadByDate: Record<string, number>;
  existingMaxPositionByDate: Record<string, number>;
  pendingActivities: PendingActivityInput[];
  horizonDays: number;
}): PlanResult {
  const candidateDates: string[] = [];
  for (let offset = 0; offset < params.horizonDays; offset++) {
    const date = addCivilDays(params.todayCivil, offset);
    if (params.availableDays.includes(weekdayCodeForCivilDate(date))) {
      candidateDates.push(date);
    }
  }

  const runningLoad = { ...params.existingLoadByDate };
  const runningMaxPosition = { ...params.existingMaxPositionByDate };
  const placed: PlanItem[] = [];
  const unplaceableAssignmentIds: string[] = [];

  for (const activity of params.pendingActivities) {
    let assignedDate: string | null = null;
    for (const date of candidateDates) {
      const currentLoad = runningLoad[date] ?? 0;
      if (currentLoad + activity.estimatedMinutes <= params.dailyMinutesCapacity) {
        assignedDate = date;
        break;
      }
    }
    if (assignedDate === null) {
      unplaceableAssignmentIds.push(activity.assignmentId);
      continue;
    }
    runningLoad[assignedDate] = (runningLoad[assignedDate] ?? 0) + activity.estimatedMinutes;
    const position = (runningMaxPosition[assignedDate] ?? -1) + 1;
    runningMaxPosition[assignedDate] = position;
    placed.push({ assignmentId: activity.assignmentId, plannedDate: assignedDate, position });
  }

  return { placed, unplaceableAssignmentIds };
}

/** Mesma lógica de busca do computePlan, para uma única atividade sendo
 *  reagendada — procura a partir de AMANHÃ (nunca hoje/passado). */
export function computeRescheduleTarget(params: {
  todayCivil: string;
  availableDays: WeekdayCode[];
  dailyMinutesCapacity: number;
  existingLoadByDate: Record<string, number>;
  existingMaxPositionByDate: Record<string, number>;
  estimatedMinutes: number;
  horizonDays: number;
}): { plannedDate: string; position: number } | null {
  for (let offset = 1; offset <= params.horizonDays; offset++) {
    const date = addCivilDays(params.todayCivil, offset);
    if (!params.availableDays.includes(weekdayCodeForCivilDate(date))) continue;
    const currentLoad = params.existingLoadByDate[date] ?? 0;
    if (currentLoad + params.estimatedMinutes <= params.dailyMinutesCapacity) {
      const position = (params.existingMaxPositionByDate[date] ?? -1) + 1;
      return { plannedDate: date, position };
    }
  }
  return null;
}

/* ---------------------------------------------------------------------- */
/* Reagendamento de uma atribuição                                         */
/* ---------------------------------------------------------------------- */

export interface RescheduleResult {
  ok: boolean;
  notFound?: boolean;
  conflict?: boolean;
  invalidTransition?: boolean;
  reason?: "no_capacity";
  newAssignmentId?: string;
}

export async function rescheduleAssignment(
  db: D1Database,
  userId: string,
  assignmentId: string,
  expectedVersion: number,
  clock: Clock
): Promise<RescheduleResult> {
  const assignment = await findAssignment(db, assignmentId);
  if (!assignment || assignment.user_id !== userId) return { ok: false, notFound: true };
  if (assignment.version !== expectedVersion) {
    // Não tenta a escrita condicionada com uma versão já sabidamente errada
    // — evita gastar uma corrida de planejamento para nada.
    return { ok: false, conflict: true };
  }
  if (assignment.status !== "not_started" && assignment.status !== "in_progress") {
    return { ok: false, invalidTransition: true };
  }

  const activity = await findActivity(db, assignment.activity_id);
  if (!activity) return { ok: false, notFound: true };

  const timezone = await getTimezone(db, userId);
  const today = civilDateInTimezone(clock.now(), timezone);
  const availability = await getAvailability(db, userId);

  // Carga existente a partir de amanhã, excluindo a própria atribuição (ela
  // está prestes a sair do dia atual dela).
  const horizonEnd = addCivilDays(today, SCHEDULE_HORIZON_DAYS);
  const inRange = await listAssignmentsInDateRange(db, userId, addCivilDays(today, 1), horizonEnd);
  const existingLoadByDate: Record<string, number> = {};
  const existingMaxPositionByDate: Record<string, number> = {};
  const activitiesById = new Map(
    (await listActivitiesByIds(db, [...new Set(inRange.map((a) => a.activity_id))])).map((a) => [a.id, a])
  );
  for (const other of inRange) {
    if (other.id === assignmentId) continue;
    if (other.status !== "not_started" && other.status !== "in_progress") continue;
    if (other.planned_date === null) continue;
    const minutes = activitiesById.get(other.activity_id)?.estimated_minutes ?? 0;
    existingLoadByDate[other.planned_date] = (existingLoadByDate[other.planned_date] ?? 0) + minutes;
    existingMaxPositionByDate[other.planned_date] = Math.max(
      existingMaxPositionByDate[other.planned_date] ?? -1,
      other.position ?? -1
    );
  }

  const target = computeRescheduleTarget({
    todayCivil: today,
    availableDays: availability.availableDays,
    dailyMinutesCapacity: availability.dailyMinutes,
    existingLoadByDate,
    existingMaxPositionByDate,
    estimatedMinutes: activity.estimated_minutes,
    horizonDays: SCHEDULE_HORIZON_DAYS,
  });

  if (!target) {
    // Nenhuma escrita tentada — a atribuição anterior permanece intacta.
    return { ok: false, reason: "no_capacity" };
  }

  const newAssignmentId = newId();
  const markOldStatement = buildMarkRescheduledStatement(db, {
    assignmentId,
    userId,
    expectedVersion,
    fromStatuses: ["not_started", "in_progress"],
    reason: "rescheduled_to_next_available_day",
  });
  const insertNewStatement = buildInsertAssignmentStatement(db, {
    id: newAssignmentId,
    userId,
    activityId: activity.id,
    plannedDate: target.plannedDate,
    position: target.position,
    rescheduledFromId: assignmentId,
  });

  let results;
  try {
    results = await db.batch([markOldStatement, insertNewStatement]);
  } catch {
    // Corrida rara na constraint de posição única do dia — tratada como
    // conflito controlado, nunca 500; nada fica parcialmente persistido
    // (o lote inteiro reverte).
    return { ok: false, conflict: true };
  }

  const [markResult] = results;
  if (markResult.meta.changes !== 1) {
    // A versão/estado mudou entre a leitura inicial e a escrita (corrida) —
    // o lote inteiro já reverteu (a linha nova nunca foi de fato inserida
    // nesta transação), então não há limpeza a fazer.
    return { ok: false, conflict: true };
  }

  await db.batch([
    buildInsertEventStatement(db, {
      id: newId(),
      assignmentId,
      userId,
      fromStatus: assignment.status,
      toStatus: "rescheduled",
      reason: "rescheduled_to_next_available_day",
    }),
    buildInsertEventStatement(db, {
      id: newId(),
      assignmentId: newAssignmentId,
      userId,
      fromStatus: null,
      toStatus: "not_started",
      reason: "created_by_reschedule",
    }),
  ]);

  return { ok: true, newAssignmentId };
}

/* ---------------------------------------------------------------------- */
/* Prévia e aplicação de plano                                             */
/* ---------------------------------------------------------------------- */

export interface PlanPreviewResponse {
  previewId: string;
  placed: PlanItem[];
  unplaceableAssignmentIds: string[];
  expiresAt: string;
}

interface StoredPlanItem extends PlanItem {
  activityId: string;
  isNewAssignment: boolean;
}

/** Chave ESTÁVEL de uma candidata para fins de detecção de "prévia
 *  desatualizada" — nunca o `assignmentId` de uma candidata nova, que é só
 *  um ID pré-gerado e mudaria a cada chamada mesmo sem nada ter mudado de
 *  verdade. Existentes usam o próprio ID da linha (estável); novas usam o
 *  ID da atividade (estável, a linha em si ainda não existe). */
function stableCandidateKey(candidate: { assignmentId: string; activityId: string; isNewAssignment: boolean }): string {
  return candidate.isNewAssignment ? `activity:${candidate.activityId}` : `assignment:${candidate.assignmentId}`;
}

function inputSnapshotFor(
  availability: Availability,
  candidates: Array<{ assignmentId: string; activityId: string; isNewAssignment: boolean }>
): string {
  return JSON.stringify({
    availableDays: [...availability.availableDays].sort(),
    dailyMinutes: availability.dailyMinutes,
    candidateKeys: candidates.map(stableCandidateKey).sort(),
  });
}

/** Candidatas a entrar num plano: atribuições já existentes mas ainda sem
 *  data (`planned_date IS NULL`, sobras de um apply anterior sem
 *  capacidade) MAIS fixtures que este usuário ainda nunca teve atribuídas.
 *  Nenhuma linha nova é criada aqui — só leitura (correção v1.1, seção 2:
 *  a criação real só acontece em `applyPlan`). Candidatas novas recebem um
 *  ID de atribuição pré-gerado, usado como a chave estável entre a prévia e
 *  a aplicação (a linha só passa a existir de fato se/quando aplicada). */
async function listPlanCandidates(
  db: D1Database,
  userId: string
): Promise<Array<{ assignmentId: string; activityId: string; estimatedMinutes: number; isNewAssignment: boolean }>> {
  const [pending, unassignedActivities] = await Promise.all([
    listPendingAssignments(db, userId),
    listUnassignedFixtureActivities(db, userId),
  ]);
  const pendingActivities = await listActivitiesByIds(
    db,
    pending.map((assignment) => assignment.activity_id)
  );
  const activityById = new Map(pendingActivities.map((activity) => [activity.id, activity]));

  const fromExistingPending = pending.map((assignment) => ({
    assignmentId: assignment.id,
    activityId: assignment.activity_id,
    estimatedMinutes: activityById.get(assignment.activity_id)?.estimated_minutes ?? 0,
    isNewAssignment: false,
  }));
  const fromUnassignedFixtures = unassignedActivities.map((activity) => ({
    assignmentId: newId(),
    activityId: activity.id,
    estimatedMinutes: activity.estimated_minutes,
    isNewAssignment: true,
  }));
  return [...fromExistingPending, ...fromUnassignedFixtures];
}

export async function previewPlan(db: D1Database, userId: string, clock: Clock): Promise<PlanPreviewResponse> {
  const timezone = await getTimezone(db, userId);
  const today = civilDateInTimezone(clock.now(), timezone);
  const availability = await getAvailability(db, userId);
  const candidates = await listPlanCandidates(db, userId);
  const candidateByAssignmentId = new Map(candidates.map((candidate) => [candidate.assignmentId, candidate]));

  const horizonEnd = addCivilDays(today, SCHEDULE_HORIZON_DAYS);
  const inRange = await listAssignmentsInDateRange(db, userId, today, horizonEnd);
  const existingLoadByDate: Record<string, number> = {};
  const existingMaxPositionByDate: Record<string, number> = {};
  const inRangeActivities = new Map(
    (await listActivitiesByIds(db, [...new Set(inRange.map((a) => a.activity_id))])).map((a) => [a.id, a])
  );
  for (const assignment of inRange) {
    if (assignment.status !== "not_started" && assignment.status !== "in_progress") continue;
    if (assignment.planned_date === null) continue;
    const minutes = inRangeActivities.get(assignment.activity_id)?.estimated_minutes ?? 0;
    existingLoadByDate[assignment.planned_date] = (existingLoadByDate[assignment.planned_date] ?? 0) + minutes;
    existingMaxPositionByDate[assignment.planned_date] = Math.max(
      existingMaxPositionByDate[assignment.planned_date] ?? -1,
      assignment.position ?? -1
    );
  }

  const plan = computePlan({
    todayCivil: today,
    availableDays: availability.availableDays,
    dailyMinutesCapacity: availability.dailyMinutes,
    existingLoadByDate,
    existingMaxPositionByDate,
    pendingActivities: candidates.map((candidate) => ({
      assignmentId: candidate.assignmentId,
      estimatedMinutes: candidate.estimatedMinutes,
    })),
    horizonDays: SCHEDULE_HORIZON_DAYS,
  });

  const storedPlaced: StoredPlanItem[] = plan.placed.map((item) => {
    const candidate = candidateByAssignmentId.get(item.assignmentId)!;
    return { ...item, activityId: candidate.activityId, isNewAssignment: candidate.isNewAssignment };
  });
  const storedUnplaceable = plan.unplaceableAssignmentIds.map((assignmentId) => {
    const candidate = candidateByAssignmentId.get(assignmentId)!;
    return { assignmentId, activityId: candidate.activityId, isNewAssignment: candidate.isNewAssignment };
  });

  const previewId = newId();
  const expiresAt = new Date(clock.now().getTime() + PLAN_PREVIEW_TTL_MS).toISOString();
  await insertPlanPreview(db, {
    id: previewId,
    userId,
    payload: JSON.stringify({ placed: storedPlaced, unplaceable: storedUnplaceable }),
    unplaceableActivityIds: JSON.stringify(plan.unplaceableAssignmentIds),
    inputSnapshot: inputSnapshotFor(availability, candidates),
    expiresAt,
  });

  return { previewId, placed: plan.placed, unplaceableAssignmentIds: plan.unplaceableAssignmentIds, expiresAt };
}

export interface ApplyPlanResult {
  ok: boolean;
  notFound?: boolean;
  expired?: boolean;
  stale?: boolean;
  alreadyApplied?: boolean;
  appliedCount?: number;
}

export async function applyPlan(db: D1Database, userId: string, previewId: string, clock: Clock): Promise<ApplyPlanResult> {
  const preview = await findPlanPreview(db, previewId);
  if (!preview || preview.user_id !== userId) return { ok: false, notFound: true };

  if (preview.applied_at !== null) {
    // Idempotente: reaplicar a MESMA prévia não duplica atribuições.
    return { ok: true, alreadyApplied: true };
  }

  if (new Date(preview.expires_at).getTime() < clock.now().getTime()) {
    return { ok: false, expired: true };
  }

  const availability = await getAvailability(db, userId);
  const currentCandidates = await listPlanCandidates(db, userId);
  const currentSnapshot = inputSnapshotFor(availability, currentCandidates);
  if (currentSnapshot !== preview.input_snapshot) {
    return { ok: false, stale: true };
  }

  const { placed, unplaceable } = JSON.parse(preview.payload) as {
    placed: StoredPlanItem[];
    unplaceable: StoredPlanItem[];
  };
  const existingAssignmentIds = new Set(
    (await listAssignmentsForUser(db, userId)).map((assignment) => assignment.id)
  );

  // Correção v1.1, seção 2: as linhas só passam a existir de verdade AQUI —
  // nem `previewPlan` nem nenhum GET criam nada. Candidatas que já existiam
  // como pendentes (isNewAssignment=false) são atualizadas por UPDATE
  // condicionado; candidatas novas (fixture ainda não atribuída) nascem por
  // INSERT com o ID pré-gerado na prévia.
  const statements = [buildMarkPreviewAppliedStatement(db, previewId)];
  for (const item of placed) {
    if (!item.isNewAssignment && existingAssignmentIds.has(item.assignmentId)) {
      statements.push(
        db
          .prepare(
            `UPDATE schedule_activity_assignments
             SET planned_date = ?, position = ?, updated_at = datetime('now')
             WHERE id = ? AND user_id = ? AND status = 'not_started' AND planned_date IS NULL`
          )
          .bind(item.plannedDate, item.position, item.assignmentId, userId)
      );
    } else {
      statements.push(
        buildInsertAssignmentStatement(db, {
          id: item.assignmentId,
          userId,
          activityId: item.activityId,
          plannedDate: item.plannedDate,
          position: item.position,
        })
      );
    }
  }
  // Candidatas que não couberam em nenhum dia: se já existiam (pendentes),
  // não precisam de nenhuma escrita; se eram novas, precisam nascer como
  // pendentes (sem data) para poderem ser reconsideradas num plano futuro.
  for (const item of unplaceable) {
    if (item.isNewAssignment && !existingAssignmentIds.has(item.assignmentId)) {
      statements.push(
        buildInsertAssignmentStatement(db, {
          id: item.assignmentId,
          userId,
          activityId: item.activityId,
          plannedDate: null,
          position: null,
        })
      );
    }
  }

  let results;
  try {
    results = await db.batch(statements);
  } catch {
    return { ok: false, stale: true };
  }

  const [markPreviewResult, ...mutationResults] = results;
  if (markPreviewResult.meta.changes !== 1) {
    // Outra requisição aplicou a mesma prévia entre a leitura e a escrita.
    return { ok: true, alreadyApplied: true };
  }
  const unexpected = mutationResults.some((result) => result.meta.changes !== 1);
  if (unexpected) {
    return { ok: false, stale: true };
  }

  await db.batch(
    placed.map((item) =>
      buildInsertEventStatement(db, {
        id: newId(),
        assignmentId: item.assignmentId,
        userId,
        fromStatus: item.isNewAssignment ? null : "not_started",
        toStatus: "not_started",
        reason: "schedule_plan_applied",
      })
    )
  );

  return { ok: true, appliedCount: placed.length };
}
