/* Repositório do Player de Questão — Sprint 8 v1.1.

   Consultas parametrizadas; nomes de tabela/coluna sempre literais fixos.
   Os "build*Statement" retornam D1PreparedStatement para compor um único
   db.batch() atômico no serviço — mesmo padrão de questionRepository.ts/
   scheduleRepository.ts desde a Sprint 5.

   Escopo por usuário SEMPRE no WHERE do SQL (`user_id = ?`), nunca só na
   camada de aplicação — nenhuma consulta de tentativa/bookmark/denúncia
   deixa de filtrar por `user_id`, prevenindo por construção que uma
   tentativa de outro aluno seja lida ou alterada. */

export interface QuestionAttemptRow {
  id: string;
  user_id: string;
  question_id: string;
  question_version: number;
  mode: "learning" | "practice" | "recognition";
  status: "in_progress" | "answered" | "completed" | "abandoned";
  selected_alternative: string | null;
  is_correct: number | null;
  recognition_pattern_id: string | null;
  recognition_clue: string | null;
  recognition_strategy: string | null;
  highest_help_layer: number;
  started_at: string;
  answered_at: string | null;
  completed_at: string | null;
  last_activity_at: string;
  version: number;
  created_at: string;
  updated_at: string;
  /** Sprint 9 v1.0 (migrations/0014, ALTER TABLE aditivo) — não-nulo só em
   *  tentativas iniciadas pelo Caderno de Erros ("Corrigir meu erro"). O
   *  Player continua persistindo `mode` tecnicamente como `practice` nessa
   *  tentativa; é este campo que diz à interface para apresentar a tela
   *  como "Revisão" (ver docs/CADERNO_ERROS_REVISAO.md). */
  error_entry_id: string | null;
}

export interface QuestionAnswerEventRow {
  id: string;
  attempt_id: string;
  previous_alternative: string | null;
  new_alternative: string | null;
  event_type: "selected" | "changed" | "confirmed";
  created_at: string;
}

export interface QuestionRecognitionEventRow {
  id: string;
  attempt_id: string;
  pattern_id: string;
  clue: string;
  strategy: string;
  attempt_version: number;
  created_at: string;
}

export interface QuestionHelpEventRow {
  id: string;
  attempt_id: string;
  layer: number;
  created_at: string;
}

export interface QuestionReviewBookmarkRow {
  id: string;
  user_id: string;
  question_id: string;
  created_at: string;
}

export interface QuestionProblemReportRow {
  id: string;
  user_id: string;
  question_id: string;
  attempt_id: string | null;
  category: string;
  comment: string | null;
  status: string;
  created_at: string;
}

/* --------------------------------- Leitura --------------------------------- */

export async function findAttemptById(db: D1Database, id: string): Promise<QuestionAttemptRow | null> {
  const row = await db.prepare("SELECT * FROM question_attempts WHERE id = ?").bind(id).first<QuestionAttemptRow>();
  return row ?? null;
}

/** Escopado por `user_id` no próprio SQL — uma tentativa de outro aluno
 *  nunca é retornada aqui, mesmo que o id exista (a rota trata `null` como
 *  404, nunca 403, para não confirmar a existência da tentativa alheia). */
export async function findAttemptByIdForUser(db: D1Database, id: string, userId: string): Promise<QuestionAttemptRow | null> {
  const row = await db.prepare("SELECT * FROM question_attempts WHERE id = ? AND user_id = ?").bind(id, userId).first<QuestionAttemptRow>();
  return row ?? null;
}

export async function findActiveAttempt(
  db: D1Database,
  userId: string,
  questionId: string,
  mode: string
): Promise<QuestionAttemptRow | null> {
  const row = await db
    .prepare("SELECT * FROM question_attempts WHERE user_id = ? AND question_id = ? AND mode = ? AND status = 'in_progress'")
    .bind(userId, questionId, mode)
    .first<QuestionAttemptRow>();
  return row ?? null;
}

/** Sprint 9 v1.0 (seção 8.1/8.2) — resumo/unicidade de revisão é por
 *  ENTRADA (`error_entry_id`), nunca por questão+modo — o índice único
 *  parcial `idx_question_attempts_one_active_review_per_entry`
 *  (migrations/0014) é quem garante, no banco, que só existe UMA
 *  tentativa `in_progress` ligada à mesma entrada por vez. */
export async function findActiveReviewAttempt(db: D1Database, userId: string, errorEntryId: string): Promise<QuestionAttemptRow | null> {
  const row = await db
    .prepare("SELECT * FROM question_attempts WHERE user_id = ? AND error_entry_id = ? AND status = 'in_progress'")
    .bind(userId, errorEntryId)
    .first<QuestionAttemptRow>();
  return row ?? null;
}

export async function listAnswerEvents(db: D1Database, attemptId: string): Promise<QuestionAnswerEventRow[]> {
  const result = await db
    .prepare("SELECT * FROM question_answer_events WHERE attempt_id = ? ORDER BY created_at ASC")
    .bind(attemptId)
    .all<QuestionAnswerEventRow>();
  return result.results ?? [];
}

