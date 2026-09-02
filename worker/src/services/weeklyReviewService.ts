/* Serviço do Relatório Semanal e das Metas Realistas — Sprint 13 v1.0.

   Duas metades, mesma separação do repositório:

   1) RELATÓRIO — 100% derivado em leitura (getReportForWeek/getHistory);
      nunca grava nada, nunca audita (seção 4.1/10 da ordem).

   2) METAS — preview (leitura pura) + apply/patch/complete/abandon
      (mutação explícita, atômica e idempotente por IDENTIDADE de
      `mutationId`, nunca por igualdade de conteúdo — seção 9 da ordem,
      mesmo padrão comprovado em worker/src/services/simulationsService.ts/
      dailyTrainingService.ts desde as Sprints 11/12).

   Relógio SEMPRE injetável (seção 5 da ordem): nunca `new Date()`/
   `Date.now()` direto aqui — só `clock.now()`, reaproveitando exatamente o
   mesmo `Clock`/`systemClock` de scheduleService.ts. */

import {
  countDailyTrainingItemsCompletedForWeek,
  countErrorNotebookEntriesCreatedForWeek,
  countHelpLayersOpenedForWeek,
  countOverdueReviewsNow,
  countSimulationBlocksCompletedForWeek,
  findActiveGoalForWeek,
  findGoalForUser,
  findLatestGoalForWeek,
  findPatternNameById,
  buildCompleteGoalStatement,
  buildAbandonGoalStatement,
  buildDeleteGoalPatternsStatement,
  buildGoalEventInsertStatement,
  buildInsertGoalPatternStatement,
  buildInsertGoalStatement,
  buildPatchGoalStatement,
  getPracticeAggregateForWeek,
  getReviewAggregateForWeek,
  getReviewMinutesForWeek,
  getScheduleCountsForWeek,
  hasAnyEvidenceForWeek,
  listEvidenceInstantsForWeek,
  listPatternsForGoal,
  listPatternsPracticedForWeek,
  listPracticedPatternIdsForWeek,
  weeklyGoalEventIdInUse,
  type WeeklyGoalPatternRow,
  type WeeklyStudyGoalRow,
} from "../repositories/weeklyReviewRepository";
import { findProfile } from "../repositories/onboardingRepository";
import { findPublishedPatternById } from "../repositories/patternsRepository";
import { listPublishedPatternIds } from "../repositories/dailyTrainingRepository";
import { getPatternEvidence } from "../repositories/studentMetricsRepository";
import { deriveProvisionalState } from "../lib/studentMetricsRules";
import { getTimezone, systemClock, type Clock } from "./scheduleService";
import {
  addCivilDays,
  civilDateInTimezone,
  civilMidnightInstant,
  mondayOfCivilWeek,
  parseSqliteInstant,
  toSqliteInstant,
  validateVersion,
  type WeekdayCode,
} from "../lib/scheduleValidation";
import {
  computeGoalProgressPercents,
  selectSuggestedPatterns,
  suggestWeeklyMinutes,
  suggestWeeklyQuestions,
  validateAvailableDays,
  validatePatternIds,
  validateTargetMinutes,
  validateTargetQuestions,
  validateWeekStartFormat,
  type PatternCandidate,
  type SuggestedPattern,
} from "../lib/weeklyGoalRules";

function newId(): string {
  return crypto.randomUUID();
}

const WEEKDAY_CODES: readonly WeekdayCode[] = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"];
function isWeekdayCode(value: string): value is WeekdayCode {
  return (WEEKDAY_CODES as readonly string[]).includes(value);
}

export interface MutationResult<T> {
  ok: boolean;
  value?: T;
  notFound?: boolean;
  conflict?: boolean;
  activeElsewhere?: boolean;
  fieldErrors?: Record<string, string>;
  changed?: boolean;
}

/* ------------------------------------------------------------------------ */
/* Relatório semanal factual                                                 */
/* ------------------------------------------------------------------------ */

export interface WeeklyComparisonDto {
  previousWeekStart: string;
  available: boolean;
  deltas: {
    confirmedQuestionsCount: number;
    correctCount: number;
    incorrectCount: number;
    daysWithEvidenceCount: number;
    approxMinutes: number | null;
  } | null;
}

