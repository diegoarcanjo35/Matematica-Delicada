/* Serviço do Player de Questão — Sprint 8 v1.2.

   Atomicidade (corrigida na v1.2, auditoria do PO): cada mutação que
   precisa de "estado muda + evento" roda num único `db.batch()` com o
   UPDATE central de `question_attempts` PRIMEIRO e o INSERT do evento
   obrigatório (INCONDICIONAL — nunca mais um `WHERE EXISTS`) por ÚLTIMO. O
   `id` do evento É o `mutationId` (mesmo id gravado em
   `question_attempts.last_mutation_id` pelo UPDATE pareado) — um trigger
   `AFTER INSERT` (migrations/0013, editada in place) verifica essa
   identidade DENTRO da mesma transação e reverte TUDO (`RAISE(ABORT)`) se
   não bater. Isto prova, ANTES do commit, que "o núcleo mudou" e "o evento
   obrigatório existe" são sempre a MESMA coisa — nunca dois fatos
   independentes que só JS reconcilia depois. A v1.1 original só checava
   `coreResult.meta.changes` DEPOIS de `db.batch()` já ter retornado — o que
   DETECTA uma divergência já commitada, mas não a PREVINE; corrigido para
   a mesma classe de mecanismo comprovada nas migrations 0009-0012 do Banco
   de Questões (ver comentário extenso em migrations/0013 e
   playerRepository.ts). Agora `db.batch()` pode LANÇAR em vez de só
   devolver `meta.changes` divergente — todo `catch` abaixo interpreta essa
   exceção exatamente como a v1.1 interpretava `meta.changes !== 1`: relê o
   estado atual e decide entre sucesso idempotente (corrida legítima, o
   resultado já reflete o que esta chamada pedia) e conflito real (409).

   Idempotência: toda mutação de conteúdo compara o valor ATUAL com o
   ENVIADO antes de montar qualquer statement — valores idênticos retornam
   sucesso sem tocar o banco (`changed:false`), nunca gravam evento nem
   avançam `version`, nunca chegam a chamar `db.batch()`. Concorrência real
   (duas chamadas simultâneas com o MESMO `expectedVersion`) faz o guard do
   UPDATE central de UMA delas afetar 0 linhas — o que agora, por
   construção, SEMPRE faz o INSERT de evento pareado disparar o trigger de
   identidade e abortar a transação inteira dessa chamada (nunca uma
   escrita parcial); a chamada perdedora relê o estado atual e devolve 409
   (versão desatualizada) OU, se o estado já reflete exatamente o que ela
   pedia (mesmo resultado, versão já avançada por ela mesma/uma corrida
   simultânea), trata como sucesso idempotente — nunca duplica evento. */

import {
  buildAbandonAttemptStatement,
  buildAnswerEventInsertStatement,
  buildAnswerUpdateStatement,
  buildBookmarkDeleteStatement,
  buildBookmarkInsertStatement,
  buildConfirmEventInsertStatement,
  buildConfirmUpdateStatement,
  buildCreateAttemptStatement,
  buildHelpAdvanceStatement,
  buildHelpEventInsertStatement,
  buildProblemReportInsertStatement,
  buildRecognitionEventInsertStatement,
  buildRecognitionUpdateStatement,
  findActiveAttempt,
  findAttemptByIdForUser,
  findBookmark,
  listAnswerEvents,
  listHelpEvents,
  listRecognitionEvents,
  type QuestionAttemptRow,
} from "../repositories/playerRepository";
import { findDna, findQuestionById, listAlternatives, listImages, listPatternsForQuestion } from "../repositories/questionRepository";
import { findPublishedPatternById, findPublishedPatternBySlug } from "../repositories/patternsRepository";
import {
  isValidAlternativeLetter,
  validateRecognitionClue,
  validateRecognitionStrategy,
  type QuestionAttemptMode,
} from "../lib/playerValidation";

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
  /** Só usado por `saveAnswer` — distingue `selected` (primeira escolha) de
   *  `changed` (troca) para a rota decidir qual `AuditEventType` gravar
   *  (seção 15 da ordem: `question_answer_selected` vs `question_answer_changed`). */
  eventType?: "selected" | "changed";
}

const PUBLISHED = "published";

/* ------------------------------- Leitura DTO -------------------------------- */

