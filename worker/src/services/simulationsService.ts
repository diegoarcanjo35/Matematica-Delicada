/* Serviço dos Simulados em Blocos — Sprint 12 v1.0.

   Orquestra: 1) o algoritmo determinístico puro (worker/src/lib/
   simulationRules.ts) — nunca reimplementado aqui; 2) leitura dos
   candidatos reais (worker/src/repositories/simulationsRepository.ts,
   sempre escopada por user_id no SQL); 3) atomicidade das mutações
   (db.batch() com o núcleo PRIMEIRO e o evento incondicional por ÚLTIMO,
   mesmo padrão de playerService.ts/dailyTrainingService.ts desde as
   Sprints 8/11 — ver o trigger de identidade em migrations/0017).

   Integração com o Player (seção 10 da ordem): reutiliza EXATAMENTE os
   builders/planos transacionais extraídos na Sprint 11
   (planStartOrResumeAttempt, worker/src/services/playerService.ts) — nunca
   chama startOrResumeAttempt (a versão que já executa seu PRÓPRIO
   db.batch()) como caixa-preta, e nunca cria um segundo Player. Mesma
   composição num ÚNICO db.batch() (statements da tentativa + associação ao
   item + evento) que dailyTrainingService.ts:startItem usa como referência.

   Esta sprint NUNCA cria tentativa de REVISÃO (o Caderno de Erros não é
   fonte de itens do simulado — seção 1 da ordem: "usando exclusivamente
   questões publicadas do Banco de Questões") — só
   planStartOrResumeAttempt, modo 'practice', é usado aqui. */

import {
  allItemsTerminal,
  buildAbandonBlockStatement,
  buildBlockEventInsertStatement,
  buildCompleteBlockStatement,
  buildCompleteItemStatement,
  buildInsertBlockStatement,
  buildInsertItemStatement,
  buildItemEventInsertStatement,
  buildMarkItemBlockedStatement,
  buildSkipItemStatement,
  buildStartItemStatement,
  findActiveBlockForUser,
  findBlockForUser,
  findItemForBlockAndUser,
  listBlockHistoryForUser,
  listItemsForBlock,
  listPublishedPatternIds,
  listRecentlyCompletedQuestionIds,
  listTrainableQuestionsForPattern,
  simulationEventIdInUse,
  type HistoryBlockRow,
  type SimulationBlockItemRow,
  type SimulationBlockRow,
} from "../repositories/simulationsRepository";
import { findQuestionForStudent } from "../repositories/questionRepository";
import { findPublishedPatternById, findPublishedPatternBySlug } from "../repositories/patternsRepository";
import { findActiveAttempt, findAttemptByIdForUser } from "../repositories/playerRepository";
import { getPatternEvidence } from "../repositories/studentMetricsRepository";
import { isUniqueActiveAttemptViolation, planStartOrResumeAttempt, type AttemptStartPlan } from "./playerService";
import { getTimezone, systemClock, type Clock } from "./scheduleService";
import { civilDateInTimezone } from "../lib/scheduleValidation";
import {
  ALLOWED_BLOCK_SIZES,
  estimateItemMinutes,
  isAllowedBlockSize,
  selectMixedBlock,
  selectPatternFocusedBlock,
  type RawSimulationCandidate,
  type SimulationBlockSize,
  type SimulationBlockType,
} from "../lib/simulationRules";

function newId(): string {
  return crypto.randomUUID();
}

const PUBLISHED = "published";

export interface MutationResult<T> {
  ok: boolean;
  value?: T;
  notFound?: boolean;
  conflict?: boolean;
  empty?: boolean;
  activeElsewhere?: boolean;
  fieldErrors?: Record<string, string>;
  changed?: boolean;
}

/* ------------------------------------- DTOs ------------------------------------- */

export interface BlockItemDto {
  id: string;
  questionId: string;
  questionCode: string;
  patternId: string | null;
  patternName: string | null;
  position: number;
  estimatedMinutes: number;
  status: string;
  questionAttemptId: string | null;
  isCorrect: boolean | null;
  version: number;
}

export interface BlockDto {
  id: string;
  blockType: SimulationBlockType;
  primaryPatternId: string | null;
  primaryPatternName: string | null;
  status: string;
  plannedItemCount: number;
  actualItemCount: number;
  estimatedMinutes: number;
  timezone: string;
  blockDate: string;
  version: number;
  createdAt: string;
  completedAt: string | null;
  abandonedAt: string | null;
  items: BlockItemDto[];
}

export interface PreviewCompositionEntry {
  patternId: string;
  patternName: string;
  count: number;
}

export interface PreviewDto {
  blockType: SimulationBlockType;
  primaryPatternId: string | null;
  primaryPatternName: string | null;
  requestedSize: SimulationBlockSize;
  availableCount: number;
  selectableCount: number;
  estimatedMinutes: number;
  composition: PreviewCompositionEntry[];
  insufficientQuantity: boolean;
  items: BlockItemDto[];
}

export interface PreviewInput {
  blockType: unknown;
  patternSlug: unknown;
  size: unknown;
}

export type PreviewResult =
  | { ok: true; preview: PreviewDto }
  | { ok: false; fieldErrors: Record<string, string>; notFound?: boolean };

/* ------------------------------ Validação de entrada ------------------------------ */

