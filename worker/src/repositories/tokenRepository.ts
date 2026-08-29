export type TokenKind = "email_confirmation" | "password_reset";

export interface TokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

/** Mapa fechado — nomes de tabela nunca vêm de entrada externa (Sprint 2 v1.3, seção 3.4). */
export const TOKEN_TABLES: Record<TokenKind, string> = {
  email_confirmation: "email_confirmation_tokens",
  password_reset: "password_reset_tokens",
};

/** Predicado de "token ainda válido" reaproveitado por findValidToken e pelos
 *  statements condicionais em authService — evita divergência entre a leitura
 *  inicial e a condição usada dentro do lote atômico. */
export function validTokenPredicateSql(): string {
  return "used_at IS NULL AND expires_at > datetime('now')";
}

/** Invalida tokens anteriores não usados do mesmo tipo e emite um novo — as
 *  duas gravações ocorrem no mesmo lote atômico do D1 (db.batch): se a
 *  inserção falhar, a invalidação do token anterior também é revertida (não
 *  fica estado parcial). Valida o resultado real da inserção — não assume
 *  sucesso só porque nada lançou exceção (Sprint 2 v1.3, correção 3.1/3.4). */
export async function issueToken(
  db: D1Database,
  kind: TokenKind,
  params: { id: string; userId: string; tokenHash: string; expiresAt: string }
): Promise<void> {
  const table = TOKEN_TABLES[kind];
  const results = await db.batch([
    db
      .prepare(`UPDATE ${table} SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL`)
      .bind(params.userId),
    db
      .prepare(`INSERT INTO ${table} (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`)
      .bind(params.id, params.userId, params.tokenHash, params.expiresAt),
  ]);

  const inserted = results[1]?.meta.changes === 1;
  if (!inserted) {
    throw new Error(`Falha ao emitir token (${kind}): a inserção não afetou exatamente 1 linha.`);
  }
}

export async function findValidToken(
  db: D1Database,
  kind: TokenKind,
  tokenHash: string
): Promise<TokenRow | null> {
  const table = TOKEN_TABLES[kind];
  const row = await db
    .prepare(`SELECT * FROM ${table} WHERE token_hash = ? AND ${validTokenPredicateSql()}`)
    .bind(tokenHash)
    .first<TokenRow>();
  return row ?? null;
}

/** Statement condicional de consumo — usado dentro de um db.batch() para que
 *  o consumo seja atômico com a mutação que ele autoriza. A condição repete o
 *  predicado de validade no próprio UPDATE (não um SELECT seguido de UPDATE),
 *  eliminando a janela de corrida entre checar e marcar usado: duas
 *  requisições concorrentes com o mesmo token nunca conseguem as duas marcar
 *  used_at — exatamente uma linha é afetada, a outra vê 0 (Sprint 2 v1.3,
 *  correção 3.2/3.3). O chamador DEVE checar meta.changes === 1 no resultado. */
export function buildConsumeTokenStatement(
  db: D1Database,
  kind: TokenKind,
  tokenId: string,
  userId: string
): D1PreparedStatement {
  const table = TOKEN_TABLES[kind];
  return db
    .prepare(`UPDATE ${table} SET used_at = datetime('now') WHERE id = ? AND user_id = ? AND ${validTokenPredicateSql()}`)
    .bind(tokenId, userId);
}

/** Subconsulta EXISTS reaproveitada pelas mutações que só podem ocorrer se o
 *  token ainda estiver, no momento da transação, íntegro (não consumido por
 *  nenhuma outra requisição concorrente). Referenciada ANTES do statement de
 *  buildConsumeTokenStatement no mesmo lote, para ler o estado do token ainda
 *  intacto (Sprint 2 v1.3, correção 3.2/3.3). */
export function tokenStillValidGuardSql(kind: TokenKind): string {
  const table = TOKEN_TABLES[kind];
  return `EXISTS (SELECT 1 FROM ${table} WHERE id = ? AND user_id = ? AND ${validTokenPredicateSql()})`;
}
