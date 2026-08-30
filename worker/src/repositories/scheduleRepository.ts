/* Repositório do cronograma adaptativo — Sprint 5 v1.0. Toda escrita usa
   statements parametrizados; nomes de tabela/coluna são sempre literais
   fixos no código-fonte. Os "build*Statement" retornam D1PreparedStatement
   para compor um único db.batch() atômico no serviço (mesmo padrão das
   Sprints 2-4). */

export interface ScheduleActivityRow {
  id: string;
  type: string;
  title: string;
  objective: string;
  estimated_minutes: number;
  completion_criteria: string;
  explanation: string;
  completion_mode: string;
  origin: string;
  resource_ref: string | null;
  dismissible: number;
  is_local_fixture: number;
}

export interface ScheduleAssignmentRow {
  id: string;
  user_id: string;
  activity_id: string;
  planned_date: string | null;
  position: number | null;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  dismissed_at: string | null;
  blocked_at: string | null;
  rescheduled_at: string | null;
  last_transition_reason: string | null;
  rescheduled_from_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface SchedulePreferencesRow {
  user_id: string;
  timezone: string;
}

export interface SchedulePlanPreviewRow {
  id: string;
  user_id: string;
  payload: string;
  unplaceable_activity_ids: string;
  input_snapshot: string;
  created_at: string;
  expires_at: string;
  applied_at: string | null;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

export async function findActivity(db: D1Database, activityId: string): Promise<ScheduleActivityRow | null> {
  const row = await db
    .prepare("SELECT * FROM schedule_activities WHERE id = ?")
    .bind(activityId)
    .first<ScheduleActivityRow>();
  return row ?? null;
}

export async function listActivitiesByIds(db: D1Database, ids: string[]): Promise<ScheduleActivityRow[]> {
  if (ids.length === 0) return [];
  const result = await db
    .prepare(`SELECT * FROM schedule_activities WHERE id IN (${placeholders(ids.length)})`)
    .bind(...ids)
    .all<ScheduleActivityRow>();
  return result.results ?? [];
}

export async function listLocalFixtureActivities(db: D1Database): Promise<ScheduleActivityRow[]> {
  const result = await db
    .prepare("SELECT * FROM schedule_activities WHERE is_local_fixture = 1")
    .all<ScheduleActivityRow>();
  return result.results ?? [];
}

export async function findAssignment(db: D1Database, assignmentId: string): Promise<ScheduleAssignmentRow | null> {
  const row = await db
    .prepare("SELECT * FROM schedule_activity_assignments WHERE id = ?")
    .bind(assignmentId)
    .first<ScheduleAssignmentRow>();
  return row ?? null;
}

export async function listAssignmentsForUser(db: D1Database, userId: string): Promise<ScheduleAssignmentRow[]> {
  const result = await db
    .prepare(
      "SELECT * FROM schedule_activity_assignments WHERE user_id = ? ORDER BY planned_date ASC, position ASC"
    )
    .bind(userId)
    .all<ScheduleAssignmentRow>();
  return result.results ?? [];
}

export async function listAssignmentsInDateRange(
  db: D1Database,
  userId: string,
  fromDate: string,
  toDate: string
): Promise<ScheduleAssignmentRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM schedule_activity_assignments
       WHERE user_id = ? AND planned_date IS NOT NULL AND planned_date BETWEEN ? AND ?
       ORDER BY planned_date ASC, position ASC`
    )
    .bind(userId, fromDate, toDate)
    .all<ScheduleAssignmentRow>();
  return result.results ?? [];
}

export async function listPendingAssignments(db: D1Database, userId: string): Promise<ScheduleAssignmentRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM schedule_activity_assignments
       WHERE user_id = ? AND planned_date IS NULL AND status = 'not_started'
       ORDER BY created_at ASC`
    )
    .bind(userId)
    .all<ScheduleAssignmentRow>();
  return result.results ?? [];
}

