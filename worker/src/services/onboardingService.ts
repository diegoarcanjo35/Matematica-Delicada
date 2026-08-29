import {
  ONBOARDING_COLUMNS_EDITABLE_AFTER_COMPLETION,
  findProfile,
  markCompleted,
  upsertProfilePatch,
  type OnboardingColumn,
  type StudentProfileRow,
} from "../repositories/onboardingRepository";
import {
  validateAccessibilityNeeds,
  validateAvailableDays,
  validateCurrentCorrectEstimate,
  validateCurrentGrade,
  validateCurrentStep,
  validateDailyMinutes,
  validateDiagnosticChoice,
  validateDifficulties,
  validateEnemYear,
  validateGoalType,
  validateGoalValue,
  validateTimePreference,
  type GoalType,
} from "../lib/onboardingValidation";

/* Serviço de onboarding — Sprint 3 v1.0. Orquestra validação (worker/src/lib/onboardingValidation.ts)
   e persistência (worker/src/repositories/onboardingRepository.ts). O user_id
   SEMPRE vem da sessão validada no Worker (nunca do corpo/query da requisição)
   — quem chama este serviço é responsável por isso (ver routes/onboarding.ts). */

export interface OnboardingPatchInput {
  currentGrade?: unknown;
  enemYear?: unknown;
  goalType?: unknown;
  goalValue?: unknown;
  currentCorrectEstimate?: unknown;
  availableDays?: unknown;
  dailyMinutes?: unknown;
  difficulties?: unknown;
  timePreference?: unknown;
  accessibilityNeeds?: unknown;
  diagnosticChoice?: unknown;
  currentStep?: unknown;
}