async function resolveBlockRequest(
  db: D1Database,
  input: PreviewInput,
  fixturesAllowed: boolean
): Promise<{ ok: true; blockType: SimulationBlockType; pattern: { id: string; name: string } | null; size: SimulationBlockSize } | { ok: false; fieldErrors: Record<string, string>; notFound?: boolean }> {
  if (input.blockType !== "mixed" && input.blockType !== "pattern_focused") {
    return { ok: false, fieldErrors: { blockType: "Escolha um tipo de bloco válido: misto ou focado em um padrão." } };
  }
  if (!isAllowedBlockSize(input.size)) {
    return { ok: false, fieldErrors: { size: `Escolha um tamanho válido: ${ALLOWED_BLOCK_SIZES.join(", ")} questões.` } };
  }

  if (input.blockType === "mixed") {
    if (typeof input.patternSlug === "string" && input.patternSlug.trim().length > 0) {
      return { ok: false, fieldErrors: { patternSlug: "Bloco misto não recebe um padrão específico." } };
    }
    return { ok: true, blockType: "mixed", pattern: null, size: input.size };
  }

  // pattern_focused — seção 6 da ordem: exige patternSlug resolvido no
  // servidor; padrão inexistente/rascunho responde 404, sem vazar conteúdo
  // editorial (mesmo contrato de findPublishedPatternBySlug em todo o
  // resto do projeto desde a Sprint 6).
  if (typeof input.patternSlug !== "string" || input.patternSlug.trim().length === 0) {
    return { ok: false, fieldErrors: { patternSlug: "Escolha um padrão para o bloco focado." } };
  }
  // Sprint 16 v1.4 — `includeFixtures: fixturesAllowed` (corrigido; v1.3
  // usava `false` sempre, o que impedia um bloco focado num padrão de
  // fixture mesmo em dev local com a flag — mesmo achado registrado no
  // relatório da v1.3 para o Banco de Questões, agora também corrigido
  // aqui, já que a criação do bloco pattern_focused depende diretamente
  // disto para funcionar localmente).
  const pattern = await findPublishedPatternBySlug(db, input.patternSlug, fixturesAllowed);
  if (!pattern) return { ok: false, notFound: true, fieldErrors: {} };
  return { ok: true, blockType: "pattern_focused", pattern: { id: pattern.id, name: pattern.name }, size: input.size };
}

/* ------------------------------ Construção dos candidatos ------------------------------ */

interface BuiltCandidates {
  timezone: string;
  todayCivil: string;
  recentlyCompleted: Set<string>;
}

async function buildContext(db: D1Database, userId: string, clock: Clock): Promise<BuiltCandidates> {
  const timezone = await getTimezone(db, userId);
  const now = clock.now();
  const todayCivil = civilDateInTimezone(now, timezone);
  // Seção 8 da ordem: "evitar questões concluídas muito recentemente quando
  // houver alternativa" — mesma janela técnica provisória de 3 dias já
  // usada pelo Treino Diário (RECENT_COMPLETION_EXCLUSION_DAYS,
  // dailyTrainingService.ts), reaproveitada aqui sem inventar um segundo
  // número para o mesmo conceito.
  const recentlyCompleted = await listRecentlyCompletedQuestionIds(db, userId, new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString());
  return { timezone, todayCivil, recentlyCompleted };
}

async function candidatesForPattern(db: D1Database, patternId: string, fixturesAllowed: boolean): Promise<RawSimulationCandidate[]> {
  const rows = await listTrainableQuestionsForPattern(db, patternId, fixturesAllowed);
  return rows.map((r) => ({ questionId: r.id, questionCode: r.code, patternId, estimatedMinutes: estimateItemMinutes(r.tempo_estimado_segundos) }));
}

/** Seção 6 da ordem: "usar evidências do Mapa ENEM somente para ordenar,
 *  nunca para excluir definitivamente um padrão" — os grupos de padrão são
 *  ordenados por `lastPracticeAt` ASC (nunca praticado vem primeiro; entre
 *  praticados, o menos recente vem primeiro), nunca um padrão é removido da
 *  lista por causa dessa evidência. Reaproveita getPatternEvidence
 *  (Sprint 10, worker/src/repositories/studentMetricsRepository.ts) — nunca
 *  uma segunda leitura de evidência inventada aqui. */
async function orderedMixedPatternGroups(db: D1Database, userId: string, fixturesAllowed: boolean): Promise<RawSimulationCandidate[][]> {
  const patterns = await listPublishedPatternIds(db);
  const withEvidence: Array<{ patternId: string; code: string; lastPracticeAt: string | null }> = [];
  for (const pattern of patterns) {
    const evidence = await getPatternEvidence(db, userId, pattern.id);
    withEvidence.push({ patternId: pattern.id, code: pattern.code, lastPracticeAt: evidence.lastPracticeAt });
  }
  withEvidence.sort((a, b) => {
    if (a.lastPracticeAt === b.lastPracticeAt) return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
    if (a.lastPracticeAt === null) return -1;
    if (b.lastPracticeAt === null) return 1;
    return a.lastPracticeAt < b.lastPracticeAt ? -1 : 1;
  });

  const groups: RawSimulationCandidate[][] = [];
  for (const entry of withEvidence) {
    const candidates = await candidatesForPattern(db, entry.patternId, fixturesAllowed);
    if (candidates.length > 0) groups.push(candidates);
  }
  return groups;
}

