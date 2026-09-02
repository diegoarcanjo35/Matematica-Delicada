import type { Env } from "../env";
import { isAdminBootstrapConfigured } from "../env";
import { Errors, json, readJsonBody } from "../lib/response";
import { timingSafeEqualStrings } from "../lib/crypto";
import { bootstrapAdmins } from "../services/adminBootstrapService";

/* Rota do Bootstrap Administrativo Seguro — Sprint 15 v1.1 (adendo, seções
   H/N). Superfície de exposição mínima deliberada (adendo: "escolher a
   superfície de menor exposição"):

   * um ÚNICO endpoint técnico, POST /api/admin-bootstrap/run — nenhum GET
     de status, nenhuma outra rota, nunca referenciado por nenhum link/UI
     (nenhuma tela consome este arquivo — ver docs/ADMIN_ESSENCIAL.md);
   * existe SOMENTE quando `ADMIN_BOOTSTRAP_SECRET` está configurado no
     ambiente (worker/src/env.ts:isAdminBootstrapConfigured) — ausente em
     TODO arquivo de configuração deste repositório nesta sprint (nem
     wrangler.jsonc, nem wrangler.local.jsonc: adendo seção Q, "não
     configurar segredo real de produção nesta sprint"), então hoje a rota
     responde 404 em qualquer ambiente, como se não existisse;
   * mesmo configurada, exige o segredo no cabeçalho
     X-Admin-Bootstrap-Secret, comparado em tempo constante — nunca aceito
     por query string (evita ir parar em log de acesso/histórico) nem pelo
     corpo (mantém o segredo fora do JSON que a auditoria poderia, por
     engano futuro, vir a ecoar);
   * nunca depende do RBAC admin (não pode: nenhum admin existe ainda,
     adendo seção H) — a autorização é inteiramente este segredo
     independente;
   * a decisão de one-shot/atomicidade/idempotência real vive em
     worker/src/services/adminBootstrapService.ts — esta rota só valida
     transporte (segredo, corpo) e traduz o resultado em HTTP. */
export async function handleAdminBootstrapRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname !== "/api/admin-bootstrap/run") return null;
  if (!isAdminBootstrapConfigured(env)) return null; // rota inexistente até um segredo real ser configurado (fora desta sprint)
  if (request.method !== "POST") return Errors.methodNotAllowed();

  const providedSecret = request.headers.get("X-Admin-Bootstrap-Secret");
  if (!providedSecret || !timingSafeEqualStrings(providedSecret, env.ADMIN_BOOTSTRAP_SECRET as string)) {
    return Errors.unauthorized("Credencial de bootstrap ausente ou inválida.");
  }

  const body = await readJsonBody<{ identifierA?: unknown; identifierB?: unknown; mutationId?: unknown }>(request);
  if (!body) return Errors.badRequest("Corpo inválido.");

  const result = await bootstrapAdmins(env.DB, {
    identifierA: body.identifierA,
    identifierB: body.identifierB,
    mutationId: body.mutationId,
  });

  if (result.ok) {
    if (result.alreadyCompleted) {
      return json({ ok: true, alreadyCompleted: true }, { status: 200 });
    }
    return json({ ok: true, alreadyCompleted: false, promotedUserIds: result.promotedUserIds }, { status: 201 });
  }

  if (result.reason === "same_account") return Errors.badRequest("As duas contas-alvo precisam ser diferentes.");
  if (result.reason === "account_not_found") {
    return Errors.badRequest(Object.values(result.fieldErrors)[0] ?? "Conta não encontrada.");
  }
  if (result.reason === "conflict") return Errors.conflict();
  return Errors.badRequest(Object.values(result.fieldErrors)[0] ?? "Requisição inválida.");
}
