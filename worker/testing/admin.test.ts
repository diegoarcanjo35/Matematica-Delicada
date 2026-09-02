// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "./fakeD1";
import {
  FIXTURE_ADMIN,
  FIXTURE_ADMIN_2,
  FIXTURE_PLAIN_USER,
  FIXTURE_STUDENT,
  FIXTURE_STUDENT_2,
  FIXTURE_TEACHER,
  FIXTURE_TEACHER_2,
  seedAdminRole,
  seedFullAdminScenario,
  seedTeacherRoleForAdmin,
} from "./adminFixtures";
import { createUser } from "../src/repositories/userRepository";
import { createSession } from "../src/repositories/sessionRepository";
import { sha256Hex, hashPassword } from "../src/lib/crypto";
import type { Env } from "../src/env";
import { handleAdminRequest } from "../src/routes/admin";

/* Sprint 15 v1.0 — Administração Essencial (worker/src/routes/admin.ts).
   Mesma convenção de worker/testing/teacher.test.ts: SQLite real por trás
   do FakeD1Database, rotas reais chamadas diretamente (nunca miniflare),
   prova de "GET nunca escreve" por contagem de linhas ANTES/DEPOIS, prova
   de idempotência/concorrência por chamadas reais repetidas/paralelas
   contra o mesmo FakeD1Database (nunca só inspecionando o código). */

let db: FakeD1Database;

beforeEach(() => {
  db = new FakeD1Database();
  seedFullAdminScenario(db.sqlite);
});

async function sessionFor(userId: string): Promise<string> {
  const rawToken = `session-token-${userId}`;
  await createSession(db as never, {
    id: `${userId}-session`,
    userId,
    tokenHash: await sha256Hex(rawToken),
    sessionVersion: 1,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    userAgent: null,
  });
  return rawToken;
}

async function seedPlainStudent(id: string): Promise<string> {
  await createUser(db as never, {
    id,
    name: "Aluno Comum",
    email: `${id}@teste.dev`,
    emailNormalized: `${id}@teste.dev`,
    passwordHash: await hashPassword("senha-original-123"),
  });
  return sessionFor(id);
}

const LOCAL_ORIGIN = "http://localhost:8793";

function localEnv(): Env {
  return { DB: db as never, ASSETS: {} as never, ENVIRONMENT: "development" };
}

