/* Serviço administrativo do Cronograma — Sprint 16 v1.2, seção 3 da ordem.
   Mesmo contrato de autorização de diagnosticAdminService.ts (sessão já
   garantida pela rota; papel `admin` via requireAdminRole aqui). CRUD
   mínimo pedido explicitamente pela ordem: criar, listar, editar, excluir
   (com guarda contra excluir uma atividade em uso por atribuições reais). */

import { requireAdminRole } from "./adminService";
import {
  buildDeleteActivityStatement,
  buildInsertActivityStatement,
  buildUpdateActivityStatement,
  countAssignmentsForActivity,
  findRealActivity,
  listRealActivities,
  type ActivityFields,
  type AdminScheduleActivityRow,
} from "../repositories/scheduleAdminRepository";
import { buildAuditEventStatement } from "../repositories/auditRepository";
import { isValidMutationId } from "../lib/questionsValidation";
import {
  validateActivityCompletionCriteria,
  validateActivityCompletionMode,
  validateActivityExplanation,
  validateActivityObjective,
  validateActivityOrigin,
  validateActivityTitle,
  validateActivityType,
  validateDismissible,
  validateEstimatedMinutes,
  validateResourceRef,
} from "../lib/scheduleAdminValidation";

export interface ActivityDto {
  id: string;
  type: string;
  title: string;
  objective: string;
  estimatedMinutes: number;
  completionCriteria: string;
  explanation: string;
  completionMode: string;
  origin: string;
  resourceRef: string | null;
  dismissible: boolean;
  createdAt: string;
  updatedAt: string;
}