async function computeSelection(
  db: D1Database,
  userId: string,
  blockType: SimulationBlockType,
  pattern: { id: string; name: string } | null,
  size: SimulationBlockSize,
  context: BuiltCandidates,
  fixturesAllowed: boolean
) {
  if (blockType === "pattern_focused") {
    const candidates = await candidatesForPattern(db, pattern!.id, fixturesAllowed);
    return selectPatternFocusedBlock({ candidates, size, recentlyCompletedQuestionIds: context.recentlyCompleted });
  }
  const groups = await orderedMixedPatternGroups(db, userId, fixturesAllowed);
  return selectMixedBlock({ patternGroups: groups, size, recentlyCompletedQuestionIds: context.recentlyCompleted });
}

async function toPreviewCompositionAndItems(
  db: D1Database,
  items: Array<{ questionId: string; patternId: string; estimatedMinutes: number; position: number }>,
  fixturesAllowed: boolean
): Promise<{ composition: PreviewCompositionEntry[]; items: BlockItemDto[] }> {
  const compositionMap = new Map<string, { patternId: string; patternName: string; count: number }>();
  const dtos: BlockItemDto[] = [];
  for (const item of items) {
    const question = await findQuestionForStudent(db, item.questionId, fixturesAllowed);
    const pattern = await findPublishedPatternById(db, item.patternId);
    const patternName = pattern?.name ?? null;
    dtos.push({
      id: "",
      questionId: item.questionId,
      questionCode: question?.code ?? "?",
      patternId: item.patternId,
      patternName,
      position: item.position,
      estimatedMinutes: item.estimatedMinutes,
      status: "pending",
      questionAttemptId: null,
      isCorrect: null,
      version: 0,
    });
    const key = item.patternId;
    const existing = compositionMap.get(key);
    if (existing) existing.count++;
    else compositionMap.set(key, { patternId: item.patternId, patternName: patternName ?? "?", count: 1 });
  }
  return { composition: Array.from(compositionMap.values()), items: dtos };
}

/* ------------------------------------ Preview ------------------------------------ */

/** GET — 100% somente leitura (seção 7 da ordem: "nenhum GET pode criar
 *  bloco, item, tentativa, evento, auditoria, bookmark ou entrada no
 *  Caderno de Erros"). Determinístico para o mesmo usuário/tipo/padrão/
 *  tamanho/estado do banco/relógio injetado. */
export async function preview(
  db: D1Database,
  userId: string,
  input: PreviewInput,
  fixturesAllowed: boolean,
  clock: Clock = systemClock
): Promise<PreviewResult> {
  const resolved = await resolveBlockRequest(db, input, fixturesAllowed);
  if (!resolved.ok) return resolved;

  const context = await buildContext(db, userId, clock);
  const selection = await computeSelection(db, userId, resolved.blockType, resolved.pattern, resolved.size, context, fixturesAllowed);
  const { composition, items } = await toPreviewCompositionAndItems(db, selection.items, fixturesAllowed);

  return {
    ok: true,
    preview: {
      blockType: resolved.blockType,
      primaryPatternId: resolved.pattern?.id ?? null,
      primaryPatternName: resolved.pattern?.name ?? null,
      requestedSize: resolved.size,
      availableCount: selection.availableCount,
      selectableCount: selection.items.length,
      estimatedMinutes: selection.totalMinutes,
      composition,
      insufficientQuantity: selection.items.length < resolved.size,
      items,
    },
  };
}

/* -------------------------------------- Apply -------------------------------------- */

function isUniqueActiveBlockViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message) && error.message.includes("simulation_blocks");
}

async function toBlockDto(db: D1Database, block: SimulationBlockRow, fixturesAllowed: boolean): Promise<BlockDto> {
  const rows = await listItemsForBlock(db, block.id);
  const items: BlockItemDto[] = [];
  for (const row of rows) items.push(await itemRowToDto(db, row, fixturesAllowed));
  const primaryPattern = block.primary_pattern_id ? await findPublishedPatternById(db, block.primary_pattern_id) : null;
  return {
    id: block.id,
    blockType: block.block_type,
    primaryPatternId: block.primary_pattern_id,
    primaryPatternName: primaryPattern?.name ?? null,
    status: block.status,
    plannedItemCount: block.planned_item_count,
    actualItemCount: block.actual_item_count,
    estimatedMinutes: block.estimated_minutes,
    timezone: block.timezone,
    blockDate: block.block_date,
    version: block.version,
    createdAt: block.created_at,
    completedAt: block.completed_at,
    abandonedAt: block.abandoned_at,
    items,
  };
}

async function itemRowToDto(db: D1Database, row: SimulationBlockItemRow, fixturesAllowed: boolean): Promise<BlockItemDto> {
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
    position: row.position,
    estimatedMinutes: row.estimated_minutes,
    status: row.status,
    questionAttemptId: row.question_attempt_id,
    isCorrect,
    version: row.version,
  };
}

export interface ApplyInput extends PreviewInput {
  mutationId: string;
}

const ACTIVE_ELSEWHERE_FIELD_ERRORS = { block: "Você já tem um bloco de simulado ativo. Conclua ou abandone-o antes de aplicar um novo." };

