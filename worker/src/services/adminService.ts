/* Serviço da área administrativa — Sprint 15 v1.0, seções 9-13 da ordem.

   Autorização (ordem seção 5) SEMPRE nesta ordem, em toda função exportada:
   1) sessão válida (a rota já garante isso antes de chamar qualquer função
      aqui — ver worker/src/routes/admin.ts);
   2) papel `admin` da sessão (requireAdminRole, que consulta o banco pelo
      userId — NUNCA por um campo enviado pelo cliente).
   Nenhuma função aqui aceita um "role de quem chama" como parâmetro — o
   `adminId` é sempre usado só para (a) checar o papel e (b) registrar como
   ATOR na auditoria, nunca como fonte de verdade sobre permissão do alvo.

   Contrato de mutação (ordem seção 15) — DELIBERADAMENTE mais simples que o
   padrão "identidade completa por mutationId" de weeklyReviewService.ts/
   dailyTrainingService.ts: aquele padrão existe porque aquelas mutações têm
   CONTEÚDO variável (targetMinutes, patternIds...) que pode genuinamente
   conflitar entre duas tentativas diferentes. As mutações desta sprint são
   todas "alternar associação/status" (conceder ou não um papel; vínculo
   ativo ou não) — não há conteúdo que possa divergir entre duas tentativas
   do MESMO alvo. Por isso, aqui a idempotência real vem do próprio
   `meta.changes` da ÚNICA instrução SQL que muda o estado (INSERT OR IGNORE
   com id determinístico, ou UPDATE guardado por status): se `changes === 0`,
   NADA mudou nesta chamada (seja porque já estava nesse estado, seja porque
   outra chamada concorrente venceu a corrida — os dois casos são
   idempotentes por natureza aqui, nunca um conflito de conteúdo) e nenhuma
   auditoria é gravada; se `changes === 1`, uma mudança REAL aconteceu e o
   evento de auditoria é gravado imediatamente em seguida, com
   `id = mutationId` (dedup determinístico via PRIMARY KEY de audit_log).
   `mutationId` continua exigido no contrato (mesmo padrão de geração pelo
   cliente do resto do projeto) por consistência de API e como defesa em
   profundidade — documentado com mais detalhe em docs/ADMIN_ESSENCIAL.md. */

import { resolveAdminRole, resolveTeacherRole } from "../lib/rbac";
import {
  ADMIN_USERS_MAX_PAGE_SIZE,
  ADMIN_USERS_DEFAULT_PAGE_SIZE,
  DEFAULT_ADMIN_USER_SORT,
  isAdminUserSort,
  isAssignableRole,
  isValidRoleFilter,
  sanitizeSearchTerm,
  type AdminUserSort,
} from "../lib/adminValidation";
import { isValidMutationId } from "../lib/questionsValidation";
import {
  countBonds,
  countUsers,
  findBondByIdForAdmin,
  getDashboardCounts,
  getUserDetail as getUserDetailRow,
  listBonds as listBondsRepo,
  listUsers as listUsersRepo,
  type AdminBondRow,
  type AdminUserDetailRow,
  type AdminUserListRow,
  type ListBondsParams,
} from "../repositories/adminRepository";
import { findUserById } from "../repositories/userRepository";
import { buildCreateBondStatement, buildDeactivateBondStatement, buildReactivateBondStatement, findBond } from "../repositories/teacherRepository";
import { buildGrantRoleStatement, buildRemoveRoleStatement, ensureRoleExists, findRoleByName } from "../repositories/roleRepository";
import { buildAuditEventStatement } from "../repositories/auditRepository";
import type { Role } from "../lib/questionsValidation";

function newId(): string {
  return crypto.randomUUID();
}

export async function requireAdminRole(db: D1Database, userId: string): Promise<boolean> {
  return (await resolveAdminRole(db, userId)) === "admin";
}

/* ------------------------------------------------------------------------ */
/* Dashboard (ordem seção 9)                                                 */
/* ------------------------------------------------------------------------ */

export type DashboardResult =
  | { ok: true; dashboard: Awaited<ReturnType<typeof getDashboardCounts>> }
  | { ok: false; forbidden: true };

export async function getDashboard(db: D1Database, adminId: string): Promise<DashboardResult> {
  if (!(await requireAdminRole(db, adminId))) return { ok: false, forbidden: true };
  const dashboard = await getDashboardCounts(db);
  return { ok: true, dashboard };
}

