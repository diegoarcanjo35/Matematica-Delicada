/* Serviço do Mapa ENEM do Aluno — Sprint 10 v1.0.

   100% SOMENTE LEITURA — nenhuma função aqui grava nada. `userId` chega
   SEMPRE da sessão (nunca de query/body/path — seção 8 da ordem); as
   rotas (worker/src/routes/studentMetrics.ts) são responsáveis por
   extrair a sessão e nunca aceitam `userId` como parâmetro de entrada
   externo.

   Nenhuma fórmula de reconhecimento/resolução/domínio é calculada aqui —
   só os cinco rótulos provisórios de worker/src/lib/studentMetricsRules.ts,
   sempre derivados de contadores reais (worker/src/repositories/
   studentMetricsRepository.ts). */

import {
  countPublishedPatterns,
  findPublishedPatternById,
  findPublishedPatternBySlug,
  listPublishedPatterns,
  type PatternRow,
} from "../repositories/patternsRepository";
import {
  getPatternEvidence,
  listPatternActiveReviews,
  listPatternAttemptAggregates,
  listPatternHelpAggregates,
  listPatternReviewCounts,
  listRecentActivity,
  type PatternEvidenceRow,
} from "../repositories/studentMetricsRepository";
import { listPublishedPatternsWithTrainableCounts } from "../repositories/dailyTrainingRepository";
import {
  derivePatternAttention,
  deriveProvisionalState,
  PROVISIONAL_STATE_LABELS,
  type PatternAttentionResult,
  type ProvisionalState,
} from "../lib/studentMetricsRules";
import type { Clock } from "./scheduleService";
import { systemClock } from "./scheduleService";

const ALL_PATTERNS_FILTERS = { search: null, content: null, tag: null, evidence: "todos" as const, sort: "codigo" as const };
const MAX_PATTERNS = 500; // teto técnico defensivo — o catálogo real é pequeno (dezenas de padrões).
const MAX_ACTIVITY_ITEMS = 50;

function hasOverdueActiveReview(evidence: PatternEvidenceRow, clock: Clock): boolean {
  if (!evidence.activeErrorEntryId || !evidence.nextReviewAt) return false;
  return new Date(evidence.nextReviewAt).getTime() <= clock.now().getTime();
}

export interface PatternMetricSummaryDTO {
  patternId: string;
  code: string;
  slug: string;
  name: string;
  state: ProvisionalState;
  stateLabel: string;
  questionsStarted: number;
  questionsConfirmed: number;
  correctCount: number;
  incorrectCount: number;
  distinctQuestionsUsed: number;
  helpOpens: number;
  highestHelpLayer: number;
  lastPracticeAt: string | null;
  nextReviewAt: string | null;
  hasActiveErrorEntry: boolean;
}

async function buildPatternMetric(db: D1Database, userId: string, pattern: PatternRow, clock: Clock): Promise<PatternMetricSummaryDTO> {
  const evidence = await getPatternEvidence(db, userId, pattern.id);
  const overdue = hasOverdueActiveReview(evidence, clock);
  const state = deriveProvisionalState({
    confirmedAttempts: evidence.confirmedAttempts,
    correctCount: evidence.correctCount,
    distinctQuestionsUsed: evidence.distinctQuestionsUsed,
    // v1.1 (correção PO, seção 1 da ordem): três sinais novos, sempre
    // derivados de PatternEvidenceRow (nunca recalculados aqui) — ver a
    // justificativa completa de cada um em worker/src/lib/studentMetricsRules.ts.
    distinctSessionDates: evidence.distinctPracticeDays,
    hasCorrectReview: evidence.reviewsCorrect > 0,
    // v1.2 (correção PO, seção 1 da ordem desta rodada): base do intervalo
    // de manutenção de sustainedEvidenceWithoutReview — firstConfirmedAt é
    // novo em PatternEvidenceRow; lastConfirmedAt reaproveita exatamente
    // evidence.lastPracticeAt (mesmo valor, nunca uma segunda consulta).
    firstConfirmedAt: evidence.firstConfirmedAt,
    lastConfirmedAt: evidence.lastPracticeAt,
    attemptsWithHelp: evidence.attemptsWithHelp,
    hasOverdueActiveReview: overdue,
  });
  return {
    patternId: pattern.id,
    code: pattern.code,
    slug: pattern.slug,
    name: pattern.name,
    state,
    stateLabel: PROVISIONAL_STATE_LABELS[state],
    questionsStarted: evidence.questionsStarted,
    questionsConfirmed: evidence.questionsConfirmed,
    correctCount: evidence.correctCount,
    incorrectCount: evidence.incorrectCount,
    distinctQuestionsUsed: evidence.distinctQuestionsUsed,
    helpOpens: evidence.helpOpens,
    highestHelpLayer: evidence.highestHelpLayer,
    lastPracticeAt: evidence.lastPracticeAt,
    nextReviewAt: evidence.nextReviewAt,
    hasActiveErrorEntry: evidence.activeErrorEntryId !== null,
  };
}

