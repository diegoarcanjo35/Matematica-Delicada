/* Repositório do Caderno de Erros — Sprint 9 v1.0.

   Mesma convenção do resto do projeto: consultas parametrizadas, nomes de
   tabela/coluna sempre literais fixos, `user_id` SEMPRE no WHERE do SQL
   (nunca só na camada de aplicação — seção 10 da ordem), "build*Statement"
   retornam D1PreparedStatement para compor um único db.batch() atômico no
   serviço. */

export interface ErrorNotebookEntryRow {
  id: string;
  user_id: string;
  original_question_id: string;
  original_attempt_id: string;
  latest_attempt_id: string;
  primary_pattern_id: string | null;
  error_type: string;
  student_note: string | null;
  status: string;
  error_count: number;
  review_stage: number;
  distinct_review_questions_succeeded: number;
  first_error_at: string;
  last_error_at: string;
  last_reviewed_at: string | null;
  next_review_at: string;
  corrected_at: string | null;
  version: number;
  last_mutation_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ErrorReviewEventRow {
  id: string;
  entry_id: string;
  user_id: string;
  attempt_id: string;
  reviewed_question_id: string;
  result: "correct" | "incorrect";
  previous_stage: number;
  resulting_stage: number;
  previous_next_review_at: string;
  resulting_next_review_at: string;
  used_different_question: number;
  created_at: string;
}

/* --------------------------------- Leitura --------------------------------- */

export async function findEntryById(db: D1Database, id: string, userId: string): Promise<ErrorNotebookEntryRow | null> {
  const row = await db.prepare("SELECT * FROM error_notebook_entries WHERE id = ? AND user_id = ?").bind(id, userId).first<ErrorNotebookEntryRow>();
  return row ?? null;
}

export async function findEntryByUserAndQuestion(db: D1Database, userId: string, originalQuestionId: string): Promise<ErrorNotebookEntryRow | null> {
  const row = await db
    .prepare("SELECT * FROM error_notebook_entries WHERE user_id = ? AND original_question_id = ?")
    .bind(userId, originalQuestionId)
    .first<ErrorNotebookEntryRow>();
  return row ?? null;
}

/** Usada pelo trigger de atomicidade indiretamente (via `last_mutation_id`
 *  gravado pelo próprio serviço) e diretamente pelos testes, para
 *  confirmar por identidade qual mutação gravou uma entrada por último. */
export async function findEntryByMutationId(db: D1Database, mutationId: string): Promise<ErrorNotebookEntryRow | null> {
  const row = await db.prepare("SELECT * FROM error_notebook_entries WHERE last_mutation_id = ?").bind(mutationId).first<ErrorNotebookEntryRow>();
  return row ?? null;
}

export interface ListFilters {
  patternId?: string;
  errorType?: string;
  status?: string;
  overdueOnly?: boolean;
  scheduledFrom?: string;
  scheduledTo?: string;
  includeArchived?: boolean;
  limit: number;
  offset: number;
}

/** GET 100% somente leitura (seção 9.1). Filtros combinados por AND;
 *  "vencida" (overdueOnly) é DERIVADO em tempo de consulta
 *  (`status = 'scheduled' AND next_review_at <= now`) — nunca um valor
 *  `due` persistido por um job em segundo plano (este projeto não tem
 *  infraestrutura de cron; ver docs/CADERNO_ERROS_REVISAO.md). Arquivadas
 *  ficam de fora por padrão (seção 9.3), só aparecem com
 *  `includeArchived: true`. Ordenação determinística
 *  (next_review_at ASC, id ASC) — paginação por LIMIT/OFFSET nunca perde
 *  nem duplica página ao avançar. */
export async function listEntries(db: D1Database, userId: string, filters: ListFilters, nowIso: string): Promise<ErrorNotebookEntryRow[]> {
  const conditions: string[] = ["user_id = ?"];
  const params: unknown[] = [userId];

  if (!filters.includeArchived) {
    conditions.push("status != 'archived'");
  }
  if (filters.patternId) {
    conditions.push("primary_pattern_id = ?");
    params.push(filters.patternId);
  }
  if (filters.errorType) {
    conditions.push("error_type = ?");
    params.push(filters.errorType);
  }
  if (filters.status) {
    conditions.push("status = ?");
    params.push(filters.status);
  }
  if (filters.overdueOnly) {
    conditions.push("status = 'scheduled' AND next_review_at <= ?");
    params.push(nowIso);
  }
  if (filters.scheduledFrom) {
    conditions.push("next_review_at >= ?");
    params.push(filters.scheduledFrom);
  }
  if (filters.scheduledTo) {
    conditions.push("next_review_at <= ?");
    params.push(filters.scheduledTo);
  }

  const sql = `SELECT * FROM error_notebook_entries WHERE ${conditions.join(" AND ")} ORDER BY next_review_at ASC, id ASC LIMIT ? OFFSET ?`;
  params.push(filters.limit, filters.offset);
  const result = await db.prepare(sql).bind(...params).all<ErrorNotebookEntryRow>();
  return result.results ?? [];
}

export async function countEntries(db: D1Database, userId: string, filters: Omit<ListFilters, "limit" | "offset">, nowIso: string): Promise<number> {
  const conditions: string[] = ["user_id = ?"];
  const params: unknown[] = [userId];
  if (!filters.includeArchived) conditions.push("status != 'archived'");
  if (filters.patternId) {
    conditions.push("primary_pattern_id = ?");
    params.push(filters.patternId);
  }
  if (filters.errorType) {
    conditions.push("error_type = ?");
    params.push(filters.errorType);
  }
  if (filters.status) {
    conditions.push("status = ?");
    params.push(filters.status);
  }
  if (filters.overdueOnly) {
    conditions.push("status = 'scheduled' AND next_review_at <= ?");
    params.push(nowIso);
  }
  if (filters.scheduledFrom) {
    conditions.push("next_review_at >= ?");
    params.push(filters.scheduledFrom);
  }
  if (filters.scheduledTo) {
    conditions.push("next_review_at <= ?");
    params.push(filters.scheduledTo);
  }
  const sql = `SELECT COUNT(*) as total FROM error_notebook_entries WHERE ${conditions.join(" AND ")}`;
  const row = await db.prepare(sql).bind(...params).first<{ total: number }>();
  return row?.total ?? 0;
}

export interface SummaryRow {
  active: number;
  overdue: number;
  corrected: number;
  total: number;
}

/** Resumo real (seção 12.1/13.2) — nunca métrica fabricada. `active` =
 *  não arquivada e não corrigida; `overdue` = agendada e vencida;
 *  `corrected`; `total` = todas as entradas já registradas (inclui
 *  arquivadas — é "erros registrados", não "erros ativos"). */
export async function summaryForUser(db: D1Database, userId: string, nowIso: string): Promise<SummaryRow> {
  const row = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN status NOT IN ('archived', 'corrected') THEN 1 ELSE 0 END) as active,
         SUM(CASE WHEN status = 'scheduled' AND next_review_at <= ? THEN 1 ELSE 0 END) as overdue,
         SUM(CASE WHEN status = 'corrected' THEN 1 ELSE 0 END) as corrected,
         COUNT(*) as total
       FROM error_notebook_entries WHERE user_id = ?`
    )
    .bind(nowIso, userId)
    .first<{ active: number | null; overdue: number | null; corrected: number | null; total: number }>();
  return { active: row?.active ?? 0, overdue: row?.overdue ?? 0, corrected: row?.corrected ?? 0, total: row?.total ?? 0 };
}

/** Sprint 14 v1.0 — contagem por tipo de erro (ordem seção 13: "tipos de
 *  erro quando já estruturados"). Só metadados agregados (tipo + contagem),
 *  nunca a anotação livre do aluno (`student_note`) — nem esta função nem
 *  nenhuma outra deste repositório retornam esse campo para fora de
 *  `error_notebook_entries` inteira. Arquivadas ficam de fora, mesmo
 *  critério de `listEntries`/`summaryForUser` para "registros ativos". */
export async function countByErrorType(db: D1Database, userId: string): Promise<Record<string, number>> {
  const result = await db
    .prepare(
      `SELECT error_type as errorType, COUNT(*) as total
       FROM error_notebook_entries
       WHERE user_id = ? AND status != 'archived'
       GROUP BY error_type`
    )
    .bind(userId)
    .all<{ errorType: string; total: number }>();
  const counts: Record<string, number> = {};
  for (const row of result.results ?? []) counts[row.errorType] = row.total;
  return counts;
}

export async function listReviewEventsForEntry(db: D1Database, entryId: string): Promise<ErrorReviewEventRow[]> {
  const result = await db
    .prepare("SELECT * FROM error_review_events WHERE entry_id = ? ORDER BY created_at ASC")
    .bind(entryId)
    .all<ErrorReviewEventRow>();
  return result.results ?? [];
}

/** Quantas revisões CORRETAS já existem para `questionId` especificamente
 *  dentro desta entrada — usada para decidir se uma revisão correta bem-
 *  sucedida aumenta `distinct_review_questions_succeeded` (só aumenta na
 *  PRIMEIRA vez que aquela questão específica é resolvida corretamente
 *  para esta entrada, nunca a cada repetição). */
export async function hasSuccessfulReviewForQuestion(db: D1Database, entryId: string, questionId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 as found FROM error_review_events WHERE entry_id = ? AND reviewed_question_id = ? AND result = 'correct' LIMIT 1")
    .bind(entryId, questionId)
    .first<{ found: number }>();
  return row !== null;
}

/* --------------------------------- Escrita --------------------------------- */

function entryGuard(): string {
  return "id = ? AND user_id = ? AND version = ?";
}

/** Primeira entrada para (user_id, original_question_id) — INCONDICIONAL
 *  (não há concorrência a resolver aqui num INSERT puro; se OUTRA
 *  confirmação concorrente já tiver criado a entrada primeiro, o índice
 *  único (user_id, original_question_id) rejeita esta com violação de
 *  unicidade — o serviço trata isso como "já existe, relê e atualiza" —
 *  mesmo padrão de playerService.ts:startOrResumeAttempt desde a Sprint 8). */
export function buildCreateEntryStatement(
  db: D1Database,
  params: {
    id: string;
    userId: string;
    originalQuestionId: string;
    originalAttemptId: string;
    primaryPatternId: string | null;
    mutationId: string;
    nowIso: string;
    nextReviewAt: string;
  }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO error_notebook_entries
         (id, user_id, original_question_id, original_attempt_id, latest_attempt_id, primary_pattern_id,
          error_type, status, error_count, review_stage, distinct_review_questions_succeeded,
          first_error_at, last_error_at, next_review_at, version, last_mutation_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'unclassified', 'scheduled', 1, 0, 0, ?, ?, ?, 1, ?, ?, ?)`
    )
    .bind(
      params.id,
      params.userId,
      params.originalQuestionId,
      params.originalAttemptId,
      params.originalAttemptId,
      params.primaryPatternId,
      params.nowIso,
      params.nowIso,
      params.nextReviewAt,
      params.mutationId,
      params.nowIso,
      params.nowIso
    );
}

