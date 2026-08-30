/* Validação centralizada do diagnóstico — Sprint 4 v1.0. Regras de faixa
   técnica (nunca pedagógicas) vivem só aqui; rotas/serviço só chamam isto. */

export const HELP_LAYER_MIN = 1;
export const HELP_LAYER_MAX = 4;

// Limite de sanidade técnica — nunca uma medida pedagógica. Impede que um
// cliente malicioso/quebrado grave um tempo absurdo; não é usado para
// pontuar nem para gerar índice algum nesta sprint.
export const TIME_SPENT_MS_MAX = 30 * 60 * 1000; // 30 minutos por questão

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

export function validateLayer(value: unknown): FieldValidationResult<number> {
  if (typeof value !== "number" || !Number.isInteger(value)) return fail("Camada de ajuda inválida.");
  if (value < HELP_LAYER_MIN || value > HELP_LAYER_MAX) return fail("Camada de ajuda inválida.");
  return ok(value);
}

export function validateTimeSpentMs(value: unknown): FieldValidationResult<number> {
  if (value === undefined || value === null) return ok(0);
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return fail("Tempo registrado inválido.");
  }
  // Nunca rejeita por exceder o limite — só satura (é telemetria, não nota).
  return ok(Math.min(value, TIME_SPENT_MS_MAX));
}

export function validateIsDontKnow(value: unknown): FieldValidationResult<boolean> {
  if (value === undefined || value === null) return ok(false);
  if (typeof value !== "boolean") return fail("Formato inválido.");
  return ok(value);
}

export function validateNonEmptyId(value: unknown, fieldLabel: string): FieldValidationResult<string> {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 100) {
    return fail(`${fieldLabel} inválido.`);
  }
  return ok(value);
}
