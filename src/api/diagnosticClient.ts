/* Cliente da API de diagnóstico — mesmo padrão de src/api/onboardingClient.ts. */

export interface DiagnosticStatus {
  ok: true;
  available: boolean;
  activeAttemptId: string | null;
  latestCompletedAttemptId: string | null;
}

export interface DiagnosticAttemptQuestion {
  id: string;
  position: number;
  prompt: string;
  options: Array<{ id: string; text: string }>;
  hasRecognition: boolean;
  recognitionOptions: Array<{ id: string; text: string }>;
  helpLayersAvailable: number[];
  helpLayersOpened: number[];
  answered: boolean;
  isDontKnow: boolean;
}

export interface DiagnosticAttemptDetail {
  id: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  questions: DiagnosticAttemptQuestion[];
}

export interface DiagnosticResult {
  status: string;
  totalQuestions: number;
  answeredCount: number;
  correctCount: number;
  dontKnowCount: number;
  totalTimeMs: number;
  averageTimeMs: number;
  helpOpensByLayer: Record<number, number>;
  recognitionConfiguredCount: number;
  recognitionInformedCount: number;
  recognitionCorrectCount: number;
  disclaimer: string;
}

export interface ApiFieldError {
  code: string;
  message: string;
  fields?: Record<string, string>;
}

export class DiagnosticApiError extends Error {
  readonly fields: Record<string, string>;
  readonly status: number;
  readonly code: string;

  constructor(apiError: ApiFieldError, status: number) {
    super(apiError.message);
    this.fields = apiError.fields ?? {};
    this.status = status;
    this.code = apiError.code;
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
    throw new DiagnosticApiError(apiError, response.status);
  }

  return data as T;
}

export function fetchDiagnosticStatus(): Promise<DiagnosticStatus> {
  return request("/api/diagnostic/status");
}

export function createDiagnosticAttempt(
  restart: boolean
): Promise<{ ok: true; attemptId: string } | { error: { code: string; message: string; attemptId?: string } }> {
  return request("/api/diagnostic/attempts", { method: "POST", body: JSON.stringify({ restart }) });
}

export function fetchDiagnosticAttempt(attemptId: string): Promise<{ ok: true; attempt: DiagnosticAttemptDetail }> {
  return request(`/api/diagnostic/attempts/${attemptId}`);
}

export function saveDiagnosticResponse(
  attemptId: string,
  questionId: string,
  patch: {
    optionId?: string;
    recognitionOptionId?: string;
    isDontKnow?: boolean;
    timeSpentMs?: number;
  }
): Promise<{ ok: true }> {
  return request(`/api/diagnostic/attempts/${attemptId}/responses/${questionId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function openDiagnosticHelp(
  attemptId: string,
  questionId: string,
  layer: number
): Promise<{ ok: true; content: string }> {
  return request(`/api/diagnostic/attempts/${attemptId}/help/${questionId}/${layer}`, { method: "POST" });
}

export function completeDiagnosticAttempt(attemptId: string): Promise<{ ok: true }> {
  return request(`/api/diagnostic/attempts/${attemptId}/complete`, { method: "POST" });
}

export function fetchDiagnosticResult(attemptId: string): Promise<{ ok: true; result: DiagnosticResult }> {
  return request(`/api/diagnostic/attempts/${attemptId}/result`);
}