/** Novo erro na MESMA questão original (seção 5 da ordem): incrementa
 *  `error_count`, atualiza `latest_attempt_id`/`last_error_at`, reagenda
 *  a próxima revisão para +1 dia a partir de AGORA (o erro reapareceu —
 *  o agendamento anterior não faz mais sentido) e reseta `review_stage`
 *  para 0. Se a entrada estava `corrected`/`archived`, reativa para
 *  `scheduled` (decisão explícita — ver docs/CADERNO_ERROS_REVISAO.md,
 *  "Reativação automática"): uma nova ocorrência independente do MESMO
 *  erro é evidência nova que sobrepõe tanto uma correção anterior quanto
 *  um arquivamento manual. `corrected_at` é limpo (a correção anterior
 *  não é mais válida). Guardado por identidade+versão (mesma concorrência
 *  otimista do resto do projeto) — se o guard falhar (0 linhas), o
 *  trigger de atomicidade (migrations/0014) aborta a transação inteira. */
/** Sprint 9 v1.1 (correção C, PO) — reativação FORMALIZADA de entradas
 *  `corrected`/`archived`: um novo erro independente na MESMA questão
 *  original nunca deve ficar escondido atrás de uma correção ou de um
 *  arquivamento anteriores. Volta explicitamente para
 *  `pending_understanding` (não `scheduled` — decisão explícita desta
 *  versão: a reativação sinaliza "precisa ser entendida de novo", não
 *  apenas "retomar um agendamento anterior"), reseta `review_stage` para
 *  0, limpa `corrected_at`, incrementa `error_count`, atualiza
 *  `last_error_at`, agenda a próxima revisão em +1 dia — os mesmos
 *  efeitos tanto para `corrected` quanto para `archived`. Provado por
 *  teste direto no banco (worker/testing/errorNotebook.test.ts,
 *  "reativação"). */