/** PO v1.1 (seção 1 da ordem de correção) — decide o que fazer quando JÁ
 *  existe um bloco `active` para este aluno, no momento em que este
 *  `applyBlock` também quer agir. A identidade da mutação (`mutationId`),
 *  NUNCA a igualdade de conteúdo (tipo/padrão/tamanho), é o que prova se
 *  esta chamada é um retry LEGÍTIMO de uma mutação já aplicada:
 *
 *  - MESMO `mutationId` do bloco ativo E mesma configuração → retry
 *    idempotente real (a PRÓPRIA mutação que criou este bloco) —
 *    `changed:false`, devolve o bloco existente.
 *  - MESMO `mutationId` do bloco ativo mas configuração DIFERENTE → essa
 *    identidade de mutação já foi consumida por OUTRA operação real (este
 *    `mutationId` não pode significar duas coisas) — 409 controlado, nunca
 *    tratado como retry.
 *  - `mutationId` DIFERENTE do bloco ativo, mesmo com configuração
 *    idêntica — igualdade de tipo/padrão/tamanho NUNCA prova que são a
 *    MESMA mutação — é um conflito de domínio controlado e explícito
 *    (`activeElsewhere`): o aluno já tem uma sessão ativa, esta é uma
 *    tentativa de abrir uma segunda, nunca disfarçada de sucesso
 *    silencioso. */
function classifyActiveBlockCollision(
  existingActive: SimulationBlockRow,
  input: ApplyInput,
  resolved: { blockType: SimulationBlockType; pattern: { id: string; name: string } | null; size: SimulationBlockSize }
): MutationResult<{ blockId: string }> {
  const sameRequest =
    existingActive.block_type === resolved.blockType &&
    existingActive.primary_pattern_id === (resolved.pattern?.id ?? null) &&
    existingActive.planned_item_count === resolved.size;

  if (existingActive.last_mutation_id === input.mutationId) {
    if (sameRequest) return { ok: true, changed: false, value: { blockId: existingActive.id } };
    return { ok: false, conflict: true };
  }
  return { ok: false, activeElsewhere: true, fieldErrors: ACTIVE_ELSEWHERE_FIELD_ERRORS };
}

/** POST — mutação explícita, atômica e idempotente (seção 9 da ordem).
 *  Recomputa os MESMOS candidatos que `preview` (nunca reaproveita uma
 *  prévia armazenada — não existe tabela de prévia nesta sprint, mesma
 *  decisão do Treino Diário) e persiste bloco+itens ATOMICAMENTE, num único
 *  db.batch() com o núcleo primeiro e o evento incondicional por último. */
export async function applyBlock(
  db: D1Database,
  userId: string,
  input: ApplyInput,
  fixturesAllowed: boolean,
  clock: Clock = systemClock
): Promise<MutationResult<{ blockId: string }>> {
  const resolved = await resolveBlockRequest(db, input, fixturesAllowed);
  if (!resolved.ok) return { ok: false, notFound: resolved.notFound, fieldErrors: resolved.fieldErrors };

  const existingActive = await findActiveBlockForUser(db, userId);
  if (existingActive) return classifyActiveBlockCollision(existingActive, input, resolved);

  // PO v1.1 — nenhum bloco ativo agora, mas este `mutationId` pode já ter
  // sido consumido por OUTRA mutação real (um apply anterior cujo bloco já
  // foi concluído/abandonado, ou qualquer evento de item/bloco de outro
  // recurso deste aluno) — `simulation_block_events.id` é PK GLOBAL da
  // tabela (mesmo raciocínio de `simulationEventIdInUse` usado por
  // start/sync/skip abaixo). Reaproveitar essa identidade para uma mutação
  // nova e diferente é um conflito controlado, nunca uma exceção crua do
  // INSERT do evento vazando para o chamador.
  if (await simulationEventIdInUse(db, input.mutationId)) {
    return { ok: false, conflict: true };
  }

  const context = await buildContext(db, userId, clock);
  const selection = await computeSelection(db, userId, resolved.blockType, resolved.pattern, resolved.size, context, fixturesAllowed);
  if (selection.items.length === 0) {
    // Seção 9 da ordem: "nunca persistir bloco vazio".
    return { ok: false, empty: true };
  }

  const blockId = newId();
  const statements = [
    buildInsertBlockStatement(db, {
      id: blockId,
      userId,
      blockType: resolved.blockType,
      primaryPatternId: resolved.pattern?.id ?? null,
      plannedItemCount: resolved.size,
      actualItemCount: selection.items.length,
      estimatedMinutes: selection.totalMinutes,
      timezone: context.timezone,
      blockDate: context.todayCivil,
      mutationId: input.mutationId,
    }),
  ];
  for (const item of selection.items) {
    statements.push(
      buildInsertItemStatement(db, {
        id: newId(),
        blockId,
        userId,
        questionId: item.questionId,
        patternId: item.patternId,
        position: item.position,
        estimatedMinutes: item.estimatedMinutes,
      })
    );
  }
  statements.push(buildBlockEventInsertStatement(db, { id: input.mutationId, blockId, userId, eventType: "block_applied" }));

  try {
    await db.batch(statements);
  } catch (error) {
    if (isUniqueActiveBlockViolation(error)) {
      // Corrida real: outra chamada (mesmo aluno) venceu entre a leitura
      // acima e este INSERT — a garantia de banco (índice único parcial,
      // migrations/0017) decide, nunca uma checagem em JS que poderia
      // perder a corrida. PO v1.1: mesmo aqui, é a IDENTIDADE do
      // mutationId da vencedora (nunca a igualdade de configuração) que
      // decide se esta chamada perdedora recebe um retry idempotente
      // (corrida da MESMA mutação, cenário 5 da ordem) ou um conflito de
      // domínio controlado (corrida de mutações DIFERENTES, cenário 4 —
      // nunca uma exceção crua chegando ao chamador).
      const stillActive = await findActiveBlockForUser(db, userId);
      if (stillActive) return classifyActiveBlockCollision(stillActive, input, resolved);
    }
    throw error;
  }

  return { ok: true, changed: true, value: { blockId } };
}

