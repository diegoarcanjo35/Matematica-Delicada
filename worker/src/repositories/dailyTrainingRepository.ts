/* Repositório do Treino Diário — Sprint 11 v1.0.

   Mesma convenção do resto do projeto: consultas parametrizadas, nomes de
   tabela/coluna sempre literais fixos, `user_id` SEMPRE no WHERE do SQL
   (nunca só na camada de aplicação), "build*Statement" retornam
   D1PreparedStatement para compor um único db.batch() atômico no serviço.

   As funções de LEITURA de candidatos (seção "Candidatos" abaixo) são
   100% somente-leitura — usadas tanto pelo preview (GET, nunca escreve)
   quanto pelo apply (recomputa o mesmo cálculo antes de persistir, seção 6
   da ordem: "apply... determinístico para o mesmo estado e relógio"). */

export interface DailyTrainingListRow {
  id: string;
  user_id: string;
  training_date: string;
  timezone: string;
  status: "active" | "completed" | "abandoned";
  estimated_minutes: number;
  item_count: number;
  version: number;
  last_mutation_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface DailyTrainingItemRow {
  id: string;
  list_id: string;
  user_id: string;
  question_id: string;
  primary_pattern_id: string | null;
  origin: string;
  reason: string;
  player_mode: "learning" | "practice" | "recognition";
  position: number;
  estimated_minutes: number;
  status: "pending" | "in_progress" | "completed" | "skipped" | "blocked";
  question_attempt_id: string | null;
  error_entry_id: string | null;
  source_schedule_assignment_id: string | null;
  skip_reason: string | null;
  version: number;
  last_mutation_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DailyTrainingEventRow {
  id: string;
  list_id: string;
  item_id: string | null;
  user_id: string;
  event_type: string;
  created_at: string;
}

const TERMINAL_ITEM_STATUSES = ["completed", "skipped", "blocked"];

/* --------------------------------- Leitura: listas/itens --------------------------------- */

export async function findListForUser(db: D1Database, id: string, userId: string): Promise<DailyTrainingListRow | null> {
  const row = await db.prepare("SELECT * FROM daily_training_lists WHERE id = ? AND user_id = ?").bind(id, userId).first<DailyTrainingListRow>();
  return row ?? null;
}

/** Lista ATIVA do aluno para a data local informada — no máximo uma, por
 *  construção do índice único parcial (migrations/0016). Nunca cria nada. */
export async function findActiveListForUserDate(db: D1Database, userId: string, trainingDate: string): Promise<DailyTrainingListRow | null> {
  const row = await db
    .prepare("SELECT * FROM daily_training_lists WHERE user_id = ? AND training_date = ? AND status = 'active'")
    .bind(userId, trainingDate)
    .first<DailyTrainingListRow>();
  return row ?? null;
}

/** Lista mais RELEVANTE do aluno para a data local informada — a `active`
 *  quando existir; senão, a mais recente (qualquer status) já criada nesse
 *  dia. Usada por GET /api/daily-training/current (seção 12 da ordem:
 *  "refresh sem perda de progresso" precisa continuar mostrando o resumo
 *  de uma lista recém-concluída/abandonada, nunca voltar silenciosamente a
 *  uma prévia nova). Continua 100% somente leitura — nunca cria nada. */
export async function findLatestListForUserDate(db: D1Database, userId: string, trainingDate: string): Promise<DailyTrainingListRow | null> {
  const active = await findActiveListForUserDate(db, userId, trainingDate);
  if (active) return active;
  const row = await db
    .prepare("SELECT * FROM daily_training_lists WHERE user_id = ? AND training_date = ? ORDER BY created_at DESC, id DESC LIMIT 1")
    .bind(userId, trainingDate)
    .first<DailyTrainingListRow>();
  return row ?? null;
}

export async function listItemsForList(db: D1Database, listId: string): Promise<DailyTrainingItemRow[]> {
  const result = await db
    .prepare("SELECT * FROM daily_training_items WHERE list_id = ? ORDER BY position ASC")
    .bind(listId)
    .all<DailyTrainingItemRow>();
  return result.results ?? [];
}

export async function findItemForUser(db: D1Database, id: string, userId: string): Promise<DailyTrainingItemRow | null> {
  const row = await db.prepare("SELECT * FROM daily_training_items WHERE id = ? AND user_id = ?").bind(id, userId).first<DailyTrainingItemRow>();
  return row ?? null;
}

/** Item pertencente a uma lista específica E a este usuário — usado por
 *  toda rota `:listId/items/:itemId/...` para rejeitar (404) tanto um item
 *  de outro aluno quanto um item de OUTRA lista deste mesmo aluno (seção 9
 *  da ordem: "recurso de outro aluno retorna 404" — aplicado também entre
 *  listas do mesmo aluno, nunca um item "solto" de contexto). */
export async function findItemForListAndUser(db: D1Database, itemId: string, listId: string, userId: string): Promise<DailyTrainingItemRow | null> {
  const row = await db
    .prepare("SELECT * FROM daily_training_items WHERE id = ? AND list_id = ? AND user_id = ?")
    .bind(itemId, listId, userId)
    .first<DailyTrainingItemRow>();
  return row ?? null;
}

export async function allItemsTerminal(db: D1Database, listId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT COUNT(*) as total FROM daily_training_items WHERE list_id = ? AND status NOT IN (${TERMINAL_ITEM_STATUSES.map(() => "?").join(", ")})`)
    .bind(listId, ...TERMINAL_ITEM_STATUSES)
    .first<{ total: number }>();
  return (row?.total ?? 1) === 0;
}

export async function findItemByAttemptId(db: D1Database, attemptId: string): Promise<DailyTrainingItemRow | null> {
  const row = await db.prepare("SELECT * FROM daily_training_items WHERE question_attempt_id = ?").bind(attemptId).first<DailyTrainingItemRow>();
  return row ?? null;
}

/** PO v1.1 (seção 4) — `daily_training_events.id` é uma PRIMARY KEY GLOBAL
 *  (nunca escopada por item/lista): reaproveitar um `mutationId` já
 *  consumido por outra mutação REAL — inclusive de OUTRO item/lista deste
 *  mesmo aluno — colide na própria PK, não só numa checagem de
 *  `last_mutation_id` da linha específica sendo mutada agora (que só cobre
 *  reaproveitar o mutationId da ÚLTIMA mutação da MESMA linha). Usado por
 *  `startItem` para transformar essa colisão num 409 controlado, ANTES de
 *  tentar o `db.batch()` — nunca deixar a exceção crua da constraint
 *  escapar como falha genuína. */
export async function dailyTrainingEventIdInUse(db: D1Database, id: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 as found FROM daily_training_events WHERE id = ?").bind(id).first<{ found: number }>();
  return row !== null;
}

/* --------------------------------- Leitura: candidatos --------------------------------- */

export interface PublishedPatternIdRow {
  id: string;
  code: string;
}

/** Todos os padrões publicados, ordenados por código — base para as
 *  camadas 3-6 da seleção (padrões em estado de desenvolvimento/evidência/
 *  consistência/exploração). Nunca inclui rascunho (seção 7 da ordem: só
 *  padrão principal e questão publicada participam). */
export async function listPublishedPatternIds(db: D1Database): Promise<PublishedPatternIdRow[]> {
  const result = await db.prepare("SELECT id, code FROM patterns WHERE editorial_status = 'published' ORDER BY code ASC, id ASC").all<PublishedPatternIdRow>();
  return result.results ?? [];
}

export interface TrainableQuestionRow {
  id: string;
  code: string;
  tempo_estimado_segundos: number | null;
}

/** Questões publicadas cujo padrão PRINCIPAL é `patternId`, ordenadas
 *  deterministicamente (código ASC) — mesmo critério de
 *  questionRepository.ts:findTrainableQuestionForPattern, mas retornando
 *  TODAS as candidatas (não só a primeira), para permitir escolher a
 *  primeira ainda não usada na lista/recentemente concluída (seção 7 da
 *  ordem: "evitar questão concluída recentemente quando houver
 *  alternativa elegível"). */
export async function listTrainableQuestionsForPattern(db: D1Database, patternId: string): Promise<TrainableQuestionRow[]> {
  const result = await db
    .prepare(
      `SELECT q.id, q.code, q.tempo_estimado_segundos FROM questions q
       JOIN question_patterns qp ON qp.question_id = q.id
       WHERE qp.pattern_id = ? AND qp.role = 'principal' AND q.editorial_status = 'published'
       ORDER BY q.code ASC, q.id ASC`
    )
    .bind(patternId)
    .all<TrainableQuestionRow>();
  return result.results ?? [];
}

/** Questões com tentativa CONFIRMADA (completed) por este aluno desde
 *  `sinceIso` — usada para preterir (nunca proibir) reoferecer a mesma
 *  questão logo em seguida (seção 7 da ordem). */
export async function listRecentlyCompletedQuestionIds(db: D1Database, userId: string, sinceIso: string): Promise<Set<string>> {
  const result = await db
    .prepare("SELECT DISTINCT question_id FROM question_attempts WHERE user_id = ? AND status = 'completed' AND completed_at >= ?")
    .bind(userId, sinceIso)
    .all<{ question_id: string }>();
  return new Set((result.results ?? []).map((r) => r.question_id));
}

export interface OverdueReviewCandidateRow {
  entryId: string;
  entryVersion: number;
  originalQuestionId: string;
  primaryPatternId: string | null;
}

/** Revisões vencidas ATIVAS (status = 'scheduled' e já venceram) deste
 *  aluno, ordenadas por vencimento (mais antiga primeiro) — camada 1 da
 *  seção 7 da ordem, prioridade máxima. Nunca inclui entradas arquivadas/
 *  corrigidas/já em revisão. */
export async function listOverdueReviewCandidates(db: D1Database, userId: string, nowIso: string, limit: number): Promise<OverdueReviewCandidateRow[]> {
  const result = await db
    .prepare(
      `SELECT id as entryId, version as entryVersion, original_question_id as originalQuestionId, primary_pattern_id as primaryPatternId
       FROM error_notebook_entries
       WHERE user_id = ? AND status = 'scheduled' AND next_review_at <= ?
       ORDER BY next_review_at ASC, id ASC
       LIMIT ?`
    )
    .bind(userId, nowIso, limit)
    .all<OverdueReviewCandidateRow>();
  return result.results ?? [];
}

export interface ScheduleCommitmentRow {
  assignmentId: string;
  estimatedMinutes: number;
}

/** Compromisso(s) obrigatório(s) do cronograma para HOJE, do tipo "treino
 *  de questões", ainda não concluídos — camada 2 da seção 7 da ordem. O
 *  cronograma (Sprint 5) não referencia uma questão/padrão específico por
 *  atividade (seção 5 daquela ordem: "sem FK inventada para entidade
 *  inexistente"), então o treino diário só usa este compromisso como um
 *  SINAL de prioridade — a questão concreta ainda vem do algoritmo de
 *  seleção por padrão (mesmo pool das camadas 3-6), nunca inventado. */
export async function listTodayScheduleCommitments(db: D1Database, userId: string, todayCivil: string, limit: number): Promise<ScheduleCommitmentRow[]> {
  const result = await db
    .prepare(
      `SELECT sa.id as assignmentId, a.estimated_minutes as estimatedMinutes
       FROM schedule_activity_assignments sa
       JOIN schedule_activities a ON a.id = sa.activity_id
       WHERE sa.user_id = ? AND sa.planned_date = ? AND sa.status IN ('not_started', 'in_progress') AND a.type = 'treino_de_questoes'
       ORDER BY sa.position ASC, sa.id ASC
       LIMIT ?`
    )
    .bind(userId, todayCivil, limit)
    .all<ScheduleCommitmentRow>();
  return result.results ?? [];
}

/** Usado pelo touch-point do Cronograma (seção 13 da ordem): quais
 *  atribuições de hoje já "entraram" numa lista de treino diário ATIVA (a
 *  mais recente, se houver mais de uma no histórico do dia). Somente
 *  leitura. */
export async function listScheduleAssignmentIdsInActiveTraining(db: D1Database, userId: string, todayCivil: string): Promise<Set<string>> {
  const result = await db
    .prepare(
      `SELECT DISTINCT i.source_schedule_assignment_id as assignmentId
       FROM daily_training_items i
       JOIN daily_training_lists l ON l.id = i.list_id
       WHERE l.user_id = ? AND l.training_date = ? AND l.status = 'active' AND i.source_schedule_assignment_id IS NOT NULL`
    )
    .bind(userId, todayCivil)
    .all<{ assignmentId: string }>();
  return new Set((result.results ?? []).map((r) => r.assignmentId));
}

/* --------------------------------- Escrita: lista/itens --------------------------------- */

export function buildInsertListStatement(
  db: D1Database,
  params: { id: string; userId: string; trainingDate: string; timezone: string; estimatedMinutes: number; itemCount: number; mutationId: string }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO daily_training_lists
         (id, user_id, training_date, timezone, status, estimated_minutes, item_count, version, last_mutation_id)
       VALUES (?, ?, ?, ?, 'active', ?, ?, 1, ?)`
    )
    .bind(params.id, params.userId, params.trainingDate, params.timezone, params.estimatedMinutes, params.itemCount, params.mutationId);
}

export function buildInsertItemStatement(
  db: D1Database,
  params: {
    id: string;
    listId: string;
    userId: string;
    questionId: string;
    patternId: string | null;
    origin: string;
    reason: string;
    playerMode: string;
    position: number;
    estimatedMinutes: number;
    errorEntryId: string | null;
    sourceScheduleAssignmentId: string | null;
  }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO daily_training_items
         (id, list_id, user_id, question_id, primary_pattern_id, origin, reason, player_mode, position,
          estimated_minutes, status, error_entry_id, source_schedule_assignment_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    )
    .bind(
      params.id,
      params.listId,
      params.userId,
      params.questionId,
      params.patternId,
      params.origin,
      params.reason,
      params.playerMode,
      params.position,
      params.estimatedMinutes,
      params.errorEntryId,
      params.sourceScheduleAssignmentId
    );
}

/** Evento incondicional — `id` é o próprio `mutationId` já gravado em
 *  daily_training_lists.last_mutation_id pelo INSERT pareado, no MESMO
 *  lote (ver trigger em migrations/0016). */
export function buildListEventInsertStatement(
  db: D1Database,
  params: { id: string; listId: string; userId: string; eventType: "list_created" | "list_completed" | "list_abandoned" }
): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO daily_training_events (id, list_id, item_id, user_id, event_type) VALUES (?, ?, NULL, ?, ?)`)
    .bind(params.id, params.listId, params.userId, params.eventType);
}

export function buildItemEventInsertStatement(
  db: D1Database,
  params: { id: string; listId: string; itemId: string; userId: string; eventType: "item_started" | "item_completed" | "item_skipped" | "item_blocked" }
): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO daily_training_events (id, list_id, item_id, user_id, event_type) VALUES (?, ?, ?, ?, ?)`)
    .bind(params.id, params.listId, params.itemId, params.userId, params.eventType);
}

