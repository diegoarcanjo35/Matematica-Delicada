/* Cliente da API do cronograma adaptativo — mesmo padrão de
   src/api/diagnosticClient.ts. */

export interface ScheduleSummary {
  ok: true;
  available: boolean;
  today: string;
  timezone: string;
  plannedMinutesToday: number;
  availableMinutesToday: number;
  pendingCount: number;
}

export interface ScheduleActivity {
  id: string;
  activityId: string;
  type: string;
  title: string;
  objective: string;
  estimatedMinutes: number;
  completionCriteria: string;
  explanation: string;
  completionMode: string;
  origin: string;
  dismissible: boolean;
  isLocalFixture: boolean;
  plannedDate: string | null;
  position: number | null;
  status: string;
  effectiveStatus: string;
  lastTransitionReason: string | null;
  version: number;
  startedAt: string | null;
  completedAt: string | null;
}

export type ScheduleView = "today" | "week" | "month" | "pending" | "reviews" | "assigned" | "history";

export interface ApiFieldError {
  code: string;
  message: string;
  fields?: Record<string, string>;
}

export class ScheduleApiError extends Error {
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
    throw new ScheduleApiError(apiError, response.status);
  }

  return data as T;
}

export function fetchScheduleSummary(): Promise<ScheduleSummary> {
  return request("/api/schedule/summary");
}

export function fetchScheduleActivities(
  view: ScheduleView,
  params: { year?: number; month?: number } = {}
): Promise<{ ok: true; activities: ScheduleActivity[] }> {
  const search = new URLSearchParams({ view });
  if (params.year) search.set("year", String(params.year));
  if (params.month) search.set("month", String(params.month));
  return request(`/api/schedule/activities?${search.toString()}`);
}

export function fetchScheduleActivityDetail(assignmentId: string): Promise<{ ok: true; activity: ScheduleActivity }> {
  return request(`/api/schedule/activities/${assignmentId}`);
}

export function startScheduleActivity(assignmentId: string, version: number): Promise<{ ok: true }> {
  return request(`/api/schedule/activities/${assignmentId}/start`, {
    method: "POST",
    body: JSON.stringify({ version }),
  });
}

export function completeScheduleActivity(assignmentId: string, version: number): Promise<{ ok: true }> {
  return request(`/api/schedule/activities/${assignmentId}/complete`, {
    method: "POST",
    body: JSON.stringify({ version }),
  });
}

export function dismissScheduleActivity(assignmentId: string, version: number): Promise<{ ok: true }> {
  return request(`/api/schedule/activities/${assignmentId}/dismiss`, {
    method: "POST",
    body: JSON.stringify({ version }),
  });
}

export function rescheduleScheduleActivity(
  assignmentId: string,
  version: number
): Promise<{ ok: true; newAssignmentId: string }> {
  return request(`/api/schedule/activities/${assignmentId}/reschedule`, {
    method: "POST",
    body: JSON.stringify({ version }),
  });
}

export interface SchedulePlanPreview {
  ok: true;
  previewId: string;
  placed: Array<{ assignmentId: string; plannedDate: string; position: number }>;
  unplaceableAssignmentIds: string[];
  expiresAt: string;
}

export function previewSchedulePlan(): Promise<SchedulePlanPreview> {
  return request("/api/schedule/plan/preview", { method: "POST" });
}

export function applySchedulePlan(previewId: string): Promise<{ ok: true; appliedCount: number }> {
  return request("/api/schedule/plan/apply", { method: "POST", body: JSON.stringify({ previewId }) });
}

export function updateScheduleTimezone(timezone: string): Promise<{ ok: true; timezone: string }> {
  return request("/api/schedule/preferences", { method: "PATCH", body: JSON.stringify({ timezone }) });
}
