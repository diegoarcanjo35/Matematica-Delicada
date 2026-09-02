/* Repositório do Relatório Semanal e das Metas Realistas — Sprint 13 v1.0.

   Duas metades bem separadas, mesma convenção do resto do projeto:

   1) LEITURA do relatório — 100% somente leitura, consultando diretamente as
      tabelas de evidência REAIS já existentes desde as Sprints 8-12
      (question_attempts, error_notebook_entries, error_review_events,
      daily_training_events, simulation_block_events, schedule_activity_events).
      Nenhuma tabela nova de relatório/snapshot é criada (seção 6 da ordem);
      esta metade nunca grava nada.

   2) ESCRITA das metas — "build*Statement" retornam D1PreparedStatement
      para compor um único db.batch() atômico no serviço
      (worker/src/services/weeklyReviewService.ts), mesmo padrão de
      simulationsRepository.ts/dailyTrainingRepository.ts desde as
      Sprints 11/12.

   Toda consulta é parametrizada; nomes de tabela/coluna são sempre literais
   fixos no código-fonte. O escopo por usuário (`user_id = ?`) está sempre no
   WHERE do SQL — nunca só na camada de aplicação. */

/* ------------------------------------------------------------------------ */
/* Leitura do relatório — agregações factuais por janela de tempo            */
/* ------------------------------------------------------------------------ */

export interface WeekAttemptAggregateRow {
  confirmed_count: number;
  distinct_questions_count: number;
  correct_count: number;
  incorrect_count: number;
  approx_minutes: number;
}

/** Prática "comum" (nunca revisão — seção 12.1 da ordem: "revisão separada
 *  de erro comum") confirmada dentro de `[startSql, endSql)`. Minutos
 *  aproximados: SOMA de `completed_at - started_at` em minutos, mesma
 *  limitação já documentada em studentMetricsRepository.ts (relógio de
 *  parede, não tempo focado). */
export async function getPracticeAggregateForWeek(
  db: D1Database,
  userId: string,
  startSql: string,
  endSql: string
): Promise<WeekAttemptAggregateRow> {
  const row = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS confirmed_count,
         COUNT(DISTINCT CASE WHEN status = 'completed' THEN question_id END) AS distinct_questions_count,
         COALESCE(SUM(CASE WHEN status = 'completed' AND is_correct = 1 THEN 1 ELSE 0 END), 0) AS correct_count,
         COALESCE(SUM(CASE WHEN status = 'completed' AND is_correct = 0 THEN 1 ELSE 0 END), 0) AS incorrect_count,
         COALESCE(SUM(CASE
           WHEN status = 'completed' THEN (julianday(completed_at) - julianday(started_at)) * 1440.0
           ELSE 0
         END), 0) AS approx_minutes
       FROM question_attempts
       WHERE user_id = ? AND error_entry_id IS NULL AND status = 'completed'
         AND completed_at >= ? AND completed_at < ?`
    )
    .bind(userId, startSql, endSql)
    .first<WeekAttemptAggregateRow>();
  return row ?? { confirmed_count: 0, distinct_questions_count: 0, correct_count: 0, incorrect_count: 0, approx_minutes: 0 };
}

export async function countHelpLayersOpenedForWeek(db: D1Database, userId: string, startSql: string, endSql: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total
       FROM question_help_events he
       JOIN question_attempts a ON a.id = he.attempt_id
       WHERE a.user_id = ? AND he.created_at >= ? AND he.created_at < ?`
    )
    .bind(userId, startSql, endSql)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/** Padrões praticados na semana (seção 4.1) — QUALQUER tentativa confirmada
 *  (comum OU revisão; diferente do agregado de acerto/erro acima, que
 *  mantém revisão separada), via padrão PRINCIPAL **e** padrões SECUNDÁRIOS
 *  da questão (PO v1.1, correção B — seção 3 da ordem: "uma questão
 *  confirmada deve gerar evidência para seu padrão principal E seus
 *  padrões secundários vinculados"). Diferente da convenção do Mapa ENEM
 *  (Sprint 10, `studentMetricsRepository.ts`, que filtra deliberadamente só
 *  `role = 'principal'` para evitar dupla contagem PEDAGÓGICA de domínio —
 *  decisão PRÓPRIA daquela sprint, nunca estendida ao relatório semanal): o
 *  relatório semanal quer "quais padrões o aluno tocou nesta semana", não
 *  "de qual padrão este aluno domina evidência confirmada" — um JOIN sem
 *  filtro de `role` é o correto aqui. Nenhuma contagem agregada usa esta
 *  consulta (confirmedQuestionsCount/correctCount/etc. vêm de
 *  `getPracticeAggregateForWeek`/`getReviewAggregateForWeek`, que nunca
 *  fazem JOIN com `question_patterns`) — só a distribuição POR padrão, que
 *  pode legitimamente atribuir a MESMA questão a mais de um padrão. Nunca
 *  duplica o MESMO padrão para a MESMA questão: `question_patterns` tem
 *  índice único `(question_id, pattern_id)` (migration 0007), então um
 *  padrão nunca aparece como principal E secundário da mesma questão ao
 *  mesmo tempo — e o `DISTINCT p.name` acima deduplica quando o MESMO
 *  padrão é evidenciado por questões diferentes na semana. Nomes ordenados
 *  alfabeticamente, mesma convenção de simulationsService.ts. */
