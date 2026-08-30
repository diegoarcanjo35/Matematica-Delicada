import type { Env } from "../env";
import { Errors, json, readJsonBody } from "../lib/response";
import { readSessionToken } from "../lib/cookies";
import { checkSession } from "../services/authService";
import { resolveEditorialRole, roleSatisfies } from "../lib/rbac";
import {
  isValidMutationId,
  isValidQuestionId,
  pickAllowedFields,
  QUESTION_CREATE_ALLOWED_FIELDS,
  validateDifficultyFilter,
  validateExpectedVersion,
  validateListLimit,
  validateListPage,
  validateOriginFilter,
  validateStatusFilter,
} from "../lib/questionsValidation";
import {
  approveQuestion,
  archiveQuestion,
  createQuestion,
  getQuestionDetail,
  listQuestionsService,
  publishQuestion,
  requestChanges,
  submitForReview,
  updateQuestion,
  type QuestionInput,
} from "../services/questionService";

/* Rotas do Banco de Questões — Sprint 7 v1.0, seção 7 da ordem.

   Ordem obrigatória de checagens em toda requisição:
     1) sessão válida (401 sem sessão);
     2) papel editorial (editor/admin) via consulta ao banco — NUNCA um
        campo enviado pelo cliente (403 sem papel, corpo genérico, nunca
        vaza conteúdo editorial);
     3) validação de entrada (400);
     4) só então o serviço toca as tabelas questions/question_*.
   GETs são 100% somente leitura. */

async function requireEditorialActor(
  request: Request,
  env: Env
): Promise<{ userId: string; role: "editor" | "admin" } | null> {
  const token = readSessionToken(request);
  if (!token) return null;
  const session = await checkSession(env.DB, token);
  if (!session.ok || !session.user) return null;
  const role = await resolveEditorialRole(env.DB, session.user.id);
  if (role === null) return null;
  return { userId: session.user.id, role };
}

function validationError(field: string, message: string): Response {
  return json({ error: { code: "validation_error", message: "Parâmetro inválido.", fields: { [field]: message } } }, { status: 400 });
}

const QUESTION_ID_RE = /^\/api\/editorial\/questions\/([^/]+)$/;
const QUESTION_ACTION_RE = /^\/api\/editorial\/questions\/([^/]+)\/(submit-review|request-changes|approve|publish|archive)$/;

