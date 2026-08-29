import type { Env } from "../env";
import { Errors, json, readJsonBody } from "../lib/response";
import { readSessionToken } from "../lib/cookies";
import { checkSession } from "../services/authService";
import { recordAuditEvent, type AuditEventType } from "../repositories/auditRepository";
import { completeOnboarding, getOnboarding, saveProgress, type OnboardingPatchInput } from "../services/onboardingService";

function newId(): string {
  return crypto.randomUUID();
}

async function audit(env: Env, type: AuditEventType, userId: string, metadata?: Record<string, string | number | boolean>) {
  await recordAuditEvent(env.DB, newId(), type, userId, metadata);
}

/** Deriva o usuário exclusivamente da sessão validada no servidor — nunca de
 *  `user_id` no corpo/query (seção 8 da ordem: "nunca aceitar user_id do
 *  corpo/query para autorização"). Retorna null se não há sessão válida. */
async function requireUser(request: Request, env: Env): Promise<{ id: string } | null> {
  const token = readSessionToken(request);
  if (!token) return null;
  const result = await checkSession(env.DB, token);
  if (!result.ok || !result.user) return null;
  return { id: result.user.id };
}

export async function handleOnboardingRequest(
  request: Request,
  env: Env,
  url: URL
): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/onboarding" && method === "GET") {
    const user = await requireUser(request, env);
    if (!user) return Errors.unauthorized();

    const profile = await getOnboarding(env.DB, user.id);
    return json({ ok: true, profile });
  }

  if (path === "/api/onboarding" && (method === "PATCH" || method === "PUT")) {
    const user = await requireUser(request, env);
    if (!user) return Errors.unauthorized();

    const body = await readJsonBody<OnboardingPatchInput>(request);
    if (!body) return Errors.badRequest();

    const currentYear = new Date().getUTCFullYear();
    const result = await saveProgress(env.DB, user.id, body, currentYear);

    if (!result.ok) {
      return json(
        { error: { code: "validation_error", message: "Um ou mais campos são inválidos.", fields: result.fieldErrors } },
        { status: 400 }
      );
    }

    if (result.startedNow) {
      await audit(env, "onboarding_started", user.id);
    }
    if (result.wasCompletedBefore) {
      await audit(env, "onboarding_preferences_updated", user.id);
    } else {
      // Metadado mínimo, não sensível: só o número da etapa (nunca dificuldades,
      // acessibilidade ou valores completos das respostas — seção 12 da ordem).
      await audit(env, "onboarding_progress_saved", user.id, { step: result.profile?.currentStep ?? 0 });
    }

    return json({ ok: true, profile: result.profile });
  }

  if (path === "/api/onboarding/complete" && method === "POST") {
    const user = await requireUser(request, env);
    if (!user) return Errors.unauthorized();

    const result = await completeOnboarding(env.DB, user.id);

    if (!result.ok) {
      return json(
        { error: { code: "validation_error", message: "Existem campos obrigatórios pendentes.", fields: result.fieldErrors } },
        { status: 400 }
      );
    }

    if (!result.alreadyCompleted) {
      await audit(env, "onboarding_completed", user.id);
    }

    return json({ ok: true, profile: result.profile });
  }

  return null;
}