export async function listPatternsPracticedForWeek(db: D1Database, userId: string, startSql: string, endSql: string): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT DISTINCT p.name AS name
       FROM question_attempts a
       JOIN question_patterns qp ON qp.question_id = a.question_id
       JOIN patterns p ON p.id = qp.pattern_id
       WHERE a.user_id = ? AND a.status = 'completed' AND a.completed_at >= ? AND a.completed_at < ?
       ORDER BY p.name ASC`
    )
    .bind(userId, startSql, endSql)
    .all<{ name: string }>();
  return (result.results ?? []).map((r) => r.name);
}

export interface WeekReviewAggregateRow {
  reviews_completed: number;
  reviews_correct: number;
  reviews_incorrect: number;
}

export async function getReviewAggregateForWeek(db: D1Database, userId: string, startSql: string, endSql: string): Promise<WeekReviewAggregateRow> {
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS reviews_completed,
         COALESCE(SUM(CASE WHEN result = 'correct' THEN 1 ELSE 0 END), 0) AS reviews_correct,
         COALESCE(SUM(CASE WHEN result = 'incorrect' THEN 1 ELSE 0 END), 0) AS reviews_incorrect
       FROM error_review_events
       WHERE user_id = ? AND created_at >= ? AND created_at < ?`
    )
    .bind(userId, startSql, endSql)
    .first<WeekReviewAggregateRow>();
  return row ?? { reviews_completed: 0, reviews_correct: 0, reviews_incorrect: 0 };
}

export async function countDailyTrainingItemsCompletedForWeek(db: D1Database, userId: string, startSql: string, endSql: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total FROM daily_training_events
       WHERE user_id = ? AND event_type = 'item_completed' AND created_at >= ? AND created_at < ?`
    )
    .bind(userId, startSql, endSql)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function countSimulationBlocksCompletedForWeek(db: D1Database, userId: string, startSql: string, endSql: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total FROM simulation_block_events
       WHERE user_id = ? AND event_type = 'block_completed' AND created_at >= ? AND created_at < ?`
    )
    .bind(userId, startSql, endSql)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export interface WeekScheduleCountsRow {
  completed_count: number;
  rescheduled_count: number;
}