/** Lista de métricas por padrão (seção 9, `/api/student-metrics/patterns`).
 *  Sempre TODOS os padrões publicados — filtros de estado/busca/recorte
 *  (seção 9) são aplicados no frontend sobre esta lista completa, nunca
 *  reduzindo o que o backend calcula (o aluno pode alternar filtro sem
 *  nova rodada de requisições). */
export async function listPatternMetrics(db: D1Database, userId: string, clock: Clock = systemClock): Promise<PatternMetricSummaryDTO[]> {
  // Sprint 16 v1.3 — `includeFixtures: false` sempre: o Mapa ENEM é gated
  // por isQuestionBankAvailable (v1.2), não por isLocalPatternFixturesAllowed
  // — não tem um conceito próprio de "fixture de padrões habilitada
  // localmente", então nunca inclui fixture, o lado seguro por padrão.
  const patterns = await listPublishedPatterns(db, userId, ALL_PATTERNS_FILTERS, MAX_PATTERNS, 0, false);
  const results: PatternMetricSummaryDTO[] = [];
  for (const pattern of patterns) {
    results.push(await buildPatternMetric(db, userId, pattern, clock));
  }
  return results;
}

export interface StudentMetricsSummaryDTO {
  totalPublishedPatterns: number;
  hasAnyEvidence: boolean;
  patternsByState: Record<ProvisionalState, number>;
  pendingReviewCount: number;
  lastPracticeAt: string | null;
}

/** Resumo (seção 8, `/api/student-metrics/summary` e seção 11 — bloco do
 *  Dashboard). Nunca fabrica um número quando não há evidência: com zero
 *  tentativas em todos os padrões, `hasAnyEvidence` é `false` e o
 *  Dashboard/página devem mostrar o estado vazio honesto, nunca um "0%". */
export async function getStudentMetricsSummary(db: D1Database, userId: string, clock: Clock = systemClock): Promise<StudentMetricsSummaryDTO> {
  const patterns = await listPatternMetrics(db, userId, clock);
  const totalPublishedPatterns = await countPublishedPatterns(db, userId, ALL_PATTERNS_FILTERS, false);

  const patternsByState: Record<ProvisionalState, number> = {
    sem_evidencias: 0,
    evidencias_iniciais: 0,
    em_desenvolvimento: 0,
    consistente_no_recorte: 0,
    revisao_pendente: 0,
  };
  let lastPracticeAt: string | null = null;
  let hasAnyEvidence = false;

  for (const p of patterns) {
    patternsByState[p.state] += 1;
    if (p.state !== "sem_evidencias") hasAnyEvidence = true;
    if (p.lastPracticeAt && (!lastPracticeAt || p.lastPracticeAt > lastPracticeAt)) {
      lastPracticeAt = p.lastPracticeAt;
    }
  }

  return {
    totalPublishedPatterns,
    hasAnyEvidence,
    patternsByState,
    pendingReviewCount: patternsByState.revisao_pendente,
    lastPracticeAt,
  };
}

