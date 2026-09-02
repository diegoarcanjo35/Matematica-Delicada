/* Repositório da área administrativa — Sprint 15 v1.0, seções 9-13 da ordem.

   Convenção do resto do projeto: consultas parametrizadas, nomes de
   tabela/coluna sempre literais fixos, nunca um spread de objeto interno —
   cada projeção é montada campo a campo (ordem seção 17: "a minimização
   deve acontecer no backend"). Reaproveita INTEGRALMENTE users/roles/
   user_roles (migration 0008) e teacher_student_access (migration 0019,
   escrita via worker/src/repositories/teacherRepository.ts) — nenhuma
   tabela paralela. */

export interface AdminUserListRow {
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
  search: string | null;
  roleFilter: string | null; // nome de papel, ou 'sem_papel'
  statusFilter: string | null;
  sort: "nome_asc" | "nome_desc" | "criado_recente" | "criado_antigo";
  limit: number;
  offset: number;
}

interface UserFilterQuery {
  whereSql: string;
  params: unknown[];
}

/** Monta o WHERE compartilhado por listUsers/countUsers — nunca duas
 *  implementações divergentes do mesmo filtro (mesmo princípio de
 *  teacherRepository.ts:buildStudentAggregateQuery). O filtro por papel usa
 *  EXISTS/NOT EXISTS em vez de JOIN para nunca duplicar uma linha de
 *  usuário por causa de múltiplos papéis. */
function buildUserFilterQuery(params: ListUsersParams): UserFilterQuery {
  const whereParts: string[] = [];
  const queryParams: unknown[] = [];

  if (params.search) {
    whereParts.push("(u.name LIKE ? COLLATE NOCASE OR u.email_normalized LIKE ? COLLATE NOCASE)");
    queryParams.push(`%${params.search}%`, `%${params.search.toLowerCase()}%`);
  }

  if (params.roleFilter === "sem_papel") {
    whereParts.push("NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id)");
  } else if (params.roleFilter) {
    whereParts.push(
      "EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.name = ?)"
    );
    queryParams.push(params.roleFilter);
  }

  if (params.statusFilter) {
    whereParts.push("u.status = ?");
    queryParams.push(params.statusFilter);
  }

  const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";
  return { whereSql, params: queryParams };
}

function sortSql(sort: ListUsersParams["sort"]): string {
  switch (sort) {
    case "nome_desc":
      return "u.name DESC, u.id ASC";
    case "criado_recente":
      return "u.created_at DESC, u.id ASC";
    case "criado_antigo":
      return "u.created_at ASC, u.id ASC";
    case "nome_asc":
    default:
      return "u.name ASC, u.id ASC";
  }
}

interface UserRowRaw {
  id: string;
  name: string;
  email: string;
  status: string;
  email_confirmed_at: string | null;
  created_at: string;
  last_login_at: string | null;
}

async function attachRoles(db: D1Database, users: UserRowRaw[]): Promise<AdminUserListRow[]> {
  if (users.length === 0) return [];
  const placeholders = users.map(() => "?").join(", ");
  const roleRows = await db
    .prepare(
      `SELECT ur.user_id as user_id, r.name as name FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id IN (${placeholders})`
    )
    .bind(...users.map((u) => u.id))
    .all<{ user_id: string; name: string }>();

  const rolesByUser = new Map<string, string[]>();
  for (const row of roleRows.results ?? []) {
    const list = rolesByUser.get(row.user_id) ?? [];
    list.push(row.name);
    rolesByUser.set(row.user_id, list);
  }

  return users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    status: u.status,
    emailConfirmed: u.email_confirmed_at !== null,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
    roles: (rolesByUser.get(u.id) ?? []).sort(),
  }));
}

/** Listagem paginada (ordem seção 10) — busca/filtro/ordenação sempre no
 *  SQL. `roles` é resolvido numa segunda consulta em lote (nunca N+1 por
 *  usuário — mesma disciplina de teacherRepository.ts). */
