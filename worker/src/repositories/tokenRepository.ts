export type TokenKind = "email_confirmation" | "password_reset";

interface TokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

const TABLE: Record<TokenKind, string> = {
  email_confirmation: "email_confirmation_tokens",
  password_reset: "password_reset_tokens",
};

/** Invalida tokens anteriores não usados do mesmo tipo e emite um novo. */
export async function issueToken(
  db: D1Database,
  kind: TokenKind,
  params: { id: string; userId: string; tokenHash: string; expiresAt: string }
): Promise<void> {
  const table = TABLE[kind];
  await db
    .prepare(`UPDATE ${table} SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL`)
    .bind(params.userId)
    .run();
  await db
    .prepare(`INSERT INTO ${table} (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`)
    .bind(params.id, params.userId, params.tokenHash, params.expiresAt)
    .run();
}

export async function findValidToken(
  db: D1Database,
  kind: TokenKind,
  tokenHash: string
): Promise<TokenRow | null> {
  const table = TABLE[kind];
  const row = await db
    .prepare(
      `SELECT * FROM ${table} WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')`
    )
    .bind(tokenHash)
    .first<TokenRow>();
  return row ?? null;
}

export async function markTokenUsed(db: D1Database, kind: TokenKind, id: string): Promise<void> {
  const table = TABLE[kind];
  await db.prepare(`UPDATE ${table} SET used_at = datetime('now') WHERE id = ?`).bind(id).run();
}