export interface OnboardingProfileView {
  status: string;
  currentStep: number;
  currentGrade: string | null;
  enemYear: number | null;
  goalType: string | null;
  goalValue: number | null;
  currentCorrectEstimate: number | null;
  availableDays: string[] | null;
  dailyMinutes: number | null;
  difficulties: string[] | null;
  timePreference: string | null;
  accessibilityNeeds: string | null;
  diagnosticChoice: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

function parseJsonArray(value: string | null): string[] | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

function toView(row: StudentProfileRow | null): OnboardingProfileView {
  if (!row) {
    return {
      status: "not_started",
      currentStep: 1,
      currentGrade: null,
      enemYear: null,
      goalType: null,
      goalValue: null,
      currentCorrectEstimate: null,
      availableDays: null,
      dailyMinutes: null,
      difficulties: null,
      timePreference: null,
      accessibilityNeeds: null,
      diagnosticChoice: null,
      startedAt: null,
      completedAt: null,
    };
  }
  return {
    status: row.status,
    currentStep: row.current_step,
    currentGrade: row.current_grade,
    enemYear: row.enem_year,
    goalType: row.goal_type,
    goalValue: row.goal_value,
    currentCorrectEstimate: row.current_correct_estimate,
    availableDays: parseJsonArray(row.available_days),
    dailyMinutes: row.daily_minutes,
    difficulties: parseJsonArray(row.difficulties),
    timePreference: row.time_preference,
    accessibilityNeeds: row.accessibility_needs,
    diagnosticChoice: row.diagnostic_choice,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export async function getOnboarding(db: D1Database, userId: string): Promise<OnboardingProfileView> {
  const row = await findProfile(db, userId);
  return toView(row);
}

export interface SaveProgressResult {
  ok: boolean;
  fieldErrors?: Record<string, string>;
  profile?: OnboardingProfileView;
  startedNow?: boolean;
  wasCompletedBefore?: boolean;
}

/** Salva progresso parcial — só valida os campos presentes no corpo (as
 *  demais etapas ainda não respondidas continuam ausentes, não é um erro).
 *  Se o perfil já está concluído, só os campos em
 *  ONBOARDING_COLUMNS_EDITABLE_AFTER_COMPLETION podem ser alterados — regra
 *  explícita (seção 6/11 da ordem), não um "PATCH livre" pós-conclusão. */
export async function saveProgress(
  db: D1Database,
  userId: string,
  input: OnboardingPatchInput,
  currentYear: number
): Promise<SaveProgressResult> {
  const existing = await findProfile(db, userId);
  const isCompleted = existing?.status === "completed";
  const effectiveGoalType = (input.goalType as GoalType | undefined) ?? (existing?.goal_type as GoalType | null) ?? undefined;

  const fieldErrors: Record<string, string> = {};
  const patch: Partial<Record<OnboardingColumn, unknown>> = {};

  function tryField<T>(
    key: keyof OnboardingPatchInput,
    column: OnboardingColumn,
    validate: (value: unknown) => { ok: boolean; value?: T; error?: string },
    serialize: (value: T) => unknown = (value) => value
  ) {
    if (!(key in input) || input[key] === undefined) return;
    if (isCompleted && !ONBOARDING_COLUMNS_EDITABLE_AFTER_COMPLETION.has(column)) {
      fieldErrors[key] = "Este campo não pode mais ser alterado após a conclusão do onboarding.";
      return;
    }
    const result = validate(input[key]);
    if (!result.ok) {
      fieldErrors[key] = result.error ?? "Valor inválido.";
      return;
    }
    patch[column] = serialize(result.value as T);
  }

  tryField("currentGrade", "current_grade", validateCurrentGrade);
  tryField("enemYear", "enem_year", (value) => validateEnemYear(value, currentYear));
  tryField("goalType", "goal_type", validateGoalType);
  tryField("goalValue", "goal_value", (value) => validateGoalValue(value, effectiveGoalType));
  tryField("currentCorrectEstimate", "current_correct_estimate", validateCurrentCorrectEstimate);
  tryField("availableDays", "available_days", validateAvailableDays, (value) => JSON.stringify(value));
  tryField("dailyMinutes", "daily_minutes", validateDailyMinutes);
  tryField("difficulties", "difficulties", validateDifficulties, (value) => JSON.stringify(value));
  tryField("timePreference", "time_preference", validateTimePreference);
  tryField("accessibilityNeeds", "accessibility_needs", validateAccessibilityNeeds);
  tryField("diagnosticChoice", "diagnostic_choice", validateDiagnosticChoice);
  tryField("currentStep", "current_step", validateCurrentStep);

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }

  const row = await upsertProfilePatch(db, userId, patch);
  return {
    ok: true,
    profile: toView(row),
    startedNow: existing === null,
    wasCompletedBefore: isCompleted,
  };
}

export interface CompleteResult {
  ok: boolean;
  fieldErrors?: Record<string, string>;
  alreadyCompleted?: boolean;
  profile?: OnboardingProfileView;
}

const REQUIRED_FOR_COMPLETION: Array<{ column: keyof StudentProfileRow; field: string; message: string }> = [
  { column: "current_grade", field: "currentGrade", message: "Informe sua série atual." },
  { column: "enem_year", field: "enemYear", message: "Informe o ano em que fará o ENEM." },
  { column: "goal_type", field: "goalType", message: "Escolha o tipo de meta." },
  { column: "goal_value", field: "goalValue", message: "Informe o valor da meta." },
  { column: "available_days", field: "availableDays", message: "Selecione seus dias disponíveis." },
  { column: "daily_minutes", field: "dailyMinutes", message: "Informe os minutos disponíveis por dia." },
  { column: "difficulties", field: "difficulties", message: "Informe suas principais dificuldades (pode ser uma lista vazia)." },
  { column: "time_preference", field: "timePreference", message: "Escolha sua preferência de horário." },
  { column: "diagnostic_choice", field: "diagnosticChoice", message: "Escolha realizar o diagnóstico agora ou depois." },
];

/** Conclui o onboarding — valida que TODOS os campos obrigatórios já foram
 *  salvos (via saveProgress em etapas anteriores) antes de marcar como
 *  concluído. Idempotente: se já concluído, retorna sucesso sem revalidar
 *  nem regravar completed_at (seção 6/14 da ordem: "conclusão repetida sem
 *  duplicidade"). */
export async function completeOnboarding(db: D1Database, userId: string): Promise<CompleteResult> {
  const existing = await findProfile(db, userId);

  if (existing?.status === "completed") {
    return { ok: true, alreadyCompleted: true, profile: toView(existing) };
  }

  const fieldErrors: Record<string, string> = {};
  for (const requirement of REQUIRED_FOR_COMPLETION) {
    const value = existing?.[requirement.column];
    if (value === null || value === undefined) {
      fieldErrors[requirement.field] = requirement.message;
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }

  const { changed } = await markCompleted(db, userId);
  if (!changed) {
    // Corrida rara: outra requisição concluiu entre a leitura e a gravação —
    // trata como sucesso idempotente, não como erro (mesma linha, mesmo dono).
    const row = await findProfile(db, userId);
    return { ok: true, alreadyCompleted: true, profile: toView(row) };
  }

  const row = await findProfile(db, userId);
  return { ok: true, profile: toView(row) };
}
