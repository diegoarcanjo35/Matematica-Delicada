import type { Env } from "../env";
import { isDevOutboxAllowed, isRealEmailProviderConfigured, shouldOmitSecureCookie } from "../env";
import { Errors, json, readJsonBody } from "../lib/response";
import { isValidEmail, isValidName, isValidPassword, normalizeEmail } from "../lib/validation";
import { buildExpiredSessionCookie, buildSessionCookie, readSessionToken } from "../lib/cookies";
import { checkEmailRateLimit, checkRateLimit, clientIdentifier } from "../lib/rateLimit";
import { recordAuditEvent, type AuditEventType } from "../repositories/auditRepository";
import { DevOutboxEmailAdapter, NoProviderEmailAdapter } from "../email/devOutboxAdapter";
import { ResendEmailAdapter } from "../email/resendAdapter";
import {
  checkSession,
  confirmEmail,
  login,
  logout,
  requestEmailConfirmation,
  requestPasswordReset,
  resetPassword,
  signup,
} from "../services/authService";

/* Limites por minuto. Duas dimensões independentes, ambas precisam passar:
   - por IP (clientIdentifier) — limita quantas tentativas UM VISITANTE faz;
   - por e-mail normalizado (checkEmailRateLimit) — limita quantas tentativas
     UMA CONTA sofre, mesmo vindas de IPs diferentes.
   LIMITAÇÃO CONHECIDA: em ambiente local (wrangler dev), a Cloudflare não injeta
   cf-connecting-ip, então clientIdentifier() cai num valor fixo ("local-dev") e
   todo tráfego local compartilharia a mesma janela por IP. Sprint 3 v1.2 mitigou
   o efeito colateral disso na suíte de testes (arquivos E2E diferentes deixando
   de "vazar" contador de rate limit entre si) via clientIdentifier(request, env, url)
   — ver worker/src/env.ts:isTestRateLimitIsolationAllowed — sem alterar o
   comportamento real do limitador. A defesa primária de produção continua sendo o
   Rate Limiting nativo da Cloudflare, na borda, por IP real — ver docs/AUTENTICACAO.md. */
const RATE_LIMITS = {
  signup: 30,
  login: 30,
  emailConfirmationRequest: 20,
  passwordResetRequest: 20,
  passwordReset: 20,
} as const;

function newId(): string {
  return crypto.randomUUID();
}

function emailAdapterFor(env: Env, url: URL) {
  // Falha fechada (Sprint 2 v1.2): só usa o outbox dev quando as três condições
  // de isDevOutboxAllowed passam (ambiente + flag local + hostname local).
  // Precede o provedor real deliberadamente: um teste local nunca deve
  // acidentalmente disparar um envio real, mesmo que RESEND_API_KEY esteja
  // configurado (ex.: preview environment com secret compartilhado).
  if (isDevOutboxAllowed(env, url)) return new DevOutboxEmailAdapter(env.DB, newId);
  // Sprint 16 v1.0 (A1) — provedor real, só quando genuinamente configurado
  // (env.ts:isRealEmailProviderConfigured). Nunca lido de nenhum arquivo
  // versionado — ver worker/src/email/resendAdapter.ts.
  if (isRealEmailProviderConfigured(env)) {
    return new ResendEmailAdapter(env.RESEND_API_KEY as string, env.EMAIL_FROM_ADDRESS as string);
  }
  return new NoProviderEmailAdapter();
}

/** Sprint 16 v1.0 (A1) — falha de envio nunca é silenciosa (ordem, seção
 *  A1). Chamado pela rota depois de requestEmailConfirmation/
 *  requestPasswordReset, nunca dentro do serviço (mesma separação já
 *  existente no projeto: services devolvem fato, routes decidem o que
 *  auditar). Não revela nada ao chamador HTTP (a resposta continua
 *  genérica, por desenho anti-enumeração) — só torna a falha observável
 *  no lado do servidor, via audit_log, que já é consultável por quem tem
 *  acesso direto ao D1. */