/* ------------------------------------------------------------------------ */
/* Usuários — listagem e detalhe (ordem seção 10/11)                         */
/* ------------------------------------------------------------------------ */

export interface ListUsersInput {
  search?: string | null;
  role?: string | null;
  status?: string | null;
  sort?: string | null;
  page?: number | null;
  pageSize?: number | null;
}

export type ListUsersResult =
  | { ok: true; users: AdminUserListRow[]; total: number; page: number; pageSize: number }
  | { ok: false; forbidden: true };

export async function listUsers(db: D1Database, adminId: string, input: ListUsersInput): Promise<ListUsersResult> {
  if (!(await requireAdminRole(db, adminId))) return { ok: false, forbidden: true };

  const search = sanitizeSearchTerm(input.search ?? null);
  const roleFilter = input.role && isValidRoleFilter(input.role) ? input.role : null;
  const statusFilter = input.status && input.status.trim().length > 0 ? input.status.trim().slice(0, 40) : null;
  const sort: AdminUserSort = input.sort && isAdminUserSort(input.sort) ? input.sort : DEFAULT_ADMIN_USER_SORT;

  const pageSizeRaw = input.pageSize ?? ADMIN_USERS_DEFAULT_PAGE_SIZE;
  const pageSize = Number.isInteger(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(pageSizeRaw, ADMIN_USERS_MAX_PAGE_SIZE) : ADMIN_USERS_DEFAULT_PAGE_SIZE;
  const pageRaw = input.page ?? 1;
  // Teto defensivo contra paginação abusiva (ordem seção 18) — nunca erro, só uma página vazia.
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? Math.min(pageRaw, 100_000) : 1;

  const params = { search, roleFilter, statusFilter, sort, limit: pageSize, offset: (page - 1) * pageSize };
  const [users, total] = await Promise.all([listUsersRepo(db, params), countUsers(db, params)]);

  return { ok: true, users, total, page, pageSize };
}

export type UserDetailResult = { ok: true; user: AdminUserDetailRow } | { ok: false; forbidden: true } | { ok: false; notFound: true };

export async function getUserDetail(db: D1Database, adminId: string, targetUserId: string): Promise<UserDetailResult> {
  if (!(await requireAdminRole(db, adminId))) return { ok: false, forbidden: true };
  const user = await getUserDetailRow(db, targetUserId);
  if (!user) return { ok: false, notFound: true };
  return { ok: true, user };
}

/* ------------------------------------------------------------------------ */
/* Papéis — mutação (ordem seção 12)                                         */
/* ------------------------------------------------------------------------ */

export type RoleMutationResult =
  | { ok: true; changed: boolean }
  | { ok: false; forbidden: true }
  | { ok: false; notFound: true }
  | { ok: false; fieldErrors: Record<string, string> }
  | { ok: false; lastAdmin: true };

function isLastAdminProtectionViolation(error: unknown): boolean {
  return error instanceof Error && /não é possível remover o último administrador/.test(error.message);
}

export async function assignRole(
  db: D1Database,
  adminId: string,
  targetUserId: string,
  roleInput: unknown,
  mutationId: string
): Promise<RoleMutationResult> {
  if (!(await requireAdminRole(db, adminId))) return { ok: false, forbidden: true };
  if (!isValidMutationId(mutationId)) return { ok: false, fieldErrors: { mutationId: "Identificador de mutação inválido." } };
  if (!isAssignableRole(roleInput)) return { ok: false, fieldErrors: { role: "Papel inválido." } };
  const role = roleInput as Role;

  const targetUser = await findUserById(db, targetUserId);
  if (!targetUser) return { ok: false, notFound: true };

  await ensureRoleExists(db, `role-${role}`, role);
  const roleRow = await findRoleByName(db, role);
  if (!roleRow) return { ok: false, fieldErrors: { role: "Papel inválido." } };

  // Id determinístico por (usuário, papel) — a MESMA linha para qualquer
  // retry desta atribuição específica; INSERT OR IGNORE nunca lança em cima
  // de UNIQUE(user_id, role_id) nem do PRIMARY KEY determinístico.
  const grantResult = await buildGrantRoleStatement(db, {
    id: `user-role-${targetUserId}-${roleRow.id}`,
    userId: targetUserId,
    roleId: roleRow.id,
    grantedBy: adminId,
  }).run();

  if (grantResult.meta.changes !== 1) return { ok: true, changed: false };

  try {
    await buildAuditEventStatement(db, {
      id: mutationId,
      eventType: "admin_role_assigned",
      userId: adminId,
      metadata: { targetUserId, role },
    }).run();
  } catch (error) {
    // mutationId já usado por ESTE MESMO evento (retry legítimo) — a
    // concessão real já aconteceu (grantResult.meta.changes === 1 só ocorre
    // uma vez, na chamada original); um retry chegando aqui de novo teria
    // grantResult.meta.changes === 0 e nunca alcançaria este bloco. Este
    // catch só existe para o caso extremo de reuso indevido do mesmo
    // mutationId por DUAS operações diferentes — tratado como conflito.
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      return { ok: false, fieldErrors: { mutationId: "Identificador de mutação já utilizado por outra operação." } };
    }
    throw error;
  }

  return { ok: true, changed: true };
}

