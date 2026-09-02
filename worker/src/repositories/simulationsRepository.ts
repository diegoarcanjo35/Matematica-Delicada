/* Repositório dos Simulados em Blocos — Sprint 12 v1.0.

   Mesma convenção do resto do projeto: consultas parametrizadas, nomes de
   tabela/coluna sempre literais fixos, `user_id` SEMPRE no WHERE do SQL
   (nunca só na camada de aplicação), "build*Statement" retornam
   D1PreparedStatement para compor um único db.batch() atômico no serviço.

   As funções de LEITURA de candidatos (seção "Candidatos" abaixo) são
   100% somente-leitura — usadas tanto pelo preview (GET, nunca escreve)
   quanto pelo apply (recomputa o mesmo cálculo antes de persistir, seção 7
   da ordem: "preview... determinístico para... o estado do banco"). */

import { listPublishedPatternIds, listRecentlyCompletedQuestionIds, listTrainableQuestionsForPattern } from "./dailyTrainingRepository";

export { listPublishedPatternIds, listRecentlyCompletedQuestionIds, listTrainableQuestionsForPattern };

export interface SimulationBlockRow {
  id: string;
  user_id: string;
  block_type: "mixed" | "pattern_focused";
  primary_pattern_id: string | null;
  status: "active" | "completed" | "abandoned";
  planned_item_count: number;
  actual_item_count: number;
  estimated_minutes: number;
  timezone: string;
  block_date: string;
  version: number;
  last_mutation_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  abandoned_at: string | null;
}

export interface SimulationBlockItemRow {
  id: string;
  block_id: string;
  user_id: string;
  question_id: string;
  primary_pattern_id: string | null;
  position: number;
  status: "pending" | "in_progress" | "completed" | "skipped" | "blocked";
  question_attempt_id: string | null;
  estimated_minutes: number;
  version: number;
  last_mutation_id: string | null;
  created_at: string;
  updated_at: string;
}

const TERMINAL_ITEM_STATUSES = ["completed", "skipped", "blocked"];

/* --------------------------------- Leitura: blocos/itens --------------------------------- */

export async function findBlockForUser(db: D1Database, id: string, userId: string): Promise<SimulationBlockRow | null> {
  const row = await db.prepare("SELECT * FROM simulation_blocks WHERE id = ? AND user_id = ?").bind(id, userId).first<SimulationBlockRow>();
  return row ?? null;
}

/** Bloco ATIVO do aluno — no máximo um, por construção do índice único
 *  parcial (migrations/0017). Nunca cria nada. */
export async function findActiveBlockForUser(db: D1Database, userId: string): Promise<SimulationBlockRow | null> {
  const row = await db.prepare("SELECT * FROM simulation_blocks WHERE user_id = ? AND status = 'active'").bind(userId).first<SimulationBlockRow>();
  return row ?? null;
}

export async function listItemsForBlock(db: D1Database, blockId: string): Promise<SimulationBlockItemRow[]> {
  const result = await db
    .prepare("SELECT * FROM simulation_block_items WHERE block_id = ? ORDER BY position ASC")
    .bind(blockId)
    .all<SimulationBlockItemRow>();
  return result.results ?? [];
}

/** Item pertencente a um bloco específico E a este usuário — usado por toda
 *  rota `:blockId/items/:itemId/...` para rejeitar (404) tanto um item de
 *  outro aluno quanto um item de OUTRO bloco deste mesmo aluno (seção 17 da
 *  ordem: "tentativa, item ou bloco de outro aluno retorna 404"). */
export async function findItemForBlockAndUser(db: D1Database, itemId: string, blockId: string, userId: string): Promise<SimulationBlockItemRow | null> {
  const row = await db
    .prepare("SELECT * FROM simulation_block_items WHERE id = ? AND block_id = ? AND user_id = ?")
    .bind(itemId, blockId, userId)
    .first<SimulationBlockItemRow>();
  return row ?? null;
}

