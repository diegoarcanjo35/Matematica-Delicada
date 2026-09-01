/* Repositório de evidências do Mapa ENEM — Sprint 10 v1.0.

   100% SOMENTE LEITURA. Nenhuma função aqui grava linha nenhuma — nenhum
   INSERT/UPDATE/DELETE, nenhum db.batch(). Cada função é uma consulta
   derivada direta sobre as tabelas de evidência já existentes desde as
   Sprints 6-9 (migrations 0007, 0008, 0013, 0014) — ver a justificativa
   completa em migrations/0015_student_metrics_map.sql sobre por que esta
   sprint não usa nenhuma tabela de projeção persistida.

   Convenção de padrão PRINCIPAL x SECUNDÁRIO (seção 12 da ordem,
   documentada também em docs/METRICAS_MAPA_ENEM.md): toda consulta aqui
   filtra `question_patterns.role = 'principal'` — um vínculo `secundario`
   nunca contribui para nenhuma métrica desta sprint. Isso evita
   contagem dupla por construção: cada questão contribui para, no
   máximo, UM padrão nas métricas do Mapa ENEM v1.0.

   Convenção de modo x apresentação (mesma de
   migrations/0014_error_notebook_spaced_review.sql): uma tentativa com
   `error_entry_id IS NOT NULL` é sempre contada como "revisão", nunca
   como "prática", mesmo que `mode` tecnicamente continue `practice` no
   banco.

   Toda consulta é parametrizada; nomes de tabela/coluna são sempre
   literais fixos no código-fonte. O escopo por usuário (`user_id = ?`)
   está sempre no WHERE do SQL — nunca só na camada de aplicação (mesma
   disciplina de patternsRepository.ts/errorNotebookRepository.ts). */

export interface PatternEvidenceRow {
  patternId: string;
  questionsStarted: number;
  questionsConfirmed: number;
  confirmedAttempts: number;
  correctCount: number;
  incorrectCount: number;
  distinctQuestionsUsed: number;
  /* v1.1 (correção PO, seção 1 da ordem): dias-calendário DISTINTOS
   *  (`date(completed_at)`) em que houve ao menos uma tentativa CONFIRMADA
   *  deste padrão — usado por deriveProvisionalState para exigir evidência
   *  espalhada por mais de um momento/sessão, nunca só um recorte de um
   *  único dia. É um PROXY técnico por data-calendário, não uma sessão de
   *  navegador real: duas práticas no MESMO dia, horas distantes uma da
   *  outra, ainda contam como UM único "dia de prática" — limitação
   *  conhecida e documentada (não há coluna de sessão real no schema),
   *  mesma classe de ressalva já usada para `approxTimeSeconds`. */
  distinctPracticeDays: number;
  /* v1.2 (correção PO, seção 1 da ordem): data/hora (`completed_at`) da
   *  PRIMEIRA tentativa CONFIRMADA deste padrão — junto com `lastPracticeAt`
   *  (já existente, é a ÚLTIMA), forma a base do cálculo do intervalo de
   *  manutenção usado por `hasMaintenanceEvidence` em
   *  worker/src/lib/studentMetricsRules.ts (evidência sustentada sem
   *  revisão prévia, para o aluno que nunca errou). `null` só quando não há
   *  nenhuma tentativa confirmada. */
  firstConfirmedAt: string | null;
  attemptsLearning: number;
  attemptsPractice: number;
  attemptsRecognition: number;
  attemptsReview: number;
  highestHelpLayer: number;
  /* v1.1 (correção PO, seção 1 da ordem): quantas tentativas CONFIRMADAS
   *  deste padrão tiveram ao menos uma camada de ajuda aberta — base do
   *  cálculo de dependência de ajuda em studentMetricsRules.ts (nunca o
   *  total bruto de aberturas de camada, que infla o mesmo evento de ajuda
   *  repetido várias vezes numa única tentativa). */
  attemptsWithHelp: number;
  approxTimeSeconds: number;
  lastPracticeAt: string | null;
  recognitionsLogged: number;
  helpOpens: number;
  activeErrorEntryId: string | null;
  activeErrorEntryStatus: string | null;
  nextReviewAt: string | null;
  lastReviewedAt: string | null;
  reviewsCorrect: number;
  reviewsIncorrect: number;
}

