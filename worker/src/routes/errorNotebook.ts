import type { Env } from "../env";
import { isLocalEditorialFixturesAllowed } from "../env";
import { Errors, json, readJsonBody } from "../lib/response";
import { readSessionToken } from "../lib/cookies";
import { checkSession } from "../services/authService";
import { recordAuditEvent, type AuditEventType } from "../repositories/auditRepository";
import { findPublishedPatternBySlug } from "../repositories/patternsRepository";
import { archiveEntry, getEntryDetail, getSummary, listEntries, patchEntry, startReview } from "../services/errorNotebookService";

/* Rotas do Caderno de Erros — Sprint 9 v1.0.

   Mesma ordem obrigatória de checagens do Player (Sprint 8) e do restante
   do namespace do aluno: 1) sessão válida (401); 2) gate local de
   fixtures (reaproveita EXATAMENTE isLocalEditorialFixturesAllowed —
   nenhum gate novo, mesma decisão de projeto do Player); 3) validação de
   parâmetros; 4) só então o serviço consulta/muta o banco.

   Uma entrada de outro aluno SEMPRE responde 404 (nunca 403) — o
   repositório já escopa por `user_id` no SQL, então "não encontrar" já é
   a resposta certa (mesmo padrão de rascunho-vs-inexistente do catálogo
   de padrões desde a Sprint 6, e da tentativa do Player desde a Sprint 8). */

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

function unavailableResponse(): Response {
  return json({ ok: true, available: false, message: "O Caderno de Erros está em preparação." }, { status: 200 });
}

function conflictResponse(): Response {
  return Errors.conflict("A entrada foi alterada em outro lugar. Recarregue e tente novamente.");
}

function parsePositiveInt(raw: string | null, fallback: number, max: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

const ENTRY_ID_RE = /^\/api\/error-notebook\/([^/]+)$/;
const PATCH_ID_RE = /^\/api\/error-notebook\/([^/]+)$/;
const START_REVIEW_RE = /^\/api\/error-notebook\/([^/]+)\/start-review$/;
const ARCHIVE_RE = /^\/api\/error-notebook\/([^/]+)\/archive$/;

export async function handleErrorNotebookRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;

  if (!path.startsWith("/api/error-notebook")) return null;

  const user = await requireUser(request, env);
  if (!user) return Errors.unauthorized();

  const fixturesAllowed = isLocalEditorialFixturesAllowed(env, url);
  if (!fixturesAllowed) return unavailableResponse();

  if (path === "/api/error-notebook/summary") {
    if (method !== "GET") return Errors.methodNotAllowed();
    const summary = await getSummary(env.DB, user.id);
    return json({ ok: true, summary });
  }

  if (path === "/api/error-notebook") {
    if (method !== "GET") return Errors.methodNotAllowed();
    // Recebido por SLUG, nunca pelo id interno do padrão — mesma convenção
    // do resto da API voltada ao aluno desde a Sprint 6 (o catálogo de
    // padrões nunca expõe `id` ao cliente); o id real só é resolvido aqui,
    // no servidor.
    const patternSlug = url.searchParams.get("patternSlug");
    const pattern = patternSlug ? await findPublishedPatternBySlug(env.DB, patternSlug) : null;
    const filters = {
      patternId: pattern?.id,
      errorType: url.searchParams.get("errorType") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      overdueOnly: url.searchParams.get("overdue") === "true",
      scheduledFrom: url.searchParams.get("from") ?? undefined,
      scheduledTo: url.searchParams.get("to") ?? undefined,
      includeArchived: url.searchParams.get("includeArchived") === "true",
      limit: parsePositiveInt(url.searchParams.get("limit"), 20, 50),
      offset: Math.max(0, Number(url.searchParams.get("offset")) || 0),
    };
    const { entries, total } = await listEntries(env.DB, user.id, filters);
    return json({ ok: true, entries, total, limit: filters.limit, offset: filters.offset });
  }

  const startReviewMatch = path.match(START_REVIEW_RE);
  if (startReviewMatch) {
    if (method !== "POST") return Errors.methodNotAllowed();
    const entryId = startReviewMatch[1];
    const result = await startReview(env.DB, user.id, entryId);
    if (!result.ok) {
      if (result.notFound) return Errors.notFound();
      return json({ error: { code: "validation_error", message: "Não foi possível iniciar a revisão.", fields: result.fieldErrors } }, { status: 400 });
    }
    // Auditoria só quando existe uma tentativa REAL (result sempre "ok"
    // aqui já garante isso — startReview nunca retorna ok sem tentativa
    // válida, seção 8.1). Metadados técnicos apenas — nunca a anotação.
    await audit(env, "error_notebook_review_started", user.id, { entryId, attemptId: result.attemptId!, reviewedQuestionId: result.reviewedQuestionId! });
    return json({ ok: true, attemptId: result.attemptId, reviewedQuestionId: result.reviewedQuestionId, selectionReason: result.selectionReason });
  }

  const archiveMatch = path.match(ARCHIVE_RE);
  if (archiveMatch) {
    if (method !== "POST") return Errors.methodNotAllowed();
    const entryId = archiveMatch[1];
    const body = await readJsonBody<{ expectedVersion?: unknown; mutationId?: unknown }>(request);
    if (!body || typeof body.expectedVersion !== "number" || typeof body.mutationId !== "string") {
      return Errors.badRequest("expectedVersion e mutationId são obrigatórios.");
    }
    const result = await archiveEntry(env.DB, user.id, entryId, body.expectedVersion, body.mutationId);
    if (!result.ok) {
      if (result.notFound) return Errors.notFound();
      if (result.conflict) return conflictResponse();
      return json({ error: { code: "validation_error", message: "Não foi possível arquivar.", fields: result.fieldErrors } }, { status: 400 });
    }
    if (result.changed) await audit(env, "error_notebook_entry_archived", user.id, { entryId });
    return json({ ok: true });
  }

  const patchMatch = path.match(PATCH_ID_RE);
  if (patchMatch && method === "PATCH") {
    const entryId = patchMatch[1];
    const body = await readJsonBody<{ errorType?: unknown; studentNote?: unknown; expectedVersion?: unknown; mutationId?: unknown }>(request);
    if (!body) return Errors.badRequest("Corpo inválido.");
    const result = await patchEntry(env.DB, user.id, entryId, {
      errorTypeProvided: Object.prototype.hasOwnProperty.call(body, "errorType"),
      errorType: body.errorType,
      studentNoteProvided: Object.prototype.hasOwnProperty.call(body, "studentNote"),
      studentNote: body.studentNote,
      expectedVersion: body.expectedVersion,
      mutationId: body.mutationId,
    });
    if (!result.ok) {
      if (result.notFound) return Errors.notFound();
      if (result.conflict) return conflictResponse();
      return json({ error: { code: "validation_error", message: "Não foi possível atualizar.", fields: result.fieldErrors } }, { status: 400 });
    }
    // A anotação livre NUNCA é auditada (seção 10/11 da ordem) — só o fato
    // técnico de que uma atualização real aconteceu.
    if (result.changed) await audit(env, "error_notebook_entry_updated", user.id, { entryId });
    return json({ ok: true, changed: result.changed === true });
  }

  const entryMatch = path.match(ENTRY_ID_RE);
  if (entryMatch) {
    if (method !== "GET") return Errors.methodNotAllowed();
    const entryId = entryMatch[1];
    const detail = await getEntryDetail(env.DB, user.id, entryId);
    if (!detail) return Errors.notFound();
    return json({ ok: true, entry: detail });
  }

  return null;
}
