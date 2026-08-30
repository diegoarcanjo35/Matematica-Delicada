import {
  buildAbandonAttemptStatement,
  buildCompleteAttemptStatement,
  buildCreateAttemptStatement,
  buildInsertAttemptQuestionStatement,
  buildInsertHelpOpenStatement,
  buildUpsertResponseStatement,
  findActiveAttemptForUser,
  findAttempt,
  findHelpLayerContent,
  findLatestCompletedAttemptForUser,
  findQuestion,
  listAttemptQuestionIds,
  listHelpLayersForQuestions,
  listHelpOpens,
  listOptionsForQuestions,
  listQuestionsOrdered,
  listRecognitionOptionsForQuestions,
  listResponses,
  type DiagnosticOptionRow,
} from "../repositories/diagnosticRepository";
import { validateIsDontKnow, validateLayer, validateNonEmptyId, validateTimeSpentMs } from "../lib/diagnosticValidation";

/* Serviço do diagnóstico inicial — Sprint 4 v1.0. Orquestra validação,
   atomicidade (db.batch()) e as regras de negócio da seção 5/8/9 da ordem.
   user_id é SEMPRE recebido de quem chama (routes/diagnostic.ts), que por
   sua vez deriva exclusivamente da sessão — nunca do corpo/query. */

function newId(): string {
  return crypto.randomUUID();
}

export interface DiagnosticStatusView {
  available: boolean;
  activeAttemptId: string | null;
  latestCompletedAttemptId: string | null;
}

export async function getStatus(
  db: D1Database,
  userId: string,
  fixturesAllowed: boolean
): Promise<DiagnosticStatusView> {
  if (!fixturesAllowed) {
    return { available: false, activeAttemptId: null, latestCompletedAttemptId: null };
  }
  const [active, latestCompleted] = await Promise.all([
    findActiveAttemptForUser(db, userId),
    findLatestCompletedAttemptForUser(db, userId),
  ]);
  return {
    available: true,
    activeAttemptId: active?.id ?? null,
    latestCompletedAttemptId: latestCompleted?.id ?? null,
  };
}

export interface CreateAttemptResult {
  ok: boolean;
  reason?: "unavailable" | "active_exists" | "no_questions";
  attemptId?: string;
}

/** Cria uma nova tentativa com o catálogo atual de questões (ordem
 *  determinística). Se já existir uma tentativa em andamento, só cria uma
 *  nova mediante `restart: true` explícito — e a anterior é marcada
 *  `abandoned`, nunca apagada (seção 5.1 da ordem: reinício exige
 *  confirmação e preserva o histórico). */
export async function createAttempt(
  db: D1Database,
  userId: string,
  fixturesAllowed: boolean,
  restart: boolean
): Promise<CreateAttemptResult> {
  if (!fixturesAllowed) return { ok: false, reason: "unavailable" };

  const active = await findActiveAttemptForUser(db, userId);
  if (active && !restart) {
    return { ok: false, reason: "active_exists", attemptId: active.id };
  }

  const questions = await listQuestionsOrdered(db);
  if (questions.length === 0) return { ok: false, reason: "no_questions" };

  const newAttemptId = newId();
  const statements = [];
  if (active && restart) {
    statements.push(buildAbandonAttemptStatement(db, active.id));
  }
  statements.push(buildCreateAttemptStatement(db, newAttemptId, userId));
  questions.forEach((question, index) => {
    statements.push(buildInsertAttemptQuestionStatement(db, newAttemptId, question.id, index));
  });

  await db.batch(statements);
  return { ok: true, attemptId: newAttemptId };
}

export interface AttemptQuestionView {
  id: string;
  position: number;
  prompt: string;
  options: Array<{ id: string; text: string }>;
  hasRecognition: boolean;
  recognitionOptions: Array<{ id: string; text: string }>;
  helpLayersAvailable: number[];
  helpLayersOpened: number[];
  answered: boolean;
  isDontKnow: boolean;
}

export interface AttemptDetailView {
  id: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  questions: AttemptQuestionView[];
}

function stripOptionAnswers(options: DiagnosticOptionRow[]): Array<{ id: string; text: string }> {
  return options.map((option) => ({ id: option.id, text: option.text }));
}

