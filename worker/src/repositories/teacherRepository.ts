/* Repositório do Painel do Professor — Sprint 14 v1.0. Ver também a nota da
   Sprint 15 logo abaixo do bloco de leitura.

   100% SOMENTE LEITURA nas consultas de listagem/autorização; a Sprint 14
   restringia as funções de escrita (buildCreateBondStatement) ao SEED
   técnico local (scripts/fixtures/teacher-fixtures.local.sql +
   worker/testing/teacherFixtures.ts) e a teste direto de migration — a
   ordem daquela sprint, seção 9, era explícita: "Nenhuma API pública de
   criação de vínculo será implementada nesta sprint", então nenhuma rota
   HTTP daquela sprint chamava as funções de escrita abaixo.

   Sprint 15 v1.0 (ordem seção 13) MUDA isso deliberadamente: agora existe a
   primeira gestão administrativa real de vínculos (worker/src/routes/
   admin.ts -> worker/src/services/adminService.ts), que PASSA a chamar
   `buildCreateBondStatement` (reaproveitada tal como estava) e as duas
   novas funções `buildReactivateBondStatement`/`buildDeactivateBondStatement`
   abaixo — sempre autorizada por RBAC admin (worker/src/lib/rbac.ts:
   resolveAdminRole), nunca pelo professor dono do vínculo. As funções de
   LEITURA acima continuam exclusivas do Painel do Professor (nunca
   chamadas pela área admin, que tem sua própria projeção sanitizada em
   worker/src/repositories/adminRepository.ts) — só a tabela
   teacher_student_access e seu par único (teacher_id, student_id) são
   reaproveitados, nunca um segundo mecanismo de vínculo.

   Convenção do resto do projeto: consultas parametrizadas, nomes de
   tabela/coluna sempre literais fixos, `teacher_id`/`student_id` sempre no
   WHERE do SQL (nunca só na camada de aplicação — mesma disciplina de
   errorNotebookRepository.ts/studentMetricsRepository.ts).

   Seção 16 da ordem ("não executar N+1 descontrolado por aluno"):
   `listStudentsForTeacher`/`countStudentsForTeacher` são UMA consulta cada
   (com sub-selects agregados por GRUPO, escopados aos alunos vinculados a
   este professor) — nunca um loop chamando um serviço por aluno. */

export interface TeacherStudentAccessRow {
  id: string;
  teacher_id: string;
  student_id: string;
  status: "active" | "inactive";
  created_at: string;
  updated_at: string;
}

export async function findBond(db: D1Database, teacherId: string, studentId: string): Promise<TeacherStudentAccessRow | null> {
  const row = await db
    .prepare("SELECT * FROM teacher_student_access WHERE teacher_id = ? AND student_id = ?")
    .bind(teacherId, studentId)
    .first<TeacherStudentAccessRow>();
  return row ?? null;
}

/** A ÚNICA consulta de autorização usada pelas rotas (ordem seção 6): só uma
 *  linha com status='active' autoriza — vínculo inexistente OU inativo
 *  respondem exatamente igual (`null`) para quem chama, nunca revelando qual
 *  dos dois casos ocorreu (evita enumeração — seção 6/17 da ordem). */
export async function findActiveBond(db: D1Database, teacherId: string, studentId: string): Promise<TeacherStudentAccessRow | null> {
  const row = await db
    .prepare("SELECT * FROM teacher_student_access WHERE teacher_id = ? AND student_id = ? AND status = 'active'")
    .bind(teacherId, studentId)
    .first<TeacherStudentAccessRow>();
  return row ?? null;
}