/* ---------------------------------- Leitura de bloco ---------------------------------- */

/** GET /api/simulations/current — o bloco ATIVO do aluno, quando existir;
 *  `null` senão (o frontend cai para a tela de configuração/preview). 100%
 *  somente leitura. */
export async function getCurrent(db: D1Database, userId: string, fixturesAllowed: boolean): Promise<BlockDto | null> {
  const block = await findActiveBlockForUser(db, userId);
  if (!block) return null;
  return toBlockDto(db, block, fixturesAllowed);
}

export async function getBlockDetail(db: D1Database, userId: string, blockId: string, fixturesAllowed: boolean): Promise<BlockDto | null> {
  const block = await findBlockForUser(db, blockId, userId);
  if (!block) return null;
  return toBlockDto(db, block, fixturesAllowed);
}

/* ------------------------------------- Início do item ------------------------------------- */

export interface StartItemResult extends MutationResult<{ attemptId: string; questionId: string }> {
  blocked?: boolean;
}

/** POST .../items/:itemId/start (seção 10 da ordem) — reutiliza o plano
 *  transacional do Player (planStartOrResumeAttempt, worker/src/services/
 *  playerService.ts), compondo os statements de criação/retomada da
 *  tentativa no MESMO `db.batch()` que associa a tentativa ao item e grava
 *  o evento `item_started` — nunca duas transações separadas (mesma
 *  correção de atomicidade extraída na Sprint 11 v1.1/v1.2, reaproveitada
 *  aqui, nunca reimplementada). */
export async function startItem(
  db: D1Database,
  userId: string,
  blockId: string,
  itemId: string,
  mutationId: string,
  fixturesAllowed: boolean
): Promise<StartItemResult> {
  const block = await findBlockForUser(db, blockId, userId);
  if (!block) return { ok: false, notFound: true };
  if (block.status !== "active") return { ok: false, fieldErrors: { status: "Este bloco não está mais ativo." } };

  const itemOrNull = await findItemForBlockAndUser(db, itemId, blockId, userId);
  if (!itemOrNull) return { ok: false, notFound: true };
  // Capturado num `const` com tipo NÃO-nulo declarado (não só uma
  // estreita de fluxo) — as funções aninhadas abaixo (`buildAssociation
  // Statements`/`handleAssociationFailure`) fecham sobre esta variável, e o
  // TypeScript não propaga estreitamentos de fluxo através de fechamentos
  // de função declarada, só o TIPO DECLARADO da própria variável.
  const item: SimulationBlockItemRow = itemOrNull;

  if (item.status === "in_progress" && item.question_attempt_id) {
    return { ok: true, changed: false, value: { attemptId: item.question_attempt_id, questionId: item.question_id } };
  }
  if (item.status !== "pending") {
    return { ok: false, fieldErrors: { status: "Este item não pode ser iniciado neste estado." } };
  }

  // Sprint 11 v1.1/v1.2 (seção 4 daquela ordem), mesma proteção reaplicada
  // aqui: `simulation_block_events.id` é a PRIMARY KEY GLOBAL da tabela
  // (mutationId), nunca escopada por item/bloco — reaproveitar um
  // mutationId já usado por OUTRA mutação real colidiria na própria
  // constraint dentro do `db.batch()` abaixo. Um retry LEGÍTIMO do próprio
  // `start` nunca chega aqui (já devolvido acima pela checagem de
  // idempotência).
  if (await simulationEventIdInUse(db, mutationId)) {
    return { ok: false, conflict: true };
  }

  const question = await findQuestionForStudent(db, item.question_id, fixturesAllowed);
  if (!question || question.editorial_status !== PUBLISHED) {
    const blockMutationId = newId();
    try {
      await db.batch([
        buildMarkItemBlockedStatement(db, { itemId: item.id, blockId, userId, guardVersion: item.version, mutationId: blockMutationId }),
        buildItemEventInsertStatement(db, { id: blockMutationId, blockId, itemId: item.id, userId, eventType: "item_blocked" }),
      ]);
    } catch {
      // Corrida ao bloquear — não crítico (o item só fica "pending" um
      // pouco mais, retentável na próxima leitura); nunca mascara o erro
      // original ao aluno.
    }
    return { ok: false, blocked: true, fieldErrors: { question: "Esta questão não está mais disponível." } };
  }

  const planned = await planStartOrResumeAttempt(db, userId, item.question_id, "practice", fixturesAllowed);
  if (!planned.ok) {
    if (planned.notFound) return { ok: false, blocked: true, fieldErrors: { question: "Esta questão não está mais disponível." } };
    return { ok: false, fieldErrors: planned.fieldErrors };
  }
  const plan: AttemptStartPlan = planned.plan;

  function buildAssociationStatements(attemptId: string) {
    return [
      buildStartItemStatement(db, { itemId: item.id, blockId, userId, guardVersion: item.version, mutationId, questionAttemptId: attemptId }),
      buildItemEventInsertStatement(db, { id: mutationId, blockId, itemId: item.id, userId, eventType: "item_started" }),
    ];
  }

  async function handleAssociationFailure(error: unknown, attemptId: string): Promise<StartItemResult> {
    const after = await findItemForBlockAndUser(db, itemId, blockId, userId);
    if (!after) return { ok: false, notFound: true };
    if (after.status === "in_progress" && after.question_attempt_id === attemptId) {
      // Retry LEGÍTIMO da MESMA operação colidindo consigo mesma numa
      // corrida real — sucesso idempotente, nunca um 409 (mesmo raciocínio
      // de dailyTrainingService.ts:startItem).
      return { ok: true, changed: false, value: { attemptId, questionId: item.question_id } };
    }
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message) && error.message.includes("simulation_block_events")) {
      // TOCTOU real: a PK de simulation_block_events (garantia do banco)
      // prova que este mutationId já foi consumido por OUTRA mutação real.
      // O db.batch() inteiro desta chamada já reverteu (D1 batches são
      // atômicos) — nunca há escrita parcial da perdedora.
      return { ok: false, conflict: true };
    }
    if (after.version === item.version) throw error; // falha genuína, não conflito.
    return { ok: false, conflict: true };
  }

  try {
    await db.batch([...plan.statements, ...buildAssociationStatements(plan.attemptId)]);
  } catch (error) {
    if (!plan.alreadyActive && isUniqueActiveAttemptViolation(error)) {
      // Corrida real: OUTRA chamada (Player direto, ou outro start() deste
      // mesmo simulado) venceu a criação da tentativa entre a leitura do
      // plano e este INSERT — relê a tentativa vencedora e associa A ELA,
      // num lote NOVO que só contém item+evento.
      const questionId = item.question_id;
      const winner = await findActiveAttempt(db, userId, questionId, "practice");
      if (winner) {
        try {
          await db.batch(buildAssociationStatements(winner.id));
        } catch (retryError) {
          return handleAssociationFailure(retryError, winner.id);
        }
        return { ok: true, changed: true, value: { attemptId: winner.id, questionId: item.question_id } };
      }
    }
    return handleAssociationFailure(error, plan.attemptId);
  }

  return { ok: true, changed: true, value: { attemptId: plan.attemptId, questionId: item.question_id } };
}