/** Retorna o estado completo de uma tentativa — NUNCA inclui gabarito
 *  (is_correct de alternativa) nem qual reconhecimento é o certo, mesmo
 *  para questões já respondidas (seção 8 da ordem: o endpoint que entrega a
 *  questão não pode enviar resposta correta antes da conclusão). Retorna
 *  null se a tentativa não existe OU não pertence ao usuário — a rota trata
 *  os dois casos da mesma forma, sem revelar qual dos dois aconteceu. */
export async function getAttemptDetail(
  db: D1Database,
  userId: string,
  attemptId: string
): Promise<AttemptDetailView | null> {
  const attempt = await findAttempt(db, attemptId);
  if (!attempt || attempt.user_id !== userId) return null;

  const questionIds = await listAttemptQuestionIds(db, attemptId);
  const [options, recognitionOptions, helpLayers, responses, helpOpens] = await Promise.all([
    listOptionsForQuestions(db, questionIds),
    listRecognitionOptionsForQuestions(db, questionIds),
    listHelpLayersForQuestions(db, questionIds),
    listResponses(db, attemptId),
    listHelpOpens(db, attemptId),
  ]);

  const question = await Promise.all(questionIds.map((id) => findQuestion(db, id)));

  const responseByQuestion = new Map(responses.map((response) => [response.question_id, response]));
  const helpOpensByQuestion = new Map<string, number[]>();
  for (const helpOpen of helpOpens) {
    const list = helpOpensByQuestion.get(helpOpen.question_id) ?? [];
    list.push(helpOpen.layer);
    helpOpensByQuestion.set(helpOpen.question_id, list);
  }

  const questions: AttemptQuestionView[] = questionIds.map((questionId, index) => {
    const questionRow = question[index];
    const questionOptions = options.filter((option) => option.question_id === questionId);
    const questionRecognitionOptions = recognitionOptions.filter((option) => option.question_id === questionId);
    const availableLayers = helpLayers.filter((layer) => layer.question_id === questionId).map((layer) => layer.layer);
    const response = responseByQuestion.get(questionId);

    return {
      id: questionId,
      position: index,
      prompt: questionRow?.prompt ?? "",
      options: stripOptionAnswers(questionOptions),
      hasRecognition: questionRecognitionOptions.length > 0,
      recognitionOptions: stripOptionAnswers(questionRecognitionOptions),
      helpLayersAvailable: availableLayers,
      helpLayersOpened: helpOpensByQuestion.get(questionId) ?? [],
      answered: response !== undefined,
      isDontKnow: response?.is_dont_know === 1,
    };
  });

  return {
    id: attempt.id,
    status: attempt.status,
    startedAt: attempt.started_at,
    completedAt: attempt.completed_at,
    questions,
  };
}

export interface SaveResponseInput {
  optionId?: unknown;
  recognitionOptionId?: unknown;
  isDontKnow?: unknown;
  timeSpentMs?: unknown;
}

export interface SaveResponseResult {
  ok: boolean;
  fieldErrors?: Record<string, string>;
  notFound?: boolean;
}

/** Salva a resposta de uma questão — corrige no servidor, nunca aceita
 *  `isCorrect` do cliente. Só aceita gravação se a tentativa pertence ao
 *  usuário, está em andamento, e a questão pertence ao conjunto da
 *  tentativa (seção 8 da ordem). */