function itemGuard(): string {
  return "id = ? AND list_id = ? AND user_id = ? AND version = ?";
}

/** Associa atomicamente a tentativa do Player ao item e o move para
 *  `in_progress` (seção 10 da ordem) — guardado por identidade+versão+
 *  status='pending'. Se este UPDATE afetar 0 linhas, NADA foi escrito
 *  (seção 15: "falha ao associar tentativa reverte o estado do item" —
 *  aqui, "reverter" é trivial: o guard nunca deixa um estado parcial). */
export function buildStartItemStatement(
  db: D1Database,
  params: { itemId: string; listId: string; userId: string; guardVersion: number; mutationId: string; questionAttemptId: string }
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE daily_training_items
       SET status = 'in_progress', question_attempt_id = ?, version = version + 1, last_mutation_id = ?, updated_at = datetime('now')
       WHERE ${itemGuard()} AND status = 'pending'`
    )
    .bind(params.questionAttemptId, params.mutationId, params.itemId, params.listId, params.userId, params.guardVersion);
}

/** Retomada idempotente (seção 10: "retry retorna a mesma tentativa") —
 *  quando o item JÁ está `in_progress` com a MESMA tentativa, nenhuma
 *  escrita nova é necessária; este statement nunca é chamado nesse caso
 *  (o serviço decide isso ANTES de montar o lote, mesmo padrão do resto do
 *  projeto). */
export function buildBlockItemStatement(
  db: D1Database,
  params: { itemId: string; listId: string; userId: string; guardVersion: number; mutationId: string }
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE daily_training_items
       SET status = 'blocked', version = version + 1, last_mutation_id = ?, updated_at = datetime('now')
       WHERE ${itemGuard()} AND status = 'pending'`
    )
    .bind(params.mutationId, params.itemId, params.listId, params.userId, params.guardVersion);
}

