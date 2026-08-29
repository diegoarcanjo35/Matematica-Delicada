export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  session_version: number;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  user_agent: string | null;
}

export async function createSession(
  db: D1Database,
  params: {
    id: string;
    userId: string;
    tokenHash: string;
    sessionVersion: number;
    expiresAt: string;
    userAgent: string | null;
  }
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO sessions (id, user_id, token_hash, session_version, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(params.id, params.userId, params.tokenHash, params.sessionVersion, params.expiresAt, params.userAgent)
    .run();
}

export async function findActiveSessionByTokenHash(
  db: D1Database,
  tokenHash: string
): Promise<SessionRow | null> {
  const row = await db
    .prepare(
      "SELECT * FROM sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > datetime('now')"
    )
    .bind(tokenHash)
    .first<SessionRow>();
  return row ?? null;
}

export async function touchSession(db: D1Database, id: string): Promise<void> {
  await db
    .prepare("UPDATE sessions SET last_used_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run();
}

export async function revokeSessionByTokenHash(db: D1Database, tokenHash: string): Promise<void> {
  await db
    .prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE token_hash = ?")
    .bind(tokenHash)
    .run();
}

/** Statement condicional — só revoga as sessões ativas do usuário se, na
 *  mesma transação, o token de redefinição de senha ainda estiver válido.
 *  Compõe o mesmo db.batch() da troca de senha e do consumo do token
 *  (Sprint 2 v1.3, correção 3.3): se qualquer statement do lote falhar,
 *  nenhuma sessão é revogada. */
export function buildRevokeAllSessionsForUserStatement(
  db: D1Database,
  userId: string,
  guardSql: string,
  guardParams: [tokenId: string, guardUserId: string]
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL AND ${guardSql}`
    )
    .bind(userId, ...guardParams);
}