export async function getScheduleCountsForWeek(db: D1Database, userId: string, startSql: string, endSql: string): Promise<WeekScheduleCountsRow> {
  const row = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN to_status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_count,
         COALESCE(SUM(CASE WHEN to_status = 'rescheduled' THEN 1 ELSE 0 END), 0) AS rescheduled_count
       FROM schedule_activity_events
       WHERE user_id = ? AND to_status IN ('completed', 'rescheduled') AND created_at >= ? AND created_at < ?`
    )
    .bind(userId, startSql, endSql)
    .first<WeekScheduleCountsRow>();
  return row ?? { completed_count: 0, rescheduled_count: 0 };
}

export async function countErrorNotebookEntriesCreatedForWeek(db: D1Database, userId: string, startSql: string, endSql: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS total FROM error_notebook_entries WHERE user_id = ? AND created_at >= ? AND created_at < ?`)
    .bind(userId, startSql, endSql)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/** Revisões vencidas — sempre uma leitura do ESTADO ATUAL das entradas
 *  (`nowSql`, nunca uma fronteira de semana passada: não existe tabela de
 *  histórico do campo `next_review_at`, então uma reconstrução retroativa
 *  exata de "vencidas ao FIM de uma semana já encerrada" não é possível com
 *  o schema atual — decisão documentada em docs/RELATORIO_SEMANAL_METAS.md
 *  e na seção 15 do relatório final. O chamador (serviço) só usa este valor
 *  para a semana que contém "hoje"; para semanas passadas, expõe `null`). */
export async function countOverdueReviewsNow(db: D1Database, userId: string, nowSql: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS total FROM error_notebook_entries WHERE user_id = ? AND status = 'scheduled' AND next_review_at <= ?`)
    .bind(userId, nowSql)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/** Todos os instantes (texto, formato `datetime('now')`) de evidência REAL
 *  de estudo dentro da janela — usados pelo serviço só para calcular "dias
 *  com alguma evidência" (convertendo cada instante para a data civil no
 *  fuso do aluno, nunca aqui — esta consulta é agnóstica de fuso). Uma
 *  UNION de cinco fontes reais, sempre escopada por `user_id`. */
export async function listEvidenceInstantsForWeek(db: D1Database, userId: string, startSql: string, endSql: string): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT ts FROM (
         SELECT completed_at AS ts FROM question_attempts WHERE user_id = ? AND status = 'completed' AND completed_at >= ? AND completed_at < ?
         UNION ALL
         SELECT created_at AS ts FROM error_review_events WHERE user_id = ? AND created_at >= ? AND created_at < ?
         UNION ALL
         SELECT created_at AS ts FROM daily_training_events WHERE user_id = ? AND event_type = 'item_completed' AND created_at >= ? AND created_at < ?
         UNION ALL
         SELECT created_at AS ts FROM simulation_block_events WHERE user_id = ? AND event_type = 'item_completed' AND created_at >= ? AND created_at < ?
         UNION ALL
         SELECT created_at AS ts FROM schedule_activity_events WHERE user_id = ? AND to_status = 'completed' AND created_at >= ? AND created_at < ?
       )`
    )
    .bind(userId, startSql, endSql, userId, startSql, endSql, userId, startSql, endSql, userId, startSql, endSql, userId, startSql, endSql)
    .all<{ ts: string }>();
  return (result.results ?? []).map((r) => r.ts);
}

/** Minutos aproximados de REVISÃO (`error_entry_id IS NOT NULL`) — separado
 *  de `getPracticeAggregateForWeek` pela mesma razão (seção 12.1: "revisão
 *  separada de erro comum"); somado ao valor de lá pelo serviço para compor
 *  o total de minutos aproximados da semana (as duas consultas juntas
 *  particionam 100% de `question_attempts`, sem sobreposição nem lacuna). */
