/* Cliente da API do Painel do Professor — Sprint 14 v1.0. Mesmo padrão de
   src/api/weeklyReviewClient.ts/editorialClient.ts: fetch tipado,
   credentials incluídas, erro traduzido para uma classe com code/status.
   Todas as chamadas aqui são GET — nenhuma mutação nesta sprint (ordem
   seção 14). */

export interface ApiFieldError {
  code: string;
  message: string;
}

export class TeacherApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(apiError: ApiFieldError, status: number) {
    super(apiError.message);
    this.status = status;
    this.code = apiError.code;
  }
}

async function request<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "include" });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const apiError: ApiFieldError = data?.error ?? { code: "unknown", message: "Erro inesperado." };
    throw new TeacherApiError(apiError, response.status);
  }
  return data as T;
}

/* -------------------------------------------------------------------- */
/* Dashboard                                                              */
/* -------------------------------------------------------------------- */

export type AttentionReasonCode =
  | "revisao_vencida"
  | "sem_atividade_recente"
  | "meta_ativa_sem_evidencia_recente"
  | "caderno_pendente";

export interface AttentionItem {
  studentId: string;
  studentName: string;
  reasons: AttentionReasonCode[];
  reasonLabels: string[];
}

export interface TeacherDashboard {
  recentActivityWindowDays: number;
  linkedStudents: {
    activeCount: number;
    withRecentEvidenceCount: number;
    withoutRecentEvidenceCount: number;
  };
  attention: AttentionItem[];
}

export function fetchTeacherDashboard(): Promise<{ ok: true; dashboard: TeacherDashboard }> {
  return request("/api/teacher/dashboard");
}

/* -------------------------------------------------------------------- */
/* Lista de alunos                                                        */
/* -------------------------------------------------------------------- */

export interface TeacherStudentListItem {
  studentId: string;
  studentName: string;
  currentGrade: string | null;
  lastActivityAt: string | null;
  hasRecentActivity: boolean;
  confirmedQuestionsRecent: number;
  daysWithActivityRecent: number;
  overdueReviewsCount: number;
  hasActiveWeeklyGoal: boolean;
}

export interface ListStudentsParams {
  search?: string;
  filter?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
}

export interface ListStudentsResponse {
  ok: true;
  students: TeacherStudentListItem[];
  total: number;
  page: number;
  pageSize: number;
  recentActivityWindowDays: number;
}

export function fetchTeacherStudents(params: ListStudentsParams): Promise<ListStudentsResponse> {
  const query = new URLSearchParams();
  if (params.search) query.set("busca", params.search);
  if (params.filter) query.set("filtro", params.filter);
  if (params.sort) query.set("ordenar", params.sort);
  if (params.page) query.set("pagina", String(params.page));
  if (params.pageSize) query.set("tamanho", String(params.pageSize));
  const qs = query.toString();
  return request(`/api/teacher/students${qs ? `?${qs}` : ""}`);
}

/* -------------------------------------------------------------------- */
/* Acompanhamento individual                                              */
/* -------------------------------------------------------------------- */

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
  progress: GoalProgress;
}

export interface WeeklyReport {
  weekStart: string;
  weekEnd: string;
  isCurrentWeek: boolean;
  hasAnyEvidence: boolean;
  approxMinutes: number | null;
  confirmedQuestionsCount: number;
  correctCount: number;
  incorrectCount: number;
  patternsPracticed: string[];
  dailyTrainingItemsCompleted: number;
  simulationBlocksCompleted: number;
  reviewsCompletedCount: number;
  overdueReviewsAtWeekEnd: number | null;
  daysWithEvidenceCount: number;
  comparison: WeeklyComparison;
  goal: Goal | null;
}

export interface PatternMetricSummary {
  patternId: string;
  code: string;
  slug: string;
  name: string;
  state: "sem_evidencias" | "evidencias_iniciais" | "em_desenvolvimento" | "consistente_no_recorte" | "revisao_pendente";
  stateLabel: string;
  questionsConfirmed: number;
  correctCount: number;
  incorrectCount: number;
  lastPracticeAt: string | null;
  nextReviewAt: string | null;
  hasActiveErrorEntry: boolean;
}

export interface ErrorNotebookMetadata {
  activeCount: number;
  overdueCount: number;
  correctedCount: number;
  totalCount: number;
  countsByErrorType: Record<string, number>;
}

export interface TrainingToday {
  status: string;
  itemCount: number;
  completedCount: number;
  date: string;
}

export interface StudentDetail {
  student: { studentId: string; studentName: string; currentGrade: string | null };
  weeklyReview: WeeklyReport;
  patterns: PatternMetricSummary[];
  errorNotebook: ErrorNotebookMetadata;
  trainingToday: TrainingToday | null;
}

export function fetchTeacherStudentDetail(studentId: string): Promise<{ ok: true; detail: StudentDetail }> {
  return request(`/api/teacher/students/${encodeURIComponent(studentId)}`);
}
