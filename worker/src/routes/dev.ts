import type { Env } from "../env";
import { isDevOutboxAllowed } from "../env";
import { Errors, json } from "../lib/response";

/* Rota exclusiva de ambiente de desenvolvimento/teste — permite que testes
   automatizados recuperem o link emitido por e-mail sem provedor externo.
   Falha FECHADA (Sprint 2 v1.2): exige as três condições de
   env.ts:isDevOutboxAllowed (ambiente + flag local explícita + hostname
   reconhecidamente local) — ENVIRONMENT sozinho não basta mais. Qualquer
   condição faltando responde 404, sem revelar que a rota existe. */
export async function handleDevRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname !== "/api/dev/outbox/last" || request.method !== "GET") return null;
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
