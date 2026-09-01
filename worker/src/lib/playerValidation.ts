/* Validação e constantes técnicas do Player de Questão — Sprint 8 v1.1.
   Mesma convenção de questionsValidation.ts/patternsValidation.ts: enums
   fechados e validação de parâmetro vivem só aqui; rota/serviço apenas
   chamam estas funções. */

export const QUESTION_ATTEMPT_MODES = ["learning", "practice", "recognition"] as const;
export type QuestionAttemptMode = (typeof QUESTION_ATTEMPT_MODES)[number];

export const QUESTION_ATTEMPT_STATUSES = ["in_progress", "answered", "completed", "abandoned"] as const;
export type QuestionAttemptStatus = (typeof QUESTION_ATTEMPT_STATUSES)[number];

export const QUESTION_ATTEMPT_ALTERNATIVE_LETTERS = ["A", "B", "C", "D", "E"] as const;
export type QuestionAttemptAlternativeLetter = (typeof QUESTION_ATTEMPT_ALTERNATIVE_LETTERS)[number];

export const QUESTION_PROBLEM_REPORT_CATEGORIES = [
  "statement_problem",
  "alternative_problem",
  "answer_key_problem",
  "image_problem",
  "accessibility_problem",
  "other",
] as const;
export type QuestionProblemReportCategory = (typeof QUESTION_PROBLEM_REPORT_CATEGORIES)[number];

export const MAX_HELP_LAYER = 4;
const MAX_CLUE_LENGTH = 300;
const MAX_STRATEGY_LENGTH = 300;
const MAX_COMMENT_LENGTH = 500;

interface FieldValidationResult<T> {
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

export function isValidAttemptMode(value: unknown): value is QuestionAttemptMode {
  return typeof value === "string" && (QUESTION_ATTEMPT_MODES as readonly string[]).includes(value);
}

export function isValidAlternativeLetter(value: unknown): value is QuestionAttemptAlternativeLetter {
  return typeof value === "string" && (QUESTION_ATTEMPT_ALTERNATIVE_LETTERS as readonly string[]).includes(value);
}

export function isValidProblemReportCategory(value: unknown): value is QuestionProblemReportCategory {
  return typeof value === "string" && (QUESTION_PROBLEM_REPORT_CATEGORIES as readonly string[]).includes(value);
}

/** Texto livre (pista/estratégia de reconhecimento, comentário de denúncia)
 *  é tratado sempre como DADO, nunca executado/interpretado — normalização
 *  mínima (trim + colapso de espaços) e limite de tamanho, mesma convenção
 *  de `questionsValidation.ts:validateTags`. Hostil (HTML, script, SQL
 *  literal etc.) nunca é rejeitado por conteúdo — só por tamanho — porque
 *  nunca é renderizado como HTML (React escapa) nem concatenado em SQL
 *  (sempre parametrizado). */
function normalizeFreeText(value: unknown, maxLength: number, fieldLabel: string): FieldValidationResult<string> {
  if (value === undefined || value === null) return ok("");
  if (typeof value !== "string") return fail(`${fieldLabel} inválido.`);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length > maxLength) return fail(`${fieldLabel} excede o tamanho máximo de ${maxLength} caracteres.`);
  return ok(normalized);
}

export function validateRecognitionClue(value: unknown): FieldValidationResult<string> {
  return normalizeFreeText(value, MAX_CLUE_LENGTH, "Pista");
}

export function validateRecognitionStrategy(value: unknown): FieldValidationResult<string> {
  return normalizeFreeText(value, MAX_STRATEGY_LENGTH, "Estratégia");
}

export function validateProblemReportComment(value: unknown): FieldValidationResult<string | null> {
  if (value === undefined || value === null) return ok(null);
  if (typeof value !== "string") return fail("Comentário inválido.");
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) return ok(null);
  if (normalized.length > MAX_COMMENT_LENGTH) return fail(`Comentário excede o tamanho máximo de ${MAX_COMMENT_LENGTH} caracteres.`);
  return ok(normalized);
}

export function isValidHelpLayer(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_HELP_LAYER;
}