export interface AttemptQuestionDto {
  id: string;
  code: string;
  enunciado: string;
  dificuldade: string;
  tipoCalculo: string;
  necessitaCalculadora: boolean;
  alternativas: Array<{ letter: string; text: string }>;
  imagens: Array<{ id: string; assetRef: string; altText: string; caption: string | null; position: number }>;
  principalPatternId: string | null;
}

export interface AttemptStateDto {
  id: string;
  questionId: string;
  mode: QuestionAttemptMode;
  status: string;
  selectedAlternative: string | null;
  recognitionSaved: boolean;
  recognitionPatternId: string | null;
  recognitionClue: string | null;
  recognitionStrategy: string | null;
  highestHelpLayer: number;
  openedLayers: number[];
  startedAt: string;
  answeredAt: string | null;
  completedAt: string | null;
  lastActivityAt: string;
  version: number;
  question: AttemptQuestionDto;
  helpContent: Record<number, string>;
  feedback: AttemptFeedbackDto | null;
  /** Sprint 8 v1.2 — correção B (PO): o bookmark é POR QUESTÃO (não por
   *  tentativa), mas este é o único GET que recarrega no refresh/remontagem
   *  da tela — reaproveitado em vez de um 10º endpoint dedicado. Escopado
   *  por `user_id` (`findBookmark`, mesmo padrão de todo o resto do
   *  módulo) — o bookmark de um aluno nunca aparece para outro. */
  isBookmarked: boolean;
}

export interface AttemptFeedbackDto {
  selectedAlternative: string;
  correctAlternative: string;
  isCorrect: boolean;
  correctExplanation: string | null;
  distractorExplanations: Array<{ letter: string; explanation: string }>;
  principalPattern: { id: string; name: string; slug: string } | null;
  dna: {
    pista: string;
    estrategia: string;
    pegadinha: string;
    conteudoApoio: string;
    resolucao: string;
    atalho: string | null;
    aprendizadoErro: string;
  } | null;
}

async function buildQuestionDto(db: D1Database, questionId: string): Promise<AttemptQuestionDto | null> {
  const question = await findQuestionById(db, questionId);
  if (!question) return null;
  const [alternatives, images, patterns] = await Promise.all([
    listAlternatives(db, questionId),
    listImages(db, questionId),
    listPatternsForQuestion(db, questionId),
  ]);
  const principal = patterns.find((p) => p.role === "principal") ?? null;
  return {
    id: question.id,
    code: question.code,
    enunciado: question.enunciado,
    dificuldade: question.dificuldade,
    tipoCalculo: question.tipo_calculo,
    necessitaCalculadora: question.necessita_calculadora === 1,
    // Nunca inclui `is_correct` nem `distractor_explanation` aqui — só
    // depois da confirmação, via `AttemptFeedbackDto` (seção 3/9 da ordem).
    alternativas: alternatives.map((a) => ({ letter: a.letter, text: a.text })),
    imagens: images.map((i) => ({ id: i.id, assetRef: i.asset_ref, altText: i.alt_text, caption: i.caption, position: i.position })),
    principalPatternId: principal?.pattern_id ?? null,
  };
}

async function buildHelpContent(
  db: D1Database,
  questionId: string,
  openedLayers: number[]
): Promise<Record<number, string>> {
  if (openedLayers.length === 0) return {};
  const content: Record<number, string> = {};
  const dna = await findDna(db, questionId);
  if (openedLayers.includes(1) && dna) content[1] = dna.pista;
  if (openedLayers.includes(2)) {
    const patterns = await listPatternsForQuestion(db, questionId);
    const principal = patterns.find((p) => p.role === "principal");
    if (principal) {
      const pattern = await findPublishedPatternById(db, principal.pattern_id);
      if (pattern) content[2] = pattern.recognition_phrase;
    }
  }
  if (openedLayers.includes(3) && dna) content[3] = dna.estrategia;
  if (openedLayers.includes(4)) {
    const question = await findQuestionById(db, questionId);
    if (question) content[4] = question.resolucao_comentada;
  }
  return content;
}