/* --------------------------------------- Sync do item --------------------------------------- */

export type SyncItemResult = MutationResult<{ itemStatus: string; isCorrect: boolean | null }>;

/** POST .../items/:itemId/sync (seção 10 da ordem) — lê a tentativa REAL do
 *  Player; só uma tentativa `completed` conclui o item. */
export async function syncItem(db: D1Database, userId: string, blockId: string, itemId: string, mutationId: string): Promise<SyncItemResult> {
  const block = await findBlockForUser(db, blockId, userId);
  if (!block) return { ok: false, notFound: true };

  const item = await findItemForBlockAndUser(db, itemId, blockId, userId);
  if (!item) return { ok: false, notFound: true };

  if (item.status === "completed") {
    return { ok: true, changed: false, value: { itemStatus: "completed", isCorrect: null } };
  }
  if (item.status !== "in_progress" || !item.question_attempt_id) {
    return { ok: false, fieldErrors: { status: "Este item não está em andamento." } };
  }
  if (block.status !== "active") return { ok: false, fieldErrors: { status: "Este bloco não está mais ativo." } };

  const attempt = await findAttemptByIdForUser(db, item.question_attempt_id, userId);
  if (!attempt) return { ok: false, notFound: true };

  if (attempt.status !== "completed") {
    // Seção 10 da ordem: "resposta salva mas não confirmada não conclui
    // item" — nunca um erro, só um fato honesto: ainda em andamento.
    return { ok: true, changed: false, value: { itemStatus: "in_progress", isCorrect: null } };
  }

  try {
    await db.batch([
      buildCompleteItemStatement(db, { itemId: item.id, blockId, userId, guardVersion: item.version, mutationId }),
      buildItemEventInsertStatement(db, { id: mutationId, blockId, itemId: item.id, userId, eventType: "item_completed" }),
    ]);
  } catch (error) {
    // PO v1.1 (mesmo raciocínio de startItem:handleAssociationFailure) —
    // `simulation_block_events.id` é PK GLOBAL: se este `mutationId` já foi
    // consumido por OUTRA mutação real (item/bloco diferente, inclusive
    // fora deste sync), o INSERT colide na própria constraint do banco.
    // Verificado ANTES da checagem de versão abaixo — senão essa colisão
    // seria tratada como "falha genuína" e a exceção crua do D1 vazaria
    // para o chamador em vez de um 409 controlado.
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message) && error.message.includes("simulation_block_events")) {
      return { ok: false, conflict: true };
    }
    const after = await findItemForBlockAndUser(db, itemId, blockId, userId);
    if (!after) return { ok: false, notFound: true };
    if (after.status === "completed") return { ok: true, changed: false, value: { itemStatus: "completed", isCorrect: attempt.is_correct === 1 } };
    if (after.version === item.version) throw error;
    return { ok: false, conflict: true };
  }

  return { ok: true, changed: true, value: { itemStatus: "completed", isCorrect: attempt.is_correct === 1 } };
}