export async function saveResponse(
  db: D1Database,
  userId: string,
  attemptId: string,
  questionId: string,
  input: SaveResponseInput
): Promise<SaveResponseResult> {
  const attempt = await findAttempt(db, attemptId);
  if (!attempt || attempt.user_id !== userId) return { ok: false, notFound: true };

  const questionIds = await listAttemptQuestionIds(db, attemptId);
  if (!questionIds.includes(questionId)) return { ok: false, notFound: true };

  const isDontKnowResult = validateIsDontKnow(input.isDontKnow);
  const timeSpentResult = validateTimeSpentMs(input.timeSpentMs);
  const fieldErrors: Record<string, string> = {};
  if (!isDontKnowResult.ok) fieldErrors.isDontKnow = isDontKnowResult.error!;
  if (!timeSpentResult.ok) fieldErrors.timeSpentMs = timeSpentResult.error!;

  const isDontKnow = isDontKnowResult.value ?? false;

  let selectedOptionId: string | null = null;
  let isCorrect: boolean | null = null;
  if (!isDontKnow) {
    const optionIdResult = validateNonEmptyId(input.optionId, "Alternativa");
    if (!optionIdResult.ok) {
      fieldErrors.optionId = optionIdResult.error!;
    } else {
      const options = await listOptionsForQuestions(db, [questionId]);
      const selected = options.find((option) => option.id === optionIdResult.value);
      if (!selected) {
        fieldErrors.optionId = "Esta alternativa não pertence a esta questão.";
      } else {
        selectedOptionId = selected.id;
        isCorrect = selected.is_correct === 1;
      }
    }
  }

  let recognitionOptionId: string | null = null;
  let recognitionIsCorrect: boolean | null = null;
  if (input.recognitionOptionId !== undefined && input.recognitionOptionId !== null) {
    const recognitionIdResult = validateNonEmptyId(input.recognitionOptionId, "Reconhecimento");
    if (!recognitionIdResult.ok) {
      fieldErrors.recognitionOptionId = recognitionIdResult.error!;
    } else {
      const recognitionOptions = await listRecognitionOptionsForQuestions(db, [questionId]);
      const selected = recognitionOptions.find((option) => option.id === recognitionIdResult.value);
      if (!selected) {
        fieldErrors.recognitionOptionId = "Esta opção de reconhecimento não pertence a esta questão.";
      } else {
        recognitionOptionId = selected.id;
        recognitionIsCorrect = selected.is_correct === 1;
      }
    }
  }

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };

  const statement = buildUpsertResponseStatement(db, attemptId, userId, questionId, {
    selectedOptionId,
    isDontKnow,
    isCorrect,
    recognitionOptionId,
    recognitionIsCorrect,
    timeSpentMs: timeSpentResult.value ?? 0,
  });
  const [result] = await db.batch([statement]);
  if (result.meta.changes !== 1) {
    // Guard falhou dentro da transação (corrida rara: tentativa concluída
    // entre a leitura acima e a gravação) — trata como "não encontrado/
    // não permitido", nunca aplica parcialmente.
    return { ok: false, notFound: true };
  }
  return { ok: true };
}

export interface OpenHelpResult {
  ok: boolean;
  notFound?: boolean;
  fieldErrors?: Record<string, string>;
  content?: string;
}

export async function openHelp(
  db: D1Database,
  userId: string,
  attemptId: string,
  questionId: string,
  layerInput: unknown
): Promise<OpenHelpResult> {
  const attempt = await findAttempt(db, attemptId);
  if (!attempt || attempt.user_id !== userId) return { ok: false, notFound: true };
  // Checagem de negócio feita aqui, sobre o estado lido: só uma tentativa em
  // andamento pode abrir ajuda. O statement atômico abaixo reavalia a mesma
  // condição dentro da transação (defesa em profundidade contra a corrida
  // rara de conclusão acontecer entre esta leitura e a gravação); nesse caso
  // raríssimo, o registro de abertura simplesmente não é persistido, mas a
  // resposta ainda é tratada como sucesso — não é uma violação de segurança,
  // só um estado de UI ligeiramente otimista.
  if (attempt.status !== "in_progress") return { ok: false, notFound: true };

  const questionIds = await listAttemptQuestionIds(db, attemptId);
  if (!questionIds.includes(questionId)) return { ok: false, notFound: true };

  const layerResult = validateLayer(layerInput);
  if (!layerResult.ok) return { ok: false, fieldErrors: { layer: layerResult.error! } };
  const layer = layerResult.value!;

  const helpLayer = await findHelpLayerContent(db, questionId, layer);
  if (!helpLayer) return { ok: false, notFound: true };

  const statement = buildInsertHelpOpenStatement(db, attemptId, userId, questionId, layer);
  await db.batch([statement]);
  return { ok: true, content: helpLayer.content };
}

export interface CompleteAttemptSummary {
  questionCount: number;
  correctCount: number;
  dontKnowCount: number;
}

export interface CompleteAttemptResult {
  ok: boolean;
  notFound?: boolean;
  fieldErrors?: Record<string, string>;
  alreadyCompleted?: boolean;
  // Resumo técnico mínimo (só contagens, nunca enunciado/resposta/gabarito) —
  // para o evento de auditoria diagnostic_completed (seção 11 da ordem).
  summary?: CompleteAttemptSummary;
}

/** Conclui a tentativa — revalida no SERVIDOR que todas as questões têm
 *  resposta (respondida ou "não sei"), nunca confia no cliente ter
 *  "chegado na última etapa" (seção 5/8 da ordem). Idempotente e seguro
 *  contra corrida (buildCompleteAttemptStatement). */