export function buildIncrementEntryStatement(
  db: D1Database,
  params: { entryId: string; userId: string; guardVersion: number; mutationId: string; latestAttemptId: string; nowIso: string; nextReviewAt: string }
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE error_notebook_entries
       SET error_count = error_count + 1,
           latest_attempt_id = ?,
           last_error_at = ?,
           review_stage = 0,
           next_review_at = ?,
           status = CASE WHEN status IN ('corrected', 'archived') THEN 'pending_understanding' ELSE status END,
           corrected_at = CASE WHEN status IN ('corrected', 'archived') THEN NULL ELSE corrected_at END,
           version = version + 1,
           last_mutation_id = ?,
           updated_at = ?
       WHERE ${entryGuard()}`
    )
    .bind(params.latestAttemptId, params.nowIso, params.nextReviewAt, params.mutationId, params.nowIso, params.entryId, params.userId, params.guardVersion);
}

/** Conclusão de revisão (seção 8.3): atualiza estágio/status/agenda a
 *  partir do resultado já calculado pelo serviço
 *  (worker/src/lib/spacedReview.ts) — este statement só GRAVA, nunca
 *  decide a regra de negócio. `distinctIncrement` é 0 ou 1 (nunca
 *  calculado aqui — decidido no serviço via
 *  hasSuccessfulReviewForQuestion ANTES de montar o lote). */
export function buildCompleteReviewEntryStatement(
  db: D1Database,
  params: {
    entryId: string;
    userId: string;
    guardVersion: number;
    mutationId: string;
    resultingStage: number;
    status: string;
    nextReviewAt: string;
    distinctIncrement: 0 | 1;
    correctedAt: string | null;
    nowIso: string;
  }
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE error_notebook_entries
       SET review_stage = ?,
           status = ?,
           next_review_at = ?,
           last_reviewed_at = ?,
           distinct_review_questions_succeeded = distinct_review_questions_succeeded + ?,
           corrected_at = ?,
           version = version + 1,
           last_mutation_id = ?,
           updated_at = ?
       WHERE ${entryGuard()} AND status != 'archived'`
    )
    .bind(
      params.resultingStage,
      params.status,
      params.nextReviewAt,
      params.nowIso,
      params.distinctIncrement,
      params.correctedAt,
      params.mutationId,
      params.nowIso,
      params.entryId,
      params.userId,
      params.guardVersion
    );
}

