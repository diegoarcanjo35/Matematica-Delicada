/* Cliente da API dos Simulados em Blocos — Sprint 12 v1.0. Mesmo padrão de
   src/api/dailyTrainingClient.ts: fetch tipado, credentials incluídas, erro
   traduzido para uma classe com code/status/fields. */

export type SimulationBlockType = "mixed" | "pattern_focused";
export const ALLOWED_BLOCK_SIZES = [5, 10, 15] as const;
export type SimulationBlockSize = (typeof ALLOWED_BLOCK_SIZES)[number];

export interface BlockItem {
  id: string;
  questionId: string;
  questionCode: string;
  patternId: string | null;
  patternName: string | null;
  position: number;
  estimatedMinutes: number;
  status: "pending" | "in_progress" | "completed" | "skipped" | "blocked";
  questionAttemptId: string | null;
  isCorrect: boolean | null;
  version: number;
}

export interface Block {
  id: string;
  blockType: SimulationBlockType;
  primaryPatternId: string | null;
  primaryPatternName: string | null;
  status: "active" | "completed" | "abandoned";
  plannedItemCount: number;
  actualItemCount: number;
  estimatedMinutes: number;
  timezone: string;
  blockDate: string;
  version: number;
  createdAt: string;
  completedAt: string | null;
  abandonedAt: string | null;
  items: BlockItem[];
}

export interface PreviewCompositionEntry {
  patternId: string;
  patternName: string;
  count: number;
}

export interface Preview {
  blockType: SimulationBlockType;
  primaryPatternId: string | null;
  primaryPatternName: string | null;
  requestedSize: SimulationBlockSize;
  availableCount: number;
  selectableCount: number;
  estimatedMinutes: number;
  composition: PreviewCompositionEntry[];
  insufficientQuantity: boolean;
  items: BlockItem[];
}

export interface CompletionSummary {
  completedCount: number;
  skippedCount: number;
  blockedCount: number;
  correctCount: number;
  incorrectCount: number;
  accuracyPercent: number | null;
  patternsPracticed: string[];
  approxMinutes: number;
  approxMinutesPerQuestion: number | null;
  helpsUsedCount: number;
}

export interface HistoryEntry {
  id: string;
  blockType: SimulationBlockType;
  primaryPatternName: string | null;
  status: string;
  blockDate: string;
  completedCount: number;
  correctCount: number;
  incorrectCount: number;
  estimatedMinutes: number;
  completedAt: string | null;
  abandonedAt: string | null;
}

export interface ApiFieldError {
  code: string;
  message: string;
  fields?: Record<string, string>;
}

export class SimulationsApiError extends Error {
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
    throw new SimulationsApiError(apiError, response.status);
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
  preview?: Preview;
}

export function fetchPreview(params: { blockType: SimulationBlockType; patternSlug?: string; size: SimulationBlockSize }): Promise<PreviewResponse> {
  const search = new URLSearchParams({ blockType: params.blockType, size: String(params.size) });
  if (params.patternSlug) search.set("patternSlug", params.patternSlug);
  return request(`/api/simulations/preview?${search.toString()}`);
}

export interface CurrentResponse {
  ok: true;
  available?: boolean;
  message?: string;
  block?: Block | null;
}

export function fetchCurrent(): Promise<CurrentResponse> {
  return request("/api/simulations/current");
}

export interface BlockDetailResponse {
  ok: true;
  available?: boolean;
  message?: string;
  block?: Block;
}

export function fetchBlockDetail(blockId: string): Promise<BlockDetailResponse> {
  return request(`/api/simulations/${encodeURIComponent(blockId)}`);
}

export interface ApplyResponse {
  ok: true;
  blockId?: string;
  empty?: boolean;
}

export function applyBlock(params: { blockType: SimulationBlockType; patternSlug?: string; size: SimulationBlockSize }): Promise<ApplyResponse> {
  return request("/api/simulations/apply", {
    method: "POST",
    body: JSON.stringify({ mutationId: newMutationId(), blockType: params.blockType, patternSlug: params.patternSlug, size: params.size }),
  });
}

export interface StartItemResponse {
  ok: true;
  attemptId?: string;
  questionId?: string;
}

export function startItem(blockId: string, itemId: string): Promise<StartItemResponse> {
  return request(`/api/simulations/${encodeURIComponent(blockId)}/items/${encodeURIComponent(itemId)}/start`, {
    method: "POST",
    body: JSON.stringify({ mutationId: newMutationId() }),
  });
}

export interface SyncItemResponse {
  ok: true;
  itemStatus?: string;
  isCorrect?: boolean | null;
}

export function syncItem(blockId: string, itemId: string): Promise<SyncItemResponse> {
  return request(`/api/simulations/${encodeURIComponent(blockId)}/items/${encodeURIComponent(itemId)}/sync`, {
    method: "POST",
    body: JSON.stringify({ mutationId: newMutationId() }),
  });
}

export function skipItem(blockId: string, itemId: string): Promise<{ ok: true }> {
  return request(`/api/simulations/${encodeURIComponent(blockId)}/items/${encodeURIComponent(itemId)}/skip`, {
    method: "POST",
    body: JSON.stringify({ mutationId: newMutationId() }),
  });
}

export interface CompleteBlockResponse {
  ok: true;
  summary?: CompletionSummary;
}

export function completeBlock(blockId: string): Promise<CompleteBlockResponse> {
  return request(`/api/simulations/${encodeURIComponent(blockId)}/complete`, {
    method: "POST",
    body: JSON.stringify({ mutationId: newMutationId() }),
  });
}

export function abandonBlock(blockId: string): Promise<{ ok: true }> {
  return request(`/api/simulations/${encodeURIComponent(blockId)}/abandon`, {
    method: "POST",
    body: JSON.stringify({ mutationId: newMutationId() }),
  });
}

export interface HistoryResponse {
  ok: true;
  entries: HistoryEntry[];
  hasMore: boolean;
}

export function fetchHistory(): Promise<HistoryResponse> {
  return request("/api/simulations/history");
}