interface AttemptAggregateRaw {
  questions_started: number;
  questions_confirmed: number;
  confirmed_attempts: number;
  correct_count: number;
  incorrect_count: number;
  distinct_questions_used: number;
  distinct_practice_days: number;
  first_confirmed_at: string | null;
  attempts_learning: number;
  attempts_practice: number;
  attempts_recognition: number;
  attempts_review: number;
  highest_help_layer: number | null;
  last_practice_at: string | null;
  approx_time_seconds: number | null;
}

/** Agregado principal: tentativas CONFIRMADAS (status='completed') apontam
 *  para acerto/erro/tempo/último-praticado; tentativa `in_progress` ou
 *  `abandoned` nunca vira acerto/erro confirmado (seção 12 da ordem) — só
 *  entra em `questions_started` (uma questão "iniciada" é qualquer questão
 *  com ao menos uma tentativa, confirmada ou não).
 *
 *  Tempo aproximado (seção 6): SOMA de `completed_at - started_at` em
 *  segundos, só de tentativas confirmadas — mesma limitação documentada já
 *  usada no Diagnóstico/Player (relógio de parede, não tempo focado; uma
 *  aba deixada aberta infla o número — documentado em
 *  docs/METRICAS_MAPA_ENEM.md, nunca escondido do aluno). */
async function getAttemptAggregate(
  db: D1Database,
  userId: string,
  patternId: string
): Promise<AttemptAggregateRaw> {
  const row = await db
    .prepare(
      `SELECT
         COUNT(DISTINCT a.question_id) AS questions_started,
         COUNT(DISTINCT CASE WHEN a.status = 'completed' THEN a.question_id END) AS questions_confirmed,
         COALESCE(SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END), 0) AS confirmed_attempts,
         COALESCE(SUM(CASE WHEN a.status = 'completed' AND a.is_correct = 1 THEN 1 ELSE 0 END), 0) AS correct_count,
         COALESCE(SUM(CASE WHEN a.status = 'completed' AND a.is_correct = 0 THEN 1 ELSE 0 END), 0) AS incorrect_count,
         COUNT(DISTINCT CASE WHEN a.status = 'completed' THEN a.question_id END) AS distinct_questions_used,
         COUNT(DISTINCT CASE WHEN a.status = 'completed' THEN date(a.completed_at) END) AS distinct_practice_days,
         MIN(CASE WHEN a.status = 'completed' THEN a.completed_at END) AS first_confirmed_at,
         COALESCE(SUM(CASE WHEN a.status = 'completed' AND a.mode = 'learning' THEN 1 ELSE 0 END), 0) AS attempts_learning,
         COALESCE(SUM(CASE WHEN a.status = 'completed' AND a.mode = 'practice' AND a.error_entry_id IS NULL THEN 1 ELSE 0 END), 0) AS attempts_practice,
         COALESCE(SUM(CASE WHEN a.status = 'completed' AND a.mode = 'recognition' THEN 1 ELSE 0 END), 0) AS attempts_recognition,
         COALESCE(SUM(CASE WHEN a.status = 'completed' AND a.error_entry_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS attempts_review,
         COALESCE(MAX(a.highest_help_layer), 0) AS highest_help_layer,
         MAX(CASE WHEN a.status = 'completed' THEN a.completed_at END) AS last_practice_at,
         COALESCE(SUM(CASE
           WHEN a.status = 'completed' AND a.completed_at IS NOT NULL
           THEN (julianday(a.completed_at) - julianday(a.started_at)) * 86400.0
           ELSE 0
         END), 0) AS approx_time_seconds
       FROM question_attempts a
       JOIN question_patterns qp ON qp.question_id = a.question_id AND qp.role = 'principal'
       WHERE a.user_id = ? AND qp.pattern_id = ?`
    )
    .bind(userId, patternId)
    .first<AttemptAggregateRaw>();
  return (
    row ?? {
      questions_started: 0,
      questions_confirmed: 0,
      confirmed_attempts: 0,
      correct_count: 0,
      incorrect_count: 0,
      distinct_questions_used: 0,
      distinct_practice_days: 0,
      first_confirmed_at: null,
      attempts_learning: 0,
      attempts_practice: 0,
      attempts_recognition: 0,
      attempts_review: 0,
      highest_help_layer: 0,
      last_practice_at: null,
      approx_time_seconds: 0,
    }
  );
}

