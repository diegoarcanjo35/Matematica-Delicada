import type { Env } from "../env";
import { isLocalEditorialFixturesAllowed } from "../env";
import { Errors, json, readJsonBody } from "../lib/response";
import { readSessionToken } from "../lib/cookies";
import { checkSession } from "../services/authService";
import { recordAuditEvent, type AuditEventType } from "../repositories/auditRepository";
import { isValidHelpLayer, isValidProblemReportCategory, validateProblemReportComment } from "../lib/playerValidation";
import {
  confirmAnswer,
  getAttempt,
  openHelpLayer,
  reportProblem,
  saveAnswer,
  saveRecognition,
  setBookmark,
  startOrResumeAttempt,
  toAttemptStateDto,
} from "../services/playerService";

/* Rotas do Player de Questão — Sprint 8 v1.1.

   Ordem obrigatória de checagens em toda requisição:
     1) sessão válida (401 sem sessão) — mesmo padrão de diagnostic.ts/
        patterns.ts/editorialQuestions.ts desde a Sprint 4;
     2) gate local de fixtures — ANTES de qualquer consulta às tabelas
        questions/question_attempts/etc. Reaproveita EXATAMENTE o gate do
        Banco de Questões (isLocalEditorialFixturesAllowed) — nenhum gate
        novo foi criado (seção 14 da ordem: só existe conteúdo técnico de
        fixture nesta sprint, nenhuma questão oficial real, então o mesmo
        gate que já protege `questions`/`question_dna`/etc. desde a
        Sprint 7 é a fonte de verdade correta);
     3) validação de parâmetros (400/404);
     4) só então o serviço consulta/muta o banco.

   Uma tentativa de outro aluno SEMPRE responde 404 (nunca 403) — o próprio
   repositório já escopa por `user_id` no SQL (playerRepository.ts), então
   simplesmente "não encontrar" já é a resposta certa sem vazar a
   existência da tentativa alheia (mesmo padrão de rascunho-vs-inexistente
   já usado pelo catálogo de padrões desde a Sprint 6). */

function newId(): string {
  return crypto.randomUUID();
}

async function audit(env: Env, type: AuditEventType, userId: string, metadata?: Record<string, string | number | boolean>) {
  await recordAuditEvent(env.DB, newId(), type, userId, metadata);
}

async function requireUser(request: Request, env: Env): Promise<{ id: string } | null> {
  const token = readSessionToken(request);
  if (!token) return null;
  const result = await checkSession(env.DB, token);
  if (!result.ok || !result.user) return null;
  return { id: result.user.id };
}

/** Mesma forma acolhedora dos gates de diagnóstico/cronograma/padrões: 200
 *  com `available: false`, nunca 404/500 e nunca qualquer vestígio de
 *  conteúdo de questão. */
function unavailableResponse(): Response {
  return json({ ok: true, available: false, message: "O Player de Questão está em preparação." }, { status: 200 });
}

function conflictResponse(): Response {
  return Errors.conflict("A tentativa foi alterada em outro lugar. Recarregue e tente novamente.");
}

const ATTEMPT_ID_RE = /^\/api\/player\/attempts\/([^/]+)$/;
const RECOGNITION_RE = /^\/api\/player\/attempts\/([^/]+)\/recognition$/;
const ANSWER_RE = /^\/api\/player\/attempts\/([^/]+)\/answer$/;
const CONFIRM_RE = /^\/api\/player\/attempts\/([^/]+)\/confirm$/;
const HELP_RE = /^\/api\/player\/attempts\/([^/]+)\/help\/([^/]+)$/;
const BOOKMARK_RE = /^\/api\/player\/questions\/([^/]+)\/review-bookmark$/;
const REPORT_RE = /^\/api\/player\/questions\/([^/]+)\/problem-reports$/;

