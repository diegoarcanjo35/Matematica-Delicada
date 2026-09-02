import type { Env } from "../env";
import { Errors, json, readJsonBody } from "../lib/response";
import { readSessionToken } from "../lib/cookies";
import { checkSession } from "../services/authService";
import {
  assignRole,
  createBond,
  deactivateBond,
  getDashboard,
  getUserDetail,
  listBonds,
  listUsers,
  reactivateBond,
  removeRole,
} from "../services/adminService";

/* Rotas da área administrativa — Sprint 15 v1.0, seção 14 da ordem.

   Autorização (ordem seção 5), SEMPRE nesta ordem, em TODA rota abaixo:
     1) sessão válida (401 se ausente/inválida — nunca 403, evita confundir
        "sem sessão" com "sem permissão", mesmo padrão de
        worker/src/routes/teacher.ts);
     2) papel `admin` (403 se autenticado mas sem o papel — TODAS as rotas
        admin são "de área", sem recurso alheio específico para 404, mesmo
        raciocínio de /api/teacher/dashboard e /api/teacher/students).
   `adminId` vem SEMPRE da sessão validada pelo cookie HttpOnly — NUNCA de
   um campo do corpo/query (ordem seção 5: "nunca aceitar... identidade
   administrativa enviada pelo cliente"). */

async function requireUser(request: Request, env: Env): Promise<{ id: string } | null> {
  const token = readSessionToken(request);
  if (!token) return null;
  const result = await checkSession(env.DB, token);
  if (!result.ok || !result.user) return null;
  return { id: result.user.id };
}

const USER_DETAIL_RE = /^\/api\/admin\/users\/([^/]+)$/;
const USER_ROLES_RE = /^\/api\/admin\/users\/([^/]+)\/roles$/;
const USER_ROLE_REMOVE_RE = /^\/api\/admin\/users\/([^/]+)\/roles\/([^/]+)$/;
const BOND_DETAIL_RE = /^\/api\/admin\/teacher-student-links\/([^/]+)$/;

function forbiddenResponse() {
  return Errors.forbidden("Esta área é exclusiva de contas com papel de administrador.");
}

