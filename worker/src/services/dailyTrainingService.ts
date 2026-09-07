/* Serviço do Treino Diário — Sprint 11 v1.0.

   Orquestra: 1) o algoritmo provisório puro (worker/src/lib/
   dailyTrainingRules.ts) — nunca reimplementado aqui; 2) leitura dos
   candidatos reais (worker/src/repositories/dailyTrainingRepository.ts,
   sempre escopada por user_id no SQL); 3) atomicidade das mutações
   (db.batch() com o núcleo PRIMEIRO e o evento incondicional por ÚLTIMO,
   mesmo padrão de playerService.ts/errorNotebookService.ts desde as
   Sprints 8-9 — ver o trigger de identidade em migrations/0016).

   `buildCandidates` é a ÚNICA função que decide QUAIS itens entram —
   chamada tanto por `preview` (GET, nunca escreve) quanto por `applyList`
   (recomputa o MESMO cálculo antes de persistir, nunca reaproveita uma
   prévia armazenada — não existe tabela de prévia nesta sprint,
   diferente do cronograma/Sprint 5, porque aqui o próprio cálculo já é
   barato e 100% determinístico para o mesmo estado+relógio, seção 6 da
   ordem). */

import {
  allItemsTerminal,
  buildAbandonListStatement,
  buildBlockItemStatement,
  buildCompleteItemStatement,
  buildCompleteListStatement,
  buildInsertItemStatement,
  buildInsertListStatement,
  buildItemEventInsertStatement,
  buildListEventInsertStatement,
  buildReleaseAbandonedItemAttemptsStatement,
  buildReleaseSpecificItemAttemptStatement,
  buildSkipItemStatement,
  buildStartItemStatement,
  dailyTrainingEventIdInUse,
  findActiveListForUserDate,
  findAttemptOwnerWithListStatus,
  findItemForListAndUser,
  findLatestListForUserDate,
  findListForUser,
  listItemsForList,
  listOverdueReviewCandidates,
  listPublishedPatternIds,
  listRecentlyCompletedQuestionIds,
  listScheduleAssignmentIdsInActiveTraining,
  listTodayScheduleCommitments,
  listTrainableQuestionsForPattern,
  listPublishedPatternsWithTrainableCounts,
  type DailyTrainingItemRow,
  type DailyTrainingListRow,
  type TrainableQuestionRow,
} from "../repositories/dailyTrainingRepository";
import { findEntryById, selectSimilarQuestion } from "../repositories/errorNotebookRepository";
import { findQuestionForStudent } from "../repositories/questionRepository";
import { findPublishedPatternById } from "../repositories/patternsRepository";
import { findProfile } from "../repositories/onboardingRepository";
import { findActiveAttempt, findActiveReviewAttempt, findAttemptByIdForUser } from "../repositories/playerRepository";
import {
  isUniqueActiveAttemptViolation,
  planStartOrResumeAttempt,
  planStartOrResumeReviewAttempt,
  type AttemptStartPlan,
} from "./playerService";
import { getTimezone, systemClock, type Clock } from "./scheduleService";
import { civilDateInTimezone, weekdayCodeForCivilDate, type WeekdayCode } from "../lib/scheduleValidation";
import { getPatternEvidence } from "../repositories/studentMetricsRepository";
import { deriveProvisionalState, type ProvisionalState } from "../lib/studentMetricsRules";
import {
  MAX_DAILY_TRAINING_ITEMS,
  REASON_LABELS,
  estimateItemMinutes,
  selectDailyTrainingItems,
  type DailyTrainingCandidate,
  type DailyTrainingPlayerMode,
  type DailyTrainingReasonCode,
  type DailyTrainingSelectionItem,
  type DailyTrainingSelectionResult,
} from "../lib/dailyTrainingRules";

function newId(): string {
  return crypto.randomUUID();
}

const RECENT_COMPLETION_EXCLUSION_DAYS = 3;
const MAX_OVERDUE_REVIEW_CANDIDATES = MAX_DAILY_TRAINING_ITEMS;
const MAX_SCHEDULE_COMMITMENT_CANDIDATES = 1;

export interface MutationResult<T> {
  ok: boolean;
  value?: T;
  notFound?: boolean;
  conflict?: boolean;
  empty?: boolean;
  fieldErrors?: Record<string, string>;
  changed?: boolean;
}

/* ------------------------------------- DTOs ------------------------------------- */

export interface TrainingItemDto {
  id: string;
  questionId: string;
  questionCode: string;
  patternId: string | null;
  patternName: string | null;
  origin: string;
  reason: string;
  reasonLabel: string;
  playerMode: string;
  position: number;
  estimatedMinutes: number;
  status: string;
  questionAttemptId: string | null;
  isCorrect: boolean | null;
  skipReason: string | null;
  version: number;
}

export interface FocusPatternDto {
  id: string;
  slug: string;
  name: string;
  mainStrategy: string;
}

export interface TrainingListDto {
  id: string;
  date: string;
  timezone: string;
  status: string;
  estimatedMinutes: number;
  itemCount: number;
  version: number;
  createdAt: string;
  completedAt: string | null;
  items: TrainingItemDto[];
  /** Sprint 20, seção 15 da ordem — derivado EM MEMÓRIA a partir dos
   *  próprios itens da lista, nunca de uma coluna nova (sem migration):
   *  só não-nulo quando TODOS os itens compartilham o MESMO
   *  `primary_pattern_id` (uma lista focada, seção 13). Uma lista
   *  histórica/adaptativa com múltiplos padrões — ou vazia — sempre
   *  devolve `null` aqui; nunca inferido pelo primeiro item quando os
   *  demais divergem. */
  focusPattern: FocusPatternDto | null;
}

export interface PreviewDto {
  date: string;
  timezone: string;
  hasAvailabilityToday: boolean;
  availableMinutesToday: number;
  estimatedMinutes: number;
  itemCount: number;
  items: TrainingItemDto[];
  composition: Array<{ reason: DailyTrainingReasonCode; reasonLabel: string; count: number }>;
}

/** Sprint 20, seção 9 da ordem — mesmo `PreviewDto` do treino adaptativo,
 *  mais o padrão escolhido pelo aluno (nome/slug/macete já resolvidos —
 *  nunca um ID cru exposto à UI). */
export interface FocusedPreviewDto extends PreviewDto {
  focusPattern: FocusPatternDto;
}

/** Sprint 20, seção 4 da ordem — um item do catálogo "O que você quer
 *  treinar hoje?". `availableQuestionCount = 0` é um estado LEGÍTIMO
 *  (padrão publicado, mas editorialmente ainda sem questão elegível) —
 *  nunca omitido do catálogo, só marcado `canTrain: false` para a UI
 *  desabilitar o card com uma mensagem amigável, nunca escondê-lo. */
export interface TrainablePatternDto {
  id: string;
  slug: string;
  name: string;
  mainStrategy: string;
  availableQuestionCount: number;
  canTrain: boolean;
}

/* ------------------------------ Construção dos candidatos ------------------------------ */

interface BuiltCandidates {
  timezone: string;
  todayCivil: string;
  availableMinutes: number;
  candidatesByTier: DailyTrainingCandidate[][];
}

function pickQuestion(candidates: TrainableQuestionRow[], recentlyCompleted: Set<string>): TrainableQuestionRow | null {
  if (candidates.length === 0) return null;
  return candidates.find((q) => !recentlyCompleted.has(q.id)) ?? candidates[0];
}