export async function handlePlayerRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;

  if (!path.startsWith("/api/player/")) return null;

  const user = await requireUser(request, env);
  if (!user) return Errors.unauthorized();

  const fixturesAllowed = isLocalEditorialFixturesAllowed(env, url);
  if (!fixturesAllowed) return unavailableResponse();

  if (path === "/api/player/attempts") {
    if (method !== "POST") return Errors.methodNotAllowed();
    const body = await readJsonBody<{ questionId?: unknown; mode?: unknown }>(request);
    if (!body || typeof body.questionId !== "string" || typeof body.mode !== "string") {
      return Errors.badRequest("questionId e mode são obrigatórios.");
    }
    const result = await startOrResumeAttempt(env.DB, user.id, body.questionId, body.mode);
    if (!result.ok) {
      if (result.notFound) return Errors.notFound();
      return json({ error: { code: "validation_error", message: "Não foi possível iniciar a tentativa.", fields: result.fieldErrors } }, { status: 400 });
    }
    if (result.changed) {
      await audit(env, "question_viewed", user.id, { questionId: body.questionId });
      await audit(env, "question_attempt_started", user.id, { questionId: body.questionId, mode: body.mode, attemptId: result.value!.attemptId });
    }
    return json({ ok: true, attemptId: result.value!.attemptId }, { status: result.changed ? 201 : 200 });
  }

  const attemptMatch = path.match(ATTEMPT_ID_RE);
  if (attemptMatch) {
    if (method !== "GET") return Errors.methodNotAllowed();
    const attempt = await getAttempt(env.DB, user.id, attemptMatch[1]);
    if (!attempt) return Errors.notFound();
    const dto = await toAttemptStateDto(env.DB, attempt);
    if (!dto) return Errors.notFound();
    return json({ ok: true, attempt: dto });
  }

  const recognitionMatch = path.match(RECOGNITION_RE);
  if (recognitionMatch) {
    if (method !== "PATCH") return Errors.methodNotAllowed();
    const attemptId = recognitionMatch[1];
    const body = await readJsonBody<{ version?: unknown; patternSlug?: unknown; clue?: unknown; strategy?: unknown }>(request);
    if (!body || typeof body.version !== "number") return Errors.badRequest("version é obrigatória.");
    const result = await saveRecognition(env.DB, user.id, attemptId, body.version, { patternSlug: body.patternSlug, clue: body.clue, strategy: body.strategy });
    if (!result.ok) {
      if (result.notFound) return Errors.notFound();
      if (result.conflict) return conflictResponse();
      return json({ error: { code: "validation_error", message: "Reconhecimento inválido.", fields: result.fieldErrors } }, { status: 400 });
    }
    if (result.changed) {
      await audit(env, "question_pattern_selected", user.id, { attemptId });
    }
    return json({ ok: true });
  }

  const answerMatch = path.match(ANSWER_RE);
  if (answerMatch) {
    if (method !== "PATCH") return Errors.methodNotAllowed();
    const attemptId = answerMatch[1];
    const body = await readJsonBody<{ version?: unknown; alternative?: unknown }>(request);
    if (!body || typeof body.version !== "number") return Errors.badRequest("version é obrigatória.");
    const result = await saveAnswer(env.DB, user.id, attemptId, body.version, body.alternative);
    if (!result.ok) {
      if (result.notFound) return Errors.notFound();
      if (result.conflict) return conflictResponse();
      return json({ error: { code: "validation_error", message: "Alternativa inválida.", fields: result.fieldErrors } }, { status: 400 });
    }
    if (result.changed && result.eventType) {
      await audit(env, result.eventType === "selected" ? "question_answer_selected" : "question_answer_changed", user.id, { attemptId });
    }
    return json({ ok: true });
  }

  const confirmMatch = path.match(CONFIRM_RE);
  if (confirmMatch) {
    if (method !== "POST") return Errors.methodNotAllowed();
    const attemptId = confirmMatch[1];
    const body = await readJsonBody<{ version?: unknown }>(request);
    if (!body || typeof body.version !== "number") return Errors.badRequest("version é obrigatória.");
    const result = await confirmAnswer(env.DB, user.id, attemptId, body.version);
    if (!result.ok) {
      if (result.notFound) return Errors.notFound();
      if (result.conflict) return conflictResponse();
      return json({ error: { code: "validation_error", message: "Não é possível confirmar agora.", fields: result.fieldErrors } }, { status: 400 });
    }
    if (result.changed) {
      await audit(env, "question_answer_confirmed", user.id, { attemptId });
      await audit(env, "question_attempt_completed", user.id, { attemptId });
    }
    const attempt = await getAttempt(env.DB, user.id, attemptId);
    const dto = attempt ? await toAttemptStateDto(env.DB, attempt) : null;
    return json({ ok: true, attempt: dto });
  }

  const helpMatch = path.match(HELP_RE);
  if (helpMatch) {
    if (method !== "POST") return Errors.methodNotAllowed();
    const [, attemptId, layerRaw] = helpMatch;
    const layer = Number(layerRaw);
    if (!isValidHelpLayer(layer)) return Errors.badRequest("Camada de ajuda inválida.");
    const body = await readJsonBody<{ version?: unknown; confirmViewResolution?: unknown }>(request);
    if (!body || typeof body.version !== "number") return Errors.badRequest("version é obrigatória.");
    const result = await openHelpLayer(env.DB, user.id, attemptId, body.version, layer, body.confirmViewResolution === true);
    if (!result.ok) {
      if (result.notFound) return Errors.notFound();
      if (result.conflict) return conflictResponse();
      return json({ error: { code: "validation_error", message: "Não é possível abrir esta camada agora.", fields: result.fieldErrors } }, { status: 400 });
    }
    if (result.changed) {
      await audit(env, "question_help_opened", user.id, { attemptId, layer });
    }
    const attempt = await getAttempt(env.DB, user.id, attemptId);
    const dto = attempt ? await toAttemptStateDto(env.DB, attempt) : null;
    return json({ ok: true, attempt: dto });
  }

  const bookmarkMatch = path.match(BOOKMARK_RE);
  if (bookmarkMatch) {
    const questionId = bookmarkMatch[1];
    if (method === "PUT") {
      const result = await setBookmark(env.DB, user.id, questionId, true);
      if (!result.ok) return Errors.notFound();
      if (result.changed) await audit(env, "question_saved_for_review", user.id, { questionId });
      return json({ ok: true, saved: true });
    }
    if (method === "DELETE") {
      const result = await setBookmark(env.DB, user.id, questionId, false);
      if (!result.ok) return Errors.notFound();
      return json({ ok: true, saved: false });
    }
    return Errors.methodNotAllowed();
  }

  const reportMatch = path.match(REPORT_RE);
  if (reportMatch) {
    if (method !== "POST") return Errors.methodNotAllowed();
    const questionId = reportMatch[1];
    const body = await readJsonBody<{ category?: unknown; comment?: unknown; attemptId?: unknown }>(request);
    if (!body || !isValidProblemReportCategory(body.category)) {
      return json({ error: { code: "validation_error", message: "Categoria obrigatória.", fields: { category: "Categoria inválida." } } }, { status: 400 });
    }
    const commentResult = validateProblemReportComment(body.comment);
    if (!commentResult.ok) {
      return json({ error: { code: "validation_error", message: "Comentário inválido.", fields: { comment: commentResult.error } } }, { status: 400 });
    }
    const attemptId = typeof body.attemptId === "string" ? body.attemptId : null;
    const result = await reportProblem(env.DB, user.id, questionId, attemptId, body.category, commentResult.value ?? null);
    if (!result.ok) return Errors.notFound();
    // Nunca o comentário livre — só id/categoria/metadado técnico (seção 15).
    await audit(env, "question_problem_reported", user.id, { questionId, category: body.category });
    return json({ ok: true, reportId: result.value!.reportId }, { status: 201 });
  }

  return null;
}
