/* Cliente da API do Mapa ENEM do Aluno — Sprint 10 v1.0. Mesmo padrão de
   src/api/errorNotebookClient.ts/playerClient.ts: fetch tipado, credentials
   incluídas, `available: false` sinaliza o gate local de fixtures fechado
   (mesmo tratamento do resto do namespace do aluno — nunca um erro, um
   estado "em preparação"). Só espelha os 4 endpoints GET que existem
   (worker/src/routes/studentMetrics.ts) — não há `rebuild` nesta sprint. */

export const PROVISIONAL_STATES = [
  "sem_evidencias",
  "evidencias_iniciais",
  "em_desenvolvimento",
  "consistente_no_recorte",
  "revisao_pendente",
] as const;
export type ProvisionalState = (typeof PROVISIONAL_STATES)[number];

export interface PatternMetricSummary {
  patternId: string;
  code: string;
  slug: string;
  name: string;
  state: ProvisionalState;
  stateLabel: string;
  questionsStarted: number;
  questionsConfirmed: number;
  correctCount: number;
  incorrectCount: number;
  distinctQuestionsUsed: number;
  helpOpens: number;
  highestHelpLayer: number;
  lastPracticeAt: string | null;
  nextReviewAt: string | null;
  hasActiveErrorEntry: boolean;
}

export interface PatternMetricDetail extends PatternMetricSummary {
  attemptsLearning: number;
  attemptsPractice: number;
  attemptsRecognition: number;
  attemptsReview: number;
  recognitionsLogged: number;
  approxTimeSeconds: number;
  reviewsCorrect: number;
  reviewsIncorrect: number;
  lastReviewedAt: string | null;
  nextStepRecommendation: string;
  limitationsNote: string;
}

export interface StudentMetricsSummary {
  totalPublishedPatterns: number;
  hasAnyEvidence: boolean;
  patternsByState: Record<ProvisionalState, number>;
  pendingReviewCount: number;
  lastPracticeAt: string | null;
}

export interface ActivityItem {
  kind: "answer" | "recognition" | "help" | "review";
  patternId: string | null;
  patternName: string | null;
  patternSlug: string | null;
  createdAt: string;
  isCorrect: number | null;
  reviewResult: string | null;
}

export interface ApiFieldError {
  code: string;
  message: string;
  fields?: Record<string, string>;
}

export class StudentMetricsApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(apiError: ApiFieldError, status: number) {
    super(apiError.message);
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
    throw new StudentMetricsApiError(apiError, response.status);
  }

  return data as T;
}

export interface SummaryResponse {
  ok: true;
  available?: boolean;
  message?: string;
  summary?: StudentMetricsSummary;
}

export function fetchStudentMetricsSummary(): Promise<SummaryResponse> {
  return request("/api/student-metrics/summary");
}

export interface PatternsResponse {
  ok: true;
  available?: boolean;
  message?: string;
  patterns?: PatternMetricSummary[];
}

export function fetchPatternMetrics(): Promise<PatternsResponse> {
  return request("/api/student-metrics/patterns");
}

export interface PatternDetailResponse {
  ok: true;
  available?: boolean;
  message?: string;
  pattern?: PatternMetricDetail;
}

export function fetchPatternMetricDetail(slug: string): Promise<PatternDetailResponse> {
  return request(`/api/student-metrics/patterns/${encodeURIComponent(slug)}`);
}

export interface ActivityResponse {
  ok: true;
  available?: boolean;
  message?: string;
  activity?: ActivityItem[];
}

export function fetchRecentActivity(): Promise<ActivityResponse> {
  return request("/api/student-metrics/activity");
}
