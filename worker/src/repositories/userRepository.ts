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

export async function markEmailConfirmed(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare(
      "UPDATE users SET email_confirmed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    )
    .bind(userId)
    .run();
}

export async function updatePasswordAndBumpSessionVersion(
  db: D1Database,
  userId: string,
  passwordHash: string
): Promise<void> {
  await db
    .prepare(
      "UPDATE users SET password_hash = ?, session_version = session_version + 1, updated_at = datetime('now') WHERE id = ?"
    )
    .bind(passwordHash, userId)
    .run();
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
