/* Repositório de importação CSV de questões — Sprint 7 v1.0, seção 8 da
   ordem. Consultas parametrizadas; nomes de tabela/coluna sempre literais
   fixos. `payload` nunca guarda o CSV bruto — só as linhas já validadas
   (nunca conteúdo de log completo). */

export interface QuestionImportBatchRow {
  id: string;
  user_id: string;
  status: "previewed" | "applied" | "undone" | "expired";
  row_count: number;
  valid_row_count: number;
  error_count: number;
  payload: string;
  input_fingerprint: string;
  created_at: string;
  expires_at: string;
  applied_at: string | null;
  undone_at: string | null;
}

export interface QuestionImportItemRow {
  id: string;
  batch_id: string;
  row_number: number;
  code: string;
  question_id: string | null;
}

export async function findImportBatch(db: D1Database, id: string): Promise<QuestionImportBatchRow | null> {
  const row = await db
    .prepare("SELECT * FROM question_import_batches WHERE id = ?")
    .bind(id)
    .first<QuestionImportBatchRow>();
  return row ?? null;
}

export async function insertImportBatch(
  db: D1Database,
  params: {
    id: string;
    userId: string;
    rowCount: number;
    validRowCount: number;
    errorCount: number;
    payload: string;
    inputFingerprint: string;
    expiresAt: string;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO question_import_batches
         (id, user_id, status, row_count, valid_row_count, error_count, payload, input_fingerprint, expires_at)
       VALUES (?, ?, 'previewed', ?, ?, ?, ?, ?, ?)`
    )
    .bind(params.id, params.userId, params.rowCount, params.validRowCount, params.errorCount, params.payload, params.inputFingerprint, params.expiresAt)
    .run();
}

/** Condicionado a `applied_at IS NULL` — reaplicar o MESMO lote não muda
 *  nada na segunda tentativa (idempotência real, mesmo padrão de
 *  buildMarkPreviewAppliedStatement em scheduleRepository.ts). */
export function buildMarkBatchAppliedStatement(db: D1Database, batchId: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE question_import_batches SET status = 'applied', applied_at = datetime('now')
       WHERE id = ? AND status = 'previewed' AND applied_at IS NULL`
    )
    .bind(batchId);
}

/** Condicionado a `applied_at IS NOT NULL AND undone_at IS NULL` — segunda
 *  tentativa de desfazer o MESMO lote não afeta nada. */
export function buildMarkBatchUndoneStatement(db: D1Database, batchId: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE question_import_batches SET status = 'undone', undone_at = datetime('now')
       WHERE id = ? AND status = 'applied' AND applied_at IS NOT NULL AND undone_at IS NULL`
    )
    .bind(batchId);
}

export function buildInsertImportItemStatement(
  db: D1Database,
  params: { id: string; batchId: string; rowNumber: number; code: string; questionId: string }
): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO question_import_items (id, batch_id, row_number, code, question_id) VALUES (?, ?, ?, ?, ?)`)
    .bind(params.id, params.batchId, params.rowNumber, params.code, params.questionId);
}

export async function listImportItems(db: D1Database, batchId: string): Promise<QuestionImportItemRow[]> {
  const result = await db
    .prepare("SELECT * FROM question_import_items WHERE batch_id = ? ORDER BY row_number ASC")
    .bind(batchId)
    .all<QuestionImportItemRow>();
  return result.results ?? [];
}

/** Remove os vínculos das linhas do lote com suas questões (undo) — mantém
 *  a linha do item como registro histórico do que foi importado, mas
 *  desvincula da questão apagada. Guardado pelo mesmo `undone_at IS NULL`
 *  do UPDATE do lote (composto no MESMO db.batch()). */
export function buildDetachImportItemsStatement(db: D1Database, batchId: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE question_import_items SET question_id = NULL
       WHERE batch_id = ? AND EXISTS (
         SELECT 1 FROM question_import_batches WHERE id = ? AND status = 'applied' AND undone_at IS NULL
       )`
    )
    .bind(batchId, batchId);
}

function guardedDeleteByQuestionIdSql(table: string): string {
  return `DELETE FROM ${table} WHERE question_id = ? AND EXISTS (
    SELECT 1 FROM question_import_batches WHERE id = ? AND status = 'applied' AND undone_at IS NULL
  )`;
}

export function buildDeleteQuestionChildrenForUndoStatements(
  db: D1Database,
  questionId: string,
  batchId: string
): D1PreparedStatement[] {
  return [
    "question_alternatives",
    "question_images",
    "question_patterns",
    "question_tags",
    "question_dna",
    "question_history",
  ].map((table) => db.prepare(guardedDeleteByQuestionIdSql(table)).bind(questionId, batchId));
}

export function buildDeleteQuestionForUndoStatement(db: D1Database, questionId: string, batchId: string): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM questions WHERE id = ? AND editorial_status = 'draft' AND EXISTS (
         SELECT 1 FROM question_import_batches WHERE id = ? AND status = 'applied' AND undone_at IS NULL
       )`
    )
    .bind(questionId, batchId);
}