export async function handleAdminRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (!path.startsWith("/api/admin/")) return null;

  const method = request.method;
  const user = await requireUser(request, env);
  if (!user) return Errors.unauthorized();

  if (path === "/api/admin/dashboard") {
    if (method !== "GET") return Errors.methodNotAllowed();
    const result = await getDashboard(env.DB, user.id);
    if (!result.ok) return forbiddenResponse();
    return json({ ok: true, dashboard: result.dashboard });
  }

  if (path === "/api/admin/users") {
    if (method !== "GET") return Errors.methodNotAllowed();
    const result = await listUsers(env.DB, user.id, {
      search: url.searchParams.get("busca"),
      role: url.searchParams.get("papel"),
      status: url.searchParams.get("situacao"),
      sort: url.searchParams.get("ordenar"),
      page: parsePositiveIntOrNull(url.searchParams.get("pagina")),
      pageSize: parsePositiveIntOrNull(url.searchParams.get("tamanho")),
    });
    if (!result.ok) return forbiddenResponse();
    return json({ ok: true, users: result.users, total: result.total, page: result.page, pageSize: result.pageSize });
  }

  const roleRemoveMatch = path.match(USER_ROLE_REMOVE_RE);
  if (roleRemoveMatch) {
    if (method !== "DELETE") return Errors.methodNotAllowed();
    const targetUserId = decodeURIComponent(roleRemoveMatch[1]);
    const role = decodeURIComponent(roleRemoveMatch[2]);
    const mutationId = url.searchParams.get("mutationId");
    if (!mutationId) return Errors.badRequest("mutationId é obrigatório.");
    const result = await removeRole(env.DB, user.id, targetUserId, role, mutationId);
    return respondRoleMutation(result);
  }

  const rolesMatch = path.match(USER_ROLES_RE);
  if (rolesMatch) {
    if (method !== "POST") return Errors.methodNotAllowed();
    const targetUserId = decodeURIComponent(rolesMatch[1]);
    const body = await readJsonBody<{ role?: unknown; mutationId?: unknown }>(request);
    if (!body || typeof body.mutationId !== "string") return Errors.badRequest("Corpo inválido.");
    const result = await assignRole(env.DB, user.id, targetUserId, body.role, body.mutationId);
    return respondRoleMutation(result);
  }

  const userDetailMatch = path.match(USER_DETAIL_RE);
  if (userDetailMatch) {
    if (method !== "GET") return Errors.methodNotAllowed();
    const targetUserId = decodeURIComponent(userDetailMatch[1]);
    const result = await getUserDetail(env.DB, user.id, targetUserId);
    if (!result.ok) return "forbidden" in result ? forbiddenResponse() : Errors.notFound("Usuário não encontrado.");
    return json({ ok: true, user: result.user });
  }

  if (path === "/api/admin/teacher-student-links") {
    if (method === "GET") {
      const result = await listBonds(env.DB, user.id, {
        search: url.searchParams.get("busca"),
        status: url.searchParams.get("situacao"),
        page: parsePositiveIntOrNull(url.searchParams.get("pagina")),
        pageSize: parsePositiveIntOrNull(url.searchParams.get("tamanho")),
      });
      if (!result.ok) return forbiddenResponse();
      return json({ ok: true, bonds: result.bonds, total: result.total, page: result.page, pageSize: result.pageSize });
    }
    if (method === "POST") {
      const body = await readJsonBody<{ teacherId?: unknown; studentId?: unknown; mutationId?: unknown }>(request);
      if (!body || typeof body.mutationId !== "string") return Errors.badRequest("Corpo inválido.");
      const result = await createBond(env.DB, user.id, body.teacherId, body.studentId, body.mutationId);
      return respondBondMutation(result);
    }
    return Errors.methodNotAllowed();
  }

  const bondDetailMatch = path.match(BOND_DETAIL_RE);
  if (bondDetailMatch) {
    if (method !== "PATCH") return Errors.methodNotAllowed();
    const bondId = decodeURIComponent(bondDetailMatch[1]);
    const body = await readJsonBody<{ action?: unknown; mutationId?: unknown }>(request);
    if (!body || typeof body.mutationId !== "string") return Errors.badRequest("Corpo inválido.");
    if (body.action !== "reactivate" && body.action !== "deactivate") {
      return Errors.badRequest("action deve ser 'reactivate' ou 'deactivate'.");
    }
    const result =
      body.action === "reactivate"
        ? await reactivateBond(env.DB, user.id, bondId, body.mutationId)
        : await deactivateBond(env.DB, user.id, bondId, body.mutationId);
    return respondBondMutation(result);
  }

  return null;
}

function respondRoleMutation(result: Awaited<ReturnType<typeof assignRole>>): Response {
  if (result.ok) return json({ ok: true, changed: result.changed });
  if ("forbidden" in result) return forbiddenResponse();
  if ("notFound" in result) return Errors.notFound("Usuário não encontrado.");
  if ("lastAdmin" in result) return Errors.conflict("Não é possível remover o papel admin do último administrador ativo.");
  return Errors.badRequest(Object.values(result.fieldErrors)[0] ?? "Requisição inválida.");
}

function respondBondMutation(result: Awaited<ReturnType<typeof createBond>>): Response {
  if (result.ok) return json({ ok: true, changed: result.changed, bondId: result.bondId ?? null });
  if ("forbidden" in result) return forbiddenResponse();
  if ("notFound" in result) return Errors.notFound("Vínculo não encontrado.");
  return Errors.badRequest(Object.values(result.fieldErrors)[0] ?? "Requisição inválida.");
}

function parsePositiveIntOrNull(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}