export interface PatternMetricDetailDTO extends PatternMetricSummaryDTO {
  attemptsLearning: number;
  attemptsPractice: number;
  attemptsRecognition: number;
  attemptsReview: number;
  recognitionsLogged: number;
  approxTimeSeconds: number;
  reviewsCorrect: number;
  reviewsIncorrect: number;
  lastReviewedAt: string | null;
  nextStepRecommendation: string;
  limitationsNote: string;
}

/** Regra de próxima recomendação — SIMPLES e TRANSPARENTE (seção 10 da
 *  ordem: "recomendação de próximo passo a partir de uma regra técnica
 *  simples e transparente"), nunca uma pontuação. Deriva só do estado
 *  provisório já calculado — não introduz nenhum critério novo. */
function nextStepRecommendation(state: ProvisionalState): string {
  switch (state) {
    case "sem_evidencias":
      return "Pratique pelo menos uma questão deste padrão para começar a registrar evidências reais.";
    case "revisao_pendente":
      return "Há uma revisão pendente no Caderno de Erros para este padrão — resolva-a para atualizar sua evidência.";
    case "evidencias_iniciais":
      return "Continue praticando questões deste padrão para acumular mais evidências.";
    case "em_desenvolvimento":
      return "Pratique mais questões distintas deste padrão para consolidar a evidência neste recorte.";
    case "consistente_no_recorte":
      return "Considere revisar periodicamente para manter a consistência já observada neste recorte.";
    default:
      return "Continue praticando para acumular mais evidências.";
  }
}

const APPROX_TIME_LIMITATION =
  "Tempo aproximado calculado pelo relógio de parede entre o início e a confirmação de cada tentativa — não é tempo efetivamente focado (uma aba deixada aberta infla este número).";

/** Detalhe de UM padrão (seção 10, `/api/student-metrics/patterns/:slug`).
 *  `null` quando o slug não existe OU não está publicado — nunca revela a
 *  diferença entre os dois casos (mesmo 404 do catálogo de padrões desde
 *  a Sprint 6). Nunca aceita id interno, só slug (mesma convenção do
 *  catálogo de padrões voltado ao aluno). */
export async function getPatternMetricDetail(
  db: D1Database,
  userId: string,
  slug: string,
  clock: Clock = systemClock
): Promise<PatternMetricDetailDTO | null> {
  // Sprint 16 v1.3 — `includeFixtures: false` sempre, mesmo raciocínio de
  // listPatternMetrics acima.
  const pattern = await findPublishedPatternBySlug(db, slug, false);
  if (!pattern) return null;

  const summary = await buildPatternMetric(db, userId, pattern, clock);
  const evidence = await getPatternEvidence(db, userId, pattern.id);

  return {
    ...summary,
    attemptsLearning: evidence.attemptsLearning,
    attemptsPractice: evidence.attemptsPractice,
    attemptsRecognition: evidence.attemptsRecognition,
    attemptsReview: evidence.attemptsReview,
    recognitionsLogged: evidence.recognitionsLogged,
    approxTimeSeconds: evidence.approxTimeSeconds,
    reviewsCorrect: evidence.reviewsCorrect,
    reviewsIncorrect: evidence.reviewsIncorrect,
    lastReviewedAt: evidence.lastReviewedAt,
    nextStepRecommendation: nextStepRecommendation(summary.state),
    limitationsNote: APPROX_TIME_LIMITATION,
  };
}

export interface ActivityItemDTO {
  kind: "answer" | "recognition" | "help" | "review";
  patternId: string | null;
  patternName: string | null;
  patternSlug: string | null;
  createdAt: string;
  isCorrect: number | null;
  reviewResult: string | null;
}

/** Atividade recente (seção 8, `/api/student-metrics/activity`) — nenhum
 *  texto livre, só metadados técnicos (seção 13). Resolve nome/slug do
 *  padrão só para os poucos ids distintos presentes na página retornada,
 *  nunca para o catálogo inteiro. */