export function buildReviewEventInsertStatement(
  db: D1Database,
  params: {
    id: string;
    entryId: string;
    userId: string;
    attemptId: string;
    reviewedQuestionId: string;
    result: "correct" | "incorrect";
    previousStage: number;
    resultingStage: number;
    previousNextReviewAt: string;
    resultingNextReviewAt: string;
    usedDifferentQuestion: boolean;
  }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO error_review_events
         (id, entry_id, user_id, attempt_id, reviewed_question_id, result, previous_stage, resulting_stage,
          previous_next_review_at, resulting_next_review_at, used_different_question)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      params.id,
      params.entryId,
      params.userId,
      params.attemptId,
      params.reviewedQuestionId,
      params.result,
      params.previousStage,
      params.resultingStage,
      params.previousNextReviewAt,
      params.resultingNextReviewAt,
      params.usedDifferentQuestion ? 1 : 0
    );
}

/** PATCH parcial (seção 9.2) — `errorType`/`studentNote` só incluídos no
 *  SET quando `isProvided` (mesma disciplina de PATCH parcial real já
 *  usada por editorial/player desde as Sprints 7-8), guardado por
 *  identidade+versão. */
export function buildPatchEntryStatement(
  db: D1Database,
  params: {
    entryId: string;
    userId: string;
    guardVersion: number;
    mutationId: string;
    errorType?: string;
    studentNoteProvided: boolean;
    studentNote: string | null;
    nowIso: string;
  }
): D1PreparedStatement {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (params.errorType !== undefined) {
    sets.push("error_type = ?");
    values.push(params.errorType);
  }
  if (params.studentNoteProvided) {
    sets.push("student_note = ?");
    values.push(params.studentNote);
  }
  sets.push("version = version + 1", "last_mutation_id = ?", "updated_at = ?");
  values.push(params.mutationId, params.nowIso);
  values.push(params.entryId, params.userId, params.guardVersion);
  return db.prepare(`UPDATE error_notebook_entries SET ${sets.join(", ")} WHERE ${entryGuard()}`).bind(...values);
}

/** Arquivar/desarquivar (seção 9.3) — idempotente, guardado por
 *  identidade+versão; nunca apaga histórico (só muda `status`). */
export function buildArchiveEntryStatement(
  db: D1Database,
  params: { entryId: string; userId: string; guardVersion: number; mutationId: string; nowIso: string }
): D1PreparedStatement {
  return db
    .prepare(`UPDATE error_notebook_entries SET status = 'archived', version = version + 1, last_mutation_id = ?, updated_at = ? WHERE ${entryGuard()}`)
    .bind(params.mutationId, params.nowIso, params.entryId, params.userId, params.guardVersion);
}