export async function handleEditorialQuestionsRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;

  /* Endpoint leve só para a interface saber se deve mostrar o shell
     editorial ou o estado de acesso negado — nunca revela conteúdo, só o
     papel efetivo (derivado do banco, nunca do cliente). 401 sem sessão;
     200 com `role: null` (nunca 403) quando autenticado mas sem papel — a
     ausência de papel não é um erro de autorização aqui, é a resposta em
     si. */
  if (path === "/api/editorial/me" && request.method === "GET") {
    const token = readSessionToken(request);
    if (!token) return Errors.unauthorized();
    const session = await checkSession(env.DB, token);
    if (!session.ok || !session.user) return Errors.unauthorized();
    const role = await resolveEditorialRole(env.DB, session.user.id);
    return json({ ok: true, role });
  }

  if (path !== "/api/editorial/questions" && !path.startsWith("/api/editorial/questions/")) return null;

  const actor = await requireEditorialActor(request, env);
  if (!actor) {
    // Corpo genérico — não revela se a sessão é inválida ou se o usuário
    // simplesmente não tem papel editorial, e nunca inclui conteúdo.
    const token = readSessionToken(request);
    if (!token) return Errors.unauthorized();
    return Errors.forbidden("Sem permissão editorial.");
  }

  if (path === "/api/editorial/questions") {
    if (request.method === "GET") {
      const searchTerm = url.searchParams.get("busca");
      const statusResult = validateStatusFilter(url.searchParams.get("status"));
      if (!statusResult.ok) return validationError("status", statusResult.error!);
      const originResult = validateOriginFilter(url.searchParams.get("origem"));
      if (!originResult.ok) return validationError("origem", originResult.error!);
      const difficultyResult = validateDifficultyFilter(url.searchParams.get("dificuldade"));
      if (!difficultyResult.ok) return validationError("dificuldade", difficultyResult.error!);
      const limitResult = validateListLimit(url.searchParams.get("limite"));
      if (!limitResult.ok) return validationError("limite", limitResult.error!);
      const pageResult = validateListPage(url.searchParams.get("pagina"));
      if (!pageResult.ok) return validationError("pagina", pageResult.error!);
      const anoParam = url.searchParams.get("ano");
      const ano = anoParam ? Number(anoParam) : null;
      const hasImageParam = url.searchParams.get("comImagem");
      const hasImage = hasImageParam === "true" ? true : hasImageParam === "false" ? false : null;

      const result = await listQuestionsService(
        env.DB,
        {
          search: searchTerm && searchTerm.trim() ? searchTerm.trim() : null,
          status: statusResult.value ?? null,
          origin: originResult.value ?? null,
          difficulty: difficultyResult.value ?? null,
          conteudo: url.searchParams.get("conteudo") || null,
          autorId: url.searchParams.get("autorId") || null,
          revisorId: url.searchParams.get("revisorId") || null,
          ano: ano && Number.isInteger(ano) ? ano : null,
          hasImage,
        },
        pageResult.value!,
        limitResult.value!
      );
      return json({ ok: true, ...result });
    }

    if (request.method === "POST") {
      const body = await readJsonBody<Record<string, unknown>>(request);
      if (!body) return Errors.badRequest("Corpo inválido ou excede o limite de tamanho.");
      const input = pickAllowedFields<QuestionInput>(body, QUESTION_CREATE_ALLOWED_FIELDS);
      const result = await createQuestion(env.DB, actor.userId, input);
      if (!result.ok) {
        if (result.fieldErrors) {
          return json({ error: { code: "validation_error", message: "Não foi possível criar a questão.", fields: result.fieldErrors } }, { status: 400 });
        }
        return Errors.internal();
      }
      return json({ ok: true, id: result.value!.id }, { status: 201 });
    }

    return Errors.methodNotAllowed();
  }

  const actionMatch = path.match(QUESTION_ACTION_RE);
  if (actionMatch) {
    if (request.method !== "POST") return Errors.methodNotAllowed();
    const [, questionId, action] = actionMatch;
    if (!isValidQuestionId(questionId)) return Errors.notFound();

    const body = await readJsonBody<{ expectedVersion?: number; reason?: string }>(request);
    if (!body) return Errors.badRequest("Corpo inválido.");
    const versionResult = validateExpectedVersion(body.expectedVersion);
    if (!versionResult.ok) return validationError("expectedVersion", versionResult.error!);

    let transitionResult;
    if (action === "submit-review") {
      transitionResult = await submitForReview(env.DB, actor.userId, actor.role, questionId, versionResult.value!);
    } else if (action === "request-changes") {
      if (!roleSatisfies(actor.role, "admin")) return Errors.forbidden();
      transitionResult = await requestChanges(env.DB, actor.userId, actor.role, questionId, versionResult.value!, body.reason ?? "");
    } else if (action === "approve") {
      if (!roleSatisfies(actor.role, "admin")) return Errors.forbidden();
      transitionResult = await approveQuestion(env.DB, actor.userId, actor.role, questionId, versionResult.value!);
    } else if (action === "publish") {
      if (!roleSatisfies(actor.role, "admin")) return Errors.forbidden();
      transitionResult = await publishQuestion(env.DB, actor.userId, actor.role, questionId, versionResult.value!);
    } else {
      if (!roleSatisfies(actor.role, "admin")) return Errors.forbidden();
      transitionResult = await archiveQuestion(env.DB, actor.userId, actor.role, questionId, versionResult.value!);
    }

    if (!transitionResult.ok) {
      if (transitionResult.notFound) return Errors.notFound();
      if (transitionResult.forbidden) return Errors.forbidden();
      if (transitionResult.conflict) {
        return json({ error: { code: "version_conflict", message: "A questão foi alterada por outra ação. Recarregue e tente novamente." } }, { status: 409 });
      }
      return json(
        { error: { code: "validation_error", message: "Transição não permitida.", fields: transitionResult.fieldErrors ?? {} } },
        { status: 400 }
      );
    }
    return json({ ok: true, changed: transitionResult.changed ?? true });
  }

  const idMatch = path.match(QUESTION_ID_RE);
  if (idMatch) {
    const questionId = idMatch[1];
    if (!isValidQuestionId(questionId)) return Errors.notFound();

    if (request.method === "GET") {
      const detail = await getQuestionDetail(env.DB, questionId);
      if (!detail) return Errors.notFound();
      return json({ ok: true, question: detail });
    }

    if (request.method === "PATCH") {
      const body = await readJsonBody<Record<string, unknown> & { expectedVersion?: number; mutationId?: string }>(request);
      if (!body) return Errors.badRequest("Corpo inválido ou excede o limite de tamanho.");
      const versionResult = validateExpectedVersion(body.expectedVersion);
      if (!versionResult.ok) return validationError("expectedVersion", versionResult.error!);
      // Sprint 7 v1.2, Correção A — mutationId é obrigatório e precisa ser
      // um UUID bem formado; a prova de idempotência de retry nunca é
      // conteúdo parecido, só esta chave.
      if (!isValidMutationId(body.mutationId)) return validationError("mutationId", "Informe um mutationId (UUID) válido.");

      const input = pickAllowedFields<QuestionInput>(body, QUESTION_CREATE_ALLOWED_FIELDS);
      const result = await updateQuestion(env.DB, actor.userId, questionId, versionResult.value!, body.mutationId, input);
      if (!result.ok) {
        if (result.notFound) return Errors.notFound();
        if (result.conflict) {
          return json(
            {
              error: {
                code: "version_conflict",
                message: result.fieldErrors?.mutationId ?? "A questão foi alterada por outra pessoa. Recarregue antes de salvar.",
              },
            },
            { status: 409 }
          );
        }
        return json({ error: { code: "validation_error", message: "Não foi possível salvar.", fields: result.fieldErrors ?? {} } }, { status: 400 });
      }
      return json({ ok: true, id: result.value!.id, changed: result.changed ?? true });
    }

    return Errors.methodNotAllowed();
  }

  return Errors.notFound();
}