export async function countActiveBondsForTeacher(db: D1Database, teacherId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) as total FROM teacher_student_access WHERE teacher_id = ? AND status = 'active'")
    .bind(teacherId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export interface TeacherStudentListRow {
  studentId: string;
  studentName: string;
  currentGrade: string | null;
  bondCreatedAt: string;
  lastActivityAt: string | null;
  hasRecentActivity: boolean;
  confirmedQuestionsRecent: number;
  daysWithActivityRecent: number;
  overdueReviewsCount: number;
  errorNotebookPendingCount: number;
  hasActiveWeeklyGoal: boolean;
}

export interface ListStudentsParams {
  teacherId: string;
  recentCutoffIso: string;
  nowIso: string;
  search: string | null;
  filter: string | null;
  sort: string;
  limit: number;
  offset: number;
}

interface BuiltQuery {
  cteSql: string;
  whereSql: string;
  params: unknown[];
}

/** Monta a CTE de agregação por aluno (seção 15/16 da ordem: projeção de
 *  leitura específica do professor, agregação SQL por conjunto). Cada
 *  sub-select é escopado por `WHERE ... user_id IN (SELECT student_id FROM
 *  teacher_student_access WHERE teacher_id = ? AND status = 'active')` —
 *  nunca uma agregação sobre TODOS os usuários da plataforma — então o custo
 *  cresce com o número de alunos DESTE professor, nunca com o total de
 *  alunos da plataforma. Compartilhada por `listStudentsForTeacher` e
 *  `countStudentsForTeacher` para nunca divergir entre lista e contagem. */
function buildStudentAggregateQuery(params: ListStudentsParams): BuiltQuery {
  const bondScope = "SELECT student_id FROM teacher_student_access WHERE teacher_id = ? AND status = 'active'";

  const cteSql = `
    WITH base AS (
      SELECT
        u.id AS student_id,
        u.name AS student_name,
        sp.current_grade AS current_grade,
        tsa.created_at AS bond_created_at,
        la.last_activity_at AS last_activity_at,
        CASE WHEN la.last_activity_at IS NOT NULL AND la.last_activity_at >= ? THEN 1 ELSE 0 END AS has_recent_activity,
        COALESCE(rec.confirmed_recent, 0) AS confirmed_questions_recent,
        COALESCE(rec.days_recent, 0) AS days_with_activity_recent,
        COALESCE(ov.overdue_count, 0) AS overdue_reviews_count,
        COALESCE(en.pending_count, 0) AS error_notebook_pending_count,
        CASE WHEN wg.user_id IS NOT NULL THEN 1 ELSE 0 END AS has_active_weekly_goal
      FROM teacher_student_access tsa
      JOIN users u ON u.id = tsa.student_id
      LEFT JOIN student_profiles sp ON sp.user_id = u.id
      LEFT JOIN (
        SELECT qa.user_id AS user_id, MAX(qa.completed_at) AS last_activity_at
        FROM question_attempts qa
        WHERE qa.status = 'completed' AND qa.user_id IN (${bondScope})
        GROUP BY qa.user_id
      ) la ON la.user_id = u.id
      LEFT JOIN (
        SELECT qa.user_id AS user_id, COUNT(*) AS confirmed_recent, COUNT(DISTINCT date(qa.completed_at)) AS days_recent
        FROM question_attempts qa
        WHERE qa.status = 'completed' AND qa.completed_at >= ? AND qa.user_id IN (${bondScope})
        GROUP BY qa.user_id
      ) rec ON rec.user_id = u.id
      LEFT JOIN (
        SELECT ee.user_id AS user_id, COUNT(*) AS overdue_count
        FROM error_notebook_entries ee
        WHERE ee.status = 'scheduled' AND ee.next_review_at <= ? AND ee.user_id IN (${bondScope})
        GROUP BY ee.user_id
      ) ov ON ov.user_id = u.id
      LEFT JOIN (
        SELECT ee.user_id AS user_id, COUNT(*) AS pending_count
        FROM error_notebook_entries ee
        WHERE ee.status != 'archived' AND ee.status != 'corrected' AND ee.user_id IN (${bondScope})
        GROUP BY ee.user_id
      ) en ON en.user_id = u.id
      LEFT JOIN (
        SELECT DISTINCT user_id AS user_id
        FROM weekly_study_goals
        WHERE status = 'active' AND user_id IN (${bondScope})
      ) wg ON wg.user_id = u.id
      WHERE tsa.teacher_id = ? AND tsa.status = 'active'
    )
  `;

  const params_: unknown[] = [
    params.recentCutoffIso,
    params.teacherId, // la
    params.recentCutoffIso,
    params.teacherId, // rec
    params.nowIso,
    params.teacherId, // ov
    params.teacherId, // en
    params.teacherId, // wg
    params.teacherId, // outer WHERE tsa.teacher_id
  ];

  const whereParts: string[] = [];
  if (params.search) {
    whereParts.push("student_name LIKE ? COLLATE NOCASE");
    params_.push(`%${params.search}%`);
  }
  if (params.filter === "com_atividade_recente") whereParts.push("has_recent_activity = 1");
  else if (params.filter === "sem_atividade_recente") whereParts.push("has_recent_activity = 0");
  else if (params.filter === "com_revisao_vencida") whereParts.push("overdue_reviews_count > 0");
  else if (params.filter === "com_meta_ativa") whereParts.push("has_active_weekly_goal = 1");
  else if (params.filter === "com_caderno_pendente") whereParts.push("error_notebook_pending_count > 0");

  const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";
  return { cteSql, whereSql, params: params_ };
}

function sortSql(sort: string): string {
  switch (sort) {
    case "nome_desc":
      return "student_name DESC, student_id ASC";
    case "atividade_recente_desc":
      return "last_activity_at IS NULL ASC, last_activity_at DESC, student_name ASC";
    case "revisoes_vencidas_desc":
      return "overdue_reviews_count DESC, student_name ASC";
    case "nome_asc":
    default:
      return "student_name ASC, student_id ASC";
  }
}

interface StudentAggregateRawRow {
  student_id: string;
  student_name: string;
  current_grade: string | null;
  bond_created_at: string;
  last_activity_at: string | null;
  has_recent_activity: number;
  confirmed_questions_recent: number;
  days_with_activity_recent: number;
  overdue_reviews_count: number;
  error_notebook_pending_count: number;
  has_active_weekly_goal: number;
}

function toListRow(row: StudentAggregateRawRow): TeacherStudentListRow {
  return {
    studentId: row.student_id,
    studentName: row.student_name,
    currentGrade: row.current_grade,
    bondCreatedAt: row.bond_created_at,
    lastActivityAt: row.last_activity_at,
    hasRecentActivity: row.has_recent_activity === 1,
    confirmedQuestionsRecent: row.confirmed_questions_recent,
    daysWithActivityRecent: row.days_with_activity_recent,
    overdueReviewsCount: row.overdue_reviews_count,
    errorNotebookPendingCount: row.error_notebook_pending_count,
    hasActiveWeeklyGoal: row.has_active_weekly_goal === 1,
  };
}

/** Listagem paginada (ordem seção 12/16) — UMA consulta agregada por
 *  conjunto, nunca um loop por aluno. `search`/`filter`/`sort` sempre
 *  aplicados no SQL (nunca só no cliente), `limit`/`offset` sempre
 *  aplicados no SQL. */
export async function listStudentsForTeacher(db: D1Database, params: ListStudentsParams): Promise<TeacherStudentListRow[]> {
  const { cteSql, whereSql, params: baseParams } = buildStudentAggregateQuery(params);
  const sql = `${cteSql} SELECT * FROM base ${whereSql} ORDER BY ${sortSql(params.sort)} LIMIT ? OFFSET ?`;
  const result = await db
    .prepare(sql)
    .bind(...baseParams, params.limit, params.offset)
    .all<StudentAggregateRawRow>();
  return (result.results ?? []).map(toListRow);
}

/** Contagem total para paginação — mesma CTE/WHERE de `listStudentsForTeacher`,
 *  nunca reimplementada separadamente (garante que total e página nunca
 *  divergem sobre quais filtros se aplicam). */
export async function countStudentsForTeacher(db: D1Database, params: ListStudentsParams): Promise<number> {
  const { cteSql, whereSql, params: baseParams } = buildStudentAggregateQuery(params);
  const sql = `${cteSql} SELECT COUNT(*) as total FROM base ${whereSql}`;
  const row = await db
    .prepare(sql)
    .bind(...baseParams)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/** Todos os alunos vinculados ativos, sem paginação (uso interno do
 *  dashboard — ordem seção 11/16), limitado por um teto técnico defensivo
 *  para nunca virar uma consulta ilimitada mesmo com uma carteira grande de
 *  alunos (ver DASHBOARD_STUDENTS_CAP em teacherService.ts). Ainda UMA única
 *  consulta agregada — nunca um loop por aluno. */
export async function listAllActiveStudentsForTeacher(
  db: D1Database,
  params: Omit<ListStudentsParams, "search" | "filter" | "sort" | "limit" | "offset"> & { cap: number }
): Promise<TeacherStudentListRow[]> {
  return listStudentsForTeacher(db, {
    ...params,
    search: null,
    filter: null,
    sort: "nome_asc",
    limit: params.cap,
    offset: 0,
  });
}

/* --------------------------------------------------------------------- */
/* Escrita — SOMENTE para seed técnico local e testes de migration/fixture. */
/* Nenhuma rota HTTP desta sprint chama estas funções (ordem seção 9).      */
/* --------------------------------------------------------------------- */

export function buildCreateBondStatement(
  db: D1Database,
  params: { id: string; teacherId: string; studentId: string; status: "active" | "inactive"; nowIso: string }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO teacher_student_access (id, teacher_id, student_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(params.id, params.teacherId, params.studentId, params.status, params.nowIso, params.nowIso);
}

/** Sprint 15 v1.0, seção 13 da ordem — reativa um vínculo já existente por
 *  UPDATE (nunca um segundo INSERT para o mesmo par, que violaria
 *  idx_teacher_student_access_pair de qualquer forma). O guard `AND status =
 *  'inactive'` no WHERE torna a chamada idempotente por CONTEÚDO: reaplicar
 *  sobre um vínculo já ativo simplesmente afeta 0 linhas (nunca um erro) —
 *  o serviço decide o que isso significa (ver adminService.ts:
 *  classifyBondMutation), nunca esta camada. */
export function buildReactivateBondStatement(
  db: D1Database,
  params: { bondId: string; nowIso: string }
): D1PreparedStatement {
  return db
    .prepare(`UPDATE teacher_student_access SET status = 'active', updated_at = ? WHERE id = ? AND status = 'inactive'`)
    .bind(params.nowIso, params.bondId);
}

/** Sprint 15 v1.0, seção 13 da ordem — inativa um vínculo ativo por UPDATE
 *  (histórico preservado, nunca DELETE — mesmo princípio de
 *  migrations/0019_teacher_student_access.sql). Mesmo guard idempotente por
 *  conteúdo do reverso acima. */
export function buildDeactivateBondStatement(
  db: D1Database,
  params: { bondId: string; nowIso: string }
): D1PreparedStatement {
  return db
    .prepare(`UPDATE teacher_student_access SET status = 'inactive', updated_at = ? WHERE id = ? AND status = 'active'`)
    .bind(params.nowIso, params.bondId);
}
