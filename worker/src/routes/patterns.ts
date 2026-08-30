import type { Env } from "../env";
import { isLocalPatternFixturesAllowed } from "../env";
import { Errors, json } from "../lib/response";
import { readSessionToken } from "../lib/cookies";
import { checkSession } from "../services/authService";
import {
  isValidPatternSlug,
  validatePatternEvidenceFilter,
  validatePatternLimit,
  validatePatternPage,
  validatePatternSearch,
  validatePatternSort,
  validatePatternTextFilter,
} from "../lib/patternsValidation";
import { getPatternDetail, getPatternProgress, listPatterns } from "../services/patternsService";

/* Rotas do catálogo de padrões ENEM — Sprint 6 v1.0.

   Os TRÊS endpoints desta sprint são GET e estritamente somente leitura.
   Qualquer outro método sob /api/patterns responde 405 sem tocar no banco —
   não existe endpoint editorial nesta sprint (o editor/admin virá em sprint
   própria, com RBAC real; seção 4.3 da ordem).

   Ordem obrigatória de checagens em toda requisição:
     1) sessão válida (401 sem sessão);
     2) método permitido;
     3) gate local de fixtures — ANTES de qualquer consulta às tabelas
        patterns/pattern_attributes/pattern_relations/student_pattern_progress;
     4) validação de parâmetros (400);
     5) só então o serviço consulta o banco. */

async function requireUser(request: Request, env: Env): Promise<{ id: string } | null> {
  const token = readSessionToken(request);
  if (!token) return null;
  const result = await checkSession(env.DB, token);
  if (!result.ok || !result.user) return null;
  return { id: result.user.id };
}

/** Mesma forma acolhedora dos gates de diagnóstico e cronograma: 200 com
 *  `available: false`, nunca 404/500 e nunca qualquer vestígio de conteúdo. */
function unavailableResponse(): Response {
  return json(
    { ok: true, available: false, message: "O catálogo de padrões está em preparação pedagógica." },
    { status: 200 }
  );
}

function validationError(field: string, message: string): Response {
  return json(
    { error: { code: "validation_error", message: "Parâmetro inválido.", fields: { [field]: message } } },
    { status: 400 }
  );
}

const PATTERN_SLUG_RE = /^\/api\/patterns\/([^/]+)$/;
const PATTERN_PROGRESS_RE = /^\/api\/patterns\/([^/]+)\/progress$/;

export async function handlePatternsRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;

  if (path !== "/api/patterns" && !path.startsWith("/api/patterns/")) return null;

  const user = await requireUser(request, env);
  if (!user) return Errors.unauthorized();

  if (method !== "GET") return Errors.methodNotAllowed();

  // Gate ANTES de qualquer consulta às tabelas pattern_*.
  if (!isLocalPatternFixturesAllowed(env, url)) return unavailableResponse();

  if (path === "/api/patterns") {
    const searchResult = validatePatternSearch(url.searchParams.get("busca"));
    if (!searchResult.ok) return validationError("busca", searchResult.error!);

    const contentResult = validatePatternTextFilter(url.searchParams.get("conteudo"), "Conteúdo");
    if (!contentResult.ok) return validationError("conteudo", contentResult.error!);

    const tagResult = validatePatternTextFilter(url.searchParams.get("tag"), "Tag");
    if (!tagResult.ok) return validationError("tag", tagResult.error!);

    const evidenceResult = validatePatternEvidenceFilter(url.searchParams.get("evidencia"));
    if (!evidenceResult.ok) return validationError("evidencia", evidenceResult.error!);

    const sortResult = validatePatternSort(url.searchParams.get("ordenar"));
    if (!sortResult.ok) return validationError("ordenar", sortResult.error!);

    const limitResult = validatePatternLimit(url.searchParams.get("limite"));
    if (!limitResult.ok) return validationError("limite", limitResult.error!);

    const pageResult = validatePatternPage(url.searchParams.get("pagina"));
    if (!pageResult.ok) return validationError("pagina", pageResult.error!);

    const result = await listPatterns(
      env.DB,
      user.id,
      {
        search: searchResult.value ?? null,
        content: contentResult.value ?? null,
        tag: tagResult.value ?? null,
        evidence: evidenceResult.value!,
        sort: sortResult.value!,
      },
      pageResult.value!,
      limitResult.value!
    );
    return json({ ok: true, available: true, ...result });
  }

  const progressMatch = path.match(PATTERN_PROGRESS_RE);
  if (progressMatch) {
    const slug = decodeURIComponent(progressMatch[1]);
    // Slug malformado responde o MESMO 404 de slug inexistente — nunca 400,
    // para não permitir distinguir "formato errado" de "não existe".
    if (!isValidPatternSlug(slug)) return Errors.notFound();
    const result = await getPatternProgress(env.DB, user.id, slug);
    if (!result) return Errors.notFound();
    return json({ ok: true, available: true, ...result });
  }

  const slugMatch = path.match(PATTERN_SLUG_RE);
  if (slugMatch) {
    const slug = decodeURIComponent(slugMatch[1]);
    if (!isValidPatternSlug(slug)) return Errors.notFound();
    const pattern = await getPatternDetail(env.DB, user.id, slug);
    // Não publicado e inexistente produzem exatamente esta mesma resposta.
    if (!pattern) return Errors.notFound();
    return json({ ok: true, available: true, pattern });
  }

  return Errors.notFound();
}