async function countRecognitionsLogged(db: D1Database, userId: string, patternId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total
       FROM question_recognition_events re
       JOIN question_attempts a ON a.id = re.attempt_id
       JOIN question_patterns qp ON qp.question_id = a.question_id AND qp.role = 'principal'
       WHERE a.user_id = ? AND qp.pattern_id = ?`
    )
    .bind(userId, patternId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

async function countHelpOpens(db: D1Database, userId: string, patternId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total
       FROM question_help_events he
       JOIN question_attempts a ON a.id = he.attempt_id
       JOIN question_patterns qp ON qp.question_id = a.question_id AND qp.role = 'principal'
       WHERE a.user_id = ? AND qp.pattern_id = ?`
    )
    .bind(userId, patternId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/** v1.1 (correção PO, seção 1 da ordem): quantas tentativas CONFIRMADAS
 *  distintas deste padrão tiveram ao menos uma camada de ajuda aberta —
 *  `COUNT(DISTINCT he.attempt_id)`, nunca o total bruto de eventos de
 *  ajuda (`countHelpOpens` acima), que conta cada camada aberta
 *  separadamente e infla o mesmo evento de ajuda várias vezes numa única
 *  tentativa. Só tentativas `completed` contam — uma tentativa abandonada
 *  que abriu ajuda nunca é evidência confirmada (mesma convenção do resto
 *  do repositório: seção 12, "tentativa incompleta nunca vira acerto/erro
 *  confirmado"). Base do cálculo de dependência de ajuda em
 *  worker/src/lib/studentMetricsRules.ts (bloqueia `consistente_no_recorte`
 *  quando a proporção de tentativas confirmadas com ajuda é alta). */
async function countAttemptsWithHelp(db: D1Database, userId: string, patternId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT he.attempt_id) AS total
       FROM question_help_events he
       JOIN question_attempts a ON a.id = he.attempt_id AND a.status = 'completed'
       JOIN question_patterns qp ON qp.question_id = a.question_id AND qp.role = 'principal'
       WHERE a.user_id = ? AND qp.pattern_id = ?`
    )
    .bind(userId, patternId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

interface ActiveEntryRow {
  id: string;
  status: string;
  next_review_at: string | null;
  last_reviewed_at: string | null;
}

/** Entrada ATIVA (nunca `archived`) do Caderno de Erros deste padrão, a
 *  mais próxima de vencer primeiro. `primary_pattern_id` já é o mesmo
 *  padrão principal atribuído pela Sprint 9 (nunca recomputado aqui). */
async function findActiveErrorEntry(db: D1Database, userId: string, patternId: string): Promise<ActiveEntryRow | null> {
  const row = await db
    .prepare(
      `SELECT id, status, next_review_at, last_reviewed_at
       FROM error_notebook_entries
       WHERE user_id = ? AND primary_pattern_id = ? AND status != 'archived' AND status != 'corrected'
       ORDER BY next_review_at ASC, id ASC
       LIMIT 1`
    )
    .bind(userId, patternId)
    .first<ActiveEntryRow>();
  return row ?? null;
}

async function getReviewCounts(db: D1Database, userId: string, patternId: string): Promise<{ correct: number; incorrect: number }> {
  const row = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN r.result = 'correct' THEN 1 ELSE 0 END), 0) AS correct,
         COALESCE(SUM(CASE WHEN r.result = 'incorrect' THEN 1 ELSE 0 END), 0) AS incorrect
       FROM error_review_events r
       JOIN error_notebook_entries e ON e.id = r.entry_id
       WHERE r.user_id = ? AND e.primary_pattern_id = ?`
    )
    .bind(userId, patternId)
    .first<{ correct: number | null; incorrect: number | null }>();
  return { correct: row?.correct ?? 0, incorrect: row?.incorrect ?? 0 };
}

/** Evidência completa de UM padrão para UM aluno — usada tanto pela lista
 *  (seção 9, chamada uma vez por padrão publicado; volume de fixtures
 *  locais não justifica uma única mega-consulta agregada — mesma decisão
 *  de simplicidade documentada em migrations/0015) quanto pelo detalhe
 *  (seção 10). Nunca lança para outro usuário: todo WHERE inclui
 *  `user_id = ?`. */