export async function getReviewMinutesForWeek(db: D1Database, userId: string, startSql: string, endSql: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM((julianday(completed_at) - julianday(started_at)) * 1440.0), 0) AS approx_minutes
       FROM question_attempts
       WHERE user_id = ? AND error_entry_id IS NOT NULL AND status = 'completed'
         AND completed_at >= ? AND completed_at < ?`
    )
    .bind(userId, startSql, endSql)
    .first<{ approx_minutes: number }>();
  return row?.approx_minutes ?? 0;
}

/** Padrões (id) que receberam QUALQUER prática confirmada (comum OU
 *  revisão) na semana — usado pelo serviço só para calcular quais padrões
 *  PRIORITÁRIOS de uma meta já tiveram alguma prática (seção 4.4: "padrões
 *  prioritários que receberam alguma prática"), nunca para decidir domínio.
 *  PO v1.1 (correção B): inclui padrão PRINCIPAL e SECUNDÁRIO da questão,
 *  mesma razão documentada em `listPatternsPracticedForWeek` acima — um
 *  padrão prioritário de meta escolhido pelo aluno que só aparece como
 *  SECUNDÁRIO numa questão praticada esta semana também conta como
 *  "recebeu prática", nunca fica invisível só por não ser o principal
 *  daquela questão específica. */
export async function listPracticedPatternIdsForWeek(db: D1Database, userId: string, startSql: string, endSql: string): Promise<Set<string>> {
  const result = await db
    .prepare(
      `SELECT DISTINCT qp.pattern_id AS pattern_id
       FROM question_attempts a
       JOIN question_patterns qp ON qp.question_id = a.question_id
       WHERE a.user_id = ? AND a.status = 'completed' AND a.completed_at >= ? AND a.completed_at < ?`
    )
    .bind(userId, startSql, endSql)
    .all<{ pattern_id: string }>();
  return new Set((result.results ?? []).map((r) => r.pattern_id));
}

/** Existência RÁPIDA de qualquer evidência real na semana (usada por
 *  `getHistory`, seção 4.1: "seleção da semana atual e semanas anteriores
 *  disponíveis") — um `EXISTS` combinando as fontes que definem "há algo
 *  para mostrar nesta semana", mais barato que montar o agregado completo
 *  só para decidir se a semana entra na lista de seleção. */
export async function hasAnyEvidenceForWeek(db: D1Database, userId: string, startSql: string, endSql: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT EXISTS(
         SELECT 1 FROM question_attempts WHERE user_id = ? AND status = 'completed' AND completed_at >= ? AND completed_at < ?
         UNION ALL
         SELECT 1 FROM daily_training_events WHERE user_id = ? AND event_type = 'item_completed' AND created_at >= ? AND created_at < ?
         UNION ALL
         SELECT 1 FROM simulation_block_events WHERE user_id = ? AND event_type = 'item_completed' AND created_at >= ? AND created_at < ?
         UNION ALL
         SELECT 1 FROM schedule_activity_events WHERE user_id = ? AND to_status IN ('completed', 'rescheduled') AND created_at >= ? AND created_at < ?
         UNION ALL
         SELECT 1 FROM error_notebook_entries WHERE user_id = ? AND created_at >= ? AND created_at < ?
       ) AS found`
    )
    .bind(userId, startSql, endSql, userId, startSql, endSql, userId, startSql, endSql, userId, startSql, endSql, userId, startSql, endSql)
    .first<{ found: number }>();
  return row?.found === 1;
}

/** Nome de um padrão que o PRÓPRIO ALUNO já escolheu para uma meta (não uma
 *  navegação de catálogo) — deliberadamente SEM filtro de
 *  `editorial_status`: se o padrão for arquivado depois de escolhido, a
 *  meta continua mostrando o nome real (nunca "?"), sem reabrir a porta
 *  para descoberta de conteúdo não publicado (é sempre um `pattern_id` que
 *  o próprio aluno já persistiu em `weekly_goal_patterns`, nunca um valor
 *  arbitrário vindo do cliente nesta função). */
export async function findPatternNameById(db: D1Database, patternId: string): Promise<string | null> {
  const row = await db.prepare("SELECT name FROM patterns WHERE id = ?").bind(patternId).first<{ name: string }>();
  return row?.name ?? null;
}

/* ------------------------------------------------------------------------ */
/* Metas semanais — leitura                                                  */
/* ------------------------------------------------------------------------ */

export interface WeeklyStudyGoalRow {
  id: string;
  user_id: string;
  week_start: string;
  timezone: string;
  available_days: string;
  target_minutes: number;
  target_questions: number;
  status: "active" | "completed" | "abandoned";
  version: number;
  last_mutation_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  abandoned_at: string | null;
}

export interface WeeklyGoalPatternRow {
  id: string;
  goal_id: string;
  user_id: string;
  pattern_id: string;
  priority_position: number;
}

export async function findGoalForUser(db: D1Database, id: string, userId: string): Promise<WeeklyStudyGoalRow | null> {
  const row = await db.prepare("SELECT * FROM weekly_study_goals WHERE id = ? AND user_id = ?").bind(id, userId).first<WeeklyStudyGoalRow>();
  return row ?? null;
}

