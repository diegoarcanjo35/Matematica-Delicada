/* Serviço do Caderno de Erros — Sprint 9 v1.0.

   Autorização: toda leitura/escrita passa `user_id` para o repositório, que
   já escopa no SQL (seção 10 da ordem) — uma entrada de outro aluno nunca é
   lida/alterada, e a rota trata "não encontrada" e "de outro aluno" de
   forma IDÊNTICA (404), nunca 403 (mesmo padrão do Player desde a Sprint
   8: não confirma a existência do recurso alheio).

   A atomicidade do REGISTRO AUTOMÁTICO e da CONCLUSÃO DE REVISÃO não vive
   aqui — vive em playerService.ts:confirmAnswer (a confirmação do Player é
   a fonte transacional real, seção 5.1/8.3/9 da ordem: "não criar endpoint
   de conclusão separado"). Este serviço cobre leitura, classificação/nota
   (PATCH), arquivamento e o INÍCIO da revisão (seção 8.1). */

import {
  countEntries,
  findEntryById,
  listEntries as repoListEntries,
  listReviewEventsForEntry,
  selectSimilarQuestion,
  summaryForUser,
  buildArchiveEntryStatement,
  buildPatchEntryStatement,
  type ErrorNotebookEntryRow,
  type ErrorReviewEventRow,
  type ListFilters,
} from "../repositories/errorNotebookRepository";
import { findQuestionById } from "../repositories/questionRepository";
import { findPublishedPatternById } from "../repositories/patternsRepository";
import { startOrResumeReviewAttempt } from "./playerService";
import { ERROR_TYPES, type ErrorType } from "../lib/errorNotebookValidation";
import type { Clock } from "../lib/spacedReview";
import { systemClock } from "./scheduleService";

function newId(): string {
  return crypto.randomUUID();
}

export interface MutationResult<T> {
  ok: boolean;
  value?: T;
  notFound?: boolean;
  conflict?: boolean;
  fieldErrors?: Record<string, string>;
  changed?: boolean;
}

/* ------------------------------------ DTOs ----------------------------------- */

export interface EntryPatternDto {
  id: string;
  name: string;
  slug: string;
}

export interface EntryListItemDto {
  id: string;
  originalQuestionId: string;
  originalQuestionCode: string;
  primaryPattern: EntryPatternDto | null;
  errorType: ErrorType;
  status: string;
  /** `status`, exceto quando `status === 'scheduled'` e a data já passou —
   *  nesse caso mostra `'due'`. NUNCA persistido — sempre calculado no
   *  momento da leitura, a partir do relógio injetado (nunca o do
   *  navegador). Ver docs/CADERNO_ERROS_REVISAO.md, "Por que 'due' nunca é
   *  gravado". */
  effectiveStatus: string;
  errorCount: number;
  reviewStage: number;
  nextReviewAt: string;
  firstErrorAt: string;
  lastErrorAt: string;
  version: number;
}

export interface EntryDetailDto extends EntryListItemDto {
  /** Só exposto no detalhe (não na lista) — usado pelo frontend para
   *  buscar a tentativa original completa via `GET /api/player/attempts/:id`
   *  (mesma rota do Player, reaproveitada — nenhum dado de questão é
   *  duplicado aqui). Sempre uma tentativa `completed` do próprio aluno, já
   *  que só é criada depois de uma confirmação real (seção 5.1). */
  originalAttemptId: string;
  studentNote: string | null;
  distinctReviewQuestionsSucceeded: number;
  correctedAt: string | null;
  lastReviewedAt: string | null;
  /** Verdadeiro quando a entrada já tem pelo menos uma revisão correta mas
   *  ainda não cumpre o critério de "outro contexto" (seção 6.1) —
   *  informação honesta para a tela, nunca uma correção fingida. */
  stillNeedsDifferentContext: boolean;
  reviewHistory: Array<{
    id: string;
    reviewedQuestionId: string;
    reviewedQuestionCode: string;
    result: "correct" | "incorrect";
    previousStage: number;
    resultingStage: number;
    usedDifferentQuestion: boolean;
    createdAt: string;
  }>;
}

function effectiveStatus(entry: ErrorNotebookEntryRow, nowIso: string): string {
  if (entry.status === "scheduled" && entry.next_review_at <= nowIso) return "due";
  return entry.status;
}

async function toListItemDto(db: D1Database, entry: ErrorNotebookEntryRow, question: { code: string }, nowIso: string): Promise<EntryListItemDto> {
  const pattern = entry.primary_pattern_id ? await findPublishedPatternById(db, entry.primary_pattern_id) : null;
  return {
    id: entry.id,
    originalQuestionId: entry.original_question_id,
    originalQuestionCode: question.code,
    primaryPattern: pattern ? { id: pattern.id, name: pattern.name, slug: pattern.slug } : null,
    errorType: entry.error_type as ErrorType,
    status: entry.status,
    effectiveStatus: effectiveStatus(entry, nowIso),
    errorCount: entry.error_count,
    reviewStage: entry.review_stage,
    nextReviewAt: entry.next_review_at,
    firstErrorAt: entry.first_error_at,
    lastErrorAt: entry.last_error_at,
    version: entry.version,
  };
}