export interface WeeklyReportDto {
  weekStart: string;
  weekEnd: string;
  timezone: string;
  isCurrentWeek: boolean;
  hasAnyEvidence: boolean;
  approxMinutes: number | null;
  confirmedQuestionsCount: number;
  distinctQuestionsCount: number;
  correctCount: number;
  incorrectCount: number;
  patternsPracticed: string[];
  helpLayersOpenedCount: number;
  dailyTrainingItemsCompleted: number;
  simulationBlocksCompleted: number;
  scheduleCompletedCount: number;
  scheduleRescheduledCount: number;
  errorNotebookEntriesCreated: number;
  reviewsCompletedCount: number;
  reviewsCorrectCount: number;
  reviewsIncorrectCount: number;
  /** Só não-nulo para a semana que contém "hoje" — ver a nota extensa em
   *  weeklyReviewRepository.ts:countOverdueReviewsNow sobre por que uma
   *  reconstrução retroativa exata para semanas já encerradas não é
   *  possível com o schema atual (documentado também em
   *  docs/RELATORIO_SEMANAL_METAS.md). */
  overdueReviewsAtWeekEnd: number | null;
  daysWithEvidenceCount: number;
  comparison: WeeklyComparisonDto;
  goal: GoalDto | null;
}

interface WeekAggregate {
  weekStart: string;
  weekEnd: string;
  timezone: string;
  isCurrentWeek: boolean;
  hasAnyEvidence: boolean;
  approxMinutes: number | null;
  confirmedQuestionsCount: number;
  distinctQuestionsCount: number;
  correctCount: number;
  incorrectCount: number;
  patternsPracticed: string[];
  helpLayersOpenedCount: number;
  dailyTrainingItemsCompleted: number;
  simulationBlocksCompleted: number;
  scheduleCompletedCount: number;
  scheduleRescheduledCount: number;
  errorNotebookEntriesCreated: number;
  reviewsCompletedCount: number;
  reviewsCorrectCount: number;
  reviewsIncorrectCount: number;
  overdueReviewsAtWeekEnd: number | null;
  daysWithEvidenceCount: number;
}

/** Núcleo puro-de-leitura (seção 4.1 da ordem) — calcula TODOS os fatos de
 *  UMA semana civil, sem comparação nem meta anexada (composição fica a
 *  cargo de `getReportForWeek`, que chama isto duas vezes: semana
 *  selecionada + semana anterior). Nunca fabrica zero quando não há
 *  evidência — `approxMinutes` é `null`, nunca `0`, quando nenhuma tentativa
 *  confirmada existe na semana. */
async function computeWeekAggregate(db: D1Database, userId: string, weekStart: string, timezone: string, clock: Clock): Promise<WeekAggregate> {
  const weekEnd = addCivilDays(weekStart, 6);
  const startSql = toSqliteInstant(civilMidnightInstant(weekStart, timezone));
  const endSql = toSqliteInstant(civilMidnightInstant(addCivilDays(weekStart, 7), timezone));
  const todayCivil = civilDateInTimezone(clock.now(), timezone);
  const isCurrentWeek = mondayOfCivilWeek(todayCivil) === weekStart;

  const [practice, reviewMinutes, reviewAgg, patternsPracticed, helpCount, dtItemsCompleted, simBlocksCompleted, scheduleCounts, entriesCreated, evidenceInstants] =
    await Promise.all([
      getPracticeAggregateForWeek(db, userId, startSql, endSql),
      getReviewMinutesForWeek(db, userId, startSql, endSql),
      getReviewAggregateForWeek(db, userId, startSql, endSql),
      listPatternsPracticedForWeek(db, userId, startSql, endSql),
      countHelpLayersOpenedForWeek(db, userId, startSql, endSql),
      countDailyTrainingItemsCompletedForWeek(db, userId, startSql, endSql),
      countSimulationBlocksCompletedForWeek(db, userId, startSql, endSql),
      getScheduleCountsForWeek(db, userId, startSql, endSql),
      countErrorNotebookEntriesCreatedForWeek(db, userId, startSql, endSql),
      listEvidenceInstantsForWeek(db, userId, startSql, endSql),
    ]);

  const confirmedQuestionsCount = practice.confirmed_count + reviewAgg.reviews_completed;
  const hasAnyEvidence =
    confirmedQuestionsCount > 0 ||
    dtItemsCompleted > 0 ||
    simBlocksCompleted > 0 ||
    scheduleCounts.completed_count > 0 ||
    scheduleCounts.rescheduled_count > 0 ||
    entriesCreated > 0;

  const daysWithEvidence = new Set(evidenceInstants.map((ts) => civilDateInTimezone(parseSqliteInstant(ts), timezone)));

  let overdueReviewsAtWeekEnd: number | null = null;
  if (isCurrentWeek) {
    overdueReviewsAtWeekEnd = await countOverdueReviewsNow(db, userId, toSqliteInstant(clock.now()));
  }

  return {
    weekStart,
    weekEnd,
    timezone,
    isCurrentWeek,
    hasAnyEvidence,
    approxMinutes: confirmedQuestionsCount > 0 ? Math.round(practice.approx_minutes + reviewMinutes) : null,
    confirmedQuestionsCount,
    distinctQuestionsCount: practice.distinct_questions_count,
    correctCount: practice.correct_count,
    incorrectCount: practice.incorrect_count,
    patternsPracticed,
    helpLayersOpenedCount: helpCount,
    dailyTrainingItemsCompleted: dtItemsCompleted,
    simulationBlocksCompleted: simBlocksCompleted,
    scheduleCompletedCount: scheduleCounts.completed_count,
    scheduleRescheduledCount: scheduleCounts.rescheduled_count,
    errorNotebookEntriesCreated: entriesCreated,
    reviewsCompletedCount: reviewAgg.reviews_completed,
    reviewsCorrectCount: reviewAgg.reviews_correct,
    reviewsIncorrectCount: reviewAgg.reviews_incorrect,
    overdueReviewsAtWeekEnd,
    daysWithEvidenceCount: daysWithEvidence.size,
  };
}