/** Seção 7/8 da ordem — monta os seis grupos de candidatos, na mesma ordem
 *  de prioridade, a partir SOMENTE de dados reais já existentes (nunca
 *  fabricados). Determinístico para o mesmo estado do banco e o mesmo
 *  `clock` (nenhuma aleatoriedade, nenhum `Date.now()` implícito). */
async function buildCandidates(db: D1Database, userId: string, clock: Clock, fixturesAllowed: boolean): Promise<BuiltCandidates> {
  const timezone = await getTimezone(db, userId);
  const now = clock.now();
  const nowIso = now.toISOString();
  const todayCivil = civilDateInTimezone(now, timezone);

  const profile = await findProfile(db, userId);
  const availableDays = ((profile?.available_days ? JSON.parse(profile.available_days) : []) as string[]).filter(
    (day): day is WeekdayCode => (["dom", "seg", "ter", "qua", "qui", "sex", "sab"] as string[]).includes(day)
  );
  const dailyMinutes = profile?.daily_minutes ?? 0;
  const todayWeekday = weekdayCodeForCivilDate(todayCivil);
  // Seção 8 da ordem: "indisponibilidade do dia gera preview vazio honesto"
  // — um dia fora da disponibilidade configurada do aluno tem 0 minutos
  // disponíveis, nunca uma capacidade inventada.
  const availableMinutes = availableDays.includes(todayWeekday) ? dailyMinutes : 0;

  const recentlyCompleted = await listRecentlyCompletedQuestionIds(
    db,
    userId,
    new Date(now.getTime() - RECENT_COMPLETION_EXCLUSION_DAYS * 24 * 60 * 60 * 1000).toISOString()
  );

  /* Camada 1 — revisões vencidas ativas. A questão de cada revisão é
     escolhida pela MESMA seleção determinística já usada pelo Caderno de
     Erros (selectSimilarQuestion, Sprint 9) — nunca duplicada aqui. Não
     exclui questões já usadas com sucesso (esse refinamento é
     responsabilidade do próprio fluxo de revisão do Caderno, seção 7
     daquela ordem; o treino diário só precisa de UMA questão real e
     determinística para representar a revisão vencida). */
  const overdueRows = await listOverdueReviewCandidates(db, userId, nowIso, MAX_OVERDUE_REVIEW_CANDIDATES);
  const tierOverdue: DailyTrainingCandidate[] = [];
  for (const row of overdueRows) {
    const selection = await selectSimilarQuestion(
      db,
      {
        originalQuestionId: row.originalQuestionId,
        primaryPatternId: row.primaryPatternId,
        excludeQuestionIds: [],
      },
      fixturesAllowed
    );
    const question = await findQuestionForStudent(db, selection.questionId, fixturesAllowed);
    if (!question) continue;
    tierOverdue.push({
      questionId: question.id,
      patternId: row.primaryPatternId,
      reason: "overdue_review",
      playerMode: "practice",
      estimatedMinutes: estimateItemMinutes(question.tempo_estimado_segundos),
      errorEntryId: row.entryId,
    });
  }

  /* Camadas 3-6 — estado provisório por padrão (reaproveita
     getPatternEvidence + deriveProvisionalState, Sprint 10, nunca uma
     fórmula nova). Padrões em `revisao_pendente` ficam de fora destas
     camadas — já estão cobertos pela camada 1, diretamente pela entrada
     real do Caderno de Erros (evitar contar a mesma revisão duas vezes). */
  const patterns = await listPublishedPatternIds(db);
  const developmentPool: DailyTrainingCandidate[] = [];
  const initialEvidencePool: DailyTrainingCandidate[] = [];
  const maintenancePool: DailyTrainingCandidate[] = [];
  const explorationPool: DailyTrainingCandidate[] = [];

  for (const pattern of patterns) {
    const evidence = await getPatternEvidence(db, userId, pattern.id);
    const hasOverdueActiveReview = evidence.activeErrorEntryStatus === "scheduled" && evidence.nextReviewAt !== null && evidence.nextReviewAt <= nowIso;
    const state = deriveProvisionalState({
      confirmedAttempts: evidence.confirmedAttempts,
      correctCount: evidence.correctCount,
      distinctQuestionsUsed: evidence.distinctQuestionsUsed,
      distinctSessionDates: evidence.distinctPracticeDays,
      hasCorrectReview: evidence.reviewsCorrect > 0,
      firstConfirmedAt: evidence.firstConfirmedAt,
      lastConfirmedAt: evidence.lastPracticeAt,
      attemptsWithHelp: evidence.attemptsWithHelp,
      hasOverdueActiveReview,
    });
    const trainable = await listTrainableQuestionsForPattern(db, pattern.id, fixturesAllowed);
    const chosen = pickQuestion(trainable, recentlyCompleted);
    if (!chosen) continue;
    const candidate: DailyTrainingCandidate = {
      questionId: chosen.id,
      patternId: pattern.id,
      reason: "pattern_exploration",
      playerMode: "learning",
      estimatedMinutes: estimateItemMinutes(chosen.tempo_estimado_segundos),
    };

    if (state === "em_desenvolvimento") {
      developmentPool.push({ ...candidate, reason: "pattern_in_development" });
    } else if (state === "evidencias_iniciais") {
      initialEvidencePool.push({ ...candidate, reason: "pattern_initial_evidence", playerMode: "recognition" });
    } else if (state === "consistente_no_recorte") {
      maintenancePool.push({ ...candidate, reason: "pattern_maintenance", playerMode: "practice" });
    } else if (state === "sem_evidencias") {
      explorationPool.push({ ...candidate, reason: "pattern_exploration" });
    }
    // 'revisao_pendente' já coberto pela camada 1 — nenhuma candidata
    // adicional é criada aqui para esse estado (evita contar a mesma
    // revisão duas vezes).
  }

  /* Camada 2 — compromisso obrigatório do cronograma para hoje. O
     cronograma não referencia uma questão específica (seção 5 daquela
     ordem, Sprint 5), então o item concreto vem do MESMO pool das camadas
     3-6 (nesta ordem de prioridade interna) — só a `reason`/`origin` muda,
     documentando ao aluno que este item também atende ao compromisso do
     dia. Limitado a `MAX_SCHEDULE_COMMITMENT_CANDIDATES` (1) — "o
     compromisso do dia", no singular, seção 12 da ordem. */
  const tierScheduleCommitment: DailyTrainingCandidate[] = [];
  const commitments = await listTodayScheduleCommitments(db, userId, todayCivil, MAX_SCHEDULE_COMMITMENT_CANDIDATES);
  if (commitments.length > 0) {
    const pools = [developmentPool, initialEvidencePool, maintenancePool, explorationPool];
    const usedByOverdue = new Set(tierOverdue.map((c) => c.questionId));
    outer: for (const pool of pools) {
      for (const candidate of pool) {
        if (usedByOverdue.has(candidate.questionId)) continue;
        tierScheduleCommitment.push({ ...candidate, reason: "schedule_commitment", playerMode: candidate.playerMode });
        break outer;
      }
    }
  }

  return {
    timezone,
    todayCivil,
    availableMinutes,
    candidatesByTier: [tierOverdue, tierScheduleCommitment, developmentPool, initialEvidencePool, maintenancePool, explorationPool],
  };
}

