/* Validação da superfície ADMINISTRATIVA do catálogo de padrões — Sprint 16
   v1.2, seção 4 da ordem (emenda do charter de patternsRepository.ts).
   Reaproveita PATTERN_ATTRIBUTE_TYPES/PATTERN_SLUG_MAX_LENGTH JÁ existentes
   em patternsValidation.ts — nenhum enum duplicado. Só os validadores dos
   campos "essenciais" (seção 4: "editar dados essenciais") são novos aqui.
   Sem score, TRI ou fórmula de domínio (seção 4 da ordem) — nada aqui
   toca `student_pattern_progress`/índices pedagógicos. */

import { PATTERN_ATTRIBUTE_TYPES, PATTERN_SLUG_MAX_LENGTH, isValidPatternSlug, type PatternAttributeType } from "./patternsValidation";

export { isValidPatternSlug };

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

export const PATTERN_CODE_MAX_LENGTH = 40;
export const PATTERN_SHORT_TEXT_MAX_LENGTH = 300;
export const PATTERN_LONG_TEXT_MAX_LENGTH = 4000;
export const PATTERN_ATTRIBUTE_MAX_LENGTH = 500;
export const PATTERN_ATTRIBUTE_LIST_MAX_ITEMS = 20;

function validateNonEmptyText(value: unknown, fieldLabel: string, maxLength: number): FieldValidationResult<string> {
  if (typeof value !== "string") return fail(`${fieldLabel} é obrigatório.`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return fail(`${fieldLabel} não pode ser vazio.`);
  if (value.length > maxLength) return fail(`${fieldLabel} não pode passar de ${maxLength} caracteres.`);
  return ok(value);
}

const CODE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,38}[A-Za-z0-9])?$/;

export function validatePatternCode(value: unknown): FieldValidationResult<string> {
  if (typeof value !== "string" || value.length === 0 || value.length > PATTERN_CODE_MAX_LENGTH || !CODE_RE.test(value)) {
    return fail("Código inválido — use letras, números, hífen ou underscore.");
  }
  return ok(value);
}

export function validatePatternSlugInput(value: unknown): FieldValidationResult<string> {
  if (!isValidPatternSlug(value)) return fail(`Slug inválido — use letras minúsculas, números e hífen, até ${PATTERN_SLUG_MAX_LENGTH} caracteres.`);
  return ok(value);
}

export function validatePatternName(value: unknown): FieldValidationResult<string> {
  return validateNonEmptyText(value, "Nome", PATTERN_SHORT_TEXT_MAX_LENGTH);
}

export function validateRecognitionPhrase(value: unknown): FieldValidationResult<string> {
  return validateNonEmptyText(value, "Frase de reconhecimento", PATTERN_SHORT_TEXT_MAX_LENGTH);
}

export function validatePatternDescription(value: unknown): FieldValidationResult<string> {
  return validateNonEmptyText(value, "Descrição", PATTERN_LONG_TEXT_MAX_LENGTH);
}

export function validateMainStrategy(value: unknown): FieldValidationResult<string> {
  return validateNonEmptyText(value, "Estratégia principal", PATTERN_LONG_TEXT_MAX_LENGTH);
}

export function validateIntroductoryExample(value: unknown): FieldValidationResult<string> {
  return validateNonEmptyText(value, "Exemplo introdutório", PATTERN_LONG_TEXT_MAX_LENGTH);
}

export function validateStrategicSummary(value: unknown): FieldValidationResult<string> {
  return validateNonEmptyText(value, "Resumo estratégico", PATTERN_LONG_TEXT_MAX_LENGTH);
}

export interface PatternAttributeLists {
  frequentClues: string[];
  recurringPhrases: string[];
  recurringVisualElements: string[];
  alternativeStrategies: string[];
  requiredContents: string[];
  prerequisiteContents: string[];
  commonMistakes: string[];
  tags: string[];
}

const ATTRIBUTE_FIELD_TO_TYPE: Record<keyof PatternAttributeLists, PatternAttributeType> = {
  frequentClues: "frequent_clue",
  recurringPhrases: "recurring_phrase",
  recurringVisualElements: "recurring_visual_element",
  alternativeStrategies: "alternative_strategy",
  requiredContents: "required_content",
  prerequisiteContents: "prerequisite_content",
  commonMistakes: "common_mistake",
  tags: "tag",
};

export { ATTRIBUTE_FIELD_TO_TYPE, PATTERN_ATTRIBUTE_TYPES };

function validateStringList(value: unknown, fieldLabel: string): FieldValidationResult<string[]> {
  if (value === undefined || value === null) return ok([]);
  if (!Array.isArray(value)) return fail(`${fieldLabel} inválido.`);
  if (value.length > PATTERN_ATTRIBUTE_LIST_MAX_ITEMS) return fail(`${fieldLabel}: no máximo ${PATTERN_ATTRIBUTE_LIST_MAX_ITEMS} itens.`);
  const parsed: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) return fail(`${fieldLabel}: item vazio não é permitido.`);
    if (item.length > PATTERN_ATTRIBUTE_MAX_LENGTH) return fail(`${fieldLabel}: item excede o tamanho máximo.`);
    parsed.push(item);
  }
  return ok(parsed);
}

export function validateAttributeLists(value: unknown): FieldValidationResult<PatternAttributeLists> {
  if (value === undefined || value === null) {
    return ok({
      frequentClues: [],
      recurringPhrases: [],
      recurringVisualElements: [],
      alternativeStrategies: [],
      requiredContents: [],
      prerequisiteContents: [],
      commonMistakes: [],
      tags: [],
    });
  }
  if (typeof value !== "object" || Array.isArray(value)) return fail("Atributos do padrão inválidos.");
  const raw = value as Record<string, unknown>;

  const result: Partial<PatternAttributeLists> = {};
  for (const field of Object.keys(ATTRIBUTE_FIELD_TO_TYPE) as (keyof PatternAttributeLists)[]) {
    const parsed = validateStringList(raw[field], field);
    if (!parsed.ok) return fail(parsed.error!);
    result[field] = parsed.value!;
  }
  return ok(result as PatternAttributeLists);
}

export function validateExpectedVersion(value: unknown): FieldValidationResult<number> {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return fail("expectedVersion é obrigatória.");
  return ok(value);
}