export async function listUsers(db: D1Database, params: ListUsersParams): Promise<AdminUserListRow[]> {
  const { whereSql, params: filterParams } = buildUserFilterQuery(params);
  const sql = `SELECT u.id, u.name, u.email, u.status, u.email_confirmed_at, u.created_at, u.last_login_at
               FROM users u ${whereSql} ORDER BY ${sortSql(params.sort)} LIMIT ? OFFSET ?`;
  const result = await db
    .prepare(sql)
    .bind(...filterParams, params.limit, params.offset)
    .all<UserRowRaw>();
  return attachRoles(db, result.results ?? []);
}

export async function countUsers(db: D1Database, params: ListUsersParams): Promise<number> {
  const { whereSql, params: filterParams } = buildUserFilterQuery(params);
  const sql = `SELECT COUNT(*) as total FROM users u ${whereSql}`;
  const row = await db
    .prepare(sql)
    .bind(...filterParams)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export interface AdminUserDetailRow extends AdminUserListRow {
  activeTeacherBondsCount: number; // só relevante se `roles` inclui 'teacher'; 0 caso contrário
}

/** Detalhe administrativo mínimo (ordem seção 11/17) — NUNCA inclui
 *  password_hash, tokens, sessões, nem qualquer dado pedagógico (isso é
 *  responsabilidade exclusiva do Painel do Professor/áreas do próprio
 *  aluno, não da área admin). O único dado "operacional" agregado é a
 *  contagem de vínculos ativos quando o usuário é professor — nunca a lista
 *  de alunos em si (isso duplicaria o Painel do Professor, proibido pela
 *  ordem seção 11). */
export async function getUserDetail(db: D1Database, userId: string): Promise<AdminUserDetailRow | null> {
  const row = await db
    .prepare(`SELECT id, name, email, status, email_confirmed_at, created_at, last_login_at FROM users WHERE id = ?`)
    .bind(userId)
    .first<UserRowRaw>();
  if (!row) return null;

  const [withRoles] = await attachRoles(db, [row]);
  let activeTeacherBondsCount = 0;
  if (withRoles.roles.includes("teacher")) {
    const bondCount = await db
      .prepare(`SELECT COUNT(*) as total FROM teacher_student_access WHERE teacher_id = ? AND status = 'active'`)
      .bind(userId)
      .first<{ total: number }>();
    activeTeacherBondsCount = bondCount?.total ?? 0;
  }

  return { ...withRoles, activeTeacherBondsCount };
}

/* -------------------------------------------------------------------- */
/* Dashboard (ordem seção 9)                                              */
/* -------------------------------------------------------------------- */

export interface AdminDashboardCounts {
  totalUsers: number;
  usersByRole: Record<string, number>;
  usersWithoutRole: number;
  activeTeacherStudentBonds: number;
  inactiveTeacherStudentBonds: number;
}

export async function getDashboardCounts(db: D1Database): Promise<AdminDashboardCounts> {
  const [totalRow, roleRows, withoutRoleRow, activeBondsRow, inactiveBondsRow] = await Promise.all([
    db.prepare(`SELECT COUNT(*) as total FROM users`).first<{ total: number }>(),
    db
      .prepare(
        `SELECT r.name as name, COUNT(DISTINCT ur.user_id) as total
         FROM user_roles ur JOIN roles r ON r.id = ur.role_id GROUP BY r.name`
      )
      .all<{ name: string; total: number }>(),
    db.prepare(`SELECT COUNT(*) as total FROM users u WHERE NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id)`).first<{ total: number }>(),
    db.prepare(`SELECT COUNT(*) as total FROM teacher_student_access WHERE status = 'active'`).first<{ total: number }>(),
    db.prepare(`SELECT COUNT(*) as total FROM teacher_student_access WHERE status = 'inactive'`).first<{ total: number }>(),
  ]);

  const usersByRole: Record<string, number> = {};
  for (const row of roleRows.results ?? []) usersByRole[row.name] = row.total;

  return {
    totalUsers: totalRow?.total ?? 0,
    usersByRole,
    usersWithoutRole: withoutRoleRow?.total ?? 0,
    activeTeacherStudentBonds: activeBondsRow?.total ?? 0,
    inactiveTeacherStudentBonds: inactiveBondsRow?.total ?? 0,
  };
}

/* -------------------------------------------------------------------- */
/* Papéis — mutação (ordem seção 12)                                      */
/* -------------------------------------------------------------------- */

/** Quantos usuários DISTINTOS têm o papel `admin` — a única definição de
 *  "administrador ativo" identificável com segurança no modelo atual (ordem
 *  seção 12): user_roles não tem coluna de status própria, e users.status
 *  nunca é gravado com um valor diferente de 'active' em nenhum fluxo
 *  existente do produto (não há suspensão/banimento implementados nesta
 *  plataforma ainda) — combinar com users.status daria uma falsa sensação
 *  de precisão sem nenhuma fonte real de verdade por trás. "Existe uma
 *  linha user_roles apontando para o papel admin" é, portanto, o único fato
 *  observável e inequívoco disponível hoje; documentado também em
 *  docs/ADMIN_ESSENCIAL.md. */
export async function countAdminRoleHolders(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT ur.user_id) as total FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.name = 'admin'`
    )
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/* -------------------------------------------------------------------- */
/* Vínculos professor <-> aluno (ordem seção 13)                          */
/* -------------------------------------------------------------------- */

export interface AdminBondRow {
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
  search: string | null; // nome do professor OU do aluno
  statusFilter: "active" | "inactive" | null; // null = todos
  limit: number;
  offset: number;
}

interface BondFilterQuery {
  whereSql: string;
  params: unknown[];
}

function buildBondFilterQuery(params: ListBondsParams): BondFilterQuery {
  const whereParts: string[] = [];
  const queryParams: unknown[] = [];

  if (params.search) {
    whereParts.push("(t.name LIKE ? COLLATE NOCASE OR s.name LIKE ? COLLATE NOCASE)");
    queryParams.push(`%${params.search}%`, `%${params.search}%`);
  }
  if (params.statusFilter) {
    whereParts.push("tsa.status = ?");
    queryParams.push(params.statusFilter);
  }

  const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";
  return { whereSql, params: queryParams };
}

const BOND_BASE_SELECT = `
  SELECT tsa.id as id, tsa.teacher_id as teacher_id, t.name as teacher_name,
         tsa.student_id as student_id, s.name as student_name,
         tsa.status as status, tsa.created_at as created_at, tsa.updated_at as updated_at
  FROM teacher_student_access tsa
  JOIN users t ON t.id = tsa.teacher_id
  JOIN users s ON s.id = tsa.student_id
`;

interface BondRowRaw {
  id: string;
  teacher_id: string;
  teacher_name: string;
  student_id: string;
  student_name: string;
  status: "active" | "inactive";
  created_at: string;
  updated_at: string;
}

function toBondRow(row: BondRowRaw): AdminBondRow {
  return {
    id: row.id,
    teacherId: row.teacher_id,
    teacherName: row.teacher_name,
    studentId: row.student_id,
    studentName: row.student_name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Listagem paginada de vínculos (ordem seção 13) — nomes de professor e
 *  aluno resolvidos por JOIN, nunca N+1. */
export async function listBonds(db: D1Database, params: ListBondsParams): Promise<AdminBondRow[]> {
  const { whereSql, params: filterParams } = buildBondFilterQuery(params);
  const sql = `${BOND_BASE_SELECT} ${whereSql} ORDER BY tsa.updated_at DESC, tsa.id ASC LIMIT ? OFFSET ?`;
  const result = await db
    .prepare(sql)
    .bind(...filterParams, params.limit, params.offset)
    .all<BondRowRaw>();
  return (result.results ?? []).map(toBondRow);
}

export async function countBonds(db: D1Database, params: ListBondsParams): Promise<number> {
  const { whereSql, params: filterParams } = buildBondFilterQuery(params);
  const sql = `SELECT COUNT(*) as total FROM teacher_student_access tsa
               JOIN users t ON t.id = tsa.teacher_id JOIN users s ON s.id = tsa.student_id ${whereSql}`;
  const row = await db
    .prepare(sql)
    .bind(...filterParams)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function findBondByIdForAdmin(db: D1Database, bondId: string): Promise<AdminBondRow | null> {
  const row = await db
    .prepare(`${BOND_BASE_SELECT} WHERE tsa.id = ?`)
    .bind(bondId)
    .first<BondRowRaw>();
  return row ? toBondRow(row) : null;
}