async function buildFeedbackDto(db: D1Database, attempt: QuestionAttemptRow): Promise<AttemptFeedbackDto | null> {
  if (attempt.status !== "completed" || !attempt.selected_alternative) return null;
  const [alternatives, dna, patterns] = await Promise.all([
    listAlternatives(db, attempt.question_id),
    findDna(db, attempt.question_id),
    listPatternsForQuestion(db, attempt.question_id),
  ]);
  const correct = alternatives.find((a) => a.is_correct === 1);
  const principalLink = patterns.find((p) => p.role === "principal") ?? null;
  const principalPattern = principalLink ? await findPublishedPatternById(db, principalLink.pattern_id) : null;
  return {
    selectedAlternative: attempt.selected_alternative,
    correctAlternative: correct?.letter ?? "",
    isCorrect: attempt.is_correct === 1,
    correctExplanation: correct?.distractor_explanation ?? null,
    distractorExplanations: alternatives
      .filter((a) => a.is_correct !== 1 && a.distractor_explanation)
      .map((a) => ({ letter: a.letter, explanation: a.distractor_explanation as string })),
    principalPattern: principalPattern ? { id: principalPattern.id, name: principalPattern.name, slug: principalPattern.slug } : null,
    dna: dna
      ? {
          pista: dna.pista,
          estrategia: dna.estrategia,
          pegadinha: dna.pegadinha,
          conteudoApoio: dna.conteudo_apoio,
          resolucao: dna.resolucao,
          atalho: dna.atalho,
          aprendizadoErro: dna.aprendizado_erro,
        }
      : null,
  };
}

export async function toAttemptStateDto(db: D1Database, attempt: QuestionAttemptRow): Promise<AttemptStateDto | null> {
  const question = await buildQuestionDto(db, attempt.question_id);
  if (!question) return null;
  const helpEvents = await listHelpEvents(db, attempt.id);
  const openedLayers = helpEvents.map((e) => e.layer).sort((a, b) => a - b);
  const helpContent = await buildHelpContent(db, attempt.question_id, openedLayers);
  const feedback = await buildFeedbackDto(db, attempt);
  const bookmark = await findBookmark(db, attempt.user_id, attempt.question_id);
  return {
    id: attempt.id,
    questionId: attempt.question_id,
    mode: attempt.mode,
    status: attempt.status,
    selectedAlternative: attempt.selected_alternative,
    recognitionSaved: attempt.recognition_pattern_id !== null,
    recognitionPatternId: attempt.recognition_pattern_id,
    recognitionClue: attempt.recognition_clue,
    recognitionStrategy: attempt.recognition_strategy,
    highestHelpLayer: attempt.highest_help_layer,
    openedLayers,
    startedAt: attempt.started_at,
    answeredAt: attempt.answered_at,
    completedAt: attempt.completed_at,
    lastActivityAt: attempt.last_activity_at,
    version: attempt.version,
    question,
    helpContent,
    feedback,
    isBookmarked: bookmark !== null,
  };
}

/* -------------------------------- Início/retomada ------------------------------- */

function isUniqueActiveAttemptViolation(error: unknown): boolean {
  // SQLite/D1 reportam violação de UNIQUE constraint na mensagem do erro —
  // mesmo padrão já usado por diagnosticService.ts:isUniqueActiveAttemptViolation
  // desde a Sprint 4. Checar o nome da tabela evita capturar por engano a
  // violação de outro índice único.
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message) && error.message.includes("question_attempts");
}

export async function startOrResumeAttempt(
  db: D1Database,
  userId: string,
  questionId: string,
  mode: string
): Promise<MutationResult<{ attemptId: string }>> {
  if (!["learning", "practice", "recognition"].includes(mode)) {
    return { ok: false, fieldErrors: { mode: "Modo inválido." } };
  }

  const question = await findQuestionById(db, questionId);
  if (!question || question.editorial_status !== PUBLISHED) return { ok: false, notFound: true };

  const active = await findActiveAttempt(db, userId, questionId, mode);
  if (active) return { ok: true, changed: false, value: { attemptId: active.id } };

  const id = newId();
  try {
    await db.batch([buildCreateAttemptStatement(db, { id, userId, questionId, questionVersion: question.version, mode })]);
  } catch (error) {
    if (isUniqueActiveAttemptViolation(error)) {
      // Corrida real: outra requisição venceu entre a leitura acima e este
      // INSERT — a garantia de banco (índice único parcial,
      // migrations/0013) é quem decide, nunca uma checagem em JS que
      // poderia perder a corrida. Relê e devolve a que venceu.
      const stillActive = await findActiveAttempt(db, userId, questionId, mode);
      if (stillActive) return { ok: true, changed: false, value: { attemptId: stillActive.id } };
    }
    throw error;
  }

  return { ok: true, changed: true, value: { attemptId: id } };
}

