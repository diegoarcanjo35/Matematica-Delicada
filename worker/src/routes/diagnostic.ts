import type { Env } from "../env";
import { isLocalDiagnosticFixturesAllowed } from "../env";
import { Errors, json, readJsonBody } from "../lib/response";
import { readSessionToken } from "../lib/cookies";
import { checkSession } from "../services/authService";
import { recordAuditEvent, type AuditEventType } from "../repositories/auditRepository";
import { isDiagnosticAvailable } from "../repositories/diagnosticRepository";
import {
  completeAttempt,
  createAttempt,
  getAttemptDetail,
  getResult,
  getStatus,
  openHelp,
  saveResponse,
} from "../services/diagnosticService";

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

function unavailableResponse() {
  return json(
    {
      ok: true,
      available: false,
      message: "Ainda não há questões cadastradas para o diagnóstico.",
    },
    { status: 200 }
  );
}

const ATTEMPT_ID_RE = /^\/api\/diagnostic\/attempts\/([^/]+)$/;
const RESPONSE_RE = /^\/api\/diagnostic\/attempts\/([^/]+)\/responses\/([^/]+)$/;
const HELP_RE = /^\/api\/diagnostic\/attempts\/([^/]+)\/help\/([^/]+)\/([^/]+)$/;
const COMPLETE_RE = /^\/api\/diagnostic\/attempts\/([^/]+)\/complete$/;
const RESULT_RE = /^\/api\/diagnostic\/attempts\/([^/]+)\/result$/;

export async function handleDiagnosticRequest(
  request: Request,
  env: Env,
  url: URL
): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;

  if (!path.startsWith("/api/diagnostic")) return null;

  const user = await requireUser(request, env);
  if (!user) return Errors.unauthorized();

  // Sprint 16 v1.3, seção 1 da ordem — `fixturesAllowed` continua existindo
  // (controla SÓ a seleção de conteúdo dentro de createAttempt: dev local
  // com a flag usa fixture+real, qualquer outro caso usa só real). O GATE
  // de disponibilidade em si passou a ser `isDiagnosticAvailable`, que
  // também abre em produção real quando existe conteúdo REAL suficiente —
  // nunca mais só a flag de dev sozinha.
  const fixturesAllowed = isLocalDiagnosticFixturesAllowed(env, url);
  const available = await isDiagnosticAvailable(env, url, env.DB);

  if (path === "/api/diagnostic/status" && method === "GET") {
    const status = await getStatus(env.DB, user.id, available);
    return json({ ok: true, ...status });
  }

  if (!available) {
    // Fora do ambiente local/teste autorizado e sem conteúdo real
    // suficiente, nenhum outro endpoint de diagnóstico toca nas tabelas
    // diagnostic_* — resposta acolhedora padrão, igual para todos eles.
    return unavailableResponse();
  }

  if (path === "/api/diagnostic/attempts" && method === "POST") {
    const body = await readJsonBody<{ restart?: boolean }>(request);
    const restart = body?.restart === true;

    const result = await createAttempt(env.DB, user.id, fixturesAllowed, restart);
    if (!result.ok) {
      if (result.reason === "active_exists") {
        return json(
          { error: { code: "active_attempt_exists", message: "Já existe uma tentativa em andamento.", attemptId: result.attemptId } },
          { status: 409 }
        );
      }
      if (result.reason === "no_questions") {
        return json(
          { error: { code: "no_questions", message: "Nenhuma questão de diagnóstico está disponível agora." } },
          { status: 409 }
        );
      }
      if (result.reason === "conflict") {
        return json(
          { error: { code: "conflict", message: "Não foi possível iniciar o diagnóstico agora. Tente novamente." } },
          { status: 409 }
        );
      }
      return Errors.badRequest("Não foi possível iniciar o diagnóstico.");
    }

    if (restart) {
      await audit(env, "diagnostic_restarted", user.id);
    }
    await audit(env, "diagnostic_started", user.id);
    return json({ ok: true, attemptId: result.attemptId }, { status: 201 });
  }

  const attemptIdMatch = path.match(ATTEMPT_ID_RE);
  if (attemptIdMatch && method === "GET") {
    const attempt = await getAttemptDetail(env.DB, user.id, attemptIdMatch[1]);
    if (!attempt) return Errors.notFound();
    return json({ ok: true, attempt });
  }

  const responseMatch = path.match(RESPONSE_RE);
  if (responseMatch && method === "PATCH") {
    const [, attemptId, questionId] = responseMatch;
    const body = await readJsonBody<Record<string, unknown>>(request);
    if (!body) return Errors.badRequest();

    const result = await saveResponse(env.DB, user.id, attemptId, questionId, body);
    if (!result.ok) {
      if (result.notFound) return Errors.notFound();
      return json(
        { error: { code: "validation_error", message: "Um ou mais campos são inválidos.", fields: result.fieldErrors } },
        { status: 400 }
      );
    }

    // Metadado mínimo, não sensível — nunca a resposta/alternativa escolhida.
    await audit(env, "diagnostic_progress_saved", user.id, { questionId });
    return json({ ok: true });
  }

  const helpMatch = path.match(HELP_RE);
  if (helpMatch && method === "POST") {
    const [, attemptId, questionId, layerRaw] = helpMatch;
    const layer = Number(layerRaw);

    const result = await openHelp(env.DB, user.id, attemptId, questionId, layer);
    if (!result.ok) {
      if (result.notFound) return Errors.notFound();
      return json(
        { error: { code: "validation_error", message: "Camada de ajuda inválida.", fields: result.fieldErrors } },
        { status: 400 }
      );
    }

    // ID interno e camada — nunca o texto da ajuda em si. Só abertura nova
    // persistida gera evento; reabertura idempotente não duplica auditoria
    // (correção v1.2, seção 3 da ordem).
    if (result.outcome === "opened") {
      await audit(env, "diagnostic_help_opened", user.id, { questionId, layer });
    }
    return json({ ok: true, content: result.content });
  }

  const completeMatch = path.match(COMPLETE_RE);
  if (completeMatch && method === "POST") {
    const attemptId = completeMatch[1];
    const result = await completeAttempt(env.DB, user.id, attemptId);
    if (!result.ok) {
      if (result.notFound) return Errors.notFound();
      return json(
        { error: { code: "validation_error", message: "Existem questões sem resposta.", fields: result.fieldErrors } },
        { status: 400 }
      );
    }

    if (!result.alreadyCompleted && result.summary) {
      // Resumo técnico mínimo: só contagens, nunca enunciado/resposta/gabarito.
      await audit(env, "diagnostic_completed", user.id, {
        questionCount: result.summary.questionCount,
        correctCount: result.summary.correctCount,
        dontKnowCount: result.summary.dontKnowCount,
      });
    }
    return json({ ok: true });
  }

  const resultMatch = path.match(RESULT_RE);
  if (resultMatch && method === "GET") {
    const attemptResult = await getResult(env.DB, user.id, resultMatch[1]);
    if (!attemptResult) return Errors.notFound();
    return json({ ok: true, result: attemptResult });
  }

  return null;
}