export async function allItemsTerminal(db: D1Database, blockId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT COUNT(*) as total FROM simulation_block_items WHERE block_id = ? AND status NOT IN (${TERMINAL_ITEM_STATUSES.map(() => "?").join(", ")})`)
    .bind(blockId, ...TERMINAL_ITEM_STATUSES)
    .first<{ total: number }>();
  return (row?.total ?? 1) === 0;
}

/** Mesmo raciocínio de dailyTrainingEventIdInUse (worker/src/repositories/
 *  dailyTrainingRepository.ts, PO Sprint 11 v1.1, seção 4 daquela ordem):
 *  `simulation_block_events.id` é uma PRIMARY KEY GLOBAL — reaproveitar um
 *  `mutationId` já consumido por outra mutação REAL (inclusive de outro
 *  item/bloco deste mesmo aluno) colide na própria PK. Usado para
 *  transformar essa colisão num 409 controlado ANTES de tentar o
 *  `db.batch()` — nunca deixar a exceção crua da constraint escapar como
 *  falha genuína. */
export async function simulationEventIdInUse(db: D1Database, id: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 as found FROM simulation_block_events WHERE id = ?").bind(id).first<{ found: number }>();
  return row !== null;
}

/* --------------------------------- Leitura: histórico --------------------------------- */

export interface HistoryBlockRow extends SimulationBlockRow {
  completed_count: number;
  correct_count: number;
  incorrect_count: number;
}

/** Histórico REAL, paginado, somente leitura (seção 14 da ordem) — blocos
 *  `completed`/`abandoned` deste aluno, mais recentes primeiro, com
 *  contagens factuais agregadas por consulta correlata (nunca uma tabela de
 *  agregação separada). Paginação por keyset (created_at, id) — mesma
 *  convenção determinística do resto do projeto, nunca OFFSET puro (que
 *  pode pular/repetir linhas se um novo bloco for concluído entre páginas). */
export async function listBlockHistoryForUser(
  db: D1Database,
  userId: string,
  limit: number,
  before: { createdAt: string; id: string } | null
): Promise<HistoryBlockRow[]> {
  const cursorClause = before ? "AND (b.created_at < ? OR (b.created_at = ? AND b.id < ?))" : "";
  const cursorParams = before ? [before.createdAt, before.createdAt, before.id] : [];
  const result = await db
    .prepare(
      `SELECT b.*,
         (SELECT COUNT(*) FROM simulation_block_items i WHERE i.block_id = b.id AND i.status = 'completed') as completed_count,
         (SELECT COUNT(*) FROM simulation_block_items i JOIN question_attempts a ON a.id = i.question_attempt_id
            WHERE i.block_id = b.id AND i.status = 'completed' AND a.is_correct = 1) as correct_count,
         (SELECT COUNT(*) FROM simulation_block_items i JOIN question_attempts a ON a.id = i.question_attempt_id
            WHERE i.block_id = b.id AND i.status = 'completed' AND a.is_correct = 0) as incorrect_count
       FROM simulation_blocks b
       WHERE b.user_id = ? AND b.status IN ('completed', 'abandoned') ${cursorClause}
       ORDER BY b.created_at DESC, b.id DESC
       LIMIT ?`
    )
    .bind(userId, ...cursorParams, limit)
    .all<HistoryBlockRow>();
  return result.results ?? [];
}

/* --------------------------------- Escrita: bloco/itens --------------------------------- */

export function buildInsertBlockStatement(
  db: D1Database,
  params: {
    id: string;
    userId: string;
    blockType: "mixed" | "pattern_focused";
    primaryPatternId: string | null;
    plannedItemCount: number;
    actualItemCount: number;
    estimatedMinutes: number;
    timezone: string;
    blockDate: string;
    mutationId: string;
  }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO simulation_blocks
         (id, user_id, block_type, primary_pattern_id, status, planned_item_count, actual_item_count,
          estimated_minutes, timezone, block_date, version, last_mutation_id)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, 1, ?)`
    )
    .bind(
      params.id,
      params.userId,
      params.blockType,
      params.primaryPatternId,
      params.plannedItemCount,
      params.actualItemCount,
      params.estimatedMinutes,
      params.timezone,
      params.blockDate,
      params.mutationId
    );
}

export function buildInsertItemStatement(
  db: D1Database,
  params: {
    id: string;
    blockId: string;
    userId: string;
    questionId: string;
    patternId: string | null;
    position: number;
    estimatedMinutes: number;
  }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO simulation_block_items
         (id, block_id, user_id, question_id, primary_pattern_id, position, estimated_minutes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
    )
    .bind(params.id, params.blockId, params.userId, params.questionId, params.patternId, params.position, params.estimatedMinutes);
}

/** Evento incondicional — `id` é o próprio `mutationId` já gravado em
 *  simulation_blocks.last_mutation_id pelo INSERT/UPDATE pareado, no MESMO
 *  lote (ver trigger em migrations/0017). */