export async function getAttempt(db: D1Database, userId: string, attemptId: string): Promise<QuestionAttemptRow | null> {
  return findAttemptByIdForUser(db, attemptId, userId);
}

/* --------------------------------- Reconhecimento -------------------------------- */

function recognitionUnchanged(attempt: QuestionAttemptRow, patternId: string, clue: string, strategy: string): boolean {
  return attempt.recognition_pattern_id === patternId && (attempt.recognition_clue ?? "") === clue && (attempt.recognition_strategy ?? "") === strategy;
}

export async function saveRecognition(
  db: D1Database,
  userId: string,
  attemptId: string,
  expectedVersion: number,
  input: { patternSlug: unknown; clue: unknown; strategy: unknown }
): Promise<MutationResult<{ attemptId: string }>> {
  const attempt = await findAttemptByIdForUser(db, attemptId, userId);
  if (!attempt) return { ok: false, notFound: true };
  if (attempt.status !== "in_progress") return { ok: false, fieldErrors: { status: "Tentativa não está mais em andamento." } };

  // Recebido por SLUG, nunca por id interno — mesma convenção do resto da
  // API voltada ao aluno (o catálogo de padrões, Sprint 6, nunca expõe o id
  // do padrão ao cliente; `patternsService.ts:toSummaryDto` documenta isso
  // explicitamente). O id real só é resolvido aqui, no servidor.
  if (typeof input.patternSlug !== "string" || input.patternSlug.trim().length === 0) {
    return { ok: false, fieldErrors: { patternSlug: "Padrão obrigatório." } };
  }
  const pattern = await findPublishedPatternBySlug(db, input.patternSlug);
  if (!pattern) return { ok: false, fieldErrors: { patternSlug: "Padrão inválido ou não publicado." } };

  const clueResult = validateRecognitionClue(input.clue);
  if (!clueResult.ok) return { ok: false, fieldErrors: { clue: clueResult.error! } };
  const strategyResult = validateRecognitionStrategy(input.strategy);
  if (!strategyResult.ok) return { ok: false, fieldErrors: { strategy: strategyResult.error! } };

  const clue = clueResult.value!;
  const strategy = strategyResult.value!;

  if (recognitionUnchanged(attempt, pattern.id, clue, strategy)) {
    // Repetição idêntica é idempotente (seção 6): sucesso sem tocar o
    // banco, sem novo evento, sem avançar `version`.
    return { ok: true, changed: false, value: { attemptId } };
  }

  if (attempt.version !== expectedVersion) return { ok: false, conflict: true };

  const mutationId = newId();
  try {
    await db.batch([
      buildRecognitionUpdateStatement(db, { attemptId, userId, guardVersion: expectedVersion, mutationId, patternId: pattern.id, clue, strategy }),
      buildRecognitionEventInsertStatement(db, { id: mutationId, attemptId, attemptVersion: expectedVersion + 1, patternId: pattern.id, clue, strategy }),
    ]);
  } catch (error) {
    // Núcleo e evento sempre viajam juntos (trigger de identidade,
    // migrations/0013) — este catch cobre tanto conflito de versão real
    // (caso normal) quanto uma corrida legítima. Nunca há evento órfão nem
    // núcleo mudado sem evento persistidos: o `RAISE(ABORT)` já reverteu a
    // transação inteira antes deste ponto.
    const after = await findAttemptByIdForUser(db, attemptId, userId);
    if (!after) return { ok: false, notFound: true };
    if (recognitionUnchanged(after, pattern.id, clue, strategy)) return { ok: true, changed: false, value: { attemptId } };
    if (after.version === expectedVersion) {
      // Ninguém mais mexeu na linha (a versão continua exatamente a que
      // esta chamada esperava) — não é uma corrida legítima, é uma falha
      // genuína (ex.: erro de SQL forçado/real ao gravar o evento). Nunca
      // disfarçar isso de "conflito de versão" — relança para virar 500,
      // nunca um 409 enganoso que sugeriria "recarregue e tente de novo".
      throw error;
    }
    return { ok: false, conflict: true };
  }

  return { ok: true, changed: true, value: { attemptId } };
}

/* ------------------------------------ Resposta ----------------------------------- */

