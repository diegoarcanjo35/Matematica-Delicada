/* Validação e constantes técnicas do Caderno de Erros — Sprint 9 v1.0.
   Mesma convenção de playerValidation.ts/questionsValidation.ts: enums
   fechados e validação de parâmetro vivem só aqui. */

export const ERROR_TYPES = [
  "unclassified",
  "pattern_not_recognized",
  "wrong_pattern",
  "inadequate_strategy",
  "interpretation",
  "content_or_base",
  "calculation",
  "haste",
  "time_shortage",
  "marking_error",
] as const;
export type ErrorType = (typeof ERROR_TYPES)[number];

export const ERROR_NOTEBOOK_STATUSES = ["pending_understanding", "scheduled", "due", "in_review", "corrected", "archived"] as const;
export type ErrorNotebookStatus = (typeof ERROR_NOTEBOOK_STATUSES)[number];

const MAX_STUDENT_NOTE_LENGTH = 1000;

interface FieldValidationResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

/** Anotação do aluno — seção 10 da ordem: texto livre, opcional, pode
 *  conter dado pessoal, tratado SEMPRE como DADO (bind parametrizado,
 *  nunca `dangerouslySetInnerHTML` no front). Normalização mínima (trim)
 *  só por tamanho, nunca por conteúdo — hostil (HTML/script/SQL literal)
 *  nunca é rejeitado, só truncado se passar do limite. `null` limpa a
 *  nota (distinto de "campo ausente" — ver errorNotebookService.ts). */
export function validateStudentNote(value: string): FieldValidationResult<string> {
  const normalized = value.trim();
  if (normalized.length > MAX_STUDENT_NOTE_LENGTH) {
    return { ok: false, error: `Anotação excede o tamanho máximo de ${MAX_STUDENT_NOTE_LENGTH} caracteres.` };
  }
  return { ok: true, value: normalized };
}

export function isValidErrorType(value: unknown): value is ErrorType {
  return typeof value === "string" && (ERROR_TYPES as readonly string[]).includes(value);
}
