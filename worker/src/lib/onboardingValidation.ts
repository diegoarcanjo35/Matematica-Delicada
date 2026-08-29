/* Validação centralizada do onboarding — Sprint 3 v1.0. Toda regra de negócio
   sobre os campos do perfil do aluno vive aqui; rotas e serviço só chamam isto,
   nunca duplicam limite/conjunto em outro lugar (Documento Mestre, seção 10.2). */

export const GRADE_OPTIONS = [
  "8_ano_ef",
  "9_ano_ef",
  "1_serie_em",
  "2_serie_em",
  "3_serie_em",
  "concluido_em",
] as const;
export type Grade = (typeof GRADE_OPTIONS)[number];

export const GOAL_TYPES = ["acertos", "nota"] as const;
export type GoalType = (typeof GOAL_TYPES)[number];

export const TIME_PREFERENCES = ["manha", "tarde", "noite", "variavel"] as const;
export type TimePreference = (typeof TIME_PREFERENCES)[number];

export const WEEKDAYS = ["seg", "ter", "qua", "qui", "sex", "sab", "dom"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const DIAGNOSTIC_CHOICES = ["agora", "depois"] as const;
export type DiagnosticChoice = (typeof DIAGNOSTIC_CHOICES)[number];

// 45 questões de Matemática do ENEM (Documento Mestre) — teto da meta em acertos
// e do "acertos atuais aproximados".
export const ENEM_MATH_QUESTION_COUNT = 45;
export const GOAL_SCORE_MIN = 0;
export const GOAL_SCORE_MAX = 1000; // escala TRI do ENEM — meta, não projeção garantida.
export const DAILY_MINUTES_MIN = 10;
export const DAILY_MINUTES_MAX = 240;
export const DIFFICULTIES_MAX_ITEMS = 6;
export const DIFFICULTY_TEXT_MAX_LENGTH = 80;
export const ACCESSIBILITY_TEXT_MAX_LENGTH = 200;
export const ONBOARDING_STEP_COUNT = 7;

function isPlainString(value: unknown): value is string {
  return typeof value === "string";
}

/** Remove caracteres de controle antes de persistir texto livre — nunca exibir
 *  entrada hostil sem sanitização (seção 7 da ordem). */
function sanitizeText(value: string): string {
  // eslint-disable-next-line no-control-regex -- intencional: remove caracteres de controle.
  const controlCharPattern = new RegExp("[\\u0000-\\u001F\\u007F]", "g");
  return value.replace(controlCharPattern, "").trim();
}

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

export function validateCurrentGrade(value: unknown): FieldValidationResult<Grade> {
  if (!isPlainString(value) || !(GRADE_OPTIONS as readonly string[]).includes(value)) {
    return fail("Selecione uma série válida.");
  }
  return ok(value as Grade);
}

export function validateEnemYear(value: unknown, currentYear: number): FieldValidationResult<number> {
  if (typeof value !== "number" || !Number.isInteger(value)) return fail("Informe um ano válido.");
  if (value < currentYear) return fail("O ano do ENEM não pode ser anterior ao ano corrente.");
  if (value > currentYear + 10) return fail("Informe um ano válido.");
  return ok(value);
}

export function validateGoalType(value: unknown): FieldValidationResult<GoalType> {
  if (!isPlainString(value) || !(GOAL_TYPES as readonly string[]).includes(value)) {
    return fail("Selecione um tipo de meta válido.");
  }
  return ok(value as GoalType);
}

export function validateGoalValue(value: unknown, goalType: GoalType | undefined): FieldValidationResult<number> {
  if (typeof value !== "number" || !Number.isInteger(value)) return fail("Informe um valor de meta válido.");
  if (goalType === "acertos") {
    if (value < 0 || value > ENEM_MATH_QUESTION_COUNT) {
      return fail(`A meta em acertos deve estar entre 0 e ${ENEM_MATH_QUESTION_COUNT}.`);
    }
    return ok(value);
  }
  if (goalType === "nota") {
    if (value < GOAL_SCORE_MIN || value > GOAL_SCORE_MAX) {
      return fail(`A meta em nota deve estar entre ${GOAL_SCORE_MIN} e ${GOAL_SCORE_MAX}.`);
    }
    return ok(value);
  }
  return fail("Selecione o tipo de meta antes de informar o valor.");
}

export function validateCurrentCorrectEstimate(value: unknown): FieldValidationResult<number | null> {
  if (value === null || value === undefined) return ok(null);
  if (typeof value !== "number" || !Number.isInteger(value)) return fail("Informe um número válido.");
  if (value < 0 || value > ENEM_MATH_QUESTION_COUNT) {
    return fail(`Deve estar entre 0 e ${ENEM_MATH_QUESTION_COUNT}.`);
  }
  return ok(value);
}

export function validateAvailableDays(value: unknown): FieldValidationResult<Weekday[]> {
  if (!Array.isArray(value) || value.length === 0) return fail("Selecione ao menos um dia disponível.");
  const seen = new Set<string>();
  for (const item of value) {
    if (!isPlainString(item) || !(WEEKDAYS as readonly string[]).includes(item)) {
      return fail("Dia inválido na lista de disponibilidade.");
    }
    if (seen.has(item)) return fail("Dias disponíveis não podem se repetir.");
    seen.add(item);
  }
  return ok(value as Weekday[]);
}

export function validateDailyMinutes(value: unknown): FieldValidationResult<number> {
  if (typeof value !== "number" || !Number.isInteger(value)) return fail("Informe os minutos disponíveis por dia.");
  if (value < DAILY_MINUTES_MIN || value > DAILY_MINUTES_MAX) {
    return fail(`Deve estar entre ${DAILY_MINUTES_MIN} e ${DAILY_MINUTES_MAX} minutos.`);
  }
  return ok(value);
}

export function validateDifficulties(value: unknown): FieldValidationResult<string[]> {
  if (!Array.isArray(value)) return fail("Formato inválido para dificuldades.");
  if (value.length > DIFFICULTIES_MAX_ITEMS) {
    return fail(`Selecione no máximo ${DIFFICULTIES_MAX_ITEMS} dificuldades.`);
  }
  const cleaned: string[] = [];
  for (const item of value) {
    if (!isPlainString(item)) return fail("Formato inválido para dificuldades.");
    const sanitized = sanitizeText(item);
    if (sanitized.length === 0 || sanitized.length > DIFFICULTY_TEXT_MAX_LENGTH) {
      return fail(`Cada dificuldade deve ter entre 1 e ${DIFFICULTY_TEXT_MAX_LENGTH} caracteres.`);
    }
    cleaned.push(sanitized);
  }
  return ok(cleaned);
}

export function validateTimePreference(value: unknown): FieldValidationResult<TimePreference> {
  if (!isPlainString(value) || !(TIME_PREFERENCES as readonly string[]).includes(value)) {
    return fail("Selecione uma preferência de horário válida.");
  }
  return ok(value as TimePreference);
}

export function validateAccessibilityNeeds(value: unknown): FieldValidationResult<string | null> {
  if (value === null || value === undefined) return ok(null);
  if (!isPlainString(value)) return fail("Formato inválido.");
  const sanitized = sanitizeText(value);
  if (sanitized.length > ACCESSIBILITY_TEXT_MAX_LENGTH) {
    return fail(`Deve ter no máximo ${ACCESSIBILITY_TEXT_MAX_LENGTH} caracteres.`);
  }
  return ok(sanitized.length === 0 ? null : sanitized);
}

export function validateDiagnosticChoice(value: unknown): FieldValidationResult<DiagnosticChoice> {
  if (!isPlainString(value) || !(DIAGNOSTIC_CHOICES as readonly string[]).includes(value)) {
    return fail('Escolha "agora" ou "depois" para o diagnóstico.');
  }
  return ok(value as DiagnosticChoice);
}

export function validateCurrentStep(value: unknown): FieldValidationResult<number> {
  if (typeof value !== "number" || !Number.isInteger(value)) return fail("Etapa inválida.");
  if (value < 1 || value > ONBOARDING_STEP_COUNT) return fail("Etapa inválida.");
  return ok(value);
}
