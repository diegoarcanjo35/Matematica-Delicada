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