/** Seção 4.2 da ordem — só diferenças FACTUAIS, nunca linguagem avaliativa.
 *  `available=false` quando qualquer uma das duas semanas não tem evidência
 *  comparável (seção 4.2: "informar indisponibilidade em vez de inferir
 *  tendência") — inclui deliberadamente a comparação de
 *  `overdueReviewsAtWeekEnd` DE FORA (sempre `null` para a semana anterior
 *  no desenho desta sprint — ver a nota em `computeWeekAggregate`/
 *  `weeklyReviewRepository.ts`; documentado como limitação conhecida em
 *  docs/RELATORIO_SEMANAL_METAS.md e no relatório final, seção 15). */
function buildComparison(current: WeekAggregate, previous: WeekAggregate): WeeklyComparisonDto {
  const available = current.hasAnyEvidence && previous.hasAnyEvidence;
  return {
    previousWeekStart: previous.weekStart,
    available,
    deltas: available
      ? {
          confirmedQuestionsCount: current.confirmedQuestionsCount - previous.confirmedQuestionsCount,
          correctCount: current.correctCount - previous.correctCount,
          incorrectCount: current.incorrectCount - previous.incorrectCount,
          daysWithEvidenceCount: current.daysWithEvidenceCount - previous.daysWithEvidenceCount,
          approxMinutes: current.approxMinutes !== null && previous.approxMinutes !== null ? current.approxMinutes - previous.approxMinutes : null,
        }
      : null,
  };
}

async function toGoalDto(db: D1Database, goal: WeeklyStudyGoalRow, patterns: WeeklyGoalPatternRow[], clock: Clock): Promise<GoalDto> {
  const patternDtos: GoalPatternDto[] = [];
  for (const p of patterns) {
    const name = await findPatternNameById(db, p.pattern_id);
    patternDtos.push({ patternId: p.pattern_id, patternName: name ?? "?", priorityPosition: p.priority_position });
  }

  const availableDays = JSON.parse(goal.available_days || "[]") as string[];
  const weekAggregate = await computeWeekAggregate(db, goal.user_id, goal.week_start, goal.timezone, clock);
  const startSql = toSqliteInstant(civilMidnightInstant(goal.week_start, goal.timezone));
  const endSql = toSqliteInstant(civilMidnightInstant(addCivilDays(goal.week_start, 7), goal.timezone));
  const practicedPatternIds = await listPracticedPatternIdsForWeek(db, goal.user_id, startSql, endSql);
  const patternsWithPractice = patternDtos.filter((p) => practicedPatternIds.has(p.patternId)).map((p) => p.patternId);

  const percents = computeGoalProgressPercents({
    targetMinutes: goal.target_minutes,
    targetQuestions: goal.target_questions,
    minutesDone: weekAggregate.approxMinutes,
    questionsDone: weekAggregate.hasAnyEvidence ? weekAggregate.confirmedQuestionsCount : null,
  });

  return {
    id: goal.id,
    weekStart: goal.week_start,
    timezone: goal.timezone,
    availableDays,
    targetMinutes: goal.target_minutes,
    targetQuestions: goal.target_questions,
    patterns: patternDtos,
    status: goal.status,
    version: goal.version,
    createdAt: goal.created_at,
    updatedAt: goal.updated_at,
    completedAt: goal.completed_at,
    abandonedAt: goal.abandoned_at,
    progress: {
      minutesDone: weekAggregate.approxMinutes,
      questionsDone: weekAggregate.hasAnyEvidence ? weekAggregate.confirmedQuestionsCount : null,
      minutesPercent: percents.minutesPercent,
      questionsPercent: percents.questionsPercent,
      daysWithActivity: weekAggregate.hasAnyEvidence ? weekAggregate.daysWithEvidenceCount : null,
      daysAvailable: availableDays.length,
      patternsWithPractice,
    },
  };
}

