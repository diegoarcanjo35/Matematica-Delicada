/* Repositório do diagnóstico inicial — Sprint 4 v1.0. Toda escrita usa
   statements parametrizados. Nomes de tabela/coluna são sempre literais
   fixos no código-fonte (nunca vindos de entrada do usuário). Os
   "build*Statement" retornam D1PreparedStatement para compor um único
   db.batch() atômico no serviço (mesmo padrão das Sprints 2/3). */

import { isLocalDiagnosticFixturesAllowed, type Env } from "../env";

export interface DiagnosticQuestionRow {
  id: string;
  prompt: string;
  position: number;
  is_local_fixture: number;
  created_at: string;
  updated_at: string;
}

export interface DiagnosticOptionRow {
  id: string;
  question_id: string;
  position: number;
  text: string;
  is_correct: number;
}

export interface DiagnosticHelpLayerRow {
  question_id: string;
  layer: number;
  content: string;
}

export interface DiagnosticAttemptRow {
  id: string;
  user_id: string;
  status: "not_started" | "in_progress" | "completed" | "abandoned";
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DiagnosticResponseRow {
  attempt_id: string;
  question_id: string;
  selected_option_id: string | null;
  is_dont_know: number;
  is_correct: number | null;
  recognition_option_id: string | null;
  recognition_is_correct: number | null;
  time_spent_ms: number;
  answered_at: string;
  updated_at: string;
}

export interface DiagnosticHelpOpenRow {
  attempt_id: string;
  question_id: string;
  layer: number;
  opened_at: string;
}

function questionIdPlaceholders(questionIds: string[]): string {
  return questionIds.map(() => "?").join(", ");
}

export async function listQuestionsOrdered(db: D1Database): Promise<DiagnosticQuestionRow[]> {
  const result = await db
    .prepare("SELECT * FROM diagnostic_questions ORDER BY position ASC, id ASC")
    .all<DiagnosticQuestionRow>();
  return result.results ?? [];
}

/** Sprint 16 v1.3 — leitura destinada ao aluno FORA do dev local com a flag
 *  explícita (produção real, ou dev local sem a flag): só questões REAIS
 *  (`is_local_fixture = 0`), nunca uma fixture. Usada por `createAttempt`
 *  quando `fixturesAllowed` é falso — a MESMA função também alimenta a
 *  listagem administrativa (diagnosticAdminRepository.ts a reexporta) —
 *  única fonte de verdade para "quais questões são reais", nunca duas
 *  consultas mantidas em paralelo. */
export async function listRealQuestionsOrdered(db: D1Database): Promise<DiagnosticQuestionRow[]> {
  const result = await db
    .prepare("SELECT * FROM diagnostic_questions WHERE is_local_fixture = 0 ORDER BY position ASC, id ASC")
    .all<DiagnosticQuestionRow>();
  return result.results ?? [];
}

/** Sprint 16 v1.3 — "conteúdo real suficiente para o fluxo funcionar" NÃO é
 *  "existe 1 linha" (seção 2 da ordem, explícito): a regra funcional JÁ
 *  exigida pelo módulo (não inventada aqui) é que uma questão só é
 *  respondível se tiver pelo menos 2 alternativas com exatamente uma
 *  correta — exatamente a mesma invariante que
 *  diagnosticAdminValidation.ts:validateDiagnosticOptionSet já impõe em
 *  toda escrita administrativa. Esta consulta verifica essa estrutura
 *  DIRETAMENTE no banco (defesa em profundidade — nunca confia cegamente
 *  que "foi criada pelo pipeline admin, logo está íntegra") em vez de só
 *  contar linhas de `diagnostic_questions`. `true` assim que UMA questão
 *  real e estruturalmente completa existir. */
export async function hasSufficientRealDiagnosticContent(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 as found FROM diagnostic_questions q
       WHERE q.is_local_fixture = 0
         AND (SELECT COUNT(*) FROM diagnostic_question_options o WHERE o.question_id = q.id) >= 2
         AND EXISTS (SELECT 1 FROM diagnostic_question_options o2 WHERE o2.question_id = q.id AND o2.is_correct = 1)
       LIMIT 1`
    )
    .first<{ found: number }>();
  return row !== null;
}

/** Sprint 16 v1.3, seção 1 da ordem — critério ÚNICO de disponibilidade do
 *  Diagnóstico, mesmo desenho de questionRepository.ts:isQuestionBankAvailable:
 *    1) dev local com ENABLE_LOCAL_DIAGNOSTIC_FIXTURES explicitamente
 *       habilitado -> disponível incondicionalmente (comportamento
 *       IDÊNTICO ao gate antigo, fixtures continuam servidas normalmente);
 *    2) qualquer outro caso (produção real inclusive) -> disponível SOMENTE
 *       quando existir conteúdo real estruturalmente suficiente. */
export async function isDiagnosticAvailable(env: Env, url: URL, db: D1Database): Promise<boolean> {
  if (isLocalDiagnosticFixturesAllowed(env, url)) return true;
  return hasSufficientRealDiagnosticContent(db);
}

export async function findQuestion(db: D1Database, questionId: string): Promise<DiagnosticQuestionRow | null> {
  const row = await db
    .prepare("SELECT * FROM diagnostic_questions WHERE id = ?")
    .bind(questionId)
    .first<DiagnosticQuestionRow>();
  return row ?? null;
}

export async function listOptionsForQuestions(
  db: D1Database,
  questionIds: string[]
): Promise<DiagnosticOptionRow[]> {
  if (questionIds.length === 0) return [];
  const result = await db
    .prepare(
      `SELECT * FROM diagnostic_question_options WHERE question_id IN (${questionIdPlaceholders(questionIds)}) ORDER BY question_id, position ASC`
    )
    .bind(...questionIds)
    .all<DiagnosticOptionRow>();
  return result.results ?? [];
}

export async function listRecognitionOptionsForQuestions(
  db: D1Database,
  questionIds: string[]
): Promise<DiagnosticOptionRow[]> {
  if (questionIds.length === 0) return [];
  const result = await db
    .prepare(
      `SELECT * FROM diagnostic_question_recognition_options WHERE question_id IN (${questionIdPlaceholders(questionIds)}) ORDER BY question_id, position ASC`
    )
    .bind(...questionIds)
    .all<DiagnosticOptionRow>();
  return result.results ?? [];
}

export async function findHelpLayerContent(
  db: D1Database,
  questionId: string,
  layer: number
): Promise<DiagnosticHelpLayerRow | null> {
  const row = await db
    .prepare("SELECT * FROM diagnostic_question_help_layers WHERE question_id = ? AND layer = ?")
    .bind(questionId, layer)
    .first<DiagnosticHelpLayerRow>();
  return row ?? null;
}

export async function listHelpLayersForQuestions(
  db: D1Database,
  questionIds: string[]
): Promise<Array<{ question_id: string; layer: number }>> {
  if (questionIds.length === 0) return [];
  const result = await db
    .prepare(
      `SELECT question_id, layer FROM diagnostic_question_help_layers WHERE question_id IN (${questionIdPlaceholders(questionIds)}) ORDER BY question_id, layer ASC`
    )
    .bind(...questionIds)
    .all<{ question_id: string; layer: number }>();
  return result.results ?? [];
}

export async function findAttempt(db: D1Database, attemptId: string): Promise<DiagnosticAttemptRow | null> {
  const row = await db
    .prepare("SELECT * FROM diagnostic_attempts WHERE id = ?")
    .bind(attemptId)
    .first<DiagnosticAttemptRow>();
  return row ?? null;
}

/** A tentativa ativa mais recente do usuário (para "Continuar diagnóstico"). */
export async function findActiveAttemptForUser(
  db: D1Database,
  userId: string
): Promise<DiagnosticAttemptRow | null> {
  const row = await db
    .prepare(
      "SELECT * FROM diagnostic_attempts WHERE user_id = ? AND status = 'in_progress' ORDER BY created_at DESC LIMIT 1"
    )
    .bind(userId)
    .first<DiagnosticAttemptRow>();
  return row ?? null;
}

/** A última tentativa concluída do usuário (para o resumo factual). */
export async function findLatestCompletedAttemptForUser(
  db: D1Database,
  userId: string
): Promise<DiagnosticAttemptRow | null> {
  const row = await db
    .prepare(
      "SELECT * FROM diagnostic_attempts WHERE user_id = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 1"
    )
    .bind(userId)
    .first<DiagnosticAttemptRow>();
  return row ?? null;
}

export async function listAttemptQuestionIds(db: D1Database, attemptId: string): Promise<string[]> {
  const result = await db
    .prepare("SELECT question_id FROM diagnostic_attempt_questions WHERE attempt_id = ? ORDER BY position ASC")
    .bind(attemptId)
    .all<{ question_id: string }>();
  return (result.results ?? []).map((row) => row.question_id);
}

export async function findResponse(
  db: D1Database,
  attemptId: string,
  questionId: string
): Promise<DiagnosticResponseRow | null> {
  const row = await db
    .prepare("SELECT * FROM diagnostic_responses WHERE attempt_id = ? AND question_id = ?")
    .bind(attemptId, questionId)
    .first<DiagnosticResponseRow>();
  return row ?? null;
}

export async function listResponses(db: D1Database, attemptId: string): Promise<DiagnosticResponseRow[]> {
  const result = await db
    .prepare("SELECT * FROM diagnostic_responses WHERE attempt_id = ?")
    .bind(attemptId)
    .all<DiagnosticResponseRow>();
  return result.results ?? [];
}

export async function listHelpOpens(db: D1Database, attemptId: string): Promise<DiagnosticHelpOpenRow[]> {
  const result = await db
    .prepare("SELECT * FROM diagnostic_help_opens WHERE attempt_id = ?")
    .bind(attemptId)
    .all<DiagnosticHelpOpenRow>();
  return result.results ?? [];
}

export async function findHelpOpen(
  db: D1Database,
  attemptId: string,
  questionId: string,
  layer: number
): Promise<DiagnosticHelpOpenRow | null> {
  const row = await db
    .prepare("SELECT * FROM diagnostic_help_opens WHERE attempt_id = ? AND question_id = ? AND layer = ?")
    .bind(attemptId, questionId, layer)
    .first<DiagnosticHelpOpenRow>();
  return row ?? null;
}

/* ---- Statements atômicos (para compor db.batch() no serviço) ---- */

export function buildCreateAttemptStatement(
  db: D1Database,
  id: string,
  userId: string
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO diagnostic_attempts (id, user_id, status, started_at) VALUES (?, ?, 'in_progress', datetime('now'))"
    )
    .bind(id, userId);
}

export function buildInsertAttemptQuestionStatement(
  db: D1Database,
  attemptId: string,
  questionId: string,
  position: number
): D1PreparedStatement {
  return db
    .prepare("INSERT INTO diagnostic_attempt_questions (attempt_id, question_id, position) VALUES (?, ?, ?)")
    .bind(attemptId, questionId, position);
}

/** Marca uma tentativa em andamento como abandonada — só usado no reinício
 *  explícito (nunca apaga: o histórico da tentativa anterior é preservado). */
export function buildAbandonAttemptStatement(db: D1Database, attemptId: string): D1PreparedStatement {
  return db
    .prepare("UPDATE diagnostic_attempts SET status = 'abandoned', updated_at = datetime('now') WHERE id = ? AND status = 'in_progress'")
    .bind(attemptId);
}

/** Predicado reaproveitado — guarda contra escrita em tentativa já concluída
 *  (seção 8 da ordem: "tentativa concluída não aceita novas respostas/
 *  ajudas"), reavaliado dentro da mesma transação do lote. */
export function attemptInProgressGuardSql(): string {
  return "EXISTS (SELECT 1 FROM diagnostic_attempts WHERE id = ? AND user_id = ? AND status = 'in_progress')";
}

export interface ResponsePatch {
  selectedOptionId: string | null;
  isDontKnow: boolean;
  isCorrect: boolean | null;
  recognitionOptionId: string | null;
  recognitionIsCorrect: boolean | null;
  timeSpentMs: number;
}

/** Salva/substitui a resposta de uma questão — condicionado à tentativa
 *  ainda estar em andamento (mesmo lote da checagem, nunca uma corrida entre
 *  ler o status e gravar). Idempotente: reenviar a mesma resposta produz o
 *  mesmo estado final. */
export function buildUpsertResponseStatement(
  db: D1Database,
  attemptId: string,
  userId: string,
  questionId: string,
  patch: ResponsePatch
): D1PreparedStatement {
  const guard = attemptInProgressGuardSql();
  return db
    .prepare(
      `INSERT INTO diagnostic_responses
         (attempt_id, question_id, selected_option_id, is_dont_know, is_correct, recognition_option_id, recognition_is_correct, time_spent_ms, answered_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now')
       WHERE ${guard}
       ON CONFLICT (attempt_id, question_id) DO UPDATE SET
         selected_option_id = excluded.selected_option_id,
         is_dont_know = excluded.is_dont_know,
         is_correct = excluded.is_correct,
         recognition_option_id = excluded.recognition_option_id,
         recognition_is_correct = excluded.recognition_is_correct,
         time_spent_ms = excluded.time_spent_ms,
         updated_at = datetime('now')
       WHERE ${guard}`
    )
    .bind(
      attemptId,
      questionId,
      patch.selectedOptionId,
      patch.isDontKnow ? 1 : 0,
      patch.isCorrect === null ? null : patch.isCorrect ? 1 : 0,
      patch.recognitionOptionId,
      patch.recognitionIsCorrect === null ? null : patch.recognitionIsCorrect ? 1 : 0,
      patch.timeSpentMs,
      attemptId,
      userId,
      attemptId,
      userId
    );
}

/** Registra a abertura de uma camada de ajuda — idempotente por natureza da
 *  chave primária composta (attempt_id, question_id, layer): reabrir a
 *  mesma camada não duplica nem atualiza timestamp. Condicionado, dentro do
 *  MESMO statement (nunca uma corrida entre ler e gravar — correção v1.2,
 *  seção 3 da ordem):
 *   - tentativa em andamento;
 *   - camada 1 sempre permitida; camada N>1 exige que a camada N-1 já
 *     tenha sido aberta (linha nunca é apagada, então uma vez aberta a
 *     camada anterior continua satisfazendo o pré-requisito para sempre —
 *     inclusive ao reabrir uma camada posterior já aberta antes).
 *  meta.changes decide o resultado no serviço: 1 = abertura nova persistida;
 *  0 = ou já estava aberta (idempotente) ou o gate acima bloqueou — o
 *  serviço distingue os dois lendo o estado após a tentativa. */
export function buildInsertHelpOpenStatement(
  db: D1Database,
  attemptId: string,
  userId: string,
  questionId: string,
  layer: number
): D1PreparedStatement {
  const guard = attemptInProgressGuardSql();
  return db
    .prepare(
      `INSERT INTO diagnostic_help_opens (attempt_id, question_id, layer, opened_at)
       SELECT ?, ?, ?, datetime('now')
       WHERE ${guard}
         AND (? <= 1 OR EXISTS (
           SELECT 1 FROM diagnostic_help_opens WHERE attempt_id = ? AND question_id = ? AND layer = ? - 1
         ))
       ON CONFLICT (attempt_id, question_id, layer) DO NOTHING`
    )
    .bind(attemptId, questionId, layer, attemptId, userId, layer, attemptId, questionId, layer);
}

/** Conclui a tentativa de forma idempotente e segura contra corrida: só a
 *  chamada que efetivamente transiciona in_progress -> completed vê
 *  meta.changes === 1; qualquer chamada concorrente ou repetida vê 0 e
 *  reaproveita o mesmo resultado já persistido — nunca gera dois resultados
 *  (seção 8/9 da ordem). */
export function buildCompleteAttemptStatement(
  db: D1Database,
  attemptId: string,
  userId: string
): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE diagnostic_attempts SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND user_id = ? AND status = 'in_progress'"
    )
    .bind(attemptId, userId);
}
