/* CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR.
   Espelho, em TypeScript, do conteúdo conceitual de
   scripts/fixtures/teacher-fixtures.local.sql — usado só pelos testes
   unitários (worker/testing/*.test.ts) via FakeD1Database. Os dois arquivos
   precisam ser mantidos em sincronia manualmente ao alterar o conteúdo. */

export const FIXTURE_TEACHER_A = "fixture-teacher-a";
export const FIXTURE_TEACHER_B = "fixture-teacher-b";
export const FIXTURE_TEACHER_C_NO_STUDENTS = "fixture-teacher-c";
export const FIXTURE_STUDENT_1 = "fixture-student-1";
export const FIXTURE_STUDENT_2 = "fixture-student-2";
export const FIXTURE_STUDENT_3 = "fixture-student-3";
export const FIXTURE_STUDENT_4_NO_TEACHER = "fixture-student-4";

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

/** Semeia as sete contas de fixture (três professores, quatro alunos) —
 *  nunca os vínculos nem os papéis, que ficam a cargo de
 *  `seedTeacherRole`/`seedBond` abaixo, chamados explicitamente por cada
 *  teste conforme o cenário que precisa provar. */
export function seedTeacherFixtureUsers(sqlite: SqliteLike): void {
  insertUser(sqlite, FIXTURE_TEACHER_A, "Professora A (Fixture Técnica)");
  insertUser(sqlite, FIXTURE_TEACHER_B, "Professor B (Fixture Técnica)");
  insertUser(sqlite, FIXTURE_TEACHER_C_NO_STUDENTS, "Professora C, sem alunos (Fixture Técnica)");
  insertUser(sqlite, FIXTURE_STUDENT_1, "Aluno 1 (Fixture Técnica)");
  insertUser(sqlite, FIXTURE_STUDENT_2, "Aluna 2 (Fixture Técnica)");
  insertUser(sqlite, FIXTURE_STUDENT_3, "Aluno 3 (Fixture Técnica)");
  insertUser(sqlite, FIXTURE_STUDENT_4_NO_TEACHER, "Aluna 4, sem professor (Fixture Técnica)");
}

/** Concede o papel `teacher` (RBAC já existente, migrations/0008) a um
 *  usuário — idempotente (mesmo padrão de worker/src/routes/dev.ts). */
export function seedTeacherRole(sqlite: SqliteLike, userId: string): void {
  sqlite.prepare(`INSERT OR IGNORE INTO roles (id, name) VALUES ('role-teacher', 'teacher')`).run();
  sqlite
    .prepare(`INSERT OR IGNORE INTO user_roles (id, user_id, role_id, granted_by) VALUES (?, ?, 'role-teacher', NULL)`)
    .run(`fixture-user-role-${userId}`, userId);
}

export function seedBond(sqlite: SqliteLike, params: { id: string; teacherId: string; studentId: string; status: "active" | "inactive" }): void {
  sqlite
    .prepare(
      `INSERT INTO teacher_student_access (id, teacher_id, student_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
    )
    .run(params.id, params.teacherId, params.studentId, params.status);
}

/** Cenário completo do arquivo SQL real (ver cabeçalho de
 *  scripts/fixtures/teacher-fixtures.local.sql) — usado pelos testes que
 *  querem o mesmo estado de ponta a ponta sem repetir a montagem. */
export function seedFullTeacherScenario(sqlite: SqliteLike): void {
  seedTeacherFixtureUsers(sqlite);
  seedTeacherRole(sqlite, FIXTURE_TEACHER_A);
  seedTeacherRole(sqlite, FIXTURE_TEACHER_B);
  seedTeacherRole(sqlite, FIXTURE_TEACHER_C_NO_STUDENTS);
  seedBond(sqlite, { id: "fixture-bond-a-1", teacherId: FIXTURE_TEACHER_A, studentId: FIXTURE_STUDENT_1, status: "active" });
  seedBond(sqlite, { id: "fixture-bond-a-2", teacherId: FIXTURE_TEACHER_A, studentId: FIXTURE_STUDENT_2, status: "active" });
  seedBond(sqlite, { id: "fixture-bond-b-3", teacherId: FIXTURE_TEACHER_B, studentId: FIXTURE_STUDENT_3, status: "active" });
  seedBond(sqlite, { id: "fixture-bond-b-1-inactive", teacherId: FIXTURE_TEACHER_B, studentId: FIXTURE_STUDENT_1, status: "inactive" });
}
