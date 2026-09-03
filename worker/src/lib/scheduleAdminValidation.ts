/* Validação do pipeline administrativo do Cronograma — Sprint 16 v1.2,
   seção 3 da ordem. Reaproveita os enums técnicos JÁ existentes em
   scheduleValidation.ts (ACTIVITY_TYPES/COMPLETION_MODES/ACTIVITY_ORIGINS —
   migration 0006) — nenhum enum duplicado. Só os validadores de campo do
   formulário administrativo (título, objetivo, minutos, etc.) são novos
   aqui. */

import { ACTIVITY_TYPES, COMPLETION_MODES, ACTIVITY_ORIGINS, type ActivityType, type CompletionMode, type ActivityOrigin } from "./scheduleValidation";

export interface FieldValidationResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

function ok<T>(value: T): FieldValidationResult<T> {
  return { ok: true, value };
}

function fail<T>(error: string): FieldValidationResult<T> {
  return { ok: false, error };
}

export const SCHEDULE_ADMIN_TITLE_MAX_LENGTH = 200;
export const SCHEDULE_ADMIN_TEXT_MAX_LENGTH = 2000;
export const SCHEDULE_ADMIN_RESOURCE_REF_MAX_LENGTH = 500;
export const SCHEDULE_ADMIN_ESTIMATED_MINUTES_MAX = 480; // 8h — teto de sanidade, nunca pedagógico.

function validateNonEmptyText(value: unknown, fieldLabel: string, maxLength: number): FieldValidationResult<string> {
  if (typeof value !== "string") return fail(`${fieldLabel} é obrigatório.`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return fail(`${fieldLabel} não pode ser vazio.`);
  if (value.length > maxLength) return fail(`${fieldLabel} não pode passar de ${maxLength} caracteres.`);
  return ok(value);
}

export function validateActivityTitle(value: unknown): FieldValidationResult<string> {
  return validateNonEmptyText(value, "Título", SCHEDULE_ADMIN_TITLE_MAX_LENGTH);
}

export function validateActivityObjective(value: unknown): FieldValidationResult<string> {
  return validateNonEmptyText(value, "Objetivo", SCHEDULE_ADMIN_TEXT_MAX_LENGTH);
}

export function validateActivityCompletionCriteria(value: unknown): FieldValidationResult<string> {
  return validateNonEmptyText(value, "Critério de conclusão", SCHEDULE_ADMIN_TEXT_MAX_LENGTH);
}

export function validateActivityExplanation(value: unknown): FieldValidationResult<string> {
  return validateNonEmptyText(value, "Explicação ao aluno", SCHEDULE_ADMIN_TEXT_MAX_LENGTH);
}

export function validateActivityType(value: unknown): FieldValidationResult<ActivityType> {
  if (typeof value !== "string" || !(ACTIVITY_TYPES as readonly string[]).includes(value)) return fail("Tipo de atividade inválido.");
  return ok(value as ActivityType);
}

export function validateActivityCompletionMode(value: unknown): FieldValidationResult<CompletionMode> {
  if (typeof value !== "string" || !(COMPLETION_MODES as readonly string[]).includes(value)) return fail("Modo de conclusão inválido.");
  return ok(value as CompletionMode);
}

export function validateActivityOrigin(value: unknown): FieldValidationResult<ActivityOrigin> {
  if (typeof value !== "string" || !(ACTIVITY_ORIGINS as readonly string[]).includes(value)) return fail("Origem inválida.");
  return ok(value as ActivityOrigin);
}

export function validateEstimatedMinutes(value: unknown): FieldValidationResult<number> {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > SCHEDULE_ADMIN_ESTIMATED_MINUTES_MAX) {
    return fail("Duração estimada inválida.");
  }
  return ok(value);
}

export function validateResourceRef(value: unknown): FieldValidationResult<string | null> {
  if (value === null || value === undefined || value === "") return ok(null);
  if (typeof value !== "string" || value.length > SCHEDULE_ADMIN_RESOURCE_REF_MAX_LENGTH) return fail("Referência de recurso inválida.");
  return ok(value);
}

export function validateDismissible(value: unknown): FieldValidationResult<boolean> {
  if (value === undefined || value === null) return ok(true);
  if (typeof value !== "boolean") return fail("Indicação de dispensável inválida.");
  return ok(value);
}
