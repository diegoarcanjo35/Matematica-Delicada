/* Cliente da API administrativa — Sprint 15 v1.0. Mesmo padrão de
   src/api/teacherClient.ts: fetch tipado, credenciais incluídas, erro
   traduzido para uma classe com code/status. */

export interface ApiFieldError {
  code: string;
  message: string;
}

export class AdminApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(apiError: ApiFieldError, status: number) {
    super(apiError.message);
    this.status = status;
    this.code = apiError.code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, credentials: "include" });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const apiError: ApiFieldError = data?.error ?? { code: "unknown", message: "Erro inesperado." };
    throw new AdminApiError(apiError, response.status);
  }
  return data as T;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/* -------------------------------------------------------------------- */
/* Dashboard                                                              */
/* -------------------------------------------------------------------- */

export interface AdminDashboard {
  totalUsers: number;
  usersByRole: Record<string, number>;
  usersWithoutRole: number;
  activeTeacherStudentBonds: number;
  inactiveTeacherStudentBonds: number;
}

export function fetchAdminDashboard(): Promise<{ ok: true; dashboard: AdminDashboard }> {
  return request("/api/admin/dashboard");
}

/* -------------------------------------------------------------------- */
/* Usuários                                                               */
/* -------------------------------------------------------------------- */

export interface AdminUserListItem {
  id: string;
  name: string;
  email: string;
  status: string;
  emailConfirmed: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  roles: string[];
}

export interface ListUsersParams {
  search?: string;
  role?: string;
  status?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
}