export async function listRecognitionEvents(db: D1Database, attemptId: string): Promise<QuestionRecognitionEventRow[]> {
  const result = await db
    .prepare("SELECT * FROM question_recognition_events WHERE attempt_id = ? ORDER BY created_at ASC")
    .bind(attemptId)
    .all<QuestionRecognitionEventRow>();
  return result.results ?? [];
}

export async function listHelpEvents(db: D1Database, attemptId: string): Promise<QuestionHelpEventRow[]> {
  const result = await db
    .prepare("SELECT * FROM question_help_events WHERE attempt_id = ? ORDER BY layer ASC")
    .bind(attemptId)
    .all<QuestionHelpEventRow>();
  return result.results ?? [];
}

export async function findBookmark(db: D1Database, userId: string, questionId: string): Promise<QuestionReviewBookmarkRow | null> {
  const row = await db
    .prepare("SELECT * FROM question_review_bookmarks WHERE user_id = ? AND question_id = ?")
    .bind(userId, questionId)
    .first<QuestionReviewBookmarkRow>();
  return row ?? null;
}

/* ------------------------------- Escrita: tentativa -------------------------------- */

export function buildCreateAttemptStatement(
  db: D1Database,
  params: { id: string; userId: string; questionId: string; questionVersion: number; mode: string; errorEntryId?: string | null }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO question_attempts (id, user_id, question_id, question_version, mode, status, error_entry_id)
       VALUES (?, ?, ?, ?, ?, 'in_progress', ?)`
    )
    .bind(params.id, params.userId, params.questionId, params.questionVersion, params.mode, params.errorEntryId ?? null);
}

/** Fragmento de guard COMPARTILHADO por toda mutação de tentativa: só afeta
 *  a linha se ela pertencer ao usuário certo, estiver na versão esperada, e
 *  ainda estiver `in_progress` (nenhuma mutação de conteúdo é permitida
 *  numa tentativa já `answered`/`completed`/`abandoned` — a única exceção é
 *  a própria confirmação, que TAMBÉM exige `in_progress`, sendo a
 *  transição que sai desse estado). */
function attemptGuard(): string {
  return "id = ? AND user_id = ? AND version = ? AND status = 'in_progress'";
}

/** Sprint 8 v1.2 — correção de atomicidade (PO): o INSERT de evento pareado
 *  com um UPDATE de `question_attempts` no MESMO lote deixou de ser
 *  CONDICIONAL (`INSERT ... SELECT ... WHERE EXISTS(...)`, que pode
 *  silenciosamente afetar zero linhas sem lançar erro — detectável só
 *  DEPOIS de `db.batch()`, nunca PREVENÍVEL) e passou a ser INCONDICIONAL
 *  (`INSERT ... VALUES (...)`), usando como `id` da própria linha o MESMO
 *  `mutationId` gravado em `question_attempts.last_mutation_id` pelo UPDATE
 *  pareado, no MESMO lote, sempre ANTES (primeiro statement) do INSERT do
 *  evento (último statement). Um trigger `AFTER INSERT` (migrations/0013,
 *  editada in place) verifica essa identidade e reverte a transação INTEIRA
 *  se não bater — mesmo mecanismo "marcador incondicional + RAISE(ABORT)
 *  por identidade" das migrations 0009-0012 do Banco de Questões, adaptado:
 *  aqui a própria linha de evento SERVE como marcador (não há coleção
 *  nenhuma para reconciliar). Ver comentário extenso em migrations/0013. */

export function buildRecognitionUpdateStatement(
  db: D1Database,
  params: { attemptId: string; userId: string; guardVersion: number; mutationId: string; patternId: string; clue: string; strategy: string }
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE question_attempts
       SET recognition_pattern_id = ?, recognition_clue = ?, recognition_strategy = ?,
           version = version + 1, last_mutation_id = ?, last_activity_at = datetime('now'), updated_at = datetime('now')
       WHERE ${attemptGuard()}`
    )
    .bind(params.patternId, params.clue, params.strategy, params.mutationId, params.attemptId, params.userId, params.guardVersion);
}

export function buildRecognitionEventInsertStatement(
  db: D1Database,
  params: { id: string; attemptId: string; attemptVersion: number; patternId: string; clue: string; strategy: string }
): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO question_recognition_events (id, attempt_id, pattern_id, clue, strategy, attempt_version) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(params.id, params.attemptId, params.patternId, params.clue, params.strategy, params.attemptVersion);
}

