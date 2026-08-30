import type { Env } from "./env";
import { Errors, json } from "./lib/response";
import { isMutationMethod, isOriginAllowed } from "./lib/origin";
import { handleAuthRequest } from "./routes/auth";
import { handleDevRequest } from "./routes/dev";
import { handleOnboardingRequest } from "./routes/onboarding";
import { handleDiagnosticRequest } from "./routes/diagnostic";
import { handleScheduleRequest } from "./routes/schedule";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({ ok: true, service: "matematica-delicada-api" });
    }

    if (url.pathname.startsWith("/api/")) {
      if (isMutationMethod(request.method) && !isOriginAllowed(request, url)) {
        return Errors.forbidden();
      }

      try {
        const authResponse = await handleAuthRequest(request, env, url);
        if (authResponse) return authResponse;

        const onboardingResponse = await handleOnboardingRequest(request, env, url);
        if (onboardingResponse) return onboardingResponse;

        const diagnosticResponse = await handleDiagnosticRequest(request, env, url);
        if (diagnosticResponse) return diagnosticResponse;

        const scheduleResponse = await handleScheduleRequest(request, env, url);
        if (scheduleResponse) return scheduleResponse;

        const devResponse = await handleDevRequest(request, env, url);
        if (devResponse) return devResponse;

        return Errors.notFound();
      } catch (error) {
        // Nunca expor stack trace ou detalhe interno ao cliente.
        console.error("Erro interno não tratado:", error);
        return Errors.internal();
      }
    }

    // Qualquer outra rota é servida pelos assets estáticos da SPA (fallback já
    // configurado em wrangler.jsonc: not_found_handling = single-page-application).
    return env.ASSETS.fetch(request);
  },
};