async function selectionItemToDto(db: D1Database, item: DailyTrainingSelectionItem, fixturesAllowed: boolean): Promise<TrainingItemDto> {
  const question = await findQuestionForStudent(db, item.questionId, fixturesAllowed);
  const pattern = item.patternId ? await findPublishedPatternById(db, item.patternId) : null;
  return {
    id: "",
    questionId: item.questionId,
    questionCode: question?.code ?? "?",
    patternId: item.patternId,
    patternName: pattern?.name ?? null,
    origin: item.origin,
    reason: item.reason,
    reasonLabel: REASON_LABELS[item.reason],
    playerMode: item.playerMode,
    position: item.position,
    estimatedMinutes: item.estimatedMinutes,
    status: "pending",
    questionAttemptId: null,
    isCorrect: null,
    skipReason: null,
    version: 0,
  };
}

/* ------------------------------------ Preview ------------------------------------ */

/** GET — 100% somente leitura (seção 6 da ordem: "o GET de preview nunca
 *  pode criar lista, item, tentativa, evento ou auditoria"). Determinístico
 *  para o mesmo estado do banco e o mesmo `clock`. */
export async function preview(db: D1Database, userId: string, fixturesAllowed: boolean, clock: Clock = systemClock): Promise<PreviewDto> {
  const built = await buildCandidates(db, userId, clock, fixturesAllowed);
  const result = selectDailyTrainingItems({ candidatesByTier: built.candidatesByTier, availableMinutes: built.availableMinutes });

  const items: TrainingItemDto[] = [];
  for (const item of result.items) items.push(await selectionItemToDto(db, item, fixturesAllowed));

  const compositionMap = new Map<DailyTrainingReasonCode, number>();
  for (const item of result.items) compositionMap.set(item.reason, (compositionMap.get(item.reason) ?? 0) + 1);
  const composition = Array.from(compositionMap.entries()).map(([reason, count]) => ({ reason, reasonLabel: REASON_LABELS[reason], count }));

  return {
    date: built.todayCivil,
    timezone: built.timezone,
    hasAvailabilityToday: built.availableMinutes > 0,
    availableMinutesToday: built.availableMinutes,
    estimatedMinutes: result.totalMinutes,
    itemCount: items.length,
    items,
    composition,
  };
}

/* -------------------------------------- Apply -------------------------------------- */

function isUniqueActiveListViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message) && error.message.includes("daily_training_lists");
}

/** PO v1.2 (correção do TOCTOU do mutationId em `startItem`) — mesmo padrão
 *  de `isUniqueActiveListViolation` acima e de `isUniqueActiveAttemptViolation`
 *  (worker/src/services/playerService.ts): a garantia REAL de que um
 *  `mutationId` não foi reaproveitado por OUTRA mutação é a PRIMARY KEY de
 *  `daily_training_events.id` (migrations/0016) — nunca só o pre-check em
 *  JS (`dailyTrainingEventIdInUse`, que só cobre a corrida SEQUENCIAL:
 *  detecta a colisão SOMENTE se a escrita concorrente já commitou antes da
 *  leitura). Duas chamadas verdadeiramente CONCORRENTES podem ambas passar
 *  pelo pre-check antes de qualquer INSERT acontecer — só este catch,
 *  reagindo à violação real da constraint depois que o `db.batch()`
 *  (atômico) já reverteu tudo, decide quem vence de verdade. */
function isUniqueEventIdViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message) && error.message.includes("daily_training_events");
}

/** Hotfix pós-Sprint 20 (reuso seguro de tentativa após abandon) — mesmo
 *  padrão de `isUniqueActiveAttemptViolation`/`isUniqueEventIdViolation`: a
 *  garantia real de que uma `question_attempt_id` tem no máximo UM item
 *  dono é `idx_daily_training_items_attempt_unique` (migrations/0016).
 *  Esta é a causa raiz do bug original que este hotfix corrige — o `catch`
 *  de `startItem` nunca reconhecia esta constraint específica, deixando o
 *  D1_ERROR bruto escapar como 500. Detectada aqui para virar sempre um 409
 *  controlado e retentável, nunca uma exceção crua — cobre tanto a corrida
 *  real na transferência de posse (seção 6 do hotfix) quanto qualquer outra
 *  colisão futura na mesma constraint. */
function isUniqueItemAttemptViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message) && error.message.includes("daily_training_items.question_attempt_id");
}

/** Sprint 20, seção 15 da ordem — "identificar foco sem migration": só
 *  não-nulo quando a lista tem pelo menos um item e TODOS compartilham o
 *  MESMO `primary_pattern_id` não-nulo. Nunca infere pelo primeiro item
 *  quando os demais divergem (lista adaptativa histórica com múltiplos
 *  padrões) — compatibilidade total com listas criadas antes desta
 *  sprint, que continuam a devolver `null` aqui sem quebrar nada. */
async function deriveFocusPattern(db: D1Database, rows: DailyTrainingItemRow[]): Promise<FocusPatternDto | null> {
  if (rows.length === 0) return null;
  const firstPatternId = rows[0].primary_pattern_id;
  if (!firstPatternId) return null;
  if (!rows.every((row) => row.primary_pattern_id === firstPatternId)) return null;
  const pattern = await findPublishedPatternById(db, firstPatternId);
  if (!pattern) return null;
  return { id: pattern.id, slug: pattern.slug, name: pattern.name, mainStrategy: pattern.main_strategy };
}

async function toListDto(db: D1Database, list: DailyTrainingListRow, fixturesAllowed: boolean): Promise<TrainingListDto> {
  const rows = await listItemsForList(db, list.id);
  const items: TrainingItemDto[] = [];
  for (const row of rows) items.push(await itemRowToDto(db, row, fixturesAllowed));
  const focusPattern = await deriveFocusPattern(db, rows);
  return {
    id: list.id,
    date: list.training_date,
    timezone: list.timezone,
    status: list.status,
    estimatedMinutes: list.estimated_minutes,
    itemCount: list.item_count,
    version: list.version,
    createdAt: list.created_at,
    completedAt: list.completed_at,
    items,
    focusPattern,
  };
}

async function itemRowToDto(db: D1Database, row: DailyTrainingItemRow, fixturesAllowed: boolean): Promise<TrainingItemDto> {
  const question = await findQuestionForStudent(db, row.question_id, fixturesAllowed);
  const pattern = row.primary_pattern_id ? await findPublishedPatternById(db, row.primary_pattern_id) : null;
  let isCorrect: boolean | null = null;
  if (row.question_attempt_id && row.status === "completed") {
    const attempt = await findAttemptByIdForUser(db, row.question_attempt_id, row.user_id);
    isCorrect = attempt?.is_correct === 1 ? true : attempt?.is_correct === 0 ? false : null;
  }
  return {
    id: row.id,
    questionId: row.question_id,
    questionCode: question?.code ?? "?",
    patternId: row.primary_pattern_id,
    patternName: pattern?.name ?? null,
    origin: row.origin,
    reason: row.reason,
    reasonLabel: REASON_LABELS[row.reason as DailyTrainingReasonCode] ?? row.reason,
    playerMode: row.player_mode,
    position: row.position,
    estimatedMinutes: row.estimated_minutes,
    status: row.status,
    questionAttemptId: row.question_attempt_id,
    isCorrect,
    skipReason: row.skip_reason,
    version: row.version,
  };
}

