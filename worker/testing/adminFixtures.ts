/* CONTEÚDO TÉCNICO PROVISÓRIO PARA TESTE — usado só por
   worker/testing/admin.test.ts e worker/testing/adminBootstrap.test.ts via
   FakeD1Database. Mesmo padrão de worker/testing/teacherFixtures.ts. */

export const FIXTURE_ADMIN = "fixture-admin-1";
export const FIXTURE_ADMIN_2 = "fixture-admin-2";
export const FIXTURE_TEACHER = "fixture-admin-teacher-1";
export const FIXTURE_TEACHER_2 = "fixture-admin-teacher-2";
export const FIXTURE_STUDENT = "fixture-admin-student-1";
export const FIXTURE_STUDENT_2 = "fixture-admin-student-2";
export const FIXTURE_PLAIN_USER = "fixture-admin-plain-1";

interface SqliteLike {
  prepare(sql: string): { run(...params: unknown[]): unknown };
}

function insertUser(sqlite: SqliteLike, id: string, name: string): void {
  sqlite
    .prepare(
      `INSERT INTO users (id, name, email, email_normalized, password_hash, status, email_confirmed_at)
       VALUES (?, ?, ?, ?, 'x', 'active', datetime('now'))`
    )
    .run(id, `[PROVISÓRIO] ${name}`, `${id}@local.teste`, `${id}@local.teste`);
}

function grantRole(sqlite: SqliteLike, roleId: string, roleName: string, userId: string, rowId: string): void {
  sqlite.prepare(`INSERT OR IGNORE INTO roles (id, name) VALUES (?, ?)`).run(roleId, roleName);
  sqlite.prepare(`INSERT OR IGNORE INTO user_roles (id, user_id, role_id, granted_by) VALUES (?, ?, ?, NULL)`).run(rowId, userId, roleId);
}

/** Semeia as sete contas de fixture (dois admins, dois professores, dois
 *  alunos, um usuário comum) — nunca os papéis/vínculos em si, que ficam a
 *  cargo das funções abaixo. */
export function seedAdminFixtureUsers(sqlite: SqliteLike): void {
  insertUser(sqlite, FIXTURE_ADMIN, "Admin 1 (Fixture Técnica)");
  insertUser(sqlite, FIXTURE_ADMIN_2, "Admin 2 (Fixture Técnica)");
  insertUser(sqlite, FIXTURE_TEACHER, "Professor 1 (Fixture Técnica)");
  insertUser(sqlite, FIXTURE_TEACHER_2, "Professor 2 (Fixture Técnica)");
  insertUser(sqlite, FIXTURE_STUDENT, "Aluno 1 (Fixture Técnica)");
  insertUser(sqlite, FIXTURE_STUDENT_2, "Aluno 2 (Fixture Técnica)");
  insertUser(sqlite, FIXTURE_PLAIN_USER, "Usuário Comum (Fixture Técnica)");
}

export function seedAdminRole(sqlite: SqliteLike, userId: string): void {
  grantRole(sqlite, "role-admin", "admin", userId, `fixture-user-role-admin-${userId}`);
}

export function seedTeacherRoleForAdmin(sqlite: SqliteLike, userId: string): void {
  grantRole(sqlite, "role-teacher", "teacher", userId, `fixture-user-role-teacher-${userId}`);
}

export function seedBondForAdmin(sqlite: SqliteLike, params: { id: string; teacherId: string; studentId: string; status: "active" | "inactive" }): void {
  sqlite
    .prepare(
      `INSERT INTO teacher_student_access (id, teacher_id, student_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
    )
    .run(params.id, params.teacherId, params.studentId, params.status);
}

/** Cenário completo padrão: FIXTURE_ADMIN é admin; FIXTURE_TEACHER tem
 *  papel teacher com um vínculo ativo (FIXTURE_STUDENT) e um inativo
 *  (FIXTURE_STUDENT_2); os demais usuários não têm nenhum papel. */
export function seedFullAdminScenario(sqlite: SqliteLike): void {
  seedAdminFixtureUsers(sqlite);
  seedAdminRole(sqlite, FIXTURE_ADMIN);
  seedTeacherRoleForAdmin(sqlite, FIXTURE_TEACHER);
  seedBondForAdmin(sqlite, { id: "fixture-admin-bond-1", teacherId: FIXTURE_TEACHER, studentId: FIXTURE_STUDENT, status: "active" });
  seedBondForAdmin(sqlite, { id: "fixture-admin-bond-2", teacherId: FIXTURE_TEACHER, studentId: FIXTURE_STUDENT_2, status: "inactive" });
}