export async function saveAnswer(
  db: D1Database,
  userId: string,
  attemptId: string,
  expectedVersion: number,
  alternative: unknown
): Promise<MutationResult<{ attemptId: string }>> {
  const attempt = await findAttemptByIdForUser(db, attemptId, userId);
  if (!attempt) return { ok: false, notFound: true };
  if (attempt.status !== "in_progress") return { ok: false, fieldErrors: { status: "Tentativa não está mais em andamento." } };
  if (!isValidAlternativeLetter(alternative)) return { ok: false, fieldErrors: { alternativa: "Selecione uma alternativa de A a E." } };

  if (attempt.selected_alternative === alternative) {
    return { ok: true, changed: false, value: { attemptId } };
  }

  if (attempt.version !== expectedVersion) return { ok: false, conflict: true };

  const eventType: "selected" | "changed" = attempt.selected_alternative === null ? "selected" : "changed";
  const mutationId = newId();
  try {
    await db.batch([
      buildAnswerUpdateStatement(db, { attemptId, userId, guardVersion: expectedVersion, mutationId, alternative }),
      buildAnswerEventInsertStatement(db, {
        id: mutationId,
        attemptId,
        previousAlternative: attempt.selected_alternative,
        newAlternative: alternative,
        eventType,
      }),
    ]);
  } catch (error) {
    const after = await findAttemptByIdForUser(db, attemptId, userId);
    if (!after) return { ok: false, notFound: true };
    if (after.selected_alternative === alternative) return { ok: true, changed: false, value: { attemptId } };
    if (after.version === expectedVersion) throw error; // falha genuína, não conflito — ver saveRecognition acima.
    return { ok: false, conflict: true };
  }

  return { ok: true, changed: true, value: { attemptId }, eventType };
}

export async function confirmAnswer(
  db: D1Database,
  userId: string,
  attemptId: string,
  expectedVersion: number
): Promise<MutationResult<{ attemptId: string }>> {
  const attempt = await findAttemptByIdForUser(db, attemptId, userId);
  if (!attempt) return { ok: false, notFound: true };

  if (attempt.status === "completed") {
    // Já confirmada — idempotente SE a versão informada é exatamente a que
    // já reflete esta confirmação (evita um "sucesso" para uma versão bem
    // antiga que só coincidentemente chegou aqui depois de outras mutações).
    if (attempt.version === expectedVersion + 1) return { ok: true, changed: false, value: { attemptId } };
    return { ok: false, conflict: true };
  }
  if (attempt.status !== "in_progress") return { ok: false, fieldErrors: { status: "Tentativa não pode ser confirmada neste estado." } };
  if (!attempt.selected_alternative) return { ok: false, fieldErrors: { alternativa: "Selecione uma alternativa antes de confirmar." } };
  if (attempt.mode === "recognition" && !attempt.recognition_pattern_id) {
    return { ok: false, fieldErrors: { reconhecimento: "Salve a etapa de reconhecimento antes de confirmar." } };
  }
  if (attempt.version !== expectedVersion) return { ok: false, conflict: true };

  const alternatives = await listAlternatives(db, attempt.question_id);
  const correct = alternatives.find((a) => a.is_correct === 1);
  // `is_correct` é SEMPRE computado aqui, no Worker, a partir do gabarito
  // editorial (`question_alternatives.is_correct`) — o cliente nunca envia
  // (nem seria lido) um `isCorrect` no corpo da requisição.
  const isCorrect: 0 | 1 = correct && correct.letter === attempt.selected_alternative ? 1 : 0;

  const mutationId = newId();
  try {
    await db.batch([
      buildConfirmUpdateStatement(db, { attemptId, userId, guardVersion: expectedVersion, mutationId, isCorrect }),
      buildConfirmEventInsertStatement(db, { id: mutationId, attemptId, alternative: attempt.selected_alternative }),
    ]);
  } catch (error) {
    // Corrida: outra requisição simultânea (mesma expectedVersion) venceu —
    // exatamente UMA confirmação real acontece (o trigger de identidade
    // garante que a perdedora nunca deixa nem núcleo nem evento
    // parcialmente escritos); esta relê e trata como sucesso idempotente se
    // o resultado já reflete o que ela pediria.
    const after = await findAttemptByIdForUser(db, attemptId, userId);
    if (after && after.status === "completed" && after.version === expectedVersion + 1) {
      return { ok: true, changed: false, value: { attemptId } };
    }
    if (after && after.version === expectedVersion) throw error; // falha genuína, não conflito — ver saveRecognition acima.
    return { ok: false, conflict: true };
  }

  return { ok: true, changed: true, value: { attemptId } };
}