export function buildCompleteItemStatement(
  db: D1Database,
  params: { itemId: string; listId: string; userId: string; guardVersion: number; mutationId: string }
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE daily_training_items
       SET status = 'completed', version = version + 1, last_mutation_id = ?, updated_at = datetime('now')
       WHERE ${itemGuard()} AND status = 'in_progress'`
    )
    .bind(params.mutationId, params.itemId, params.listId, params.userId, params.guardVersion);
}

export function buildSkipItemStatement(
  db: D1Database,
  params: { itemId: string; listId: string; userId: string; guardVersion: number; mutationId: string; skipReason: string }
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE daily_training_items
       SET status = 'skipped', skip_reason = ?, version = version + 1, last_mutation_id = ?, updated_at = datetime('now')
       WHERE ${itemGuard()} AND status IN ('pending', 'in_progress')`
    )
    .bind(params.skipReason, params.mutationId, params.itemId, params.listId, params.userId, params.guardVersion);
}

function listGuard(): string {
  return "id = ? AND user_id = ? AND version = ?";
}

/** Conclusão da lista (seção 11 da ordem) — o próprio UPDATE já exige, na
 *  MESMA condição guardada (nunca uma checagem em JS separada), que
 *  NENHUM item desta lista esteja fora dos três estados terminais. Se
 *  algum item não-terminal existir, este UPDATE afeta 0 linhas — "aborta
 *  antes do commit" por construção (seção 15 da ordem), sem precisar de
 *  trigger adicional aqui (a condição já está no próprio WHERE). */
export function buildCompleteListStatement(
  db: D1Database,
  params: { listId: string; userId: string; guardVersion: number; mutationId: string }
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE daily_training_lists
       SET status = 'completed', completed_at = datetime('now'), version = version + 1, last_mutation_id = ?, updated_at = datetime('now')
       WHERE ${listGuard()} AND status = 'active'
         AND NOT EXISTS (SELECT 1 FROM daily_training_items WHERE list_id = ? AND status NOT IN ('completed', 'skipped', 'blocked'))`
    )
    .bind(params.mutationId, params.listId, params.userId, params.guardVersion, params.listId);
}

export function buildAbandonListStatement(
  db: D1Database,
  params: { listId: string; userId: string; guardVersion: number; mutationId: string }
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE daily_training_lists
       SET status = 'abandoned', version = version + 1, last_mutation_id = ?, updated_at = datetime('now')
       WHERE ${listGuard()} AND status = 'active'`
    )
    .bind(params.mutationId, params.listId, params.userId, params.guardVersion);
}
