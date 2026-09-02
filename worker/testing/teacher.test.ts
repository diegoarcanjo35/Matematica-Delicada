// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "./fakeD1";
import { seedQuestion } from "./questionFixtures";
import {
  FIXTURE_STUDENT_1,
  FIXTURE_STUDENT_2,
  FIXTURE_STUDENT_3,
  FIXTURE_STUDENT_4_NO_TEACHER,
  FIXTURE_TEACHER_A,
  FIXTURE_TEACHER_B,
  FIXTURE_TEACHER_C_NO_STUDENTS,
  seedBond,
  seedTeacherFixtureUsers,
  seedTeacherRole,
} from "./teacherFixtures";
import { createUser } from "../src/repositories/userRepository";
import { createSession } from "../src/repositories/sessionRepository";
import { sha256Hex, hashPassword } from "../src/lib/crypto";
import type { Env } from "../src/env";
import { handleTeacherRequest } from "../src/routes/teacher";

/* Sprint 14 v1.0 — Painel do Professor. Mesma convenção de
   worker/testing/errorNotebook.test.ts/weeklyReview.test.ts: SQLite real
   por trás do FakeD1Database, rotas reais chamadas diretamente (nunca
   miniflare), prova de "nenhum GET escreve" sempre por contagem de linhas
   ANTES/DEPOIS em cada tabela relevante — nunca só pela resposta HTTP. */

let db: FakeD1Database;

