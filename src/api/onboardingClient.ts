/* Cliente da API de onboarding — mesmo padrão de src/api/authClient.ts
   (cookies HttpOnly, credentials: "include", nunca lida com token). */

export interface OnboardingProfile {
  status: "not_started" | "in_progress" | "completed" | string;
  currentStep: number;
  currentGrade: string | null;
  enemYear: number | null;
  goalType: "acertos" | "nota" | null;
  goalValue: number | null;
  currentCorrectEstimate: number | null;
  availableDays: string[] | null;
  dailyMinutes: number | null;
  difficulties: string[] | null;
  timePreference: string | null;
  accessibilityNeeds: string | null;
  diagnosticChoice: "agora" | "depois" | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface OnboardingPatch {
  currentGrade?: string;
  enemYear?: number;
  goalType?: "acertos" | "nota";
  goalValue?: number;
  currentCorrectEstimate?: number | null;
  availableDays?: string[];
  dailyMinutes?: number;
  difficulties?: string[];
  timePreference?: string;
  accessibilityNeeds?: string | null;
  diagnosticChoice?: "agora" | "depois";
  currentStep?: number;
}

export interface ApiFieldError {
  code: string;
  message: string;
  fields?: Record<string, string>;
}

export class OnboardingApiError extends Error {
  readonly fields: Record<string, string>;
  readonly status: number;

  constructor(apiError: ApiFieldError, status: number) {
    super(apiError.message);
    this.fields = apiError.fields ?? {};
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init.headers },
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const apiError: ApiFieldError = data?.error ?? { code: "unknown", message: "Erro inesperado." };
    throw new OnboardingApiError(apiError, response.status);
  }

  return data as T;
}

export function fetchOnboarding(): Promise<{ ok: true; profile: OnboardingProfile }> {
  return request("/api/onboarding");
}

export function saveOnboardingProgress(
  patch: OnboardingPatch
): Promise<{ ok: true; profile: OnboardingProfile }> {
  return request("/api/onboarding", { method: "PATCH", body: JSON.stringify(patch) });
}

export function completeOnboarding(): Promise<{ ok: true; profile: OnboardingProfile }> {
  return request("/api/onboarding/complete", { method: "POST" });
}