export interface GoalPatternDto {
  patternId: string;
  patternName: string;
  priorityPosition: number;
}

export interface GoalProgressDto {
  minutesDone: number | null;
  questionsDone: number | null;
  minutesPercent: number | null;
  questionsPercent: number | null;
  daysWithActivity: number | null;
  daysAvailable: number;
  patternsWithPractice: string[];
}

export interface GoalDto {
  id: string;
  weekStart: string;
  timezone: string;
  availableDays: string[];
  targetMinutes: number;
  targetQuestions: number;
  patterns: GoalPatternDto[];
  status: "active" | "completed" | "abandoned";
  version: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  abandonedAt: string | null;
  progress: GoalProgressDto;
}

/** Meta mais relevante para anexar ao relatório desta semana — a `active`
 *  quando existir; senão, a mais recente concluída/abandonada desta semana,
 *  se existir (o aluno vê o desfecho, nunca some silenciosamente do
 *  relatório). `null` só quando nenhuma meta jamais existiu para esta
 *  semana. */
async function getGoalDtoForWeek(db: D1Database, userId: string, weekStart: string, clock: Clock): Promise<GoalDto | null> {
  const resolved = await findLatestGoalForWeek(db, userId, weekStart);
  if (!resolved) return null;
  const patterns = await listPatternsForGoal(db, resolved.id);
  return toGoalDto(db, resolved, patterns, clock);
}

export async function getReportForWeek(db: D1Database, userId: string, weekStartInput: unknown, clock: Clock = systemClock): Promise<{ ok: true; report: WeeklyReportDto } | { ok: false; fieldErrors: Record<string, string> }> {
  const timezone = await getTimezone(db, userId);
  let weekStart: string;
  if (weekStartInput === undefined) {
    weekStart = mondayOfCivilWeek(civilDateInTimezone(clock.now(), timezone));
  } else {
    const validated = validateWeekStartFormat(weekStartInput);
    if (!validated.ok) return { ok: false, fieldErrors: { weekStart: validated.error! } };
    weekStart = mondayOfCivilWeek(validated.value!);
  }

  const [current, previous] = await Promise.all([
    computeWeekAggregate(db, userId, weekStart, timezone, clock),
    computeWeekAggregate(db, userId, addCivilDays(weekStart, -7), timezone, clock),
  ]);
  const goal = await getGoalDtoForWeek(db, userId, weekStart, clock);

  return {
    ok: true,
    report: {
      ...current,
      comparison: buildComparison(current, previous),
      goal,
    },
  };
}

const HISTORY_LOOKBACK_WEEKS = 12;

export interface WeeklyHistoryEntryDto {
  weekStart: string;
  weekEnd: string;
  isCurrentWeek: boolean;
  hasEvidence: boolean;
}

/** Seção 4.1 da ordem: "seleção da semana atual e semanas anteriores
 *  disponíveis" — 100% somente leitura. A semana atual entra sempre (mesmo
 *  sem evidência, para o aluno poder ver o estado "ainda sem evidências");
 *  semanas anteriores só entram se tiverem alguma evidência real (nunca uma
 *  lista poluída de dezenas de semanas vazias). */
export async function getHistory(db: D1Database, userId: string, clock: Clock = systemClock): Promise<{ weeks: WeeklyHistoryEntryDto[] }> {
  const timezone = await getTimezone(db, userId);
  const currentWeekStart = mondayOfCivilWeek(civilDateInTimezone(clock.now(), timezone));
  const weeks: WeeklyHistoryEntryDto[] = [];
  for (let i = 0; i < HISTORY_LOOKBACK_WEEKS; i++) {
    const weekStart = addCivilDays(currentWeekStart, -7 * i);
    const weekEnd = addCivilDays(weekStart, 6);
    const startSql = toSqliteInstant(civilMidnightInstant(weekStart, timezone));
    const endSql = toSqliteInstant(civilMidnightInstant(addCivilDays(weekStart, 7), timezone));
    const hasEvidence = await hasAnyEvidenceForWeek(db, userId, startSql, endSql);
    if (i === 0 || hasEvidence) weeks.push({ weekStart, weekEnd, isCurrentWeek: i === 0, hasEvidence });
  }
  return { weeks };
}

/* ------------------------------------------------------------------------ */
/* Metas — preview (leitura pura, seção 8 da ordem)                          */
/* ------------------------------------------------------------------------ */

