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
  buildSkipItemStatement,
  buildStartItemStatement,
  dailyTrainingEventIdInUse,
  findActiveListForUserDate,
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
  type DailyTrainingItemRow,
  type DailyTrainingListRow,
  type TrainableQuestionRow,
} from "../repositories/dailyTrainingRepository";
import { findEntryById, selectSimilarQuestion } from "../repositories/errorNotebookRepository";
import { findQuestionById } from "../repositories/questionRepository";
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
import { deriveProvisionalState } from "../lib/studentMetricsRules";
import {
  MAX_DAILY_TRAINING_ITEMS,
  REASON_LABELS,
  estimateItemMinutes,
  selectDailyTrainingItems,
  type DailyTrainingCandidate,
  type DailyTrainingReasonCode,
  type DailyTrainingSelectionItem,
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
async function buildCandidates(db: D1Database, userId: string, clock: Clock): Promise<BuiltCandidates> {
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
    const selection = await selectSimilarQuestion(db, {
      originalQuestionId: row.originalQuestionId,
      primaryPatternId: row.primaryPatternId,
      excludeQuestionIds: [],
    });
    const question = await findQuestionById(db, selection.questionId);
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
    const trainable = await listTrainableQuestionsForPattern(db, pattern.id);
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

async function selectionItemToDto(db: D1Database, item: DailyTrainingSelectionItem): Promise<TrainingItemDto> {
  const question = await findQuestionById(db, item.questionId);
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
export async function preview(db: D1Database, userId: string, clock: Clock = systemClock): Promise<PreviewDto> {
  const built = await buildCandidates(db, userId, clock);
  const result = selectDailyTrainingItems({ candidatesByTier: built.candidatesByTier, availableMinutes: built.availableMinutes });

  const items: TrainingItemDto[] = [];
  for (const item of result.items) items.push(await selectionItemToDto(db, item));

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

async function toListDto(db: D1Database, list: DailyTrainingListRow): Promise<TrainingListDto> {
  const rows = await listItemsForList(db, list.id);
  const items: TrainingItemDto[] = [];
  for (const row of rows) items.push(await itemRowToDto(db, row));
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
  };
}

async function itemRowToDto(db: D1Database, row: DailyTrainingItemRow): Promise<TrainingItemDto> {
  const question = await findQuestionById(db, row.question_id);
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

/** POST — mutação explícita e idempotente (seção 6 da ordem). Recomputa os
 *  MESMOS candidatos que `preview` (nunca reaproveita uma prévia
 *  armazenada) e persiste lista+itens ATOMICAMENTE, num único db.batch()
 *  com o núcleo primeiro e o evento incondicional por último. */
export async function applyList(db: D1Database, userId: string, mutationId: string, clock: Clock = systemClock): Promise<MutationResult<{ listId: string }>> {
  const built = await buildCandidates(db, userId, clock);

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

  const listId = newId();
  const statements = [
    buildInsertListStatement(db, {
      id: listId,
      userId,
      trainingDate: built.todayCivil,
      timezone: built.timezone,
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

  try {
    await db.batch(statements);
  } catch (error) {
    if (isUniqueActiveListViolation(error)) {
      // Corrida real: outra chamada (mesmo aluno, mesma data) venceu entre
      // a leitura acima e este INSERT — a garantia de banco (índice único
      // parcial, migrations/0016) decide, nunca uma checagem em JS que
      // poderia perder a corrida.
      const stillActive = await findActiveListForUserDate(db, userId, built.todayCivil);
      if (stillActive) return { ok: true, changed: false, value: { listId: stillActive.id } };
    }
    throw error;
  }

  return { ok: true, changed: true, value: { listId } };
}

/* ---------------------------------- Leitura de lista ---------------------------------- */

/** GET /api/daily-training/current — devolve a lista ATIVA de hoje quando
 *  existir; senão, a mais recente já criada hoje (completed/abandoned),
 *  para que um refresh depois de concluir/abandonar continue mostrando o
 *  mesmo estado terminal em vez de voltar silenciosamente a uma prévia
 *  nova (seção 12 da ordem: "refresh sem perda de progresso"). `null`
 *  apenas quando NENHUMA lista existe ainda para hoje — só nesse caso o
 *  frontend cai para o preview. Continua 100% somente leitura. */
export async function getCurrent(db: D1Database, userId: string, clock: Clock = systemClock): Promise<TrainingListDto | null> {
  const timezone = await getTimezone(db, userId);
  const today = civilDateInTimezone(clock.now(), timezone);
  const list = await findLatestListForUserDate(db, userId, today);
  if (!list) return null;
  return toListDto(db, list);
}

export async function getListDetail(db: D1Database, userId: string, listId: string): Promise<TrainingListDto | null> {
  const list = await findListForUser(db, listId, userId);
  if (!list) return null;
  return toListDto(db, list);
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
export async function startItem(db: D1Database, userId: string, listId: string, itemId: string, mutationId: string): Promise<StartItemResult> {
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
    const questionVersion = (await findQuestionById(db, item.question_id))?.version ?? 1;
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
    const question = await findQuestionById(db, item.question_id);
    if (!question || question.editorial_status !== "published") {
      await markBlocked();
      return { ok: false, blocked: true, fieldErrors: { question: "Esta questão não está mais disponível." } };
    }
    const planned = await planStartOrResumeAttempt(db, userId, item.question_id, item.player_mode);
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

  function buildAssociationStatements(attemptId: string) {
    return [
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