/* ---------------------------------------- Pular item ---------------------------------------- */

export async function skipItem(db: D1Database, userId: string, blockId: string, itemId: string, mutationId: string): Promise<MutationResult<null>> {
  const block = await findBlockForUser(db, blockId, userId);
  if (!block) return { ok: false, notFound: true };
  if (block.status !== "active") return { ok: false, fieldErrors: { status: "Este bloco não está mais ativo." } };

  const item = await findItemForBlockAndUser(db, itemId, blockId, userId);
  if (!item) return { ok: false, notFound: true };

  if (item.status === "skipped") return { ok: true, changed: false };
  if (item.status !== "pending" && item.status !== "in_progress") {
    return { ok: false, fieldErrors: { status: "Este item não pode ser pulado neste estado." } };
  }

  try {
    await db.batch([
      buildSkipItemStatement(db, { itemId: item.id, blockId, userId, guardVersion: item.version, mutationId }),
      buildItemEventInsertStatement(db, { id: mutationId, blockId, itemId: item.id, userId, eventType: "item_skipped" }),
    ]);
  } catch (error) {
    // PO v1.1 — mesma proteção de identidade de syncItem/startItem: colisão
    // na PK global de simulation_block_events (mutationId já consumido por
    // outra mutação real) é um 409 controlado, nunca uma exceção crua.
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message) && error.message.includes("simulation_block_events")) {
      return { ok: false, conflict: true };
    }
    const after = await findItemForBlockAndUser(db, itemId, blockId, userId);
    if (!after) return { ok: false, notFound: true };
    if (after.status === "skipped") return { ok: true, changed: false };
    if (after.version === item.version) throw error;
    return { ok: false, conflict: true };
  }

  return { ok: true, changed: true };
}

/* --------------------------------- Conclusão/abandono do bloco --------------------------------- */

export interface CompletionSummaryDto {
  completedCount: number;
  skippedCount: number;
  blockedCount: number;
  correctCount: number;
  incorrectCount: number;
  accuracyPercent: number | null;
  patternsPracticed: string[];
  approxMinutes: number;
  approxMinutesPerQuestion: number | null;
  helpsUsedCount: number;
}

async function buildSummary(db: D1Database, block: SimulationBlockRow): Promise<CompletionSummaryDto> {
  const rows = await listItemsForBlock(db, block.id);
  let completedCount = 0;
  let skippedCount = 0;
  let blockedCount = 0;
  let correctCount = 0;
  let incorrectCount = 0;
  let helpsUsedCount = 0;
  let approxMinutes = 0;
  const patternIds = new Set<string>();

  for (const row of rows) {
    if (row.status === "completed") {
      completedCount++;
      approxMinutes += row.estimated_minutes;
      if (row.primary_pattern_id) patternIds.add(row.primary_pattern_id);
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

  const confirmedCount = correctCount + incorrectCount;
  return {
    completedCount,
    skippedCount,
    blockedCount,
    correctCount,
    incorrectCount,
    // Seção 4/12 da ordem: "percentual bruto de acerto só pode aparecer
    // claramente rotulado como 'acerto neste bloco'" — nunca uma nota TRI,
    // projeção ou domínio definitivo. `null` quando nenhuma questão foi
    // confirmada (honesto, nunca 0% fabricado).
    accuracyPercent: confirmedCount > 0 ? Math.round((correctCount / confirmedCount) * 100) : null,
    patternsPracticed: patternNames.sort(),
    approxMinutes,
    approxMinutesPerQuestion: completedCount > 0 ? Math.round((approxMinutes / completedCount) * 10) / 10 : null,
    helpsUsedCount,
  };
}

export type CompleteBlockResult = MutationResult<{ summary: CompletionSummaryDto }>;

/** POST .../complete (seção 12 da ordem) — um bloco só pode ser concluído
 *  quando TODOS os itens estiverem em estado terminal. O próprio UPDATE
 *  guardado já exige isso (migrations/0017 / simulationsRepository.ts:
 *  buildCompleteBlockStatement) — "aborta antes do commit" por construção. */
export async function completeBlock(db: D1Database, userId: string, blockId: string, mutationId: string): Promise<CompleteBlockResult> {
  const block = await findBlockForUser(db, blockId, userId);
  if (!block) return { ok: false, notFound: true };

  if (block.status === "completed") {
    return { ok: true, changed: false, value: { summary: await buildSummary(db, block) } };
  }
  if (block.status !== "active") return { ok: false, fieldErrors: { status: "Este bloco não está mais ativo." } };

  const terminal = await allItemsTerminal(db, blockId);
  if (!terminal) return { ok: false, fieldErrors: { items: "Ainda há itens não concluídos, pulados ou bloqueados." } };

  if (block.last_mutation_id === mutationId) return { ok: false, conflict: true };

  // PO v1.1 — a checagem acima (`block.last_mutation_id === mutationId`)
  // só cobre reaproveitamento do mutationId de uma mutação anterior NESTE
  // MESMO bloco; `simulation_block_events.id` é PK GLOBAL da tabela, então
  // reaproveitar um mutationId consumido por um evento de ITEM (start/sync/
  // skip) ou de outro bloco deste aluno colide no INSERT abaixo — sem este
  // try/catch, essa exceção crua do D1 escapava direto para o chamador
  // (500 genérico) em vez do 409 controlado exigido.
  let result;
  try {
    result = await db.batch([
      buildCompleteBlockStatement(db, { blockId, userId, guardVersion: block.version, mutationId }),
      buildBlockEventInsertStatement(db, { id: mutationId, blockId, userId, eventType: "block_completed" }),
    ]);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message) && error.message.includes("simulation_block_events")) {
      return { ok: false, conflict: true };
    }
    const after = await findBlockForUser(db, blockId, userId);
    if (!after) return { ok: false, notFound: true };
    if (after.status === "completed") return { ok: true, changed: false, value: { summary: await buildSummary(db, after) } };
    if (after.version === block.version) throw error;
    return { ok: false, conflict: true };
  }

  if (result[0].meta.changes !== 1) {
    const after = await findBlockForUser(db, blockId, userId);
    if (!after) return { ok: false, notFound: true };
    if (after.status === "completed") return { ok: true, changed: false, value: { summary: await buildSummary(db, after) } };
    if (!(await allItemsTerminal(db, blockId))) return { ok: false, fieldErrors: { items: "Ainda há itens não concluídos, pulados ou bloqueados." } };
    return { ok: false, conflict: true };
  }

  const after = await findBlockForUser(db, blockId, userId);
  return { ok: true, changed: true, value: { summary: await buildSummary(db, after!) } };
}