export interface GoalSuggestionDto {
  weekStart: string;
  timezone: string;
  suggestedMinutes: number;
  suggestedQuestions: number;
  suggestedPatterns: SuggestedPattern[];
  basedOnAvailability: boolean;
  availableDays: string[];
}

export async function previewGoal(db: D1Database, userId: string, weekStartInput: unknown, clock: Clock = systemClock): Promise<{ ok: true; preview: GoalSuggestionDto } | { ok: false; fieldErrors: Record<string, string> }> {
  const weekStartV = validateWeekStartFormat(weekStartInput);
  if (!weekStartV.ok) return { ok: false, fieldErrors: { weekStart: weekStartV.error! } };
  const weekStart = mondayOfCivilWeek(weekStartV.value!);

  const timezone = await getTimezone(db, userId);
  const profile = await findProfile(db, userId);
  const availableDays = ((profile?.available_days ? JSON.parse(profile.available_days) : []) as string[]).filter(isWeekdayCode);
  const dailyMinutes = profile?.daily_minutes ?? 0;
  const weeklyCapacity = availableDays.length * dailyMinutes;

  const suggestedMinutes = suggestWeeklyMinutes(weeklyCapacity);
  const suggestedQuestions = suggestWeeklyQuestions(suggestedMinutes);

  const nowSql = toSqliteInstant(clock.now());
  const patterns = await listPublishedPatternIds(db);
  const candidates: PatternCandidate[] = [];
  for (const pattern of patterns) {
    const evidence = await getPatternEvidence(db, userId, pattern.id);
    const activeStatus = evidence.activeErrorEntryStatus;
    if (activeStatus && activeStatus !== "archived" && activeStatus !== "corrected") {
      if (evidence.nextReviewAt !== null && evidence.nextReviewAt <= nowSql) {
        candidates.push({ patternId: pattern.id, patternCode: pattern.code, patternName: pattern.code, urgencyRank: 0, recencyKey: evidence.nextReviewAt ?? "" });
        continue;
      }
      candidates.push({
        patternId: pattern.id,
        patternCode: pattern.code,
        patternName: pattern.code,
        urgencyRank: 1,
        recencyKey: evidence.lastReviewedAt ?? evidence.lastPracticeAt ?? "",
      });
      continue;
    }
    const state = deriveProvisionalState({
      confirmedAttempts: evidence.confirmedAttempts,
      correctCount: evidence.correctCount,
      distinctQuestionsUsed: evidence.distinctQuestionsUsed,
      distinctSessionDates: evidence.distinctPracticeDays,
      hasCorrectReview: evidence.reviewsCorrect > 0,
      firstConfirmedAt: evidence.firstConfirmedAt,
      lastConfirmedAt: evidence.lastPracticeAt,
      attemptsWithHelp: evidence.attemptsWithHelp,
      hasOverdueActiveReview: false,
    });
    if (state === "em_desenvolvimento") {
      candidates.push({ patternId: pattern.id, patternCode: pattern.code, patternName: pattern.code, urgencyRank: 2, recencyKey: evidence.lastPracticeAt ?? "" });
    }
  }

  const suggestedPatternsRaw = selectSuggestedPatterns(candidates);
  const suggestedPatterns: SuggestedPattern[] = [];
  for (const sp of suggestedPatternsRaw) {
    const full = await findPublishedPatternById(db, sp.patternId);
    suggestedPatterns.push({ ...sp, patternName: full?.name ?? sp.patternName });
  }

  return {
    ok: true,
    preview: {
      weekStart,
      timezone,
      suggestedMinutes,
      suggestedQuestions,
      suggestedPatterns,
      basedOnAvailability: weeklyCapacity > 0,
      availableDays,
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Metas — apply/patch/complete/abandon (mutação atômica e idempotente)      */
/* ------------------------------------------------------------------------ */

function isUniqueActiveGoalViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message) && error.message.includes("weekly_study_goals");
}

function isUniqueEventIdViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message) && error.message.includes("weekly_goal_events");
}

export interface ApplyGoalInput {
  weekStart: unknown;
  targetMinutes: unknown;
  targetQuestions: unknown;
  availableDays: unknown;
  patternIds: unknown;
  mutationId: string;
}

interface RequestedGoalContent {
  targetMinutes: number;
  targetQuestions: number;
  availableDays: string[];
  patternIds: string[];
}

function sortedJson(values: string[]): string {
  return JSON.stringify([...values].sort());
}

/** PO — decide o que fazer quando JÁ existe uma meta `active` para esta
 *  semana no momento em que este `applyGoal` também quer agir. A IDENTIDADE
 *  da mutação (`mutationId`), NUNCA a igualdade de conteúdo, é o que prova
 *  se esta chamada é um retry LEGÍTIMO de uma mutação já aplicada — mesmo
 *  raciocínio de `classifyActiveBlockCollision`
 *  (worker/src/services/simulationsService.ts, Sprint 12). */