/** Minutos já comprometidos (not_started/in_progress) num dia — usados pelo
 *  planejador para nunca ultrapassar a capacidade diária configurada. */
export async function sumActiveMinutesForDay(db: D1Database, userId: string, date: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(a.estimated_minutes), 0) as total
       FROM schedule_activity_assignments sa
       JOIN schedule_activities a ON a.id = sa.activity_id
       WHERE sa.user_id = ? AND sa.planned_date = ? AND sa.status IN ('not_started', 'in_progress')`
    )
    .bind(userId, date)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function maxPositionForDay(db: D1Database, userId: string, date: string): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COALESCE(MAX(position), -1) as maxPosition FROM schedule_activity_assignments WHERE user_id = ? AND planned_date = ?"
    )
    .bind(userId, date)
    .first<{ maxPosition: number }>();
  return row?.maxPosition ?? -1;
}

export async function getPreferences(db: D1Database, userId: string): Promise<SchedulePreferencesRow | null> {
  const row = await db
    .prepare("SELECT * FROM schedule_preferences WHERE user_id = ?")
    .bind(userId)
    .first<SchedulePreferencesRow>();
  return row ?? null;
}

export function buildUpsertTimezoneStatement(db: D1Database, userId: string, timezone: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO schedule_preferences (user_id, timezone, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT (user_id) DO UPDATE SET timezone = excluded.timezone, updated_at = datetime('now')`
    )
    .bind(userId, timezone);
}

export function buildInsertAssignmentStatement(
  db: D1Database,
  params: {
    id: string;
    userId: string;
    activityId: string;
    plannedDate: string | null;
    position: number | null;
    rescheduledFromId?: string | null;
  }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO schedule_activity_assignments
         (id, user_id, activity_id, planned_date, position, status, rescheduled_from_id)
       VALUES (?, ?, ?, ?, ?, 'not_started', ?)`
    )
    .bind(
      params.id,
      params.userId,
      params.activityId,
      params.plannedDate,
      params.position,
      params.rescheduledFromId ?? null
    );
}

export function buildInsertEventStatement(
  db: D1Database,
  params: { id: string; assignmentId: string; userId: string; fromStatus: string | null; toStatus: string; reason: string | null }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO schedule_activity_events (id, assignment_id, user_id, from_status, to_status, reason)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(params.id, params.assignmentId, params.userId, params.fromStatus, params.toStatus, params.reason);
}

/** Correção v1.2 — histórico condicionado, para compor no MESMO db.batch()
 *  do UPDATE da transição (nunca um segundo batch separado): o INSERT só
 *  persiste se, NAQUELE MOMENTO da transação (depois do UPDATE anterior no
 *  mesmo lote ter rodado), a linha estiver exatamente no estado/versão alvo
 *  E ainda não existir nenhum evento prévio para esta atribuição com este
 *  `to_status`.
 *
 *  A segunda condição é essencial: sem ela, um REENVIO idempotente com a
 *  mesma `expectedVersion` já obsoleta veria o UPDATE falhar (guard de
 *  versão não bate, `changes = 0`), mas a linha JÁ estaria (desde a
 *  chamada real anterior) no estado/versão alvo — a primeira condição
 *  sozinha bateria de novo e duplicaria o evento. Para as quatro transições
 *  que usam este helper (start/complete/dismiss/block), cada
 *  `(assignment_id, to_status)` só pode ser alcançado uma única vez de
 *  verdade (todas terminam num estado final ou consomem o único
 *  `not_started` possível), então "nenhum evento prévio com este to_status"
 *  é equivalente a "esta é a primeira vez que a transição realmente
 *  acontece" — sem precisar de coluna nova nem migration. */
export function buildConditionalTransitionEventStatement(
  db: D1Database,
  params: {
    id: string;
    assignmentId: string;
    userId: string;
    fromStatus: string | null;
    toStatus: string;
    reason: string | null;
    expectedVersionAfter: number;
  }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO schedule_activity_events (id, assignment_id, user_id, from_status, to_status, reason)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM schedule_activity_assignments
         WHERE id = ? AND user_id = ? AND status = ? AND version = ?
       )
       AND NOT EXISTS (
         SELECT 1 FROM schedule_activity_events WHERE assignment_id = ? AND to_status = ?
       )`
    )
    .bind(
      params.id,
      params.assignmentId,
      params.userId,
      params.fromStatus,
      params.toStatus,
      params.reason,
      params.assignmentId,
      params.userId,
      params.toStatus,
      params.expectedVersionAfter,
      params.assignmentId,
      params.toStatus
    );
}