export async function listEntries(
  db: D1Database,
  userId: string,
  filters: ListFilters,
  clock: Clock = systemClock
): Promise<{ entries: EntryListItemDto[]; total: number }> {
  const nowIso = clock.now().toISOString();
  const [rows, total] = await Promise.all([repoListEntries(db, userId, filters, nowIso), countEntries(db, userId, filters, nowIso)]);
  const entries: EntryListItemDto[] = [];
  for (const row of rows) {
    const question = await findQuestionById(db, row.original_question_id);
    entries.push(await toListItemDto(db, row, { code: question?.code ?? "?" }, nowIso));
  }
  return { entries, total };
}

export async function getSummary(db: D1Database, userId: string, clock: Clock = systemClock) {
  return summaryForUser(db, userId, clock.now().toISOString());
}

export async function getEntryDetail(db: D1Database, userId: string, entryId: string, clock: Clock = systemClock): Promise<EntryDetailDto | null> {
  const entry = await findEntryById(db, entryId, userId);
  if (!entry) return null;
  const question = await findQuestionById(db, entry.original_question_id);
  const nowIso = clock.now().toISOString();
  const base = await toListItemDto(db, entry, { code: question?.code ?? "?" }, nowIso);

  const events = await listReviewEventsForEntry(db, entryId);
  const reviewHistory: EntryDetailDto["reviewHistory"] = [];
  let hasSuccessOnDifferentQuestion = false;
  for (const event of events) {
    const reviewedQuestion = await findQuestionById(db, event.reviewed_question_id);
    if (event.result === "correct" && event.reviewed_question_id !== entry.original_question_id) hasSuccessOnDifferentQuestion = true;
    reviewHistory.push({
      id: event.id,
      reviewedQuestionId: event.reviewed_question_id,
      reviewedQuestionCode: reviewedQuestion?.code ?? "?",
      result: event.result,
      previousStage: event.previous_stage,
      resultingStage: event.resulting_stage,
      usedDifferentQuestion: event.used_different_question === 1,
      createdAt: event.created_at,
    });
  }

  const hasAnyCorrectReview = events.some((e: ErrorReviewEventRow) => e.result === "correct");

  return {
    ...base,
    originalAttemptId: entry.original_attempt_id,
    studentNote: entry.student_note,
    distinctReviewQuestionsSucceeded: entry.distinct_review_questions_succeeded,
    correctedAt: entry.corrected_at,
    lastReviewedAt: entry.last_reviewed_at,
    stillNeedsDifferentContext: entry.status !== "corrected" && entry.status !== "archived" && hasAnyCorrectReview && !hasSuccessOnDifferentQuestion,
    reviewHistory,
  };
}

/* --------------------------------- Classificação/nota (PATCH) --------------------------------- */

export async function patchEntry(
  db: D1Database,
  userId: string,
  entryId: string,
  input: { errorTypeProvided: boolean; errorType: unknown; studentNoteProvided: boolean; studentNote: unknown; expectedVersion: unknown; mutationId: unknown }
): Promise<MutationResult<{ entryId: string }>> {
  const entry = await findEntryById(db, entryId, userId);
  if (!entry) return { ok: false, notFound: true };

  if (!input.errorTypeProvided && !input.studentNoteProvided) {
    return { ok: false, fieldErrors: { body: "Corpo vazio — informe errorType e/ou studentNote." } };
  }
  if (input.errorTypeProvided && input.errorType === null) {
    return { ok: false, fieldErrors: { errorType: "errorType não pode ser removido, só trocado por outro tipo válido." } };
  }
  if (input.errorTypeProvided && (typeof input.errorType !== "string" || !ERROR_TYPES.includes(input.errorType as ErrorType))) {
    return { ok: false, fieldErrors: { errorType: "Tipo de erro inválido." } };
  }
  if (input.studentNoteProvided && input.studentNote !== null && typeof input.studentNote !== "string") {
    return { ok: false, fieldErrors: { studentNote: "Anotação inválida." } };
  }
  if (typeof input.expectedVersion !== "number") return { ok: false, fieldErrors: { expectedVersion: "expectedVersion é obrigatória." } };
  if (typeof input.mutationId !== "string" || input.mutationId.trim().length === 0) {
    return { ok: false, fieldErrors: { mutationId: "mutationId é obrigatório." } };
  }

  const nextErrorType = input.errorTypeProvided ? (input.errorType as ErrorType) : entry.error_type;
  // `undefined` = campo não veio no corpo (não mexe); `null`/string = valor
  // resultante pedido. Comparado sempre contra o texto ATUAL, nunca contra
  // o `mutationId` (a nota NUNCA é usada como chave de idempotência —
  // seção 10 da ordem).
  const nextStudentNote = input.studentNoteProvided ? (input.studentNote as string | null) : entry.student_note;

  const isRetryOfSameMutation = entry.last_mutation_id === input.mutationId;
  const resultAlreadyMatches = nextErrorType === entry.error_type && nextStudentNote === entry.student_note;

  if (isRetryOfSameMutation) {
    // Retry do MESMO mutationId (seção 9.2): idempotente se o estado atual
    // já reflete exatamente o que esta chamada pediria de novo — nunca
    // reaplica, nunca duplica escrita.
    if (resultAlreadyMatches) return { ok: true, changed: false, value: { entryId } };
    // Mesmo mutationId, conteúdo DIFERENTE do que já foi aplicado — reuso
    // indevido de uma chave de idempotência para uma mudança diferente.
    return { ok: false, conflict: true };
  }

  const noopEvenThoughNewMutation = nextErrorType === entry.error_type && nextStudentNote === entry.student_note;
  if (noopEvenThoughNewMutation) {
    // Mesmo conteúdo, mutationId novo — sucesso sem tocar o banco (seção
    // 9.2: "no-op: changed:false, zero escrita").
    return { ok: true, changed: false, value: { entryId } };
  }

  if (entry.version !== input.expectedVersion) return { ok: false, conflict: true };

  await db.batch([
    buildPatchEntryStatement(db, {
      entryId,
      userId,
      guardVersion: entry.version,
      mutationId: input.mutationId,
      errorType: input.errorTypeProvided ? (input.errorType as string) : undefined,
      studentNoteProvided: input.studentNoteProvided,
      studentNote: nextStudentNote,
      nowIso: new Date().toISOString(),
    }),
  ]);

  return { ok: true, changed: true, value: { entryId } };
}