export async function removeRole(
  db: D1Database,
  adminId: string,
  targetUserId: string,
  roleInput: unknown,
  mutationId: string
): Promise<RoleMutationResult> {
  if (!(await requireAdminRole(db, adminId))) return { ok: false, forbidden: true };
  if (!isValidMutationId(mutationId)) return { ok: false, fieldErrors: { mutationId: "Identificador de mutação inválido." } };
  if (!isAssignableRole(roleInput)) return { ok: false, fieldErrors: { role: "Papel inválido." } };
  const role = roleInput as Role;

  const targetUser = await findUserById(db, targetUserId);
  if (!targetUser) return { ok: false, notFound: true };

  const roleRow = await findRoleByName(db, role);
  if (!roleRow) return { ok: true, changed: false }; // papel nunca concedido a ninguém ainda — nada a remover

  let removeResult;
  try {
    removeResult = await buildRemoveRoleStatement(db, { userId: targetUserId, roleId: roleRow.id }).run();
  } catch (error) {
    // Guarda de banco (migrations/0020, trg_user_roles_protect_last_admin) —
    // única forma imune a corrida real entre duas remoções concorrentes
    // (ordem seção 12: proteção contra remoção do último admin; ver
    // adminRepository.ts:countAdminRoleHolders para a definição de "ativo").
    if (isLastAdminProtectionViolation(error)) return { ok: false, lastAdmin: true };
    throw error;
  }

  if (removeResult.meta.changes !== 1) return { ok: true, changed: false }; // já não tinha o papel

  try {
    await buildAuditEventStatement(db, {
      id: mutationId,
      eventType: "admin_role_removed",
      userId: adminId,
      metadata: { targetUserId, role },
    }).run();
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      return { ok: false, fieldErrors: { mutationId: "Identificador de mutação já utilizado por outra operação." } };
    }
    throw error;
  }

  return { ok: true, changed: true };
}

/* ------------------------------------------------------------------------ */
/* Vínculos professor <-> aluno (ordem seção 13)                             */
/* ------------------------------------------------------------------------ */

export interface ListBondsInput {
  search?: string | null;
  status?: string | null; // 'active' | 'inactive' | ausente (todos)
  page?: number | null;
  pageSize?: number | null;
}

export type ListBondsResult = { ok: true; bonds: AdminBondRow[]; total: number; page: number; pageSize: number } | { ok: false; forbidden: true };