function toDto(row: AdminScheduleActivityRow): ActivityDto {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    objective: row.objective,
    estimatedMinutes: row.estimated_minutes,
    completionCriteria: row.completion_criteria,
    explanation: row.explanation,
    completionMode: row.completion_mode,
    origin: row.origin,
    resourceRef: row.resource_ref,
    dismissible: row.dismissible === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type ListResult = { ok: true; activities: ActivityDto[] } | { ok: false; forbidden: true };

export async function listActivities(db: D1Database, adminId: string): Promise<ListResult> {
  if (!(await requireAdminRole(db, adminId))) return { ok: false, forbidden: true };
  const rows = await listRealActivities(db);
  return { ok: true, activities: rows.map(toDto) };
}

interface RawActivityInput {
  type: unknown;
  title: unknown;
  objective: unknown;
  estimatedMinutes: unknown;
  completionCriteria: unknown;
  explanation: unknown;
  completionMode: unknown;
  origin: unknown;
  resourceRef: unknown;
  dismissible: unknown;
}

function validateFields(input: RawActivityInput): { ok: true; fields: ActivityFields } | { ok: false; fieldErrors: Record<string, string> } {
  const type = validateActivityType(input.type);
  if (!type.ok) return { ok: false, fieldErrors: { type: type.error! } };
  const title = validateActivityTitle(input.title);
  if (!title.ok) return { ok: false, fieldErrors: { title: title.error! } };
  const objective = validateActivityObjective(input.objective);
  if (!objective.ok) return { ok: false, fieldErrors: { objective: objective.error! } };
  const estimatedMinutes = validateEstimatedMinutes(input.estimatedMinutes);
  if (!estimatedMinutes.ok) return { ok: false, fieldErrors: { estimatedMinutes: estimatedMinutes.error! } };
  const completionCriteria = validateActivityCompletionCriteria(input.completionCriteria);
  if (!completionCriteria.ok) return { ok: false, fieldErrors: { completionCriteria: completionCriteria.error! } };
  const explanation = validateActivityExplanation(input.explanation);
  if (!explanation.ok) return { ok: false, fieldErrors: { explanation: explanation.error! } };
  const completionMode = validateActivityCompletionMode(input.completionMode);
  if (!completionMode.ok) return { ok: false, fieldErrors: { completionMode: completionMode.error! } };
  const origin = validateActivityOrigin(input.origin);
  if (!origin.ok) return { ok: false, fieldErrors: { origin: origin.error! } };
  const resourceRef = validateResourceRef(input.resourceRef);
  if (!resourceRef.ok) return { ok: false, fieldErrors: { resourceRef: resourceRef.error! } };
  const dismissible = validateDismissible(input.dismissible);
  if (!dismissible.ok) return { ok: false, fieldErrors: { dismissible: dismissible.error! } };

  return {
    ok: true,
    fields: {
      type: type.value!,
      title: title.value!,
      objective: objective.value!,
      estimatedMinutes: estimatedMinutes.value!,
      completionCriteria: completionCriteria.value!,
      explanation: explanation.value!,
      completionMode: completionMode.value!,
      origin: origin.value!,
      resourceRef: resourceRef.value!,
      dismissible: dismissible.value!,
    },
  };
}

function fieldsEqual(a: ActivityFields, existing: AdminScheduleActivityRow): boolean {
  return (
    a.type === existing.type &&
    a.title === existing.title &&
    a.objective === existing.objective &&
    a.estimatedMinutes === existing.estimated_minutes &&
    a.completionCriteria === existing.completion_criteria &&
    a.explanation === existing.explanation &&
    a.completionMode === existing.completion_mode &&
    a.origin === existing.origin &&
    a.resourceRef === existing.resource_ref &&
    a.dismissible === (existing.dismissible === 1)
  );
}

export type CreateResult =
  | { ok: true; changed: boolean; activityId: string }
  | { ok: false; forbidden: true }
  | { ok: false; conflict: true }
  | { ok: false; fieldErrors: Record<string, string> };

export async function createActivity(db: D1Database, adminId: string, input: RawActivityInput & { mutationId: unknown }): Promise<CreateResult> {
  if (!(await requireAdminRole(db, adminId))) return { ok: false, forbidden: true };
  if (!isValidMutationId(input.mutationId)) return { ok: false, fieldErrors: { mutationId: "mutationId é obrigatório e precisa ser um UUID válido." } };
  const mutationId = input.mutationId;

  const validated = validateFields(input);
  if (!validated.ok) return { ok: false, fieldErrors: validated.fieldErrors };
  const fields = validated.fields;

  try {
    await db.batch([
      buildInsertActivityStatement(db, mutationId, fields),
      buildAuditEventStatement(db, { id: mutationId, eventType: "admin_schedule_activity_created", userId: adminId, metadata: { activityId: mutationId } }),
    ]);
  } catch (error) {
    const existing = await findRealActivity(db, mutationId);
    if (!existing) throw error;
    if (fieldsEqual(fields, existing)) return { ok: true, changed: false, activityId: mutationId };
    return { ok: false, conflict: true };
  }

  return { ok: true, changed: true, activityId: mutationId };
}

export type UpdateResult =
  | { ok: true; changed: boolean }
  | { ok: false; forbidden: true }
  | { ok: false; notFound: true }
  | { ok: false; conflict: true }
  | { ok: false; fieldErrors: Record<string, string> };

export async function updateActivity(
  db: D1Database,
  adminId: string,
  activityId: string,
  input: RawActivityInput & { mutationId: unknown }
): Promise<UpdateResult> {
  if (!(await requireAdminRole(db, adminId))) return { ok: false, forbidden: true };
  if (!isValidMutationId(input.mutationId)) return { ok: false, fieldErrors: { mutationId: "mutationId é obrigatório e precisa ser um UUID válido." } };
  const mutationId = input.mutationId;

  const existing = await findRealActivity(db, activityId);
  if (!existing) return { ok: false, notFound: true };

  const validated = validateFields(input);
  if (!validated.ok) return { ok: false, fieldErrors: validated.fieldErrors };
  const fields = validated.fields;

  if (fieldsEqual(fields, existing)) return { ok: true, changed: false };

  try {
    const result = await db.batch([
      buildUpdateActivityStatement(db, activityId, fields),
      buildAuditEventStatement(db, { id: mutationId, eventType: "admin_schedule_activity_updated", userId: adminId, metadata: { activityId } }),
    ]);
    if (result[0].meta.changes !== 1) return { ok: false, notFound: true };
  } catch (error) {
    // audit_log.id (mutationId) já foi usado por OUTRA mutação real —
    // conflito controlado, nunca uma exceção crua (mesmo raciocínio de
    // dailyTrainingService.ts:isUniqueEventIdViolation).
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message) && error.message.includes("audit_log")) {
      return { ok: false, conflict: true };
    }
    throw error;
  }

  return { ok: true, changed: true };
}

export type DeleteResult =
  | { ok: true; changed: boolean }
  | { ok: false; forbidden: true }
  | { ok: false; notFound: true }
  | { ok: false; inUse: true };

export async function deleteActivity(db: D1Database, adminId: string, activityId: string): Promise<DeleteResult> {
  if (!(await requireAdminRole(db, adminId))) return { ok: false, forbidden: true };

  const existing = await findRealActivity(db, activityId);
  if (!existing) return { ok: false, notFound: true };

  const assignmentCount = await countAssignmentsForActivity(db, activityId);
  if (assignmentCount > 0) return { ok: false, inUse: true };

  const eventId = crypto.randomUUID();
  const result = await db.batch([
    buildDeleteActivityStatement(db, activityId),
    buildAuditEventStatement(db, { id: eventId, eventType: "admin_schedule_activity_deleted", userId: adminId, metadata: { activityId } }),
  ]);
  if (result[0].meta.changes !== 1) return { ok: true, changed: false };
  return { ok: true, changed: true };
}
