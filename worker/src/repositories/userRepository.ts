export interface UserRow {
  id: string;
  name: string;
  email: string;
  email_normalized: string;
  password_hash: string;
  status: string;
  email_confirmed_at: string | null;
  session_version: number;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export async function findUserByNormalizedEmail(
  db: D1Database,
  emailNormalized: string
): Promise<UserRow | null> {
  const row = await db
    .prepare("SELECT * FROM users WHERE email_normalized = ?")
    .bind(emailNormalized)
    .first<UserRow>();
  return row ?? null;
}

export async function findUserById(db: D1Database, id: string): Promise<UserRow | null> {
  const row = await db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
  return row ?? null;
}

export async function createUser(
  db: D1Database,
  params: { id: string; name: string; email: string; emailNormalized: string; passwordHash: string }
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO users (id, name, email, email_normalized, password_hash) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(params.id, params.name.trim(), params.email.trim(), params.emailNormalized, params.passwordHash)
    .run();
}

/** Statement condicional — só confirma o e-mail se, na mesma transação, o
 *  token referenciado (guardSql) ainda estiver válido. Feito para compor um
 *  db.batch() com o consumo do token (Sprint 2 v1.3, correção 3.2). */
export function buildConfirmEmailStatement(
  db: D1Database,
  userId: string,
  guardSql: string,
  guardParams: [tokenId: string, guardUserId: string]
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE users SET email_confirmed_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND ${guardSql}`
    )
    .bind(userId, ...guardParams);
}

/** Statement condicional — só troca a senha e incrementa session_version se,
 *  na mesma transação, o token de redefinição ainda estiver válido
 *  (Sprint 2 v1.3, correção 3.3). */
export function buildUpdatePasswordAndBumpSessionVersionStatement(
  db: D1Database,
  userId: string,
  passwordHash: string,
  guardSql: string,
  guardParams: [tokenId: string, guardUserId: string]
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE users SET password_hash = ?, session_version = session_version + 1, updated_at = datetime('now') WHERE id = ? AND ${guardSql}`
    )
    .bind(passwordHash, userId, ...guardParams);
}

/** Upgrade oportunista de hash após login válido — não bump de session_version,
 *  não revoga sessões (o segredo comprovado pelo usuário não mudou, só o custo
 *  computacional do hash armazenado). */
export async function upgradePasswordHash(
  db: D1Database,
  userId: string,
  passwordHash: string
): Promise<void> {
  await db
    .prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(passwordHash, userId)
    .run();
}

export async function touchLastLogin(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?")
    .bind(userId)
    .run();
}