export async function findActiveGoalForWeek(db: D1Database, userId: string, weekStart: string): Promise<WeeklyStudyGoalRow | null> {
  const row = await db
    .prepare("SELECT * FROM weekly_study_goals WHERE user_id = ? AND week_start = ? AND status = 'active'")
    .bind(userId, weekStart)
    .first<WeeklyStudyGoalRow>();
  return row ?? null;
}

/** A meta mais RELEVANTE desta semana para exibir no relatório — a `active`
 *  quando existir; senão, a mais recentemente atualizada (qualquer status)
 *  entre as já criadas para esta semana. Continua 100% somente leitura. */
export async function findLatestGoalForWeek(db: D1Database, userId: string, weekStart: string): Promise<WeeklyStudyGoalRow | null> {
  const active = await findActiveGoalForWeek(db, userId, weekStart);
  if (active) return active;
  const row = await db
    .prepare("SELECT * FROM weekly_study_goals WHERE user_id = ? AND week_start = ? ORDER BY updated_at DESC, id DESC LIMIT 1")
    .bind(userId, weekStart)
    .first<WeeklyStudyGoalRow>();
  return row ?? null;
}

export async function listPatternsForGoal(db: D1Database, goalId: string): Promise<WeeklyGoalPatternRow[]> {
  const result = await db
    .prepare("SELECT * FROM weekly_goal_patterns WHERE goal_id = ? ORDER BY priority_position ASC")
    .bind(goalId)
    .all<WeeklyGoalPatternRow>();
  return result.results ?? [];
}

/** PK GLOBAL de `weekly_goal_events.id` (mutationId) — mesma checagem
 *  pré-lote de `simulationEventIdInUse`/`dailyTrainingEventIdInUse`: só um
 *  atalho para responder 409 mais cedo; a garantia REAL vem da própria PK,
 *  reagida no catch do `db.batch()` (TOCTOU real, seção 9 da ordem). */
export async function weeklyGoalEventIdInUse(db: D1Database, id: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS found FROM weekly_goal_events WHERE id = ?").bind(id).first<{ found: number }>();
  return row !== null;
}

/* ------------------------------------------------------------------------ */
/* Metas semanais — escrita                                                  */
/* ------------------------------------------------------------------------ */