export async function getRecentActivity(db: D1Database, userId: string, limit: number = MAX_ACTIVITY_ITEMS): Promise<ActivityItemDTO[]> {
  const rows = await listRecentActivity(db, userId, Math.min(limit, MAX_ACTIVITY_ITEMS));

  const patternIds = Array.from(new Set(rows.map((r) => r.patternId).filter((id): id is string => id !== null)));
  const patternById = new Map<string, PatternRow>();
  for (const id of patternIds) {
    const pattern = await findPublishedPatternById(db, id);
    if (pattern) patternById.set(id, pattern);
  }

  return rows.map((row) => {
    const pattern = row.patternId ? patternById.get(row.patternId) ?? null : null;
    return {
      kind: row.kind,
      patternId: row.patternId,
      patternName: pattern?.name ?? null,
      patternSlug: pattern?.slug ?? null,
      createdAt: row.createdAt,
      isCorrect: row.isCorrect,
      reviewResult: row.reviewResult,
    };
  });
}

/* ---------------------------------------------------------------------------
 * Sprint 21 — Dashboard de Desempenho por Padrão. Reaproveita 100% da
 * camada existente (`deriveProvisionalState`, `PROVISIONAL_STATE_LABELS`,
 * a nova `derivePatternAttention`) — nenhuma fórmula de domínio nova.
 * Diferente de `listPatternMetrics` acima (que chama `getPatternEvidence`
 * uma vez POR padrão — aceitável para o Mapa ENEM, que sempre foi uma tela
 * separada), esta função usa 5 consultas AGREGADAS no total, sempre — nunca
 * cresce com o número de padrões publicados (seção 4/21 da ordem). */

export interface PatternPerformanceOverviewItemDTO {
  pattern: { id: string; slug: string; name: string; mainStrategy: string };
  evidence: {
    confirmedAttempts: number;
    correctCount: number;
    incorrectCount: number;
    distinctQuestionsUsed: number;
    distinctPracticeDays: number;
    attemptsWithHelp: number;
    reviewsCorrect: number;
    reviewsIncorrect: number;
    lastPracticeAt: string | null;
  };
  accuracy: number | null;
  state: { code: ProvisionalState; label: string };
  attention: PatternAttentionResult;
  /** Sprint 20 — reaproveita `listPublishedPatternsWithTrainableCounts`
   *  (dailyTrainingRepository.ts) para o CTA "Treinar este padrão" saber,
   *  sem N+1, se há questão publicada elegível (seção 17/18 da ordem). */
  training: { canTrain: boolean; availableQuestionCount: number };
}

/** Prioridade de AÇÃO (nunca nota — seção 10 da ordem: "isso é prioridade
 *  de ação, NÃO nota"). Menor número = mostrado primeiro. */
function performanceSortPriority(state: ProvisionalState, attentionNeeded: boolean): number {
  if (state === "revisao_pendente") return 0;
  if (attentionNeeded) return 1;
  if (state === "em_desenvolvimento") return 2;
  if (state === "evidencias_iniciais") return 3;
  if (state === "sem_evidencias") return 4;
  return 5; // consistente_no_recorte
}

/** Visão agregada de desempenho por padrão (seção 5, endpoint
 *  `/api/student-metrics/patterns/overview`). `fixturesAllowed` chega
 *  SEMPRE calculado pela rota (`isLocalEditorialFixturesAllowed`), mesmo
 *  padrão de todo o namespace do Treino Diário (Sprint 20) — nunca lido de
 *  header/query/body. Ordenação de prioridade de ação aplicada aqui, uma
 *  única vez, nunca recalculada no cliente. */