export async function getPatternEvidence(db: D1Database, userId: string, patternId: string): Promise<PatternEvidenceRow> {
  const [attempts, recognitionsLogged, helpOpens, attemptsWithHelp, activeEntry, reviews] = await Promise.all([
    getAttemptAggregate(db, userId, patternId),
    countRecognitionsLogged(db, userId, patternId),
    countHelpOpens(db, userId, patternId),
    countAttemptsWithHelp(db, userId, patternId),
    findActiveErrorEntry(db, userId, patternId),
    getReviewCounts(db, userId, patternId),
  ]);

  return {
    patternId,
    questionsStarted: attempts.questions_started,
    questionsConfirmed: attempts.questions_confirmed,
    confirmedAttempts: attempts.confirmed_attempts,
    correctCount: attempts.correct_count,
    incorrectCount: attempts.incorrect_count,
    distinctQuestionsUsed: attempts.distinct_questions_used,
    distinctPracticeDays: attempts.distinct_practice_days,
    firstConfirmedAt: attempts.first_confirmed_at,
    attemptsLearning: attempts.attempts_learning,
    attemptsPractice: attempts.attempts_practice,
    attemptsRecognition: attempts.attempts_recognition,
    attemptsReview: attempts.attempts_review,
    highestHelpLayer: attempts.highest_help_layer ?? 0,
    attemptsWithHelp,
    approxTimeSeconds: Math.round(attempts.approx_time_seconds ?? 0),
    lastPracticeAt: attempts.last_practice_at,
    recognitionsLogged,
    helpOpens,
    activeErrorEntryId: activeEntry?.id ?? null,
    activeErrorEntryStatus: activeEntry?.status ?? null,
    nextReviewAt: activeEntry?.next_review_at ?? null,
    lastReviewedAt: activeEntry?.last_reviewed_at ?? null,
    reviewsCorrect: reviews.correct,
    reviewsIncorrect: reviews.incorrect,
  };
}

export interface RecentActivityRow {
  kind: "answer" | "recognition" | "help" | "review";
  patternId: string | null;
  questionId: string;
  createdAt: string;
  isCorrect: number | null;
  reviewResult: string | null;
}

/** Atividade recente do aluno (endpoint `/activity`, seção 8) — só
 *  metadados técnicos, NUNCA texto livre (seção 13: nenhum comentário/nota
 *  em resposta agregada). Uma UNION de quatro fontes reais, sempre
 *  escopada por `user_id`, ordenada por data decrescente. `limit` é
 *  sempre aplicado no SQL, nunca só no cliente. */
export async function listRecentActivity(db: D1Database, userId: string, limit: number): Promise<RecentActivityRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM (
         SELECT 'answer' AS kind, qp.pattern_id AS pattern_id, a.question_id AS question_id,
                a.completed_at AS created_at, a.is_correct AS is_correct, NULL AS review_result
         FROM question_attempts a
         LEFT JOIN question_patterns qp ON qp.question_id = a.question_id AND qp.role = 'principal'
         WHERE a.user_id = ? AND a.status = 'completed' AND a.completed_at IS NOT NULL

         UNION ALL

         SELECT 'recognition' AS kind, re.pattern_id AS pattern_id, a.question_id AS question_id,
                re.created_at AS created_at, NULL AS is_correct, NULL AS review_result
         FROM question_recognition_events re
         JOIN question_attempts a ON a.id = re.attempt_id
         WHERE a.user_id = ?

         UNION ALL

         SELECT 'help' AS kind, qp.pattern_id AS pattern_id, a.question_id AS question_id,
                he.created_at AS created_at, NULL AS is_correct, NULL AS review_result
         FROM question_help_events he
         JOIN question_attempts a ON a.id = he.attempt_id
         LEFT JOIN question_patterns qp ON qp.question_id = a.question_id AND qp.role = 'principal'
         WHERE a.user_id = ?

         UNION ALL

         SELECT 'review' AS kind, e.primary_pattern_id AS pattern_id, r.reviewed_question_id AS question_id,
                r.created_at AS created_at, NULL AS is_correct, r.result AS review_result
         FROM error_review_events r
         JOIN error_notebook_entries e ON e.id = r.entry_id
         WHERE r.user_id = ?
       )
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .bind(userId, userId, userId, userId, limit)
    .all<RecentActivityRow & { pattern_id: string | null; question_id: string; created_at: string; is_correct: number | null; review_result: string | null }>();
  return (result.results ?? []).map((row) => ({
    kind: row.kind,
    patternId: row.pattern_id,
    questionId: row.question_id,
    createdAt: row.created_at,
    isCorrect: row.is_correct,
    reviewResult: row.review_result,
  }));
}