function classifyActiveGoalCollision(existing: WeeklyStudyGoalRow, mutationId: string, requested: RequestedGoalContent): MutationResult<{ goalId: string }> {
  const sameRequest =
    existing.target_minutes === requested.targetMinutes &&
    existing.target_questions === requested.targetQuestions &&
    sortedJson(JSON.parse(existing.available_days || "[]")) === sortedJson(requested.availableDays);

  if (existing.last_mutation_id === mutationId) {
    if (sameRequest) return { ok: true, changed: false, value: { goalId: existing.id } };
    return { ok: false, conflict: true };
  }
  return {
    ok: false,
    activeElsewhere: true,
    fieldErrors: { weekStart: "Você já tem uma meta ativa para esta semana. Edite, conclua ou abandone-a antes de aplicar uma nova." },
  };
}

/** Sem parâmetro de relógio: `weekStart` vem sempre EXPLICITAMENTE do
 *  corpo da requisição (a semana que o aluno escolheu no preview), nunca
 *  derivado de "agora" dentro desta função — diferente de
 *  `previewGoal`/`getReportForWeek`, que precisam do relógio injetável para
 *  resolver "a semana atual" quando nenhuma é informada (seção 5 da
 *  ordem). */
export async function applyGoal(db: D1Database, userId: string, input: ApplyGoalInput): Promise<MutationResult<{ goalId: string }>> {
  const weekStartV = validateWeekStartFormat(input.weekStart);
  if (!weekStartV.ok) return { ok: false, fieldErrors: { weekStart: weekStartV.error! } };
  const weekStart = mondayOfCivilWeek(weekStartV.value!);

  const minutesV = validateTargetMinutes(input.targetMinutes);
  if (!minutesV.ok) return { ok: false, fieldErrors: { targetMinutes: minutesV.error! } };
  const questionsV = validateTargetQuestions(input.targetQuestions);
  if (!questionsV.ok) return { ok: false, fieldErrors: { targetQuestions: questionsV.error! } };
  const daysV = validateAvailableDays(input.availableDays ?? []);
  if (!daysV.ok) return { ok: false, fieldErrors: { availableDays: daysV.error! } };
  const patternsV = validatePatternIds(input.patternIds);
  if (!patternsV.ok) return { ok: false, fieldErrors: { patternIds: patternsV.error! } };

  for (const pid of patternsV.value!) {
    const pattern = await findPublishedPatternById(db, pid);
    if (!pattern) return { ok: false, notFound: true };
  }

  const requested: RequestedGoalContent = { targetMinutes: minutesV.value!, targetQuestions: questionsV.value!, availableDays: daysV.value!, patternIds: patternsV.value! };

  const existingActive = await findActiveGoalForWeek(db, userId, weekStart);
  if (existingActive) return classifyActiveGoalCollision(existingActive, input.mutationId, requested);

  if (await weeklyGoalEventIdInUse(db, input.mutationId)) return { ok: false, conflict: true };

  const timezone = await getTimezone(db, userId);
  const goalId = newId();
  const statements = [
    buildInsertGoalStatement(db, {
      id: goalId,
      userId,
      weekStart,
      timezone,
      availableDays: requested.availableDays,
      targetMinutes: requested.targetMinutes,
      targetQuestions: requested.targetQuestions,
      mutationId: input.mutationId,
    }),
  ];
  requested.patternIds.forEach((pid, idx) =>
    statements.push(buildInsertGoalPatternStatement(db, { id: newId(), goalId, userId, patternId: pid, priorityPosition: idx + 1, mutationId: input.mutationId }))
  );
  statements.push(
    buildGoalEventInsertStatement(db, {
      id: input.mutationId,
      goalId,
      userId,
      eventType: "goal_created",
      fromStatus: null,
      toStatus: "active",
      goalVersion: 1,
      // PO v1.1 (correção A): apply sempre grava a coleção de padrões do
      // zero (0 a 3), então esta mutação SEMPRE "toca" weekly_goal_patterns
      // — o trigger consolidado (migrations/0018) exige que a contagem real
      // carimbada com este mutationId bata exatamente com este valor.
      patternsExpectedCount: requested.patternIds.length,
    })
  );

  try {
    await db.batch(statements);
  } catch (error) {
    if (isUniqueActiveGoalViolation(error)) {
      const stillActive = await findActiveGoalForWeek(db, userId, weekStart);
      if (stillActive) return classifyActiveGoalCollision(stillActive, input.mutationId, requested);
    }
    if (isUniqueEventIdViolation(error)) return { ok: false, conflict: true };
    throw error;
  }

  return { ok: true, changed: true, value: { goalId } };
}