export function buildAnswerUpdateStatement(
  db: D1Database,
  params: { attemptId: string; userId: string; guardVersion: number; mutationId: string; alternative: string }
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE question_attempts
       SET selected_alternative = ?, version = version + 1, last_mutation_id = ?, last_activity_at = datetime('now'), updated_at = datetime('now')
       WHERE ${attemptGuard()}`
    )
    .bind(params.alternative, params.mutationId, params.attemptId, params.userId, params.guardVersion);
}

export function buildAnswerEventInsertStatement(
  db: D1Database,
  params: { id: string; attemptId: string; previousAlternative: string | null; newAlternative: string; eventType: "selected" | "changed" }
): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO question_answer_events (id, attempt_id, previous_alternative, new_alternative, event_type) VALUES (?, ?, ?, ?, ?)`)
    .bind(params.id, params.attemptId, params.previousAlternative, params.newAlternative, params.eventType);
}

/** Confirmação: MESMO guard-base (id+user+version+in_progress) mais a
 *  exigência de já haver uma alternativa selecionada — o UPDATE central que
 *  muda `status` para `completed`, grava `is_correct` (computado no
 *  serviço, nunca recebido do cliente) e `answered_at`/`completed_at`
 *  (sempre `datetime('now')` do servidor, nunca um valor do corpo da
 *  requisição). */
export function buildConfirmUpdateStatement(
  db: D1Database,
  params: { attemptId: string; userId: string; guardVersion: number; mutationId: string; isCorrect: 0 | 1 }
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE question_attempts
       SET status = 'completed', is_correct = ?, answered_at = datetime('now'), completed_at = datetime('now'),
           version = version + 1, last_mutation_id = ?, last_activity_at = datetime('now'), updated_at = datetime('now')
       WHERE ${attemptGuard()} AND selected_alternative IS NOT NULL`
    )
    .bind(params.isCorrect, params.mutationId, params.attemptId, params.userId, params.guardVersion);
}

export function buildConfirmEventInsertStatement(db: D1Database, params: { id: string; attemptId: string; alternative: string }): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO question_answer_events (id, attempt_id, previous_alternative, new_alternative, event_type) VALUES (?, ?, ?, ?, 'confirmed')`)
    .bind(params.id, params.attemptId, params.alternative, params.alternative);
}

/** Ajuda: avança `highest_help_layer` para `layer` — o guard exige que
 *  `layer` seja EXATAMENTE `highest_help_layer + 1` (nunca pular camada),
 *  além do guard-base de identidade/versão/status. Uma tentativa de reabrir
 *  uma camada já aberta (`layer <= highest_help_layer`) nunca chega a este
 *  statement — o serviço trata como idempotente ANTES de montar o lote (ver
 *  playerService.ts:openHelpLayer). */
export function buildHelpAdvanceStatement(
  db: D1Database,
  params: { attemptId: string; userId: string; guardVersion: number; mutationId: string; layer: number }
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE question_attempts
       SET highest_help_layer = ?, version = version + 1, last_mutation_id = ?, last_activity_at = datetime('now'), updated_at = datetime('now')
       WHERE ${attemptGuard()} AND highest_help_layer = ?`
    )
    .bind(params.layer, params.mutationId, params.attemptId, params.userId, params.guardVersion, params.layer - 1);
}

export function buildHelpEventInsertStatement(db: D1Database, params: { id: string; attemptId: string; layer: number }): D1PreparedStatement {
  return db.prepare(`INSERT INTO question_help_events (id, attempt_id, layer) VALUES (?, ?, ?)`).bind(params.id, params.attemptId, params.layer);
}

export function buildAbandonAttemptStatement(db: D1Database, params: { attemptId: string; userId: string; guardVersion: number }): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE question_attempts
       SET status = 'abandoned', version = version + 1, last_activity_at = datetime('now'), updated_at = datetime('now')
       WHERE ${attemptGuard()}`
    )
    .bind(params.attemptId, params.userId, params.guardVersion);
}

/* ------------------------- Escrita: revisão e denúncia ------------------------- */

/** `INSERT OR IGNORE` — o índice único (user_id, question_id) já garante
 *  idempotência no BANCO: repetir o PUT nunca duplica, nunca lança erro. */
export function buildBookmarkInsertStatement(db: D1Database, params: { id: string; userId: string; questionId: string }): D1PreparedStatement {
  return db
    .prepare("INSERT OR IGNORE INTO question_review_bookmarks (id, user_id, question_id) VALUES (?, ?, ?)")
    .bind(params.id, params.userId, params.questionId);
}

/** DELETE idempotente por natureza — 0 ou 1 linha afetada, nunca um erro em
 *  nenhum dos dois casos. */
export function buildBookmarkDeleteStatement(db: D1Database, params: { userId: string; questionId: string }): D1PreparedStatement {
  return db.prepare("DELETE FROM question_review_bookmarks WHERE user_id = ? AND question_id = ?").bind(params.userId, params.questionId);
}

export function buildProblemReportInsertStatement(
  db: D1Database,
  params: { id: string; userId: string; questionId: string; attemptId: string | null; category: string; comment: string | null }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO question_problem_reports (id, user_id, question_id, attempt_id, category, comment)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(params.id, params.userId, params.questionId, params.attemptId, params.category, params.comment);
}