/** Marca a entrada `in_review` (seção 8.1) — só quando uma tentativa
 *  válida existe de verdade (o serviço só chama isto DEPOIS de criar/
 *  retomar a tentativa com sucesso, nunca antes). Guardado por
 *  identidade+versão; idempotente (repetir com o mesmo `mutationId` não
 *  duplica nada — chamado só uma vez por início real de revisão). */
export function buildMarkInReviewStatement(
  db: D1Database,
  params: { entryId: string; userId: string; guardVersion: number; mutationId: string; nowIso: string }
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE error_notebook_entries SET status = 'in_review', version = version + 1, last_mutation_id = ?, updated_at = ?
       WHERE ${entryGuard()} AND status != 'archived'`
    )
    .bind(params.mutationId, params.nowIso, params.entryId, params.userId, params.guardVersion);
}

/* ------------------------------ Seleção semelhante ------------------------------ */

export interface SimilarQuestionSelection {
  questionId: string;
  reason:
    | "same_pattern_excluding_used"
    | "original_not_yet_succeeded"
    | "same_pattern_including_used"
    | "original_fallback_no_pattern"
    | "original_fallback_no_alternative";
}

/** Seção 7 da ordem — seleção DETERMINÍSTICA (nunca ORDER BY RANDOM()) de
 *  questão semelhante para "Corrigir meu erro". `excludeQuestionIds` aqui
 *  significa especificamente "questões já usadas COM SUCESSO nesta
 *  entrada" (nunca inclui a original nele — a original é tratada à parte,
 *  como seu próprio degrau, para permitir o critério de "outro contexto"
 *  da seção 6.1 avançar mesmo quando só existe UMA questão semelhante
 *  publicada). Ordem de tentativa, cada uma já determinística por si
 *  (ORDER BY code ASC, mesmo critério de
 *  questionRepository.ts:findTrainableQuestionForPattern):
 *    1) mesmo padrão principal, publicada, excluindo a original E as já
 *       usadas com sucesso — uma questão semelhante GENUINAMENTE NOVA;
 *    2) se não houver, e a questão ORIGINAL em si ainda não tiver sido
 *       usada com sucesso nesta entrada, oferecer a original — permite
 *       ao aluno provar domínio nela também, contribuindo para o critério
 *       de 2 questões distintas mesmo com só 1 alternativa disponível;
 *    3) mesmo padrão principal, publicada, excluindo só a original (a
 *       original já foi usada com sucesso, ou não existe — reaproveitar
 *       uma questão semelhante já resolvida corretamente é melhor que só
 *       sobrar a original de novo);
 *    4) a questão original (fallback final — sempre existe, é a própria
 *       entrada).
 *  Nunca revela rascunho nem questão de outro padrão/contexto (todo
 *  filtro exige `editorial_status = 'published'`). */
export async function selectSimilarQuestion(
  db: D1Database,
  params: { originalQuestionId: string; primaryPatternId: string | null; excludeQuestionIds: string[] }
): Promise<SimilarQuestionSelection> {
  if (!params.primaryPatternId) {
    return { questionId: params.originalQuestionId, reason: "original_fallback_no_pattern" };
  }

  const succeeded = new Set(params.excludeQuestionIds);
  const excludeStrict = Array.from(new Set([params.originalQuestionId, ...succeeded]));
  const placeholdersStrict = excludeStrict.map(() => "?").join(", ");
  const strict = await db
    .prepare(
      `SELECT q.id FROM questions q
       JOIN question_patterns qp ON qp.question_id = q.id
       WHERE qp.pattern_id = ? AND qp.role = 'principal' AND q.editorial_status = 'published'
         AND q.id NOT IN (${placeholdersStrict})
       ORDER BY q.code ASC
       LIMIT 1`
    )
    .bind(params.primaryPatternId, ...excludeStrict)
    .first<{ id: string }>();
  if (strict) return { questionId: strict.id, reason: "same_pattern_excluding_used" };

  if (!succeeded.has(params.originalQuestionId)) {
    return { questionId: params.originalQuestionId, reason: "original_not_yet_succeeded" };
  }

  const relaxed = await db
    .prepare(
      `SELECT q.id FROM questions q
       JOIN question_patterns qp ON qp.question_id = q.id
       WHERE qp.pattern_id = ? AND qp.role = 'principal' AND q.editorial_status = 'published'
         AND q.id != ?
       ORDER BY q.code ASC
       LIMIT 1`
    )
    .bind(params.primaryPatternId, params.originalQuestionId)
    .first<{ id: string }>();
  if (relaxed) return { questionId: relaxed.id, reason: "same_pattern_including_used" };

  return { questionId: params.originalQuestionId, reason: "original_fallback_no_alternative" };
}