export function buildBlockEventInsertStatement(
  db: D1Database,
  params: { id: string; blockId: string; userId: string; eventType: "block_applied" | "block_completed" | "block_abandoned" }
): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO simulation_block_events (id, block_id, item_id, user_id, event_type) VALUES (?, ?, NULL, ?, ?)`)
    .bind(params.id, params.blockId, params.userId, params.eventType);
}

export function buildItemEventInsertStatement(
  db: D1Database,
  params: { id: string; blockId: string; itemId: string; userId: string; eventType: "item_started" | "item_completed" | "item_skipped" | "item_blocked" }
): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO simulation_block_events (id, block_id, item_id, user_id, event_type) VALUES (?, ?, ?, ?, ?)`)
    .bind(params.id, params.blockId, params.itemId, params.userId, params.eventType);
}

function itemGuard(): string {
  return "id = ? AND block_id = ? AND user_id = ? AND version = ?";
}

/** Associa atomicamente a tentativa do Player ao item e o move para
 *  `in_progress` (seção 10 da ordem) — guardado por identidade+versão+
 *  status='pending'. Se este UPDATE afetar 0 linhas, NADA foi escrito. */
export function buildStartItemStatement(
  db: D1Database,
  params: { itemId: string; blockId: string; userId: string; guardVersion: number; mutationId: string; questionAttemptId: string }
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE simulation_block_items
       SET status = 'in_progress', question_attempt_id = ?, version = version + 1, last_mutation_id = ?, updated_at = datetime('now')
       WHERE ${itemGuard()} AND status = 'pending'`
    )
    .bind(params.questionAttemptId, params.mutationId, params.itemId, params.blockId, params.userId, params.guardVersion);
}

/** Item cuja questão deixou de estar disponível (despublicada) entre o
 *  apply e a tentativa de início — mesmo papel de buildBlockItemStatement do
 *  Treino Diário (dailyTrainingRepository.ts). */
export function buildMarkItemBlockedStatement(
  db: D1Database,
  params: { itemId: string; blockId: string; userId: string; guardVersion: number; mutationId: string }
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE simulation_block_items
       SET status = 'blocked', version = version + 1, last_mutation_id = ?, updated_at = datetime('now')
       WHERE ${itemGuard()} AND status = 'pending'`
    )
    .bind(params.mutationId, params.itemId, params.blockId, params.userId, params.guardVersion);
}

export function buildCompleteItemStatement(
  db: D1Database,
  params: { itemId: string; blockId: string; userId: string; guardVersion: number; mutationId: string }
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE simulation_block_items
       SET status = 'completed', version = version + 1, last_mutation_id = ?, updated_at = datetime('now')
       WHERE ${itemGuard()} AND status = 'in_progress'`
    )
    .bind(params.mutationId, params.itemId, params.blockId, params.userId, params.guardVersion);
}

export function buildSkipItemStatement(
  db: D1Database,
  params: { itemId: string; blockId: string; userId: string; guardVersion: number; mutationId: string }
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE simulation_block_items
       SET status = 'skipped', version = version + 1, last_mutation_id = ?, updated_at = datetime('now')
       WHERE ${itemGuard()} AND status IN ('pending', 'in_progress')`
    )
    .bind(params.mutationId, params.itemId, params.blockId, params.userId, params.guardVersion);
}

function blockGuard(): string {
  return "id = ? AND user_id = ? AND version = ?";
}

/** Conclusão do bloco (seção 12 da ordem) — o próprio UPDATE já exige, na
 *  MESMA condição guardada (nunca uma checagem em JS separada), que NENHUM
 *  item deste bloco esteja fora dos três estados terminais. Se algum item
 *  não-terminal existir, este UPDATE afeta 0 linhas — "aborta antes do
 *  commit" por construção (seção 19 da ordem). */
export function buildCompleteBlockStatement(
  db: D1Database,
  params: { blockId: string; userId: string; guardVersion: number; mutationId: string }
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE simulation_blocks
       SET status = 'completed', completed_at = datetime('now'), version = version + 1, last_mutation_id = ?, updated_at = datetime('now')
       WHERE ${blockGuard()} AND status = 'active'
         AND NOT EXISTS (SELECT 1 FROM simulation_block_items WHERE block_id = ? AND status NOT IN ('completed', 'skipped', 'blocked'))`
    )
    .bind(params.mutationId, params.blockId, params.userId, params.guardVersion, params.blockId);
}

export function buildAbandonBlockStatement(
  db: D1Database,
  params: { blockId: string; userId: string; guardVersion: number; mutationId: string }
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE simulation_blocks
       SET status = 'abandoned', abandoned_at = datetime('now'), version = version + 1, last_mutation_id = ?, updated_at = datetime('now')
       WHERE ${blockGuard()} AND status = 'active'`
    )
    .bind(params.mutationId, params.blockId, params.userId, params.guardVersion);
}