export async function listBonds(db: D1Database, adminId: string, input: ListBondsInput): Promise<ListBondsResult> {
  if (!(await requireAdminRole(db, adminId))) return { ok: false, forbidden: true };

  const search = sanitizeSearchTerm(input.search ?? null);
  const statusFilter: "active" | "inactive" | null = input.status === "active" ? "active" : input.status === "inactive" ? "inactive" : null;
  const pageSizeRaw = input.pageSize ?? ADMIN_USERS_DEFAULT_PAGE_SIZE;
  const pageSize = Number.isInteger(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(pageSizeRaw, ADMIN_USERS_MAX_PAGE_SIZE) : ADMIN_USERS_DEFAULT_PAGE_SIZE;
  const pageRaw = input.page ?? 1;
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? Math.min(pageRaw, 100_000) : 1;

  const params: ListBondsParams = { search, statusFilter, limit: pageSize, offset: (page - 1) * pageSize };
  const [bonds, total] = await Promise.all([listBondsRepo(db, params), countBonds(db, params)]);
  return { ok: true, bonds, total, page, pageSize };
}

export type BondMutationResult =
  | { ok: true; changed: boolean; bondId?: string }
  | { ok: false; forbidden: true }
  | { ok: false; notFound: true }
  | { ok: false; fieldErrors: Record<string, string> };

export async function createBond(
  db: D1Database,
  adminId: string,
  teacherIdInput: unknown,
  studentIdInput: unknown,
  mutationId: string
): Promise<BondMutationResult> {
  if (!(await requireAdminRole(db, adminId))) return { ok: false, forbidden: true };
  if (!isValidMutationId(mutationId)) return { ok: false, fieldErrors: { mutationId: "Identificador de mutação inválido." } };

  const teacherId = typeof teacherIdInput === "string" ? teacherIdInput : null;
  const studentId = typeof studentIdInput === "string" ? studentIdInput : null;
  if (!teacherId || !studentId) return { ok: false, fieldErrors: { teacherId: "Professor e aluno são obrigatórios." } };
  if (teacherId === studentId) return { ok: false, fieldErrors: { studentId: "Professor e aluno não podem ser a mesma conta." } };

  const [teacherUser, studentUser] = await Promise.all([findUserById(db, teacherId), findUserById(db, studentId)]);
  if (!teacherUser) return { ok: false, fieldErrors: { teacherId: "Professor não encontrado." } };
  if (!studentUser) return { ok: false, fieldErrors: { studentId: "Aluno não encontrado." } };

  const teacherRole = await resolveTeacherRole(db, teacherId);
  if (teacherRole !== "teacher") return { ok: false, fieldErrors: { teacherId: "A conta selecionada não tem papel de professor." } };

  const existing = await findBond(db, teacherId, studentId);
  if (existing) {
    return existing.status === "active"
      ? { ok: false, fieldErrors: { studentId: "Já existe um vínculo ativo para este par — nenhuma ação necessária." } }
      : { ok: false, fieldErrors: { studentId: "Já existe um vínculo inativo para este par — use reativar em vez de criar." } };
  }

  const bondId = newId();
  const nowIso = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  const createResult = await buildCreateBondStatement(db, { id: bondId, teacherId, studentId, status: "active", nowIso }).run();

  if (createResult.meta.changes !== 1) {
    // Corrida real perdida (outra requisição criou o mesmo par entre a checagem e este INSERT).
    const after = await findBond(db, teacherId, studentId);
    return after
      ? { ok: false, fieldErrors: { studentId: "Já existe um vínculo para este par — recarregue a página." } }
      : { ok: false, fieldErrors: { studentId: "Não foi possível criar o vínculo — tente novamente." } };
  }

  await buildAuditEventStatement(db, {
    id: mutationId,
    eventType: "admin_teacher_student_link_created",
    userId: adminId,
    metadata: { teacherId, studentId, bondId },
  }).run();

  return { ok: true, changed: true, bondId };
}

async function mutateBondStatus(
  db: D1Database,
  adminId: string,
  bondId: string,
  mutationId: string,
  direction: "reactivate" | "deactivate"
): Promise<BondMutationResult> {
  if (!(await requireAdminRole(db, adminId))) return { ok: false, forbidden: true };
  if (!isValidMutationId(mutationId)) return { ok: false, fieldErrors: { mutationId: "Identificador de mutação inválido." } };

  const bond = await findBondByIdForAdmin(db, bondId);
  if (!bond) return { ok: false, notFound: true };

  const targetStatus = direction === "reactivate" ? "active" : "inactive";
  if (bond.status === targetStatus) return { ok: true, changed: false };

  const nowIso = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  const statement = direction === "reactivate" ? buildReactivateBondStatement(db, { bondId, nowIso }) : buildDeactivateBondStatement(db, { bondId, nowIso });
  const result = await statement.run();

  if (result.meta.changes !== 1) {
    const after = await findBondByIdForAdmin(db, bondId);
    if (!after) return { ok: false, notFound: true };
    return { ok: true, changed: false }; // outra requisição já levou ao mesmo estado
  }

  await buildAuditEventStatement(db, {
    id: mutationId,
    eventType: direction === "reactivate" ? "admin_teacher_student_link_reactivated" : "admin_teacher_student_link_deactivated",
    userId: adminId,
    metadata: { bondId, teacherId: bond.teacherId, studentId: bond.studentId },
  }).run();

  return { ok: true, changed: true, bondId };
}

export function reactivateBond(db: D1Database, adminId: string, bondId: string, mutationId: string): Promise<BondMutationResult> {
  return mutateBondStatus(db, adminId, bondId, mutationId, "reactivate");
}

export function deactivateBond(db: D1Database, adminId: string, bondId: string, mutationId: string): Promise<BondMutationResult> {
  return mutateBondStatus(db, adminId, bondId, mutationId, "deactivate");
}
