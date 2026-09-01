/* Cliente da API do Caderno de Erros — Sprint 9 v1.0. Mesmo padrão de
   src/api/playerClient.ts: fetch tipado, credentials incluídas, erro
   traduzido para uma classe com code/status/fields. */

export type ErrorType =
  | "unclassified"
  | "pattern_not_recognized"
  | "wrong_pattern"
  | "inadequate_strategy"
  | "interpretation"
  | "content_or_base"
  | "calculation"
  | "haste"
  | "time_shortage"
  | "marking_error";

export const ERROR_TYPE_LABELS: Record<ErrorType, string> = {
  unclassified: "Ainda não classificado",
  pattern_not_recognized: "Não reconheci o padrão",
  wrong_pattern: "Reconheci o padrão errado",
  inadequate_strategy: "Estratégia inadequada",
  interpretation: "Erro de interpretação",
  content_or_base: "Conteúdo ou base insuficiente",
  calculation: "Erro de cálculo",
  haste: "Pressa",
  time_shortage: "Falta de tempo",
  marking_error: "Erro ao marcar a alternativa",
};

export type EntryStatus = "pending_understanding" | "scheduled" | "due" | "in_review" | "corrected" | "archived";

export const STATUS_LABELS: Record<EntryStatus, string> = {
  pending_understanding: "Entendendo o erro",
  scheduled: "Revisão agendada",
  due: "Revisão vencida",
  in_review: "Em revisão",
  corrected: "Corrigido",
  archived: "Arquivado",
};

export interface EntryPattern {
  id: string;
  name: string;
  slug: string;
}

export interface EntryListItem {
  id: string;
  originalQuestionId: string;
  originalQuestionCode: string;
  primaryPattern: EntryPattern | null;
  errorType: ErrorType;
  status: EntryStatus;
  effectiveStatus: EntryStatus;
  errorCount: number;
  reviewStage: number;
  nextReviewAt: string;
  firstErrorAt: string;
  lastErrorAt: string;
  version: number;
}

export interface EntryReviewHistoryItem {
  id: string;
  reviewedQuestionId: string;
  reviewedQuestionCode: string;
  result: "correct" | "incorrect";
  previousStage: number;
  resultingStage: number;
  usedDifferentQuestion: boolean;
  createdAt: string;
}

export interface EntryDetail extends EntryListItem {
  originalAttemptId: string;
  studentNote: string | null;
  distinctReviewQuestionsSucceeded: number;
  correctedAt: string | null;
  lastReviewedAt: string | null;
  stillNeedsDifferentContext: boolean;
  reviewHistory: EntryReviewHistoryItem[];
}

export interface ApiFieldError {
  code: string;
  message: string;
  fields?: Record<string, string>;
}

export class ErrorNotebookApiError extends Error {
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
    throw new ErrorNotebookApiError(apiError, response.status);
  }

  return data as T;
}

export interface ListFiltersInput {
  patternSlug?: string;
  errorType?: string;
  status?: string;
  overdue?: boolean;
  from?: string;
  to?: string;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}

export interface ListResponse {
  ok: true;
  available?: boolean;
  message?: string;
  entries?: EntryListItem[];
  total?: number;
  limit?: number;
  offset?: number;
}

function buildQuery(filters: ListFiltersInput): string {
  const params = new URLSearchParams();
  if (filters.patternSlug) params.set("patternSlug", filters.patternSlug);
  if (filters.errorType) params.set("errorType", filters.errorType);
  if (filters.status) params.set("status", filters.status);
  if (filters.overdue) params.set("overdue", "true");
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.includeArchived) params.set("includeArchived", "true");
  params.set("limit", String(filters.limit ?? 20));
  params.set("offset", String(filters.offset ?? 0));
  return params.toString();
}

export function listEntries(filters: ListFiltersInput = {}): Promise<ListResponse> {
  return request(`/api/error-notebook?${buildQuery(filters)}`);
}

export interface SummaryResponse {
  ok: true;
  available?: boolean;
  message?: string;
  summary?: { active: number; overdue: number; corrected: number; total: number };
}

export function fetchSummary(): Promise<SummaryResponse> {
  return request("/api/error-notebook/summary");
}

export interface DetailResponse {
  ok: true;
  available?: boolean;
  message?: string;
  entry?: EntryDetail;
}

export function fetchEntry(entryId: string): Promise<DetailResponse> {
  return request(`/api/error-notebook/${encodeURIComponent(entryId)}`);
}

export interface PatchEntryInput {
  errorType?: ErrorType;
  studentNote?: string | null;
  expectedVersion: number;
  mutationId: string;
}

export function patchEntry(entryId: string, input: PatchEntryInput): Promise<{ ok: true; changed: boolean }> {
  return request(`/api/error-notebook/${encodeURIComponent(entryId)}`, { method: "PATCH", body: JSON.stringify(input) });
}

export interface StartReviewResponse {
  ok: true;
  attemptId?: string;
  reviewedQuestionId?: string;
  selectionReason?: string;
}

export function startReview(entryId: string): Promise<StartReviewResponse> {
  return request(`/api/error-notebook/${encodeURIComponent(entryId)}/start-review`, { method: "POST" });
}

export function archiveEntry(entryId: string, expectedVersion: number, mutationId: string): Promise<{ ok: true }> {
  return request(`/api/error-notebook/${encodeURIComponent(entryId)}/archive`, {
    method: "POST",
    body: JSON.stringify({ expectedVersion, mutationId }),
  });
}