export interface PatchGoalInput {
  targetMinutes?: unknown;
  targetQuestions?: unknown;
  availableDays?: unknown;
  patternIds?: unknown;
  version: unknown;
  mutationId: string;
}

function isSameContentAsCurrent(
  goal: WeeklyStudyGoalRow,
  currentPatterns: WeeklyGoalPatternRow[],
  input: { targetMinutes?: number; targetQuestions?: number; availableDays?: string[]; patternIds?: string[] }
): boolean {
  if (input.targetMinutes !== undefined && input.targetMinutes !== goal.target_minutes) return false;
  if (input.targetQuestions !== undefined && input.targetQuestions !== goal.target_questions) return false;
  if (input.availableDays !== undefined && sortedJson(input.availableDays) !== sortedJson(JSON.parse(goal.available_days || "[]"))) return false;
  if (input.patternIds !== undefined && sortedJson(input.patternIds) !== sortedJson(currentPatterns.map((p) => p.pattern_id))) return false;
  return true;
}

export async function patchGoal(db: D1Database, userId: string, goalId: string, input: PatchGoalInput, clock: Clock = systemClock): Promise<MutationResult<{ goal: GoalDto }>> {
  const goal = await findGoalForUser(db, goalId, userId);
  if (!goal) return { ok: false, notFound: true };

  const versionV = validateVersion(input.version);
  if (!versionV.ok) return { ok: false, fieldErrors: { version: versionV.error! } };

  let targetMinutes: number | undefined;
  if (input.targetMinutes !== undefined) {
    const v = validateTargetMinutes(input.targetMinutes);
    if (!v.ok) return { ok: false, fieldErrors: { targetMinutes: v.error! } };
    targetMinutes = v.value;
  }
  let targetQuestions: number | undefined;
  if (input.targetQuestions !== undefined) {
    const v = validateTargetQuestions(input.targetQuestions);
    if (!v.ok) return { ok: false, fieldErrors: { targetQuestions: v.error! } };
    targetQuestions = v.value;
  }
  let availableDays: string[] | undefined;
  if (input.availableDays !== undefined) {
    const v = validateAvailableDays(input.availableDays);
    if (!v.ok) return { ok: false, fieldErrors: { availableDays: v.error! } };
    availableDays = v.value;
  }
  let patternIds: string[] | undefined;
  if (input.patternIds !== undefined) {
    const v = validatePatternIds(input.patternIds);
    if (!v.ok) return { ok: false, fieldErrors: { patternIds: v.error! } };
    for (const pid of v.value!) {
      const pattern = await findPublishedPatternById(db, pid);
      if (!pattern) return { ok: false, notFound: true };
    }
    patternIds = v.value;
  }

  if (targetMinutes === undefined && targetQuestions === undefined && availableDays === undefined && patternIds === undefined) {
    return { ok: false, fieldErrors: { patch: "Informe ao menos um campo para atualizar." } };
  }

  if (goal.status !== "active") return { ok: false, fieldErrors: { status: "Esta meta não está mais ativa." } };

  const currentPatterns = await listPatternsForGoal(db, goal.id);

  if (goal.last_mutation_id === input.mutationId) {
    if (isSameContentAsCurrent(goal, currentPatterns, { targetMinutes, targetQuestions, availableDays, patternIds })) {
      return { ok: true, changed: false, value: { goal: await toGoalDto(db, goal, currentPatterns, clock) } };
    }
    return { ok: false, conflict: true };
  }

  if (goal.version !== versionV.value) return { ok: false, conflict: true };
  if (await weeklyGoalEventIdInUse(db, input.mutationId)) return { ok: false, conflict: true };

  const nextVersion = goal.version + 1;
  const statements = [
    buildPatchGoalStatement(db, {
      goalId: goal.id,
      userId,
      guardVersion: goal.version,
      mutationId: input.mutationId,
      targetMinutes,
      targetQuestions,
      availableDaysProvided: availableDays !== undefined,
      availableDays: availableDays ?? [],
    }),
  ];
  if (patternIds !== undefined) {
    statements.push(buildDeleteGoalPatternsStatement(db, { goalId: goal.id, userId }));
    patternIds.forEach((pid, idx) =>
      statements.push(
        buildInsertGoalPatternStatement(db, { id: newId(), goalId: goal.id, userId, patternId: pid, priorityPosition: idx + 1, mutationId: input.mutationId })
      )
    );
  }
  statements.push(
    buildGoalEventInsertStatement(db, {
      id: input.mutationId,
      goalId: goal.id,
      userId,
      eventType: "goal_updated",
      fromStatus: "active",
      toStatus: "active",
      goalVersion: nextVersion,
      // PO v1.1 (correção A): só "toca" weekly_goal_patterns (e portanto só
      // é validado por identidade pelo trigger) quando este PATCH de fato
      // informou `patternIds` — quando não informou, a coleção permanece
      // intocada de uma mutação ANTERIOR, e isso é o comportamento correto
      // (undefined ⇒ NULL ⇒ trigger não valida nada sobre padrões aqui).
      patternsExpectedCount: patternIds !== undefined ? patternIds.length : undefined,
    })
  );

  try {
    await db.batch(statements);
  } catch (error) {
    if (isUniqueEventIdViolation(error)) return { ok: false, conflict: true };
    const after = await findGoalForUser(db, goal.id, userId);
    if (!after) return { ok: false, notFound: true };
    if (after.last_mutation_id === input.mutationId) {
      return { ok: true, changed: false, value: { goal: await toGoalDto(db, after, await listPatternsForGoal(db, after.id), clock) } };
    }
    if (after.version === goal.version) throw error;
    return { ok: false, conflict: true };
  }

  const after = await findGoalForUser(db, goal.id, userId);
  const afterPatterns = await listPatternsForGoal(db, after!.id);
  return { ok: true, changed: true, value: { goal: await toGoalDto(db, after!, afterPatterns, clock) } };
}

