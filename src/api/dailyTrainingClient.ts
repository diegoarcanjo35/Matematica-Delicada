/* Cliente da API do Treino Diário — Sprint 11 v1.0. Mesmo padrão de
   src/api/errorNotebookClient.ts: fetch tipado, credentials incluídas, erro
   traduzido para uma classe com code/status/fields. */

export type DailyTrainingReasonCode =
  | "overdue_review"
  | "schedule_commitment"
  | "pattern_in_development"
  | "pattern_initial_evidence"
  | "pattern_maintenance"
  | "pattern_exploration";

export const SKIP_REASON_LABELS: Record<string, string> = {
  not_now: "Agora não",
  too_hard: "Muito difícil agora",
  already_know: "Já sei isso",
  out_of_time: "Sem tempo",
};

export interface TrainingItem {
  id: string;
  questionId: string;
  questionCode: string;
  patternId: string | null;
  patternName: string | null;
  origin: string;
  reason: DailyTrainingReasonCode;
  reasonLabel: string;
  playerMode: string;
  position: number;
  estimatedMinutes: number;
  status: "pending" | "in_progress" | "completed" | "skipped" | "blocked";
  questionAttemptId: string | null;
  isCorrect: boolean | null;
  skipReason: string | null;
  version: number;
}

export interface TrainingList {
  id: string;
  date: string;
  timezone: string;
  status: "active" | "completed" | "abandoned";
  estimatedMinutes: number;
  itemCount: number;
  version: number;
  createdAt: string;
  completedAt: string | null;
  items: TrainingItem[];
}

export interface TrainingPreview {
  date: string;
  timezone: string;
  hasAvailabilityToday: boolean;
  availableMinutesToday: number;
  estimatedMinutes: number;
  itemCount: number;
  items: TrainingItem[];
  composition: Array<{ reason: DailyTrainingReasonCode; reasonLabel: string; count: number }>;
}

export interface CompletionSummary {
  completedCount: number;
  skippedCount: number;
  blockedCount: number;
  correctCount: number;
  incorrectCount: number;
  patternsPracticed: string[];
  reviewsCompleted: number;
  helpsUsedCount: number;
  approxMinutes: number;
}

export interface ApiFieldError {
  code: string;
  message: string;
  fields?: Record<string, string>;
}

export class DailyTrainingApiError extends Error {
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
    throw new DailyTrainingApiError(apiError, response.status);
  }

  return data as T;
}

function newMutationId(): string {
  return crypto.randomUUID();
}

export interface PreviewResponse {
  ok: true;
  available?: boolean;
  message?: string;
  preview?: TrainingPreview;
  empty?: boolean;
}

export function fetchPreview(): Promise<PreviewResponse> {
  return request("/api/daily-training/preview");
}

export interface CurrentResponse {
  ok: true;
  available?: boolean;
  message?: string;
  list?: TrainingList | null;
}

export function fetchCurrent(): Promise<CurrentResponse> {
  return request("/api/daily-training/current");
}

export interface ListDetailResponse {
  ok: true;
  available?: boolean;
  message?: string;
  list?: TrainingList;
}

export function fetchListDetail(listId: string): Promise<ListDetailResponse> {
  return request(`/api/daily-training/${encodeURIComponent(listId)}`);
}

export interface ApplyResponse {
  ok: true;
  listId?: string;
  empty?: boolean;
}

export function applyDailyTraining(): Promise<ApplyResponse> {
  return request("/api/daily-training/apply", { method: "POST", body: JSON.stringify({ mutationId: newMutationId() }) });
}

export interface StartItemResponse {
  ok: true;
  attemptId?: string;
  questionId?: string;
}

export function startItem(listId: string, itemId: string): Promise<StartItemResponse> {
  return request(`/api/daily-training/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}/start`, {
    method: "POST",
    body: JSON.stringify({ mutationId: newMutationId() }),
  });
}

export interface SyncItemResponse {
  ok: true;
  itemStatus?: string;
  isCorrect?: boolean | null;
}

export function syncItem(listId: string, itemId: string): Promise<SyncItemResponse> {
  return request(`/api/daily-training/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}/sync`, {
    method: "POST",
    body: JSON.stringify({ mutationId: newMutationId() }),
  });
}

export function skipItem(listId: string, itemId: string, skipReason: string): Promise<{ ok: true }> {
  return request(`/api/daily-training/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}/skip`, {
    method: "POST",
    body: JSON.stringify({ mutationId: newMutationId(), skipReason }),
  });
}

export interface CompleteListResponse {
  ok: true;
  summary?: CompletionSummary;
}

export function completeList(listId: string): Promise<CompleteListResponse> {
  return request(`/api/daily-training/${encodeURIComponent(listId)}/complete`, {
    method: "POST",
    body: JSON.stringify({ mutationId: newMutationId() }),
  });
}

export function abandonList(listId: string): Promise<{ ok: true }> {
  return request(`/api/daily-training/${encodeURIComponent(listId)}/abandon`, {
    method: "POST",
    body: JSON.stringify({ mutationId: newMutationId() }),
  });
}