/** Núcleo de persistência compartilhado entre `applyList` (adaptativo,
 *  múltiplos padrões) e `applyFocusedByPattern` (Sprint 20 — um único
 *  padrão escolhido pelo aluno): monta lista+itens+evento num único
 *  `db.batch()` atômico. Idêntico byte a byte ao corpo que `applyList`
 *  sempre teve — extraído aqui só para nunca duplicar a composição do
 *  lote entre os dois fluxos (seção 2 da ordem: "não duplicar lifecycle"). */
async function persistNewList(
  db: D1Database,
  userId: string,
  todayCivil: string,
  timezone: string,
  result: DailyTrainingSelectionResult,
  mutationId: string
): Promise<{ listId: string }> {
  const listId = newId();
  const statements = [
    buildInsertListStatement(db, {
      id: listId,
      userId,
      trainingDate: todayCivil,
      timezone,
      estimatedMinutes: result.totalMinutes,
      itemCount: result.items.length,
      mutationId,
    }),
  ];
  for (const item of result.items) {
    statements.push(
      buildInsertItemStatement(db, {
        id: newId(),
        listId,
        userId,
        questionId: item.questionId,
        patternId: item.patternId,
        origin: item.origin,
        reason: item.reason,
        playerMode: item.playerMode,
        position: item.position,
        estimatedMinutes: item.estimatedMinutes,
        errorEntryId: item.errorEntryId ?? null,
        sourceScheduleAssignmentId: item.sourceScheduleAssignmentId ?? null,
      })
    );
  }
  statements.push(buildListEventInsertStatement(db, { id: mutationId, listId, userId, eventType: "list_created" }));
  await db.batch(statements);
  return { listId };
}

/** POST — mutação explícita e idempotente (seção 6 da ordem). Recomputa os
 *  MESMOS candidatos que `preview` (nunca reaproveita uma prévia
 *  armazenada) e persiste lista+itens ATOMICAMENTE, num único db.batch()
 *  com o núcleo primeiro e o evento incondicional por último. */
export async function applyList(
  db: D1Database,
  userId: string,
  mutationId: string,
  fixturesAllowed: boolean,
  clock: Clock = systemClock
): Promise<MutationResult<{ listId: string }>> {
  const built = await buildCandidates(db, userId, clock, fixturesAllowed);

  const existing = await findActiveListForUserDate(db, userId, built.todayCivil);
  if (existing) {
    // Seção 6 da ordem: "impedir duas listas ativas para o mesmo aluno/data"
    // e "retornar a lista existente em retry idempotente" — já existe uma
    // lista ativa para hoje (desta chamada ou de uma corrida concorrente):
    // devolve a existente, nunca cria uma segunda.
    return { ok: true, changed: false, value: { listId: existing.id } };
  }

  const result = selectDailyTrainingItems({ candidatesByTier: built.candidatesByTier, availableMinutes: built.availableMinutes });
  if (result.items.length === 0) {
    // Seção 8 da ordem: "nenhuma lista vazia é persistida".
    return { ok: false, empty: true };
  }

  try {
    const persisted = await persistNewList(db, userId, built.todayCivil, built.timezone, result, mutationId);
    return { ok: true, changed: true, value: persisted };
  } catch (error) {
    if (isUniqueActiveListViolation(error)) {
      // Corrida real: outra chamada (mesmo aluno, mesma data) venceu entre
      // a leitura acima e este INSERT — a garantia de banco (índice único
      // parcial, migrations/0016) decide, nunca uma checagem em JS que
      // poderia perder a corrida. Vale também quando o vencedor foi uma
      // chamada de `applyFocusedByPattern` (Sprint 20) — o índice único é o
      // mesmo, cego a qual fluxo escreveu primeiro.
      const stillActive = await findActiveListForUserDate(db, userId, built.todayCivil);
      if (stillActive) return { ok: true, changed: false, value: { listId: stillActive.id } };
    }
    throw error;
  }
}

/* ------------------------- Treino focado por padrão (Sprint 20) ------------------------- */

/** Sprint 20, seção 12 da ordem — mapeamento FIXO estado→(reason,
 *  playerMode) para o treino focado, reaproveitando os MESMOS reason
 *  codes/player modes já usados pelo motor adaptativo (nunca uma enum
 *  nova). Idêntico ao mapeamento já aplicado por `buildCandidates` acima
 *  para os quatro primeiros estados. `revisao_pendente` é o único estado
 *  que `buildCandidates` NUNCA mapeia (ali, é coberto pela camada 1 de
 *  revisão vencida) — como o treino focado não tem essa camada separada
 *  (é só o pool do padrão escolhido, seção 10 da ordem), a regra simples e
 *  factual adotada aqui é: `revisao_pendente` significa que o aluno JÁ tem
 *  evidência real neste padrão (confirmedAttempts > 0) mais uma revisão
 *  específica vencida no Caderno de Erros — mais próximo, em espírito, de
 *  "manutenção" (evidência real e sustentada) do que de "sem evidência" ou
 *  "evidência inicial". Mapeado para `pattern_maintenance`/`practice`. A
 *  revisão espaçada em si continua tratada exclusivamente pelo Caderno de
 *  Erros/motor adaptativo geral — esta escolha NUNCA bloqueia ou redireciona
 *  a escolha livre do aluno por este padrão. */
function mapStateToFocusedReason(state: ProvisionalState): { reason: DailyTrainingReasonCode; playerMode: DailyTrainingPlayerMode } {
  switch (state) {
    case "sem_evidencias":
      return { reason: "pattern_exploration", playerMode: "learning" };
    case "evidencias_iniciais":
      return { reason: "pattern_initial_evidence", playerMode: "recognition" };
    case "em_desenvolvimento":
      return { reason: "pattern_in_development", playerMode: "learning" };
    case "consistente_no_recorte":
      return { reason: "pattern_maintenance", playerMode: "practice" };
    case "revisao_pendente":
      return { reason: "pattern_maintenance", playerMode: "practice" };
  }
}

/** Sprint 20, seção 10 da ordem — candidatos para o treino de UM ÚNICO
 *  padrão escolhido livremente pelo aluno. Deliberadamente mais simples que
 *  `buildCandidates`: nunca mistura revisão vencida/compromisso de
 *  cronograma/outros padrões — só o pool REAL de questões publicadas deste
 *  padrão, ordenado com as ainda não vistas recentemente PRIMEIRO e as
 *  vistas recentemente (últimos `RECENT_COMPLETION_EXCLUSION_DAYS` dias)
 *  DEPOIS, como preenchimento honesto de capacidade (seção 11 da ordem:
 *  "nunca preencher com outro padrão só porque faltaram questões" — se só
 *  sobrarem questões recentes, elas SÃO o treino). Devolve um único grupo/
 *  camada de candidatos — como todos compartilham o MESMO patternId,
 *  `selectDailyTrainingItems` relaxa automaticamente o cap de concentração
 *  por padrão (só um padrão distinto existe no pool inteiro), sem precisar
 *  de nenhuma regra nova aqui. */