export async function abandonBlock(db: D1Database, userId: string, blockId: string, mutationId: string): Promise<MutationResult<null>> {
  const block = await findBlockForUser(db, blockId, userId);
  if (!block) return { ok: false, notFound: true };

  if (block.status === "abandoned") return { ok: true, changed: false };
  if (block.status !== "active") return { ok: false, fieldErrors: { status: "Este bloco não está mais ativo." } };

  if (block.last_mutation_id === mutationId) return { ok: false, conflict: true };

  // PO v1.1 — mesma proteção de completeBlock: a checagem acima só cobre
  // reaproveitamento NESTE bloco; a PK global de simulation_block_events
  // cobre o resto (evento de item/outro bloco). Try/catch adicionado para
  // nunca deixar a exceção crua do D1 escapar como 500 genérico.
  let result;
  try {
    result = await db.batch([
      buildAbandonBlockStatement(db, { blockId, userId, guardVersion: block.version, mutationId }),
      buildBlockEventInsertStatement(db, { id: mutationId, blockId, userId, eventType: "block_abandoned" }),
    ]);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message) && error.message.includes("simulation_block_events")) {
      return { ok: false, conflict: true };
    }
    const after = await findBlockForUser(db, blockId, userId);
    if (!after) return { ok: false, notFound: true };
    if (after.status === "abandoned") return { ok: true, changed: false };
    if (after.version === block.version) throw error;
    return { ok: false, conflict: true };
  }

  if (result[0].meta.changes !== 1) {
    const after = await findBlockForUser(db, blockId, userId);
    if (!after) return { ok: false, notFound: true };
    if (after.status === "abandoned") return { ok: true, changed: false };
    return { ok: false, conflict: true };
  }

  return { ok: true, changed: true };
}

/* -------------------------------------- Histórico -------------------------------------- */

export interface HistoryEntryDto {
  id: string;
  blockType: SimulationBlockType;
  primaryPatternName: string | null;
  status: string;
  blockDate: string;
  completedCount: number;
  correctCount: number;
  incorrectCount: number;
  estimatedMinutes: number;
  completedAt: string | null;
  abandonedAt: string | null;
}

async function historyRowToDto(db: D1Database, row: HistoryBlockRow): Promise<HistoryEntryDto> {
  const pattern = row.primary_pattern_id ? await findPublishedPatternById(db, row.primary_pattern_id) : null;
  return {
    id: row.id,
    blockType: row.block_type,
    primaryPatternName: pattern?.name ?? null,
    status: row.status,
    blockDate: row.block_date,
    completedCount: row.completed_count,
    correctCount: row.correct_count,
    incorrectCount: row.incorrect_count,
    estimatedMinutes: row.estimated_minutes,
    completedAt: row.completed_at,
    abandonedAt: row.abandoned_at,
  };
}

const HISTORY_PAGE_LIMIT = 20;

/** GET /api/simulations/history — histórico REAL, paginado, somente leitura
 *  (seção 14 da ordem). Nunca agrega em nota/ranking/tendência definitiva. */
export async function getHistory(db: D1Database, userId: string, before: { createdAt: string; id: string } | null): Promise<{ entries: HistoryEntryDto[]; hasMore: boolean }> {
  const rows = await listBlockHistoryForUser(db, userId, HISTORY_PAGE_LIMIT + 1, before);
  const hasMore = rows.length > HISTORY_PAGE_LIMIT;
  const page = hasMore ? rows.slice(0, HISTORY_PAGE_LIMIT) : rows;
  const entries: HistoryEntryDto[] = [];
  for (const row of page) entries.push(await historyRowToDto(db, row));
  return { entries, hasMore };
}