export interface ListUsersResponse {
  ok: true;
  users: AdminUserListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export function fetchAdminUsers(params: ListUsersParams): Promise<ListUsersResponse> {
  const query = new URLSearchParams();
  if (params.search) query.set("busca", params.search);
  if (params.role) query.set("papel", params.role);
  if (params.status) query.set("situacao", params.status);
  if (params.sort) query.set("ordenar", params.sort);
  if (params.page) query.set("pagina", String(params.page));
  if (params.pageSize) query.set("tamanho", String(params.pageSize));
  const qs = query.toString();
  return request(`/api/admin/users${qs ? `?${qs}` : ""}`);
}

export interface AdminUserDetail extends AdminUserListItem {
  activeTeacherBondsCount: number;
}

export function fetchAdminUserDetail(userId: string): Promise<{ ok: true; user: AdminUserDetail }> {
  return request(`/api/admin/users/${encodeURIComponent(userId)}`);
}

export const ASSIGNABLE_ROLES = ["student", "teacher", "editor", "admin", "support", "commercial"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export function assignAdminRole(userId: string, role: string, mutationId: string): Promise<{ ok: true; changed: boolean }> {
  return request(`/api/admin/users/${encodeURIComponent(userId)}/roles`, jsonInit("POST", { role, mutationId }));
}

export function removeAdminRole(userId: string, role: string, mutationId: string): Promise<{ ok: true; changed: boolean }> {
  return request(
    `/api/admin/users/${encodeURIComponent(userId)}/roles/${encodeURIComponent(role)}?mutationId=${encodeURIComponent(mutationId)}`,
    { method: "DELETE" }
  );
}

/* -------------------------------------------------------------------- */
/* Vínculos professor <-> aluno                                           */
/* -------------------------------------------------------------------- */

export interface AdminBond {
  id: string;
  teacherId: string;
  teacherName: string;
  studentId: string;
  studentName: string;
  status: "active" | "inactive";
  createdAt: string;
  updatedAt: string;
}

export interface ListBondsParams {
  search?: string;
  status?: "active" | "inactive";
  page?: number;
  pageSize?: number;
}

export interface ListBondsResponse {
  ok: true;
  bonds: AdminBond[];
  total: number;
  page: number;
  pageSize: number;
}

export function fetchAdminBonds(params: ListBondsParams): Promise<ListBondsResponse> {
  const query = new URLSearchParams();
  if (params.search) query.set("busca", params.search);
  if (params.status) query.set("situacao", params.status);
  if (params.page) query.set("pagina", String(params.page));
  if (params.pageSize) query.set("tamanho", String(params.pageSize));
  const qs = query.toString();
  return request(`/api/admin/teacher-student-links${qs ? `?${qs}` : ""}`);
}

export function createAdminBond(teacherId: string, studentId: string, mutationId: string): Promise<{ ok: true; changed: boolean; bondId: string | null }> {
  return request("/api/admin/teacher-student-links", jsonInit("POST", { teacherId, studentId, mutationId }));
}

function patchBond(bondId: string, action: "reactivate" | "deactivate", mutationId: string): Promise<{ ok: true; changed: boolean; bondId: string | null }> {
  return request(`/api/admin/teacher-student-links/${encodeURIComponent(bondId)}`, jsonInit("PATCH", { action, mutationId }));
}

export function reactivateAdminBond(bondId: string, mutationId: string): Promise<{ ok: true; changed: boolean; bondId: string | null }> {
  return patchBond(bondId, "reactivate", mutationId);
}

export function deactivateAdminBond(bondId: string, mutationId: string): Promise<{ ok: true; changed: boolean; bondId: string | null }> {
  return patchBond(bondId, "deactivate", mutationId);
}

/* -------------------------------------------------------------------- */
/* Diagnóstico — pipeline administrativo mínimo (Sprint 16 v1.2, seção 2)  */
/* -------------------------------------------------------------------- */

export interface DiagnosticAdminOption {
  text: string;
  isCorrect: boolean;
}

export interface DiagnosticAdminQuestion {
  id: string;
  prompt: string;
  position: number;
  options: DiagnosticAdminOption[];
  recognitionOptions: DiagnosticAdminOption[];
  helpLayers: Partial<Record<1 | 2 | 3 | 4, string>>;
  createdAt: string;
  updatedAt: string;
}

export function fetchAdminDiagnosticQuestions(): Promise<{ ok: true; questions: DiagnosticAdminQuestion[] }> {
  return request("/api/admin/diagnostic-questions");
}

export interface CreateDiagnosticQuestionInput {
  prompt: string;
  options: DiagnosticAdminOption[];
  recognitionOptions: DiagnosticAdminOption[];
  helpLayers: Partial<Record<1 | 2 | 3 | 4, string>>;
  mutationId: string;
}

export function createAdminDiagnosticQuestion(input: CreateDiagnosticQuestionInput): Promise<{ ok: true; changed: boolean; questionId: string }> {
  return request("/api/admin/diagnostic-questions", jsonInit("POST", input));
}

export function deleteAdminDiagnosticQuestion(questionId: string): Promise<{ ok: true; changed: boolean }> {
  return request(`/api/admin/diagnostic-questions/${encodeURIComponent(questionId)}`, { method: "DELETE" });
}

/* -------------------------------------------------------------------- */
/* Cronograma — pipeline administrativo mínimo (Sprint 16 v1.2, seção 3)   */
/* -------------------------------------------------------------------- */

export const SCHEDULE_ACTIVITY_TYPES = [
  "diagnostico",
  "reconhecimento",
  "estudo_de_padrao",
  "conteudo_de_base",
  "aula_video",
  "treino_de_questoes",
  "correcao_de_erro",
  "revisao_espacada",
  "lista_do_professor",
  "simulado",
  "live",
  "leitura_de_resumo",
] as const;
export const SCHEDULE_COMPLETION_MODES = ["manual", "automatic", "external_evidence"] as const;
export const SCHEDULE_ACTIVITY_ORIGINS = ["system", "teacher", "diagnostic", "review"] as const;

export interface ScheduleActivityAdmin {
  id: string;
  type: string;
  title: string;
  objective: string;
  estimatedMinutes: number;
  completionCriteria: string;
  explanation: string;
  completionMode: string;
  origin: string;
  resourceRef: string | null;
  dismissible: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleActivityInput {
  type: string;
  title: string;
  objective: string;
  estimatedMinutes: number;
  completionCriteria: string;
  explanation: string;
  completionMode: string;
  origin: string;
  resourceRef?: string | null;
  dismissible?: boolean;
  mutationId: string;
}

export function fetchAdminScheduleActivities(): Promise<{ ok: true; activities: ScheduleActivityAdmin[] }> {
  return request("/api/admin/schedule-activities");
}

export function createAdminScheduleActivity(input: ScheduleActivityInput): Promise<{ ok: true; changed: boolean; activityId: string }> {
  return request("/api/admin/schedule-activities", jsonInit("POST", input));
}

export function updateAdminScheduleActivity(activityId: string, input: ScheduleActivityInput): Promise<{ ok: true; changed: boolean }> {
  return request(`/api/admin/schedule-activities/${encodeURIComponent(activityId)}`, jsonInit("PATCH", input));
}

export function deleteAdminScheduleActivity(activityId: string): Promise<{ ok: true; changed: boolean }> {
  return request(`/api/admin/schedule-activities/${encodeURIComponent(activityId)}`, { method: "DELETE" });
}

/* -------------------------------------------------------------------- */
/* Padrões — superfície administrativa (Sprint 16 v1.2, seção 4)           */
/* -------------------------------------------------------------------- */

export interface PatternAttributeLists {
  frequentClues: string[];
  recurringPhrases: string[];
  recurringVisualElements: string[];
  alternativeStrategies: string[];
  requiredContents: string[];
  prerequisiteContents: string[];
  commonMistakes: string[];
  tags: string[];
}

export interface PatternAdmin {
  id: string;
  code: string;
  slug: string;
  name: string;
  recognitionPhrase: string;
  description: string;
  mainStrategy: string;
  introductoryExample: string;
  strategicSummary: string;
  editorialStatus: string;
  version: number;
  attributes: PatternAttributeLists;
  createdAt: string;
  updatedAt: string;
}

export interface PatternCoreInput {
  code: string;
  slug: string;
  name: string;
  recognitionPhrase: string;
  description: string;
  mainStrategy: string;
  introductoryExample: string;
  strategicSummary: string;
  attributes?: Partial<PatternAttributeLists>;
}

export function fetchAdminPatterns(): Promise<{ ok: true; patterns: PatternAdmin[] }> {
  return request("/api/admin/patterns");
}

export function createAdminPattern(input: PatternCoreInput & { mutationId: string }): Promise<{ ok: true; changed: boolean; patternId: string }> {
  return request("/api/admin/patterns", jsonInit("POST", input));
}

export function updateAdminPattern(
  patternId: string,
  input: PatternCoreInput & { expectedVersion: number; mutationId: string }
): Promise<{ ok: true; changed: boolean }> {
  return request(`/api/admin/patterns/${encodeURIComponent(patternId)}`, jsonInit("PATCH", input));
}

export function transitionAdminPatternStatus(
  patternId: string,
  action: "publish" | "inactivate",
  expectedVersion: number,
  mutationId: string
): Promise<{ ok: true; changed: boolean }> {
  return request(`/api/admin/patterns/${encodeURIComponent(patternId)}/status`, jsonInit("PATCH", { action, expectedVersion, mutationId }));
}