async function buildFocusedCandidates(db: D1Database, userId: string, clock: Clock, fixturesAllowed: boolean, patternId: string): Promise<BuiltCandidates> {
  const timezone = await getTimezone(db, userId);
  const now = clock.now();
  const nowIso = now.toISOString();
  const todayCivil = civilDateInTimezone(now, timezone);

  const profile = await findProfile(db, userId);
  const availableDays = ((profile?.available_days ? JSON.parse(profile.available_days) : []) as string[]).filter(
    (day): day is WeekdayCode => (["dom", "seg", "ter", "qua", "qui", "sex", "sab"] as string[]).includes(day)
  );
  const dailyMinutes = profile?.daily_minutes ?? 0;
  const todayWeekday = weekdayCodeForCivilDate(todayCivil);
  const availableMinutes = availableDays.includes(todayWeekday) ? dailyMinutes : 0;

  const recentlyCompleted = await listRecentlyCompletedQuestionIds(
    db,
    userId,
    new Date(now.getTime() - RECENT_COMPLETION_EXCLUSION_DAYS * 24 * 60 * 60 * 1000).toISOString()
  );

  const evidence = await getPatternEvidence(db, userId, patternId);
  const hasOverdueActiveReview = evidence.activeErrorEntryStatus === "scheduled" && evidence.nextReviewAt !== null && evidence.nextReviewAt <= nowIso;
  const state = deriveProvisionalState({
    confirmedAttempts: evidence.confirmedAttempts,
    correctCount: evidence.correctCount,
    distinctQuestionsUsed: evidence.distinctQuestionsUsed,
    distinctSessionDates: evidence.distinctPracticeDays,
    hasCorrectReview: evidence.reviewsCorrect > 0,
    firstConfirmedAt: evidence.firstConfirmedAt,
    lastConfirmedAt: evidence.lastPracticeAt,
    attemptsWithHelp: evidence.attemptsWithHelp,
    hasOverdueActiveReview,
  });
  const { reason, playerMode } = mapStateToFocusedReason(state);

  const trainable = await listTrainableQuestionsForPattern(db, patternId, fixturesAllowed);
  const fresh = trainable.filter((q) => !recentlyCompleted.has(q.id));
  const recent = trainable.filter((q) => recentlyCompleted.has(q.id));
  const ordered = [...fresh, ...recent];

  const tier: DailyTrainingCandidate[] = ordered.map((q) => ({
    questionId: q.id,
    patternId,
    reason,
    playerMode,
    estimatedMinutes: estimateItemMinutes(q.tempo_estimado_segundos),
  }));

  return { timezone, todayCivil, availableMinutes, candidatesByTier: [tier] };
}

/** Sprint 20, seção 4 da ordem — catálogo "O que você quer treinar hoje?".
 *  100% somente leitura, uma única consulta agregada (sem N+1). */
export async function listTrainablePatterns(db: D1Database, fixturesAllowed: boolean): Promise<TrainablePatternDto[]> {
  const rows = await listPublishedPatternsWithTrainableCounts(db, fixturesAllowed);
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    mainStrategy: row.main_strategy,
    availableQuestionCount: row.available_count,
    canTrain: row.available_count > 0,
  }));
}

export type FocusedPreviewResult = { ok: true; value: FocusedPreviewDto } | { ok: false; notFound: true };

/** GET .../patterns/:patternId/preview (seção 9 da ordem) — 100% somente
 *  leitura: nunca cria lista, item, tentativa, progresso ou auditoria. Um
 *  `patternId` inexistente e um de padrão NÃO publicado (rascunho/
 *  arquivado) devolvem exatamente o mesmo `notFound` — nunca revela a
 *  existência de um padrão não publicado (mesma convenção de
 *  `findPublishedPatternById`/`findPublishedPatternBySlug` em todo o
 *  projeto). */
export async function previewFocusedByPattern(
  db: D1Database,
  userId: string,
  patternId: string,
  fixturesAllowed: boolean,
  clock: Clock = systemClock
): Promise<FocusedPreviewResult> {
  const pattern = await findPublishedPatternById(db, patternId);
  if (!pattern) return { ok: false, notFound: true };

  const built = await buildFocusedCandidates(db, userId, clock, fixturesAllowed, patternId);
  const result = selectDailyTrainingItems({ candidatesByTier: built.candidatesByTier, availableMinutes: built.availableMinutes });

  const items: TrainingItemDto[] = [];
  for (const item of result.items) items.push(await selectionItemToDto(db, item, fixturesAllowed));

  const compositionMap = new Map<DailyTrainingReasonCode, number>();
  for (const item of result.items) compositionMap.set(item.reason, (compositionMap.get(item.reason) ?? 0) + 1);
  const composition = Array.from(compositionMap.entries()).map(([reason, count]) => ({ reason, reasonLabel: REASON_LABELS[reason], count }));

  return {
    ok: true,
    value: {
      date: built.todayCivil,
      timezone: built.timezone,
      hasAvailabilityToday: built.availableMinutes > 0,
      availableMinutesToday: built.availableMinutes,
      estimatedMinutes: result.totalMinutes,
      itemCount: items.length,
      items,
      composition,
      focusPattern: { id: pattern.id, slug: pattern.slug, name: pattern.name, mainStrategy: pattern.main_strategy },
    },
  };
}

export type ApplyFocusedResult = MutationResult<{ listId: string }> & { notFound?: boolean };

/** POST .../patterns/:patternId/apply (seção 13 da ordem) — mesmo desenho
 *  de atomicidade/idempotência/concorrência de `applyList` (mesmo índice
 *  único parcial `idx_daily_training_lists_one_active_per_day` decide quem
 *  vence quando dois padrões diferentes são aplicados ao mesmo tempo,
 *  seção 14 da ordem), só trocando `buildCandidates` por
 *  `buildFocusedCandidates`. TODOS os itens criados carregam
 *  `primary_pattern_id = patternId` (garantido por `buildFocusedCandidates`
 *  atribuir o mesmo `patternId` a cada candidato). */
export async function applyFocusedByPattern(
  db: D1Database,
  userId: string,
  patternId: string,
  mutationId: string,
  fixturesAllowed: boolean,
  clock: Clock = systemClock
): Promise<ApplyFocusedResult> {
  const pattern = await findPublishedPatternById(db, patternId);
  if (!pattern) return { ok: false, notFound: true };

  const built = await buildFocusedCandidates(db, userId, clock, fixturesAllowed, patternId);

  const existing = await findActiveListForUserDate(db, userId, built.todayCivil);
  if (existing) {
    // Seção 6/14 da ordem: já existe lista ativa hoje (desta escolha ou de
    // uma concorrente, inclusive de OUTRO padrão) — devolve a existente,
    // nunca cria uma segunda. O frontend precisa carregar a lista REAL
    // devolvida, nunca assumir que o padrão clicado "ganhou".
    return { ok: true, changed: false, value: { listId: existing.id } };
  }

  const result = selectDailyTrainingItems({ candidatesByTier: built.candidatesByTier, availableMinutes: built.availableMinutes });
  if (result.items.length === 0) {
    // Seção 8/23 da ordem: nunca persiste lista vazia — inclusive quando o
    // padrão escolhido tem questões reais mas 0 minutos disponíveis hoje.
    return { ok: false, empty: true };
  }

  try {
    const persisted = await persistNewList(db, userId, built.todayCivil, built.timezone, result, mutationId);
    return { ok: true, changed: true, value: persisted };
  } catch (error) {
    if (isUniqueActiveListViolation(error)) {
      const stillActive = await findActiveListForUserDate(db, userId, built.todayCivil);
      if (stillActive) return { ok: true, changed: false, value: { listId: stillActive.id } };
    }
    throw error;
  }
}

/* ---------------------------------- Leitura de lista ---------------------------------- */