/* ---------------------------------------- Arquivar ---------------------------------------- */

export async function archiveEntry(
  db: D1Database,
  userId: string,
  entryId: string,
  expectedVersion: number,
  mutationId: string
): Promise<MutationResult<null>> {
  const entry = await findEntryById(db, entryId, userId);
  if (!entry) return { ok: false, notFound: true };
  if (entry.status === "archived") {
    if (entry.last_mutation_id === mutationId || entry.version === expectedVersion + 0) {
      // Já arquivada — idempotente (seção 9.3), independentemente de qual
      // chamada arquivou primeiro.
      return { ok: true, changed: false };
    }
  }
  if (entry.version !== expectedVersion) return { ok: false, conflict: true };
  const result = await db.batch([buildArchiveEntryStatement(db, { entryId, userId, guardVersion: expectedVersion, mutationId, nowIso: new Date().toISOString() })]);
  if (result[0].meta.changes !== 1) return { ok: false, conflict: true };
  return { ok: true, changed: true };
}

/* ------------------------------------- Iniciar revisão ------------------------------------- */

export interface StartReviewResult {
  ok: boolean;
  notFound?: boolean;
  fieldErrors?: Record<string, string>;
  attemptId?: string;
  reviewedQuestionId?: string;
  selectionReason?: string;
}

/** "Corrigir meu erro" (seção 8.1) — seleciona a questão semelhante
 *  (seção 7, `selectSimilarQuestion`, determinística e explicável — o
 *  `selectionReason` devolvido documenta exatamente por que aquela
 *  questão foi escolhida) e cria/retoma a tentativa de revisão
 *  (`startOrResumeReviewAttempt`, playerService.ts — atômico com marcar
 *  a entrada `in_review`, ver comentário lá). Entrada arquivada não pode
 *  iniciar revisão (arquivar é uma decisão do aluno de "não quero mais
 *  ver isto agora" — reabrir exige desarquivar primeiro, fora do escopo
 *  desta sprint). */
export async function startReview(db: D1Database, userId: string, entryId: string): Promise<StartReviewResult> {
  const entry = await findEntryById(db, entryId, userId);
  if (!entry) return { ok: false, notFound: true };
  if (entry.status === "archived") {
    return { ok: false, fieldErrors: { status: "Entrada arquivada — desarquive antes de iniciar uma revisão." } };
  }

  // Seção 7, item 4: excluir questões já usadas com SUCESSO nesta
  // entrada, quando possível — senão o critério de "outro contexto"
  // (seção 6.1) nunca teria como avançar (a mesma questão semelhante
  // sendo reaproveitada indefinidamente nunca soma uma segunda questão
  // DISTINTA bem-sucedida).
  const priorEvents = await listReviewEventsForEntry(db, entryId);
  const alreadySucceededQuestionIds = priorEvents.filter((e) => e.result === "correct").map((e) => e.reviewed_question_id);
  const selection = await selectSimilarQuestion(db, {
    originalQuestionId: entry.original_question_id,
    primaryPatternId: entry.primary_pattern_id,
    excludeQuestionIds: alreadySucceededQuestionIds,
  });
  const question = await findQuestionById(db, selection.questionId);
  if (!question) return { ok: false, fieldErrors: { question: "Não foi possível selecionar uma questão para a revisão." } };

  const result = await startOrResumeReviewAttempt(db, userId, entryId, entry.version, question.id, question.version);
  if (!result.ok) {
    if (result.notFound) return { ok: false, notFound: true };
    return { ok: false, fieldErrors: result.fieldErrors };
  }
  return { ok: true, attemptId: result.value!.attemptId, reviewedQuestionId: question.id, selectionReason: selection.reason };
}

export { newId };