function requestWithCookie(path: string, token: string | null, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (token) headers.set("Cookie", `md_session=${token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  return new Request(`${LOCAL_ORIGIN}${path}`, { ...init, headers });
}

async function callAdminRoute(path: string, token: string | null, init: RequestInit = {}): Promise<Response> {
  const request = requestWithCookie(path, token, init);
  const url = new URL(request.url);
  return (await handleAdminRequest(request, localEnv(), url))!;
}

function postJson(path: string, token: string | null, body: unknown): Promise<Response> {
  return callAdminRoute(path, token, { method: "POST", body: JSON.stringify(body) });
}

function patchJson(path: string, token: string | null, body: unknown): Promise<Response> {
  return callAdminRoute(path, token, { method: "PATCH", body: JSON.stringify(body) });
}

function countRows(table: string): number {
  return (db.sqlite.prepare(`SELECT COUNT(*) as total FROM ${table}`).get() as { total: number }).total;
}

const WRITE_SENSITIVE_TABLES = ["user_roles", "teacher_student_access", "audit_log", "users", "sessions"];

function snapshotCounts(): Record<string, number> {
  const snapshot: Record<string, number> = {};
  for (const table of WRITE_SENSITIVE_TABLES) snapshot[table] = countRows(table);
  return snapshot;
}

function newMutationId(): string {
  return crypto.randomUUID();
}

describe("Autorização (ordem seção 5/18)", () => {
  it("sem sessão nenhuma, /api/admin/dashboard responde 401", async () => {
    const response = await callAdminRoute("/api/admin/dashboard", null);
    expect(response.status).toBe(401);
  });

  it("aluno comum (autenticado, sem papel admin) recebe 403 em /dashboard", async () => {
    const token = await seedPlainStudent("aluno-comum-admin-1");
    const response = await callAdminRoute("/api/admin/dashboard", token);
    expect(response.status).toBe(403);
  });

  it("professor (autenticado, sem papel admin) recebe 403 em /users", async () => {
    const token = await sessionFor(FIXTURE_TEACHER);
    const response = await callAdminRoute("/api/admin/users", token);
    expect(response.status).toBe(403);
  });

  it("admin autorizado: /dashboard responde 200", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const response = await callAdminRoute("/api/admin/dashboard", token);
    expect(response.status).toBe(200);
  });

  it("método não permitido (POST) em /api/admin/dashboard responde 405", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const response = await postJson("/api/admin/dashboard", token, {});
    expect(response.status).toBe(405);
  });

  it("erros nunca vazam SQL ou stack trace", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const response = await callAdminRoute("/api/admin/users/id-inexistente", token);
    const body = await response.text();
    expect(body.toLowerCase()).not.toContain("select");
    expect(body.toLowerCase()).not.toContain("sqlite");
    expect(body).not.toContain(".ts:");
  });
});

describe("Dashboard (ordem seção 9)", () => {
  it("contagens factuais refletem o cenário semeado", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const response = await callAdminRoute("/api/admin/dashboard", token);
    const body = (await response.json()) as {
      dashboard: { totalUsers: number; usersByRole: Record<string, number>; activeTeacherStudentBonds: number; inactiveTeacherStudentBonds: number };
    };
    expect(body.dashboard.totalUsers).toBe(7);
    expect(body.dashboard.usersByRole.admin).toBe(1);
    expect(body.dashboard.usersByRole.teacher).toBe(1);
    expect(body.dashboard.activeTeacherStudentBonds).toBe(1);
    expect(body.dashboard.inactiveTeacherStudentBonds).toBe(1);
  });

  it("GET /dashboard nunca escreve nenhuma linha", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const before = snapshotCounts();
    await callAdminRoute("/api/admin/dashboard", token);
    expect(snapshotCounts()).toEqual(before);
  });
});

describe("Listagem de usuários (ordem seção 10)", () => {
  it("busca por nome filtra corretamente", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const response = await callAdminRoute(`/api/admin/users?busca=${encodeURIComponent("Professor 1")}`, token);
    const body = (await response.json()) as { users: Array<{ id: string }>; total: number };
    expect(body.users.map((u) => u.id)).toEqual([FIXTURE_TEACHER]);
    expect(body.total).toBe(1);
  });

  it("filtro por papel retorna só usuários com aquele papel", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const response = await callAdminRoute("/api/admin/users?papel=teacher", token);
    const body = (await response.json()) as { users: Array<{ id: string }> };
    expect(body.users.map((u) => u.id)).toEqual([FIXTURE_TEACHER]);
  });

  it("paginação: tamanho=2 retorna 2 itens por página, total reflete todos os usuários", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const response = await callAdminRoute("/api/admin/users?tamanho=2&pagina=1", token);
    const body = (await response.json()) as { users: unknown[]; total: number; pageSize: number };
    expect(body.users.length).toBe(2);
    expect(body.total).toBe(7);
    expect(body.pageSize).toBe(2);
  });

  it("paginação abusiva (página muito alta) retorna lista vazia, nunca erro", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const response = await callAdminRoute("/api/admin/users?pagina=999999", token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { users: unknown[] };
    expect(body.users).toEqual([]);
  });

  it("filtro/ordenação inválidos nunca quebram a rota (caem no padrão)", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const response = await callAdminRoute("/api/admin/users?papel=algo-invalido&ordenar=algo-invalido", token);
    expect(response.status).toBe(200);
  });

  it("projeção da listagem nunca inclui password_hash/token/sessão", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const response = await callAdminRoute("/api/admin/users", token);
    const rawBody = await response.text();
    expect(rawBody.toLowerCase()).not.toContain("password_hash");
    expect(rawBody).not.toContain("session-token-");
  });
});

describe("Detalhe do usuário (ordem seção 11)", () => {
  it("usuário existente: 200 com papéis", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const response = await callAdminRoute(`/api/admin/users/${FIXTURE_TEACHER}`, token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { user: { roles: string[]; activeTeacherBondsCount: number } };
    expect(body.user.roles).toEqual(["teacher"]);
    expect(body.user.activeTeacherBondsCount).toBe(1);
  });

  it("usuário inexistente: 404", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const response = await callAdminRoute("/api/admin/users/id-inexistente", token);
    expect(response.status).toBe(404);
  });

  it("aluno comum tentando abrir detalhe de usuário recebe 403 (nunca vê dados alheios)", async () => {
    const token = await seedPlainStudent("aluno-comum-admin-2");
    const response = await callAdminRoute(`/api/admin/users/${FIXTURE_TEACHER}`, token);
    expect(response.status).toBe(403);
  });
});

describe("Mutação de papéis (ordem seção 12)", () => {
  it("atribuir um papel válido: 200, changed=true, auditoria criada", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const mutationId = newMutationId();
    const response = await postJson(`/api/admin/users/${FIXTURE_PLAIN_USER}/roles`, token, { role: "editor", mutationId });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { changed: boolean };
    expect(body.changed).toBe(true);
    const audit = db.sqlite.prepare(`SELECT * FROM audit_log WHERE id = ?`).get(mutationId) as { event_type: string } | undefined;
    expect(audit?.event_type).toBe("admin_role_assigned");
  });

  it("atribuir role arbitrária/inválida é rejeitado (400), nenhuma linha criada", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const before = snapshotCounts();
    const response = await postJson(`/api/admin/users/${FIXTURE_PLAIN_USER}/roles`, token, { role: "super_admin", mutationId: newMutationId() });
    expect(response.status).toBe(400);
    expect(snapshotCounts()).toEqual(before);
  });

  it("atribuir papel a usuário inexistente: 404", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const response = await postJson(`/api/admin/users/id-inexistente/roles`, token, { role: "editor", mutationId: newMutationId() });
    expect(response.status).toBe(404);
  });

  it("atribuir um papel já concedido é idempotente: changed=false, nenhuma auditoria nova", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const before = countRows("audit_log");
    const response = await postJson(`/api/admin/users/${FIXTURE_TEACHER}/roles`, token, { role: "teacher", mutationId: newMutationId() });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { changed: boolean };
    expect(body.changed).toBe(false);
    expect(countRows("audit_log")).toBe(before);
  });

  it("retry com o MESMO mutationId não duplica auditoria", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const mutationId = newMutationId();
    const first = await postJson(`/api/admin/users/${FIXTURE_PLAIN_USER}/roles`, token, { role: "support", mutationId });
    expect(first.status).toBe(200);
    const afterFirst = countRows("audit_log");
    // Uma segunda tentativa com o MESMO mutationId, depois que o papel já
    // foi concedido — o INSERT OR IGNORE do grant afeta 0 linhas, então o
    // serviço nunca chega a tentar inserir auditoria de novo.
    const second = await postJson(`/api/admin/users/${FIXTURE_PLAIN_USER}/roles`, token, { role: "support", mutationId });
    expect(second.status).toBe(200);
    expect(countRows("audit_log")).toBe(afterFirst);
  });

  it("concorrência: duas atribuições simultâneas do MESMO papel ao MESMO usuário produzem só 1 auditoria real", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const [r1, r2] = await Promise.all([
      postJson(`/api/admin/users/${FIXTURE_PLAIN_USER}/roles`, token, { role: "commercial", mutationId: newMutationId() }),
      postJson(`/api/admin/users/${FIXTURE_PLAIN_USER}/roles`, token, { role: "commercial", mutationId: newMutationId() }),
    ]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    const [b1, b2] = (await Promise.all([r1.json(), r2.json()])) as Array<{ changed: boolean }>;
    expect([b1.changed, b2.changed].filter(Boolean).length).toBe(1);
    const roleRow = db.sqlite.prepare(`SELECT id FROM roles WHERE name = 'commercial'`).get() as { id: string };
    const grants = db.sqlite.prepare(`SELECT COUNT(*) as total FROM user_roles WHERE user_id = ? AND role_id = ?`).get(FIXTURE_PLAIN_USER, roleRow.id) as {
      total: number;
    };
    expect(grants.total).toBe(1);
    const auditCount = db.sqlite.prepare(`SELECT COUNT(*) as total FROM audit_log WHERE event_type = 'admin_role_assigned'`).get() as { total: number };
    expect(auditCount.total).toBe(1);
  });

  it("remover um papel concedido: 200, changed=true", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const mutationId = newMutationId();
    const response = await callAdminRoute(`/api/admin/users/${FIXTURE_TEACHER}/roles/teacher?mutationId=${mutationId}`, token, { method: "DELETE" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { changed: boolean };
    expect(body.changed).toBe(true);
  });

  it("remover papel inexistente NÃO é reportado como alteração (changed=false)", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const response = await callAdminRoute(`/api/admin/users/${FIXTURE_PLAIN_USER}/roles/editor?mutationId=${newMutationId()}`, token, { method: "DELETE" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { changed: boolean };
    expect(body.changed).toBe(false);
  });

  it("proteção do último admin: remover admin do único administrador é recusada (409), papel permanece", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const response = await callAdminRoute(`/api/admin/users/${FIXTURE_ADMIN}/roles/admin?mutationId=${newMutationId()}`, token, { method: "DELETE" });
    expect(response.status).toBe(409);
    const stillAdmin = db.sqlite.prepare(`SELECT COUNT(*) as total FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.name = 'admin'`).get() as {
      total: number;
    };
    expect(stillAdmin.total).toBe(1);
  });

  it("remover admin de UM entre DOIS admins é permitido", async () => {
    seedAdminRole(db.sqlite, FIXTURE_ADMIN_2);
    const token = await sessionFor(FIXTURE_ADMIN);
    const response = await callAdminRoute(`/api/admin/users/${FIXTURE_ADMIN_2}/roles/admin?mutationId=${newMutationId()}`, token, { method: "DELETE" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { changed: boolean };
    expect(body.changed).toBe(true);
  });

  it("aluno comum não consegue se autopromover (403 antes de tocar em qualquer lógica de mutação)", async () => {
    const token = await seedPlainStudent("aluno-comum-admin-3");
    const before = countRows("user_roles");
    const response = await postJson(`/api/admin/users/aluno-comum-admin-3/roles`, token, { role: "admin", mutationId: newMutationId() });
    expect(response.status).toBe(403);
    expect(countRows("user_roles")).toBe(before);
  });

  it("professor não consegue conceder papéis (403 — RBAC exige admin, não teacher)", async () => {
    const token = await sessionFor(FIXTURE_TEACHER);
    const response = await postJson(`/api/admin/users/${FIXTURE_PLAIN_USER}/roles`, token, { role: "editor", mutationId: newMutationId() });
    expect(response.status).toBe(403);
  });
});

describe("Gestão de vínculos professor <-> aluno (ordem seção 13)", () => {
  it("criar vínculo novo: 201-like ok, changed=true, auditoria criada", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    seedTeacherRoleForAdmin(db.sqlite, FIXTURE_TEACHER_2);
    const mutationId = newMutationId();
    const response = await postJson("/api/admin/teacher-student-links", token, { teacherId: FIXTURE_TEACHER_2, studentId: FIXTURE_STUDENT, mutationId });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { changed: boolean; bondId: string };
    expect(body.changed).toBe(true);
    const audit = db.sqlite.prepare(`SELECT event_type FROM audit_log WHERE id = ?`).get(mutationId) as { event_type: string };
    expect(audit.event_type).toBe("admin_teacher_student_link_created");
  });

  it("professor == aluno é rejeitado (400)", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const response = await postJson("/api/admin/teacher-student-links", token, { teacherId: FIXTURE_TEACHER, studentId: FIXTURE_TEACHER, mutationId: newMutationId() });
    expect(response.status).toBe(400);
  });

  it("professor sem papel teacher é rejeitado (400)", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const response = await postJson("/api/admin/teacher-student-links", token, { teacherId: FIXTURE_PLAIN_USER, studentId: FIXTURE_STUDENT, mutationId: newMutationId() });
    expect(response.status).toBe(400);
  });

  it("aluno inexistente é rejeitado (400)", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const response = await postJson("/api/admin/teacher-student-links", token, { teacherId: FIXTURE_TEACHER, studentId: "id-inexistente", mutationId: newMutationId() });
    expect(response.status).toBe(400);
  });

  it("criar vínculo duplicado (par já ATIVO) é rejeitado, nunca cria segunda linha", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const before = countRows("teacher_student_access");
    const response = await postJson("/api/admin/teacher-student-links", token, { teacherId: FIXTURE_TEACHER, studentId: FIXTURE_STUDENT, mutationId: newMutationId() });
    expect(response.status).toBe(400);
    expect(countRows("teacher_student_access")).toBe(before);
  });

  it("criar vínculo para um par já existente INATIVO orienta a usar reativação, nunca cria segunda linha", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const before = countRows("teacher_student_access");
    const response = await postJson("/api/admin/teacher-student-links", token, { teacherId: FIXTURE_TEACHER, studentId: FIXTURE_STUDENT_2, mutationId: newMutationId() });
    expect(response.status).toBe(400);
    expect(countRows("teacher_student_access")).toBe(before);
  });

  it("reativar vínculo inativo: UPDATE na mesma linha, nunca uma segunda linha", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const before = countRows("teacher_student_access");
    const response = await patchJson("/api/admin/teacher-student-links/fixture-admin-bond-2", token, { action: "reactivate", mutationId: newMutationId() });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { changed: boolean };
    expect(body.changed).toBe(true);
    expect(countRows("teacher_student_access")).toBe(before);
    const row = db.sqlite.prepare(`SELECT status FROM teacher_student_access WHERE id = 'fixture-admin-bond-2'`).get() as { status: string };
    expect(row.status).toBe("active");
  });

  it("reativar vínculo JÁ ativo é idempotente (changed=false)", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const response = await patchJson("/api/admin/teacher-student-links/fixture-admin-bond-1", token, { action: "reactivate", mutationId: newMutationId() });
    const body = (await response.json()) as { changed: boolean };
    expect(body.changed).toBe(false);
  });

  it("inativar vínculo ativo: changed=true, auditoria criada", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const mutationId = newMutationId();
    const response = await patchJson("/api/admin/teacher-student-links/fixture-admin-bond-1", token, { action: "deactivate", mutationId });
    expect(response.status).toBe(200);
    const audit = db.sqlite.prepare(`SELECT event_type FROM audit_log WHERE id = ?`).get(mutationId) as { event_type: string };
    expect(audit.event_type).toBe("admin_teacher_student_link_deactivated");
  });

  it("vínculo inexistente: 404", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const response = await patchJson("/api/admin/teacher-student-links/id-inexistente", token, { action: "deactivate", mutationId: newMutationId() });
    expect(response.status).toBe(404);
  });

  it("retry da mesma inativação com o MESMO mutationId não duplica auditoria", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const mutationId = newMutationId();
    await patchJson("/api/admin/teacher-student-links/fixture-admin-bond-1", token, { action: "deactivate", mutationId });
    const afterFirst = countRows("audit_log");
    const second = await patchJson("/api/admin/teacher-student-links/fixture-admin-bond-1", token, { action: "deactivate", mutationId });
    expect(second.status).toBe(200);
    expect(countRows("audit_log")).toBe(afterFirst);
  });

  it("listagem de vínculos: busca por nome do professor/aluno filtra corretamente", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const response = await callAdminRoute(`/api/admin/teacher-student-links?busca=${encodeURIComponent("Aluno 1")}`, token);
    const body = (await response.json()) as { bonds: Array<{ studentId: string }> };
    expect(body.bonds.some((b) => b.studentId === FIXTURE_STUDENT)).toBe(true);
  });

  it("isolamento: nenhuma rota admin escreve em GET", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const before = snapshotCounts();
    await callAdminRoute("/api/admin/users", token);
    await callAdminRoute(`/api/admin/users/${FIXTURE_TEACHER}`, token);
    await callAdminRoute("/api/admin/teacher-student-links", token);
    expect(snapshotCounts()).toEqual(before);
  });
});
