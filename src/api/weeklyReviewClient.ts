/* Cliente da API do Relatório Semanal e das Metas Realistas — Sprint 13
   v1.0. Mesmo padrão de src/api/simulationsClient.ts: fetch tipado,
   credentials incluídas, erro traduzido para uma classe com code/status/
   fields. */

export interface WeeklyComparisonDeltas {
  confirmedQuestionsCount: number;
  correctCount: number;
  incorrectCount: number;
  daysWithEvidenceCount: number;
  approxMinutes: number | null;
}

export interface WeeklyComparison {
  previousWeekStart: string;
  available: boolean;
  deltas: WeeklyComparisonDeltas | null;
}

export interface GoalPattern {
  patternId: string;
  patternName: string;
  priorityPosition: number;
}

export interface GoalProgress {
  minutesDone: number | null;
  questionsDone: number | null;
  minutesPercent: number | null;
  questionsPercent: number | null;
  daysWithActivity: number | null;
  daysAvailable: number;
  patternsWithPractice: string[];
}

export interface Goal {
  id: string;
  weekStart: string;
  timezone: string;
  availableDays: string[];
  targetMinutes: number;
  targetQuestions: number;
  patterns: GoalPattern[];
  status: "active" | "completed" | "abandoned";
  version: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  abandonedAt: string | null;
  progress: GoalProgress;
}

export interface WeeklyReport {
  weekStart: string;
  weekEnd: string;
  timezone: string;
  isCurrentWeek: boolean;
  hasAnyEvidence: boolean;
  approxMinutes: number | null;
  confirmedQuestionsCount: number;
  distinctQuestionsCount: number;
  correctCount: number;
  incorrectCount: number;
  patternsPracticed: string[];
  helpLayersOpenedCount: number;
  dailyTrainingItemsCompleted: number;
  simulationBlocksCompleted: number;
  scheduleCompletedCount: number;
  scheduleRescheduledCount: number;
  errorNotebookEntriesCreated: number;
  reviewsCompletedCount: number;
  reviewsCorrectCount: number;
  reviewsIncorrectCount: number;
  overdueReviewsAtWeekEnd: number | null;
  daysWithEvidenceCount: number;
  comparison: WeeklyComparison;
  goal: Goal | null;
}

export interface WeeklyHistoryEntry {
  weekStart: string;
  weekEnd: string;
  isCurrentWeek: boolean;
  hasEvidence: boolean;
}

export interface SuggestedPattern {
  patternId: string;
  patternName: string;
  priorityPosition: number;
  reason: "overdue_review" | "error_notebook_pending" | "recent_development";
}

export interface GoalSuggestion {
  weekStart: string;
  timezone: string;
  suggestedMinutes: number;
  suggestedQuestions: number;
  suggestedPatterns: SuggestedPattern[];
  basedOnAvailability: boolean;
  availableDays: string[];
}

export interface ApiFieldError {
  code: string;
  message: string;
  fields?: Record<string, string>;
}

export class WeeklyReviewApiError extends Error {
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
    throw new WeeklyReviewApiError(apiError, response.status);
  }

  return data as T;
}

function newMutationId(): string {
  return crypto.randomUUID();
}

export function fetchCurrentReport(): Promise<{ ok: true; report: WeeklyReport }> {
  return request("/api/weekly-review/current");
}

export function fetchReportForWeek(weekStart: string): Promise<{ ok: true; report: WeeklyReport }> {
  return request(`/api/weekly-review/${encodeURIComponent(weekStart)}`);
}

export function fetchHistory(): Promise<{ ok: true; weeks: WeeklyHistoryEntry[] }> {
  return request("/api/weekly-review/history");
}

export function fetchGoalPreview(weekStart: string): Promise<{ ok: true; preview: GoalSuggestion }> {
  return request(`/api/weekly-goals/preview?weekStart=${encodeURIComponent(weekStart)}`);
}

export interface ApplyGoalParams {
  weekStart: string;
  targetMinutes: number;
  targetQuestions: number;
  availableDays: string[];
  patternIds: string[];
}

export function applyGoal(params: ApplyGoalParams): Promise<{ ok: true; goalId: string }> {
  return request("/api/weekly-goals/apply", {
    method: "POST",
    body: JSON.stringify({ mutationId: newMutationId(), ...params }),
  });
}

export interface PatchGoalParams {
  targetMinutes?: number;
  targetQuestions?: number;
  availableDays?: string[];
  patternIds?: string[];
  version: number;
}

export function patchGoal(goalId: string, params: PatchGoalParams): Promise<{ ok: true; goal: Goal }> {
  return request(`/api/weekly-goals/${encodeURIComponent(goalId)}`, {
    method: "PATCH",
    body: JSON.stringify({ mutationId: newMutationId(), ...params }),
  });
}

export function completeGoal(goalId: string): Promise<{ ok: true }> {
  return request(`/api/weekly-goals/${encodeURIComponent(goalId)}/complete`, {
    method: "POST",
    body: JSON.stringify({ mutationId: newMutationId() }),
  });
}

export function abandonGoal(goalId: string): Promise<{ ok: true }> {
  return request(`/api/weekly-goals/${encodeURIComponent(goalId)}/abandon`, {
    method: "POST",
    body: JSON.stringify({ mutationId: newMutationId() }),
  });
}
