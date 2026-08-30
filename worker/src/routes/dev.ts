import type { Env } from "../env";
import { isDevOutboxAllowed, isLocalEditorialFixturesAllowed } from "../env";
import { Errors, json, readJsonBody } from "../lib/response";
import { readSessionToken } from "../lib/cookies";
import { checkSession } from "../services/authService";
import { ensureRoleExists, findRoleByName, grantRole } from "../repositories/roleRepository";
import { recordAuditEvent } from "../repositories/auditRepository";
import { ALL_ROLES, EDITORIAL_ROLES, type Role } from "../lib/questionsValidation";

/* Rota exclusiva de ambiente de desenvolvimento/teste — permite que testes
   automatizados recuperem o link emitido por e-mail sem provedor externo.
   Falha FECHADA (Sprint 2 v1.2): exige as três condições de
   env.ts:isDevOutboxAllowed (ambiente + flag local explícita + hostname
   reconhecidamente local) — ENVIRONMENT sozinho não basta mais. Qualquer
   condição faltando responde 404, sem revelar que a rota existe. */
export async function handleDevRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/dev/outbox/last" && request.method === "GET") {
    if (!isDevOutboxAllowed(env, url)) return Errors.notFound();

    const to = url.searchParams.get("to");
    const kind = url.searchParams.get("kind");
    if (!to || !kind) return Errors.badRequest("Informe to e kind.");

    const row = await env.DB.prepare(
      "SELECT subject, body, created_at FROM dev_email_outbox WHERE to_email = ? AND kind = ? ORDER BY created_at DESC LIMIT 1"
    )
      .bind(to, kind)
      .first<{ subject: string; body: string; created_at: string }>();

    if (!row) return Errors.notFound("Nenhum e-mail encontrado.");
    return json({ ok: true, email: row });
  }

  /* Sprint 7 v1.0, seção 4.2 — bootstrap local explícito e idempotente de
     papéis editoriais. NUNCA um GET; NUNCA concede papel a outro usuário
     que não o da própria sessão autenticada (evita escalonamento de
     privilégio de terceiros mesmo dentro do gate local); atrás do MESMO
     gate de três condições (ambiente + flag exclusiva de
     wrangler.local.jsonc + hostname local reconhecido) usado por todo o
     resto do conteúdo técnico provisório do projeto. Fora do gate, responde
     404 sem revelar que a rota existe — nunca 403 (não vaza a existência). */
  if (url.pathname === "/api/dev/editorial/bootstrap-role" && request.method === "POST") {
    if (!isLocalEditorialFixturesAllowed(env, url)) return Errors.notFound();

    const token = readSessionToken(request);
    if (!token) return Errors.unauthorized();
    const session = await checkSession(env.DB, token);
    if (!session.ok || !session.user) return Errors.unauthorized();

    const body = await readJsonBody<{ role?: string }>(request);
    if (!body) return Errors.badRequest("Corpo inválido.");
    const role = body.role;
    if (typeof role !== "string" || !(EDITORIAL_ROLES as readonly string[]).includes(role)) {
      return Errors.badRequest("Papel inválido — só editor/admin podem ser concedidos pelo bootstrap local.");
    }

    for (const knownRole of ALL_ROLES) {
      await ensureRoleExists(env.DB, `role-${knownRole}`, knownRole as Role);
    }
    const roleRow = await findRoleByName(env.DB, role as Role);
    if (!roleRow) return Errors.internal();

    await grantRole(env.DB, {
      id: crypto.randomUUID(),
      userId: session.user.id,
      roleId: roleRow.id,
      grantedBy: null,
    });
    await recordAuditEvent(env.DB, crypto.randomUUID(), "editorial_role_granted", session.user.id, { role });

    return json({ ok: true, role });
  }

  return null;
}