export async function completeGoal(db: D1Database, userId: string, goalId: string, mutationId: string): Promise<MutationResult<null>> {
  const goal = await findGoalForUser(db, goalId, userId);
  if (!goal) return { ok: false, notFound: true };
  if (goal.status === "completed") return { ok: true, changed: false };
  if (goal.status !== "active") return { ok: false, fieldErrors: { status: "Esta meta não está mais ativa." } };
  if (goal.last_mutation_id === mutationId) return { ok: false, conflict: true };

  const nextVersion = goal.version + 1;
  let result;
  try {
    result = await db.batch([
      buildCompleteGoalStatement(db, { goalId: goal.id, userId, guardVersion: goal.version, mutationId }),
      buildGoalEventInsertStatement(db, { id: mutationId, goalId: goal.id, userId, eventType: "goal_completed", fromStatus: "active", toStatus: "completed", goalVersion: nextVersion }),
    ]);
  } catch (error) {
    if (isUniqueEventIdViolation(error)) return { ok: false, conflict: true };
    const after = await findGoalForUser(db, goal.id, userId);
    if (!after) return { ok: false, notFound: true };
    if (after.status === "completed") return { ok: true, changed: false };
    if (after.version === goal.version) throw error;
    return { ok: false, conflict: true };
  }

  if (result[0].meta.changes !== 1) {
    const after = await findGoalForUser(db, goal.id, userId);
    if (!after) return { ok: false, notFound: true };
    if (after.status === "completed") return { ok: true, changed: false };
    return { ok: false, conflict: true };
  }

  return { ok: true, changed: true };
}

export async function abandonGoal(db: D1Database, userId: string, goalId: string, mutationId: string): Promise<MutationResult<null>> {
  const goal = await findGoalForUser(db, goalId, userId);
  if (!goal) return { ok: false, notFound: true };
  if (goal.status === "abandoned") return { ok: true, changed: false };
  if (goal.status !== "active") return { ok: false, fieldErrors: { status: "Esta meta não está mais ativa." } };
  if (goal.last_mutation_id === mutationId) return { ok: false, conflict: true };

  const nextVersion = goal.version + 1;
  let result;
  try {
    result = await db.batch([
      buildAbandonGoalStatement(db, { goalId: goal.id, userId, guardVersion: goal.version, mutationId }),
      buildGoalEventInsertStatement(db, { id: mutationId, goalId: goal.id, userId, eventType: "goal_abandoned", fromStatus: "active", toStatus: "abandoned", goalVersion: nextVersion }),
    ]);
  } catch (error) {
    if (isUniqueEventIdViolation(error)) return { ok: false, conflict: true };
    const after = await findGoalForUser(db, goal.id, userId);
    if (!after) return { ok: false, notFound: true };
    if (after.status === "abandoned") return { ok: true, changed: false };
    if (after.version === goal.version) throw error;
    return { ok: false, conflict: true };
  }

  if (result[0].meta.changes !== 1) {
    const after = await findGoalForUser(db, goal.id, userId);
    if (!after) return { ok: false, notFound: true };
    if (after.status === "abandoned") return { ok: true, changed: false };
    return { ok: false, conflict: true };
  }

  return { ok: true, changed: true };
}