/** GET /api/daily-training/current — devolve a lista ATIVA de hoje quando
 *  existir; senão, a mais recente já criada hoje (completed/abandoned),
 *  para que um refresh depois de concluir/abandonar continue mostrando o
 *  mesmo estado terminal em vez de voltar silenciosamente a uma prévia
 *  nova (seção 12 da ordem: "refresh sem perda de progresso"). `null`
 *  apenas quando NENHUMA lista existe ainda para hoje — só nesse caso o
 *  frontend cai para o preview. Continua 100% somente leitura. */
export async function getCurrent(db: D1Database, userId: string, fixturesAllowed: boolean, clock: Clock = systemClock): Promise<TrainingListDto | null> {
  const timezone = await getTimezone(db, userId);
  const today = civilDateInTimezone(clock.now(), timezone);
  const list = await findLatestListForUserDate(db, userId, today);
  if (!list) return null;
  return toListDto(db, list, fixturesAllowed);
}

export async function getListDetail(db: D1Database, userId: string, listId: string, fixturesAllowed: boolean): Promise<TrainingListDto | null> {
  const list = await findListForUser(db, listId, userId);
  if (!list) return null;
  return toListDto(db, list, fixturesAllowed);
}

/* ------------------------------------- Início do item ------------------------------------- */

export interface StartItemResult extends MutationResult<{ attemptId: string; questionId: string }> {
  blocked?: boolean;
}

/** POST .../items/:itemId/start (seção 10 da ordem) — reutiliza o
 *  serviço/contrato do Player já existente, mas agora compondo os
 *  statements de criação/retomada da tentativa (planStartOrResumeAttempt/
 *  planStartOrResumeReviewAttempt, worker/src/services/playerService.ts)
 *  no MESMO `db.batch()` que associa a tentativa ao item e grava o evento
 *  `item_started` (PO v1.1, correção de atomicidade — seções 1-3): "criar/
 *  retomar a tentativa" e "associar ao item" nunca são duas transações
 *  separadas. Quando a tentativa JÁ existe e é retomável
 *  (`plan.alreadyActive`), não há statement de criação nenhum para incluir
 *  — a associação sozinha já era atômica antes (um único `db.batch()`) e
 *  continua sendo. Só quando uma tentativa NOVA precisa ser criada é que a
 *  composição num único lote passa a ser necessária para fechar a janela
 *  de órfã. */
export async function startItem(
  db: D1Database,
  userId: string,
  listId: string,
  itemId: string,
  mutationId: string,
  fixturesAllowed: boolean
): Promise<StartItemResult> {
  const list = await findListForUser(db, listId, userId);
  if (!list) return { ok: false, notFound: true };
  if (list.status !== "active") return { ok: false, fieldErrors: { status: "Esta lista não está mais ativa." } };

  const item = await findItemForListAndUser(db, itemId, listId, userId);
  if (!item) return { ok: false, notFound: true };

  if (item.status === "in_progress" && item.question_attempt_id) {
    return { ok: true, changed: false, value: { attemptId: item.question_attempt_id, questionId: item.question_id } };
  }
  if (item.status !== "pending") {
    return { ok: false, fieldErrors: { status: "Este item não pode ser iniciado neste estado." } };
  }

  // PO v1.1 (seção 4) — `daily_training_events.id` é a PRIMARY KEY GLOBAL
  // da tabela (mutationId), nunca escopada por item/lista: reaproveitar um
  // mutationId já usado por OUTRA mutação real (deste item ou de QUALQUER
  // outro item/lista) colidiria na própria constraint dentro do
  // `db.batch()` abaixo — nunca uma exceção crua/500, sempre um conflito
  // controlado (409). Um retry LEGÍTIMO do próprio `start` nunca chega
  // aqui: já foi devolvido acima pelo check `status === "in_progress" &&
  // question_attempt_id` (idempotência), então qualquer mutationId que
  // sobreviva até este ponto e já exista na tabela de eventos é, por
  // construção, uma colisão genuína.
  if (await dailyTrainingEventIdInUse(db, mutationId)) {
    return { ok: false, conflict: true };
  }

  async function markBlocked(): Promise<void> {
    const blockMutationId = newId();
    try {
      await db.batch([
        buildBlockItemStatement(db, { itemId: item!.id, listId, userId, guardVersion: item!.version, mutationId: blockMutationId }),
        buildItemEventInsertStatement(db, { id: blockMutationId, listId, itemId: item!.id, userId, eventType: "item_blocked" }),
      ]);
    } catch {
      // Corrida ao bloquear — não crítico (o item só fica "pending" um
      // pouco mais, retentável na próxima leitura); nunca mascara o erro
      // original ao aluno.
    }
  }

  let plan: AttemptStartPlan;
  let rereadWinnerAttemptId: () => Promise<string | null>;

  if (item.error_entry_id) {
    const entry = await findEntryById(db, item.error_entry_id, userId);
    if (!entry || entry.status === "archived") {
      await markBlocked();
      return { ok: false, blocked: true, fieldErrors: { question: "Esta revisão não está mais disponível." } };
    }
    const questionVersion = (await findQuestionForStudent(db, item.question_id, fixturesAllowed))?.version ?? 1;
    const planned = await planStartOrResumeReviewAttempt(db, userId, item.error_entry_id, entry.version, item.question_id, questionVersion);
    if (!planned.ok) {
      if (planned.notFound) {
        await markBlocked();
        return { ok: false, blocked: true, fieldErrors: { question: "Esta questão não está mais disponível." } };
      }
      return { ok: false, fieldErrors: planned.fieldErrors };
    }
    plan = planned.plan;
    const errorEntryId = item.error_entry_id;
    rereadWinnerAttemptId = async () => (await findActiveReviewAttempt(db, userId, errorEntryId))?.id ?? null;
  } else {
    const question = await findQuestionForStudent(db, item.question_id, fixturesAllowed);
    if (!question || question.editorial_status !== "published") {
      await markBlocked();
      return { ok: false, blocked: true, fieldErrors: { question: "Esta questão não está mais disponível." } };
    }
    const planned = await planStartOrResumeAttempt(db, userId, item.question_id, item.player_mode, fixturesAllowed);
    if (!planned.ok) {
      if (planned.notFound) {
        await markBlocked();
        return { ok: false, blocked: true, fieldErrors: { question: "Esta questão não está mais disponível." } };
      }
      return { ok: false, fieldErrors: planned.fieldErrors };
    }
    plan = planned.plan;
    const questionId = item.question_id;
    const playerMode = item.player_mode;
    rereadWinnerAttemptId = async () => (await findActiveAttempt(db, userId, questionId, playerMode))?.id ?? null;
  }

  // Hotfix pós-Sprint 20, seções 5/6/9 — quando a tentativa JÁ existe
  // (`plan.alreadyActive`), ela pode já estar presa a OUTRO item
  // (idx_daily_training_items_attempt_unique permite só um dono por vez —
  // causa raiz do bug original). Detecta ANTES de tentar associar:
  //   - dono numa lista já ABANDONED e ainda não completed → transferência
  //     segura, atômica, no MESMO batch (caso C);
  //   - dono numa lista ATIVA diferente, ou já COMPLETED → nunca rouba,
  //     fail-closed com conflito controlado (casos D/E). `owner` já vem
  //     escopado por user_id no próprio SQL (nunca confia só no attemptId).
  let transferStatement: D1PreparedStatement | null = null;
  if (plan.alreadyActive) {
    const owner = await findAttemptOwnerWithListStatus(db, plan.attemptId, userId);
    if (owner && owner.id !== item.id) {
      if (owner.list_status === "abandoned" && owner.status !== "completed") {
        transferStatement = buildReleaseSpecificItemAttemptStatement(db, {
          itemId: owner.id,
          userId,
          questionAttemptId: plan.attemptId,
        });
      } else {
        return { ok: false, conflict: true };
      }
    }
  }

  function buildAssociationStatements(attemptId: string) {
    return [
      ...(transferStatement ? [transferStatement] : []),
      buildStartItemStatement(db, { itemId: item!.id, listId, userId, guardVersion: item!.version, mutationId, questionAttemptId: attemptId }),
      buildItemEventInsertStatement(db, { id: mutationId, listId, itemId: item!.id, userId, eventType: "item_started" }),
    ];
  }

  async function handleAssociationFailure(error: unknown, attemptId: string): Promise<StartItemResult> {
    const after = await findItemForListAndUser(db, itemId, listId, userId);
    if (!after) return { ok: false, notFound: true };
    if (after.status === "in_progress" && after.question_attempt_id === attemptId) {
      // Retry LEGÍTIMO da MESMA operação (mesmo item, mesmo mutationId)
      // colidindo consigo mesma numa corrida real — checado ANTES da
      // violação de identidade abaixo: uma colisão na PK de
      // daily_training_events causada pela PRÓPRIA mutação bem-sucedida
      // (a outra chamada concorrente idêntica) é sucesso idempotente,
      // nunca um 409.
      return { ok: true, changed: false, value: { attemptId, questionId: item!.question_id } };
    }
    if (isUniqueEventIdViolation(error)) {
      // PO v1.2 — TOCTOU real: a PK de daily_training_events (garantia do
      // banco, não uma checagem em JS que poderia perder a corrida) prova
      // que este mutationId já foi consumido por OUTRA mutação real
      // (verificado acima: NÃO é esta mesma operação retomada). O
      // db.batch() inteiro desta chamada (inclusive a criação/retomada da
      // tentativa) já reverteu — D1 batches são atômicos — então nunca há
      // escrita parcial da perdedora. Sempre um 409 controlado, nunca a
      // exceção crua da constraint.
      return { ok: false, conflict: true };
    }
    if (isUniqueItemAttemptViolation(error)) {
      // Hotfix pós-Sprint 20 — corrida real na TRANSFERÊNCIA de posse (ou
      // qualquer outra colisão na mesma constraint): outra chamada
      // concorrente já reassociou esta tentativa a um item diferente entre
      // nossa leitura do "dono" e este batch. O lote inteiro já reverteu
      // (D1 batches são atômicos) — nunca uma transferência parcial, nunca
      // dois itens apontando para a mesma tentativa. 409 controlado.
      return { ok: false, conflict: true };
    }
    if (after.version === item!.version) throw error; // falha genuína, não conflito.
    return { ok: false, conflict: true };
  }

  try {
    // Seções 1-3 da ordem PO v1.1: `plan.statements` (criação/retomada da
    // tentativa — vazio quando `alreadyActive`) e a associação ao item
    // viajam no MESMO `db.batch()`. Se qualquer statement falhar (inclusive
    // o gatilho de identidade do evento), a transação INTEIRA reverte —
    // nunca uma tentativa criada sem o item associado.
    await db.batch([...plan.statements, ...buildAssociationStatements(plan.attemptId)]);
  } catch (error) {
    if (!plan.alreadyActive && isUniqueActiveAttemptViolation(error)) {
      // Corrida real: OUTRA chamada (Player direto, ou outro start() deste
      // mesmo treino diário) venceu a criação da tentativa entre a leitura
      // do plano e este INSERT — a garantia de banco decide, nunca uma
      // checagem em JS. Todo o lote acima (inclusive nossa tentativa de
      // associação) já foi revertido; relê a tentativa vencedora e associa
      // A ELA, num lote NOVO que só contém item+evento (a tentativa dela já
      // existe de verdade — nada para criar).
      const winnerAttemptId = await rereadWinnerAttemptId();
      if (winnerAttemptId) {
        try {
          await db.batch(buildAssociationStatements(winnerAttemptId));
        } catch (retryError) {
          return handleAssociationFailure(retryError, winnerAttemptId);
        }
        return { ok: true, changed: true, value: { attemptId: winnerAttemptId, questionId: item.question_id } };
      }
    }
    return handleAssociationFailure(error, plan.attemptId);
  }

  return { ok: true, changed: true, value: { attemptId: plan.attemptId, questionId: item.question_id } };
}