/* -------------------------------------- Ajuda ------------------------------------- */

export async function openHelpLayer(
  db: D1Database,
  userId: string,
  attemptId: string,
  expectedVersion: number,
  layer: number,
  confirmViewResolution: boolean
): Promise<MutationResult<{ attemptId: string }>> {
  const attempt = await findAttemptByIdForUser(db, attemptId, userId);
  if (!attempt) return { ok: false, notFound: true };
  if (attempt.status === "abandoned") return { ok: false, fieldErrors: { status: "Tentativa não está mais ativa." } };

  if (layer <= attempt.highest_help_layer) {
    // Camada já aberta — idempotente, nunca duplica evento nem versão.
    return { ok: true, changed: false, value: { attemptId } };
  }
  if (layer !== attempt.highest_help_layer + 1) {
    return { ok: false, fieldErrors: { layer: "Não é possível pular uma camada de ajuda — abra em ordem." } };
  }
  if (layer === 4 && !confirmViewResolution) {
    return { ok: false, fieldErrors: { confirmViewResolution: "Confirme explicitamente que deseja ver a resolução comentada." } };
  }
  if (attempt.version !== expectedVersion) return { ok: false, conflict: true };

  const mutationId = newId();
  try {
    await db.batch([
      buildHelpAdvanceStatement(db, { attemptId, userId, guardVersion: expectedVersion, mutationId, layer }),
      buildHelpEventInsertStatement(db, { id: mutationId, attemptId, layer }),
    ]);
  } catch (error) {
    const after = await findAttemptByIdForUser(db, attemptId, userId);
    if (!after) return { ok: false, notFound: true };
    if (layer <= after.highest_help_layer) return { ok: true, changed: false, value: { attemptId } };
    if (after.version === expectedVersion) throw error; // falha genuína, não conflito — ver saveRecognition acima.
    return { ok: false, conflict: true };
  }

  return { ok: true, changed: true, value: { attemptId } };
}

/* -------------------------------- Revisão e denúncia ------------------------------- */

export async function setBookmark(db: D1Database, userId: string, questionId: string, save: boolean): Promise<MutationResult<null>> {
  const question = await findQuestionById(db, questionId);
  if (!question || question.editorial_status !== PUBLISHED) return { ok: false, notFound: true };

  const existing = await findBookmark(db, userId, questionId);
  if (save) {
    if (existing) return { ok: true, changed: false };
    await db.batch([buildBookmarkInsertStatement(db, { id: newId(), userId, questionId })]);
    return { ok: true, changed: true };
  }
  if (!existing) return { ok: true, changed: false };
  await db.batch([buildBookmarkDeleteStatement(db, { userId, questionId })]);
  return { ok: true, changed: true };
}

export async function reportProblem(
  db: D1Database,
  userId: string,
  questionId: string,
  attemptId: string | null,
  category: string,
  comment: string | null
): Promise<MutationResult<{ reportId: string }>> {
  const question = await findQuestionById(db, questionId);
  if (!question || question.editorial_status !== PUBLISHED) return { ok: false, notFound: true };

  if (attemptId) {
    const attempt = await findAttemptByIdForUser(db, attemptId, userId);
    if (!attempt || attempt.question_id !== questionId) return { ok: false, notFound: true };
  }

  const id = newId();
  await db.batch([buildProblemReportInsertStatement(db, { id, userId, questionId, attemptId, category, comment })]);
  return { ok: true, changed: true, value: { reportId: id } };
}

export async function abandonAttempt(db: D1Database, userId: string, attemptId: string, expectedVersion: number): Promise<MutationResult<null>> {
  const attempt = await findAttemptByIdForUser(db, attemptId, userId);
  if (!attempt) return { ok: false, notFound: true };
  if (attempt.status !== "in_progress") return { ok: true, changed: false };
  if (attempt.version !== expectedVersion) return { ok: false, conflict: true };
  const results = await db.batch([buildAbandonAttemptStatement(db, { attemptId, userId, guardVersion: expectedVersion })]);
  if (results[0].meta.changes !== 1) return { ok: false, conflict: true };
  return { ok: true, changed: true };
}

export { listAnswerEvents, listRecognitionEvents };