export async function completeAttempt(
  db: D1Database,
  userId: string,
  attemptId: string
): Promise<CompleteAttemptResult> {
  const attempt = await findAttempt(db, attemptId);
  if (!attempt || attempt.user_id !== userId) return { ok: false, notFound: true };

  if (attempt.status === "completed") {
    return { ok: true, alreadyCompleted: true };
  }
  if (attempt.status !== "in_progress") {
    return { ok: false, notFound: true };
  }

  const questionIds = await listAttemptQuestionIds(db, attemptId);
  const responses = await listResponses(db, attemptId);
  const answeredQuestionIds = new Set(responses.map((response) => response.question_id));
  const missing = questionIds.filter((id) => !answeredQuestionIds.has(id));

  if (missing.length > 0) {
    return {
      ok: false,
      fieldErrors: { questions: `Existem ${missing.length} questão(ões) sem resposta.` },
    };
  }

  const summary: CompleteAttemptSummary = {
    questionCount: questionIds.length,
    correctCount: responses.filter((response) => response.is_correct === 1).length,
    dontKnowCount: responses.filter((response) => response.is_dont_know === 1).length,
  };

  const statement = buildCompleteAttemptStatement(db, attemptId, userId);
  const [result] = await db.batch([statement]);
  if (result.meta.changes !== 1) {
    // Outra requisição concluiu entre a leitura e a gravação — idempotente,
    // não um erro (evita gerar dois resultados na corrida).
    return { ok: true, alreadyCompleted: true };
  }
  return { ok: true, summary };
}

export interface DiagnosticResultView {
  status: string;
  totalQuestions: number;
  answeredCount: number;
  correctCount: number;
  dontKnowCount: number;
  totalTimeMs: number;
  averageTimeMs: number;
  helpOpensByLayer: Record<number, number>;
  recognitionConfiguredCount: number;
  recognitionInformedCount: number;
  recognitionCorrectCount: number;
  disclaimer: string;
}

const RESULT_DISCLAIMER =
  "Resultado técnico provisório para validação do sistema. A análise pedagógica será ativada somente após aprovação da metodologia e do banco de questões.";

/** Resultado estritamente factual — nunca calcula/expõe índice, nota TRI,
 *  nível fechado ou plano (seção 5.3 da ordem). Só existe para tentativas
 *  concluídas. */
export async function getResult(
  db: D1Database,
  userId: string,
  attemptId: string
): Promise<DiagnosticResultView | null> {
  const attempt = await findAttempt(db, attemptId);
  if (!attempt || attempt.user_id !== userId || attempt.status !== "completed") return null;

  const questionIds = await listAttemptQuestionIds(db, attemptId);
  const [responses, helpOpens, recognitionOptions] = await Promise.all([
    listResponses(db, attemptId),
    listHelpOpens(db, attemptId),
    listRecognitionOptionsForQuestions(db, questionIds),
  ]);

  const recognitionConfiguredQuestionIds = new Set(recognitionOptions.map((option) => option.question_id));

  let correctCount = 0;
  let dontKnowCount = 0;
  let totalTimeMs = 0;
  let recognitionInformedCount = 0;
  let recognitionCorrectCount = 0;

  for (const response of responses) {
    if (response.is_correct === 1) correctCount += 1;
    if (response.is_dont_know === 1) dontKnowCount += 1;
    totalTimeMs += response.time_spent_ms;
    if (response.recognition_option_id !== null) {
      recognitionInformedCount += 1;
      if (response.recognition_is_correct === 1) recognitionCorrectCount += 1;
    }
  }

  const helpOpensByLayer: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const helpOpen of helpOpens) {
    helpOpensByLayer[helpOpen.layer] = (helpOpensByLayer[helpOpen.layer] ?? 0) + 1;
  }

  return {
    status: attempt.status,
    totalQuestions: questionIds.length,
    answeredCount: responses.length,
    correctCount,
    dontKnowCount,
    totalTimeMs,
    averageTimeMs: responses.length > 0 ? Math.round(totalTimeMs / responses.length) : 0,
    helpOpensByLayer,
    recognitionConfiguredCount: recognitionConfiguredQuestionIds.size,
    recognitionInformedCount,
    recognitionCorrectCount,
    disclaimer: RESULT_DISCLAIMER,
  };
}