async function auditEmailSendOutcome(
  env: Env,
  outcome: { attempted: boolean; sent: boolean },
  kind: "email_confirmation" | "password_reset"
): Promise<void> {
  if (!outcome.attempted || outcome.sent) return;
  await audit(env, "email_send_failed", null, { kind });
}

function toPublicUser(user: { id: string; name: string; email: string; email_confirmed_at: string | null }) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    emailConfirmed: user.email_confirmed_at !== null,
  };
}

async function audit(env: Env, type: AuditEventType, userId: string | null, metadata?: Record<string, string | number | boolean>) {
  await recordAuditEvent(env.DB, newId(), type, userId, metadata);
}

/** Roda os dois limites (IP + e-mail) — basta um estourar para bloquear. */
async function checkCombinedRateLimit(
  env: Env,
  request: Request,
  url: URL,
  scope: string,
  emailNormalized: string,
  limit: number
): Promise<boolean> {
  const byIp = await checkRateLimit(env.DB, scope, clientIdentifier(request, env, url), limit);
  const byEmail = await checkEmailRateLimit(env.DB, scope, emailNormalized, limit);
  return byIp && byEmail;
}

export async function handleAuthRequest(
  request: Request,
  env: Env,
  url: URL
): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/auth/signup" && method === "POST") {
    const body = await readJsonBody<{ name?: string; email?: string; password?: string; confirmPassword?: string; acceptTerms?: boolean }>(request);
    if (!body) return Errors.badRequest();

    const { name, email, password, confirmPassword, acceptTerms } = body;
    if (!email || !isValidEmail(email)) return Errors.badRequest("Informe um e-mail válido.");

    const allowed = await checkCombinedRateLimit(
      env,
      request,
      url,
      "signup",
      normalizeEmail(email),
      RATE_LIMITS.signup
    );
    if (!allowed) return Errors.tooManyRequests();

    if (!name || !isValidName(name)) return Errors.badRequest("Informe um nome válido.");
    if (!password || !isValidPassword(password))
      return Errors.badRequest("A senha deve ter pelo menos 10 caracteres.");
    if (password !== confirmPassword) return Errors.badRequest("As senhas não coincidem.");
    if (!acceptTerms) return Errors.badRequest("É necessário aceitar os termos e a política de privacidade.");

    const result = await signup(env.DB, emailAdapterFor(env, url), { name, email, password, origin: url.origin });
    if (!result.ok) {
      // Mensagem específica de e-mail em uso é aceitável no cadastro (não é enumeração
      // de login) — o usuário está tentando usar o próprio e-mail, comportamento comum e
      // esperado nesse fluxo (seção 9 da especificação trata isso como "tratado corretamente").
      return Errors.badRequest("Este e-mail já está cadastrado.");
    }

    await audit(env, "signup", result.user?.id ?? null);
    if (result.emailOutcome) await auditEmailSendOutcome(env, result.emailOutcome, "email_confirmation");
    return json({ ok: true }, { status: 201 });
  }

  if (path === "/api/auth/login" && method === "POST") {
    const body = await readJsonBody<{ email?: string; password?: string }>(request);
    if (!body?.email || !body.password) return Errors.badRequest("Informe e-mail e senha.");

    const emailNormalized = normalizeEmail(body.email);
    const allowed = await checkCombinedRateLimit(env, request, url, "login", emailNormalized, RATE_LIMITS.login);
    if (!allowed) return Errors.tooManyRequests();

    const result = await login(env.DB, {
      email: body.email,
      password: body.password,
      userAgent: request.headers.get("User-Agent"),
    });

    if (!result.ok || !result.sessionToken || !result.user) {
      await audit(env, "login_failure", null, { email_normalized: emailNormalized });
      return Errors.unauthorized("E-mail ou senha incorretos.");
    }

    await audit(env, "login_success", result.user.id);

    return json(
      { ok: true, user: toPublicUser(result.user) },
      { headers: { "Set-Cookie": buildSessionCookie(result.sessionToken, shouldOmitSecureCookie(env, url)) } }
    );
  }

  if (path === "/api/auth/logout" && method === "POST") {
    const token = readSessionToken(request);
    if (token) {
      await logout(env.DB, token);
      await audit(env, "logout", null);
    }
    return json(
      { ok: true },
      { headers: { "Set-Cookie": buildExpiredSessionCookie(shouldOmitSecureCookie(env, url)) } }
    );
  }

  if (path === "/api/auth/session" && method === "GET") {
    const token = readSessionToken(request);
    if (!token) return Errors.unauthorized();

    const result = await checkSession(env.DB, token);
    if (!result.ok || !result.user) return Errors.unauthorized();

    return json({ ok: true, user: toPublicUser(result.user) });
  }

  if (path === "/api/auth/email/request-confirmation" && method === "POST") {
    const body = await readJsonBody<{ email?: string }>(request);
    if (!body?.email || !isValidEmail(body.email)) return Errors.badRequest();

    const emailNormalized = normalizeEmail(body.email);
    const allowed = await checkCombinedRateLimit(
      env,
      request,
      url,
      "email_confirmation",
      emailNormalized,
      RATE_LIMITS.emailConfirmationRequest
    );
    if (!allowed) return Errors.tooManyRequests();

    const emailOutcome = await requestEmailConfirmation(env.DB, emailAdapterFor(env, url), emailNormalized, url.origin);
    await auditEmailSendOutcome(env, emailOutcome, "email_confirmation");
    // Resposta sempre genérica — não revela se o e-mail existe ou já foi confirmado.
    return json({ ok: true });
  }

  if (path === "/api/auth/email/confirm" && method === "POST") {
    const body = await readJsonBody<{ token?: string }>(request);
    if (!body?.token) return Errors.badRequest();

    const result = await confirmEmail(env.DB, body.token);
    if (!result.ok) return Errors.badRequest("Link de confirmação inválido, já usado ou expirado.");

    await audit(env, "email_confirmed", null);
    return json({ ok: true });
  }

  if (path === "/api/auth/password/request-reset" && method === "POST") {
    const body = await readJsonBody<{ email?: string }>(request);
    if (!body?.email || !isValidEmail(body.email)) return Errors.badRequest();

    const emailNormalized = normalizeEmail(body.email);
    const allowed = await checkCombinedRateLimit(
      env,
      request,
      url,
      "password_reset_request",
      emailNormalized,
      RATE_LIMITS.passwordResetRequest
    );
    if (!allowed) return Errors.tooManyRequests();

    const emailOutcome = await requestPasswordReset(env.DB, emailAdapterFor(env, url), body.email, url.origin);
    await audit(env, "password_reset_requested", null);
    await auditEmailSendOutcome(env, emailOutcome, "password_reset");
    // Resposta sempre genérica — não enumera usuários.
    return json({ ok: true });
  }

  if (path === "/api/auth/password/reset" && method === "POST") {
    const allowed = await checkRateLimit(
      env.DB,
      "password_reset",
      clientIdentifier(request, env, url),
      RATE_LIMITS.passwordReset
    );
    if (!allowed) return Errors.tooManyRequests();

    const body = await readJsonBody<{ token?: string; password?: string; confirmPassword?: string }>(request);
    if (!body?.token || !body.password) return Errors.badRequest();
    if (!isValidPassword(body.password)) return Errors.badRequest("A senha deve ter pelo menos 10 caracteres.");
    if (body.password !== body.confirmPassword) return Errors.badRequest("As senhas não coincidem.");

    const result = await resetPassword(env.DB, body.token, body.password);
    if (!result.ok) return Errors.badRequest("Link de redefinição inválido, já usado ou expirado.");

    await audit(env, "password_reset_completed", null);
    return json({ ok: true });
  }

  return null;
}