/** Guard reutilizado por todas as transições: usuário dono, versão exata e
 *  status atual dentre os permitidos — tudo dentro do MESMO statement
 *  condicionado, nunca uma corrida entre ler e gravar. */
function transitionGuardSql(fromStatuses: string[]): string {
  return `id = ? AND user_id = ? AND version = ? AND status IN (${placeholders(fromStatuses.length)})`;
}

export function buildTransitionStatement(
  db: D1Database,
  params: {
    assignmentId: string;
    userId: string;
    expectedVersion: number;
    fromStatuses: string[];
    toStatus: string;
    reason: string;
    timestampColumn: "started_at" | "completed_at" | "dismissed_at" | "blocked_at" | "rescheduled_at" | null;
  }
): D1PreparedStatement {
  const guard = transitionGuardSql(params.fromStatuses);
  const timestampSet = params.timestampColumn ? `${params.timestampColumn} = datetime('now'),` : "";
  return db
    .prepare(
      `UPDATE schedule_activity_assignments
       SET status = ?, ${timestampSet} last_transition_reason = ?, version = version + 1, updated_at = datetime('now')
       WHERE ${guard}`
    )
    .bind(
      params.toStatus,
      params.reason,
      params.assignmentId,
      params.userId,
      params.expectedVersion,
      ...params.fromStatuses
    );
}

export function buildMarkRescheduledStatement(
  db: D1Database,
  params: { assignmentId: string; userId: string; expectedVersion: number; fromStatuses: string[]; reason: string }
): D1PreparedStatement {
  return buildTransitionStatement(db, {
    assignmentId: params.assignmentId,
    userId: params.userId,
    expectedVersion: params.expectedVersion,
    fromStatuses: params.fromStatuses,
    toStatus: "rescheduled",
    reason: params.reason,
    timestampColumn: "rescheduled_at",
  });
}

export async function insertPlanPreview(
  db: D1Database,
  params: {
    id: string;
    userId: string;
    payload: string;
    unplaceableActivityIds: string;
    inputSnapshot: string;
    expiresAt: string;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO schedule_plan_previews (id, user_id, payload, unplaceable_activity_ids, input_snapshot, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(params.id, params.userId, params.payload, params.unplaceableActivityIds, params.inputSnapshot, params.expiresAt)
    .run();
}

export async function findPlanPreview(db: D1Database, previewId: string): Promise<SchedulePlanPreviewRow | null> {
  const row = await db
    .prepare("SELECT * FROM schedule_plan_previews WHERE id = ?")
    .bind(previewId)
    .first<SchedulePlanPreviewRow>();
  return row ?? null;
}

/** Marca a prévia como aplicada — condicionado a `applied_at IS NULL` no
 *  mesmo statement (idempotência real: uma segunda tentativa de aplicar a
 *  MESMA prévia vê meta.changes = 0 e o serviço trata como reaplicação, não
 *  duplica atribuições). */
export function buildMarkPreviewAppliedStatement(db: D1Database, previewId: string): D1PreparedStatement {
  return db
    .prepare("UPDATE schedule_plan_previews SET applied_at = datetime('now') WHERE id = ? AND applied_at IS NULL")
    .bind(previewId);
}