beforeEach(() => {
  db = new FakeD1Database();
  seedTeacherFixtureUsers(db.sqlite);
  seedTeacherRole(db.sqlite, FIXTURE_TEACHER_A);
  seedTeacherRole(db.sqlite, FIXTURE_TEACHER_B);
  seedTeacherRole(db.sqlite, FIXTURE_TEACHER_C_NO_STUDENTS);
  seedBond(db.sqlite, { id: "b-a-1", teacherId: FIXTURE_TEACHER_A, studentId: FIXTURE_STUDENT_1, status: "active" });
  seedBond(db.sqlite, { id: "b-a-2", teacherId: FIXTURE_TEACHER_A, studentId: FIXTURE_STUDENT_2, status: "active" });
  seedBond(db.sqlite, { id: "b-b-3", teacherId: FIXTURE_TEACHER_B, studentId: FIXTURE_STUDENT_3, status: "active" });
  seedBond(db.sqlite, { id: "b-b-1-inactive", teacherId: FIXTURE_TEACHER_B, studentId: FIXTURE_STUDENT_1, status: "inactive" });
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

function requestWithCookie(path: string, token: string | null): Request {
  const headers = new Headers();
  if (token) headers.set("Cookie", `md_session=${token}`);
  return new Request(`${LOCAL_ORIGIN}${path}`, { headers });
}

async function callTeacherRoute(path: string, token: string | null): Promise<Response> {
  const request = requestWithCookie(path, token);
  const url = new URL(request.url);
  return (await handleTeacherRequest(request, localEnv(), url))!;
}

function countRows(table: string): number {
  return (db.sqlite.prepare(`SELECT COUNT(*) as total FROM ${table}`).get() as { total: number }).total;
}

const WRITE_SENSITIVE_TABLES = [
  "teacher_student_access",
  "question_attempts",
  "weekly_study_goals",
  "weekly_goal_events",
  "error_notebook_entries",
  "error_review_events",
  "daily_training_lists",
  "audit_log",
  "sessions",
  "users",
];

function snapshotCounts(): Record<string, number> {
  const snapshot: Record<string, number> = {};
  for (const table of WRITE_SENSITIVE_TABLES) snapshot[table] = countRows(table);
  return snapshot;
}

/** Insere uma tentativa CONFIRMADA de questão para um aluno, direto no
 *  banco (nunca via HTTP — este arquivo testa leitura do professor, não o
 *  Player) — usada para provar que a lista/dashboard refletem evidência
 *  REAL, nunca fabricada. */
function seedConfirmedAttempt(studentId: string, questionId: string, completedAtIso: string): void {
  db.sqlite
    .prepare(
      `INSERT INTO question_attempts
         (id, user_id, question_id, question_version, mode, status, selected_alternative, is_correct, started_at, answered_at, completed_at, last_activity_at)
       VALUES (?, ?, ?, 1, 'practice', 'completed', 'B', 1, ?, ?, ?, ?)`
    )
    .run(`attempt-${studentId}-${questionId}`, studentId, questionId, completedAtIso, completedAtIso, completedAtIso, completedAtIso);
}

describe("Autorização (ordem seção 6/17)", () => {
  it("sem sessão nenhuma, /api/teacher/dashboard responde 401", async () => {
    const response = await callTeacherRoute("/api/teacher/dashboard", null);
    expect(response.status).toBe(401);
  });

  it("sem sessão nenhuma, /api/teacher/students responde 401", async () => {
    const response = await callTeacherRoute("/api/teacher/students", null);
    expect(response.status).toBe(401);
  });

  it("sem sessão nenhuma, /api/teacher/students/:id responde 401 (nunca 404 — a ausência de sessão é distinguível de 'aluno não autorizado')", async () => {
    const response = await callTeacherRoute(`/api/teacher/students/${FIXTURE_STUDENT_1}`, null);
    expect(response.status).toBe(401);
  });

  it("aluno comum (autenticado, sem papel teacher) recebe 403 em /dashboard", async () => {
    const token = await seedPlainStudent("aluno-comum-1");
    const response = await callTeacherRoute("/api/teacher/dashboard", token);
    expect(response.status).toBe(403);
  });

  it("aluno comum (autenticado, sem papel teacher) recebe 403 em /students", async () => {
    const token = await seedPlainStudent("aluno-comum-2");
    const response = await callTeacherRoute("/api/teacher/students", token);
    expect(response.status).toBe(403);
  });

  it("aluno comum tentando abrir /students/:id de outro usuário recebe 404 (nunca 403 — evita enumeração de que o recurso é 'de professor')", async () => {
    const token = await seedPlainStudent("aluno-comum-3");
    const response = await callTeacherRoute(`/api/teacher/students/${FIXTURE_STUDENT_1}`, token);
    expect(response.status).toBe(404);
  });

  it("professor autorizado, vínculo ATIVO: /students/:id responde 200", async () => {
    const token = await sessionFor(FIXTURE_TEACHER_A);
    const response = await callTeacherRoute(`/api/teacher/students/${FIXTURE_STUDENT_1}`, token);
    expect(response.status).toBe(200);
  });

  it("professor SEM vínculo com este aluno (aluno 4, sem professor algum) recebe 404", async () => {
    const token = await sessionFor(FIXTURE_TEACHER_A);
    const response = await callTeacherRoute(`/api/teacher/students/${FIXTURE_STUDENT_4_NO_TEACHER}`, token);
    expect(response.status).toBe(404);
  });

  it("professor tentando acessar aluno vinculado a OUTRO professor recebe 404 (professor B tentando ver aluno 2, só vinculado à professora A)", async () => {
    const token = await sessionFor(FIXTURE_TEACHER_B);
    const response = await callTeacherRoute(`/api/teacher/students/${FIXTURE_STUDENT_2}`, token);
    expect(response.status).toBe(404);
  });

  it("vínculo INATIVO nunca concede acesso, mesmo que já tenha existido ativo para outro professor (professor B x aluno 1, vínculo inativo)", async () => {
    const token = await sessionFor(FIXTURE_TEACHER_B);
    const response = await callTeacherRoute(`/api/teacher/students/${FIXTURE_STUDENT_1}`, token);
    expect(response.status).toBe(404);
  });

  it("studentId inexistente recebe 404", async () => {
    const token = await sessionFor(FIXTURE_TEACHER_A);
    const response = await callTeacherRoute(`/api/teacher/students/id-que-nao-existe`, token);
    expect(response.status).toBe(404);
  });

  it("404 é INDISTINGUÍVEL entre 'vínculo inexistente', 'vínculo inativo', 'aluno de outro professor' e 'aluno inexistente' (mesmo status e mesmo corpo)", async () => {
    const token = await sessionFor(FIXTURE_TEACHER_A);
    const [noBond, otherTeachersStudent, nonexistent] = await Promise.all([
      callTeacherRoute(`/api/teacher/students/${FIXTURE_STUDENT_4_NO_TEACHER}`, token),
      callTeacherRoute(`/api/teacher/students/${FIXTURE_STUDENT_3}`, token),
      callTeacherRoute(`/api/teacher/students/id-inexistente`, token),
    ]);
    expect(noBond.status).toBe(404);
    expect(otherTeachersStudent.status).toBe(404);
    expect(nonexistent.status).toBe(404);
    const [bodyA, bodyB, bodyC] = await Promise.all([noBond.json(), otherTeachersStudent.json(), nonexistent.json()]);
    expect(bodyA).toEqual(bodyB);
    expect(bodyB).toEqual(bodyC);
  });

  it("método não permitido (POST) em /api/teacher/dashboard responde 405", async () => {
    const token = await sessionFor(FIXTURE_TEACHER_A);
    const request = new Request(`${LOCAL_ORIGIN}/api/teacher/dashboard`, { method: "POST", headers: { Cookie: `md_session=${token}` } });
    const response = (await handleTeacherRequest(request, localEnv(), new URL(request.url)))!;
    expect(response.status).toBe(405);
  });
});

describe("Dashboard (ordem seção 11)", () => {
  it("professor sem alunos vinculados: contagens em zero, sem itens em 'Para acompanhar'", async () => {
    const token = await sessionFor(FIXTURE_TEACHER_C_NO_STUDENTS);
    const response = await callTeacherRoute("/api/teacher/dashboard", token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { dashboard: { linkedStudents: { activeCount: number }; attention: unknown[] } };
    expect(body.dashboard.linkedStudents.activeCount).toBe(0);
    expect(body.dashboard.attention).toEqual([]);
  });

  it("agregação de múltiplos alunos: professor A vê exatamente 2 vínculos ativos (alunos 1 e 2)", async () => {
    const token = await sessionFor(FIXTURE_TEACHER_A);
    const response = await callTeacherRoute("/api/teacher/dashboard", token);
    const body = (await response.json()) as { dashboard: { linkedStudents: { activeCount: number } } };
    expect(body.dashboard.linkedStudents.activeCount).toBe(2);
  });

  it("isolamento entre professores: dashboard do professor B nunca inclui alunos exclusivos da professora A", async () => {
    const tokenA = await sessionFor(FIXTURE_TEACHER_A);
    const tokenB = await sessionFor(FIXTURE_TEACHER_B);
    const [responseA, responseB] = await Promise.all([callTeacherRoute("/api/teacher/students", tokenA), callTeacherRoute("/api/teacher/students", tokenB)]);
    const [bodyA, bodyB] = (await Promise.all([responseA.json(), responseB.json()])) as Array<{ students: Array<{ studentId: string }> }>;
    const idsA = bodyA.students.map((s) => s.studentId);
    const idsB = bodyB.students.map((s) => s.studentId);
    expect(idsA).toContain(FIXTURE_STUDENT_1);
    expect(idsA).toContain(FIXTURE_STUDENT_2);
    expect(idsA).not.toContain(FIXTURE_STUDENT_3);
    expect(idsB).toEqual([FIXTURE_STUDENT_3]);
    expect(idsB).not.toContain(FIXTURE_STUDENT_1); // vínculo inativo não conta
  });

  it("ausência de evidência nunca vira zero pedagógico: aluno sem nenhuma tentativa aparece com lastActivityAt=null, não '0%'", async () => {
    const token = await sessionFor(FIXTURE_TEACHER_A);
    const response = await callTeacherRoute("/api/teacher/students", token);
    const body = (await response.json()) as { students: Array<{ studentId: string; lastActivityAt: string | null; hasRecentActivity: boolean }> };
    const student1 = body.students.find((s) => s.studentId === FIXTURE_STUDENT_1)!;
    expect(student1.lastActivityAt).toBeNull();
    expect(student1.hasRecentActivity).toBe(false);
  });

  it("dados factuais corretos: uma tentativa confirmada recente do aluno 1 aparece refletida na lista do professor A", async () => {
    const qId = seedQuestion(db.sqlite, { id: "q-teacher-1", status: "published" });
    seedConfirmedAttempt(FIXTURE_STUDENT_1, qId, new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, ""));

    const token = await sessionFor(FIXTURE_TEACHER_A);
    const response = await callTeacherRoute("/api/teacher/students", token);
    const body = (await response.json()) as { students: Array<{ studentId: string; lastActivityAt: string | null; hasRecentActivity: boolean; confirmedQuestionsRecent: number }> };
    const student1 = body.students.find((s) => s.studentId === FIXTURE_STUDENT_1)!;
    expect(student1.lastActivityAt).not.toBeNull();
    expect(student1.hasRecentActivity).toBe(true);
    expect(student1.confirmedQuestionsRecent).toBe(1);
  });

  it("nenhum GET (dashboard/students/students-detail) escreve nenhuma linha em nenhuma tabela sensível", async () => {
    const token = await sessionFor(FIXTURE_TEACHER_A);
    const before = snapshotCounts();

    await callTeacherRoute("/api/teacher/dashboard", token);
    await callTeacherRoute("/api/teacher/students", token);
    await callTeacherRoute(`/api/teacher/students/${FIXTURE_STUDENT_1}`, token);

    const after = snapshotCounts();
    expect(after).toEqual(before);
  });
});

describe("Lista de alunos (ordem seção 12)", () => {
  it("busca por nome filtra corretamente", async () => {
    const token = await sessionFor(FIXTURE_TEACHER_A);
    const response = await callTeacherRoute(`/api/teacher/students?busca=${encodeURIComponent("Aluno 1")}`, token);
    const body = (await response.json()) as { students: Array<{ studentId: string }>; total: number };
    expect(body.students.map((s) => s.studentId)).toEqual([FIXTURE_STUDENT_1]);
    expect(body.total).toBe(1);
  });

  it("filtro com_revisao_vencida só retorna alunos com revisão vencida", async () => {
    const token = await sessionFor(FIXTURE_TEACHER_A);
    const response = await callTeacherRoute("/api/teacher/students?filtro=com_revisao_vencida", token);
    const body = (await response.json()) as { students: unknown[] };
    expect(body.students).toEqual([]);
  });

  it("paginação: tamanho=1 retorna 1 item por página, total reflete todos os vínculos ativos", async () => {
    const token = await sessionFor(FIXTURE_TEACHER_A);
    const response = await callTeacherRoute("/api/teacher/students?tamanho=1&pagina=1", token);
    const body = (await response.json()) as { students: unknown[]; total: number; pageSize: number };
    expect(body.students.length).toBe(1);
    expect(body.total).toBe(2);
    expect(body.pageSize).toBe(1);
  });

  it("paginação abusiva (página muito alta) retorna lista vazia, nunca erro", async () => {
    const token = await sessionFor(FIXTURE_TEACHER_A);
    const response = await callTeacherRoute("/api/teacher/students?pagina=999999", token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { students: unknown[] };
    expect(body.students).toEqual([]);
  });

  it("parâmetro de ordenação/filtro inválido nunca quebra a rota (cai no padrão)", async () => {
    const token = await sessionFor(FIXTURE_TEACHER_A);
    const response = await callTeacherRoute("/api/teacher/students?ordenar=algo-invalido&filtro=algo-invalido", token);
    expect(response.status).toBe(200);
  });
});

describe("Acompanhamento individual (ordem seção 13/18)", () => {
  it("perfil individual inclui relatório semanal, padrões e metadados do Caderno de Erros", async () => {
    const token = await sessionFor(FIXTURE_TEACHER_A);
    const response = await callTeacherRoute(`/api/teacher/students/${FIXTURE_STUDENT_1}`, token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { detail: { weeklyReview: unknown; patterns: unknown[]; errorNotebook: { activeCount: number; overdueCount: number; totalCount: number }; trainingToday: unknown } };
    expect(body.detail.weeklyReview).toBeTruthy();
    expect(Array.isArray(body.detail.patterns)).toBe(true);
    expect(body.detail.errorNotebook.totalCount).toBe(0);
    expect(body.detail.trainingToday).toBeNull();
  });

  it("nunca expõe campos privados: e-mail, hash de senha, token de sessão ou anotação livre do Caderno de Erros", async () => {
    // Semeia uma entrada de Caderno de Erros com anotação PRIVADA do aluno 1.
    const qId = seedQuestion(db.sqlite, { id: "q-teacher-priv", status: "published" });
    const now = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
    seedConfirmedAttempt(FIXTURE_STUDENT_1, qId, now);
    db.sqlite
      .prepare(
        `INSERT INTO error_notebook_entries
           (id, user_id, original_question_id, original_attempt_id, latest_attempt_id, error_type, student_note, status, first_error_at, last_error_at, next_review_at)
         VALUES ('entry-priv','${FIXTURE_STUDENT_1}','${qId}','attempt-${FIXTURE_STUDENT_1}-${qId}','attempt-${FIXTURE_STUDENT_1}-${qId}','calculation','SEGREDO-PESSOAL-DO-ALUNO-NUNCA-DEVE-VAZAR','scheduled','${now}','${now}','${now}')`
      )
      .run();

    const token = await sessionFor(FIXTURE_TEACHER_A);
    const response = await callTeacherRoute(`/api/teacher/students/${FIXTURE_STUDENT_1}`, token);
    const rawBody = await response.text();

    expect(rawBody).not.toContain("SEGREDO-PESSOAL-DO-ALUNO-NUNCA-DEVE-VAZAR");
    expect(rawBody).not.toContain("student_note");
    expect(rawBody.toLowerCase()).not.toContain("password_hash");
    expect(rawBody).not.toContain("session-token-");
    expect(rawBody).not.toContain("@local.teste"); // e-mail do aluno nunca aparece
  });
});