/* --------------------------------------- Sync do item --------------------------------------- */

// PO v1.2 — `interface X extends Y {}` sem membros próprios é
// estruturalmente idêntico a `Y` (ESLint @typescript-eslint/no-empty-object-type);
// alias em vez de interface vazia preserva exatamente o mesmo contrato
// público (nenhum chamador muda), sem suprimir a regra.
export type SyncItemResult = MutationResult<{ itemStatus: string; isCorrect: boolean | null }>;

/** POST .../items/:itemId/sync (seção 10 da ordem) — lê a tentativa REAL do
 *  Player; só uma tentativa `completed` pode concluir o item. */
export async function syncItem(db: D1Database, userId: string, listId: string, itemId: string, mutationId: string): Promise<SyncItemResult> {
  const list = await findListForUser(db, listId, userId);
  if (!list) return { ok: false, notFound: true };

  const item = await findItemForListAndUser(db, itemId, listId, userId);
  if (!item) return { ok: false, notFound: true };

  if (item.status === "completed") {
    return { ok: true, changed: false, value: { itemStatus: "completed", isCorrect: null } };
  }
  if (item.status !== "in_progress" || !item.question_attempt_id) {
    return { ok: false, fieldErrors: { status: "Este item não está em andamento." } };
  }
  if (list.status !== "active") return { ok: false, fieldErrors: { status: "Esta lista não está mais ativa." } };

  const attempt = await findAttemptByIdForUser(db, item.question_attempt_id, userId);
  if (!attempt) return { ok: false, notFound: true };

  if (attempt.status !== "completed") {
    // Seção 10 da ordem: "resposta não confirmada não conclui item" — nunca
    // um erro, só um fato honesto: ainda em andamento.
    return { ok: true, changed: false, value: { itemStatus: "in_progress", isCorrect: null } };
  }

  try {
    await db.batch([
      buildCompleteItemStatement(db, { itemId: item.id, listId, userId, guardVersion: item.version, mutationId }),
      buildItemEventInsertStatement(db, { id: mutationId, listId, itemId: item.id, userId, eventType: "item_completed" }),
    ]);
  } catch (error) {
    const after = await findItemForListAndUser(db, itemId, listId, userId);
    if (!after) return { ok: false, notFound: true };
    if (after.status === "completed") return { ok: true, changed: false, value: { itemStatus: "completed", isCorrect: attempt.is_correct === 1 } };
    if (after.version === item.version) throw error;
    return { ok: false, conflict: true };
  }

  return { ok: true, changed: true, value: { itemStatus: "completed", isCorrect: attempt.is_correct === 1 } };
}

/* ---------------------------------------- Pular item ---------------------------------------- */