export async function getPatternPerformanceOverview(
  db: D1Database,
  userId: string,
  fixturesAllowed: boolean,
  clock: Clock = systemClock
): Promise<PatternPerformanceOverviewItemDTO[]> {
  const [catalog, attemptAggregates, helpAggregates, activeReviews, reviewCounts] = await Promise.all([
    listPublishedPatternsWithTrainableCounts(db, fixturesAllowed),
    listPatternAttemptAggregates(db, userId),
    listPatternHelpAggregates(db, userId),
    listPatternActiveReviews(db, userId),
    listPatternReviewCounts(db, userId),
  ]);

  const attemptsByPattern = new Map(attemptAggregates.map((row) => [row.patternId, row]));
  const helpByPattern = new Map(helpAggregates.map((row) => [row.patternId, row]));
  const activeReviewByPattern = new Map(activeReviews.map((row) => [row.patternId, row]));
  const reviewCountsByPattern = new Map(reviewCounts.map((row) => [row.patternId, row]));
  const now = clock.now().getTime();

  const items: PatternPerformanceOverviewItemDTO[] = catalog.map((pattern) => {
    const attempts = attemptsByPattern.get(pattern.id);
    const help = helpByPattern.get(pattern.id);
    const activeReview = activeReviewByPattern.get(pattern.id);
    const reviews = reviewCountsByPattern.get(pattern.id);

    const confirmedAttempts = attempts?.confirmedAttempts ?? 0;
    const correctCount = attempts?.correctCount ?? 0;
    const incorrectCount = attempts?.incorrectCount ?? 0;
    const distinctQuestionsUsed = attempts?.distinctQuestionsUsed ?? 0;
    const distinctPracticeDays = attempts?.distinctPracticeDays ?? 0;
    const firstConfirmedAt = attempts?.firstConfirmedAt ?? null;
    const lastPracticeAt = attempts?.lastPracticeAt ?? null;
    const attemptsWithHelp = help?.attemptsWithHelp ?? 0;
    const reviewsCorrect = reviews?.reviewsCorrect ?? 0;
    const reviewsIncorrect = reviews?.reviewsIncorrect ?? 0;

    // Mesma semântica de `hasOverdueActiveReview` acima (Mapa ENEM): entrada
    // ATIVA (já filtrada na consulta — nunca archived/corrected) com
    // next_review_at já vencido. Nenhum critério novo.
    const hasOverdueActiveReview = Boolean(activeReview?.nextReviewAt && new Date(activeReview.nextReviewAt).getTime() <= now);

    const state = deriveProvisionalState({
      confirmedAttempts,
      correctCount,
      distinctQuestionsUsed,
      distinctSessionDates: distinctPracticeDays,
      hasCorrectReview: reviewsCorrect > 0,
      firstConfirmedAt,
      lastConfirmedAt: lastPracticeAt,
      attemptsWithHelp,
      hasOverdueActiveReview,
    });

    const attention = derivePatternAttention({ state, confirmedAttempts, correctCount, incorrectCount, attemptsWithHelp, reviewsIncorrect });

    const accuracy = correctCount + incorrectCount > 0 ? correctCount / (correctCount + incorrectCount) : null;

    return {
      pattern: { id: pattern.id, slug: pattern.slug, name: pattern.name, mainStrategy: pattern.main_strategy },
      evidence: {
        confirmedAttempts,
        correctCount,
        incorrectCount,
        distinctQuestionsUsed,
        distinctPracticeDays,
        attemptsWithHelp,
        reviewsCorrect,
        reviewsIncorrect,
        lastPracticeAt,
      },
      accuracy,
      state: { code: state, label: PROVISIONAL_STATE_LABELS[state] },
      attention,
      training: { canTrain: pattern.available_count > 0, availableQuestionCount: pattern.available_count },
    };
  });

  items.sort((a, b) => {
    const priorityDiff = performanceSortPriority(a.state.code, a.attention.needed) - performanceSortPriority(b.state.code, b.attention.needed);
    if (priorityDiff !== 0) return priorityDiff;
    return a.pattern.name.localeCompare(b.pattern.name, "pt-BR");
  });

  return items;
}
