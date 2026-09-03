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
  findHelpOpen,
  findLatestCompletedAttemptForUser,
  findQuestion,
  listAttemptQuestionIds,
  listHelpLayersForQuestions,
  listHelpOpens,
  listOptionsForQuestions,
  listQuestionsOrdered,
  listRealQuestionsOrdered,
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

/** Sprint 16 v1.3 — `available` agora reflete `isDiagnosticAvailable`
 *  (dev local com fixtures explícitas OU conteúdo real suficiente), nunca
 *  só a flag de dev sozinha (nome do parâmetro atualizado por clareza —
 *  comportamento idêntico ao antigo `fixturesAllowed` quando o chamador
 *  ainda só passar a flag, já que `isDiagnosticAvailable` inclui esse
 *  mesmo caso como um dos dois critérios). */
export async function getStatus(
  db: D1Database,
  userId: string,
  available: boolean
): Promise<DiagnosticStatusView> {
  if (!available) {
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
  reason?: "unavailable" | "active_exists" | "no_questions" | "conflict";
  attemptId?: string;
}

function isUniqueActiveAttemptViolation(error: unknown): boolean {
  // SQLite/D1 reportam violação de UNIQUE constraint na mensagem do erro
  // (não há código estruturado disponível no seam de teste nem, de forma
  // documentada, na API real do D1) — checar o nome da tabela junto do texto
  // padrão evita capturar por engano uma violação de outro índice único.
  return (
    error instanceof Error &&
    /UNIQUE constraint failed/i.test(error.message) &&
    error.message.includes("diagnostic_attempts")
  );
}

/** Cria uma nova tentativa com o catálogo atual de questões (ordem
 *  determinística). Se já existir uma tentativa em andamento, só cria uma
 *  nova mediante `restart: true` explícito — e a anterior é marcada
 *  `abandoned`, nunca apagada (seção 5.1 da ordem: reinício exige
 *  confirmação e preserva o histórico).
 *
 *  A checagem de `active` acima é só um atalho de UX (evita uma viagem ao
 *  banco desnecessária no caminho feliz) — quem garante de verdade que
 *  nenhum usuário fica com duas tentativas in_progress simultâneas é o
 *  índice único parcial da migration 0005, dentro da MESMA transação do
 *  `db.batch()`. Duas criações/reinícios concorrentes: o statement de
 *  INSERT que perder a corrida viola a constraint, o D1/SQLite reverte o
 *  lote inteiro (nada fica parcialmente persistido — nem o abandono da
 *  tentativa vencedora, nem vínculos de questão órfãos) e devolvemos o
 *  mesmo resultado controlado de "já existe uma tentativa ativa", nunca um
 *  erro 500 (correção v1.2, seções 4/5 da ordem).
 *
 *  Sprint 16 v1.3 — o gate de disponibilidade (`isDiagnosticAvailable`)
 *  agora é checado ANTES desta função ser chamada, na rota
 *  (worker/src/routes/diagnostic.ts) — nunca mais aqui dentro. `fixturesAllowed`
 *  passou a controlar SÓ a seleção de conteúdo: dev local com a flag
 *  explícita usa `listQuestionsOrdered` (TODAS as questões, real+fixture —
 *  comportamento idêntico ao de sempre, nenhuma regressão para quem testa
 *  localmente com fixtures); qualquer outro caso (produção real com
 *  conteúdo real, já garantido pelo gate da rota) usa
 *  `listRealQuestionsOrdered` (`is_local_fixture = 0`) — nunca mistura uma
 *  fixture local numa tentativa real. */
export async function createAttempt(
  db: D1Database,
  userId: string,
  fixturesAllowed: boolean,
  restart: boolean
): Promise<CreateAttemptResult> {
  const active = await findActiveAttemptForUser(db, userId);
  if (active && !restart) {
    return { ok: false, reason: "active_exists", attemptId: active.id };
  }

  const questions = fixturesAllowed ? await listQuestionsOrdered(db) : await listRealQuestionsOrdered(db);
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

  let results: Awaited<ReturnType<D1Database["batch"]>>;
  try {
    results = await db.batch(statements);
  } catch (error) {
    if (isUniqueActiveAttemptViolation(error)) {
      const stillActive = await findActiveAttemptForUser(db, userId);
      return { ok: false, reason: "active_exists", attemptId: stillActive?.id };
    }
    throw error;
  }

  // Cada statement do lote deve afetar exatamente uma linha — qualquer
  // contagem diferente indica um estado inesperado (nunca deveria acontecer
  // dado o desenho acima); não fingimos sucesso nesse caso.
  const unexpectedCount = results.some((result) => result.meta.changes !== 1);
  if (unexpectedCount) {
    return { ok: false, reason: "conflict" };
  }

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
  // Distingue os dois casos de sucesso para o chamador decidir se audita
  // (correção v1.2, seção 3/5: só abertura nova gera diagnostic_help_opened).
  outcome?: "opened" | "already_open";
}

/** Abre uma camada de ajuda. O gate de negócio (tentativa em andamento +
 *  progressão 1→2→3→4) vive DENTRO do statement atômico
 *  (buildInsertHelpOpenStatement), nunca numa leitura separada antes da
 *  escrita — elimina a corrida entre checar e gravar (correção v1.2, seção
 *  3 da ordem). Depois do batch, meta.changes por si só não distingue
 *  "já estava aberta" (idempotente) de "gate bloqueou" (pré-requisito
 *  ausente ou tentativa inválida) — os dois dão changes=0 — então uma
 *  leitura de estado (não uma corrida: é só para classificar um resultado
 *  que já é definitivo) decide qual dos dois aconteceu. */
export async function openHelp(
  db: D1Database,
  userId: string,
  attemptId: string,
  questionId: string,
  layerInput: unknown
): Promise<OpenHelpResult> {
  const attempt = await findAttempt(db, attemptId);
  if (!attempt || attempt.user_id !== userId) return { ok: false, notFound: true };

  const questionIds = await listAttemptQuestionIds(db, attemptId);
  if (!questionIds.includes(questionId)) return { ok: false, notFound: true };

  const layerResult = validateLayer(layerInput);
  if (!layerResult.ok) return { ok: false, fieldErrors: { layer: layerResult.error! } };
  const layer = layerResult.value!;

  const helpLayer = await findHelpLayerContent(db, questionId, layer);
  if (!helpLayer) return { ok: false, notFound: true };

  const statement = buildInsertHelpOpenStatement(db, attemptId, userId, questionId, layer);
  const [result] = await db.batch([statement]);

  if (result.meta.changes === 1) {
    return { ok: true, content: helpLayer.content, outcome: "opened" };
  }

  // changes === 0: já estava aberta OU o gate bloqueou. Reler o estado real
  // (pós-escrita, não uma corrida) para decidir a resposta correta.
  const alreadyOpen = await findHelpOpen(db, attemptId, questionId, layer);
  if (alreadyOpen) {
    return { ok: true, content: helpLayer.content, outcome: "already_open" };
  }

  const freshAttempt = await findAttempt(db, attemptId);
  if (!freshAttempt || freshAttempt.status !== "in_progress") {
    // Tentativa concluída/abandonada (inclusive por corrida com a conclusão
    // acontecendo entre a leitura do início desta função e a gravação) não
    // recebe nem revela ajuda nova.
    return { ok: false, notFound: true };
  }

  if (layer > 1) {
    return {
      ok: false,
      fieldErrors: { layer: "Abra a camada anterior antes desta." },
    };
  }

  // Não deveria ser alcançável (camada 1 nunca tem pré-requisito e a
  // tentativa está em andamento) — estado inesperado, tratado como erro de
  // validação genérico em vez de fingir sucesso.
  return { ok: false, fieldErrors: { layer: "Não foi possível abrir esta camada agora." } };
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