export const SKIP_REASONS = ["not_now", "too_hard", "already_know", "out_of_time"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export async function skipItem(
  db: D1Database,
  userId: string,
  listId: string,
  itemId: string,
  mutationId: string,
  skipReason: string
): Promise<MutationResult<null>> {
  if (!(SKIP_REASONS as readonly string[]).includes(skipReason)) {
    return { ok: false, fieldErrors: { skipReason: "Motivo de pular inválido." } };
  }
  const list = await findListForUser(db, listId, userId);
  if (!list) return { ok: false, notFound: true };
  if (list.status !== "active") return { ok: false, fieldErrors: { status: "Esta lista não está mais ativa." } };

  const item = await findItemForListAndUser(db, itemId, listId, userId);
  if (!item) return { ok: false, notFound: true };

  if (item.status === "skipped") return { ok: true, changed: false };
  if (item.status !== "pending" && item.status !== "in_progress") {
    return { ok: false, fieldErrors: { status: "Este item não pode ser pulado neste estado." } };
  }

  try {
    await db.batch([
      buildSkipItemStatement(db, { itemId: item.id, listId, userId, guardVersion: item.version, mutationId, skipReason }),
      buildItemEventInsertStatement(db, { id: mutationId, listId, itemId: item.id, userId, eventType: "item_skipped" }),
    ]);
  } catch (error) {
    const after = await findItemForListAndUser(db, itemId, listId, userId);
    if (!after) return { ok: false, notFound: true };
    if (after.status === "skipped") return { ok: true, changed: false };
    if (after.version === item.version) throw error;
    return { ok: false, conflict: true };
  }

  return { ok: true, changed: true };
}

/* --------------------------------- Conclusão/abandono da lista --------------------------------- */

export interface CompletionSummaryDto {
  completedCount: number;
  skippedCount: number;
  blockedCount: number;
  correctCount: number;
  incorrectCount: number;
  patternsPracticed: string[];
  reviewsCompleted: number;
  helpsUsedCount: number;
  approxMinutes: number;
}

async function buildSummary(db: D1Database, list: DailyTrainingListRow): Promise<CompletionSummaryDto> {
  const rows = await listItemsForList(db, list.id);
  let completedCount = 0;
  let skippedCount = 0;
  let blockedCount = 0;
  let correctCount = 0;
  let incorrectCount = 0;
  let reviewsCompleted = 0;
  let helpsUsedCount = 0;
  let approxMinutes = 0;
  const patternIds = new Set<string>();

  for (const row of rows) {
    if (row.status === "completed") {
      completedCount++;
      approxMinutes += row.estimated_minutes;
      if (row.primary_pattern_id) patternIds.add(row.primary_pattern_id);
      if (row.error_entry_id) reviewsCompleted++;
      if (row.question_attempt_id) {
        const attempt = await findAttemptByIdForUser(db, row.question_attempt_id, row.user_id);
        if (attempt?.is_correct === 1) correctCount++;
        else if (attempt?.is_correct === 0) incorrectCount++;
        if (attempt && attempt.highest_help_layer > 0) helpsUsedCount++;
      }
    } else if (row.status === "skipped") {
      skippedCount++;
    } else if (row.status === "blocked") {
      blockedCount++;
    }
  }

  const patternNames: string[] = [];
  for (const id of patternIds) {
    const pattern = await findPublishedPatternById(db, id);
    if (pattern) patternNames.push(pattern.name);
  }

  return {
    completedCount,
    skippedCount,
    blockedCount,
    correctCount,
    incorrectCount,
    patternsPracticed: patternNames.sort(),
    reviewsCompleted,
    helpsUsedCount,
    approxMinutes,
  };
}

// PO v1.2 — mesmo motivo de SyncItemResult acima: alias em vez de
// interface vazia, mesmo contrato público.
export type CompleteListResult = MutationResult<{ summary: CompletionSummaryDto }>;

/** POST .../complete (seção 11 da ordem) — uma lista só pode ser concluída
 *  quando TODOS os itens estiverem em estado terminal. O próprio UPDATE
 *  guardado já exige isso (migrations/0016 / dailyTrainingRepository.ts:
 *  buildCompleteListStatement) — "aborta antes do commit" por construção,
 *  nunca uma checagem em JS separada da escrita real. */
export async function completeList(db: D1Database, userId: string, listId: string, mutationId: string): Promise<CompleteListResult> {
  const list = await findListForUser(db, listId, userId);
  if (!list) return { ok: false, notFound: true };

  if (list.status === "completed") {
    return { ok: true, changed: false, value: { summary: await buildSummary(db, list) } };
  }
  if (list.status !== "active") return { ok: false, fieldErrors: { status: "Esta lista não está mais ativa." } };

  const terminal = await allItemsTerminal(db, listId);
  if (!terminal) return { ok: false, fieldErrors: { items: "Ainda há itens não concluídos, pulados ou bloqueados." } };

  if (list.last_mutation_id === mutationId) {
    return { ok: false, conflict: true };
  }

  const result = await db.batch([
    buildCompleteListStatement(db, { listId, userId, guardVersion: list.version, mutationId }),
    buildListEventInsertStatement(db, { id: mutationId, listId, userId, eventType: "list_completed" }),
  ]);

  if (result[0].meta.changes !== 1) {
    const after = await findListForUser(db, listId, userId);
    if (!after) return { ok: false, notFound: true };
    if (after.status === "completed") return { ok: true, changed: false, value: { summary: await buildSummary(db, after) } };
    if (!(await allItemsTerminal(db, listId))) return { ok: false, fieldErrors: { items: "Ainda há itens não concluídos, pulados ou bloqueados." } };
    return { ok: false, conflict: true };
  }

  const after = await findListForUser(db, listId, userId);
  return { ok: true, changed: true, value: { summary: await buildSummary(db, after!) } };
}

export async function abandonList(db: D1Database, userId: string, listId: string, mutationId: string): Promise<MutationResult<null>> {
  const list = await findListForUser(db, listId, userId);
  if (!list) return { ok: false, notFound: true };

  if (list.status === "abandoned") return { ok: true, changed: false };
  if (list.status !== "active") return { ok: false, fieldErrors: { status: "Esta lista não está mais ativa." } };

  if (list.last_mutation_id === mutationId) return { ok: false, conflict: true };

  const result = await db.batch([
    buildAbandonListStatement(db, { listId, userId, guardVersion: list.version, mutationId }),
    // Hotfix pós-Sprint 20, seção 4 — libera, no MESMO batch atômico, a
    // posse de itens não-completed cuja tentativa do Player segue
    // in_progress: sem isso, um treino futuro com a MESMA questão nunca
    // consegue retomar essa tentativa (idx_daily_training_items_attempt_
    // unique bloqueia dois donos). Nunca toca em item completed nem na
    // tentativa em si (não apaga, não muda status).
    buildReleaseAbandonedItemAttemptsStatement(db, { listId, userId }),
    buildListEventInsertStatement(db, { id: mutationId, listId, userId, eventType: "list_abandoned" }),
  ]);

  if (result[0].meta.changes !== 1) {
    const after = await findListForUser(db, listId, userId);
    if (!after) return { ok: false, notFound: true };
    if (after.status === "abandoned") return { ok: true, changed: false };
    return { ok: false, conflict: true };
  }

  return { ok: true, changed: true };
}

/* ------------------------------- Touch-point do Cronograma ------------------------------- */

/** Seção 13 da ordem — "Cronograma consegue indicar que o compromisso do
 *  dia entrou no treino": usado por scheduleService.ts para marcar, na
 *  visão "hoje", quais atribuições já foram incorporadas à lista ativa do
 *  treino diário. Somente leitura. */
export async function listTodayAssignmentIdsInTraining(db: D1Database, userId: string, todayCivil: string): Promise<Set<string>> {
  return listScheduleAssignmentIdsInActiveTraining(db, userId, todayCivil);
}