export function buildInsertGoalStatement(
  db: D1Database,
  params: {
    id: string;
    userId: string;
    weekStart: string;
    timezone: string;
    availableDays: string[];
    targetMinutes: number;
    targetQuestions: number;
    mutationId: string;
  }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO weekly_study_goals
         (id, user_id, week_start, timezone, available_days, target_minutes, target_questions, status, version, last_mutation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, ?)`
    )
    .bind(
      params.id,
      params.userId,
      params.weekStart,
      params.timezone,
      JSON.stringify(params.availableDays),
      params.targetMinutes,
      params.targetQuestions,
      params.mutationId
    );
}

/** `mutationId` (PO v1.1, correção A): a MESMA identidade de mutação da
 *  meta (weekly_study_goals.last_mutation_id / weekly_goal_events.id) desta
 *  operação — carimbada em `weekly_goal_patterns.mutation_id`, nunca um
 *  valor à parte. É o que permite ao trigger consolidado (migrations/0018)
 *  provar, por identidade e ANTES do commit, que a coleção de padrões
 *  resultante pertence de verdade a ESTA mutação (ver a nota extensa no
 *  trigger). */
export function buildInsertGoalPatternStatement(
  db: D1Database,
  params: { id: string; goalId: string; userId: string; patternId: string; priorityPosition: number; mutationId: string }
): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO weekly_goal_patterns (id, goal_id, user_id, pattern_id, priority_position, mutation_id) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(params.id, params.goalId, params.userId, params.patternId, params.priorityPosition, params.mutationId);
}

/** Seção 12.1 da ordem: "PATCH parcial e limpeza explícita da coleção de
 *  padrões" — quando o PATCH inclui uma nova lista de padrões, a coleção
 *  ANTERIOR inteira é removida explicitamente (nunca um `UPSERT` silencioso
 *  que poderia deixar posições órfãs) antes de inserir a nova, no MESMO
 *  db.batch() do serviço. */
export function buildDeleteGoalPatternsStatement(db: D1Database, params: { goalId: string; userId: string }): D1PreparedStatement {
  return db.prepare("DELETE FROM weekly_goal_patterns WHERE goal_id = ? AND user_id = ?").bind(params.goalId, params.userId);
}

/** `patternsExpectedCount` (PO v1.1, correção A): NÃO informado (`undefined`
 *  → grava `NULL`) quando ESTA mutação não tocou weekly_goal_patterns
 *  (PATCH sem `patternIds`, complete, abandon — a coleção permanece
 *  exatamente como estava, o trigger não valida nada aqui); 0..3 quando
 *  tocou (apply sempre grava a coleção do zero; PATCH com `patternIds`
 *  sempre remove tudo e reinsere do zero) — a contagem REAL de linhas que
 *  devem existir, carimbadas com este MESMO `id` (mutationId) em
 *  `weekly_goal_patterns.mutation_id`, depois da escrita. Ver a nota
 *  extensa no trigger (migrations/0018). */
export function buildGoalEventInsertStatement(
  db: D1Database,
  params: {
    id: string;
    goalId: string;
    userId: string;
    eventType: "goal_created" | "goal_updated" | "goal_completed" | "goal_abandoned";
    fromStatus: "active" | "completed" | "abandoned" | null;
    toStatus: "active" | "completed" | "abandoned" | null;
    goalVersion: number;
    patternsExpectedCount?: number | null;
  }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO weekly_goal_events (id, goal_id, user_id, event_type, from_status, to_status, goal_version, patterns_expected_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      params.id,
      params.goalId,
      params.userId,
      params.eventType,
      params.fromStatus,
      params.toStatus,
      params.goalVersion,
      params.patternsExpectedCount ?? null
    );
}

function goalGuard(): string {
  return "id = ? AND user_id = ? AND version = ?";
}

/** PATCH parcial (seção 4.3/9 da ordem) — cada campo só entra no `SET`
 *  quando explicitamente fornecido (mesma disciplina de
 *  errorNotebookRepository.ts:buildPatchEntryStatement), guardado por
 *  identidade+versão+`status = 'active'` (uma meta concluída/abandonada
 *  nunca é editável por PATCH). */
export function buildPatchGoalStatement(
  db: D1Database,
  params: {
    goalId: string;
    userId: string;
    guardVersion: number;
    mutationId: string;
    targetMinutes?: number;
    targetQuestions?: number;
    availableDaysProvided: boolean;
    availableDays: string[];
  }
): D1PreparedStatement {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (params.targetMinutes !== undefined) {
    sets.push("target_minutes = ?");
    values.push(params.targetMinutes);
  }
  if (params.targetQuestions !== undefined) {
    sets.push("target_questions = ?");
    values.push(params.targetQuestions);
  }
  if (params.availableDaysProvided) {
    sets.push("available_days = ?");
    values.push(JSON.stringify(params.availableDays));
  }
  sets.push("version = version + 1", "last_mutation_id = ?", "updated_at = datetime('now')");
  values.push(params.mutationId, params.goalId, params.userId, params.guardVersion);
  return db.prepare(`UPDATE weekly_study_goals SET ${sets.join(", ")} WHERE ${goalGuard()} AND status = 'active'`).bind(...values);
}

export function buildCompleteGoalStatement(db: D1Database, params: { goalId: string; userId: string; guardVersion: number; mutationId: string }): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE weekly_study_goals
       SET status = 'completed', completed_at = datetime('now'), version = version + 1, last_mutation_id = ?, updated_at = datetime('now')
       WHERE ${goalGuard()} AND status = 'active'`
    )
    .bind(params.mutationId, params.goalId, params.userId, params.guardVersion);
}

export function buildAbandonGoalStatement(db: D1Database, params: { goalId: string; userId: string; guardVersion: number; mutationId: string }): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE weekly_study_goals
       SET status = 'abandoned', abandoned_at = datetime('now'), version = version + 1, last_mutation_id = ?, updated_at = datetime('now')
       WHERE ${goalGuard()} AND status = 'active'`
    )
    .bind(params.mutationId, params.goalId, params.userId, params.guardVersion);
}
